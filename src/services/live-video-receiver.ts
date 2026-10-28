// Watching live video: every stream in range becomes a row in its chat, shows
// a live picture while that chat is open, and ends as a recording. bitchat's
// ChatLiveVideoCoordinator in Airhop's terms; LIVE_VIDEO_V1 "Receiver
// behavior" is the contract.
//
// A stream is received whether or not anyone is watching. Assembling and
// recording are cheap, and a stream that only existed for whoever had the
// right chat open would leave no trace for anyone else, so the row appears
// with the first picture, not with START: a stream that never shows one (a
// stray START, a stream canceled within a second) leaves nothing behind.
// Decoding is not cheap, so units go to the
// screen only while the chat is open, and sound only for the one stream the
// user unmuted, never over live voice.
//
// A stream goes quiet as "reconnecting" after 4 s and keeps its row open; a
// quiet one whose END arrived finishes, and one with no END closes after 90 s.
// Any end leaves the recording rebuilt here in the row, and if the sender's
// own file (video_<id>.mp4) arrives later it takes the row over. Packets after
// a silence close open a new row for the new segment, since joining the two
// recordings needs a remux; the sender's file, being the whole stream, then
// replaces every segment's row with one.

import NativeAirhopVideo from "@bridge/NativeAirhopVideo";
import { bytesToBase64 } from "@core/encoding/base64";
import { LiveVideoPlayout } from "@core/mesh/video/live-video-playout";
import {
  decodeVideoBurstPacket,
  STREAM_ID_BYTES,
} from "@core/mesh/video/video-burst-packet";
import {
  VideoStreamAssembler,
  type LiveVideoOutput,
} from "@core/mesh/video/video-stream-assembler";
import { liveVideoFileName } from "@core/mesh/wire/file-packet";
import { bytesToHex } from "@noble/hashes/utils.js";
import { useChatStore, type ChatAttachment } from "@store/chat-store";
import { useSettingsStore } from "@store/settings-store";
import * as FileSystem from "expo-file-system";
import {
  enforceIncomingQuota,
  INCOMING_FILE_PREFIX,
} from "./file-transfer-service";
import { trackLiveVideoWork } from "./live-video-work";

// LIVE_VIDEO_V1's resource bounds. Every one caps what a hostile sender in
// range can make this phone hold.
const MAX_STREAMS = 4;
const MAX_STREAM_BYTES = 24 * 1024 * 1024;
const MAX_BYTES_PER_SECOND = 96_000;
const BURST_ALLOWANCE_SECONDS = 3;

const QUIET_MS = 4_000;
// A stream that shows no picture in this long is dropped. A late joiner gets
// one with the next keyframe, two seconds at most, so this is generous; it
// keeps a stream of START packets alone from holding a MAX_STREAMS slot.
const PICTURE_DEADLINE_MS = 10_000;
const CLOSE_AFTER_SILENCE_MS = 90_000;
// Fine enough for 24 fps; the clock below is what keeps frames even.
const TICK_MS = 40;
// How long a stream that ended is remembered, so its END copies and stray
// late packets cannot open it again.
const FINISHED_MEMORY = 64;

export const LIVE_VIDEO_ROW_PREFIX = "live-video-";

export function liveVideoRowID(senderPeerID: string, streamID: string): string {
  return `${LIVE_VIDEO_ROW_PREFIX}${senderPeerID}-${streamID}`;
}

interface Unit {
  track: "video" | "audio";
  ptsMs: number;
  keyframe: boolean;
  data: Uint8Array;
}

interface Stream {
  key: string;
  senderPeerID: string;
  streamID: string;
  channel: string;
  rowID: string;
  assembler: VideoStreamAssembler;
  playout: LiveVideoPlayout<Unit>;
  // Set once START arrives: until then there is no recording.
  config: { width: number; height: number; hasAudio: boolean } | null;
  // Whether the row is in the chat; it is added with the first picture.
  rowAdded: boolean;
  recordingPath: string | null;
  openedAtMs: number;
  lastPacketMs: number;
  quiet: boolean;
  totalBytes: number;
  byteTokens: number;
  lastRefillMs: number;
}

export interface LiveVideoReceiverDeps {
  resolveNickname: (peerID: string) => string;
  // The chat on screen, or null.
  watchedChannel: () => string | null;
  // Live voice owns the speaker while anyone is talking.
  playAudio: (streamKey: string, frames: Uint8Array[]) => void;
  stopAudio: (streamKey: string) => void;
  now?: () => number;
}

export class LiveVideoReceiver {
  private readonly streams = new Map<string, Stream>();
  // Streams that ended, keyed like `streams`, true when the silence closed
  // them (packets may open a new row) and false when the sender ended them.
  private readonly finished = new Map<string, boolean>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private audibleRow: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly deps: LiveVideoReceiverDeps) {
    this.now = deps.now ?? Date.now;
  }

  static get available(): boolean {
    return NativeAirhopVideo !== null && NativeAirhopVideo !== undefined;
  }

  // Rows left live by a process that died cannot come back: their stream is
  // either over or will reopen with a fresh START.
  dropStaleRows(): void {
    const chat = useChatStore.getState();
    for (const [channel, list] of Object.entries(chat.messages)) {
      for (const m of list) {
        if (m.liveVideo !== undefined) chat.removeMessage(channel, m.id);
      }
    }
  }

  // One VideoBurstPacket from `senderPeerID`, already authenticated: signed and
  // fresh on the mesh, or sealed in that peer's Noise session.
  onPacket(senderPeerID: string, channel: string, payload: Uint8Array): void {
    if (!useSettingsStore.getState().liveVideoEnabled) return;
    if (!LiveVideoReceiver.available) return;
    const packet = decodeVideoBurstPacket(payload);
    if (packet === null || packet.streamID.length !== STREAM_ID_BYTES) return;
    const streamID = bytesToHex(packet.streamID);
    const key = `${senderPeerID}:${streamID}`;
    const now = this.now();

    let stream = this.streams.get(key);
    if (stream === undefined) {
      const closedBySilence = this.finished.get(key);
      if (closedBySilence === false) return;
      // One camera, one stream: a sender's new stream means the old one is
      // over, even if its END was lost.
      for (const other of [...this.streams.values()]) {
        if (other.senderPeerID === senderPeerID) this.end(other, false);
      }
      if (this.streams.size >= MAX_STREAMS) return;
      stream = this.open(key, senderPeerID, streamID, channel, now);
      if (closedBySilence === true) {
        // A new row for the new segment, so its ID must differ from the old.
        stream.rowID = `${stream.rowID}-${String(now)}`;
        this.finished.delete(key);
      }
    }

    if (!this.admit(stream, payload.length, now)) {
      this.close(stream, "bound");
      return;
    }
    stream.lastPacketMs = now;
    if (stream.quiet) this.setQuiet(stream, false);
    this.apply(
      stream,
      stream.assembler.onPacket(packet, payload.length, now),
      now,
    );
    this.ensureTicking();
  }

  // The sender's own recording arrived as a file. Returns true when it took
  // the stream's rows over, in which case the caller adds no row of its own.
  absorbFinalFile(
    senderPeerID: string,
    channel: string,
    streamID: string,
    attachment: ChatAttachment,
  ): boolean {
    const base = liveVideoRowID(senderPeerID, streamID);
    const chat = useChatStore.getState();
    // The first segment's row, then any a resumed stream opened after it.
    const rows = (chat.messages[channel] ?? []).filter(
      (m) => m.id === base || m.id.startsWith(`${base}-`),
    );
    if (rows.length === 0) return false;
    const live = this.streams.get(`${senderPeerID}:${streamID}`);
    if (live !== undefined) this.close(live, "replaced");
    const [kept, ...rest] = rows;
    for (const row of rows) {
      const rebuilt = row.attachment?.uri;
      if (rebuilt !== undefined && rebuilt !== attachment.uri) {
        deleteFile(rebuilt);
      }
    }
    for (const row of rest) chat.removeMessage(channel, row.id);
    chat.setLiveVideoRow(channel, kept.id, {
      liveVideo: undefined,
      attachment,
    });
    return true;
  }

  // ---- Sound ----

  // The one row whose sound plays, or null for none.
  get audible(): string | null {
    return this.audibleRow;
  }

  setAudible(rowID: string | null): void {
    if (rowID === this.audibleRow) return;
    const previous = this.streamForRow(this.audibleRow);
    if (previous !== undefined) this.deps.stopAudio(previous.key);
    this.audibleRow = rowID;
    for (const fn of this.listeners) fn();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  // Everything stops: the mesh went down or the app is being wiped. What was
  // received so far is still kept as a recording.
  stop(): void {
    for (const stream of [...this.streams.values()]) this.end(stream, true);
    this.stopTicking();
  }

  // ---- Internals ----

  // A stream with a row ends as its recording; one that never showed a
  // picture just goes, its recording with it. A reopenable one takes a new row
  // if its packets come back: the mesh restarted, or it simply had no picture
  // yet.
  private end(stream: Stream, reopenable: boolean): void {
    if (stream.rowAdded) {
      this.close(stream, reopenable ? "silence" : "ended");
      return;
    }
    this.streams.delete(stream.key);
    if (!reopenable) this.rememberFinished(stream.key, false);
    NativeAirhopVideo?.cancelRecording(stream.key);
    if (stream.recordingPath !== null) deleteFile(stream.recordingPath);
    if (this.streams.size === 0) this.stopTicking();
  }

  private close(
    stream: Stream,
    why: "ended" | "silence" | "bound" | "replaced",
  ): void {
    this.streams.delete(stream.key);
    this.rememberFinished(stream.key, why === "silence");
    this.deps.stopAudio(stream.key);
    NativeAirhopVideo?.releaseDecoder(stream.key);
    if (this.audibleRow === stream.rowID) this.setAudible(null);
    if (why === "replaced") {
      if (stream.recordingPath !== null) {
        NativeAirhopVideo?.cancelRecording(stream.key);
        deleteFile(stream.recordingPath);
      }
      return;
    }
    void trackLiveVideoWork(this.finishRecording(stream));
    if (this.streams.size === 0) this.stopTicking();
  }

  private open(
    key: string,
    senderPeerID: string,
    streamID: string,
    channel: string,
    now: number,
  ): Stream {
    const stream: Stream = {
      key,
      senderPeerID,
      streamID,
      channel,
      rowID: liveVideoRowID(senderPeerID, streamID),
      assembler: new VideoStreamAssembler(),
      playout: new LiveVideoPlayout<Unit>(),
      config: null,
      rowAdded: false,
      recordingPath: null,
      openedAtMs: now,
      lastPacketMs: now,
      quiet: false,
      totalBytes: 0,
      byteTokens: MAX_BYTES_PER_SECOND * BURST_ALLOWANCE_SECONDS,
      lastRefillMs: now,
    };
    this.streams.set(key, stream);
    return stream;
  }

  // The per-stream byte budget: a sustained rate with a few seconds of burst,
  // and a total.
  private admit(stream: Stream, bytes: number, now: number): boolean {
    const elapsed = Math.max(0, now - stream.lastRefillMs) / 1000;
    stream.lastRefillMs = now;
    stream.byteTokens = Math.min(
      MAX_BYTES_PER_SECOND * BURST_ALLOWANCE_SECONDS,
      stream.byteTokens + elapsed * MAX_BYTES_PER_SECOND,
    );
    stream.byteTokens -= bytes;
    stream.totalBytes += bytes;
    return stream.byteTokens >= 0 && stream.totalBytes <= MAX_STREAM_BYTES;
  }

  private apply(stream: Stream, outputs: LiveVideoOutput[], now: number): void {
    for (const out of outputs) {
      switch (out.kind) {
        case "config":
          this.configure(stream, out.config);
          break;
        case "video":
        case "audio": {
          if (stream.config === null) break;
          const unit: Unit = {
            track: out.kind,
            ptsMs: out.ptsMs,
            keyframe: out.kind === "video" && out.keyframe,
            data: out.data,
          };
          this.record(stream, unit);
          stream.playout.push(unit, now);
          // The assembler releases no video before a keyframe, so this is the
          // first picture.
          if (unit.track === "video" && !stream.rowAdded) this.addRow(stream);
          break;
        }
        case "videoSkipped":
          break;
        case "ended":
          this.present(stream, stream.playout.flush());
          this.close(stream, "ended");
          return;
        case "canceled":
          this.cancel(stream);
          return;
      }
    }
  }

  private configure(
    stream: Stream,
    config: { width: number; height: number; hasAudio: boolean },
  ): void {
    if (stream.config !== null) {
      // A new START mid-stream: a new size the row should take. The recording
      // keeps the first format; a decoder reconfigures on its next keyframe.
      stream.config = { ...stream.config, ...config };
      this.updateRow(stream);
      return;
    }
    stream.config = config;
    const file = new FileSystem.File(
      FileSystem.Paths.cache,
      `${INCOMING_FILE_PREFIX}${String(this.now())}_${liveVideoFileName(stream.streamID)}`,
    );
    stream.recordingPath = file.uri;
    void NativeAirhopVideo?.startRecording(
      stream.key,
      file.uri,
      config.width,
      config.height,
      config.hasAudio,
    ).catch(() => {
      stream.recordingPath = null;
    });
  }

  private addRow(stream: Stream): void {
    const config = stream.config;
    if (config === null) return;
    stream.rowAdded = true;
    const chat = useChatStore.getState();
    if (stream.channel.startsWith("dm:")) chat.addChannel(stream.channel);
    chat.addMessage({
      id: stream.rowID,
      channel: stream.channel,
      senderID: stream.senderPeerID,
      senderNickname: this.deps.resolveNickname(stream.senderPeerID),
      text: "",
      timestampMs: this.now(),
      isMine: false,
      liveVideo: {
        streamID: stream.streamID,
        state: "live",
        startedAtMs: this.now(),
        width: config.width,
        height: config.height,
      },
    });
  }

  private updateRow(stream: Stream): void {
    const row = useChatStore
      .getState()
      .messages[stream.channel]?.find((m) => m.id === stream.rowID);
    if (row?.liveVideo === undefined || stream.config === null) return;
    useChatStore.getState().setLiveVideoRow(stream.channel, stream.rowID, {
      liveVideo: {
        ...row.liveVideo,
        state: stream.quiet ? "reconnecting" : "live",
        width: stream.config.width,
        height: stream.config.height,
      },
      attachment: undefined,
    });
  }

  private setQuiet(stream: Stream, quiet: boolean): void {
    stream.quiet = quiet;
    this.updateRow(stream);
  }

  private record(stream: Stream, unit: Unit): void {
    const native = NativeAirhopVideo;
    if (native === null || native === undefined) return;
    if (stream.recordingPath === null) return;
    const b64 = bytesToBase64(unit.data);
    if (unit.track === "video") {
      native.appendVideo(stream.key, b64, unit.ptsMs, unit.keyframe);
    } else {
      native.appendAudio(stream.key, b64, unit.ptsMs);
    }
  }

  private present(stream: Stream, units: Unit[]): void {
    if (units.length === 0) return;
    const watching = this.deps.watchedChannel() === stream.channel;
    const audible = watching && this.audibleRow === stream.rowID;
    const sound: Uint8Array[] = [];
    for (const unit of units) {
      if (unit.track === "audio") {
        if (audible) sound.push(unit.data);
      } else if (watching) {
        NativeAirhopVideo?.decodeVideo(
          stream.key,
          bytesToBase64(unit.data),
          unit.keyframe,
        );
      }
    }
    if (sound.length > 0) this.deps.playAudio(stream.key, sound);
  }

  private cancel(stream: Stream): void {
    this.streams.delete(stream.key);
    this.rememberFinished(stream.key, false);
    this.deps.stopAudio(stream.key);
    NativeAirhopVideo?.releaseDecoder(stream.key);
    NativeAirhopVideo?.cancelRecording(stream.key);
    if (stream.recordingPath !== null) deleteFile(stream.recordingPath);
    if (this.audibleRow === stream.rowID) this.setAudible(null);
    useChatStore.getState().removeMessage(stream.channel, stream.rowID);
    if (this.streams.size === 0) this.stopTicking();
  }

  private async finishRecording(stream: Stream): Promise<void> {
    const path = stream.recordingPath;
    let attachment: ChatAttachment | null = null;
    if (path !== null) {
      const result = await NativeAirhopVideo?.finishRecording(stream.key)
        .then((r) => r ?? null)
        .catch(() => null);
      if (result !== null && result !== undefined) {
        enforceIncomingQuota(0);
        attachment = {
          type: "video",
          uri: path,
          name: liveVideoFileName(stream.streamID),
          mimeType: "video/mp4",
          durationMs: result.durationMs,
          sizeBytes: result.sizeBytes,
        };
      }
    }
    const chat = useChatStore.getState();
    const row = chat.messages[stream.channel]?.find(
      (m) => m.id === stream.rowID,
    );
    // The sender's file got here first and the row is already its.
    if (row?.liveVideo === undefined) {
      if (attachment !== null) deleteFile(attachment.uri);
      return;
    }
    if (attachment === null) {
      chat.removeMessage(stream.channel, stream.rowID);
      return;
    }
    chat.setLiveVideoRow(stream.channel, stream.rowID, {
      liveVideo: undefined,
      attachment,
    });
  }

  private rememberFinished(key: string, bySilence: boolean): void {
    this.finished.delete(key);
    this.finished.set(key, bySilence);
    while (this.finished.size > FINISHED_MEMORY) {
      this.finished.delete(this.finished.keys().next().value as string);
    }
  }

  private streamForRow(rowID: string | null): Stream | undefined {
    if (rowID === null) return undefined;
    for (const s of this.streams.values()) if (s.rowID === rowID) return s;
    return undefined;
  }

  private ensureTicking(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopTicking(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = this.now();
    for (const stream of [...this.streams.values()]) {
      if (!stream.rowAdded) {
        // Not reopenable: ten seconds without one keyframe is a stream that
        // cannot show anything, or one only holding a slot.
        if (now - stream.openedAtMs >= PICTURE_DEADLINE_MS) {
          this.end(stream, false);
        } else this.apply(stream, stream.assembler.onTick(now), now);
        continue;
      }
      const silent = now - stream.lastPacketMs;
      if (silent >= CLOSE_AFTER_SILENCE_MS) {
        // drain, not flush: flush ends the stream, and one closed by silence
        // must stay open to a resumed segment.
        this.apply(stream, stream.assembler.drain(), now);
        this.present(stream, stream.playout.flush());
        if (this.streams.has(stream.key)) this.close(stream, "silence");
        continue;
      }
      if (silent >= QUIET_MS) {
        if (stream.assembler.endReceived) {
          // Whatever is still missing is tail loss, not a pause.
          this.apply(stream, stream.assembler.flush(), now);
          continue;
        }
        if (!stream.quiet) {
          this.setQuiet(stream, true);
          this.apply(stream, stream.assembler.drain(), now);
        }
      } else {
        this.apply(stream, stream.assembler.onTick(now), now);
      }
      if (this.streams.has(stream.key)) {
        this.present(stream, stream.playout.take(now));
      }
    }
    if (this.streams.size === 0) this.stopTicking();
  }
}

function deleteFile(uri: string): void {
  try {
    const file = new FileSystem.File(uri);
    if (file.exists) file.delete();
  } catch {
    // Already gone; the retention sweep takes whatever a failure leaves.
  }
}
