import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Backend,
  type BackendInstance,
  type ModelSpec,
  ProcessBackendInstance,
} from "./backend.js";

/**
 * Resolve how to launch the mock server as a child process. When Corral itself
 * runs from source under tsx (files end in .ts), the child is launched with the
 * tsx loader; when running from the compiled dist (.js), plain node is used.
 */
function mockServerInvocation(): { cmd: string; args: string[] } {
  const here = fileURLToPath(import.meta.url); // .../backend/mock.(ts|js)
  const dir = dirname(here);
  if (here.endsWith(".ts")) {
    const script = resolve(dir, "..", "mock-server.ts");
    return { cmd: process.execPath, args: ["--import", "tsx", script] };
  }
  const script = resolve(dir, "..", "mock-server.js");
  return { cmd: process.execPath, args: [script] };
}

export interface MockBackendOptions {
  /** Delay before the mock server reports healthy, to simulate model load. */
  readyDelayMs?: number;
  /** Crash the mock server after this many chat requests (for restart tests). */
  crashOnRequest?: number;
}

/**
 * MockBackend spawns the bundled deterministic OpenAI-compatible server. It is
 * always available (no external binary, no OS restriction) and is what every
 * automated test and the smoke script run against, in line with Corral's rule
 * that inference is defined behind an interface and never pulls real weights.
 */
export class MockBackend implements Backend {
  readonly kind = "mock";
  private readonly options: MockBackendOptions;

  constructor(options: MockBackendOptions = {}) {
    this.options = options;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async spawn(model: ModelSpec, port: number): Promise<BackendInstance> {
    const { cmd, args } = mockServerInvocation();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CORRAL_MOCK_MODEL: model.id,
      CORRAL_MOCK_PORT: String(port),
      CORRAL_MOCK_READY_DELAY_MS: String(this.options.readyDelayMs ?? 0),
      CORRAL_MOCK_CRASH_ON_REQUEST: String(this.options.crashOnRequest ?? 0),
    };
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    // Surface backend stderr under CORRAL_DEBUG only; keep it off by default.
    if (process.env.CORRAL_DEBUG === "1") {
      child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[mock:${model.id}] ${d}`));
    }
    return new ProcessBackendInstance({
      child,
      port,
      healthPath: "/health",
      healthAccept: (s) => s === 200,
    });
  }
}
