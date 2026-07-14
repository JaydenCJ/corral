import { spawn } from "node:child_process";
import {
  type Backend,
  type BackendInstance,
  type ModelSpec,
  ProcessBackendInstance,
} from "./backend.js";
import { which } from "./which.js";

export interface LlamaCppOptions {
  /** Override the llama-server binary name or absolute path. */
  binary?: string;
  /** Host to bind; defaults to loopback. */
  host?: string;
  /** Extra raw args appended to the llama-server invocation. */
  extraArgs?: string[];
}

/**
 * Assemble the llama-server argument vector. Pure and exported so the exact
 * command line is unit-tested without needing the binary installed.
 */
export function buildLlamaArgs(model: ModelSpec, port: number, host: string): string[] {
  if (!model.path) {
    throw new Error(`model "${model.id}" has no GGUF path; run \`corral pull\` first`);
  }
  const args = ["--model", model.path, "--host", host, "--port", String(port)];
  if (model.ctxSize && model.ctxSize > 0) {
    args.push("--ctx-size", String(model.ctxSize));
  }
  return args;
}

/**
 * Backend that drives a user-installed, upstream `llama-server` binary from
 * llama.cpp. Corral does not fork, vendor, or bundle llama.cpp: it locates the
 * binary on PATH and passes GGUF files through unchanged. Install it yourself,
 * e.g. `brew install llama.cpp`.
 */
export class LlamaCppBackend implements Backend {
  readonly kind = "llamacpp";
  private readonly binaryName: string;
  private readonly host: string;
  private readonly extraArgs: string[];

  constructor(options: LlamaCppOptions = {}) {
    this.binaryName = options.binary ?? "llama-server";
    this.host = options.host ?? "127.0.0.1";
    this.extraArgs = options.extraArgs ?? [];
  }

  async isAvailable(): Promise<boolean> {
    return which(this.binaryName) !== null;
  }

  async spawn(model: ModelSpec, port: number): Promise<BackendInstance> {
    const resolved = which(this.binaryName);
    if (!resolved) {
      throw new Error(
        `llama-server not found on PATH. Install llama.cpp (e.g. \`brew install llama.cpp\`) ` +
          `or set the backend binary in ~/.corral/config.json.`,
      );
    }
    const args = [...buildLlamaArgs(model, port, this.host), ...this.extraArgs];
    const child = spawn(resolved, args, { stdio: ["ignore", "pipe", "pipe"] });
    if (process.env.CORRAL_DEBUG === "1") {
      child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[llama:${model.id}] ${d}`));
    }
    // llama-server exposes /health: 503 while loading, 200 once ready.
    return new ProcessBackendInstance({
      child,
      port,
      host: this.host,
      healthPath: "/health",
      healthAccept: (s) => s === 200,
    });
  }
}
