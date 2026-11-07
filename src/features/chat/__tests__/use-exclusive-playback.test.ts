// The thread's one-sound rule for a video player: a finished or paused video
// gives the speaker back, and a remount never starts it again.

import { act, renderHook } from "@testing-library/react-native";
import type { VideoPlayer } from "expo-video";
import { useExclusivePlayback } from "../use-exclusive-playback";

type Listener = (payload: { isPlaying: boolean }) => void;

// Only what the hook touches: events, play, pause, the position and the load
// status.
function fakePlayer() {
  const listeners = new Map<string, Set<Listener>>();
  const player = {
    status: "readyToPlay" as VideoPlayer["status"],
    currentTime: 12,
    play: jest.fn(),
    pause: jest.fn(),
    addListener(event: string, listener: Listener) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
      return { remove: () => set.delete(listener) };
    },
    emit(
      event: string,
      payload: { isPlaying: boolean } = { isPlaying: false },
    ) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
  return player;
}

type Fake = ReturnType<typeof fakePlayer>;

type Props = { player: Fake; playing: boolean };

async function mount(
  player: Fake,
  playing: boolean,
  onPlay: () => void,
  onStop: (() => void) | undefined,
) {
  return renderHook(
    ({ player: p, playing: now }: Props) =>
      useExclusivePlayback(p as unknown as VideoPlayer, now, onPlay, onStop),
    { initialProps: { player, playing } },
  );
}

describe("useExclusivePlayback", () => {
  // Android still means to play at the end, so the rewind alone would start
  // the clip over.
  test("ending releases the speaker, paused before the rewind", async () => {
    const player = fakePlayer();
    const onStop = jest.fn();
    const hook = await mount(player, false, jest.fn(), onStop);
    await hook.rerender({ player, playing: true });
    player.pause.mockClear();
    await act(() => player.emit("playToEnd"));
    expect(onStop).toHaveBeenCalled();
    expect(player.pause).toHaveBeenCalled();
    expect(player.currentTime).toBe(0);
  });

  test("a pause by the person releases the speaker", async () => {
    const player = fakePlayer();
    const onStop = jest.fn();
    const hook = await mount(player, false, jest.fn(), onStop);
    await hook.rerender({ player, playing: true });
    await act(() => player.emit("playingChange", { isPlaying: false }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("a buffering stall is not a pause", async () => {
    const player = fakePlayer();
    const onStop = jest.fn();
    const hook = await mount(player, false, jest.fn(), onStop);
    await hook.rerender({ player, playing: true });
    player.status = "loading";
    await act(() => player.emit("playingChange", { isPlaying: false }));
    expect(onStop).not.toHaveBeenCalled();
  });

  test("the pause it issues when another player takes over releases nothing", async () => {
    const player = fakePlayer();
    const onStop = jest.fn();
    const hook = await mount(player, false, jest.fn(), onStop);
    await hook.rerender({ player, playing: true });
    await hook.rerender({ player, playing: false });
    expect(player.pause).toHaveBeenCalled();
    await act(() => player.emit("playingChange", { isPlaying: false }));
    expect(onStop).not.toHaveBeenCalled();
  });

  test("starting from the native controls claims the speaker", async () => {
    const player = fakePlayer();
    const onPlay = jest.fn();
    await mount(player, false, onPlay, jest.fn());
    await act(() => player.emit("playingChange", { isPlaying: true }));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  test("plays on a change into playing", async () => {
    const player = fakePlayer();
    const hook = await mount(player, false, jest.fn(), jest.fn());
    expect(player.play).not.toHaveBeenCalled();
    await hook.rerender({ player, playing: true });
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  test("a remount holding the speaker does not play, and lets it go", async () => {
    const player = fakePlayer();
    const onStop = jest.fn();
    await mount(player, true, jest.fn(), onStop);
    expect(player.play).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("unmounting while holding the speaker releases it", async () => {
    const player = fakePlayer();
    const onStop = jest.fn();
    const hook = await mount(player, false, jest.fn(), onStop);
    await hook.rerender({ player, playing: true });
    await hook.unmount();
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
