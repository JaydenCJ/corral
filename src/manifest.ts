import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { modelsDir, sanitizeModelId } from "./paths.js";

/**
 * On-disk record for a pulled model. Corral has no private registry: a model is
 * just the GGUF file on your disk plus this manifest describing where it came
 * from. `sha256` is null unless the pull was run with checksum verification
 * enabled, so the field is always present but honestly optional.
 */
export interface ModelManifest {
  id: string;
  repo: string;
  quant: string;
  file: string;
  path: string;
  sourceUrl: string;
  sha256: string | null;
  sizeBytes: number;
  revision: string;
  pulledAt: string;
  corralVersion: string;
}

const MANIFEST_FILE = "manifest.json";

function manifestPathFor(id: string, root: string): string {
  return join(root, sanitizeModelId(id), MANIFEST_FILE);
}

/** Directory a model's files live in. */
export function modelDirFor(id: string, root: string = modelsDir()): string {
  return join(root, sanitizeModelId(id));
}

/** Write (or overwrite) a model manifest, creating its directory. */
export function writeManifest(manifest: ModelManifest, root: string = modelsDir()): void {
  const dir = modelDirFor(manifest.id, root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

/** Read a single manifest by exact model id. Returns null if not present. */
export function readManifest(id: string, root: string = modelsDir()): ModelManifest | null {
  const p = manifestPathFor(id, root);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ModelManifest;
  } catch {
    return null;
  }
}

/** Enumerate every model that has a readable manifest, sorted by id. */
export function listManifests(root: string = modelsDir()): ModelManifest[] {
  if (!existsSync(root)) return [];
  const out: ModelManifest[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(root, entry.name, MANIFEST_FILE);
    if (!existsSync(p)) continue;
    try {
      out.push(JSON.parse(readFileSync(p, "utf8")) as ModelManifest);
    } catch {
      // Skip corrupt manifests rather than failing the whole listing.
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Resolve a user-supplied model reference to a manifest. Accepts the exact id
 * ("repo:quant") or a shorthand (just the repo, or the repo's last path
 * segment) as long as it is unambiguous.
 */
export function resolveManifest(ref: string, root: string = modelsDir()): ModelManifest | null {
  const exact = readManifest(ref, root);
  if (exact) return exact;
  const all = listManifests(root);
  const matches = all.filter(
    (m) => m.repo === ref || m.repo.split("/").pop() === ref || m.id.startsWith(ref + ":"),
  );
  if (matches.length === 1) return matches[0] ?? null;
  return null;
}

/** Remove a model directory. Returns true if something was deleted. */
export function removeModel(id: string, root: string = modelsDir()): boolean {
  const dir = modelDirFor(id, root);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Best-effort on-disk size of a model directory in bytes. */
export function modelSizeOnDisk(id: string, root: string = modelsDir()): number {
  const dir = modelDirFor(id, root);
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) {
      try {
        total += statSync(join(dir, entry.name)).size;
      } catch {
        // ignore unreadable files
      }
    }
  }
  return total;
}
