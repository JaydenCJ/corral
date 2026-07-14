import { type IncomingMessage, request, type ServerResponse } from "node:http";

/**
 * Reverse-proxy an already-read request to a backend on 127.0.0.1:port. The
 * request body was consumed upstream to inspect `body.model`, so it is replayed
 * here from `body`. Response headers and status are passed through verbatim and
 * the body is piped, so Server-Sent Events (SSE) stream through chunk-by-chunk
 * without buffering.
 */
export function proxyToBackend(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  targetPort: number,
  body: Buffer,
  host = "127.0.0.1",
): Promise<void> {
  return new Promise((resolve) => {
    const headers: Record<string, string | string[]> = { ...clientReq.headers } as Record<
      string,
      string | string[]
    >;
    // Rewrite host and set an accurate content-length for the replayed body.
    headers.host = `${host}:${targetPort}`;
    delete headers["content-length"];
    headers["content-length"] = String(body.length);

    const proxyReq = request(
      {
        host,
        port: targetPort,
        path: clientReq.url,
        method: clientReq.method,
        headers,
      },
      (proxyRes) => {
        clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.on("end", resolve);
        proxyRes.pipe(clientRes);
      },
    );

    proxyReq.on("error", (err) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "content-type": "application/json" });
        clientRes.end(
          JSON.stringify({
            error: { message: `backend proxy error: ${err.message}`, type: "backend_error" },
          }),
        );
      } else {
        clientRes.end();
      }
      resolve();
    });

    proxyReq.end(body);
  });
}
