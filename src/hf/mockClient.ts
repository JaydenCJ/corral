import { Readable } from "node:stream";
import type { HfDownloadHandle, HfFileEntry, HuggingFaceClient } from "./client.js";

interface MockRepo {
  files: HfFileEntry[];
  /** Full bytes for each file path, used to serve deterministic downloads. */
  contents: Record<string, Buffer>;
}

/**
 * Deterministic, offline Hugging Face client for tests and demos. It never
 * touches the network and never downloads real weights: file bodies are small,
 * synthetic buffers supplied by the test. It honors byte-range requests so the
 * resumable-download path can be exercised without a real server.
 */
export class MockHuggingFaceClient implements HuggingFaceClient {
  private readonly repos = new Map<string, MockRepo>();
  public readonly downloadCalls: Array<{ repo: string; path: string; rangeStart: number }> = [];

  /** Register a repo. If contents are omitted, files download as zero bytes. */
  addRepo(repo: string, files: HfFileEntry[], contents: Record<string, Buffer> = {}): void {
    this.repos.set(repo, { files, contents });
  }

  private repoOrThrow(repo: string): MockRepo {
    const r = this.repos.get(repo);
    if (!r) throw new Error(`mock: unknown repo ${repo}`);
    return r;
  }

  async listFiles(repo: string): Promise<HfFileEntry[]> {
    return this.repoOrThrow(repo).files.slice();
  }

  resolveUrl(repo: string, filePath: string, revision: string): string {
    return `https://huggingface.co/${repo}/resolve/${revision}/${filePath}`;
  }

  async openDownload(
    repo: string,
    filePath: string,
    _revision: string,
    rangeStart: number,
  ): Promise<HfDownloadHandle> {
    this.downloadCalls.push({ repo, path: filePath, rangeStart });
    const r = this.repoOrThrow(repo);
    const full = r.contents[filePath] ?? Buffer.alloc(0);
    const slice = rangeStart > 0 ? full.subarray(rangeStart) : full;
    const stream = Readable.from([slice]);
    return {
      totalSize: full.length,
      statusCode: rangeStart > 0 ? 206 : 200,
      stream,
    };
  }
}
