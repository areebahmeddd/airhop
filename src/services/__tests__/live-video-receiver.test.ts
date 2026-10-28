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
      return false;
    }
    list(): unknown[] {
      return [];
    }
  }
  return { File, Directory, Paths: { cache: {} } };
});

const native = NativeAirhopVideo as unknown as Record<string, jest.Mock>;
const SENDER = "a1b2c3d4e5f60718";
const ROOM = "#bluetooth";

let now = 1_000_000;

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

let watching: string | null = null;

function stream(hasAudio = true) {
  const id = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const q = LIVE_VIDEO_QUALITIES.low;
  const packetizer = new VideoStreamPacketizer(
    id,
    {
      width: q.width,
      height: q.height,
      fps: q.fps,
      bitrateKbps: 18,
      hasAudio,
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
    // A file for a stream this phone never saw is an ordinary video.
    expect(
      receiver.absorbFinalFile(SENDER, ROOM, "ffffffffffffffff", attachment),
    ).toBe(false);
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
      },
    });
    setup().receiver.dropStaleRows();
    expect(row("live-video-stale")).toBeUndefined();
  });
});
