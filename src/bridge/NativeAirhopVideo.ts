// The native contract for live video: H.264 in and out of the hardware codecs,
// pictures on screen, and samples into an MP4.
//
// Hand-maintained, not Codegen input. See NativeAirhopBLE.ts for why.
//
// Media plumbing only. The wire format, erasure code, packetizer, assembler,
// pacing and the playout clock are all in core/mesh/video/; nothing here knows
// what a packet is. iOS is backed by AirhopVideoModule.swift (AVCaptureSession,
// VideoToolbox, AVSampleBufferDisplayLayer, AVAssetWriter), Android by
// AirhopVideoModule.kt (CameraX, MediaCodec, MediaMuxer).
//
// Video crosses the bridge as base64 H.264 access units in Annex B with 4-byte
// start codes, and every keyframe carries its SPS and PPS in-band: LIVE_VIDEO_V1's
// unit format exactly, so what native emits is what goes on the wire. Audio is
// raw AAC-LC 16 kHz mono, the frames AirhopVoice already captures and plays.
//
// Events emitted by native code:
//
//   AirhopVideo.encoded      { dataBase64, ptsMs, keyframe }
//   AirhopVideo.cameraError  { message }
//
// cameraError means capture stopped on its own (the camera was taken, the
// encoder failed, the app lost the foreground) and the caller should end the
// stream.
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
