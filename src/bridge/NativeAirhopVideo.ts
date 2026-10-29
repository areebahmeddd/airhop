// The native contract for video: H.264 in and out of the hardware codecs,
// pictures on screen, samples into an MP4, and one transcode pass of a file.
//
// Hand-maintained, not Codegen input. See NativeAirhopBLE.ts for why.
//
// Media plumbing only. The wire format, erasure code, packetizer, assembler,
// pacing and the playout clock are all in core/mesh/video/; nothing here knows
// what a packet is, and a transcode runs the plan core/mesh/video/transcode-plan
// makes without second-guessing it. iOS is backed by AirhopVideoModule.swift
// (AVCaptureSession, VideoToolbox, AVSampleBufferDisplayLayer, AVAssetReader and
// AVAssetWriter), Android by AirhopVideoModule.kt (CameraX, MediaCodec,
// MediaMuxer, Media3 Transformer).
//
// Video crosses the bridge as base64 H.264 access units in Annex B with 4-byte
// start codes, and every keyframe carries its SPS and PPS in-band: LIVE_VIDEO_V1's
// unit format exactly, so what native emits is what goes on the wire. Audio is
// raw AAC-LC 16 kHz mono, the frames AirhopVoice already captures and plays.
//
// Events emitted by native code:
//
//   AirhopVideo.encoded            { dataBase64, ptsMs, keyframe }
//   AirhopVideo.cameraError        { message }
//   AirhopVideo.transcodeProgress  { jobKey, fraction }
//
// cameraError means capture stopped on its own (the camera was taken, the
// encoder failed, the app lost the foreground) and the caller should end the
// stream. transcodeProgress is throttled natively, and `fraction` runs 0 to 1
// over one pass.
import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export type CameraFacing = "front" | "back";

export interface CameraOptions {
  facing: CameraFacing;
  // The encoded picture, portrait. The camera's frames are centre-cropped and
  // scaled to it, so the preview shows what viewers get.
  width: number;
  height: number;
  fps: number;
  // Bits per second.
  bitrate: number;
  keyframeIntervalSeconds: number;
}

export interface FinishedRecording {
  durationMs: number;
  sizeBytes: number;
}

// A source as a transcode sees it. The size is upright, rotation applied.
export interface VideoProbe {
  durationMs: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

// One pass: `keepMs` of the source from `startMs`, as H.264 at exactly this
// upright size, frame rate and bitrate, with AAC-LC 16 kHz mono at
// `audioBitrate`, or no sound at 0. The output starts at zero, SDR BT.709
// whatever the source, with no source metadata (location above all) carried
// over.
export interface TranscodeOptions {
  startMs: number;
  keepMs: number;
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  audioBitrate: number;
  keyframeIntervalSeconds: number;
}

export interface TranscodeResult {
  sizeBytes: number;
  durationMs: number;
}

export interface Spec extends TurboModule {
  // ---- Display ----

  // Decode one access unit onto the AirhopVideoSurface whose `surfaceKey`
  // matches. Paced by the caller: a unit shows the moment it lands. With no
  // surface mounted it is dropped, and the next one after a surface appears
  // must be a keyframe; native waits for it rather than painting garbage.
  decodeVideo(surfaceKey: string, dataBase64: string, keyframe: boolean): void;
  // The stream is over: free the decoder and blank the surface.
  releaseDecoder(surfaceKey: string): void;

  // ---- Recording ----

  // Open an MP4 at `path` (a file:// URI). Nothing is written until the first
  // keyframe with SPS and PPS, which sets the format and the timeline's start;
  // anything earlier is dropped. The size is the picture's, for the track
  // header; iOS reads it from the SPS instead.
  startRecording(
    recordingKey: string,
    path: string,
    width: number,
    height: number,
    hasAudio: boolean,
  ): Promise<void>;
  // Samples in their track's order; one at or before its predecessor's pts is
  // dropped. A gap in either track plays back as a held picture or silence.
  appendVideo(
    recordingKey: string,
    dataBase64: string,
    ptsMs: number,
    keyframe: boolean,
  ): void;
  appendAudio(recordingKey: string, dataBase64: string, ptsMs: number): void;
  // Null, and nothing left on disk, when no picture was ever written.
  finishRecording(recordingKey: string): Promise<FinishedRecording | null>;
  cancelRecording(recordingKey: string): void;

  // ---- Transcode ----

  // Rejects NO_VIDEO for a file without a picture, UNREADABLE for one that
  // cannot be opened.
  probeVideo(uri: string): Promise<VideoProbe>;
  // One pass from `source` to `output` (file:// URIs). Passes run one at a
  // time; a second waits for the first. Rejects CANCELLED after
  // cancelTranscode, TRANSCODE_FAILED otherwise, and either way leaves nothing
  // at `output`.
  transcodeVideo(
    jobKey: string,
    source: string,
    output: string,
    options: TranscodeOptions,
  ): Promise<TranscodeResult>;
  // A key with nothing running, or already finished, is ignored.
  cancelTranscode(jobKey: string): void;
  // Upright JPEG stills of the source at each of `timesMs`, the nearest
  // keyframe to each, no larger than `maxEdge` pixels on the long side, written
  // to the matching `outputs` (file:// URIs). A frame that cannot be grabbed is
  // skipped rather than failing the rest.
  extractFrames(
    source: string,
    timesMs: number[],
    maxEdge: number,
    outputs: string[],
  ): Promise<void>;

  // ---- Capture ----

  // Open the camera behind every mounted AirhopCameraPreview. Rejects without
  // permission or a camera. Nothing is encoded until startEncoding. The screen
  // stays on until stopCamera.
  startCamera(options: CameraOptions): Promise<void>;
  // Rejects, keeping the open camera, when the switch fails.
  setFacing(facing: CameraFacing): Promise<void>;
  // Emit AirhopVideo.encoded from now on, pts counted from this call. The
  // first unit is a keyframe.
  startEncoding(): Promise<void>;
  // Flush the encoder: every unit it was holding is emitted before this
  // resolves.
  stopEncoding(): Promise<void>;
  // Congestion control's answer, applied to the running encoder.
  setBitrate(bitrate: number): void;
  requestKeyframe(): void;
  stopCamera(): Promise<void>;

  // Required by the NativeEventEmitter contract.
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

// Optional: a build without the module offers no live video, and a stream from
// someone else is relayed but not shown.
export default TurboModuleRegistry.get<Spec>("AirhopVideo");
