import type { Readable } from "node:stream";

/** One file entry from a Hugging Face repo tree. */
export interface HfFileEntry {
  path: string;
  size: number;
}

/** A byte stream for a (possibly partial) file download. */
export interface HfDownloadHandle {
  /** Total size of the complete file in bytes. */
  totalSize: number;
  /** HTTP status: 200 for a full body, 206 for a satisfied Range request. */
  statusCode: number;
  /** The bytes, starting at the requested offset. */
  stream: Readable;
}

/**
 * Abstraction over the Hugging Face Hub. Business logic (pull, quant selection,
 * resumable download) depends only on this interface, never on a concrete HTTP
 * client. Tests inject a deterministic in-memory implementation so the suite
 * never touches the network and never downloads real weights.
 */
export interface HuggingFaceClient {
  /** List every file in the repo at a revision. */
  listFiles(repo: string, revision: string): Promise<HfFileEntry[]>;
  /** Open a download stream, optionally resuming from a byte offset. */
  openDownload(
    repo: string,
    filePath: string,
    revision: string,
    rangeStart: number,
  ): Promise<HfDownloadHandle>;
  /** The stable resolve URL recorded in the manifest as the source. */
  resolveUrl(repo: string, filePath: string, revision: string): string;
}
