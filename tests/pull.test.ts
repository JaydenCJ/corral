import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockHuggingFaceClient } from "../src/hf/mockClient.js";
import { readManifest } from "../src/manifest.js";
import { parsePullRef, pullModel } from "../src/commands/pull.js";
import { rmDir, tmpDir } from "./helpers.js";

let root: string;

beforeEach(() => {
  root = tmpDir();
});
afterEach(() => {
  rmDir(root);
});

describe("parsePullRef", () => {
  it("parses repo, quant, and revision", () => {
    expect(parsePullRef("owner/name:Q4_K_M")).toEqual({
      repo: "owner/name",
      quant: "Q4_K_M",
      revision: "main",
    });
    expect(parsePullRef("owner/name")).toEqual({ repo: "owner/name", quant: undefined, revision: "main" });
    expect(parsePullRef("owner/name:Q8_0@v1.0")).toEqual({
      repo: "owner/name",
      quant: "Q8_0",
      revision: "v1.0",
    });
  });

  it("rejects a reference without an owner", () => {
    expect(() => parsePullRef("justaname")).toThrow(/expected the form owner\/name/);
  });
});

describe("pullModel", () => {
  function client(): MockHuggingFaceClient {
    const c = new MockHuggingFaceClient();
    const body = Buffer.from("GGUF" + "x".repeat(200));
    c.addRepo(
      "TheBloke/Demo-GGUF",
      [
        { path: "demo.Q4_K_M.gguf", size: body.length },
        { path: "demo.Q8_0.gguf", size: body.length },
      ],
      { "demo.Q4_K_M.gguf": body, "demo.Q8_0.gguf": body },
    );
    return c;
  }

  it("pulls the requested quant, writes the file and a manifest", async () => {
    const c = client();
    const manifest = await pullModel(
      { repo: "TheBloke/Demo-GGUF", quant: "Q4_K_M", revision: "main" },
      { client: c, root },
    );
    expect(manifest.id).toBe("TheBloke/Demo-GGUF:Q4_K_M");
    expect(manifest.quant).toBe("Q4_K_M");
    expect(manifest.file).toBe("demo.Q4_K_M.gguf");
    expect(manifest.sourceUrl).toBe(
      "https://huggingface.co/TheBloke/Demo-GGUF/resolve/main/demo.Q4_K_M.gguf",
    );
    expect(manifest.sha256).toBeNull(); // null unless --checksum
    expect(readFileSync(manifest.path).toString()).toContain("GGUF");

    // Manifest is persisted and resolvable.
    expect(readManifest("TheBloke/Demo-GGUF:Q4_K_M", root)?.id).toBe("TheBloke/Demo-GGUF:Q4_K_M");
  });

  it("defaults to Q4_K_M when no quant is requested", async () => {
    const manifest = await pullModel(
      { repo: "TheBloke/Demo-GGUF", revision: "main" },
      { client: client(), root },
    );
    expect(manifest.quant).toBe("Q4_K_M");
  });
});
