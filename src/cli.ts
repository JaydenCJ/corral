#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createBackend } from "./backend/factory.js";
import { type BackendKind, type CorralConfig, loadConfig, parseBackendKind } from "./config.js";
import { consoleLogger } from "./logger.js";
import {
  listManifests,
  type ModelManifest,
  modelSizeOnDisk,
  removeModel,
  resolveManifest,
} from "./manifest.js";
import { isServerHealthy, streamChat } from "./openaiClient.js";
import { formatBytes, parsePullRef, pullModel } from "./commands/pull.js";
import { RealHuggingFaceClient } from "./hf/realClient.js";
import { startServer } from "./serve/server.js";
import { VERSION } from "./version.js";

/** Error whose presence means "wrong usage" and maps to exit code 2. */
class UsageError extends Error {}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags.set(key, next);
          i++;
        } else {
          flags.set(key, true);
        }
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      // short flags: -h, -V
      flags.set(arg.slice(1), true);
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function flagStr(flags: Map<string, string | boolean>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = flags.get(n);
    if (typeof v === "string") return v;
  }
  return undefined;
}

function flagBool(flags: Map<string, string | boolean>, ...names: string[]): boolean {
  return names.some((n) => flags.get(n) === true || flags.get(n) === "true");
}

/** Merge CLI flag overrides onto the on-disk config. */
function resolveConfig(flags: Map<string, string | boolean>): CorralConfig {
  const config = loadConfig();
  const backend = flagStr(flags, "backend");
  if (backend) {
    try {
      config.backend = parseBackendKind(backend);
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
  }
  const host = flagStr(flags, "host");
  if (host) config.host = host;
  const port = flagStr(flags, "port");
  if (port) config.port = requireInt(port, "port");
  const maxLoaded = flagStr(flags, "max-loaded");
  if (maxLoaded) config.maxLoaded = requireInt(maxLoaded, "max-loaded");
  const idle = flagStr(flags, "idle-timeout");
  if (idle) config.idleTimeoutMs = requireInt(idle, "idle-timeout");
  const ctx = flagStr(flags, "ctx-size");
  if (ctx) config.ctxSize = requireInt(ctx, "ctx-size");
  const restarts = flagStr(flags, "max-restarts");
  if (restarts) config.maxRestarts = requireInt(restarts, "max-restarts");
  return config;
}

function requireInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new UsageError(`--${name} must be an integer, got "${value}"`);
  }
  return n;
}

const HELP = `corral ${VERSION} — the no-fork local model runner

Usage:
  corral pull <hf-repo>[:<quant>]   Download a GGUF from Hugging Face
  corral ls                         List installed models
  corral show <model>               Show a model's manifest
  corral rm <model>                 Remove an installed model
  corral serve                      Start the OpenAI-compatible server
  corral run <model>                Chat with a model in the terminal
  corral ps                         List running models (needs a live server)

Global flags:
  --backend <llamacpp|mlx|mock>     Inference backend (default from config)
  --host <addr>                     Bind address (default 127.0.0.1)
  --port <n>                        Server port (default 11435)
  --max-loaded <n>                  Models kept resident before LRU eviction
  --idle-timeout <ms>               Idle time before a model is reaped
  --ctx-size <n>                    Context window passed to the backend
  -h, --help                        Show this help
  -V, --version                     Show version

Corral is a thin orchestrator. Real inference needs a local llama.cpp
(e.g. \`brew install llama.cpp\`) or mlx-lm; Corral bundles no models.
`;

function printModelsTable(models: ModelManifest[]): void {
  if (models.length === 0) {
    process.stdout.write("No models installed. Try: corral pull <owner/repo>:<quant>\n");
    return;
  }
  const rows = models.map((m) => ({
    id: m.id,
    quant: m.quant,
    size: formatBytes(m.sizeBytes),
    pulled: m.pulledAt.slice(0, 10),
  }));
  const idW = Math.max(5, ...rows.map((r) => r.id.length));
  const qW = Math.max(5, ...rows.map((r) => r.quant.length));
  const sW = Math.max(4, ...rows.map((r) => r.size.length));
  const header = `${"MODEL".padEnd(idW)}  ${"QUANT".padEnd(qW)}  ${"SIZE".padEnd(sW)}  PULLED`;
  process.stdout.write(header + "\n");
  for (const r of rows) {
    process.stdout.write(
      `${r.id.padEnd(idW)}  ${r.quant.padEnd(qW)}  ${r.size.padEnd(sW)}  ${r.pulled}\n`,
    );
  }
}

async function cmdPull(args: ParsedArgs): Promise<number> {
  const target = args.positionals[0];
  if (!target) throw new UsageError("pull requires a repo, e.g. corral pull owner/name:Q4_K_M");
  const ref = parsePullRef(target);
  const quantFlag = flagStr(args.flags, "quant");
  if (quantFlag) ref.quant = quantFlag;
  const checksum = flagBool(args.flags, "checksum");
  const client = new RealHuggingFaceClient();

  let lastPct = -1;
  const manifest = await pullModel(ref, {
    client,
    checksum,
    logger: consoleLogger,
    onProgress: (downloaded, total) => {
      if (total <= 0) return;
      const pct = Math.floor((downloaded / total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        process.stderr.write(`\rdownloading ${pct}% (${formatBytes(downloaded)}/${formatBytes(total)})`);
      }
    },
  });
  if (lastPct >= 0) process.stderr.write("\n");
  process.stdout.write(`Installed ${manifest.id} (${formatBytes(manifest.sizeBytes)})\n`);
  return 0;
}

function cmdLs(): number {
  printModelsTable(listManifests());
  return 0;
}

function cmdShow(args: ParsedArgs): number {
  const ref = args.positionals[0];
  if (!ref) throw new UsageError("show requires a model name");
  const manifest = resolveManifest(ref);
  if (!manifest) {
    process.stderr.write(`error: model "${ref}" is not installed\n`);
    return 1;
  }
  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
  return 0;
}

function cmdRm(args: ParsedArgs): number {
  const ref = args.positionals[0];
  if (!ref) throw new UsageError("rm requires a model name");
  const manifest = resolveManifest(ref);
  if (!manifest) {
    process.stderr.write(`error: model "${ref}" is not installed\n`);
    return 1;
  }
  const freed = modelSizeOnDisk(manifest.id);
  removeModel(manifest.id);
  process.stdout.write(`Removed ${manifest.id} (freed ${formatBytes(freed)})\n`);
  return 0;
}

async function cmdServe(args: ParsedArgs): Promise<number> {
  const config = resolveConfig(args.flags);
  const backend = createBackend(config.backend, config);
  if (!(await backend.isAvailable()) && config.backend !== "mock") {
    consoleLogger.warn(
      `backend "${config.backend}" is not available on this host; ` +
        `models will fail to start until it is installed.`,
    );
  }
  const running = await startServer({
    backend,
    config,
    logger: consoleLogger,
    allowEphemeralModels: config.backend === "mock",
  });
  process.stdout.write("Press Ctrl+C to stop.\n");

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      consoleLogger.info("shutting down; stopping backends...");
      running
        .close()
        .then(() => resolve())
        .catch(() => resolve());
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
  return 0;
}

async function cmdPs(args: ParsedArgs): Promise<number> {
  const config = resolveConfig(args.flags);
  const base = flagStr(args.flags, "serve-url") ?? `http://${config.host}:${config.port}`;
  const healthy = await isServerHealthy(base);
  if (!healthy) {
    process.stderr.write(`error: no corral server reachable at ${base} (start one with \`corral serve\`)\n`);
    return 1;
  }
  const res = await fetch(new URL("/api/ps", base));
  const data = (await res.json()) as { models: Array<Record<string, unknown>> };
  if (flagBool(args.flags, "json")) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return 0;
  }
  if (data.models.length === 0) {
    process.stdout.write("No models are currently loaded.\n");
    return 0;
  }
  process.stdout.write("MODEL                          PORT   PID     RESTARTS\n");
  for (const m of data.models) {
    const id = String(m.id).padEnd(30);
    const port = String(m.port).padEnd(6);
    const pid = String(m.pid ?? "-").padEnd(7);
    process.stdout.write(`${id} ${port} ${pid} ${m.restarts}\n`);
  }
  return 0;
}

async function cmdRun(args: ParsedArgs): Promise<number> {
  const model = args.positionals[0];
  if (!model) throw new UsageError("run requires a model name");
  const config = resolveConfig(args.flags);
  const explicitUrl = flagStr(args.flags, "serve-url");

  // Prefer an already-running server; otherwise start one inline.
  let base = explicitUrl ?? `http://${config.host}:${config.port}`;
  let inline: Awaited<ReturnType<typeof startServer>> | undefined;
  if (!explicitUrl && !(await isServerHealthy(base))) {
    const backend = createBackend(config.backend, config);
    inline = await startServer({
      backend,
      config,
      logger: consoleLogger,
      port: 0, // ephemeral
      allowEphemeralModels: config.backend === "mock",
      disableIdleTimer: true,
    });
    base = `http://${inline.host}:${inline.port}`;
    consoleLogger.info(`started inline server at ${base}`);
  }

  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  const oneShot = flagStr(args.flags, "prompt");

  // Returns true if the request succeeded. The one-shot path maps a failure to a
  // non-zero exit code so scripts can detect it; the interactive REPL just prints
  // the error and keeps going.
  const ask = async (prompt: string): Promise<boolean> => {
    history.push({ role: "user", content: prompt });
    let reply = "";
    try {
      reply = await streamChat(base, model, history, (t) => process.stdout.write(t));
    } catch (err) {
      process.stderr.write(`\nerror: ${(err as Error).message}\n`);
      history.pop();
      return false;
    }
    process.stdout.write("\n");
    history.push({ role: "assistant", content: reply });
    return true;
  };

  try {
    if (oneShot !== undefined) {
      const ok = await ask(oneShot);
      return ok ? 0 : 1;
    }
    process.stdout.write(`Chatting with ${model} via ${base}. Type /exit to quit.\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>((resolve) => {
      const loop = () => {
        rl.question("> ", (line) => {
          const text = line.trim();
          if (text === "/exit" || text === "/quit") {
            rl.close();
            resolve();
            return;
          }
          if (text.length === 0) {
            loop();
            return;
          }
          void ask(text).then(loop);
        });
      };
      rl.on("close", resolve);
      loop();
    });
    return 0;
  } finally {
    if (inline) await inline.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv);

  // Version is checked before the "no positionals -> help" fallback so that
  // `corral --version` reports the version rather than printing help.
  if (flagBool(flags, "version", "V") || positionals[0] === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (flagBool(flags, "help", "h") || positionals[0] === "help" || positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }

  const command = positionals[0];
  const rest = { positionals: positionals.slice(1), flags };
  switch (command) {
    case "pull":
      return cmdPull(rest);
    case "ls":
    case "list":
      return cmdLs();
    case "show":
      return cmdShow(rest);
    case "rm":
    case "remove":
      return cmdRm(rest);
    case "serve":
      return cmdServe(rest);
    case "ps":
      return cmdPs(rest);
    case "run":
      return cmdRun(rest);
    default:
      throw new UsageError(`unknown command "${command}". Run \`corral --help\`.`);
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: Error) => {
    if (err instanceof UsageError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  });
