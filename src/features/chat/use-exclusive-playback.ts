// A video player with native controls, brought under the thread's rule that
// one thing is heard at a time. Starting it claims the speaker, as tapping a
// voice note does; anything else claiming it (another note, a stream given
// sound, live voice, a microphone opening) pauses it.
//
// The claim is released when the video ends, when the person pauses it, and
// when the player unmounts while holding it, or a finished video would stay
// "the one playing" and a row scrolled back into view would start again
// aloud. `onStop` must compare and clear (release only a claim that is still
// this player's), since it can land after another player has claimed.

import type { VideoPlayer } from "expo-video";
import { useEffect, useRef } from "react";

export function useExclusivePlayback(
  player: VideoPlayer,
  playing: boolean,
  onPlay: () => void,
  // Omitted by a player that loops itself from `playToEnd` (the trimmer),
  // where the end is not a stop.
  onStop?: () => void,
): void {
  const onPlayRef = useRef(onPlay);
  const onStopRef = useRef(onStop);
  const playingRef = useRef(playing);
  useEffect(() => {
    onPlayRef.current = onPlay;
    onStopRef.current = onStop;
    playingRef.current = playing;
  });
  useEffect(() => {
    const change = player.addListener("playingChange", ({ isPlaying }) => {
      if (isPlaying) {
        onPlayRef.current();
        return;
      }
      // A pause only while the claim is still ours: the pause this hook
      // issues when another player takes over arrives with `playing` already
      // false. And only from a ready player, since Android reports
      // not-playing while it buffers, which is a stall and not a pause.
      if (playingRef.current && player.status === "readyToPlay") {
        onStopRef.current?.();
      }
    });
    const ended = player.addListener("playToEnd", () => {
      if (onStopRef.current === undefined) return;
      // Back to the start, so the next play (a screen reader's, from inside
      // the bubble where the native replay button is out of reach) plays it
      // again: Android ignores play() on a player sitting at its end. Paused
      // first, since Android still means to play at the end, and the seek
      // alone would start it over aloud.
      player.pause();
      player.currentTime = 0;
      if (playingRef.current) onStopRef.current();
    });
    return () => {
      change.remove();
      ended.remove();
    };
  }, [player]);
  // Played on a change into `playing` only, never because it holds at mount:
  // a remount is a scroll, not a request to hear it again.
  const wasPlaying = useRef(playing);
  useEffect(() => {
    if (playing && !wasPlaying.current) player.play();
    else if (!playing) player.pause();
    wasPlaying.current = playing;
  }, [player, playing]);
  useEffect(() => {
    // A claim held at mount belongs to a player that is gone, so it is let go
    // rather than left reading "Pause" over a still frame.
    if (playingRef.current) onStopRef.current?.();
    return () => {
      if (playingRef.current) onStopRef.current?.();
    };
  }, []);
}
