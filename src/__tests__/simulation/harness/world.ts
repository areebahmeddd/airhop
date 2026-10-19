// The world every simulated phone lives in: one clock, one timeline, one set of
// fabrics.
//
// There is exactly ONE clock here, and it is Jest's fake timers. Every device's
// OS model, every native module, the real mesh-service's own setTimeouts, and
// every fabric schedule onto it. That is not a convenience - it is the property
// that makes the whole harness trustworthy. Two clocks would let the simulation
// invent an interleaving that hardware cannot produce, and a race-condition
// harness that reports impossible races is worse than no harness, because every
// failure has to be argued about before it can be believed.
//
// The merged timeline is the second half of the deal. A multi-device bug is
// never explained by one device's log; it is explained by seeing device B's
// scan start three milliseconds after device A's advertise stopped. So every
// device writes into one ordered trace tagged with who it was.
//
// A world also pins the two inputs a schedule depends on that nothing above
// would otherwise fix: the wall clock starts at SIM_EPOCH_MS, and Math.random
// (the announce and relay jitter) draws from the seed. What stays random is the
// CSPRNG behind keys, nonces and handshake ephemerals, which no harness may
// replace, so two runs of one seed share a schedule but not their ciphertext.
// Anything keyed on ciphertext (a packet ID, a gossip filter's false positive)
// can still differ between them.

import type { TraceEvent } from "../../harness/os";
import { eventRouter } from "./event-router";
import { Prng } from "./prng";

export interface WorldEvent extends TraceEvent {
  who: string;
}

// The wall clock every world starts at. Fixed so a timestamp in a trace means
// the same thing on every run; any instant would do, so long as it never moves.
export const SIM_EPOCH_MS = Date.UTC(2026, 0, 1);

// Modern fake timers hang their clock off the patched setTimeout. Checked
// rather than assumed, because a fabric self-test builds a world under real
// timers, where setting the system time is an error.
function fakeTimersInstalled(): boolean {
  return (
    typeof (globalThis.setTimeout as unknown as { clock?: unknown }).clock ===
    "object"
  );
}

export interface WorldOptions {
  seed?: number;
  // Printed on failure so a red run can be re-run byte for byte.
  name?: string;
}

export class World {
  readonly rng: Prng;
  readonly seed: number;
  readonly name: string;
  readonly events: WorldEvent[] = [];

  private nowMs = 0;
  // Things that must be torn down when the scenario ends, newest first.
  private readonly closers: (() => void)[] = [];
  // Frames a fabric has put on a medium and not yet handed over, and how many
  // it has ever scheduled. settle() reads both: a frame in the air is the
  // network still talking, though it writes no trace line until it lands.
  private inFlight = 0;
  private carried = 0;
  private readonly randomSpy: jest.SpyInstance<number, []>;

  constructor(opts: WorldOptions = {}) {
    this.seed = opts.seed ?? 1;
    this.name = opts.name ?? "world";
    this.rng = new Prng(this.seed);
    if (fakeTimersInstalled()) jest.setSystemTime(SIM_EPOCH_MS);
    // A sub-stream of its own, so a scenario drawing from `rng` does not shift
    // every jitter the app draws, and the other way round.
    const jitter = this.rng.fork("math-random");
    this.randomSpy = jest
      .spyOn(Math, "random")
      .mockImplementation(() => jitter.float());
  }

  get now(): number {
    return this.nowMs;
  }

  // Everything a device does reads the time through this, so a device's OS
  // model never counts its own milliseconds.
  readonly clock = (): number => this.nowMs;

  // Epoch milliseconds, which is what a packet timestamp field carries.
  //
  // Distinct from `now`, which is elapsed simulated time and starts at 0. A
  // hand-forged packet stamped with `now` looks decades stale to the receiver's
  // freshness window, so it is dropped for being old rather than for whatever
  // the scenario was testing, and the test passes for the wrong reason.
  // Anything building a packet by hand stamps it with this; app code already
  // does, via Date.now() under the same fake timers.
  readonly wallClock = (): number => Date.now();

  record(who: string, event: TraceEvent): void {
    this.events.push({ ...event, who });
  }

  // A line from the harness itself rather than from a device, so a scenario can
  // narrate what it is doing between steps.
  say(kind: string, detail?: string): void {
    this.events.push({
      atMs: this.nowMs,
      who: "world",
      source: "user",
      kind,
      detail,
    });
  }

  onClose(fn: () => void): void {
    this.closers.push(fn);
  }

  // Hand a frame to the far side after `delayMs`, the way every fabric
  // delivers. Counted here so settle() cannot call a network quiet while a
  // frame is still crossing it.
  carry(delayMs: number, deliver: () => void): void {
    this.inFlight++;
    this.carried++;
    setTimeout(() => {
      this.inFlight--;
      deliver();
    }, delayMs);
  }

  // Step forward, flushing microtasks between steps so promise continuations
  // (every native call is a Promise) land in a realistic order relative to
  // timers rather than all at once at the end.
  //
  // The step size is a real trade. Too coarse and two events that a device would
  // have seen milliseconds apart arrive in the same tick, hiding orderings. Too
  // fine and a 60-second scenario takes 12,000 iterations. 5ms matches the
  // shortest thing anything in Airhop schedules (the 8ms voice relay jitter
  // floor), so no scheduled event can be skipped over.
  async advance(ms: number, stepMs = 5): Promise<void> {
    let remaining = ms;
    while (remaining > 0) {
      const chunk = Math.min(stepMs, remaining);
      this.nowMs += chunk;
      jest.advanceTimersByTime(chunk);
      await Promise.resolve();
      await Promise.resolve();
      remaining -= chunk;
    }
  }

  // Advance until nothing is left to do, or the budget runs out.
  //
  // "Quiet" is deliberately defined as no new trace lines and no frame on any
  // medium, rather than no pending timers: Airhop always has pending timers
  // (announce, gossip, outbox sweep), so waiting for an empty timer queue would
  // never return. What we actually want is "the network has stopped saying
  // anything new", which is what convergence checks need. Frames count because
  // a delivery writes no trace line: a relay hop or a sync answer would
  // otherwise land after settle() had already called the room converged.
  // The step here is coarser than a precise advance() on purpose. Settling is
  // about draining a network that has already been set in motion, not about
  // observing a race, and jest.advanceTimersByTime runs every timer due inside
  // the window in the right order either way. The only fidelity given up is the
  // interleaving of promise continuations against timers within one 25ms slice,
  // which no scenario asserts on - and it makes a crowded room finish in
  // seconds instead of minutes.
  async settle(budgetMs = 30_000, quietMs = 500): Promise<void> {
    let quietFor = 0;
    let lastCount = this.events.length;
    let lastCarried = this.carried;
    let spent = 0;
    while (spent < budgetMs) {
      await this.advance(50, 25);
      spent += 50;
      const silent =
        this.events.length === lastCount &&
        this.carried === lastCarried &&
        this.inFlight === 0;
      if (silent) {
        quietFor += 50;
        if (quietFor >= quietMs) return;
      } else {
        quietFor = 0;
        lastCount = this.events.length;
        lastCarried = this.carried;
      }
    }
  }

  // Await a promise that can only settle if time passes.
  //
  // Under fake timers a bare `await` on anything that schedules a timeout - a
  // mint round trip, store hydration, a retry backoff - deadlocks: the promise
  // is waiting for a clock that only advances when somebody asks it to, and the
  // await is what stopped anybody asking. Driving the clock while waiting is
  // the only correct way to await app code from a scenario.
  async resolve<T>(promise: Promise<T>, budgetMs = 60_000): Promise<T> {
    let settled = false;
    let value: T | undefined;
    let error: unknown;
    let rejected = false;
    void promise.then(
      (v) => {
        value = v;
        settled = true;
      },
      (e: unknown) => {
        error = e;
        rejected = true;
        settled = true;
      },
    );
    let spent = 0;
    while (!settled && spent < budgetMs) {
      await this.advance(25, 25);
      spent += 25;
    }
    if (!settled) {
      throw new Error(
        `promise did not settle within ${String(budgetMs)}ms of simulated time`,
      );
    }
    if (rejected) throw error;
    return value as T;
  }

  formatTimeline(filter?: (e: WorldEvent) => boolean): string {
    const rows = filter ? this.events.filter(filter) : this.events;
    return rows
      .map((e) => {
        const t = String(e.atMs).padStart(6, " ");
        const who = e.who.padEnd(10, " ");
        const src = e.source.padEnd(7, " ");
        const detail = e.detail !== undefined ? `, ${e.detail}` : "";
        return `${t}ms ${who} ${src} ${e.kind}${detail}`;
      })
      .join("\n");
  }

  // The last N lines, which is what you actually want on a soak failure where
  // the timeline is 40,000 rows long.
  formatTail(n = 120): string {
    const rows = this.events.slice(-n);
    return rows
      .map((e) => {
        const t = String(e.atMs).padStart(6, " ");
        const who = e.who.padEnd(10, " ");
        const detail = e.detail !== undefined ? `, ${e.detail}` : "";
        return `${t}ms ${who} ${e.kind}${detail}`;
      })
      .join("\n");
  }

  close(): void {
    for (const fn of this.closers.reverse()) {
      try {
        fn();
      } catch {
        // A teardown that throws must not hide the teardown after it, and the
        // scenario has already made its findings by this point.
      }
    }
    this.closers.length = 0;
    this.randomSpy.mockRestore();
    // The event router is process-wide by necessity (see event-router.ts), so
    // it outlives this world. Clear it, or the next scenario inherits these
    // phones' subscriptions under the same device ids.
    eventRouter().reset();
  }
}
