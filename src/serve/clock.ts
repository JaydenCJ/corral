/**
 * Time source abstraction. The supervisor reads "now" through a Clock so that
 * LRU eviction and idle reaping can be tested deterministically with a fake
 * clock instead of real timers.
 */
export interface Clock {
  now(): number;
}

/** Real wall-clock time. */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/** Controllable clock for tests. */
export class FakeClock implements Clock {
  private t: number;
  constructor(start = 0) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  /** Advance time by `ms` milliseconds. */
  advance(ms: number): void {
    this.t += ms;
  }
  /** Set absolute time. */
  set(ms: number): void {
    this.t = ms;
  }
}
