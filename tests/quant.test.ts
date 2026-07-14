import { describe, expect, it } from "vitest";
import { extractQuant, isSplitGguf, selectGguf } from "../src/hf/quant.js";
import type { HfFileEntry } from "../src/hf/client.js";

const repo: HfFileEntry[] = [
  { path: "README.md", size: 1000 },
  { path: "config.json", size: 500 },
  { path: "llama-2-7b.Q4_K_M.gguf", size: 4_000_000 },
  { path: "llama-2-7b.Q8_0.gguf", size: 7_000_000 },
  { path: "llama-2-7b.Q5_K_M.gguf", size: 5_000_000 },
];

describe("extractQuant", () => {
  it("pulls the quant tag from a GGUF filename", () => {
    expect(extractQuant("llama-2-7b.Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(extractQuant("model.Q8_0.gguf")).toBe("Q8_0");
    expect(extractQuant("mixtral.IQ3_XXS.gguf")).toBe("IQ3_XXS");
    expect(extractQuant("model.f16.gguf")).toBe("F16");
  });

  it("returns null when no quant tag is present", () => {
    expect(extractQuant("model.gguf")).toBeNull();
  });
});

describe("isSplitGguf", () => {
  it("detects multi-part split files", () => {
    expect(isSplitGguf("big-model-00001-of-00003.gguf")).toBe(true);
    expect(isSplitGguf("model.Q4_K_M.gguf")).toBe(false);
  });
});

describe("selectGguf", () => {
  it("selects the exact quant when specified", () => {
    const sel = selectGguf(repo, "Q8_0");
    expect(sel.file.path).toBe("llama-2-7b.Q8_0.gguf");
    expect(sel.quant).toBe("Q8_0");
  });

  it("is case-insensitive on the quant needle", () => {
    expect(selectGguf(repo, "q5_k_m").file.path).toBe("llama-2-7b.Q5_K_M.gguf");
  });

  it("falls back to the Q4_K_M default when no quant is given", () => {
    expect(selectGguf(repo).file.path).toBe("llama-2-7b.Q4_K_M.gguf");
  });

  it("throws a helpful error when the quant is not available", () => {
    expect(() => selectGguf(repo, "Q2_K")).toThrow(/no GGUF file matching quant "Q2_K"/);
  });

  it("throws when the repo has no GGUF files", () => {
    expect(() => selectGguf([{ path: "README.md", size: 1 }])).toThrow(/no \.gguf files/);
  });

  it("rejects split GGUFs with a clear message", () => {
    const split: HfFileEntry[] = [{ path: "big-00001-of-00003.gguf", size: 1 }];
    expect(() => selectGguf(split)).toThrow(/split \(multi-part\) GGUF/);
  });
});
