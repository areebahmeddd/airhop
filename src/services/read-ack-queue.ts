// Read receipts owed per conversation, sent when the user opens it.
//
// Bounded per conversation, oldest dropped first: the chat store keeps only a
// thread's newest MAX_PER_CHANNEL messages, so an older ID names a bubble that
// is gone, and a chatty or hostile sender would otherwise grow the set until
// the thread opened and then draw one receipt per ID in a burst.
export class ReadAckQueue {
  // Sets iterate in insertion order, so the first ID is always the oldest.
  private readonly pending = new Map<string, Set<string>>();

  constructor(private readonly cap: number) {}

  add(key: string, messageID: string): void {
    const ids = this.pending.get(key) ?? new Set<string>();
    ids.add(messageID);
    for (const oldest of ids) {
      if (ids.size <= this.cap) break;
      ids.delete(oldest);
    }
    this.pending.set(key, ids);
  }

  // Everything owed for `key`, oldest first, which is then no longer owed.
  take(key: string): string[] {
    const ids = this.pending.get(key);
    this.pending.delete(key);
    return ids === undefined ? [] : [...ids];
  }

  // Drop every conversation `keep` says no longer exists.
  retain(keep: (key: string) => boolean): void {
    for (const key of this.pending.keys()) {
      if (!keep(key)) this.pending.delete(key);
    }
  }

  count(key: string): number {
    return this.pending.get(key)?.size ?? 0;
  }
}
