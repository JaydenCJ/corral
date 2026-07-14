import { describe, expect, it } from "vitest";
import { buildLlamaArgs, LlamaCppBackend } from "../src/backend/llamacpp.js";
import { buildMlxArgs, MlxBackend } from "../src/backend/mlx.js";
import { which } from "../src/backend/which.js";

describe("buildLlamaArgs", () => {
  it("assembles model, host, port, and ctx-size", () => {
    const args = buildLlamaArgs({ id: "m", path: "/models/m.gguf", ctxSize: 8192 }, 8080, "127.0.0.1");
    expect(args).toEqual([
      "--model",
      "/models/m.gguf",
      "--host",
      "127.0.0.1",
      "--port",
      "8080",
      "--ctx-size",
      "8192",
    ]);
  });

  it("omits ctx-size when not provided", () => {
    const args = buildLlamaArgs({ id: "m", path: "/models/m.gguf" }, 9000, "127.0.0.1");
    expect(args).not.toContain("--ctx-size");
  });

  it("throws when the model has no path", () => {
    expect(() => buildLlamaArgs({ id: "m" }, 9000, "127.0.0.1")).toThrow(/no GGUF path/);
  });
});

describe("buildMlxArgs", () => {
  it("assembles model, host, and port", () => {
    expect(buildMlxArgs({ id: "m", path: "/models/m" }, 8080, "127.0.0.1")).toEqual([
      "--model",
      "/models/m",
      "--host",
      "127.0.0.1",
      "--port",
      "8080",
    ]);
  });
});

describe("which", () => {
  it("finds a ubiquitous binary and misses a nonexistent one", () => {
    // `node` is guaranteed present because the tests run under it.
    expect(which("node")).not.toBeNull();
    expect(which("definitely-not-a-real-binary-xyz")).toBeNull();
  });
});

describe("backend availability", () => {
  it("LlamaCppBackend reports unavailable when llama-server is absent", async () => {
    // The container has no llama.cpp installed; the probe must fail gracefully.
    const available = await new LlamaCppBackend().isAvailable();
    expect(available).toBe(which("llama-server") !== null);
  });

  it("MlxBackend is unavailable off macOS", async () => {
    if (process.platform !== "darwin") {
      expect(await new MlxBackend().isAvailable()).toBe(false);
    }
  });
});
