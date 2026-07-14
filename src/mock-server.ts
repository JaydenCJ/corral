/**
 * Deterministic, dependency-free fake OpenAI-compatible server used by Corral's
 * MockBackend for tests and demos. It bundles no model and downloads nothing:
 * responses are computed from the request so the orchestration layer (proxying,
 * hot-swap, SSE passthrough, crash/restart) can be tested end to end.
 *
 * Configured entirely through environment variables so it can be spawned as a
 * standalone child process identically from source (tsx) and from dist (node):
 *   CORRAL_MOCK_MODEL         model id echoed back in responses (default "mock")
 *   CORRAL_MOCK_PORT          port to bind on 127.0.0.1 (required)
 *   CORRAL_MOCK_READY_DELAY_MS  delay before /health returns 200 (default 0)
 *   CORRAL_MOCK_CRASH_ON_REQUEST  crash with exit(1) after N chat requests
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const MODEL = process.env.CORRAL_MOCK_MODEL ?? "mock";
const PORT = Number(process.env.CORRAL_MOCK_PORT ?? "0");
const READY_DELAY = Number(process.env.CORRAL_MOCK_READY_DELAY_MS ?? "0");
const CRASH_ON_REQUEST = Number(process.env.CORRAL_MOCK_CRASH_ON_REQUEST ?? "0");
const HOST = "127.0.0.1";
const CREATED = 1_700_000_000; // fixed timestamp keeps responses deterministic

const startedAt = Date.now();
let requestCount = 0;

function ready(): boolean {
  return Date.now() - startedAt >= READY_DELAY;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function lastUserMessage(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.messages)) {
    for (let i = b.messages.length - 1; i >= 0; i--) {
      const m = b.messages[i] as Record<string, unknown>;
      if (m && m.role === "user" && typeof m.content === "string") return m.content;
    }
    return "";
  }
  if (typeof b.prompt === "string") return b.prompt;
  return "";
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const data = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

function replyText(prompt: string): string {
  return `[${MODEL}] echo: ${prompt}`;
}

function chatCompletion(reply: string) {
  return {
    id: `chatcmpl-mock-${MODEL}`,
    object: "chat.completion",
    created: CREATED,
    model: MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: reply },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 8, completion_tokens: reply.length, total_tokens: 8 + reply.length },
  };
}

function streamChat(res: ServerResponse, reply: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (obj: unknown): void => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const base = {
    id: `chatcmpl-mock-${MODEL}`,
    object: "chat.completion.chunk",
    created: CREATED,
    model: MODEL,
  };
  send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

  // Split into words so multiple SSE chunks arrive separately, letting clients
  // observe true streaming rather than one buffered payload.
  const words = reply.split(/(\s+)/).filter((w) => w.length > 0);
  let i = 0;
  const pump = (): void => {
    if (i < words.length) {
      send({ ...base, choices: [{ index: 0, delta: { content: words[i] }, finish_reason: null }] });
      i++;
      setTimeout(pump, 5);
      return;
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    res.write("data: [DONE]\n\n");
    res.end();
  };
  setTimeout(pump, 5);
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";

  if (url === "/__crash") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"crashing":true}');
    // Exit non-zero so the supervisor treats it as a crash.
    setTimeout(() => process.exit(1), 5);
    return;
  }

  if (url === "/health") {
    if (ready()) json(res, 200, { status: "ok", model: MODEL });
    else json(res, 503, { status: "loading" });
    return;
  }

  if (url === "/v1/models" && req.method === "GET") {
    json(res, 200, {
      object: "list",
      data: [{ id: MODEL, object: "model", created: CREATED, owned_by: "corral-mock" }],
    });
    return;
  }

  if ((url === "/v1/chat/completions" || url === "/v1/completions") && req.method === "POST") {
    readBody(req)
      .then((raw) => {
        requestCount++;
        if (CRASH_ON_REQUEST > 0 && requestCount >= CRASH_ON_REQUEST) {
          setTimeout(() => process.exit(1), 5);
        }
        let body: unknown = {};
        try {
          body = raw.length > 0 ? JSON.parse(raw) : {};
        } catch {
          json(res, 400, { error: { message: "invalid JSON body", type: "invalid_request_error" } });
          return;
        }
        const prompt = lastUserMessage(body);
        const reply = replyText(prompt);
        const stream = (body as Record<string, unknown>).stream === true;

        if (url === "/v1/completions") {
          if (stream) {
            streamChat(res, reply);
            return;
          }
          json(res, 200, {
            id: `cmpl-mock-${MODEL}`,
            object: "text_completion",
            created: CREATED,
            model: MODEL,
            choices: [{ index: 0, text: reply, finish_reason: "stop" }],
            usage: { prompt_tokens: 8, completion_tokens: reply.length, total_tokens: 8 + reply.length },
          });
          return;
        }

        if (stream) streamChat(res, reply);
        else json(res, 200, chatCompletion(reply));
      })
      .catch(() => {
        json(res, 500, { error: { message: "mock server error", type: "internal_error" } });
      });
    return;
  }

  json(res, 404, { error: { message: `unknown route ${url}`, type: "invalid_request_error" } });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`mock-server listening on ${HOST}:${PORT} model=${MODEL}\n`);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
