import type { BackendKind, CorralConfig } from "../config.js";
import type { Backend } from "./backend.js";
import { LlamaCppBackend } from "./llamacpp.js";
import { MlxBackend } from "./mlx.js";
import { MockBackend } from "./mock.js";

/** Construct the backend named by `kind`, wiring in host/ctx from config. */
export function createBackend(kind: BackendKind, config: CorralConfig): Backend {
  switch (kind) {
    case "mock":
      return new MockBackend();
    case "llamacpp":
      return new LlamaCppBackend({ host: config.host });
    case "mlx":
      return new MlxBackend({ host: config.host });
    default: {
      const exhaustive: never = kind;
      throw new Error(`unknown backend: ${String(exhaustive)}`);
    }
  }
}
