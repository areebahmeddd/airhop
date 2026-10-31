// Token buckets for one sender, run on message time rather than arrival order.
//
// Relay backfill and gossip sync hand over a sender's history in one burst,
// often newest first, so an arrival-time bucket would hide an ordinary
// conversation. Each admitted message stays on a timeline, and a candidate is
// admitted only if replaying every bucket with it inserted never runs dry. For
// live, in-order traffic that is exactly a classic token bucket. Entries older
// than the backdate window fold into a checkpoint nothing can precede, which
// keeps the replay short. Port of bitchat's TokenBucketSchedule.

import type { TokenBucketConfig } from "./spam-filter-config";

interface Entry {
  time: number;
  costs: readonly number[];
}

const EPSILON = 1e-9;

export class TokenBucketSchedule {
  private entries: Entry[] = [];
  private checkpoint: number | null = null;
  private checkpointTokens: number[];
  // Tokens after the newest entry, so an in-order message needs no replay.
  private tailTokens: number[];
  private tailTime: number | null = null;

  constructor(private readonly buckets: readonly TokenBucketConfig[]) {
    this.checkpointTokens = buckets.map((b) => b.capacity);
    this.tailTokens = [...this.checkpointTokens];
  }

  // Admits and records the message when every bucket can pay `costs` at
  // `time` (seconds). Returns null on success, otherwise the index of the first
  // bucket that ran dry.
  tryAdmit(at: number, costs: readonly number[]): number | null {
    const time = this.checkpoint === null ? at : Math.max(this.checkpoint, at);
    let insertAt = this.entries.length;
    while (insertAt > 0 && this.entries[insertAt - 1].time > time) insertAt--;
    const candidate: Entry = { time, costs };

    if (insertAt === this.entries.length) {
      const tokens = [...this.tailTokens];
      this.refill(tokens, this.tailTime, time);
      const dry = this.spend(tokens, costs);
      if (dry !== null) return dry;
      this.entries.push(candidate);
      this.tailTokens = tokens;
      this.tailTime = time;
      return null;
    }

    const tokens = [...this.checkpointTokens];
    let last = this.checkpoint;
    for (let i = 0; i <= this.entries.length; i++) {
      const entry =
        i < insertAt
          ? this.entries[i]
          : i === insertAt
            ? candidate
            : this.entries[i - 1];
      this.refill(tokens, last, entry.time);
      last = entry.time;
      const dry = this.spend(tokens, entry.costs);
      if (dry !== null) return dry;
    }
    this.entries.splice(insertAt, 0, candidate);
    this.tailTokens = tokens;
    this.tailTime = last;
    return null;
  }

  // Folds entries before `cutoff` (seconds) into the checkpoint.
  prune(cutoff: number): void {
    let folded = 0;
    while (folded < this.entries.length && this.entries[folded].time < cutoff) {
      const entry = this.entries[folded];
      this.refill(this.checkpointTokens, this.checkpoint, entry.time);
      entry.costs.forEach((cost, b) => (this.checkpointTokens[b] -= cost));
      this.checkpoint = entry.time;
      folded++;
    }
    if (folded > 0) this.entries.splice(0, folded);
  }

  private spend(tokens: number[], costs: readonly number[]): number | null {
    for (let b = 0; b < this.buckets.length; b++) {
      tokens[b] -= costs[b];
      if (tokens[b] < -EPSILON) return b;
    }
    return null;
  }

  private refill(tokens: number[], from: number | null, to: number): void {
    if (from === null || to <= from) return;
    const seconds = to - from;
    this.buckets.forEach((bucket, b) => {
      tokens[b] = Math.min(
        bucket.capacity,
        tokens[b] + seconds * bucket.refillPerSecond,
      );
    });
  }
}
