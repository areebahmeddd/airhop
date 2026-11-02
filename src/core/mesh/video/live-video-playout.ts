// When a received unit is shown or heard: on the sender's clock, 350 ms behind
// the first unit, so bursty mesh delivery still plays at an even pace. A unit
// that would show more than 1.5 s late, or more than 3 s early, rebases the
// clock instead of stalling the picture or racing it. bitchat's decoder
// pacing, as LIVE_VIDEO_V1 "Receiver behavior" specifies it.
//
// One clock per stream, shared by both tracks, so picture and sound stay
// together. Pure: the caller supplies time.

const JITTER_MS = 350;
const REBASE_LATE_MS = 1_500;
const REBASE_EARLY_MS = 3_000;
// About four seconds at the High preset. A queue this deep means the caller
// stopped draining (the app went to the background), and what it holds is
// already stale.
const MAX_QUEUED = 96;

export interface TimedUnit {
  ptsMs: number;
}

export class LiveVideoPlayout<T extends TimedUnit> {
  private queue: T[] = [];
  // Wall time at which pts 0 is due.
  private baseMs: number | null = null;

  get size(): number {
    return this.queue.length;
  }

  push(unit: T, nowMs: number): void {
    const due = this.dueAt(unit.ptsMs, nowMs);
    if (due < nowMs - REBASE_LATE_MS || due > nowMs + REBASE_EARLY_MS) {
      this.baseMs = nowMs - unit.ptsMs + JITTER_MS;
    }
    if (this.queue.length >= MAX_QUEUED) this.queue.shift();
    this.queue.push(unit);
  }

  // Every queued unit whose moment has come, in presentation order.
  take(nowMs: number): T[] {
    if (this.baseMs === null || this.queue.length === 0) return [];
    const base = this.baseMs;
    const ready: T[] = [];
    const waiting: T[] = [];
    for (const unit of this.queue) {
      (base + unit.ptsMs <= nowMs ? ready : waiting).push(unit);
    }
    this.queue = waiting;
    return ready.sort((a, b) => a.ptsMs - b.ptsMs);
  }

  // Everything still queued, as when a stream ends and its tail should play.
  flush(): T[] {
    const all = this.queue.sort((a, b) => a.ptsMs - b.ptsMs);
    this.queue = [];
    return all;
  }

  clear(): void {
    this.queue = [];
    this.baseMs = null;
  }

  private dueAt(ptsMs: number, nowMs: number): number {
    this.baseMs ??= nowMs - ptsMs + JITTER_MS;
    return this.baseMs + ptsMs;
  }
}
