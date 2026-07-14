import type { ChildProcess } from "node:child_process";
import { httpGetStatus } from "../net.js";

/** What the supervisor needs to know to launch a model. */
export interface ModelSpec {
  /** Model id used in the OpenAI API `model` field. */
  id: string;
  /** Absolute path to the GGUF file. Optional for backends that need no file. */
  path?: string;
  /** Context window hint passed to the backend. */
  ctxSize?: number;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** A running backend process bound to a loopback port. */
export interface BackendInstance {
  readonly port: number;
  readonly pid: number | undefined;
  /** Resolve true once the backend answers its readiness endpoint. */
  healthCheck(): Promise<boolean>;
  /** Terminate the process gracefully (SIGTERM, then SIGKILL fallback). */
  stop(): Promise<void>;
  /** Register a listener fired only on unexpected exit (not on stop()). */
  onExit(listener: (info: ExitInfo) => void): void;
}

/**
 * A pluggable inference backend. Corral is a thin orchestrator: it never links
 * llama.cpp or bundles weights. Each backend either wraps a user-installed
 * upstream binary (llama.cpp, MLX) or, for tests and demos, a deterministic
 * mock server. Business logic depends only on this interface.
 */
export interface Backend {
  readonly kind: string;
  /** Whether this backend can run on the current host (binary present, OS ok). */
  isAvailable(): Promise<boolean>;
  /**
   * Launch `model` bound to 127.0.0.1:`port`. Resolves once the process has
   * started; callers await BackendInstance.healthCheck() for readiness.
   */
  spawn(model: ModelSpec, port: number): Promise<BackendInstance>;
}

/**
 * Shared BackendInstance implementation for backends that manage a child
 * process exposing an HTTP readiness endpoint. Distinguishes intentional stops
 * from crashes so the supervisor's restart policy only fires on real failures.
 */
export class ProcessBackendInstance implements BackendInstance {
  readonly port: number;
  private readonly child: ChildProcess;
  private readonly host: string;
  private readonly healthPath: string;
  private readonly healthAccept: (status: number) => boolean;
  private readonly exitListeners: Array<(info: ExitInfo) => void> = [];
  private stopping = false;
  private exited = false;

  constructor(opts: {
    child: ChildProcess;
    port: number;
    host?: string;
    healthPath: string;
    healthAccept: (status: number) => boolean;
  }) {
    this.child = opts.child;
    this.port = opts.port;
    this.host = opts.host ?? "127.0.0.1";
    this.healthPath = opts.healthPath;
    this.healthAccept = opts.healthAccept;

    this.child.on("exit", (code, signal) => {
      this.exited = true;
      if (this.stopping) return; // expected shutdown
      const info: ExitInfo = { code, signal };
      for (const listener of this.exitListeners) listener(info);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  async healthCheck(): Promise<boolean> {
    if (this.exited) return false;
    try {
      const status = await httpGetStatus(this.host, this.port, this.healthPath, 1000);
      return this.healthAccept(status);
    } catch {
      return false;
    }
  }

  onExit(listener: (info: ExitInfo) => void): void {
    this.exitListeners.push(listener);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.exited || this.child.pid === undefined) return;
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        // Escalate if the process ignores SIGTERM.
        this.child.kill("SIGKILL");
      }, 3000);
      this.child.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      this.child.kill("SIGTERM");
    });
  }
}
