// A thread full of video notes holds a player only for the notes on screen and
// the one being heard, and loops only the newest few.

import { videoNoteName } from "@core/mesh/wire/file-packet";
import type { ChatMessage } from "@store/chat-store";
import { videoNoteIds, videoNotePlayback } from "../video-note-playback";

// Two notes move at once; the rest hold still.
const LOOPING = 2;

function row(id: string, name?: string): ChatMessage {
  return {
    id,
    channel: "mesh",
    senderID: "",
    senderNickname: "",
    text: "",
    timestampMs: 0,
    isMine: false,
    ...(name === undefined
      ? {}
      : { attachment: { type: "video", uri: `file:///${id}`, name } }),
  } as ChatMessage;
}

describe("videoNoteIds", () => {
  it("picks the video notes out of the rows on screen, in order", () => {
    const rows = [
      row("a", videoNoteName()),
      row("b"),
      row("c", "holiday.mp4"),
      row("d", videoNoteName()),
    ];
    expect(videoNoteIds(rows)).toEqual(["a", "d"]);
  });
});

describe("videoNotePlayback", () => {
  const onScreen = ["n1", "n2", "n3", "n4"];

  it("gives a note off screen no player", () => {
    expect(videoNotePlayback("gone", onScreen, null)).toBe("none");
  });

  it("loops only the newest notes on screen and holds the rest still", () => {
    const states = onScreen.map((id) => videoNotePlayback(id, onScreen, null));
    expect(states.filter((s) => s === "loop")).toHaveLength(LOOPING);
    expect(states.slice(-LOOPING).every((s) => s === "loop")).toBe(true);
    expect(states.slice(0, -LOOPING).every((s) => s === "still")).toBe(true);
  });

  it("keeps the player of a note being heard after it scrolls away", () => {
    expect(videoNotePlayback("heard", onScreen, "heard")).toBe("still");
  });

  it("holds a dozen notes to at most what the screen shows", () => {
    const thread = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const visible = thread.slice(5, 8);
    const players = thread.filter(
      (id) => videoNotePlayback(id, visible, null) !== "none",
    );
    expect(players).toEqual(visible);
  });
});
