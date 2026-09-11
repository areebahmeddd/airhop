/**
 * @jest-environment node
 */
// The urgent line is the one place a board post reaches the chat itself, so
// what gets written, how many times, and for which post is pinned here.

import { useChatStore } from "@store/chat-store";
import { noteUrgentNotice, resetBoardAlerts } from "../board-alerts";

beforeEach(() => {
  jest.useFakeTimers();
  useChatStore.getState().clearAll();
  useChatStore.getState().addChannel("#geo:u4pr");
  resetBoardAlerts();
});

afterEach(() => {
  jest.useRealTimers();
});

function notice(postID: string, channel = "#bluetooth") {
  return {
    postID,
    channel,
    authorNickname: "alice",
    content: "water at gate 3",
  };
}

function lines(channel: string) {
  return useChatStore.getState().messages[channel] ?? [];
}

describe("noteUrgentNotice", () => {
  it("writes one system line per notice after the collapse delay", () => {
    noteUrgentNotice(notice("p1"));
    expect(lines("#bluetooth")).toHaveLength(0);
    jest.runAllTimers();
    const [row] = lines("#bluetooth");
    expect(row.isSystem).toBe(true);
    expect(row.isMine).toBe(false);
    expect(row.systemKey).toBe("chat.board.urgent_one");
    expect(row.systemVars).toEqual({
      author: "alice",
      content: "water at gate 3",
    });
  });

  it("collapses a burst into a single counted line per channel", () => {
    noteUrgentNotice(notice("p1"));
    noteUrgentNotice(notice("p2"));
    noteUrgentNotice(notice("p3", "#geo:u4pr"));
    jest.runAllTimers();
    expect(lines("#bluetooth")).toHaveLength(1);
    expect(lines("#bluetooth")[0].systemKey).toBe("chat.board.urgent_many");
    expect(lines("#bluetooth")[0].systemVars).toEqual({ count: 2 });
    expect(lines("#geo:u4pr")).toHaveLength(1);
    expect(lines("#geo:u4pr")[0].systemKey).toBe("chat.board.urgent_one");
  });

  // A relay resubscribe replays recent notes, still inside the recency gate.
  it("ignores a post it has already seen, in the same burst or a later one", () => {
    noteUrgentNotice(notice("p1"));
    noteUrgentNotice(notice("p1"));
    jest.runAllTimers();
    noteUrgentNotice(notice("p1"));
    jest.runAllTimers();
    expect(lines("#bluetooth")).toHaveLength(1);
    expect(lines("#bluetooth")[0].systemKey).toBe("chat.board.urgent_one");
  });

  it("writes nothing for a channel that is not joined", () => {
    noteUrgentNotice(notice("p1", "#geo:zzzz"));
    jest.runAllTimers();
    expect(lines("#geo:zzzz")).toHaveLength(0);
  });

  it("clips a long body and flattens its whitespace", () => {
    noteUrgentNotice({
      ...notice("p1"),
      content: "line one\n\n" + "x".repeat(200),
    });
    jest.runAllTimers();
    const text = lines("#bluetooth")[0].systemVars?.content as string;
    expect(text.startsWith("line one x")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(Array.from(text)).toHaveLength(121);
  });

  it("falls back to a stand-in when the author has no nickname", () => {
    noteUrgentNotice({ ...notice("p1"), authorNickname: "" });
    jest.runAllTimers();
    expect(lines("#bluetooth")[0].systemVars?.author).toBe("Someone");
  });
});
