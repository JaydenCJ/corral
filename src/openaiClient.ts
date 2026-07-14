import { request } from "node:http";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Minimal OpenAI-compatible chat client used by `corral run`. Streams a chat
 * completion from an OpenAI-style endpoint, invoking `onToken` for each content
 * delta and resolving with the full assembled text. Depends only on node:http.
 */
export function streamChat(
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  onToken: (token: string) => void,
): Promise<string> {
  const url = new URL("/v1/chat/completions", baseUrl);
  const payload = JSON.stringify({ model, messages, stream: true });

  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          accept: "text/event-stream",
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            reject(
              new Error(
                `server returned ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8")}`,
              ),
            );
          });
          return;
        }
        let buffer = "";
        let full = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const event = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of event.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (data === "[DONE]") continue;
              try {
                const obj = JSON.parse(data) as {
                  choices?: Array<{ delta?: { content?: string } }>;
                };
                const token = obj.choices?.[0]?.delta?.content;
                if (typeof token === "string" && token.length > 0) {
                  full += token;
                  onToken(token);
                }
              } catch {
                // ignore keepalive / non-JSON lines
              }
            }
          }
        });
        res.on("end", () => resolve(full));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** Probe an OpenAI-compatible endpoint's /health. Returns true on HTTP 200. */
export function isServerHealthy(baseUrl: string, timeoutMs = 800): Promise<boolean> {
  const url = new URL("/health", baseUrl);
  return new Promise((resolve) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}
