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

  test("a radio refusing writes backs the encoder off", async () => {
    const { s } = session();
    await s.start();
    for (let t = 0; t < 4_000; t += 125) {
      encoded(t, t % 2_000 === 0);
      s.noteRefused(3);
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
});
