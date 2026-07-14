import { Readable } from "node:stream";
import type { HfDownloadHandle, HfFileEntry, HuggingFaceClient } from "./client.js";

const HF_BASE = "https://huggingface.co";

interface TreeEntry {
  type: string;
  path: string;
  size?: number;
}

/**
 * Real Hugging Face Hub client backed by the public HTTP API. Uses the global
 * fetch (Node >= 20). Only reads public metadata and file bytes; it performs no
 * writes and sends no telemetry. An HF token, if present in HF_TOKEN, is used
 * only as a bearer for private/gated repos.
 */
export class RealHuggingFaceClient implements HuggingFaceClient {
  private readonly base: string;
  private readonly token: string | undefined;

  constructor(opts: { base?: string; token?: string } = {}) {
    this.base = opts.base ?? HF_BASE;
    this.token = opts.token ?? process.env.HF_TOKEN ?? undefined;
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  async listFiles(repo: string, revision: string): Promise<HfFileEntry[]> {
    const url = `${this.base}/api/models/${repo}/tree/${encodeURIComponent(revision)}?recursive=1`;
    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) {
      throw new Error(`Hugging Face API returned ${res.status} for ${repo} (${res.statusText})`);
    }
    const body = (await res.json()) as TreeEntry[];
    return body
      .filter((e) => e.type === "file")
      .map((e) => ({ path: e.path, size: typeof e.size === "number" ? e.size : 0 }));
  }

  resolveUrl(repo: string, filePath: string, revision: string): string {
    return `${this.base}/${repo}/resolve/${encodeURIComponent(revision)}/${filePath}`;
  }

  async openDownload(
    repo: string,
    filePath: string,
    revision: string,
    rangeStart: number,
  ): Promise<HfDownloadHandle> {
    const url = this.resolveUrl(repo, filePath, revision);
    const headers: Record<string, string> = { ...this.authHeaders() };
    if (rangeStart > 0) headers.range = `bytes=${rangeStart}-`;
    const res = await fetch(url, { headers, redirect: "follow" });
    if (!res.ok && res.status !== 206) {
      throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
    }
    if (!res.body) {
      throw new Error(`download failed: empty body for ${url}`);
    }
    const contentLength = Number(res.headers.get("content-length") ?? "0");
    const totalSize =
      res.status === 206 ? rangeStart + contentLength : contentLength || rangeStart + contentLength;
    // Convert the web ReadableStream from fetch into a Node stream.
    const stream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    return { totalSize, statusCode: res.status, stream };
  }
}
