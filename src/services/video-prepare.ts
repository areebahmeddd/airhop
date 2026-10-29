// Shrink a video before it is sent, to the budget of whoever receives it.
//
// bitchat's clips are fitted to 100 KiB (MAX_BITCHAT_VIDEO_BYTES), so anything
// a bitchat phone may receive is too: the Bluetooth room, where some listener
// may run bitchat, and a DM to anyone not known to run Airhop. Another Airhop
// phone takes the whole 1 MiB file ceiling, so a video between two Airhop
// phones keeps as much quality as the mesh can carry.
//
// A picked or recorded video is always re-encoded, however small. That is what
// strips its metadata, the location a phone camera writes above all, just as
// prepareImageForSend does for a photo, and it turns HEVC, HDR and QuickTime
// into the H.264 MP4 every receiver plays. A video note (our own recorder, H.264
// with no location) or a forward is re-encoded only when it does not fit.
//
// The plan is core/mesh/video/transcode-plan; native runs one pass of it at a
// time and decides nothing. A pass that misses the budget gets one retry at a
// bitrate scaled by the overshoot, as bitchat-ios does, and a second miss is
// reported rather than looped.
//
// Nothing a pass writes outlives it unless it succeeds: cancel, a panic wipe
// and, on iOS, a trip to the background all stop the pass, and native deletes
// the partial file before it answers. iOS denies a backgrounded app the GPU the
// video composition renders on, so a pass there could only fail; Android keeps
// encoding, as the user would expect of a send they already tapped.

import NativeAirhopVideo from "@bridge/NativeAirhopVideo";
import {
  initialTranscodeBits,
  MAX_TRANSCODE_ATTEMPTS,
  planTranscode,
  retryTranscodeBits,
  type TranscodeRange,
  type TranscodeSource,
} from "@core/mesh/video/transcode-plan";
import {
  isVideoNoteName,
  MAX_BITCHAT_VIDEO_BYTES,
  MAX_FILE_BYTES,
  resolveMimeType,
  videoClipName,
  videoNoteName,
} from "@core/mesh/wire/file-packet";
import { useVideoPrepStore } from "@store/video-prep-store";
import * as FileSystem from "expo-file-system";
import {
  AppState,
  NativeEventEmitter,
  Platform,
  type EventSubscription,
  type NativeEventSubscription,
} from "react-native";
import { adoptIntoAttachmentCache } from "./file-transfer-service";
import {
  currentWipeGeneration,
  isCurrentWipeGeneration,
} from "./wipe-generation";

const EVT_PROGRESS = "AirhopVideo.transcodeProgress";
const WORK_DIRECTORY = "video-prep";
const MP4 = "video/mp4";

// Where the video came from, which decides whether one that already fits is
// re-encoded anyway.
export type VideoOrigin = "picked" | "note" | "forward";

export interface VideoToSend {
  uri: string;
  // The thread it is going to, where its progress shows.
  channel: string;
  origin: VideoOrigin;
  // A DM to a peer known to run Airhop. Anything else may reach bitchat.
  toAirhop: boolean;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  // The part chosen in the trimmer; without one, the first minute.
  trim?: TranscodeRange;
}

export type VideoPrepFailure =
  // Stopped from its progress card, or by a panic wipe.
  | "cancelled"
  // Stopped because the app went to the background (iOS).
  | "interrupted"
  // Still over budget after the retry.
  | "too_large"
  // Not a video this phone can open.
  | "unreadable"
  | "failed";

export type PreparedVideo =
  | {
      ok: true;
      uri: string;
      name: string | undefined;
      mimeType: string | undefined;
      sizeBytes: number | undefined;
      durationMs: number | undefined;
    }
  | { ok: false; reason: VideoPrepFailure };

interface Job {
  id: string;
  stopped: VideoPrepFailure | null;
  // The pass native is running for this job, if any.
  passKey: string | null;
}

// Whether this build can shrink a video at all. Without the native module a
// video goes as it is, under the 1 MiB check at pick time and in sendBytes.
export function canTranscodeVideo(): boolean {
  return NativeAirhopVideo !== null && NativeAirhopVideo !== undefined;
}

function videoBudgetBytes(toAirhop: boolean): number {
  return toAirhop ? MAX_FILE_BYTES : MAX_BITCHAT_VIDEO_BYTES;
}

export function needsTranscode(video: VideoToSend): boolean {
  if (video.origin === "picked") return true;
  const budget = videoBudgetBytes(video.toAirhop);
  const size = video.sizeBytes ?? fileSize(video.uri);
  if (size === undefined || size > budget) return true;
  // bitchat opens only an MP4 as a video; anything else is an unopenable file.
  return !video.toAirhop && resolveMimeType(video.mimeType, video.name) !== MP4;
}

const jobs = new Map<string, Job>();
// Passes run one at a time: two 4K decodes at once would compete for the same
// hardware decoder and memory, and finish no sooner.
let queue: Promise<unknown> = Promise.resolve();
let jobSeq = 0;
let frameSeq = 0;
let progressSub: EventSubscription | null = null;
let appStateSub: NativeEventSubscription | null = null;

// Ready to send: the same video when nothing needs doing, or a shrunk copy in
// the attachment cache. The caller owns the source either way, and should
// discard a picker's copy once this settles.
export async function prepareVideoForSend(
  video: VideoToSend,
): Promise<PreparedVideo> {
  if (!canTranscodeVideo() || !needsTranscode(video)) {
    return {
      ok: true,
      uri: video.uri,
      name: video.name,
      mimeType: video.mimeType,
      sizeBytes: video.sizeBytes,
      durationMs: undefined,
    };
  }
  jobSeq += 1;
  const job: Job = {
    id: `prep-${String(jobSeq)}`,
    stopped: null,
    passKey: null,
  };
  jobs.set(job.id, job);
  useVideoPrepStore.getState().add(job.id, video.channel);
  watchLifecycle();
  const run = queue.then(() => transcode(job, video));
  queue = run.catch(() => undefined);
  try {
    return await run;
  } catch {
    return { ok: false, reason: job.stopped ?? failureReason() };
  } finally {
    jobs.delete(job.id);
    useVideoPrepStore.getState().remove(job.id);
    if (jobs.size === 0) unwatchLifecycle();
  }
}

export function cancelVideoPreparation(id: string): void {
  stop(id, "cancelled");
}

// For the panic wipe: stop everything, and settle once no pass can write
// another byte.
export async function cancelAllVideoPreparation(): Promise<void> {
  for (const id of [...jobs.keys()]) stop(id, "cancelled");
  await queue;
}

// Stills for the trimmer's filmstrip, `count` of them spread evenly along the
// video, each an empty string where the phone could not grab one. Written to
// the shrink's own folder, so a launch or a wipe takes any the caller leaves;
// `discard` is for the caller to free them sooner.
export async function filmstripFrames(
  uri: string,
  durationMs: number,
  count: number,
  maxEdge: number,
): Promise<{ frames: string[]; discard: () => void }> {
  const native = NativeAirhopVideo;
  if (native === null || native === undefined || count <= 0) {
    return { frames: [], discard: () => undefined };
  }
  frameSeq += 1;
  const dir = new FileSystem.Directory(
    workDirectory(),
    `frames-${String(frameSeq)}`,
  );
  const discardAll = (): void => {
    try {
      if (dir.exists) dir.delete();
    } catch {
      // Already gone.
    }
  };
  try {
    dir.create({ intermediates: true, idempotent: true });
    const files = Array.from(
      { length: count },
      (_, i) => new FileSystem.File(dir, `${String(i)}.jpg`),
    );
    const timesMs = files.map((_, i) => ((i + 0.5) * durationMs) / count);
    await native.extractFrames(
      uri,
      timesMs,
      maxEdge,
      files.map((f) => f.uri),
    );
    return {
      frames: files.map((f) => (f.exists ? f.uri : "")),
      discard: discardAll,
    };
  } catch {
    discardAll();
    return { frames: [], discard: () => undefined };
  }
}

// Passes left mid-write by a process that died. Only while none runs here,
// since a remounted app keeps this module's jobs alive.
export function discardStaleVideoWork(): void {
  if (jobs.size > 0) return;
  try {
    const dir = workDirectory();
    if (dir.exists) dir.delete();
  } catch {
    // Unreadable cache. The panic wipe and the OS take whatever is left.
  }
}

async function transcode(job: Job, video: VideoToSend): Promise<PreparedVideo> {
  const native = NativeAirhopVideo;
  if (native === null || native === undefined) {
    return { ok: false, reason: "failed" };
  }
  if (job.stopped !== null) return { ok: false, reason: job.stopped };
  useVideoPrepStore.getState().start(job.id);
  const generation = currentWipeGeneration();
  const budget = videoBudgetBytes(video.toAirhop);

  let source: TranscodeSource;
  try {
    source = await native.probeVideo(video.uri);
  } catch {
    return { ok: false, reason: job.stopped ?? failureReason("unreadable") };
  }

  let bits = initialTranscodeBits(budget);
  for (let attempt = 1; attempt <= MAX_TRANSCODE_ATTEMPTS; attempt++) {
    if (job.stopped !== null) return { ok: false, reason: job.stopped };
    const output = workFile(job.id, attempt);
    job.passKey = `${job.id}:${String(attempt)}`;
    useVideoPrepStore.getState().start(job.id);
    const result = await native.transcodeVideo(
      job.passKey,
      video.uri,
      output.uri,
      planTranscode(source, bits, budget, video.trim),
    );
    job.passKey = null;
    // A file finished after a wipe began would be the one thing to survive it.
    if (job.stopped !== null || !isCurrentWipeGeneration(generation)) {
      discard(output);
      return { ok: false, reason: job.stopped ?? "cancelled" };
    }
    if (result.sizeBytes <= budget) {
      const name = isVideoNoteName(video.name)
        ? videoNoteName()
        : videoClipName();
      return {
        ok: true,
        uri: await adoptIntoAttachmentCache(output.uri, name),
        name,
        mimeType: MP4,
        sizeBytes: result.sizeBytes,
        durationMs: result.durationMs,
      };
    }
    discard(output);
    bits = retryTranscodeBits(bits, budget, result.sizeBytes);
  }
  return { ok: false, reason: "too_large" };
}

// A pass iOS failed because the app had just left the foreground can answer
// before the AppState edge that would have stopped it does.
function failureReason(
  otherwise: VideoPrepFailure = "failed",
): VideoPrepFailure {
  const backgrounded =
    Platform.OS === "ios" && AppState.currentState === "background";
  return backgrounded ? "interrupted" : otherwise;
}

function stop(id: string, reason: VideoPrepFailure): void {
  const job = jobs.get(id);
  if (job === undefined || job.stopped !== null) return;
  job.stopped = reason;
  if (job.passKey !== null) NativeAirhopVideo?.cancelTranscode(job.passKey);
}

// Progress events and the background edge matter only while a job exists.
function watchLifecycle(): void {
  const native = NativeAirhopVideo;
  if (progressSub === null && native !== null && native !== undefined) {
    const emitter = new NativeEventEmitter(
      native as unknown as ConstructorParameters<typeof NativeEventEmitter>[0],
    );
    progressSub = emitter.addListener(
      EVT_PROGRESS,
      (e: { jobKey?: string; fraction?: number }) => {
        if (typeof e.jobKey !== "string" || typeof e.fraction !== "number") {
          return;
        }
        const job = [...jobs.values()].find((j) => j.passKey === e.jobKey);
        if (job !== undefined) {
          useVideoPrepStore.getState().progress(job.id, e.fraction);
        }
      },
    );
  }
  if (Platform.OS === "ios") {
    appStateSub ??= AppState.addEventListener("change", (state) => {
      if (state !== "background") return;
      for (const id of [...jobs.keys()]) stop(id, "interrupted");
    });
  }
}

function unwatchLifecycle(): void {
  progressSub?.remove();
  progressSub = null;
  appStateSub?.remove();
  appStateSub = null;
}

function workDirectory(): FileSystem.Directory {
  return new FileSystem.Directory(FileSystem.Paths.cache, WORK_DIRECTORY);
}

function workFile(jobId: string, attempt: number): FileSystem.File {
  const dir = workDirectory();
  dir.create({ intermediates: true, idempotent: true });
  return new FileSystem.File(dir, `${jobId}-${String(attempt)}.mp4`);
}

function discard(file: FileSystem.File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // Already gone.
  }
}

function fileSize(uri: string): number | undefined {
  try {
    const file = new FileSystem.File(uri);
    return file.exists ? file.size : undefined;
  } catch {
    return undefined;
  }
}
