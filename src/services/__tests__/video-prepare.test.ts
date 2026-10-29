// Shrinking a video before it is sent, with the native transcoder stubbed: who
// gets which budget, the retry, the names, and every way a pass can stop.

import NativeAirhopVideo from "@bridge/NativeAirhopVideo";
import {
  initialTranscodeBits,
  planTranscode,
  retryTranscodeBits,
} from "@core/mesh/video/transcode-plan";
import {
  isVideoNoteName,
  MAX_BITCHAT_VIDEO_BYTES,
  MAX_FILE_BYTES,
} from "@core/mesh/wire/file-packet";
import { useVideoPrepStore } from "@store/video-prep-store";
import { AppState, DeviceEventEmitter, Platform } from "react-native";
import { adoptIntoAttachmentCache } from "../file-transfer-service";
import {
  cancelAllVideoPreparation,
  cancelVideoPreparation,
  discardStaleVideoWork,
  filmstripFrames,
  needsTranscode,
  prepareVideoForSend,
  type VideoToSend,
} from "../video-prepare";
import { bumpWipeGeneration } from "../wipe-generation";

jest.mock("@bridge/NativeAirhopVideo", () => ({
  __esModule: true,
  default: {
    probeVideo: jest.fn(),
    transcodeVideo: jest.fn(),
    extractFrames: jest.fn(),
    cancelTranscode: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
}));

jest.mock("../file-transfer-service", () => ({
  adoptIntoAttachmentCache: jest.fn((_uri: string, name: string) =>
    Promise.resolve(`file:///cache/airhop_${name}`),
  ),
}));

const mockFiles = new Map<string, number>();
const mockDeleted: string[] = [];

jest.mock("expo-file-system", () => {
  class File {
    readonly uri: string;
    constructor(dirOrUri: { uri: string } | string, name?: string) {
      this.uri =
        typeof dirOrUri === "string" ? dirOrUri : `${dirOrUri.uri}/${name}`;
    }
    get exists(): boolean {
      return mockFiles.has(this.uri);
    }
    get size(): number {
      return mockFiles.get(this.uri) ?? 0;
    }
    delete(): void {
      mockFiles.delete(this.uri);
      mockDeleted.push(this.uri);
    }
  }
  class Directory {
    readonly uri: string;
    constructor(_parent: unknown, name: string) {
      this.uri = `file:///cache/${name}`;
    }
    get exists(): boolean {
      return [...mockFiles.keys()].some((k) => k.startsWith(this.uri));
    }
    create(): void {}
    delete(): void {
      for (const k of [...mockFiles.keys()])
        if (k.startsWith(this.uri)) mockFiles.delete(k);
      mockDeleted.push(this.uri);
    }
  }
  return { File, Directory, Paths: { cache: { uri: "file:///cache" } } };
});

const native = NativeAirhopVideo as unknown as {
  extractFrames: jest.Mock;
  probeVideo: jest.Mock;
  transcodeVideo: jest.Mock;
  cancelTranscode: jest.Mock;
};

const PROBE = { durationMs: 10_000, width: 1080, height: 1920, hasAudio: true };

function video(over: Partial<VideoToSend> = {}): VideoToSend {
  return {
    uri: "file:///cache/airhop_picked.mov",
    channel: "#bluetooth",
    origin: "picked",
    toAirhop: false,
    name: "IMG_0001.MOV",
    mimeType: "video/quicktime",
    sizeBytes: 40_000_000,
    ...over,
  };
}

// Each pass "writes" its output and answers with the given size.
function passSizes(...sizes: number[]): void {
  for (const size of sizes) {
    native.transcodeVideo.mockImplementationOnce(
      (_key: string, _source: string, output: string) => {
        mockFiles.set(output, size);
        return Promise.resolve({ sizeBytes: size, durationMs: 10_000 });
      },
    );
  }
}

// A pass that runs until cancelled, then rejects as native does.
function hangingPass(): { started: Promise<string> } {
  let markStarted: (key: string) => void = () => undefined;
  const started = new Promise<string>((resolve) => (markStarted = resolve));
  native.transcodeVideo.mockImplementationOnce(
    (key: string) =>
      new Promise((_resolve, reject) => {
        markStarted(key);
        native.cancelTranscode.mockImplementationOnce((cancelled: string) => {
          if (cancelled === key) {
            reject(
              Object.assign(new Error("cancelled"), { code: "CANCELLED" }),
            );
          }
        });
      }),
  );
  return { started };
}

let appStateHandler: ((state: string) => void) | null = null;
// The jest preset stubs currentState with a function, so the tests set it here.
let appStateNow = "active";

beforeAll(() => {
  Object.defineProperty(AppState, "currentState", {
    configurable: true,
    get: () => appStateNow,
  });
});

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  appStateNow = "active";
  native.probeVideo.mockReset();
  native.transcodeVideo.mockReset();
  native.cancelTranscode.mockReset();
  native.extractFrames.mockReset();
  mockFiles.clear();
  mockDeleted.length = 0;
  native.probeVideo.mockResolvedValue(PROBE);
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_type, handler) => {
      appStateHandler = handler as (state: string) => void;
      return { remove: jest.fn() } as never;
    });
});

describe("needsTranscode", () => {
  test("a picked video always is, to strip its metadata", () => {
    expect(needsTranscode(video({ sizeBytes: 10 }))).toBe(true);
    expect(needsTranscode(video({ sizeBytes: 10, toAirhop: true }))).toBe(true);
  });

  test("a note or a forward only when it does not fit", () => {
    const note = video({
      origin: "note",
      mimeType: "video/mp4",
      name: "note_x.mp4",
    });
    expect(
      needsTranscode({ ...note, sizeBytes: MAX_BITCHAT_VIDEO_BYTES }),
    ).toBe(false);
    expect(
      needsTranscode({ ...note, sizeBytes: MAX_BITCHAT_VIDEO_BYTES + 1 }),
    ).toBe(true);
    expect(
      needsTranscode({ ...note, sizeBytes: 700_000, toAirhop: true }),
    ).toBe(false);
  });

  test("bitchat gets an MP4 or nothing", () => {
    const forward = video({ origin: "forward", sizeBytes: 50_000 });
    expect(needsTranscode(forward)).toBe(true);
    expect(needsTranscode({ ...forward, toAirhop: true })).toBe(false);
  });

  test("an unknown size is measured", () => {
    mockFiles.set("file:///cache/airhop_note.mp4", 2_000_000);
    expect(
      needsTranscode(
        video({
          origin: "note",
          uri: "file:///cache/airhop_note.mp4",
          mimeType: "video/mp4",
          sizeBytes: undefined,
          toAirhop: true,
        }),
      ),
    ).toBe(true);
  });
});

describe("prepareVideoForSend", () => {
  test("a video that already fits goes as it is", async () => {
    const note = video({
      origin: "note",
      mimeType: "video/mp4",
      name: "note_x.mp4",
      sizeBytes: 700_000,
      toAirhop: true,
    });

    const ready = await prepareVideoForSend(note);

    expect(ready).toEqual({
      ok: true,
      uri: note.uri,
      name: note.name,
      mimeType: "video/mp4",
      sizeBytes: 700_000,
      durationMs: undefined,
    });
    expect(native.transcodeVideo).not.toHaveBeenCalled();
  });

  test("a bitchat-reachable video is planned to 100 KiB and renamed", async () => {
    passSizes(90_000);

    const ready = await prepareVideoForSend(video());

    expect(native.transcodeVideo).toHaveBeenCalledTimes(1);
    expect(native.transcodeVideo.mock.calls[0][3]).toEqual(
      planTranscode(
        PROBE,
        initialTranscodeBits(MAX_BITCHAT_VIDEO_BYTES),
        MAX_BITCHAT_VIDEO_BYTES,
      ),
    );
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    expect(ready.name).toMatch(/^clip_[0-9a-f-]{36}\.mp4$/);
    expect(ready.mimeType).toBe("video/mp4");
    expect(ready.sizeBytes).toBe(90_000);
    expect(adoptIntoAttachmentCache).toHaveBeenCalledWith(
      native.transcodeVideo.mock.calls[0][2],
      ready.name,
    );
  });

  test("a trimmed video is planned from the part chosen", async () => {
    passSizes(90_000);
    const trim = { startMs: 120_000, endMs: 150_000 };

    await prepareVideoForSend(video({ trim }));

    expect(native.transcodeVideo.mock.calls[0][3]).toEqual(
      planTranscode(
        PROBE,
        initialTranscodeBits(MAX_BITCHAT_VIDEO_BYTES),
        MAX_BITCHAT_VIDEO_BYTES,
        trim,
      ),
    );
  });

  test("another Airhop phone gets the whole file ceiling", async () => {
    passSizes(600_000);

    const ready = await prepareVideoForSend(video({ toAirhop: true }));

    expect(ready.ok).toBe(true);
    expect(native.transcodeVideo.mock.calls[0][3]).toEqual(
      planTranscode(
        PROBE,
        initialTranscodeBits(MAX_FILE_BYTES),
        MAX_FILE_BYTES,
      ),
    );
  });

  test("a note keeps its round shape", async () => {
    passSizes(80_000);

    const ready = await prepareVideoForSend(
      video({
        origin: "note",
        name: "note_00000000-0000-4000-8000-000000000000.mp4",
        mimeType: "video/mp4",
        sizeBytes: 700_000,
      }),
    );

    expect(ready.ok && isVideoNoteName(ready.name)).toBe(true);
  });

  test("an overshoot is retried once, smaller", async () => {
    passSizes(130_000, 95_000);

    const ready = await prepareVideoForSend(video());

    expect(ready.ok).toBe(true);
    expect(native.transcodeVideo).toHaveBeenCalledTimes(2);
    const first = initialTranscodeBits(MAX_BITCHAT_VIDEO_BYTES);
    expect(native.transcodeVideo.mock.calls[1][3]).toEqual(
      planTranscode(
        PROBE,
        retryTranscodeBits(first, MAX_BITCHAT_VIDEO_BYTES, 130_000),
        MAX_BITCHAT_VIDEO_BYTES,
      ),
    );
    expect(mockDeleted).toContain(native.transcodeVideo.mock.calls[0][2]);
  });

  test("a second miss is reported, not looped, and leaves nothing", async () => {
    passSizes(130_000, 120_000);

    const ready = await prepareVideoForSend(video());

    expect(ready).toEqual({ ok: false, reason: "too_large" });
    expect(native.transcodeVideo).toHaveBeenCalledTimes(2);
    expect([...mockFiles.keys()]).toEqual([]);
    expect(adoptIntoAttachmentCache).not.toHaveBeenCalled();
  });

  test("a file the phone cannot open", async () => {
    native.probeVideo.mockRejectedValueOnce(new Error("UNREADABLE"));

    expect(await prepareVideoForSend(video())).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  test("a pass that fails", async () => {
    native.transcodeVideo.mockRejectedValueOnce(new Error("TRANSCODE_FAILED"));

    expect(await prepareVideoForSend(video())).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(useVideoPrepStore.getState().preps).toEqual({});
  });

  test("progress reaches the thread's card, and the card goes when done", async () => {
    const pass = hangingPass();
    const result = prepareVideoForSend(video({ channel: "dm:abc" }));
    const key = await pass.started;

    DeviceEventEmitter.emit("AirhopVideo.transcodeProgress", {
      jobKey: key,
      fraction: 0.4,
    });

    const [prep] = Object.values(useVideoPrepStore.getState().preps);
    expect(prep).toMatchObject({
      channel: "dm:abc",
      status: "active",
      fraction: 0.4,
    });
    cancelVideoPreparation(prep.id);
    expect(await result).toEqual({ ok: false, reason: "cancelled" });
    expect(native.cancelTranscode).toHaveBeenCalledWith(key);
    expect(useVideoPrepStore.getState().preps).toEqual({});
  });

  test("on iOS, going to the background stops every pass", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const pass = hangingPass();
    const result = prepareVideoForSend(video());
    await pass.started;

    appStateHandler?.("inactive");
    expect(native.cancelTranscode).not.toHaveBeenCalled();
    appStateHandler?.("background");

    expect(await result).toEqual({ ok: false, reason: "interrupted" });
  });

  test("on iOS, a pass that fails as the app leaves reads as interrupted", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    appStateNow = "background";
    native.transcodeVideo.mockRejectedValueOnce(new Error("TRANSCODE_FAILED"));

    expect(await prepareVideoForSend(video())).toEqual({
      ok: false,
      reason: "interrupted",
    });
  });

  test("on Android, a shrink carries on in the background", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    passSizes(90_000);

    const ready = await prepareVideoForSend(video());

    expect(AppState.addEventListener).not.toHaveBeenCalled();
    expect(ready.ok).toBe(true);
  });

  test("videos are shrunk one at a time, the rest wait", async () => {
    const pass = hangingPass();
    const first = prepareVideoForSend(video());
    await pass.started;
    passSizes(90_000);
    const second = prepareVideoForSend(video());
    await Promise.resolve();

    const statuses = Object.values(useVideoPrepStore.getState().preps).map(
      (p) => p.status,
    );
    expect(statuses).toEqual(["active", "waiting"]);
    expect(native.transcodeVideo).toHaveBeenCalledTimes(1);

    const [firstPrep] = Object.values(useVideoPrepStore.getState().preps);
    cancelVideoPreparation(firstPrep.id);
    await first;
    expect((await second).ok).toBe(true);
  });

  test("a waiting video cancelled never starts", async () => {
    const pass = hangingPass();
    const first = prepareVideoForSend(video());
    await pass.started;
    const second = prepareVideoForSend(video());
    const [, waiting] = Object.values(useVideoPrepStore.getState().preps);

    cancelVideoPreparation(waiting.id);
    await cancelAllVideoPreparation();

    expect(await second).toEqual({ ok: false, reason: "cancelled" });
    expect(await first).toEqual({ ok: false, reason: "cancelled" });
    expect(native.transcodeVideo).toHaveBeenCalledTimes(1);
  });

  test("the panic wipe stops the pass and settles once it has", async () => {
    const pass = hangingPass();
    const result = prepareVideoForSend(video());
    await pass.started;

    await cancelAllVideoPreparation();

    expect(await result).toEqual({ ok: false, reason: "cancelled" });
  });

  test("a file finished after a wipe began is not kept", async () => {
    native.transcodeVideo.mockImplementationOnce(
      (_key: string, _source: string, output: string) => {
        mockFiles.set(output, 90_000);
        bumpWipeGeneration();
        return Promise.resolve({ sizeBytes: 90_000, durationMs: 10_000 });
      },
    );

    expect(await prepareVideoForSend(video())).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect([...mockFiles.keys()]).toEqual([]);
    expect(adoptIntoAttachmentCache).not.toHaveBeenCalled();
  });
});

describe("filmstripFrames", () => {
  test("spreads the stills evenly, leaving a gap where one failed", async () => {
    native.extractFrames.mockImplementationOnce(
      (_source: string, _times: number[], _edge: number, outputs: string[]) => {
        mockFiles.set(outputs[0], 2_000);
        mockFiles.set(outputs[2], 2_000);
        return Promise.resolve();
      },
    );

    const strip = await filmstripFrames("file:///v.mp4", 40_000, 4, 96);

    expect(native.extractFrames.mock.calls[0][1]).toEqual([
      5_000, 15_000, 25_000, 35_000,
    ]);
    expect(strip.frames.map((f) => f !== "")).toEqual([
      true,
      false,
      true,
      false,
    ]);
    strip.discard();
    expect([...mockFiles.keys()]).toEqual([]);
  });

  test("a phone that cannot grab stills gets an empty strip", async () => {
    native.extractFrames.mockRejectedValueOnce(new Error("BAD_PATH"));

    const strip = await filmstripFrames("file:///v.mp4", 40_000, 4, 96);

    expect(strip.frames).toEqual([]);
  });
});

describe("discardStaleVideoWork", () => {
  test("clears what a dead process left, never a running pass", async () => {
    mockFiles.set("file:///cache/video-prep/prep-9-1.mp4", 5_000);
    discardStaleVideoWork();
    expect(mockFiles.size).toBe(0);

    const pass = hangingPass();
    const result = prepareVideoForSend(video());
    await pass.started;
    mockFiles.set("file:///cache/video-prep/live.mp4", 1);
    discardStaleVideoWork();
    expect(mockFiles.has("file:///cache/video-prep/live.mp4")).toBe(true);

    await cancelAllVideoPreparation();
    await result;
  });
});
