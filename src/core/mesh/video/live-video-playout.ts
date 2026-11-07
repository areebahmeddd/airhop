// When a received unit is shown or heard: on the sender's clock, 350 ms behind
// the first unit, so bursty mesh delivery still plays at an even pace. A unit
// that would show more than 1.5 s late, or more than 3 s early, rebases the
// clock instead of stalling the picture or racing it. bitchat's decoder
// pacing, as LIVE_VIDEO_V1 "Receiver behavior" specifies it.
//
// One clock per stream, shared by both tracks, so picture and sound stay
// together. Pure: the caller supplies time.
//
// Sound is timed apart from the picture at the edges. The player it goes to
// plays frames in arrival order with no clock of its own, so a frame handed
// over late shifts every frame after it later for good: a JS stall, a gap
// wait or a late repair would each add lag that never comes back. So sound
// leaves a little ahead of its moment, which keeps the player fed through a
// stall, and a frame already well past its moment is dropped, costing a click
// rather than all the sync after it.
//
// Dropping alone would silence a stream whose path got slower for good (a busy
// relay adding half a second): every frame would arrive past its moment while
// the picture played on late, until the delay passed the 1.5 s rebase. So a
// run of sound arriving past its moment moves the clock later by the latest
// one's lateness, plus the lead, and both tracks play on in step at the new
// delay. A run, not one frame, so a single late repair or spike is only
// dropped; and only on arrival, so a stall of the caller's own never moves it.

const JITTER_MS = 350;
const REBASE_LATE_MS = 1_500;
const REBASE_EARLY_MS = 3_000;
// About four seconds at the High preset. A queue this deep means the caller
// stopped draining (the app went to the background), and what it holds is
// already stale.
const MAX_QUEUED = 96;
// How far ahead of its moment sound is handed over: a little over two 64 ms
// AAC frames, more than one 40 ms playout tick plus a stall of that size.
const AUDIO_LEAD_MS = 150;
// How late sound may be and still play. Past this it is dropped.
const AUDIO_LATE_MS = 100;
// Frames of sound in a row arriving past their moment before the clock moves:
// about a quarter second of 64 ms AAC frames, longer than a burst of repairs.
const AUDIO_LATE_RUN = 4;

export interface TimedUnit {
  ptsMs: number;
  // Audio leaves ahead and is dropped when late; anything else (video) is
  // released exactly when due.
  track?: "video" | "audio";
}

export class LiveVideoPlayout<T extends TimedUnit> {
  private queue: T[] = [];
  // Wall time at which pts 0 is due.
  private baseMs: number | null = null;
  // Frames of sound in a row that arrived past their moment.
  private lateAudio = 0;

  get size(): number {
    return this.queue.length;
  }

  push(unit: T, nowMs: number): void {
    const due = this.dueAt(unit.ptsMs, nowMs);
    if (due < nowMs - REBASE_LATE_MS || due > nowMs + REBASE_EARLY_MS) {
      this.baseMs = nowMs - unit.ptsMs + JITTER_MS;
      this.lateAudio = 0;
    } else if (unit.track === "audio") {
      this.lateAudio = due < nowMs ? this.lateAudio + 1 : 0;
      if (this.lateAudio >= AUDIO_LATE_RUN) {
        this.baseMs = nowMs - unit.ptsMs + AUDIO_LEAD_MS;
        this.lateAudio = 0;
      }
    }
    if (this.queue.length >= MAX_QUEUED) this.queue.shift();
    this.queue.push(unit);
  }

  // Every queued unit whose moment has come, sound AUDIO_LEAD_MS early, in
  // presentation order. Sound more than AUDIO_LATE_MS late is dropped here.
  take(nowMs: number): T[] {
    if (this.baseMs === null || this.queue.length === 0) return [];
    const base = this.baseMs;
    const ready: T[] = [];
    const waiting: T[] = [];
    for (const unit of this.queue) {
      const due = base + unit.ptsMs;
      if (unit.track === "audio") {
        if (due < nowMs - AUDIO_LATE_MS) continue;
        (due - AUDIO_LEAD_MS <= nowMs ? ready : waiting).push(unit);
        continue;
      }
      (due <= nowMs ? ready : waiting).push(unit);
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
    this.lateAudio = 0;
  }

  private dueAt(ptsMs: number, nowMs: number): number {
    this.baseMs ??= nowMs - ptsMs + JITTER_MS;
    return this.baseMs + ptsMs;
  }
}
