import { describe, expect, it } from "vitest";
import type { ModelSpec } from "../src/backend/backend.js";
import { FakeClock } from "../src/serve/clock.js";
import { ModelSupervisor } from "../src/serve/supervisor.js";
import { FakeBackend, FakeInstance, until } from "./helpers.js";

function makeSupervisor(overrides: Partial<ConstructorParameters<typeof ModelSupervisor>[0]> = {}) {
  const backend = new FakeBackend();
  const clock = new FakeClock(0);
  let nextPort = 9000;
  const supervisor = new ModelSupervisor({
    backend,
    resolveModel: async (id: string): Promise<ModelSpec> => ({ id }),
    maxLoaded: 2,
    idleTimeoutMs: 1000,
    maxRestarts: 3,
    clock,
    readyTimeoutMs: 2000,
    allocatePort: async () => nextPort++,
    ...overrides,
  });
  return { backend, clock, supervisor };
}

describe("ModelSupervisor", () => {
  it("reuses a loaded model instead of spawning again", async () => {
    const { backend, supervisor } = makeSupervisor();
    const a1 = await supervisor.ensure("a");
    const a2 = await supervisor.ensure("a");
    expect(a1).toBe(a2);
    expect(backend.instances).toHaveLength(1);
  });

  it("evicts the least-recently-used model past maxLoaded", async () => {
    const { backend, clock, supervisor } = makeSupervisor({ maxLoaded: 2 });
    await supervisor.ensure("a");
    clock.advance(10);
    await supervisor.ensure("b");
    clock.advance(10);
    await supervisor.ensure("a"); // touch a -> b is now the LRU
    clock.advance(10);
    await supervisor.ensure("c"); // over capacity -> evict b

    expect(supervisor.loadedIds().sort()).toEqual(["a", "c"]);
    const bInstance = backend.instances[1] as FakeInstance;
    expect(bInstance.stopped).toBe(true);
  });

  it("never exceeds maxLoaded when distinct models start concurrently", async () => {
    // Three concurrent ensures for distinct ids at maxLoaded=1 each clear the
    // pre-spawn capacity check while the map is still empty; the supervisor must
    // still end with at most one backend resident.
    const { backend, supervisor } = makeSupervisor({ maxLoaded: 1 });
    await Promise.all([supervisor.ensure("a"), supervisor.ensure("b"), supervisor.ensure("c")]);
    expect(supervisor.loadedIds()).toHaveLength(1);
    // Every backend that lost the cap race must have been stopped, not leaked.
    const resident = supervisor.list()[0]?.port;
    for (const inst of backend.instances as FakeInstance[]) {
      if (inst.port !== resident) expect(inst.stopped).toBe(true);
    }
  });

  it("keeps both models resident when maxLoaded is 2 (hot-swap without eviction)", async () => {
    const { supervisor } = makeSupervisor({ maxLoaded: 2 });
    await supervisor.ensure("a");
    await supervisor.ensure("b");
    expect(supervisor.loadedIds().sort()).toEqual(["a", "b"]);
  });

  it("reaps only models idle beyond the timeout, using the injected clock", async () => {
    const { backend, clock, supervisor } = makeSupervisor({ maxLoaded: 2, idleTimeoutMs: 1000 });
    await supervisor.ensure("a"); // lastUsed = 0
    clock.advance(500);
    await supervisor.ensure("b"); // lastUsed = 500
    clock.advance(600); // now = 1100: a idle 1100ms, b idle 600ms

    const reaped = await supervisor.reapIdle();
    expect(reaped).toEqual(["a"]);
    expect(supervisor.loadedIds()).toEqual(["b"]);
    expect((backend.instances[0] as FakeInstance).stopped).toBe(true);
    expect((backend.instances[1] as FakeInstance).stopped).toBe(false);
  });

  it("restarts a crashed backend up to the limit", async () => {
    const { backend, supervisor } = makeSupervisor({ maxRestarts: 2 });
    await supervisor.ensure("a");
    expect(backend.instances).toHaveLength(1);

    (backend.instances[0] as FakeInstance).crash();
    await until(() => backend.instances.length === 2);
    expect(supervisor.loadedIds()).toEqual(["a"]);
    expect(supervisor.list()[0]?.restarts).toBe(1);
  });

  it("gives up after exceeding maxRestarts", async () => {
    const { backend, supervisor } = makeSupervisor({ maxRestarts: 1 });
    await supervisor.ensure("a");
    (backend.instances[0] as FakeInstance).crash(); // restart 1
    await until(() => backend.instances.length === 2);
    (backend.instances[1] as FakeInstance).crash(); // exceeds limit -> drop
    await until(() => supervisor.loadedIds().length === 0);
    expect(supervisor.loadedIds()).toEqual([]);
  });

  it("stops all models on shutdown", async () => {
    const { backend, supervisor } = makeSupervisor();
    await supervisor.ensure("a");
    await supervisor.ensure("b");
    await supervisor.stopAll();
    expect(backend.instances.every((i) => i.stopped)).toBe(true);
    expect(supervisor.loadedIds()).toEqual([]);
  });
});
