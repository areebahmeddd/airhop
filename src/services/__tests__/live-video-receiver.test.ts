// Watching live video: the receiver against a real packetizer, with the
// native codec layer stubbed. What is checked is the row's life (live,
// reconnecting, a recording, the sender's file taking over, a cancel) and
// that nothing reaches the screen or the speaker unasked.

import NativeAirhopVideo from "@bridge/NativeAirhopVideo";
import { LIVE_VIDEO_QUALITIES } from "@core/mesh/video/live-video-quality";
import { VideoStreamPacketizer } from "@core/mesh/video/video-stream-packetizer";
import { useChatStore } from "@store/chat-store";
import { useSettingsStore } from "@store/settings-store";
import { LiveVideoReceiver, liveVideoRowID } from "../live-video-receiver";

jest.mock("@bridge/NativeAirhopVideo", () => ({
  __esModule: true,
  default: {
    decodeVideo: jest.fn(),
    releaseDecoder: jest.fn(),
    startRecording: jest.fn(() => Promise.resolve()),
    appendVideo: jest.fn(),
    appendAudio: jest.fn(),
    finishRecording: jest.fn(() =>
      Promise.resolve({ durationMs: 3_000, sizeBytes: 40_000 }),
    ),
    cancelRecording: jest.fn(),
  },
}));

jest.mock("expo-file-system", () => {
  class File {
    constructor(
      _dir: unknown,
      readonly name: string = String(_dir),
    ) {}
    get uri(): string {
      return this.name.startsWith("file://")
        ? this.name
        : `file:///cache/${this.name}`;
    }
    get exists(): boolean {
      return false;
    }
    delete(): void {}
  }
  class Directory {
    get exists(): boolean {
      return mockCache.size > 0;
    }
    list(): unknown[] {
      return [...mockCache].map((name) =>
        Object.assign(new File(name), {
          delete: () => mockDeleted.push(name),
        }),
      );
    }
  }
  return { File, Directory, Paths: { cache: {} } };
});

// What the cache directory lists, and what was deleted from it.
const mockCache = new Set<string>();
const mockDeleted: string[] = [];

const native = NativeAirhopVideo as unknown as Record<string, jest.Mock>;
const SENDER = "a1b2c3d4e5f60718";
const ROOM = "#bluetooth";

let now = 1_000_000;
let watching: string | null = null;

function setup() {
  const played: string[] = [];
  const receiver = new LiveVideoReceiver({
    resolveNickname: () => "alice",
    watchedChannel: () => watching,
    playAudio: (key) => played.push(key),
    stopAudio: () => undefined,
    now: () => now,
  });
  return { receiver, played };
}

function stream() {
  const id = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const q = LIVE_VIDEO_QUALITIES.low;
  const packetizer = new VideoStreamPacketizer(
    id,
    {
      width: q.width,
      height: q.height,
      fps: q.fps,
      bitrateKbps: 18,
      hasAudio: true,
    },
    q.fec,
  );
  return { packetizer, streamID: "0102030405060708" };
}

const row = (id: string) =>
  useChatStore.getState().messages[ROOM]?.find((m) => m.id === id);

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  watching = null;
  now = 1_000_000;
  useChatStore.getState().clearAll();
  useChatStore.getState().addChannel(ROOM);
  useSettingsStore.setState({ liveVideoEnabled: true });
});

afterEach(() => {
  jest.useRealTimers();
});

// Feeds `seconds` of 8 fps video with a keyframe every 2 s, plus audio.
function feed(
  receiver: LiveVideoReceiver,
  packetizer: VideoStreamPacketizer,
  seconds: number,
  startMs = 0,
): void {
  for (let t = startMs; t < startMs + seconds * 1000; t += 125) {
    const keyframe = t % 2000 === 0;
    const packets = [
      ...packetizer.add(
        {
          track: "video",
          ptsMs: t,
          keyframe,
          data: new Uint8Array(keyframe ? 900 : 150).fill(7),
        },
        t,
      ),
      ...packetizer.add(
        {
          track: "audio",
          ptsMs: t,
          keyframe: false,
          data: new Uint8Array(90).fill(3),
        },
        t,
      ),
      ...packetizer.tick(t),
    ];
    for (const p of packets) receiver.onPacket(SENDER, ROOM, p);
    now += 125;
    jest.advanceTimersByTime(125);
  }
}

describe("LiveVideoReceiver", () => {
  test("the first picture opens a live row, and END leaves the recording in it", async () => {
    const { receiver } = setup();
    const { packetizer, streamID } = stream();
    for (const p of packetizer.start()) receiver.onPacket(SENDER, ROOM, p);
    const id = liveVideoRowID(SENDER, streamID);
    // START alone shows nothing: a stream with no picture leaves no row.
    expect(row(id)).toBeUndefined();
    feed(receiver, packetizer, 0.5);
    expect(row(id)?.liveVideo).toMatchObject({
      streamID,
      state: "live",
      width: 144,
      height: 192,
      hasAudio: true,
    });
    feed(receiver, packetizer, 2.5, 500);
    for (const p of packetizer.finish(3_000, 3_000)) {
      receiver.onPacket(SENDER, ROOM, p);
    }
    jest.advanceTimersByTime(1_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(native.startRecording).toHaveBeenCalledTimes(1);
    expect(native.appendVideo).toHaveBeenCalled();
    expect(native.appendAudio).toHaveBeenCalled();
    expect(row(id)?.liveVideo).toBeUndefined();
    expect(row(id)?.attachment).toMatchObject({
      type: "video",
      name: `video_${streamID}.mp4`,
      durationMs: 3_000,
    });
  });

  test("nothing is decoded or heard unless the room is open and unmuted", () => {
    const { receiver, played } = setup();
    const { packetizer, streamID } = stream();
    for (const p of packetizer.start()) receiver.onPacket(SENDER, ROOM, p);
    feed(receiver, packetizer, 2);
    expect(native.decodeVideo).not.toHaveBeenCalled();

    watching = ROOM;
    feed(receiver, packetizer, 2, 2_000);
    expect(native.decodeVideo).toHaveBeenCalled();
    expect(played).toHaveLength(0);

    receiver.setAudible(liveVideoRowID(SENDER, streamID));
    feed(receiver, packetizer, 2, 4_000);
    expect(played.length).toBeGreaterThan(0);
  });

  test("a quiet stream says it is reconnecting, then picks up again", () => {
    const { receiver } = setup();
    const { packetizer, streamID } = stream();
    for (const p of packetizer.start()) receiver.onPacket(SENDER, ROOM, p);
    feed(receiver, packetizer, 1);
    now += 5_000;
    jest.advanceTimersByTime(5_000);
    const id = liveVideoRowID(SENDER, streamID);
    expect(row(id)?.liveVideo?.state).toBe("reconnecting");
    feed(receiver, packetizer, 1, 6_000);
    expect(row(id)?.liveVideo?.state).toBe("live");
  });

  test("CANCELED takes the row away and keeps no recording", () => {
    const { receiver } = setup();
    const { packetizer, streamID } = stream();
    for (const p of packetizer.start()) receiver.onPacket(SENDER, ROOM, p);
    feed(receiver, packetizer, 1);
    for (const p of packetizer.cancel()) receiver.onPacket(SENDER, ROOM, p);
    expect(row(liveVideoRowID(SENDER, streamID))).toBeUndefined();
    expect(native.cancelRecording).toHaveBeenCalled();
    // A late packet of the canceled stream opens nothing.
    for (const p of packetizer.start()) receiver.onPacket(SENDER, ROOM, p);
    expect(row(liveVideoRowID(SENDER, streamID))).toBeUndefined();
  });

  test("the sender's file takes the row over instead of showing twice", () => {
    const { receiver } = setup();
    const { packetizer, streamID } = stream();
    for (const p of packetizer.start()) receiver.onPacket(SENDER, ROOM, p);
    feed(receiver, packetizer, 1);
    const attachment = {
      type: "video" as const,
      uri: "file:///cache/airhop_in_final.mp4",
      name: `video_${streamID}.mp4`,
    };
    expect(receiver.absorbFinalFile(SENDER, ROOM, streamID, attachment)).toBe(
      true,
    );
    const id = liveVideoRowID(SENDER, streamID);
    expect(row(id)?.liveVideo).toBeUndefined();
    expect(row(id)?.attachment?.uri).toBe(attachment.uri);
    expect(native.cancelRecording).toHaveBeenCalled();
    // A file for a stream this phone never saw is an ordinary video.
    expect(
      receiver.absorbFinalFile(SENDER, ROOM, "ffffffffffffffff", attachment),
    ).toBe(false);
  });

  test("a stream resumed after its silence close gets a row, and the file folds both into one", async () => {
    const { receiver } = setup();
    const { packetizer, streamID } = stream();
    for (const p of packetizer.start()) receiver.onPacket(SENDER, ROOM, p);
    feed(receiver, packetizer, 1);
    now += 91_000;
    jest.advanceTimersByTime(1_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    feed(receiver, packetizer, 1, 92_000);
    const rows = () =>
      (useChatStore.getState().messages[ROOM] ?? []).filter((m) =>
        m.id.startsWith(liveVideoRowID(SENDER, streamID)),
      );
    expect(rows()).toHaveLength(2);
    receiver.absorbFinalFile(SENDER, ROOM, streamID, {
      type: "video",
      uri: "file:///cache/airhop_in_final.mp4",
      name: `video_${streamID}.mp4`,
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0].attachment?.uri).toBe("file:///cache/airhop_in_final.mp4");
  });

  test("a sender's next stream ends the last one, whose END went missing", async () => {
    const { receiver } = setup();
    const first = stream();
    for (const p of first.packetizer.start())
      receiver.onPacket(SENDER, ROOM, p);
    feed(receiver, first.packetizer, 1);
    const next = new VideoStreamPacketizer(
      Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]),
      { width: 144, height: 192, fps: 8, bitrateKbps: 18, hasAudio: true },
      LIVE_VIDEO_QUALITIES.low.fec,
    );
    for (const p of next.start()) receiver.onPacket(SENDER, ROOM, p);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const old = row(liveVideoRowID(SENDER, first.streamID));
    expect(old?.liveVideo).toBeUndefined();
    expect(old?.attachment?.type).toBe("video");
    // The old stream stays over: a straggler from it opens nothing.
    for (const p of first.packetizer.tick(1_000)) {
      receiver.onPacket(SENDER, ROOM, p);
    }
    expect(
      row(liveVideoRowID(SENDER, first.streamID))?.liveVideo,
    ).toBeUndefined();
  });

  test("a stream cut off by the mesh stopping picks up again when it restarts", async () => {
    const { receiver } = setup();
    const { packetizer, streamID } = stream();
    for (const p of packetizer.start()) receiver.onPacket(SENDER, ROOM, p);
    feed(receiver, packetizer, 1);
    receiver.stop();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    feed(receiver, packetizer, 1, 2_000);
    const rows = (useChatStore.getState().messages[ROOM] ?? []).filter((m) =>
      m.id.startsWith(liveVideoRowID(SENDER, streamID)),
    );
    expect(rows).toHaveLength(2);
    expect(rows.some((m) => m.liveVideo?.state === "live")).toBe(true);
  });

  test("a stream with no picture gives its slot back, and its picture still opens it", () => {
    const { receiver } = setup();
    const { packetizer, streamID } = stream();
    // A sender sending sound only: no keyframe, so no picture to show.
    for (let i = 0; i < 12; i++) {
      for (const p of packetizer.start()) receiver.onPacket(SENDER, ROOM, p);
      now += 1_000;
      jest.advanceTimersByTime(1_000);
    }
    expect(row(liveVideoRowID(SENDER, streamID))).toBeUndefined();
    expect(native.cancelRecording).toHaveBeenCalled();
    // Video returns: the stream is not shut out for having been quiet.
    feed(receiver, packetizer, 1, 12_000);
    expect(row(liveVideoRowID(SENDER, streamID))?.liveVideo?.state).toBe(
      "live",
    );
  });

  test("the tail of a stream never followed opens nothing", () => {
    const { receiver } = setup();
    const current = stream();
    for (const p of current.packetizer.start())
      receiver.onPacket(SENDER, ROOM, p);
    feed(receiver, current.packetizer, 1);
    const earlier = new VideoStreamPacketizer(
      Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]),
      { width: 144, height: 192, fps: 8, bitrateKbps: 18, hasAudio: true },
      LIVE_VIDEO_QUALITIES.low.fec,
    );
    for (const p of [...earlier.finish(3_000, 0), ...earlier.cancel()]) {
      receiver.onPacket(SENDER, ROOM, p);
    }
    expect(receiver.streamCount).toBe(1);
    expect(
      row(liveVideoRowID(SENDER, current.streamID))?.liveVideo?.state,
    ).toBe("live");
  });

  test("CANCELED takes every segment's row away", async () => {
    const { receiver } = setup();
    const { packetizer, streamID } = stream();
    for (const p of packetizer.start()) receiver.onPacket(SENDER, ROOM, p);
    feed(receiver, packetizer, 1);
    now += 91_000;
    jest.advanceTimersByTime(1_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    feed(receiver, packetizer, 1, 92_000);
    for (const p of packetizer.cancel()) receiver.onPacket(SENDER, ROOM, p);
    const rows = (useChatStore.getState().messages[ROOM] ?? []).filter((m) =>
      m.id.startsWith(liveVideoRowID(SENDER, streamID)),
    );
    expect(rows).toHaveLength(0);
  });

  test("a discard after a resumed segment was let go still takes the earlier rows", async () => {
    const { receiver } = setup();
    const { packetizer, streamID } = stream();
    for (const p of packetizer.start()) receiver.onPacket(SENDER, ROOM, p);
    feed(receiver, packetizer, 1);
    now += 91_000;
    jest.advanceTimersByTime(1_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // Back with sound only, then quiet: the new segment is let go unseen.
    for (let i = 0; i < 10; i++) {
      for (const p of packetizer.start()) receiver.onPacket(SENDER, ROOM, p);
      now += 1_000;
      jest.advanceTimersByTime(1_000);
    }
    expect(receiver.streamCount).toBe(0);
    for (const p of packetizer.cancel()) receiver.onPacket(SENDER, ROOM, p);
    const rows = (useChatStore.getState().messages[ROOM] ?? []).filter((m) =>
      m.id.startsWith(liveVideoRowID(SENDER, streamID)),
    );
    expect(rows).toHaveLength(0);
  });

  test("a discard arriving after the mesh stopped still takes the rows away", async () => {
    const { receiver } = setup();
    const { packetizer, streamID } = stream();
    for (const p of packetizer.start()) receiver.onPacket(SENDER, ROOM, p);
    feed(receiver, packetizer, 1);
    receiver.stop();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(row(liveVideoRowID(SENDER, streamID))?.attachment).toBeDefined();
    for (const p of packetizer.cancel()) receiver.onPacket(SENDER, ROOM, p);
    expect(row(liveVideoRowID(SENDER, streamID))).toBeUndefined();
    expect(receiver.streamCount).toBe(0);
    // Over for good: a straggler opens nothing.
    feed(receiver, packetizer, 1, 2_000);
    expect(row(liveVideoRowID(SENDER, streamID))).toBeUndefined();
  });

  test("the sender's file arriving before the first picture ends the stream", () => {
    const { receiver } = setup();
    const { packetizer, streamID } = stream();
    for (const p of packetizer.start()) receiver.onPacket(SENDER, ROOM, p);
    expect(
      receiver.absorbFinalFile(SENDER, ROOM, streamID, {
        type: "video",
        uri: "file:///cache/airhop_in_final.mp4",
        name: `video_${streamID}.mp4`,
      }),
    ).toBe(false);
    expect(receiver.streamCount).toBe(0);
    // Its late pictures do not add a second row beside the file's.
    feed(receiver, packetizer, 1);
    expect(row(liveVideoRowID(SENDER, streamID))).toBeUndefined();
  });

  test("decoding picks up at a keyframe after the chat was away", () => {
    const { receiver } = setup();
    const { packetizer } = stream();
    for (const p of packetizer.start()) receiver.onPacket(SENDER, ROOM, p);
    feed(receiver, packetizer, 1);
    expect(native.decodeVideo).not.toHaveBeenCalled();
    watching = ROOM;
    feed(receiver, packetizer, 2, 1_000);
    expect(native.decodeVideo).toHaveBeenCalled();
    // The first unit decoded is the keyframe at 2 s, never a delta before it.
    expect(native.decodeVideo.mock.calls[0][2]).toBe(true);
  });

  test("a stream past its byte budget is closed", () => {
    const { receiver } = setup();
    const { packetizer, streamID } = stream();
    for (const p of packetizer.start()) receiver.onPacket(SENDER, ROOM, p);
    // 400 KB in one instant, far past 96 kB/s with three seconds of burst.
    for (let i = 0; i < 1_200; i++) {
      for (const p of packetizer.add(
        {
          track: "video",
          ptsMs: i,
          keyframe: false,
          data: new Uint8Array(300).fill(1),
        },
        0,
      )) {
        receiver.onPacket(SENDER, ROOM, p);
      }
    }
    expect(native.releaseDecoder).toHaveBeenCalledWith(`${SENDER}:${streamID}`);
  });

  test("live video switched off shows nothing", () => {
    useSettingsStore.setState({ liveVideoEnabled: false });
    const { receiver } = setup();
    const { packetizer, streamID } = stream();
    for (const p of packetizer.start()) receiver.onPacket(SENDER, ROOM, p);
    expect(row(liveVideoRowID(SENDER, streamID))).toBeUndefined();
  });

  test("a row left live by a dead process is dropped at start", () => {
    useChatStore.getState().addMessage({
      id: "live-video-stale",
      channel: ROOM,
      senderID: SENDER,
      senderNickname: "alice",
      text: "",
      timestampMs: Date.now(),
      isMine: false,
      liveVideo: {
        streamID: "0102030405060708",
        state: "live",
        startedAtMs: 0,
        width: 144,
        height: 192,
        hasAudio: true,
      },
    });
    setup().receiver.dropStaleRows();
    expect(row("live-video-stale")).toBeUndefined();
  });

  test("partial recordings an earlier process left behind are deleted, and nothing else", () => {
    const earlier = Date.now() - 60_000;
    const later = Date.now() + 60_000;
    const kept = `airhop_in_${earlier}_video_0102030405060708.mp4`;
    useChatStore.getState().addMessage({
      id: "finished-recording",
      channel: ROOM,
      senderID: SENDER,
      senderNickname: "alice",
      text: "",
      timestampMs: Date.now(),
      isMine: false,
      attachment: {
        type: "video",
        uri: `file:///cache/${kept}`,
        name: "video_0102030405060708.mp4",
        mimeType: "video/mp4",
      },
    });
    const received = `airhop_in_${earlier}_video_1112131415161718.mp4`;
    const sent = `airhop_${earlier}_video_2122232425262728.mp4`;
    const thisProcess = `airhop_in_${later}_video_3132333435363738.mp4`;
    const photo = `airhop_in_${earlier}_photo.jpg`;
    for (const name of [kept, received, sent, thisProcess, photo]) {
      mockCache.add(name);
    }
    try {
      setup().receiver.dropStaleRows();
      expect(mockDeleted.sort()).toEqual([received, sent].sort());
    } finally {
      mockCache.clear();
      mockDeleted.length = 0;
    }
  });
});
