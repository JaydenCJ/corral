import { spawn } from "node:child_process";
import {
  type Backend,
  type BackendInstance,
  type ModelSpec,
  ProcessBackendInstance,
} from "./backend.js";
import { which } from "./which.js";

export interface MlxOptions {
  /** Override the mlx_lm.server binary name or absolute path. */
  binary?: string;
  host?: string;
  extraArgs?: string[];
}

/**
 * Assemble the mlx_lm.server argument vector. Pure and exported for unit tests.
 */
export function buildMlxArgs(model: ModelSpec, port: number, host: string): string[] {
  if (!model.path) {
    throw new Error(`model "${model.id}" has no path; run \`corral pull\` first`);
  }
  return ["--model", model.path, "--host", host, "--port", String(port)];
}

/**
 * Backend that drives Apple's `mlx_lm.server` from the mlx-lm package. MLX runs
 * only on Apple Silicon macOS, so this backend reports unavailable on every
 * other platform. Corral bundles nothing: install it yourself with
 * `pip install mlx-lm`.
 */
export class MlxBackend implements Backend {
  readonly kind = "mlx";
  private readonly binaryName: string;
  private readonly host: string;
  private readonly extraArgs: string[];

  constructor(options: MlxOptions = {}) {
    this.binaryName = options.binary ?? "mlx_lm.server";
    this.host = options.host ?? "127.0.0.1";
    this.extraArgs = options.extraArgs ?? [];
  }

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    return which(this.binaryName) !== null;
  }

  async spawn(model: ModelSpec, port: number): Promise<BackendInstance> {
    if (process.platform !== "darwin") {
      throw new Error("the MLX backend is only available on Apple Silicon macOS");
    }
    const resolved = which(this.binaryName);
    if (!resolved) {
      throw new Error(
        `mlx_lm.server not found on PATH. Install it with \`pip install mlx-lm\` ` +
          `or choose a different backend.`,
      );
    }
    const args = [...buildMlxArgs(model, port, this.host), ...this.extraArgs];
    const child = spawn(resolved, args, { stdio: ["ignore", "pipe", "pipe"] });
    if (process.env.CORRAL_DEBUG === "1") {
      child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[mlx:${model.id}] ${d}`));
    }
    // mlx_lm.server has no /health route; a 200 on /v1/models means it is up.
    return new ProcessBackendInstance({
      child,
      port,
      host: this.host,
      healthPath: "/v1/models",
      healthAccept: (s) => s === 200,
    });
  }
}
