// A set of IDs capped at `capacity`, dropping the oldest added when it grows
// past it, as bitchat-ios's BoundedIDSet does.
//
// For IDs that arrive from relays or off the air, where an unbounded set is
// memory anyone in range can spend. Re-adding an ID already held neither moves
// it nor evicts anything, so every caller checks `has` first when that matters.
export class BoundedIdSet {
  // Sets iterate in insertion order, so the first key is always the oldest.
  private readonly ids = new Set<string>();

  constructor(private readonly capacity: number) {}

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    this.ids.add(id);
    if (this.ids.size <= this.capacity) return;
    const oldest = this.ids.values().next().value;
    if (oldest !== undefined) this.ids.delete(oldest);
  }

  clear(): void {
    this.ids.clear();
  }

  get size(): number {
    return this.ids.size;
  }
}
