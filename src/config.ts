import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "./paths.js";

/** Backend identifier accepted by the config and the --backend flag. */
export type BackendKind = "llamacpp" | "mlx" | "mock";

export interface CorralConfig {
  /** Which inference backend to launch. */
  backend: BackendKind;
  /** Interface the serve/ inline server binds to. Defaults to loopback only. */
  host: string;
  /** Port for `corral serve`. */
  port: number;
  /** Maximum number of models kept resident at once; excess is LRU-evicted. */
  maxLoaded: number;
  /** Milliseconds a model may sit idle before it is reaped. */
  idleTimeoutMs: number;
  /** Context window passed to the backend. */
  ctxSize: number;
  /** Maximum automatic restarts after a backend crash, per model. */
  maxRestarts: number;
}

export const DEFAULT_CONFIG: CorralConfig = {
  backend: "llamacpp",
  host: "127.0.0.1",
  port: 11435,
  maxLoaded: 1,
  idleTimeoutMs: 5 * 60 * 1000,
  ctxSize: 4096,
  maxRestarts: 3,
};

const BACKENDS: readonly BackendKind[] = ["llamacpp", "mlx", "mock"];

function coerce(raw: unknown): Partial<CorralConfig> {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<CorralConfig> = {};
  if (typeof r.backend === "string" && (BACKENDS as string[]).includes(r.backend)) {
    out.backend = r.backend as BackendKind;
  }
  if (typeof r.host === "string") out.host = r.host;
  if (typeof r.port === "number") out.port = r.port;
  if (typeof r.maxLoaded === "number") out.maxLoaded = r.maxLoaded;
  if (typeof r.idleTimeoutMs === "number") out.idleTimeoutMs = r.idleTimeoutMs;
  if (typeof r.ctxSize === "number") out.ctxSize = r.ctxSize;
  if (typeof r.maxRestarts === "number") out.maxRestarts = r.maxRestarts;
  return out;
}

/** Load config from disk merged over defaults. Missing file returns defaults. */
export function loadConfig(path: string = configPath()): CorralConfig {
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`invalid config at ${path}: ${(err as Error).message}`);
  }
  return { ...DEFAULT_CONFIG, ...coerce(parsed) };
}

/** Persist a config object, creating the parent directory if needed. */
export function saveConfig(config: CorralConfig, path: string = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/** Validate a backend name coming from a CLI flag. Throws on unknown values. */
export function parseBackendKind(value: string): BackendKind {
  if ((BACKENDS as string[]).includes(value)) return value as BackendKind;
  throw new Error(`unknown backend "${value}" (expected one of: ${BACKENDS.join(", ")})`);
}
