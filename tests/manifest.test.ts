import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listManifests,
  type ModelManifest,
  readManifest,
  removeModel,
  resolveManifest,
  writeManifest,
} from "../src/manifest.js";
import { rmDir, tmpDir } from "./helpers.js";

let root: string;

function fixture(id: string, repo: string, quant: string): ModelManifest {
  return {
    id,
    repo,
    quant,
    file: "model.gguf",
    path: `/nonexistent/${id}/model.gguf`,
    sourceUrl: `https://huggingface.co/${repo}/resolve/main/model.gguf`,
    sha256: null,
    sizeBytes: 1234,
    revision: "main",
    pulledAt: "2026-07-08T00:00:00.000Z",
    corralVersion: "0.1.0",
  };
}

beforeEach(() => {
  root = tmpDir();
});
afterEach(() => {
  rmDir(root);
});

describe("manifest store", () => {
  it("writes and reads a manifest round-trip", () => {
    const m = fixture("owner/repo:Q4_K_M", "owner/repo", "Q4_K_M");
    writeManifest(m, root);
    expect(readManifest("owner/repo:Q4_K_M", root)).toEqual(m);
  });

  it("returns null for an unknown model", () => {
    expect(readManifest("nope/nope:Q4", root)).toBeNull();
  });

  it("lists all manifests sorted by id", () => {
    writeManifest(fixture("b/b:Q4_K_M", "b/b", "Q4_K_M"), root);
    writeManifest(fixture("a/a:Q8_0", "a/a", "Q8_0"), root);
    const ids = listManifests(root).map((m) => m.id);
    expect(ids).toEqual(["a/a:Q8_0", "b/b:Q4_K_M"]);
  });

  it("resolves by repo shorthand and last path segment", () => {
    writeManifest(fixture("TheBloke/Llama-2-7B-GGUF:Q4_K_M", "TheBloke/Llama-2-7B-GGUF", "Q4_K_M"), root);
    expect(resolveManifest("TheBloke/Llama-2-7B-GGUF", root)?.quant).toBe("Q4_K_M");
    expect(resolveManifest("Llama-2-7B-GGUF", root)?.quant).toBe("Q4_K_M");
  });

  it("removes a model directory", () => {
    const m = fixture("x/y:Q4_K_M", "x/y", "Q4_K_M");
    writeManifest(m, root);
    expect(removeModel("x/y:Q4_K_M", root)).toBe(true);
    expect(readManifest("x/y:Q4_K_M", root)).toBeNull();
    expect(removeModel("x/y:Q4_K_M", root)).toBe(false);
  });
});
