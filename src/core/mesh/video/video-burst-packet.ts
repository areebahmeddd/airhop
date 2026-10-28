// bitchat's live video packet, LIVE_VIDEO_V1: the payload of a VIDEO_FRAME
// (0x2D) broadcast, and of NoisePayloadType 0x0A inside a DM. Byte for byte
// bitchat's VideoBurstPacket (docs/LIVE_VIDEO_V1.md upstream); the golden
// vectors in its tests pin it.
//
//   [streamID: 8][sequence: u16][kind: u8][body]
//
//   START    0x01  [version=1][videoCodec][width u16][height u16][fps]
//                  [bitrateKbps u16][audioCodec]
//   DATA     0x00  [block u16][index][entries region]
//   END      0x02  [durationMs u32][videoUnits u16][audioUnits u16][packets u16]
//   PARITY   0x03  [block u16][parityIndex][k][r][symbolLen u16][symbol]
//   CANCELED 0x04  no body
//
// Every multi-byte integer is big-endian. decode() refuses anything a bitchat
// client would refuse, which is also the bar a relay holds the packet to.

export const VIDEO_PACKET_VERSION = 1;
export const STREAM_ID_BYTES = 8;
const HEADER_BYTES = STREAM_ID_BYTES + 2 + 1;
const PARITY_HEADER_BYTES = HEADER_BYTES + 7;

// Keeps a Noise-wrapped, signed packet with a four-hop route under the 512-byte
// BLE fragmentation threshold.
export const MAX_VIDEO_PACKET_BYTES = 352;
// A parity symbol is `[regionLength u16][region]`, so the region leaves room.
export const MAX_ENTRIES_REGION =
  MAX_VIDEO_PACKET_BYTES - PARITY_HEADER_BYTES - 2;
export const MAX_BLOCK_SOURCE_SHARDS = 32;
export const MAX_BLOCK_PARITY_SHARDS = 16;
const MAX_DIMENSION = 1920;
const MAX_FPS = 60;

// One entry's fixed header inside a DATA region.
export const ENTRY_HEADER_BYTES = 11;
const TRACK_MASK = 0x03;
const KEYFRAME_FLAG = 0x04;

const KIND_DATA = 0x00;
const KIND_START = 0x01;
const KIND_END = 0x02;
const KIND_PARITY = 0x03;
const KIND_CANCELED = 0x04;

// H.264 Constrained Baseline in Annex B, SPS and PPS on every IDR.
export const VIDEO_CODEC_H264 = 0x01;
export const AUDIO_CODEC_NONE = 0x00;
// Raw AAC-LC at 16 kHz mono, as live voice.
export const AUDIO_CODEC_AAC_LC = 0x01;

export type VideoTrack = "video" | "audio";

export interface LiveVideoConfig {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  hasAudio: boolean;
}

// One media unit, or one fragment of it.
export interface LiveVideoEntry {
  track: VideoTrack;
  keyframe: boolean;
  unitSequence: number;
  ptsMs: number;
  fragmentIndex: number;
  fragmentCount: number;
  bytes: Uint8Array;
}

export type VideoPacketKind =
  | { kind: "start"; config: LiveVideoConfig }
  | { kind: "data"; block: number; index: number; region: Uint8Array }
  | {
      kind: "parity";
      block: number;
      parityIndex: number;
      sourceCount: number;
      parityCount: number;
      symbol: Uint8Array;
    }
  | {
      kind: "end";
      durationMs: number;
      videoUnits: number;
      audioUnits: number;
      packets: number;
    }
  | { kind: "canceled" };

export type VideoBurstPacket = VideoPacketKind & {
  streamID: Uint8Array;
  sequence: number;
};

const u16 = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1];
const u32 = (b: Uint8Array, o: number): number =>
  b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);

function putU16(out: number[], v: number): void {
  out.push((v >> 8) & 0xff, v & 0xff);
}

function putU32(out: number[], v: number): void {
  out.push(
    Math.floor(v / 0x1000000) & 0xff,
    (v >> 16) & 0xff,
    (v >> 8) & 0xff,
    v & 0xff,
  );
}

function entryIsValid(e: LiveVideoEntry): boolean {
  return (
    e.unitSequence >= 0 &&
    e.unitSequence <= 0xffff &&
    e.ptsMs >= 0 &&
    e.ptsMs <= 0xffffffff &&
    e.fragmentCount >= 1 &&
    e.fragmentCount <= 0xff &&
    e.fragmentIndex >= 0 &&
    e.fragmentIndex < e.fragmentCount &&
    e.bytes.length >= 1 &&
    e.bytes.length <= 0xffff &&
    (!e.keyframe || e.track === "video")
  );
}

/** @public Exported for its test until a stream is sent. */
export function encodeEntries(entries: readonly LiveVideoEntry[]): Uint8Array {
  const out: number[] = [];
  for (const e of entries) {
    out.push((e.track === "video" ? 0 : 1) | (e.keyframe ? KEYFRAME_FLAG : 0));
    putU16(out, e.unitSequence);
    putU32(out, e.ptsMs);
    out.push(e.fragmentIndex, e.fragmentCount);
    putU16(out, e.bytes.length);
    for (const byte of e.bytes) out.push(byte);
  }
  return Uint8Array.from(out);
}

// The entries of a DATA region, or null when any is malformed or there are
// none.
export function decodeEntries(region: Uint8Array): LiveVideoEntry[] | null {
  const entries: LiveVideoEntry[] = [];
  let cursor = 0;
  while (cursor < region.length) {
    if (region.length - cursor < ENTRY_HEADER_BYTES) return null;
    const flags = region[cursor];
    const trackBits = flags & TRACK_MASK;
    if ((flags & ~(TRACK_MASK | KEYFRAME_FLAG)) !== 0 || trackBits > 1) {
      return null;
    }
    const length = u16(region, cursor + 9);
    const start = cursor + ENTRY_HEADER_BYTES;
    if (length === 0 || region.length - start < length) return null;
    const entry: LiveVideoEntry = {
      track: trackBits === 0 ? "video" : "audio",
      keyframe: (flags & KEYFRAME_FLAG) !== 0,
      unitSequence: u16(region, cursor + 1),
      ptsMs: u32(region, cursor + 3),
      fragmentIndex: region[cursor + 7],
      fragmentCount: region[cursor + 8],
      bytes: region.slice(start, start + length),
    };
    if (!entryIsValid(entry)) return null;
    entries.push(entry);
    cursor = start + length;
  }
  return entries.length === 0 ? null : entries;
}

function kindIsValid(k: VideoPacketKind): boolean {
  switch (k.kind) {
    case "start": {
      const c = k.config;
      return (
        c.width >= 16 &&
        c.width <= MAX_DIMENSION &&
        c.height >= 16 &&
        c.height <= MAX_DIMENSION &&
        c.width % 2 === 0 &&
        c.height % 2 === 0 &&
        c.fps >= 1 &&
        c.fps <= MAX_FPS &&
        c.bitrateKbps >= 1 &&
        c.bitrateKbps <= 0xffff
      );
    }
    case "data":
      return (
        k.block >= 0 &&
        k.block <= 0xffff &&
        k.index >= 0 &&
        k.index < MAX_BLOCK_SOURCE_SHARDS &&
        k.region.length >= 1 &&
        k.region.length <= MAX_ENTRIES_REGION &&
        decodeEntries(k.region) !== null
      );
    case "parity":
      return (
        k.block >= 0 &&
        k.block <= 0xffff &&
        k.sourceCount >= 1 &&
        k.sourceCount <= MAX_BLOCK_SOURCE_SHARDS &&
        k.parityCount >= 1 &&
        k.parityCount <= MAX_BLOCK_PARITY_SHARDS &&
        k.parityIndex >= 0 &&
        k.parityIndex < k.parityCount &&
        k.symbol.length >= 3 &&
        k.symbol.length <= MAX_ENTRIES_REGION + 2
      );
    case "end":
      return (
        k.durationMs >= 0 &&
        k.durationMs <= 0xffffffff &&
        [k.videoUnits, k.audioUnits, k.packets].every(
          (n) => n >= 0 && n <= 0xffff,
        )
      );
    case "canceled":
      return true;
  }
}

/**
 * @public Exported for its test until a stream is sent. Null for a packet
 * bitchat would not build: a wrong-sized stream ID, a sequence out of range,
 * or any field outside its bounds.
 */
export function encodeVideoBurstPacket(p: VideoBurstPacket): Uint8Array | null {
  if (
    p.streamID.length !== STREAM_ID_BYTES ||
    p.sequence < 0 ||
    p.sequence > 0xffff ||
    !kindIsValid(p)
  ) {
    return null;
  }
  const out: number[] = [...p.streamID];
  putU16(out, p.sequence);
  switch (p.kind) {
    case "start":
      out.push(KIND_START, VIDEO_PACKET_VERSION, VIDEO_CODEC_H264);
      putU16(out, p.config.width);
      putU16(out, p.config.height);
      out.push(p.config.fps);
      putU16(out, p.config.bitrateKbps);
      out.push(p.config.hasAudio ? AUDIO_CODEC_AAC_LC : AUDIO_CODEC_NONE);
      break;
    case "data":
      out.push(KIND_DATA);
      putU16(out, p.block);
      out.push(p.index, ...p.region);
      break;
    case "parity":
      out.push(KIND_PARITY);
      putU16(out, p.block);
      out.push(p.parityIndex, p.sourceCount, p.parityCount);
      putU16(out, p.symbol.length);
      out.push(...p.symbol);
      break;
    case "end":
      out.push(KIND_END);
      putU32(out, p.durationMs);
      putU16(out, p.videoUnits);
      putU16(out, p.audioUnits);
      putU16(out, p.packets);
      break;
    case "canceled":
      out.push(KIND_CANCELED);
      break;
  }
  return Uint8Array.from(out);
}

export function decodeVideoBurstPacket(
  data: Uint8Array,
): VideoBurstPacket | null {
  if (data.length < HEADER_BYTES || data.length > MAX_VIDEO_PACKET_BYTES) {
    return null;
  }
  const streamID = data.slice(0, STREAM_ID_BYTES);
  const sequence = u16(data, STREAM_ID_BYTES);
  const b = HEADER_BYTES;
  let kind: VideoPacketKind;
  switch (data[HEADER_BYTES - 1]) {
    case KIND_START: {
      const audio = data[b + 9];
      if (
        data.length !== b + 10 ||
        data[b] !== VIDEO_PACKET_VERSION ||
        data[b + 1] !== VIDEO_CODEC_H264 ||
        (audio !== AUDIO_CODEC_NONE && audio !== AUDIO_CODEC_AAC_LC)
      ) {
        return null;
      }
      kind = {
        kind: "start",
        config: {
          width: u16(data, b + 2),
          height: u16(data, b + 4),
          fps: data[b + 6],
          bitrateKbps: u16(data, b + 7),
          hasAudio: audio === AUDIO_CODEC_AAC_LC,
        },
      };
      break;
    }
    case KIND_DATA:
      if (data.length <= b + 3) return null;
      kind = {
        kind: "data",
        block: u16(data, b),
        index: data[b + 2],
        region: data.slice(b + 3),
      };
      break;
    case KIND_PARITY: {
      if (data.length < b + 7) return null;
      if (data.length !== b + 7 + u16(data, b + 5)) return null;
      kind = {
        kind: "parity",
        block: u16(data, b),
        parityIndex: data[b + 2],
        sourceCount: data[b + 3],
        parityCount: data[b + 4],
        symbol: data.slice(b + 7),
      };
      break;
    }
    case KIND_END:
      if (data.length !== b + 10) return null;
      kind = {
        kind: "end",
        durationMs: u32(data, b),
        videoUnits: u16(data, b + 4),
        audioUnits: u16(data, b + 6),
        packets: u16(data, b + 8),
      };
      break;
    case KIND_CANCELED:
      if (data.length !== b) return null;
      kind = { kind: "canceled" };
      break;
    default:
      return null;
  }
  return kindIsValid(kind) ? { ...kind, streamID, sequence } : null;
}
