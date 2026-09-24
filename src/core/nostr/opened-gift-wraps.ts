// Gift wraps already opened this session, by event ID.
//
// A DM inbox is re-subscribed with a lookback on every relay-pool rebuild, so
// relays replay the whole window each time, and each replay would otherwise be
// decrypted and acknowledged again. Keyed by the wrap's event ID, not the
// message ID: a sender who never saw our receipt retries in a new wrap, and
// that one still has to be acknowledged.

// Well past what one inbox's lookback holds. Past it, the oldest is forgotten
// and at worst opened once more.
const MAX_OPENED = 5_000;

export class OpenedGiftWraps {
  private readonly ids = new Set<string>();

  has(eventID: string): boolean {
    return this.ids.has(eventID);
  }

  add(eventID: string): void {
    if (this.ids.size >= MAX_OPENED) {
      // A Set iterates in insertion order, so this is the oldest.
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    this.ids.add(eventID);
  }
}
