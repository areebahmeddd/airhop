// A video player with native controls, brought under the thread's rule that
// one thing is heard at a time. Starting it claims the speaker, as tapping a
// voice note does; anything else claiming it (another note, a stream given
// sound, live voice, a microphone opening) pauses it.

import type { VideoPlayer } from "expo-video";
import { useEffect, useRef } from "react";

export function useExclusivePlayback(
  player: VideoPlayer,
  playing: boolean,
  onPlay: () => void,
): void {
  const onPlayRef = useRef(onPlay);
  useEffect(() => {
    onPlayRef.current = onPlay;
  });
  useEffect(() => {
    const sub = player.addListener("playingChange", ({ isPlaying }) => {
      if (isPlaying) onPlayRef.current();
    });
    return () => sub.remove();
  }, [player]);
  useEffect(() => {
    if (!playing) player.pause();
  }, [player, playing]);
}
