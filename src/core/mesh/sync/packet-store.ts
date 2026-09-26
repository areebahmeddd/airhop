// Packets held for gossip sync, oldest first, under a count and a byte budget.
//
// Mirrors bitchat-ios GossipSyncManager.PacketStore. The count alone is not a
// bound: a thousand packets at their type's payload cap would pin over 100 MiB,
// so the oldest go until both hold.
import type { Packet } from "../wire/packet-codec";

export class PacketStore {
  // Insertion-ordered, so the first key is always the oldest.
  private readonly packets = new Map<string, Packet>();
  private bytes = 0;

  constructor(
    private readonly capacity: number,
    private readonly byteBudget: number = Number.POSITIVE_INFINITY,
  ) {}

  // Store under `key`, as the newest. A packet that could never fit the budget
  // is refused rather than emptying the store to make room for it.
  insert(key: string, packet: Packet): void {
    if (packet.payload.length > this.byteBudget) return;
    this.remove(key);
    this.packets.set(key, packet);
    this.bytes += packet.payload.length;
    while (this.packets.size > this.capacity || this.bytes > this.byteBudget) {
      const oldest = this.packets.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  get(key: string): Packet | undefined {
    return this.packets.get(key);
  }

  remove(key: string): void {
    const packet = this.packets.get(key);
    if (packet === undefined) return;
    this.packets.delete(key);
    this.bytes -= packet.payload.length;
  }

  removeWhere(drop: (packet: Packet) => boolean): void {
    for (const [key, packet] of this.packets) {
      if (drop(packet)) this.remove(key);
    }
  }

  values(): IterableIterator<Packet> {
    return this.packets.values();
  }

  clear(): void {
    this.packets.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.packets.size;
  }

  get payloadBytes(): number {
    return this.bytes;
  }
}
