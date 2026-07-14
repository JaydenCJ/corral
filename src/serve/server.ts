import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Backend, ModelSpec } from "../backend/backend.js";
import type { CorralConfig } from "../config.js";
import { type Logger, silentLogger } from "../logger.js";
import { listManifests, resolveManifest } from "../manifest.js";
import { type Clock, systemClock } from "./clock.js";
import { proxyToBackend } from "./proxy.js";
import { ModelSupervisor } from "./supervisor.js";

export interface ServeOptions {
  backend: Backend;
  config: CorralConfig;
  logger?: Logger;
  clock?: Clock;
  /** Model root for manifest lookups; defaults to the real models dir. */
  modelsRoot?: string;
  /**
   * When true, unknown model ids are accepted and launched with a spec that has
   * no GGUF path. Used for the mock backend so demos/tests can hot-swap between
   * arbitrary model names without pulling anything.
   */
  allowEphemeralModels?: boolean;
  /** Disable the periodic idle reaper timer (tests drive reaping manually). */
  disableIdleTimer?: boolean;
}

export interface RunningServer {
  server: Server;
  supervisor: ModelSupervisor;
  port: number;
  host: string;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendError(res: ServerResponse, status: number, message: string, type: string): void {
  sendJson(res, status, { error: { message, type } });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Build (but do not start) the OpenAI-compatible HTTP server and its supervisor.
 * Exposed separately from `startServer` so tests can wire in a fake clock and
 * ephemeral models.
 */
export function createCorralServer(opts: ServeOptions): {
  server: Server;
  supervisor: ModelSupervisor;
} {
  const logger = opts.logger ?? silentLogger;
  const clock = opts.clock ?? systemClock;
  const modelsRoot = opts.modelsRoot;

  const resolveModel = async (id: string): Promise<ModelSpec> => {
    const manifest = modelsRoot ? resolveManifest(id, modelsRoot) : resolveManifest(id);
    if (manifest) {
      return { id: manifest.id, path: manifest.path, ctxSize: opts.config.ctxSize };
    }
    if (opts.allowEphemeralModels) {
      return { id, ctxSize: opts.config.ctxSize };
    }
    throw new Error(`model "${id}" is not installed; run \`corral pull ${id}\` first`);
  };

  const supervisor = new ModelSupervisor({
    backend: opts.backend,
    resolveModel,
    maxLoaded: opts.config.maxLoaded,
    idleTimeoutMs: opts.config.idleTimeoutMs,
    maxRestarts: opts.config.maxRestarts,
    clock,
    logger,
  });

  const listModels = (): unknown => {
    const manifests = modelsRoot ? listManifests(modelsRoot) : listManifests();
    const data = manifests.map((m) => ({
      id: m.id,
      object: "model",
      created: Math.floor(new Date(m.pulledAt).getTime() / 1000) || 0,
      owned_by: "corral",
    }));
    // Models that are currently loaded but have no manifest (ephemeral ids
    // served by the mock backend) must also be listed, so that /v1/models
    // never omits a model id that /v1/chat/completions is actively serving.
    const seen = new Set(data.map((d) => d.id));
    for (const loaded of supervisor.list()) {
      if (seen.has(loaded.id)) continue;
      seen.add(loaded.id);
      data.push({
        id: loaded.id,
        object: "model",
        created: Math.floor(loaded.loadedAtMs / 1000),
        owned_by: "corral",
      });
    }
    return { object: "list", data };
  };

  const handleInference = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = body.length > 0 ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      sendError(res, 400, "request body is not valid JSON", "invalid_request_error");
      return;
    }
    const model = (parsed as Record<string, unknown>).model;
    if (typeof model !== "string" || model.length === 0) {
      sendError(res, 400, "missing required field: model", "invalid_request_error");
      return;
    }
    let instance;
    try {
      instance = await supervisor.ensure(model);
    } catch (err) {
      sendError(res, 404, (err as Error).message, "model_not_found");
      return;
    }
    await proxyToBackend(req, res, instance.port, body, opts.config.host);
  };

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (url === "/health" && method === "GET") {
      sendJson(res, 200, { status: "ok", backend: opts.backend.kind });
      return;
    }
    if (url === "/v1/models" && method === "GET") {
      sendJson(res, 200, listModels());
      return;
    }
    if (url === "/api/ps" && method === "GET") {
      sendJson(res, 200, { models: supervisor.list() });
      return;
    }
    if (
      (url === "/v1/chat/completions" || url === "/v1/completions") &&
      method === "POST"
    ) {
      handleInference(req, res).catch((err: Error) => {
        if (!res.headersSent) sendError(res, 500, err.message, "internal_error");
        else res.end();
      });
      return;
    }
    sendError(res, 404, `unknown route ${method} ${url}`, "invalid_request_error");
  });

  return { server, supervisor };
}

/**
 * Start a fully wired Corral server listening on config.host:config.port (or an
 * override). Installs the idle reaper timer and returns a handle that stops both
 * the HTTP server and every backend it launched.
 */
export async function startServer(
  opts: ServeOptions & { port?: number },
): Promise<RunningServer> {
  const { server, supervisor } = createCorralServer(opts);
  const host = opts.config.host;
  const port = opts.port ?? opts.config.port;
  const logger = opts.logger ?? silentLogger;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  let idleTimer: NodeJS.Timeout | undefined;
  if (!opts.disableIdleTimer && opts.config.idleTimeoutMs > 0) {
    const interval = Math.max(1000, Math.min(opts.config.idleTimeoutMs, 30000));
    idleTimer = setInterval(() => {
      void supervisor.reapIdle();
    }, interval);
    idleTimer.unref();
  }

  const addr = server.address();
  const actualPort = addr && typeof addr === "object" ? addr.port : port;
  logger.info(`corral serving on http://${host}:${actualPort} (backend: ${opts.backend.kind})`);

  return {
    server,
    supervisor,
    host,
    port: actualPort,
    close: async () => {
      if (idleTimer) clearInterval(idleTimer);
      await supervisor.stopAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
