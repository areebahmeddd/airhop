// The receiving side of one live video stream: packets in, decodable units
// out, per track in sequence order. bitchat's VideoStreamAssembler, so a
// stream from either client plays the same here.
//
// Packets arrive duplicated, reordered or not at all. A DATA shard is parsed
// the moment it lands; parity rebuilds lost shards once any k symbols of a
// block are present. A gap is skipped after `gapMs`, and a skipped video unit
// breaks the reference chain, so deltas are withheld until the next keyframe:
// the player freezes on the last good picture rather than showing corruption.
//
// Pure: the caller supplies the clock and confines it to one queue.

import { fecRegion, fecSymbol } from "./fec-symbol";
import { reconstruct } from "./reed-solomon";
import {
  decodeEntries,
  type LiveVideoConfig,
  type LiveVideoEntry,
  type VideoBurstPacket,
  type VideoTrack,
} from "./video-burst-packet";

// Every cap bounds what a hostile sender can make a viewer hold.
const MAX_TRACKED_BLOCKS = 48;
const MAX_PENDING_UNITS = 192;
const MAX_READY_UNITS = 192;
// Sequences behind the recent-loss figure the viewer's quality badge shows.
const LOSS_WINDOW = 128;
// Longer than the widest block window plus relay jitter, so parity can land.
const DEFAULT_GAP_MS = 900;
const DEFAULT_MAX_UNIT_BYTES = 256 * 1024;

const TRACKS: readonly VideoTrack[] = ["video", "audio"];

export type LiveVideoOutput =
  | { kind: "config"; config: LiveVideoConfig }
  // A keyframe, or a delta whose references all arrived.
  | {
      kind: "video";
      sequence: number;
      ptsMs: number;
      keyframe: boolean;
      data: Uint8Array;
    }
  | { kind: "audio"; sequence: number; ptsMs: number; data: Uint8Array }
  // Video units lost, or undecodable after a loss, and passed over.
  | { kind: "videoSkipped"; count: number }
  | { kind: "ended"; durationMs: number }
  | { kind: "canceled" };

export interface LiveVideoReceiveStats {
  packets: number;
  bytes: number;
  recoveredShards: number;
  videoUnits: number;
  audioUnits: number;
  skippedVideoUnits: number;
  // Packet loss over the last LOSS_WINDOW sequences, 0 to 1.
  recentLoss: number;
}

interface BlockState {
  sources: Map<number, Uint8Array>;
  parities: Map<number, Uint8Array>;
  sourceCount: number | null;
  parityCount: number | null;
  complete: boolean;
}

interface PendingUnit {
  keyframe: boolean;
  ptsMs: number;
  fragments: (Uint8Array | null)[];
  received: number;
  bytes: number;
}

interface ReadyUnit {
  ptsMs: number;
  keyframe: boolean;
  data: Uint8Array;
}

interface TrackState {
  // Map iteration is insertion order, so the first key is the oldest.
  pending: Map<number, PendingUnit>;
  ready: Map<number, ReadyUnit>;
  next: number | null;
  lastReference: number | null;
  gapSinceMs: number | null;
  released: number;
}

function sameConfig(a: LiveVideoConfig, b: LiveVideoConfig | null): boolean {
  return (
    b !== null &&
    a.width === b.width &&
    a.height === b.height &&
    a.fps === b.fps &&
    a.bitrateKbps === b.bitrateKbps &&
    a.hasAudio === b.hasAudio
  );
}

function minKey(map: ReadonlyMap<number, unknown>): number | null {
  let min: number | null = null;
  for (const key of map.keys()) if (min === null || key < min) min = key;
  return min;
}

// The unbounded value of a 16-bit wire counter closest to `reference`.
export function expandSequence(value: number, reference: number): number {
  let candidate = reference - (reference & 0xffff) + value;
  if (candidate - reference > 0x8000) candidate -= 0x10000;
  if (reference - candidate > 0x8000) candidate += 0x10000;
  return candidate;
}

// END counts units, not sequences: a count of N means sequences 0 to N - 1.
export function expandCount(count: number, reference: number): number {
  let candidate = reference - (reference & 0xffff) + count;
  if (candidate < reference - 0x8000) candidate += 0x10000;
  return candidate;
}

export class VideoStreamAssembler {
  private readonly blocks = new Map<number, BlockState>();
  private readonly tracks: Record<VideoTrack, TrackState> = {
    video: VideoStreamAssembler.track(),
    audio: VideoStreamAssembler.track(),
  };
  private lastConfig: LiveVideoConfig | null = null;
  private videoChainBroken = true;
  private expectedUnits: Record<VideoTrack, number> | null = null;
  private endDurationMs: number | null = null;
  private finished = false;

  private packets = 0;
  private bytes = 0;
  private recoveredShards = 0;
  private skippedVideo = 0;
  private highestSequence: number | null = null;
  private readonly recent = new Set<number>();

  constructor(
    private readonly gapMs = DEFAULT_GAP_MS,
    private readonly maxUnitBytes = DEFAULT_MAX_UNIT_BYTES,
  ) {}

  private static track(): TrackState {
    return {
      pending: new Map(),
      ready: new Map(),
      next: null,
      lastReference: null,
      gapSinceMs: null,
      released: 0,
    };
  }

  get config(): LiveVideoConfig | null {
    return this.lastConfig;
  }

  // The sender's END arrived, so anything still missing is tail loss rather
  // than a pause.
  get endReceived(): boolean {
    return this.expectedUnits !== null;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  stats(): LiveVideoReceiveStats {
    let recentLoss = 0;
    const high = this.highestSequence;
    if (high !== null) {
      const window = Math.min(LOSS_WINDOW, high + 1);
      let seen = 0;
      for (const s of this.recent) if (s > high - window) seen++;
      recentLoss = Math.min(Math.max(1 - seen / window, 0), 1);
    }
    return {
      packets: this.packets,
      bytes: this.bytes,
      recoveredShards: this.recoveredShards,
      videoUnits: this.tracks.video.released,
      audioUnits: this.tracks.audio.released,
      skippedVideoUnits: this.skippedVideo,
      recentLoss,
    };
  }

  onPacket(
    packet: VideoBurstPacket,
    sizeBytes: number,
    nowMs: number,
  ): LiveVideoOutput[] {
    if (this.finished) return [];
    this.packets++;
    this.bytes += sizeBytes;
    this.recordSequence(packet.sequence);
    const out: LiveVideoOutput[] = [];
    switch (packet.kind) {
      case "start":
        if (!sameConfig(packet.config, this.lastConfig)) {
          this.lastConfig = packet.config;
          out.push({ kind: "config", config: packet.config });
        }
        break;
      case "data":
        this.onData(packet.block, packet.index, packet.region);
        break;
      case "parity":
        this.onParity(packet);
        break;
      case "end":
        this.expectedUnits = {
          video: packet.videoUnits,
          audio: packet.audioUnits,
        };
        this.endDurationMs = packet.durationMs;
        break;
      case "canceled":
        this.finished = true;
        return [{ kind: "canceled" }];
    }
    out.push(...this.release(nowMs));
    return out;
  }

  // Skips gaps whose deadline passed; call periodically.
  onTick(nowMs: number): LiveVideoOutput[] {
    return this.finished ? [] : this.release(nowMs);
  }

  // Releases everything buffered, skipping open gaps, without ending the
  // stream: a viewer whose link went quiet keeps what it has and carries on
  // when packets return.
  drain(): LiveVideoOutput[] {
    return this.finished ? [] : this.release(Infinity);
  }

  // Forces every buffered unit out and ends the stream.
  flush(): LiveVideoOutput[] {
    if (this.finished) return [];
    const out = this.release(Infinity);
    // release() has already ended it if END's totals were met.
    if (!this.finished) {
      this.finished = true;
      out.push({ kind: "ended", durationMs: this.endDurationMs ?? 0 });
    }
    return out;
  }

  // ---- Blocks ----

  private onData(block: number, index: number, region: Uint8Array): void {
    const state = this.blockState(block);
    if (state.complete || state.sources.has(index)) return;
    if (state.sourceCount !== null && index >= state.sourceCount) return;
    state.sources.set(index, region);
    this.ingestRegion(region);
    this.tryRecover(state);
  }

  private onParity(p: Extract<VideoBurstPacket, { kind: "parity" }>): void {
    const state = this.blockState(p.block);
    if (state.complete) return;
    if (
      state.sourceCount !== null &&
      (state.sourceCount !== p.sourceCount ||
        state.parityCount !== p.parityCount)
    ) {
      return;
    }
    const existing = state.parities.values().next().value;
    if (existing !== undefined && existing.length !== p.symbol.length) return;
    for (const index of state.sources.keys()) {
      if (index >= p.sourceCount) return;
    }
    state.sourceCount = p.sourceCount;
    state.parityCount = p.parityCount;
    if (!state.parities.has(p.parityIndex)) {
      state.parities.set(p.parityIndex, p.symbol);
    }
    this.tryRecover(state);
  }

  private tryRecover(state: BlockState): void {
    const k = state.sourceCount;
    if (k === null) return;
    if (state.sources.size >= k) {
      state.complete = true;
      return;
    }
    const symbolLength = state.parities.values().next().value?.length;
    if (
      state.sources.size + state.parities.size < k ||
      symbolLength === undefined
    ) {
      return;
    }
    state.complete = true;
    for (const region of state.sources.values()) {
      if (region.length + 2 > symbolLength) return;
    }
    const slots = Array.from({ length: k }, (_, i) => {
      const region = state.sources.get(i);
      return region === undefined ? null : fecSymbol(region, symbolLength);
    });
    const rebuilt = reconstruct(slots, state.parities);
    if (rebuilt === null) return;
    for (let i = 0; i < k; i++) {
      if (state.sources.has(i)) continue;
      const region = fecRegion(rebuilt[i]);
      if (region === null) continue;
      state.sources.set(i, region);
      this.recoveredShards++;
      this.ingestRegion(region);
    }
  }

  private blockState(block: number): BlockState {
    const known = this.blocks.get(block);
    if (known !== undefined) return known;
    while (this.blocks.size >= MAX_TRACKED_BLOCKS) {
      this.blocks.delete(this.blocks.keys().next().value as number);
    }
    const state: BlockState = {
      sources: new Map(),
      parities: new Map(),
      sourceCount: null,
      parityCount: null,
      complete: false,
    };
    this.blocks.set(block, state);
    return state;
  }

  // ---- Units ----

  private ingestRegion(region: Uint8Array): void {
    for (const entry of decodeEntries(region) ?? []) this.ingestEntry(entry);
  }

  private ingestEntry(entry: LiveVideoEntry): void {
    const track = this.tracks[entry.track];
    const sequence = expandSequence(
      entry.unitSequence,
      track.next ?? track.lastReference ?? entry.unitSequence,
    );
    if (track.next !== null && sequence < track.next) return;
    if (track.ready.has(sequence)) return;
    let pending = track.pending.get(sequence);
    if (pending === undefined) {
      if (track.pending.size >= MAX_PENDING_UNITS) {
        track.pending.delete(track.pending.keys().next().value as number);
      }
      pending = {
        keyframe: entry.keyframe,
        ptsMs: entry.ptsMs,
        fragments: new Array<Uint8Array | null>(entry.fragmentCount).fill(null),
        received: 0,
        bytes: 0,
      };
      track.pending.set(sequence, pending);
    }
    if (
      pending.fragments.length !== entry.fragmentCount ||
      pending.keyframe !== entry.keyframe ||
      pending.fragments[entry.fragmentIndex] !== null
    ) {
      return;
    }
    pending.bytes += entry.bytes.length;
    if (pending.bytes > this.maxUnitBytes) {
      track.pending.delete(sequence);
      return;
    }
    pending.fragments[entry.fragmentIndex] = entry.bytes;
    pending.received++;
    if (pending.received < pending.fragments.length) return;
    track.pending.delete(sequence);
    const data = new Uint8Array(pending.bytes);
    let offset = 0;
    for (const fragment of pending.fragments as Uint8Array[]) {
      data.set(fragment, offset);
      offset += fragment.length;
    }
    if (track.next === null) track.next = sequence;
    track.lastReference = sequence;
    track.ready.set(sequence, {
      ptsMs: pending.ptsMs,
      keyframe: pending.keyframe,
      data,
    });
    if (track.ready.size > MAX_READY_UNITS) {
      // A backlog this deep means the head gap will never fill.
      this.skip(entry.track, minKey(track.ready) as number);
    }
  }

  private release(nowMs: number): LiveVideoOutput[] {
    const out: LiveVideoOutput[] = [];
    for (const type of TRACKS) {
      const track = this.tracks[type];
      while (track.next !== null) {
        const next = track.next;
        const unit = track.ready.get(next);
        if (unit !== undefined) {
          track.ready.delete(next);
          track.gapSinceMs = null;
          track.next = next + 1;
          track.released++;
          this.emit(type, next, unit, out);
          continue;
        }
        const target = minKey(track.ready);
        if (target === null) {
          track.gapSinceMs = null;
          break;
        }
        const since = track.gapSinceMs ?? nowMs;
        track.gapSinceMs = since;
        if (nowMs === Infinity || nowMs - since >= this.gapMs) {
          const skipped = this.skip(type, target);
          if (type === "video" && skipped > 0) {
            out.push({ kind: "videoSkipped", count: skipped });
          }
          track.gapSinceMs = null;
          continue;
        }
        break;
      }
    }
    if (this.expectedUnits !== null && !this.finished) {
      const expected = this.expectedUnits;
      const done = TRACKS.every((type) => {
        const total = expected[type];
        if (total === 0) return true;
        const next = this.tracks[type].next;
        return next !== null && next >= expandCount(total, next);
      });
      if (done) {
        this.finished = true;
        out.push({ kind: "ended", durationMs: this.endDurationMs ?? 0 });
      }
    }
    return out;
  }

  private emit(
    type: VideoTrack,
    sequence: number,
    unit: ReadyUnit,
    out: LiveVideoOutput[],
  ): void {
    if (type === "audio") {
      out.push({ kind: "audio", sequence, ptsMs: unit.ptsMs, data: unit.data });
      return;
    }
    if (unit.keyframe) this.videoChainBroken = false;
    if (this.videoChainBroken) {
      this.skippedVideo++;
      out.push({ kind: "videoSkipped", count: 1 });
      return;
    }
    out.push({
      kind: "video",
      sequence,
      ptsMs: unit.ptsMs,
      keyframe: unit.keyframe,
      data: unit.data,
    });
  }

  private skip(type: VideoTrack, target: number): number {
    const track = this.tracks[type];
    if (track.next === null) return 0;
    const skipped = Math.max(target - track.next, 0);
    if (skipped > 0) {
      for (const sequence of track.pending.keys()) {
        if (sequence < target) track.pending.delete(sequence);
      }
      if (type === "video") {
        this.videoChainBroken = true;
        this.skippedVideo += skipped;
      }
    }
    track.next = target;
    return skipped;
  }

  // ---- Sequence numbers ----

  private recordSequence(sequence: number): void {
    const expanded = expandSequence(sequence, this.highestSequence ?? sequence);
    if (this.recent.has(expanded)) return;
    this.recent.add(expanded);
    if (this.highestSequence === null || expanded > this.highestSequence) {
      this.highestSequence = expanded;
    }
    // A Set iterates in insertion order, so the first value is the oldest.
    while (this.recent.size > LOSS_WINDOW) {
      this.recent.delete(this.recent.values().next().value as number);
    }
  }
}
