import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { HuggingFaceClient } from "./hf/client.js";

export interface DownloadResult {
  path: string;
  sizeBytes: number;
  sha256: string | null;
  resumedFrom: number;
}

export interface DownloadOptions {
  /** Compute a sha256 of the finished file. Off by default for large weights. */
  checksum?: boolean;
  /**
   * Known final size of the file (e.g. from the Hugging Face file listing). When
   * provided it guards the resumable path: a `.part` already larger than this is
   * treated as stale and discarded, and a finished download whose size does not
   * match is rejected instead of being silently renamed into place.
   */
  expectedSize?: number;
  /** Progress callback: (bytesDownloaded, totalBytes). */
  onProgress?: (downloaded: number, total: number) => void;
}

/**
 * Download a single file into `destDir` with resume support. A partial download
 * is written to `<name>.part`; on completion it is renamed to the final name.
 * If a `.part` already exists, the download resumes from its current length via
 * an HTTP Range request. If the server ignores the range (returns 200), the
 * partial file is truncated and the download restarts from zero.
 */
export async function downloadFile(
  client: HuggingFaceClient,
  repo: string,
  filePath: string,
  revision: string,
  destDir: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  mkdirSync(destDir, { recursive: true });
  const finalPath = join(destDir, basename(filePath));
  const partPath = `${finalPath}.part`;

  if (existsSync(finalPath)) {
    const size = statSync(finalPath).size;
    return {
      path: finalPath,
      sizeBytes: size,
      sha256: opts.checksum ? await hashFile(finalPath) : null,
      resumedFrom: size,
    };
  }

  let rangeStart = existsSync(partPath) ? statSync(partPath).size : 0;
  // A `.part` bigger than the known final size cannot be a valid prefix of the
  // current remote file (stale partial, changed revision, or unrelated job).
  // Discard it and restart rather than resuming onto bytes we would corrupt.
  if (opts.expectedSize && opts.expectedSize > 0 && rangeStart > opts.expectedSize) {
    rmSync(partPath, { force: true });
    rangeStart = 0;
  }
  const handle = await client.openDownload(repo, filePath, revision, rangeStart);

  // The server may ignore our Range and send the whole file (200). In that case
  // we must overwrite from the start, not append to the stale partial bytes.
  const resuming = handle.statusCode === 206 && rangeStart > 0;
  if (!resuming) rangeStart = 0;

  const out = createWriteStream(partPath, { flags: resuming ? "a" : "w" });
  let downloaded = rangeStart;
  const total = handle.totalSize || rangeStart;

  handle.stream.on("data", (chunk: Buffer) => {
    downloaded += chunk.length;
    opts.onProgress?.(downloaded, total);
  });

  await pipeline(handle.stream, out);

  // Reject a size mismatch before publishing the file: renaming a corrupt body
  // into place would make later pulls short-circuit on it. Remove the `.part` so
  // a re-run starts clean instead of resuming onto the bad bytes.
  const partSize = statSync(partPath).size;
  if (opts.expectedSize && opts.expectedSize > 0 && partSize !== opts.expectedSize) {
    rmSync(partPath, { force: true });
    throw new Error(
      `download size mismatch for ${basename(filePath)}: got ${partSize} bytes, ` +
        `expected ${opts.expectedSize}; the partial download was discarded, please retry`,
    );
  }
  renameSync(partPath, finalPath);

  const sizeBytes = statSync(finalPath).size;
  return {
    path: finalPath,
    sizeBytes,
    sha256: opts.checksum ? await hashFile(finalPath) : null,
    resumedFrom: rangeStart,
  };
}

async function hashFile(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}
