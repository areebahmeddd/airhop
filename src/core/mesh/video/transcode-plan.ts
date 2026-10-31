// The numbers for one transcode pass: which part of the source to keep,
// whether it keeps its sound, and the size, frame rate and bitrate of the
// picture.
// bitchat-ios's VideoTranscoder.plan, so a clip shrunk here for a bitchat phone
// is the clip bitchat itself would have made.
//
// The bitrate comes from the budget spread over the kept length; resolution
// and frame rate follow the bitrate, and the upright shape is kept in 16-pixel
// blocks. Native code runs a pass to these numbers and decides nothing.
//
// One Airhop extension: a budget above bitchat's (a DM to another Airhop
// phone) may use bitchat-android's 480-pixel step. At bitchat's own budget the
// ladder is exactly iOS's, which stops at 320.

import { MAX_BITCHAT_VIDEO_BYTES } from "../wire/file-packet";

export const MAX_TRANSCODE_SOURCE_MS = 60_000;
// Two passes, as bitchat-ios makes; a second miss is reported, not looped.
export const MAX_TRANSCODE_ATTEMPTS = 2;

// A source with no usable duration plans as if it ran the full 60 s.
const MIN_PLANNED_MS = 500;
// The MP4 boxes and the encoders' overshoot come out of the budget first.
const CONTAINER_HEADROOM = 0.92;
// A retry aims this far under the budget the first pass missed by.
const RETRY_MARGIN = 0.9;
const AUDIO_BITRATE = 12_000;
// Below this total, 12 kbps of speech would starve the picture.
const AUDIO_MIN_TOTAL_BITRATE = 30_000;
const MIN_VIDEO_BITRATE = 6_000;
const MAX_VIDEO_BITRATE = 600_000;
const WIDE_LONG_EDGE = 480;
const WIDE_MIN_BITRATE = 200_000;
const LONG_EDGE = 320;
const LONG_EDGE_MIN_BITRATE = 60_000;
const SMALL_LONG_EDGE = 192;
const MIN_EDGE = 64;
const KEYFRAME_INTERVAL_SECONDS = 3;

// What a probe of the source reports. The size is upright, rotation applied.
export interface TranscodeSource {
  durationMs: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

// The part of the source to send, as the trimmer leaves it. Without one a pass
// keeps the first MAX_TRANSCODE_SOURCE_MS, as bitchat-ios does.
export interface TranscodeRange {
  startMs: number;
  endMs: number;
}

export interface TranscodePlan {
  startMs: number;
  keepMs: number;
  width: number;
  height: number;
  fps: number;
  // Bits per second.
  videoBitrate: number;
  // Zero drops the sound.
  audioBitrate: number;
  keyframeIntervalSeconds: number;
}

// The bits the first pass may spend.
export function initialTranscodeBits(budgetBytes: number): number {
  return budgetBytes * 8 * CONTAINER_HEADROOM;
}

// The bits a retry may spend, scaled down by how far the last pass overshot.
export function retryTranscodeBits(
  lastBits: number,
  budgetBytes: number,
  producedBytes: number,
): number {
  return ((lastBits * budgetBytes) / producedBytes) * RETRY_MARGIN;
}

export function planTranscode(
  source: TranscodeSource,
  totalBits: number,
  budgetBytes: number,
  range?: TranscodeRange,
): TranscodePlan {
  const keepMs = keptMs(
    range === undefined ? source.durationMs : range.endMs - range.startMs,
  );
  const totalBps = Math.trunc(totalBits / (keepMs / 1000));
  const withAudio = source.hasAudio && totalBps >= AUDIO_MIN_TOTAL_BITRATE;
  const videoBitrate = clamp(
    totalBps - (withAudio ? AUDIO_BITRATE : 0),
    MIN_VIDEO_BITRATE,
    MAX_VIDEO_BITRATE,
  );
  const longEdge = longEdgeFor(videoBitrate, budgetBytes);
  const aspect = source.width / Math.max(source.height, 1);
  const [width, height] =
    aspect >= 1
      ? [longEdge, roundTo16(longEdge / aspect)]
      : [roundTo16(longEdge * aspect), longEdge];
  return {
    startMs: range?.startMs ?? 0,
    keepMs,
    width,
    height,
    fps: fpsFor(videoBitrate),
    videoBitrate,
    audioBitrate: withAudio ? AUDIO_BITRATE : 0,
    keyframeIntervalSeconds: KEYFRAME_INTERVAL_SECONDS,
  };
}

function keptMs(durationMs: number): number {
  const known = Number.isFinite(durationMs) && durationMs > 0;
  return clamp(
    known ? durationMs : MAX_TRANSCODE_SOURCE_MS,
    MIN_PLANNED_MS,
    MAX_TRANSCODE_SOURCE_MS,
  );
}

function longEdgeFor(videoBitrate: number, budgetBytes: number): number {
  if (budgetBytes > MAX_BITCHAT_VIDEO_BYTES && videoBitrate >= WIDE_MIN_BITRATE)
    return WIDE_LONG_EDGE;
  return videoBitrate >= LONG_EDGE_MIN_BITRATE ? LONG_EDGE : SMALL_LONG_EDGE;
}

function fpsFor(videoBitrate: number): number {
  if (videoBitrate >= 120_000) return 24;
  if (videoBitrate >= 40_000) return 15;
  if (videoBitrate >= 18_000) return 10;
  return 6;
}

function roundTo16(value: number): number {
  return Math.max(MIN_EDGE, Math.round(value / 16) * 16);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
