// The sending side of a live video stream: encoded audio and video units in,
// signed-packet payloads out. bitchat's VideoStreamPacketizer, so a viewer on
// either client rebuilds the same blocks.
//
// Small units share one DATA shard and large ones fragment across several, so
// every packet parses on its own and a loss only damages the units it carried.
// Consecutive shards form a block, closed by count, by time or ahead of a
// keyframe, and protected by Reed-Solomon parity. Shards leave at once; parity
// costs latency only when a shard is actually lost.
//
// Pure: the caller supplies the clock and owns the one queue that drives it.

import { fecSymbol } from "./fec-symbol";
import { encodeParity } from "./reed-solomon";
import {
  encodeEntries,
  encodeVideoBurstPacket,
  ENTRY_HEADER_BYTES,
  MAX_BLOCK_PARITY_SHARDS,
  MAX_BLOCK_SOURCE_SHARDS,
  MAX_ENTRIES_REGION,
  type LiveVideoConfig,
  type LiveVideoEntry,
  type VideoPacketKind,
  type VideoTrack,
} from "./video-burst-packet";

// A fragment carrying less than this is not worth its 11-byte header.
const MIN_FRAGMENT_BYTES = 24;
// END is sent more than once: a lost one leaves viewers waiting out their
// reconnect window, and copies dedupe as duplicates.
const END_COPIES = 3;

// One encoded access unit.
export interface LiveMediaUnit {
  track: VideoTrack;
  ptsMs: number;
  keyframe: boolean;
  data: Uint8Array;
}

export interface LiveVideoFecPolicy {
  parityRatio: number;
  keyframeParityRatio: number;
  maxSourceShards: number;
  // Longest a part-filled shard waits for more units.
  shardFlushMs: number;
  // Longest a block stays open before its parity goes out.
  blockWindowMs: number;
}

export function fecPolicy(
  parityRatio: number,
  keyframeParityRatio: number,
): LiveVideoFecPolicy {
  return {
    parityRatio,
    keyframeParityRatio,
    maxSourceShards: 12,
    shardFlushMs: 150,
    blockWindowMs: 400,
  };
}

export function parityCount(
  policy: LiveVideoFecPolicy,
  sourceCount: number,
  containsKeyframe: boolean,
): number {
  const ratio = containsKeyframe
    ? policy.keyframeParityRatio
    : policy.parityRatio;
  if (ratio <= 0) return 0;
  // Two from four sources up: one lost delta frame freezes the picture until
  // the next keyframe, so a double loss is worth absorbing.
  const floor = sourceCount >= 4 ? 2 : 1;
  return Math.min(
    Math.max(Math.ceil(sourceCount * ratio), floor),
    MAX_BLOCK_PARITY_SHARDS,
  );
}

export class VideoStreamPacketizer {
  private sequence = 0;
  private block = 0;
  private openEntries: LiveVideoEntry[] = [];
  private openSize = 0;
  private openSinceMs = 0;
  private blockRegions: Uint8Array[] = [];
  private blockSinceMs = 0;
  private blockHasKeyframe = false;
  private readonly unitSequence = { video: 0, audio: 0 };
  private readonly unitCount = { video: 0, audio: 0 };

  packetCount = 0;
  droppedUnits = 0;
  parityPackets = 0;

  constructor(
    readonly streamID: Uint8Array,
    private readonly config: LiveVideoConfig,
    private readonly fec: LiveVideoFecPolicy,
    private readonly maxEntriesRegion = MAX_ENTRIES_REGION,
  ) {}

  unitsEmitted(track: VideoTrack): number {
    return this.unitCount[track];
  }

  start(): Uint8Array[] {
    return this.packet({ kind: "start", config: this.config });
  }

  add(unit: LiveMediaUnit, nowMs: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    if (unit.data.length === 0) return out;
    const bodyBudget = this.maxEntriesRegion - ENTRY_HEADER_BYTES;
    if (unit.keyframe && unit.track === "video") {
      // A keyframe gets its own, more strongly protected block, announced by a
      // repeated START so a viewer joining mid-stream can configure a decoder.
      out.push(
        ...this.flushShard(nowMs),
        ...this.closeBlock(),
        ...this.start(),
      );
    }
    const firstCapacity =
      this.maxEntriesRegion - this.openSize - ENTRY_HEADER_BYTES;
    const useOpenShard =
      this.openEntries.length > 0 &&
      firstCapacity >= Math.min(unit.data.length, MIN_FRAGMENT_BYTES);
    if (this.openEntries.length > 0 && !useOpenShard) {
      out.push(...this.flushShard(nowMs));
    }
    const firstChunk = Math.min(
      useOpenShard ? firstCapacity : bodyBudget,
      unit.data.length,
    );
    const fragmentCount =
      1 + Math.ceil((unit.data.length - firstChunk) / bodyBudget);
    if (fragmentCount > 0xff) {
      this.droppedUnits++;
      return out;
    }
    const sequence = this.unitSequence[unit.track];
    this.unitSequence[unit.track] = (sequence + 1) & 0xffff;
    this.unitCount[unit.track] = Math.min(
      this.unitCount[unit.track] + 1,
      0xffff,
    );
    const ptsMs = Math.min(Math.max(unit.ptsMs, 0), 0xffffffff);
    let offset = 0;
    for (let fragment = 0; fragment < fragmentCount; fragment++) {
      const chunk =
        fragment === 0
          ? firstChunk
          : Math.min(bodyBudget, unit.data.length - offset);
      const entry: LiveVideoEntry = {
        track: unit.track,
        keyframe: unit.keyframe,
        unitSequence: sequence,
        ptsMs,
        fragmentIndex: fragment,
        fragmentCount,
        bytes: unit.data.subarray(offset, offset + chunk),
      };
      offset += chunk;
      if (this.openEntries.length === 0) this.openSinceMs = nowMs;
      this.openEntries.push(entry);
      this.openSize += ENTRY_HEADER_BYTES + chunk;
      if (unit.keyframe) this.blockHasKeyframe = true;
      if (
        this.maxEntriesRegion - this.openSize <
        ENTRY_HEADER_BYTES + MIN_FRAGMENT_BYTES
      ) {
        out.push(...this.flushShard(nowMs));
      }
    }
    return out;
  }

  // Shards and parity whose latency deadline has passed.
  tick(nowMs: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    if (
      this.openEntries.length > 0 &&
      nowMs - this.openSinceMs >= this.fec.shardFlushMs
    ) {
      out.push(...this.flushShard(nowMs));
    }
    if (
      this.blockRegions.length > 0 &&
      nowMs - this.blockSinceMs >= this.fec.blockWindowMs
    ) {
      out.push(...this.closeBlock());
    }
    return out;
  }

  finish(durationMs: number, nowMs: number): Uint8Array[] {
    const out = [...this.flushShard(nowMs), ...this.closeBlock()];
    const end: VideoPacketKind = {
      kind: "end",
      durationMs: Math.min(Math.max(durationMs, 0), 0xffffffff),
      videoUnits: this.unitCount.video,
      audioUnits: this.unitCount.audio,
      packets: Math.min(this.packetCount, 0xffff),
    };
    for (let i = 0; i < END_COPIES; i++) out.push(...this.packet(end));
    return out;
  }

  cancel(): Uint8Array[] {
    return this.packet({ kind: "canceled" });
  }

  private flushShard(nowMs: number): Uint8Array[] {
    if (this.openEntries.length === 0) return [];
    const region = encodeEntries(this.openEntries);
    this.openEntries = [];
    this.openSize = 0;
    if (this.blockRegions.length === 0) this.blockSinceMs = nowMs;
    const index = this.blockRegions.length;
    this.blockRegions.push(region);
    const out = this.packet({ kind: "data", block: this.block, index, region });
    if (
      this.blockRegions.length >=
      Math.min(this.fec.maxSourceShards, MAX_BLOCK_SOURCE_SHARDS)
    ) {
      out.push(...this.closeBlock());
    }
    return out;
  }

  private closeBlock(): Uint8Array[] {
    if (this.blockRegions.length === 0) return [];
    const k = this.blockRegions.length;
    const r = parityCount(this.fec, k, this.blockHasKeyframe);
    const out: Uint8Array[] = [];
    if (r > 0) {
      const length =
        2 + Math.max(...this.blockRegions.map((region) => region.length));
      const symbols = this.blockRegions.map((region) =>
        fecSymbol(region, length),
      );
      encodeParity(symbols, r).forEach((symbol, parityIndex) => {
        const packet = this.packet({
          kind: "parity",
          block: this.block,
          parityIndex,
          sourceCount: k,
          parityCount: r,
          symbol,
        });
        this.parityPackets += packet.length;
        out.push(...packet);
      });
    }
    this.blockRegions = [];
    this.blockHasKeyframe = false;
    this.block = (this.block + 1) & 0xffff;
    return out;
  }

  // The packet as a zero- or one-element list, so the sequence only advances
  // past one that encoded.
  private packet(kind: VideoPacketKind): Uint8Array[] {
    const encoded = encodeVideoBurstPacket({
      ...kind,
      streamID: this.streamID,
      sequence: this.sequence,
    });
    if (encoded === null) return [];
    this.sequence = (this.sequence + 1) & 0xffff;
    this.packetCount++;
    return [encoded];
  }
}
