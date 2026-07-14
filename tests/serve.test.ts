import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockBackend } from "../src/backend/mock.js";
import { DEFAULT_CONFIG, type CorralConfig } from "../src/config.js";
import { writeManifest } from "../src/manifest.js";
import { startServer, type RunningServer } from "../src/serve/server.js";
import { silentLogger } from "../src/logger.js";
import { collectSse, getJson, postJson, rmDir, tmpDir, until } from "./helpers.js";

let running: RunningServer | undefined;
let root: string;

function cfg(overrides: Partial<CorralConfig> = {}): CorralConfig {
  return { ...DEFAULT_CONFIG, backend: "mock", host: "127.0.0.1", ...overrides };
}

async function serve(config: CorralConfig): Promise<string> {
  running = await startServer({
    backend: new MockBackend(),
    config,
    logger: silentLogger,
    modelsRoot: root,
    allowEphemeralModels: true,
    disableIdleTimer: true,
    port: 0,
  });
  return `http://${running.host}:${running.port}`;
}

beforeEach(() => {
  root = tmpDir();
});
afterEach(async () => {
  if (running) await running.close();
  running = undefined;
  rmDir(root);
});

describe("corral serve (real MockBackend child processes)", () => {
  it("answers /health", async () => {
    const base = await serve(cfg());
    const { status, json } = await getJson(base, "/health");
    expect(status).toBe(200);
    expect((json as { status: string }).status).toBe("ok");
  });

  it("proxies a chat completion to the right backend with OpenAI shape", async () => {
    const base = await serve(cfg({ maxLoaded: 1 }));
    const { status, json } = await postJson(base, "/v1/chat/completions", {
      model: "model-a",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(status).toBe(200);
    const body = json as {
      object: string;
      model: string;
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("model-a");
    expect(body.choices[0]?.message.role).toBe("assistant");
    expect(body.choices[0]?.message.content).toBe("[model-a] echo: hello");
    expect(body.choices[0]?.finish_reason).toBe("stop");
  });

  it("hot-swaps to a second model and LRU-evicts the first when maxLoaded=1", async () => {
    const base = await serve(cfg({ maxLoaded: 1 }));
    await postJson(base, "/v1/chat/completions", {
      model: "model-a",
      messages: [{ role: "user", content: "hi" }],
    });
    const b = await postJson(base, "/v1/chat/completions", {
      model: "model-b",
      messages: [{ role: "user", content: "yo" }],
    });
    expect((b.json as { model: string }).model).toBe("model-b");

    const ps = (await getJson(base, "/api/ps")).json as { models: Array<{ id: string }> };
    expect(ps.models.map((m) => m.id)).toEqual(["model-b"]); // a was evicted
  });

  it("keeps both models resident when maxLoaded=2", async () => {
    const base = await serve(cfg({ maxLoaded: 2 }));
    await postJson(base, "/v1/chat/completions", {
      model: "model-a",
      messages: [{ role: "user", content: "hi" }],
    });
    await postJson(base, "/v1/chat/completions", {
      model: "model-b",
      messages: [{ role: "user", content: "yo" }],
    });
    const ps = (await getJson(base, "/api/ps")).json as { models: Array<{ id: string }> };
    expect(ps.models.map((m) => m.id).sort()).toEqual(["model-a", "model-b"]);
  });

  it("streams SSE chunk-by-chunk and reassembles the content", async () => {
    const base = await serve(cfg({ maxLoaded: 1 }));
    const { chunks, sawDone } = await collectSse(base, "/v1/chat/completions", {
      model: "model-a",
      messages: [{ role: "user", content: "stream me" }],
      stream: true,
    });
    expect(sawDone).toBe(true);
    // More than one chunk proves true streaming, not a single buffered payload.
    expect(chunks.length).toBeGreaterThan(1);
    const content = chunks
      .map((c) => (c as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content ?? "")
      .join("");
    expect(content).toBe("[model-a] echo: stream me");
  });

  it("restarts a crashed backend and keeps serving the same model", async () => {
    const base = await serve(cfg({ maxLoaded: 1, maxRestarts: 3 }));
    await postJson(base, "/v1/chat/completions", {
      model: "model-a",
      messages: [{ role: "user", content: "hi" }],
    });
    const before = (await getJson(base, "/api/ps")).json as { models: Array<{ port: number }> };
    const backendPort = before.models[0]!.port;

    // Crash the backend directly via its debug endpoint.
    await getJson(`http://127.0.0.1:${backendPort}`, "/__crash").catch(() => undefined);

    // Supervisor should auto-restart; ps eventually shows restarts >= 1.
    await until(async () => {
      const ps = (await getJson(base, "/api/ps")).json as { models: Array<{ restarts: number }> };
      return (ps.models[0]?.restarts ?? 0) >= 1;
    }, 10000);

    // And the model still answers.
    const again = await postJson(base, "/v1/chat/completions", {
      model: "model-a",
      messages: [{ role: "user", content: "still there?" }],
    });
    expect((again.json as { model: string }).model).toBe("model-a");
  });

  it("lists installed models from manifests at /v1/models", async () => {
    writeManifest(
      {
        id: "owner/repo:Q4_K_M",
        repo: "owner/repo",
        quant: "Q4_K_M",
        file: "model.gguf",
        path: "/nonexistent/model.gguf",
        sourceUrl: "https://huggingface.co/owner/repo/resolve/main/model.gguf",
        sha256: null,
        sizeBytes: 42,
        revision: "main",
        pulledAt: "2026-07-08T00:00:00.000Z",
        corralVersion: "0.1.0",
      },
      root,
    );
    const base = await serve(cfg());
    const { json } = await getJson(base, "/v1/models");
    const data = (json as { data: Array<{ id: string; owned_by: string }> }).data;
    expect(data).toHaveLength(1);
    expect(data[0]?.id).toBe("owner/repo:Q4_K_M");
    expect(data[0]?.owned_by).toBe("corral");
  });

  it("lists loaded ephemeral (mock) models at /v1/models, deduplicated against manifests", async () => {
    writeManifest(
      {
        id: "owner/repo:Q4_K_M",
        repo: "owner/repo",
        quant: "Q4_K_M",
        file: "model.gguf",
        path: "/nonexistent/model.gguf",
        sourceUrl: "https://huggingface.co/owner/repo/resolve/main/model.gguf",
        sha256: null,
        sizeBytes: 42,
        revision: "main",
        pulledAt: "2026-07-08T00:00:00.000Z",
        corralVersion: "0.1.0",
      },
      root,
    );
    const base = await serve(cfg({ maxLoaded: 2 }));
    // An ephemeral model that answered a chat request must show up in /v1/models.
    await postJson(base, "/v1/chat/completions", {
      model: "demo",
      messages: [{ role: "user", content: "hi" }],
    });
    // Loading the manifest-backed model too must not produce a duplicate entry.
    await postJson(base, "/v1/chat/completions", {
      model: "owner/repo:Q4_K_M",
      messages: [{ role: "user", content: "hi" }],
    });
    const { json } = await getJson(base, "/v1/models");
    const data = (json as { data: Array<{ id: string; owned_by: string }> }).data;
    expect(data.length).toBeGreaterThan(0);
    expect(data.map((m) => m.id).sort()).toEqual(["demo", "owner/repo:Q4_K_M"]);
    // No duplicate entries: each id appears exactly once.
    expect(new Set(data.map((m) => m.id)).size).toBe(data.length);
    expect(data.every((m) => m.owned_by === "corral")).toBe(true);
  });

  it("rejects an unknown model with a 400 when it lacks the model field", async () => {
    const base = await serve(cfg());
    const { status, json } = await postJson(base, "/v1/chat/completions", {
      messages: [{ role: "user", content: "no model field" }],
    });
    expect(status).toBe(400);
    expect((json as { error: { message: string } }).error.message).toMatch(/missing required field: model/);
  });
});
