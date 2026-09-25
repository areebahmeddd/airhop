// Sliding-window rate limit per key: at most `max` admitted hits in any
// `windowMs`. Keys come from the air (a claimed peer ID, a link), so a key
// with no hit left in its window is swept out rather than kept for good.
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  // Whether one more hit would be admitted now. Records nothing, so two
  // limiters can both be asked before either spends its budget.
  allows(key: string, now: number): boolean {
    this.sweep(now);
    const recent = this.recent(key, now);
    if (recent.length === 0) this.hits.delete(key);
    else this.hits.set(key, recent);
    return recent.length < this.max;
  }

  record(key: string, now: number): void {
    const recent = this.recent(key, now);
    recent.push(now);
    this.hits.set(key, recent);
  }

  tryAcquire(key: string, now: number): boolean {
    if (!this.allows(key, now)) return false;
    this.record(key, now);
    return true;
  }

  forget(key: string): void {
    this.hits.delete(key);
  }

  reset(): void {
    this.hits.clear();
  }

  get size(): number {
    return this.hits.size;
  }

  private recent(key: string, now: number): number[] {
    const cutoff = now - this.windowMs;
    return (this.hits.get(key) ?? []).filter((t) => t > cutoff);
  }

  // At most once a window, so the cost stays linear in the keys a window saw.
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    const cutoff = now - this.windowMs;
    for (const [key, times] of this.hits) {
      if (times[times.length - 1] <= cutoff) this.hits.delete(key);
    }
  }
}
