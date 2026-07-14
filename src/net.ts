import { createServer } from "node:net";
import { request } from "node:http";

/**
 * Ask the OS for a free TCP port by binding to port 0 and reading it back.
 * There is an inherent race between closing this probe socket and the backend
 * binding, but for loopback-only local orchestration it is acceptable and the
 * backend spawn will surface EADDRINUSE if it ever loses that race.
 */
export function findFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine free port")));
      }
    });
  });
}

/** Issue a GET and resolve with the HTTP status code, or reject on transport error. */
export function httpGetStatus(
  host: string,
  port: number,
  path: string,
  timeoutMs = 1000,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host, port, path, method: "GET", timeout: timeoutMs },
      (res) => {
        res.resume(); // drain
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("timeout", () => req.destroy(new Error("health probe timeout")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Poll `check` until it resolves true or the deadline passes. Used to wait for a
 * freshly spawned backend to report healthy.
 */
export async function waitUntil(
  check: () => Promise<boolean>,
  opts: { timeoutMs: number; intervalMs?: number } = { timeoutMs: 30000 },
): Promise<void> {
  const interval = opts.intervalMs ?? 150;
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = await check();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${opts.timeoutMs}ms waiting for readiness`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
