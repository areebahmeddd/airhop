/**
 * @jest-environment node
 */
// The seam between the platform-agnostic PTT stack and the native audio module.
//
// What matters here is the fallback behaviour: every one of these paths is a
// case where live voice is unavailable or dies mid-burst, and in each of them
// the app has to keep working rather than hang, throw, or leave the speaker
// open. The audio itself needs devices; these are the decisions around it.

import NativeAirhopVoice from "@bridge/NativeAirhopVoice";
import { NativeAudioPlayback } from "../voice-audio-backend";

jest.mock("@bridge/NativeAirhopVoice", () => ({
  __esModule: true,
  default: {
    startPlayback: jest.fn(() => Promise.resolve()),
    enqueueFrames: jest.fn(() => Promise.resolve()),
    stopPlayback: jest.fn(() => Promise.resolve()),
    finishPlayback: jest.fn(() => Promise.resolve()),
    startCapture: jest.fn(() => Promise.resolve()),
    stopCapture: jest.fn(() => Promise.resolve()),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  },
}));

const native = NativeAirhopVoice as unknown as {
  startPlayback: jest.Mock;
  enqueueFrames: jest.Mock;
  stopPlayback: jest.Mock;
  finishPlayback: jest.Mock;
};

const frame = () => [new Uint8Array([1, 2, 3])];

beforeEach(() => {
  jest.clearAllMocks();
});

describe("NativeAudioPlayback", () => {
  it("opens the speaker once per burst, not once per batch", async () => {
    const playback = new NativeAudioPlayback();
    await playback.playFrames("aa", 0x01, frame());
    await playback.playFrames("aa", 0x01, frame());
    await playback.playFrames("aa", 0x01, frame());

    expect(native.startPlayback).toHaveBeenCalledTimes(1);
    expect(native.enqueueFrames).toHaveBeenCalledTimes(3);
  });

  it("hands the speaker to a new talker mid-burst", async () => {
    // One voice at a time: a second burst replaces the first rather than
    // mixing, which is the native side's contract for startPlayback.
    const playback = new NativeAudioPlayback();
    await playback.playFrames("aa", 0x01, frame());
    await playback.playFrames("bb", 0x01, frame());

    expect(native.startPlayback).toHaveBeenCalledTimes(2);
  });

  it("ignores an end for a burst that is not the one playing", async () => {
    // A late END from an earlier talker must not cut off the current one.
    const playback = new NativeAudioPlayback();
    await playback.playFrames("bb", 0x01, frame());
    playback.finishSession("aa");
    playback.stopSession("aa");

    expect(native.finishPlayback).not.toHaveBeenCalled();
    expect(native.stopPlayback).not.toHaveBeenCalled();
  });

  it("silences at once a burst that was retracted", async () => {
    const playback = new NativeAudioPlayback();
    await playback.playFrames("aa", 0x01, frame());
    playback.stopSession("aa");

    expect(native.stopPlayback).toHaveBeenCalledTimes(1);
    expect(native.finishPlayback).not.toHaveBeenCalled();
  });

  it("lets a burst that ended play out before releasing the speaker", async () => {
    const onIdle = jest.fn();
    let drained: () => void = () => undefined;
    native.finishPlayback.mockImplementationOnce(
      () => new Promise<void>((resolve) => (drained = resolve)),
    );
    const playback = new NativeAudioPlayback(
      () => true,
      () => undefined,
      onIdle,
    );
    await playback.playFrames("aa", 0x01, frame());
    playback.finishSession("aa");

    expect(native.finishPlayback).toHaveBeenCalledTimes(1);
    expect(native.stopPlayback).not.toHaveBeenCalled();
    // Handing the audio session back reconfigures it, which on iOS restarts
    // the engine under the tail and loses it, so it waits for the drain.
    await Promise.resolve();
    expect(onIdle).not.toHaveBeenCalled();
    drained();
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("leaves the audio session alone when a new burst took over the drain", async () => {
    // A floor handoff: the next talker's audio lands while the last one's tail
    // is still playing, and reconfiguring the session under it costs it an
    // engine rebuild.
    const onIdle = jest.fn();
    let drained: () => void = () => undefined;
    native.finishPlayback.mockImplementationOnce(
      () => new Promise<void>((resolve) => (drained = resolve)),
    );
    const playback = new NativeAudioPlayback(
      () => true,
      () => undefined,
      onIdle,
    );
    await playback.playFrames("aa", 0x01, frame());
    playback.finishSession("aa");
    await playback.playFrames("bb", 0x01, frame());
    drained();
    await new Promise<void>((resolve) => setImmediate(() => resolve()));

    expect(onIdle).not.toHaveBeenCalled();
  });

  it("queues a burst's first audio before an end in the same breath", () => {
    // A burst whose first batch is also its last (END landing inside the
    // jitter window, or the idle timeout of a burst that only just got the
    // floor) hands over both at once. Opening the speaker must not let the
    // finish overtake the frames, or the drain finds nothing and they are
    // dropped as late.
    const playback = new NativeAudioPlayback();
    void playback.playFrames("aa", 0x01, frame());
    playback.finishSession("aa");

    const [start] = native.startPlayback.mock.invocationCallOrder;
    const [enqueue] = native.enqueueFrames.mock.invocationCallOrder;
    const [finish] = native.finishPlayback.mock.invocationCallOrder;
    expect(start).toBeLessThan(enqueue);
    expect(enqueue).toBeLessThan(finish);
  });

  it("gives up on a burst the speaker refused, without throwing", async () => {
    // A call takes the audio session mid-burst. Retrying into a device that is
    // not listening is pointless; the finalized voice note is the fallback.
    native.startPlayback.mockRejectedValueOnce(new Error("audio session busy"));
    const playback = new NativeAudioPlayback();

    await expect(
      playback.playFrames("aa", 0x01, frame()),
    ).resolves.toBeUndefined();

    // Reset, so the next burst is free to try again rather than being stuck.
    await playback.playFrames("cc", 0x01, frame());
    expect(native.startPlayback).toHaveBeenCalledTimes(2);
  });

  it("does nothing for an empty batch", async () => {
    const playback = new NativeAudioPlayback();
    await playback.playFrames("aa", 0x01, []);

    expect(native.startPlayback).not.toHaveBeenCalled();
    expect(native.enqueueFrames).not.toHaveBeenCalled();
  });
});

describe("NativeAudioPlayback autoplay gate", () => {
  // Audio must never start from a screen the user is not looking at. The burst
  // is still tracked (so "X is talking" stays right), it just makes no sound.
  it("stays silent when the conversation is not on screen", async () => {
    const playback = new NativeAudioPlayback(() => false);
    await playback.playFrames("aa", 0x01, frame());

    expect(native.startPlayback).not.toHaveBeenCalled();
    expect(native.enqueueFrames).not.toHaveBeenCalled();
  });

  it("plays when the conversation is on screen", async () => {
    const playback = new NativeAudioPlayback(() => true);
    await playback.playFrames("aa", 0x01, frame());

    expect(native.startPlayback).toHaveBeenCalledTimes(1);
  });

  it("cuts the audio when the user leaves mid-burst", async () => {
    // Backgrounding the app or walking out of the thread should stop the sound
    // where it happens, not at the end of whatever was being said.
    let audible = true;
    const playback = new NativeAudioPlayback(() => audible);
    await playback.playFrames("aa", 0x01, frame());
    expect(native.startPlayback).toHaveBeenCalledTimes(1);

    audible = false;
    await playback.playFrames("aa", 0x01, frame());
    expect(native.stopPlayback).toHaveBeenCalledTimes(1);
    expect(native.enqueueFrames).toHaveBeenCalledTimes(1); // no second batch
  });

  it("picks the audio back up when the user returns", async () => {
    let audible = false;
    const playback = new NativeAudioPlayback(() => audible);
    await playback.playFrames("aa", 0x01, frame());
    audible = true;
    await playback.playFrames("aa", 0x01, frame());

    expect(native.startPlayback).toHaveBeenCalledTimes(1);
    expect(native.enqueueFrames).toHaveBeenCalledTimes(1);
  });
});
