import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadFile } from "../src/download.js";
import { MockHuggingFaceClient } from "../src/hf/mockClient.js";
import { rmDir, tmpDir } from "./helpers.js";

let dir: string;
const CONTENT = Buffer.from("the quick brown fox jumps over the lazy dog".repeat(8));

beforeEach(() => {
  dir = tmpDir();
});
afterEach(() => {
  rmDir(dir);
});

describe("downloadFile", () => {
  it("downloads a full file and renames off the .part suffix", async () => {
    const client = new MockHuggingFaceClient();
    client.addRepo("owner/repo", [{ path: "model.gguf", size: CONTENT.length }], {
      "model.gguf": CONTENT,
    });
    const result = await downloadFile(client, "owner/repo", "model.gguf", "main", dir);
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(result.path + ".part")).toBe(false);
    expect(readFileSync(result.path)).toEqual(CONTENT);
    expect(result.sizeBytes).toBe(CONTENT.length);
    expect(result.resumedFrom).toBe(0);
  });

  it("resumes from an existing .part using a byte-range request", async () => {
    const client = new MockHuggingFaceClient();
    client.addRepo("owner/repo", [{ path: "model.gguf", size: CONTENT.length }], {
      "model.gguf": CONTENT,
    });
    // Pre-seed a half-finished download.
    const half = Math.floor(CONTENT.length / 2);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model.gguf.part"), CONTENT.subarray(0, half));

    const result = await downloadFile(client, "owner/repo", "model.gguf", "main", dir);
    expect(result.resumedFrom).toBe(half);
    expect(readFileSync(result.path)).toEqual(CONTENT);
    // The client must have been asked for a ranged download starting at `half`.
    expect(client.downloadCalls).toEqual([{ repo: "owner/repo", path: "model.gguf", rangeStart: half }]);
  });

  it("computes a sha256 when checksum is enabled", async () => {
    const client = new MockHuggingFaceClient();
    client.addRepo("owner/repo", [{ path: "model.gguf", size: CONTENT.length }], {
      "model.gguf": CONTENT,
    });
    const result = await downloadFile(client, "owner/repo", "model.gguf", "main", dir, {
      checksum: true,
    });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("discards a stale .part larger than the expected size and restarts", async () => {
    const client = new MockHuggingFaceClient();
    client.addRepo("owner/repo", [{ path: "model.gguf", size: CONTENT.length }], {
      "model.gguf": CONTENT,
    });
    // A .part bigger than the real file cannot be a valid prefix; it must not be
    // resumed onto (that would silently corrupt the GGUF with checksum off).
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model.gguf.part"), Buffer.alloc(CONTENT.length + 64, 0x7a));

    const result = await downloadFile(client, "owner/repo", "model.gguf", "main", dir, {
      expectedSize: CONTENT.length,
    });
    expect(result.resumedFrom).toBe(0); // restarted from scratch, no resume
    expect(readFileSync(result.path)).toEqual(CONTENT);
    expect(client.downloadCalls).toEqual([{ repo: "owner/repo", path: "model.gguf", rangeStart: 0 }]);
  });

  it("rejects and cleans up when the finished size does not match expectedSize", async () => {
    const client = new MockHuggingFaceClient();
    client.addRepo("owner/repo", [{ path: "model.gguf", size: CONTENT.length }], {
      "model.gguf": CONTENT,
    });
    await expect(
      // The delivered body cannot match a deliberately wrong expected size.
      downloadFile(client, "owner/repo", "model.gguf", "main", dir, {
        expectedSize: CONTENT.length + 1000,
      }),
    ).rejects.toThrow(/size mismatch/);
    expect(existsSync(join(dir, "model.gguf"))).toBe(false); // never published
    expect(existsSync(join(dir, "model.gguf.part"))).toBe(false); // .part cleaned up
  });

  it("short-circuits when the final file already exists", async () => {
    const client = new MockHuggingFaceClient();
    client.addRepo("owner/repo", [{ path: "model.gguf", size: CONTENT.length }], {
      "model.gguf": CONTENT,
    });
    await downloadFile(client, "owner/repo", "model.gguf", "main", dir);
    client.downloadCalls.length = 0;
    await downloadFile(client, "owner/repo", "model.gguf", "main", dir);
    expect(client.downloadCalls).toHaveLength(0); // no re-download
  });
});
