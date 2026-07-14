import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the Corral home directory. Honors CORRAL_HOME so tests and power
 * users can redirect all state (config + models) to an isolated location.
 */
export function corralHome(): string {
  const override = process.env.CORRAL_HOME;
  if (override && override.length > 0) return override;
  return join(homedir(), ".corral");
}

/** Directory holding downloaded GGUF models, one subdirectory per model. */
export function modelsDir(): string {
  return join(corralHome(), "models");
}

/** Path to the JSON config file. */
export function configPath(): string {
  return join(corralHome(), "config.json");
}

/**
 * Turn a model id like "TheBloke/Llama-2-7B-GGUF:Q4_K_M" into a filesystem-safe
 * directory name. The reverse mapping is stored in each model's manifest, so the
 * exact sanitized form only needs to be stable, not reversible.
 */
export function sanitizeModelId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}
