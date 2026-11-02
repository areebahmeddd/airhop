// The sender's pacing queue: a byte and a packet token bucket in front of the
// radio, so the queue a stream builds is one the sender can see and steer by
// (live-video-congestion.ts) rather than a buffer deep in the Bluetooth stack.
// bitchat's LiveVideoSendSession pacing, constant for constant.
//
// A packet that has waited past the deadline is dropped instead of sent: it
// would reach viewers after the moment it shows. Pure: the caller supplies
// time and does the sending.

import type { LiveVideoQuality } from "./live-video-quality";
import { MAX_VIDEO_PACKET_BYTES } from "./video-burst-packet";

// Headroom over the preset's own rate, so the encoder's bursts (a keyframe is
// ten deltas' worth) clear the queue rather than sit in it.
const PACING_HEADROOM = 1.8;
const BURST_PACKETS = 6;
const OUTBOUND_DEADLINE_MS = 1_200;
// A route never paced below this, whatever it reports.
const MIN_PACKET_BUDGET = 4;

export class LiveVideoPacer {
  staleDropped = 0;

  private queue: { queuedAtMs: number; packet: Uint8Array }[] = [];
  private head = 0;
  private byteTokens: number;
  private packetTokens = BURST_PACKETS;
  private lastRefillMs: number | null = null;
  private readonly byteBurst = BURST_PACKETS * MAX_VIDEO_PACKET_BYTES;

  constructor(
    private readonly bytesPerSecond: number,
    private readonly packetsPerSecond: number,
  ) {
    this.byteTokens = this.byteBurst;
  }

  // Paced to the lower of what the preset needs and what the route carries.
  static forQuality(
    quality: LiveVideoQuality,
    packetBudget: number,
  ): LiveVideoPacer {
    const budget = Math.max(MIN_PACKET_BUDGET, packetBudget);
    const presetBytes =
      ((quality.videoBitrate + quality.audioBitrate) / 8) *
      (1 + quality.fec.parityRatio) *
      PACING_HEADROOM;
    return new LiveVideoPacer(
      Math.min(presetBytes, budget * MAX_VIDEO_PACKET_BYTES),
      budget,
    );
  }

  get backlog(): number {
    return this.queue.length - this.head;
  }

  enqueue(packets: readonly Uint8Array[], nowMs: number): void {
    for (const packet of packets)
      this.queue.push({ queuedAtMs: nowMs, packet });
  }

  // Sends what the buckets allow and returns how long until the next packet
  // may go, 0 once the queue is empty. `final` sends late packets too: an END
  // that arrives late still ends the stream for its viewers.
  drain(
    nowMs: number,
    send: (packet: Uint8Array) => void,
    final = false,
  ): number {
    this.refill(nowMs);
    while (this.head < this.queue.length) {
      const { queuedAtMs, packet } = this.queue[this.head];
      if (!final && nowMs - queuedAtMs > OUTBOUND_DEADLINE_MS) {
        this.head++;
        this.staleDropped++;
        continue;
      }
      if (this.byteTokens < packet.length || this.packetTokens < 1) {
        this.compact();
        const byteWait =
          Math.max(0, packet.length - this.byteTokens) / this.bytesPerSecond;
        const packetWait =
          Math.max(0, 1 - this.packetTokens) / this.packetsPerSecond;
        return Math.ceil(Math.max(byteWait, packetWait) * 1000);
      }
      this.byteTokens -= packet.length;
      this.packetTokens -= 1;
      this.head++;
      send(packet);
    }
    this.queue = [];
    this.head = 0;
    return 0;
  }

  clear(): void {
    this.queue = [];
    this.head = 0;
  }

  private refill(nowMs: number): void {
    const elapsed =
      this.lastRefillMs === null
        ? 0
        : Math.max(0, nowMs - this.lastRefillMs) / 1000;
    this.lastRefillMs = nowMs;
    this.byteTokens = Math.min(
      this.byteBurst,
      this.byteTokens + elapsed * this.bytesPerSecond,
    );
    this.packetTokens = Math.min(
      BURST_PACKETS,
      this.packetTokens + elapsed * this.packetsPerSecond,
    );
  }

  private compact(): void {
    if (this.head < 256) return;
    this.queue = this.queue.slice(this.head);
    this.head = 0;
  }
}
