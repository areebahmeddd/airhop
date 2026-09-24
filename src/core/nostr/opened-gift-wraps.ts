// Gift wraps already opened this session, so a relay replaying the lookback
// window after a pool rebuild is not decrypted and acknowledged again. Keyed by
// wrap event ID, not message ID: a sender's retry comes in a new wrap and still
// needs acknowledging.

// Well past one inbox's lookback. Evicting the oldest costs at most a reopen.
const MAX_OPENED = 5_000;

export class OpenedGiftWraps {
  private readonly ids = new Set<string>();

  has(eventID: string): boolean {
    return this.ids.has(eventID);
  }

  add(eventID: string): void {
    if (this.ids.size >= MAX_OPENED) {
      // Sets iterate in insertion order.
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    this.ids.add(eventID);
  }
}
