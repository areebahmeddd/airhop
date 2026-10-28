// Sending live video: the camera's encoded units and the microphone's AAC
// frames in, signed packets out, paced to what the route carries, and the same
// samples recorded into the MP4 that follows the stream as a file. bitchat's
// LiveVideoSendSession in Airhop's terms.
//
// Every 250 ms congestion control reads the deeper of two queues: the pacing
// queue's, and the radio's, which shows only as writes it refused. A growing
// queue lowers the encoder's bitrate, a deep one drops video at the source
// (audio keeps flowing) until it drains and a keyframe restarts the picture.
// There is no receiver feedback to steer by; a broadcast has many listeners
// and none of them answer.
//
// One session per stream, one stream at a time. The caller owns the camera,
// so a viewfinder can run before and after.

import NativeAirhopVideo, {
  type CameraFacing,
} from "@bridge/NativeAirhopVideo";
import { base64ToBytes, bytesToBase64 } from "@core/encoding/base64";
import { LiveVideoCongestionController } from "@core/mesh/video/live-video-congestion";
import { LiveVideoPacer } from "@core/mesh/video/live-video-pacer";
import {
  KEYFRAME_INTERVAL_SECONDS,
  MAX_LIVE_VIDEO_FILE_BYTES,
  MIN_LIVE_VIDEO_MS,
  type LiveVideoQuality,
} from "@core/mesh/video/live-video-quality";
import { STREAM_ID_BYTES } from "@core/mesh/video/video-burst-packet";
import { VideoStreamPacketizer } from "@core/mesh/video/video-stream-packetizer";
import { liveVideoFileName } from "@core/mesh/wire/file-packet";
import { t } from "@i18n";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import * as FileSystem from "expo-file-system";
import { NativeEventEmitter, type EventSubscription } from "react-native";
import { CACHE_FILE_PREFIX } from "./file-transfer-service";
import type { NativeAudioCapture } from "./voice-audio-backend";

const EVT_ENCODED = "AirhopVideo.encoded";
const EVT_CAMERA_ERROR = "AirhopVideo.cameraError";

const TICK_MS = 20;
const CONGESTION_CHECK_MS = 250;
// How long the END and the queue ahead of it may take to leave once the user
// stops. Past it the rest is dropped; viewers still finish on silence.
const FINAL_DRAIN_MS = 8_000;
// One AAC-LC frame: 1024 samples at 16 kHz.
const AUDIO_FRAME_MS = 64;

export interface LiveVideoSendStats {
  elapsedMs: number;
  packetsSent: number;
  bitrate: number;
  // Packets waiting to leave: the congestion signal, shown as a meter.
  backlog: number;
  skipping: boolean;
}

export interface FinishedLiveVideo {
  uri: string;
  name: string;
  durationMs: number;
  sizeBytes: number;
  // Small enough to follow the stream as an ordinary file.
  fitsAsFile: boolean;
}

interface Deps {
  // Hands one VideoBurstPacket to the mesh: signed and broadcast, or sealed
  // to the one peer of a DM.
  send: (payload: Uint8Array) => void;
  // The microphone, or null for a silent stream.
  audio: NativeAudioCapture | null;
  // Ends the stream on the session's own initiative: the camera was taken.
  onFailure: () => void;
  // Packets a second the route carries; see live-video-quality.ts.
  packetBudget: number;
  now?: () => number;
}

export class LiveVideoSendSession {
  readonly streamID: string;
  private readonly packetizer: VideoStreamPacketizer;
  private readonly pacer: LiveVideoPacer;
  private readonly congestion: LiveVideoCongestionController;
  private readonly recordingKey: string;
  private readonly recording: FileSystem.File;
  private readonly now: () => number;
  private startedAtMs = 0;
  private lastCongestionMs = -Infinity;
  private awaitingKeyframe = false;
  private audioFrames = 0;
  private audioOffsetMs: number | null = null;
  private packetsSent = 0;
  // Radio writes refused since the last congestion check, against packets
  // handed over in it.
  private refusedInWindow = 0;
  private sentInWindow = 0;
  private readonly highWater: number;
  private readonly skipWater: number;
  // Live from start() until stop() is called.
  private running = false;
  // stop()'s answer, shared by every caller: the studio and the mesh can both
  // end one stream, and both must get its recording.
  private stopping: Promise<FinishedLiveVideo | null> | null = null;
  // Units still accepted: through the encoder's and the microphone's flush,
  // which stop() waits for, so the stream's last moments are not lost.
  private accepting = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private encodedSub: EventSubscription | null = null;
  private errorSub: EventSubscription | null = null;

  constructor(
    readonly quality: LiveVideoQuality,
    private readonly deps: Deps,
  ) {
    this.now = deps.now ?? Date.now;
    const id = randomBytes(STREAM_ID_BYTES);
    this.streamID = bytesToHex(id);
    this.recordingKey = `send:${this.streamID}`;
    this.packetizer = new VideoStreamPacketizer(
      id,
      {
        width: quality.width,
        height: quality.height,
        fps: quality.fps,
        bitrateKbps: Math.round(quality.videoBitrate / 1000),
        hasAudio: deps.audio !== null,
      },
      quality.fec,
    );
    const budget = deps.packetBudget;
    this.pacer = LiveVideoPacer.forQuality(quality, budget);
    this.highWater = Math.max(6, Math.floor((budget * 6) / 10));
    this.skipWater = Math.max(18, Math.floor((budget * 3) / 2));
    this.congestion = new LiveVideoCongestionController(quality.videoBitrate, {
      highWater: this.highWater,
      skipWater: this.skipWater,
    });
    this.recording = new FileSystem.File(
      FileSystem.Paths.cache,
      `${CACHE_FILE_PREFIX}${String(this.now())}_${liveVideoFileName(this.streamID)}`,
    );
  }

  static openCamera(
    quality: LiveVideoQuality,
    facing: CameraFacing,
  ): Promise<void> {
    const native = NativeAirhopVideo;
    if (!native) return Promise.reject(new Error(t("chat.live_video.failed")));
    return native.startCamera({
      facing,
      width: quality.width,
      height: quality.height,
      fps: quality.fps,
      bitrate: quality.videoBitrate,
      keyframeIntervalSeconds: KEYFRAME_INTERVAL_SECONDS,
    });
  }

  static setFacing(facing: CameraFacing): Promise<void> {
    return NativeAirhopVideo?.setFacing(facing) ?? Promise.resolve();
  }

  static closeCamera(): Promise<void> {
    return NativeAirhopVideo?.stopCamera() ?? Promise.resolve();
  }

  get isRunning(): boolean {
    return this.running;
  }

  stats(): LiveVideoSendStats {
    return {
      elapsedMs: this.running ? this.now() - this.startedAtMs : 0,
      packetsSent: this.packetsSent,
      bitrate: this.congestion.bitrate,
      backlog: this.pacer.backlog,
      skipping: this.congestion.skipping,
    };
  }

  // Goes live on the camera the caller already opened.
  async start(): Promise<void> {
    const native = NativeAirhopVideo;
    if (!native) throw new Error(t("chat.live_video.failed"));
    await native.startRecording(
      this.recordingKey,
      this.recording.uri,
      this.quality.width,
      this.quality.height,
      this.deps.audio !== null,
    );
    // Ended while the recording was opening: nothing has gone on air yet.
    if (this.stopping !== null) {
      native.cancelRecording(this.recordingKey);
      return;
    }
    const emitter = new NativeEventEmitter(
      native as unknown as ConstructorParameters<typeof NativeEventEmitter>[0],
    );
    this.encodedSub = emitter.addListener(
      EVT_ENCODED,
      (e: { dataBase64?: string; ptsMs?: number; keyframe?: boolean }) => {
        if (typeof e.dataBase64 !== "string" || typeof e.ptsMs !== "number") {
          return;
        }
        this.onVideo(e.dataBase64, e.ptsMs, e.keyframe === true);
      },
    );
    this.errorSub = emitter.addListener(EVT_CAMERA_ERROR, () => {
      if (this.running) this.deps.onFailure();
    });
    this.startedAtMs = this.now();
    this.running = true;
    this.accepting = true;
    this.pacer.enqueue(this.packetizer.start(), 0);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    try {
      await native.startEncoding();
    } catch (err) {
      await this.stop(true);
      throw err;
    }
    // The microphone is a bonus: a stream that cannot get one goes on silent.
    await this.deps.audio
      ?.startCapture((frame) => this.onAudio(frame))
      .catch(() => undefined);
  }

  // A link's radio refused this many writes: its transmit queue is full.
  noteRefused(count: number): void {
    this.refusedInWindow += count;
  }

  // Ends the stream: END (or CANCELED), the queue drained, the recording
  // finished. Null when canceled, too short, or nothing was recorded.
  stop(canceled: boolean): Promise<FinishedLiveVideo | null> {
    this.stopping ??= this.running ? this.end(canceled) : Promise.resolve(null);
    return this.stopping;
  }

  // ---- Internals ----

  private async end(canceled: boolean): Promise<FinishedLiveVideo | null> {
    this.running = false;
    const native = NativeAirhopVideo;
    // Both flushes emit their last units before they resolve, and those still
    // go into the stream and the file.
    await this.deps.audio?.stopCapture().catch(() => undefined);
    await native?.stopEncoding().catch(() => undefined);
    this.accepting = false;
    this.encodedSub?.remove();
    this.errorSub?.remove();
    this.encodedSub = null;
    this.errorSub = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;

    const durationMs = this.now() - this.startedAtMs;
    const valid = !canceled && durationMs >= MIN_LIVE_VIDEO_MS;
    const at = this.elapsed();
    this.pacer.enqueue(
      valid ? this.packetizer.finish(durationMs, at) : this.packetizer.cancel(),
      at,
    );
    await this.finalDrain();

    if (!valid) {
      native?.cancelRecording(this.recordingKey);
      discard(this.recording);
      return null;
    }
    const result = await native
      ?.finishRecording(this.recordingKey)
      .catch(() => null);
    if (result === null || result === undefined) return null;
    return {
      uri: this.recording.uri,
      name: liveVideoFileName(this.streamID),
      durationMs: result.durationMs,
      sizeBytes: result.sizeBytes,
      fitsAsFile: result.sizeBytes <= MAX_LIVE_VIDEO_FILE_BYTES,
    };
  }

  private elapsed(): number {
    return this.now() - this.startedAtMs;
  }

  private onVideo(dataBase64: string, ptsMs: number, keyframe: boolean): void {
    if (!this.accepting) return;
    NativeAirhopVideo?.appendVideo(
      this.recordingKey,
      dataBase64,
      ptsMs,
      keyframe,
    );
    // While the queue is far behind, and until a fresh keyframe once it
    // drains, video is dropped here: queued deltas would only arrive stale.
    if (this.congestion.skipping || (this.awaitingKeyframe && !keyframe)) {
      return;
    }
    if (keyframe) this.awaitingKeyframe = false;
    const data = base64ToBytes(dataBase64);
    if (data.length === 0) return;
    const at = this.elapsed();
    this.pacer.enqueue(
      this.packetizer.add({ track: "video", ptsMs, keyframe, data }, at),
      at,
    );
  }

  private onAudio(frame: Uint8Array): void {
    if (!this.accepting) return;
    // The first frame anchors the audio clock to the stream's; after that
    // every frame is exactly 64 ms on, as the encoder made it.
    this.audioOffsetMs ??= this.elapsed();
    const ptsMs = this.audioOffsetMs + this.audioFrames * AUDIO_FRAME_MS;
    this.audioFrames++;
    NativeAirhopVideo?.appendAudio(
      this.recordingKey,
      bytesToBase64(frame),
      ptsMs,
    );
    const at = this.elapsed();
    this.pacer.enqueue(
      this.packetizer.add(
        { track: "audio", ptsMs, keyframe: false, data: frame },
        at,
      ),
      at,
    );
  }

  private tick(): void {
    const at = this.elapsed();
    if (at - this.lastCongestionMs >= CONGESTION_CHECK_MS) {
      this.lastCongestionMs = at;
      const decision = this.congestion.onBacklog(
        Math.max(this.pacer.backlog, this.radioBacklog()),
        at,
      );
      NativeAirhopVideo?.setBitrate(decision.bitrate);
      if (decision.skipVideo) this.awaitingKeyframe = true;
      if (decision.requestKeyframe) NativeAirhopVideo?.requestKeyframe();
    }
    this.pacer.enqueue(this.packetizer.tick(at), at);
    this.pacer.drain(at, (packet) => this.sendPacket(packet));
  }

  private sendPacket(packet: Uint8Array): void {
    this.packetsSent++;
    this.sentInWindow++;
    this.deps.send(packet);
  }

  // A full radio queue read as a queue depth, since the radio reports only
  // that it refused: any refusal is a queue at its high water, and refusals
  // for half of what went out are one far enough behind to drop video.
  private radioBacklog(): number {
    const refused = this.refusedInWindow;
    const sent = this.sentInWindow;
    this.refusedInWindow = 0;
    this.sentInWindow = 0;
    if (refused === 0) return 0;
    return refused * 2 >= sent ? this.skipWater : this.highWater;
  }

  private async finalDrain(): Promise<void> {
    const deadline = this.now() + FINAL_DRAIN_MS;
    while (this.pacer.backlog > 0 && this.now() < deadline) {
      const wait = this.pacer.drain(
        this.elapsed(),
        (packet) => this.sendPacket(packet),
        true,
      );
      if (wait > 0) await sleep(Math.min(wait, 50));
    }
    this.pacer.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function discard(file: FileSystem.File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // Never written, or already gone.
  }
}
