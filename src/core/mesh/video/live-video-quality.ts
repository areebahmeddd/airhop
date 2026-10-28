// The sender's presets and the limits around a live stream, as bitchat ships
// them (LIVE_VIDEO_V1 "Sender behavior"), so a stream from either client
// costs the mesh the same airtime.
//
// Dimensions are portrait and multiples of 16, so every hardware H.264
// encoder takes them without cropping. Low is about the airtime of a live
// voice burst and suits several Bluetooth hops; Medium suits one or two; High
// assumes Wi-Fi Aware.

import { fecPolicy, type LiveVideoFecPolicy } from "./video-stream-packetizer";

export type LiveVideoQualityName = "low" | "medium" | "high";

export interface LiveVideoQuality {
  name: LiveVideoQualityName;
  width: number;
  height: number;
  fps: number;
  // Bits per second.
  videoBitrate: number;
  audioBitrate: number;
  fec: LiveVideoFecPolicy;
}

// A keyframe every two seconds: the longest a late viewer waits for a picture,
// and the longest a loss freezes one.
export const KEYFRAME_INTERVAL_SECONDS = 2;

export const LIVE_VIDEO_QUALITIES: Record<
  LiveVideoQualityName,
  LiveVideoQuality
> = {
  low: {
    name: "low",
    width: 144,
    height: 192,
    fps: 8,
    videoBitrate: 18_000,
    audioBitrate: 12_000,
    fec: { ...fecPolicy(0.2, 0.4), blockWindowMs: 600 },
  },
  medium: {
    name: "medium",
    width: 240,
    height: 320,
    fps: 12,
    videoBitrate: 56_000,
    audioBitrate: 16_000,
    fec: { ...fecPolicy(0.2, 0.35), maxSourceShards: 16 },
  },
  high: {
    name: "high",
    width: 480,
    height: 640,
    fps: 24,
    videoBitrate: 360_000,
    audioBitrate: 24_000,
    fec: { ...fecPolicy(0.15, 0.3), maxSourceShards: 32 },
  },
};

// Packets a second a Bluetooth route carries before queues build up out of
// sight. The sender paces to the lower of this and what the preset needs.
export const BLE_PACKET_BUDGET = 24;

// The largest recording resent as a file afterwards: 256 fragments of about
// 450 B, less the file's TLVs, the header, the signature and Noise framing.
// A longer stream is not resent; viewers keep what they rebuilt.
export const MAX_LIVE_VIDEO_FILE_BYTES = 100 * 1024;

// A stream shorter than this is a slip of the thumb: it is canceled, not
// ended, and nothing is recorded.
export const MIN_LIVE_VIDEO_MS = 1_000;
