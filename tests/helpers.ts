import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type {
  Backend,
  BackendInstance,
  ExitInfo,
  ModelSpec,
} from "../src/backend/backend.js";

/** Create a throwaway temp directory; caller passes the returned path to rmDir. */
export function tmpDir(prefix = "corral-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function rmDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** In-memory backend instance for deterministic supervisor tests. */
export class FakeInstance implements BackendInstance {
  readonly port: number;
  readonly pid: number | undefined;
  healthy = true;
  stopped = false;
  private readonly listeners: Array<(info: ExitInfo) => void> = [];

  constructor(port: number) {
    this.port = port;
    this.pid = 100000 + port;
  }

  async healthCheck(): Promise<boolean> {
    return this.healthy && !this.stopped;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  onExit(listener: (info: ExitInfo) => void): void {
    this.listeners.push(listener);
  }

  /** Simulate an unexpected crash. */
  crash(code = 1): void {
    for (const l of this.listeners) l({ code, signal: null });
  }
}

/** In-memory backend that records every spawn; no real processes involved. */
export class FakeBackend implements Backend {
  readonly kind = "fake";
  readonly instances: FakeInstance[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async spawn(_model: ModelSpec, port: number): Promise<BackendInstance> {
    const inst = new FakeInstance(port);
    this.instances.push(inst);
    return inst;
  }
}

/** POST JSON and return { status, json }. */
export function postJson(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const url = new URL(path, base);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** GET JSON and return { status, json }. */
export function getJson(base: string, path: string): Promise<{ status: number; json: unknown }> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, path: url.pathname, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Collect SSE `data:` chunks from a streaming POST. */
export function collectSse(
  base: string,
  path: string,
  body: unknown,
): Promise<{ chunks: unknown[]; sawDone: boolean }> {
  const url = new URL(path, base);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks: unknown[] = [];
        let sawDone = false;
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          buffer += c;
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const event = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of event.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (data === "[DONE]") {
                sawDone = true;
                continue;
              }
              chunks.push(JSON.parse(data));
            }
          }
        });
        res.on("end", () => resolve({ chunks, sawDone }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** Poll `check` until it returns true or the deadline passes. */
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error("condition not met before timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}
