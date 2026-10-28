// Congestion control for a broadcast stream nobody answers: the signal is the
// sender's own outbound queue, since on a mesh the first hop is the usual
// bottleneck and a growing queue is pure latency. bitchat's
// LiveVideoCongestionController, constant for constant.
//
// The bitrate backs off multiplicatively, probes back up additively once the
// queue has stayed short, and when the queue is far behind video is skipped
// until it drains, then resumes from a keyframe so the stream stays live
// rather than drifting seconds behind. Pure: the caller supplies time.

const DECREASE_INTERVAL_MS = 1_000;
const INCREASE_INTERVAL_MS = 1_000;
const CALM_BEFORE_INCREASE_MS = 2_000;

export interface CongestionDecision {
  bitrate: number;
  skipVideo: boolean;
  requestKeyframe: boolean;
}

export class LiveVideoCongestionController {
  bitrate: number;
  skipping = false;
  skipEpisodes = 0;

  private readonly minBitrate: number;
  private readonly highWater: number;
  private readonly skipWater: number;
  private readonly lowWater: number;
  private lastDecreaseMs = -Infinity;
  private lastIncreaseMs = -Infinity;
  private calmSinceMs: number | null = null;

  // Queue depths in packets. The floor defaults to 30% of the ceiling.
  constructor(
    private readonly maxBitrate: number,
    options: {
      minBitrate?: number;
      highWater?: number;
      skipWater?: number;
      lowWater?: number;
    } = {},
  ) {
    this.minBitrate = options.minBitrate ?? Math.floor((maxBitrate * 3) / 10);
    this.highWater = options.highWater ?? 16;
    this.skipWater = options.skipWater ?? 48;
    this.lowWater = options.lowWater ?? 4;
    this.bitrate = maxBitrate;
  }

  onBacklog(backlog: number, nowMs: number): CongestionDecision {
    let requestKeyframe = false;
    if (backlog >= this.skipWater) {
      if (!this.skipping) this.skipEpisodes++;
      this.skipping = true;
      this.calmSinceMs = null;
      this.decrease(nowMs, 0.6, true);
    } else if (backlog >= this.highWater) {
      this.calmSinceMs = null;
      this.decrease(nowMs, 0.8, false);
    } else if (backlog <= this.lowWater) {
      if (this.skipping) {
        this.skipping = false;
        requestKeyframe = true;
      }
      const since = this.calmSinceMs ?? nowMs;
      this.calmSinceMs = since;
      if (
        nowMs - since >= CALM_BEFORE_INCREASE_MS &&
        nowMs - this.lastIncreaseMs >= INCREASE_INTERVAL_MS
      ) {
        this.bitrate = Math.min(
          this.maxBitrate,
          this.bitrate + Math.floor(this.maxBitrate / 12),
        );
        this.lastIncreaseMs = nowMs;
      }
    } else {
      this.calmSinceMs = null;
    }
    return { bitrate: this.bitrate, skipVideo: this.skipping, requestKeyframe };
  }

  private decrease(nowMs: number, factor: number, force: boolean): void {
    if (!force && nowMs - this.lastDecreaseMs < DECREASE_INTERVAL_MS) return;
    this.bitrate = Math.max(this.minBitrate, Math.floor(this.bitrate * factor));
    this.lastDecreaseMs = nowMs;
  }
}
