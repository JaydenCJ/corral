import { downloadFile } from "../download.js";
import type { HuggingFaceClient } from "../hf/client.js";
import { selectGguf } from "../hf/quant.js";
import { type Logger, silentLogger } from "../logger.js";
import { modelDirFor, type ModelManifest, writeManifest } from "../manifest.js";
import { modelsDir } from "../paths.js";
import { VERSION } from "../version.js";

export interface PullRef {
  repo: string;
  quant?: string;
  revision: string;
}

/**
 * Parse a pull reference like `owner/name:Q4_K_M@main`. The revision (`@ref`)
 * and quant (`:tag`) are both optional; revision defaults to `main`.
 */
export function parsePullRef(input: string): PullRef {
  let rest = input.trim();
  let revision = "main";
  const at = rest.lastIndexOf("@");
  if (at > 0) {
    revision = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let quant: string | undefined;
  const colon = rest.indexOf(":");
  if (colon > 0) {
    quant = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (!rest.includes("/")) {
    throw new Error(`invalid repo "${input}"; expected the form owner/name[:quant]`);
  }
  return { repo: rest, quant, revision };
}

export interface PullOptions {
  client: HuggingFaceClient;
  root?: string;
  logger?: Logger;
  checksum?: boolean;
  onProgress?: (downloaded: number, total: number) => void;
}

/**
 * Full pull pipeline: list repo files, pick the GGUF for the requested quant,
 * download it with resume support into the model directory, and write a
 * manifest recording the source URL, size, quant, and (optionally) sha256.
 * The HuggingFaceClient is injected, so tests exercise the whole pipeline with
 * an offline mock and never download real weights.
 */
export async function pullModel(ref: PullRef, opts: PullOptions): Promise<ModelManifest> {
  const logger = opts.logger ?? silentLogger;
  const root = opts.root ?? modelsDir();

  logger.info(`resolving ${ref.repo} (revision: ${ref.revision})`);
  const files = await opts.client.listFiles(ref.repo, ref.revision);
  const { file, quant } = selectGguf(files, ref.quant);
  const id = `${ref.repo}:${quant}`;
  logger.info(`selected ${file.path} (${quant}, ${formatBytes(file.size)})`);

  const dir = modelDirFor(id, root);
  const result = await downloadFile(opts.client, ref.repo, file.path, ref.revision, dir, {
    checksum: opts.checksum,
    expectedSize: file.size,
    onProgress: opts.onProgress,
  });

  const manifest: ModelManifest = {
    id,
    repo: ref.repo,
    quant,
    file: file.path.split("/").pop() ?? file.path,
    path: result.path,
    sourceUrl: opts.client.resolveUrl(ref.repo, file.path, ref.revision),
    sha256: result.sha256,
    sizeBytes: result.sizeBytes,
    revision: ref.revision,
    pulledAt: new Date().toISOString(),
    corralVersion: VERSION,
  };
  writeManifest(manifest, root);
  logger.info(`pulled "${id}" -> ${result.path}`);
  return manifest;
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
