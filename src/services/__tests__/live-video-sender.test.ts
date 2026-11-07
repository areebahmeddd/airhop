// Going live, with the native camera stubbed: what reaches the wire and the
// recording when a stream starts, ends, is cut short, or meets a full radio.

import NativeAirhopVideo from "@bridge/NativeAirhopVideo";
import { bytesToBase64 } from "@core/encoding/base64";
import {
  BLE_PACKET_BUDGET,
  LIVE_VIDEO_QUALITIES,
} from "@core/mesh/video/live-video-quality";
import { decodeVideoBurstPacket } from "@core/mesh/video/video-burst-packet";
import { DeviceEventEmitter } from "react-native";
import { LiveVideoSendSession } from "../live-video-sender";
import type { NativeAudioCapture } from "../voice-audio-backend";

jest.mock("@bridge/NativeAirhopVideo", () => ({
  __esModule: true,
  default: {
    startRecording: jest.fn(() => Promise.resolve()),
    appendVideo: jest.fn(),
    appendAudio: jest.fn(),
    finishRecording: jest.fn(() =>
      Promise.resolve({ durationMs: 3_000, sizeBytes: 60_000 }),
    ),
    cancelRecording: jest.fn(),
    startEncoding: jest.fn(() => Promise.resolve()),
    stopEncoding: jest.fn(() => Promise.resolve()),
    setBitrate: jest.fn(),
    requestKeyframe: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
}));

jest.mock("expo-file-system", () => {
  class File {
    readonly uri: string;
    constructor(_dir: unknown, name: string) {
      this.uri = `file:///cache/${name}`;
    }
    get exists(): boolean {
      return false;
    }
    delete(): void {}
  }
  return { File, Paths: { cache: {} } };
});

const native = NativeAirhopVideo as unknown as Record<string, jest.Mock>;
let now = 0;

// A keyframe-sized unit, as the camera's encoder would emit it.
function encoded(ptsMs: number, keyframe: boolean): void {
  DeviceEventEmitter.emit("AirhopVideo.encoded", {
    dataBase64: bytesToBase64(new Uint8Array(keyframe ? 600 : 120).fill(5)),
    ptsMs,
    keyframe,
  });
}

function session() {
  const sent: Uint8Array[] = [];
  const s = new LiveVideoSendSession(LIVE_VIDEO_QUALITIES.low, {
    send: (p) => sent.push(p),
    audio: null,
    onFailure: () => undefined,
    packetBudget: BLE_PACKET_BUDGET,
    now: () => now,
  });
  return { s, sent };
}

const kinds = (sent: Uint8Array[]) =>
  sent.map((p) => decodeVideoBurstPacket(p)?.kind);

async function advance(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 20) {
    now += 20;
    jest.advanceTimersByTime(20);
    await Promise.resolve();
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  now = 1_000;
});

afterEach(() => {
  jest.useRealTimers();
});

describe("LiveVideoSendSession", () => {
  test("a stream opens with START, carries what the camera encodes, and ends with END", async () => {
    const { s, sent } = session();
    await s.start();
    for (let t = 0; t < 3_000; t += 125) {
      encoded(t, t % 2_000 === 0);
      await advance(125);
    }
    const stopping = s.stop(false);
    await advance(500);
    const finished = await stopping;

    const seen = kinds(sent);
    expect(seen[0]).toBe("start");
    expect(seen).toContain("data");
    expect(seen.filter((k) => k === "end")).toHaveLength(3);
    expect(native.appendVideo).toHaveBeenCalledTimes(24);
    expect(finished).toMatchObject({ fitsAsFile: true, durationMs: 3_000 });
  });

  test("the encoder's last units, flushed on stop, still reach the stream and the file", async () => {
    const { s, sent } = session();
    await s.start();
    encoded(0, true);
    await advance(1_500);
    native.stopEncoding.mockImplementationOnce(() => {
      encoded(1_500, false);
      return Promise.resolve();
    });
    const stopping = s.stop(false);
    await advance(500);
    await stopping;
    expect(native.appendVideo).toHaveBeenCalledTimes(2);
    const units = sent
      .map((p) => decodeVideoBurstPacket(p))
      .filter((p) => p?.kind === "data");
    expect(units.length).toBeGreaterThanOrEqual(2);
  });

  test("a stream ended inside a second is canceled and leaves no recording", async () => {
    const { s, sent } = session();
    await s.start();
    encoded(0, true);
    await advance(400);
    const stopping = s.stop(false);
    await advance(200);
    expect(await stopping).toBeNull();
    expect(kinds(sent)).toContain("canceled");
    expect(kinds(sent)).not.toContain("end");
    expect(native.cancelRecording).toHaveBeenCalled();
    expect(native.finishRecording).not.toHaveBeenCalled();
  });

  test("every caller of stop gets the one recording", async () => {
    const { s } = session();
    await s.start();
    encoded(0, true);
    await advance(1_500);
    const first = s.stop(false);
    const second = s.stop(true);
    await advance(500);
    const [a, b] = await Promise.all([first, second]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(native.finishRecording).toHaveBeenCalledTimes(1);
  });

  test("a stop while the recording is still opening puts nothing on air", async () => {
    let open: () => void = () => undefined;
    native.startRecording.mockImplementationOnce(
      () => new Promise<void>((resolve) => (open = resolve)),
    );
    const { s, sent } = session();
    const starting = s.start();
    expect(await s.stop(false)).toBeNull();
    open();
    await starting;
    await advance(200);
    expect(sent).toHaveLength(0);
    expect(native.startEncoding).not.toHaveBeenCalled();
    expect(native.cancelRecording).toHaveBeenCalled();
  });

  test("a stop while the encoder is starting never opens the microphone", async () => {
    let encoding: () => void = () => undefined;
    native.startEncoding.mockImplementationOnce(
      () => new Promise<void>((resolve) => (encoding = resolve)),
    );
    const audio = {
      startCapture: jest.fn(() => Promise.resolve()),
      stopCapture: jest.fn(() => Promise.resolve()),
    };
    const s = new LiveVideoSendSession(LIVE_VIDEO_QUALITIES.low, {
      send: () => undefined,
      audio: audio as unknown as NativeAudioCapture,
      onFailure: () => undefined,
      packetBudget: BLE_PACKET_BUDGET,
      now: () => now,
    });
    const starting = s.start();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const stopping = s.stop(false);
    encoding();
    await starting;
    await advance(200);
    await stopping;
    expect(audio.startCapture).not.toHaveBeenCalled();
  });

  test("a microphone that will not open leaves a silent stream that says so", async () => {
    const audio = {
      startCapture: jest.fn(() => Promise.reject(new Error("mic taken"))),
      stopCapture: jest.fn(() => Promise.resolve()),
    };
    const sent: Uint8Array[] = [];
    const s = new LiveVideoSendSession(LIVE_VIDEO_QUALITIES.low, {
      send: (p) => sent.push(p),
      audio: audio as unknown as NativeAudioCapture,
      onFailure: () => undefined,
      packetBudget: BLE_PACKET_BUDGET,
      now: () => now,
    });
    expect(s.summary().withSound).toBe(true);
    await s.start();
    expect(s.isRunning).toBe(true);
    expect(s.summary().withSound).toBe(false);
    // Viewers were told there is sound before the microphone failed. The
    // keyframe asked for brings a START that tells them otherwise.
    expect(native.requestKeyframe).toHaveBeenCalled();
    encoded(0, true);
    await advance(200);
    const starts = sent
      .map((p) => decodeVideoBurstPacket(p))
      .filter((p) => p?.kind === "start")
      .map((p) => (p?.kind === "start" ? p.config.hasAudio : null));
    expect(starts[0]).toBe(true);
    expect(starts[starts.length - 1]).toBe(false);
    const stopping = s.stop(true);
    await advance(200);
    await stopping;
  });

  test("a radio refusing writes backs the encoder off", async () => {
    const { s } = session();
    await s.start();
    for (let t = 0; t < 4_000; t += 125) {
      encoded(t, t % 2_000 === 0);
      s.noteWrites({ sent: 0, refused: 3, skipped: 0, queued: 0 });
      await advance(125);
    }
    const rates = native.setBitrate.mock.calls.map(([b]) => b as number);
    expect(Math.min(...rates)).toBeLessThan(
      LIVE_VIDEO_QUALITIES.low.videoBitrate,
    );
    const stopping = s.stop(true);
    await advance(200);
    await stopping;
  });

  // Once writes queue in native, refusals all but stop; the depth the queues
  // report is the signal.
  test("a deep radio queue drops video until it drains", async () => {
    const { s } = session();
    await s.start();
    for (let t = 0; t < 1_000; t += 125) {
      encoded(t, t === 0);
      // Past 1.5 s of Bluetooth's 24 packets a second.
      s.noteWrites({ sent: 3, refused: 0, skipped: 0, queued: 40 });
      await advance(125);
    }
    expect(s.stats().skipping).toBe(true);
    const rates = native.setBitrate.mock.calls.map(([b]) => b as number);
    expect(Math.min(...rates)).toBeLessThan(
      LIVE_VIDEO_QUALITIES.low.videoBitrate,
    );
    const stopping = s.stop(true);
    await advance(200);
    await stopping;
  });

  test("one refusing neighbor of three backs off without dropping video", async () => {
    const { s } = session();
    await s.start();
    for (let t = 0; t < 1_000; t += 125) {
      encoded(t, t === 0);
      s.noteWrites({ sent: 2, refused: 1, skipped: 0, queued: 0 });
      await advance(125);
    }
    expect(s.stats()).toMatchObject({ congested: true, skipping: false });
    const stopping = s.stop(true);
    await advance(200);
    await stopping;
  });

  // A neighbor who walked away stops draining long before its link closes,
  // and the one still in range should keep the picture.
  test("one crowded neighbor of two leaves the stream alone", async () => {
    const { s } = session();
    await s.start();
    for (let t = 0; t < 1_000; t += 125) {
      encoded(t, t === 0);
      s.noteWrites({ sent: 1, refused: 0, skipped: 1, queued: 2 });
      await advance(125);
    }
    expect(s.stats()).toMatchObject({ congested: false, skipping: false });
    const stopping = s.stop(true);
    await advance(200);
    await stopping;
  });

  test("a microphone lost mid-stream turns the sound off and tells viewers", async () => {
    const audio = {
      startCapture: jest.fn(() => Promise.resolve()),
      stopCapture: jest.fn(() => Promise.resolve()),
    };
    const sent: Uint8Array[] = [];
    const s = new LiveVideoSendSession(LIVE_VIDEO_QUALITIES.low, {
      send: (p) => sent.push(p),
      audio: audio as unknown as NativeAudioCapture,
      onFailure: () => undefined,
      packetBudget: BLE_PACKET_BUDGET,
      now: () => now,
    });
    await s.start();
    encoded(0, true);
    await advance(500);
    expect(s.soundOn).toBe(true);
    expect(native.requestKeyframe).not.toHaveBeenCalled();

    s.dropSound();
    expect(s.soundOn).toBe(false);
    expect(native.requestKeyframe).toHaveBeenCalledTimes(1);
    expect(audio.stopCapture).toHaveBeenCalled();
    encoded(500, true);
    await advance(200);
    const starts = sent
      .map((p) => decodeVideoBurstPacket(p))
      .filter((p) => p?.kind === "start")
      .map((p) => (p?.kind === "start" ? p.config.hasAudio : null));
    expect(starts[0]).toBe(true);
    expect(starts[starts.length - 1]).toBe(false);
    const stopping = s.stop(true);
    await advance(200);
    await stopping;
  });

  // The camera stamps video from its own start, inside startEncoding. Sound
  // counted from any earlier moment would trail the picture by however long
  // the encoder took to build.
  test("sound and picture share the origin taken once the encoder has started", async () => {
    let onFrame: (frame: Uint8Array) => void = () => undefined;
    const audio = {
      startCapture: jest.fn((cb: (frame: Uint8Array) => void) => {
        onFrame = cb;
        return Promise.resolve();
      }),
      stopCapture: jest.fn(() => Promise.resolve()),
    };
    // The encoder takes 300 ms to build.
    native.startEncoding.mockImplementationOnce(() => {
      now += 300;
      return Promise.resolve();
    });
    const s = new LiveVideoSendSession(LIVE_VIDEO_QUALITIES.low, {
      send: () => undefined,
      audio: audio as unknown as NativeAudioCapture,
      onFailure: () => undefined,
      packetBudget: BLE_PACKET_BUDGET,
      now: () => now,
    });
    await s.start();
    // The camera's first frame and the microphone's, both 40 ms in.
    now += 40;
    encoded(40, true);
    onFrame(new Uint8Array(100).fill(1));
    const [, , videoPts] = native.appendVideo.mock.calls[0] as [
      string,
      string,
      number,
    ];
    const [, , audioPts] = native.appendAudio.mock.calls[0] as [
      string,
      string,
      number,
    ];
    expect(videoPts).toBe(40);
    expect(audioPts).toBe(40);
    const stopping = s.stop(true);
    await advance(200);
    await stopping;
  });
});
