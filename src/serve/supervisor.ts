import type { Backend, BackendInstance, ExitInfo, ModelSpec } from "../backend/backend.js";
import { type Logger, silentLogger } from "../logger.js";
import { findFreePort, waitUntil } from "../net.js";
import { type Clock, systemClock } from "./clock.js";

/** A model that is currently loaded (or being loaded) in the supervisor. */
interface LoadedModel {
  id: string;
  spec: ModelSpec;
  instance: BackendInstance;
  lastUsed: number;
  loadedAt: number;
  restarts: number;
  /** Set while a crash-triggered restart is in flight; resolves when healthy. */
  restarting?: Promise<void>;
}

/** Public view of a running model, exposed via /api/ps and `corral ps`. */
export interface PsEntry {
  id: string;
  port: number;
  pid: number | undefined;
  lastUsedMs: number;
  loadedAtMs: number;
  restarts: number;
}

export interface SupervisorOptions {
  backend: Backend;
  /** Map a model id to its launch spec (GGUF path, ctx size, ...). */
  resolveModel: (id: string) => Promise<ModelSpec>;
  maxLoaded: number;
  idleTimeoutMs: number;
  maxRestarts: number;
  clock?: Clock;
  logger?: Logger;
  /** How long to wait for a freshly spawned backend to become healthy. */
  readyTimeoutMs?: number;
  /** Override port allocation (tests may want a fixed strategy). */
  allocatePort?: () => Promise<number>;
}

/**
 * Owns the set of running backend processes and implements the runtime policy:
 * lazy start on first request, LRU eviction past `maxLoaded`, idle reaping, and
 * bounded automatic restart after a crash. All time-based decisions go through
 * an injectable Clock so they can be tested without real timers.
 */
export class ModelSupervisor {
  private readonly backend: Backend;
  private readonly resolveModel: (id: string) => Promise<ModelSpec>;
  private readonly maxLoaded: number;
  private readonly idleTimeoutMs: number;
  private readonly maxRestarts: number;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly readyTimeoutMs: number;
  private readonly allocatePort: () => Promise<number>;

  private readonly loaded = new Map<string, LoadedModel>();
  /** In-flight ensure() promises, so concurrent requests share one spawn. */
  private readonly pending = new Map<string, Promise<BackendInstance>>();

  constructor(opts: SupervisorOptions) {
    this.backend = opts.backend;
    this.resolveModel = opts.resolveModel;
    this.maxLoaded = Math.max(1, opts.maxLoaded);
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.maxRestarts = opts.maxRestarts;
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger ?? silentLogger;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 30000;
    this.allocatePort = opts.allocatePort ?? (() => findFreePort());
  }

  /** Ids of currently loaded models, most-recently-used last. */
  loadedIds(): string[] {
    return [...this.loaded.values()].sort((a, b) => a.lastUsed - b.lastUsed).map((m) => m.id);
  }

  /** Snapshot for `corral ps` / GET /api/ps. */
  list(): PsEntry[] {
    return [...this.loaded.values()]
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .map((m) => ({
        id: m.id,
        port: m.instance.port,
        pid: m.instance.pid,
        lastUsedMs: m.lastUsed,
        loadedAtMs: m.loadedAt,
        restarts: m.restarts,
      }));
  }

  /**
   * Ensure `id` is loaded and healthy, then return its instance. Reuses a
   * running model (touching its LRU timestamp), or starts it — evicting the
   * least-recently-used model first if at capacity.
   */
  async ensure(id: string): Promise<BackendInstance> {
    const existing = this.loaded.get(id);
    if (existing) {
      if (existing.restarting) {
        // A crash restart is in flight; wait for it rather than routing the
        // request to the dead process, then re-evaluate (the record may now be
        // healthy, or may have been dropped after exhausting restarts).
        await existing.restarting.catch(() => {});
        return this.ensure(id);
      }
      existing.lastUsed = this.clock.now();
      return existing.instance;
    }
    const inflight = this.pending.get(id);
    if (inflight) return inflight;

    const p = this.startModel(id).finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }

  private async startModel(id: string): Promise<BackendInstance> {
    // Free capacity up front so the common (sequential) path never spawns a new
    // backend while already at the residency cap.
    while (this.loaded.size >= this.maxLoaded) {
      await this.evictLru();
    }
    const spec = await this.resolveModel(id);
    const instance = await this.spawnAndWait(spec);
    // Re-check the cap after the async spawn. Concurrent ensure() calls for
    // *distinct* models can each clear the pre-spawn check while the map is still
    // below capacity, then all insert and leave more than maxLoaded resident.
    // Enforcing again here — immediately before the insert, with no await between
    // the final check and the set — keeps residency bounded under concurrency.
    while (this.loaded.size >= this.maxLoaded) {
      await this.evictLru();
    }
    const now = this.clock.now();
    const record: LoadedModel = {
      id,
      spec,
      instance,
      lastUsed: now,
      loadedAt: now,
      restarts: 0,
    };
    this.attachCrashHandler(record);
    this.loaded.set(id, record);
    this.logger.info(`loaded model "${id}" on port ${instance.port}`);
    return instance;
  }

  private async spawnAndWait(spec: ModelSpec): Promise<BackendInstance> {
    const port = await this.allocatePort();
    const instance = await this.backend.spawn(spec, port);
    try {
      await waitUntil(() => instance.healthCheck(), { timeoutMs: this.readyTimeoutMs });
    } catch (err) {
      await instance.stop().catch(() => {});
      throw new Error(`model "${spec.id}" failed to become ready: ${(err as Error).message}`);
    }
    return instance;
  }

  private attachCrashHandler(record: LoadedModel): void {
    record.instance.onExit((info: ExitInfo) => {
      // Ignore if this record was already replaced or intentionally removed.
      if (this.loaded.get(record.id) !== record) return;
      this.logger.warn(
        `backend for "${record.id}" exited unexpectedly (code=${info.code}, signal=${info.signal})`,
      );
      if (record.restarts >= this.maxRestarts) {
        this.logger.error(`"${record.id}" exceeded ${this.maxRestarts} restarts; giving up`);
        this.loaded.delete(record.id);
        return;
      }
      // Publish the restart promise synchronously so concurrent ensure() calls
      // block on it instead of hitting the just-crashed instance.
      record.restarting = this.restart(record).finally(() => {
        record.restarting = undefined;
      });
    });
  }

  private async restart(record: LoadedModel): Promise<void> {
    record.restarts++;
    this.logger.info(`restarting "${record.id}" (attempt ${record.restarts}/${this.maxRestarts})`);
    try {
      const instance = await this.spawnAndWait(record.spec);
      // Bail if the record was evicted while we were respawning.
      if (this.loaded.get(record.id) !== record) {
        await instance.stop().catch(() => {});
        return;
      }
      record.instance = instance;
      record.lastUsed = this.clock.now();
      this.attachCrashHandler(record);
      this.logger.info(`"${record.id}" restarted on port ${instance.port}`);
    } catch (err) {
      this.logger.error(`failed to restart "${record.id}": ${(err as Error).message}`);
      this.loaded.delete(record.id);
    }
  }

  private async evictLru(): Promise<void> {
    let victim: LoadedModel | undefined;
    for (const m of this.loaded.values()) {
      if (!victim || m.lastUsed < victim.lastUsed) victim = m;
    }
    if (!victim) return;
    this.logger.info(`evicting LRU model "${victim.id}"`);
    this.loaded.delete(victim.id);
    await victim.instance.stop().catch(() => {});
  }

  /**
   * Stop every model whose idle time exceeds the configured timeout. Returns the
   * ids that were reaped. Call this on a timer in production, or directly in
   * tests after advancing a fake clock.
   */
  async reapIdle(): Promise<string[]> {
    const now = this.clock.now();
    const reaped: string[] = [];
    for (const m of [...this.loaded.values()]) {
      if (now - m.lastUsed >= this.idleTimeoutMs) {
        reaped.push(m.id);
        this.loaded.delete(m.id);
        await m.instance.stop().catch(() => {});
        this.logger.info(`reaped idle model "${m.id}"`);
      }
    }
    return reaped;
  }

  /** Stop all backends. Called on shutdown. */
  async stopAll(): Promise<void> {
    const all = [...this.loaded.values()];
    this.loaded.clear();
    await Promise.all(all.map((m) => m.instance.stop().catch(() => {})));
  }
}
