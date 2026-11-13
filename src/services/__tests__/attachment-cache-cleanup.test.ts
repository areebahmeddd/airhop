// What happens to an attachment's file when its row leaves the chat store:
// leaving or clearing a conversation, removing a message, the 200-message
// trim. Rows share files (a forward keeps its source's URI), so a file goes
// only once nothing references it, and never while a send or a receive still
// holds it. Without this, the confirmation that a chat's history is removed
// from this device is untrue for its photos, videos and voice notes.

// The files on the fake disk, by URI. On globalThis because jest.mock
// factories are hoisted above module-scope bindings.
declare global {
  var __files: Set<string>;
}
globalThis.__files = new Set();

jest.mock("expo-file-system", () => {
  class MockFile {
    readonly uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get exists(): boolean {
      return globalThis.__files.has(this.uri);
    }
    delete(): void {
      if (!globalThis.__files.delete(this.uri)) throw new Error("gone");
    }
  }
  class MockDirectory {
    readonly exists = false;
    list(): unknown[] {
      return [];
    }
  }
  return {
    File: MockFile,
    Directory: MockDirectory,
    Paths: {
      cache: { uri: "file:///app/Library/Caches/" },
      document: { parentDirectory: "/app" },
    },
  };
});

import {
  MAX_PER_CHANNEL,
  useChatStore,
  type ChatAttachment,
  type ChatMessage,
} from "@store/chat-store";
import {
  CACHE_FILE_PREFIX,
  deleteUnreferencedAttachments,
  holdAttachmentFile,
  INCOMING_FILE_PREFIX,
  startAttachmentCleanup,
} from "../attachment-cache";

const CACHE = "file:///app/Library/Caches/";
const PHOTO = `${CACHE}${INCOMING_FILE_PREFIX}1800000000000_img_a.jpg`;
const VIDEO = `${CACHE}${CACHE_FILE_PREFIX}1800000000000_1_clip_b.mp4`;

let seq = 0;
function row(channel: string, uri?: string, timestampMs = 1): ChatMessage {
  seq += 1;
  const attachment: ChatAttachment | undefined =
    uri === undefined ? undefined : { type: "image", uri };
  return {
    id: `m${String(seq)}`,
    channel,
    senderID: "aabbccdd00112233",
    senderNickname: "alice",
    text: "",
    timestampMs,
    isMine: false,
    attachment,
  };
}

function onDisk(uri: string): boolean {
  return globalThis.__files.has(uri);
}

beforeAll(() => {
  startAttachmentCleanup();
});

beforeEach(() => {
  // clearAll reports nothing, so the reset itself deletes no file.
  useChatStore.getState().clearAll();
  globalThis.__files = new Set([PHOTO, VIDEO]);
});

describe("when a row leaves the chat store", () => {
  it("deletes its file once nothing references it", () => {
    const photo = row("dm:alice", PHOTO);
    useChatStore.getState().addMessage(photo);
    useChatStore.getState().removeMessage("dm:alice", photo.id);
    expect(onDisk(PHOTO)).toBe(false);
  });

  it("keeps a file a forward in another chat still shows", () => {
    const original = row("dm:alice", PHOTO);
    const forward = row("#room", PHOTO);
    useChatStore.getState().addMessage(original);
    useChatStore.getState().addMessage(forward);

    useChatStore.getState().removeChannel("dm:alice");
    expect(onDisk(PHOTO)).toBe(true);

    useChatStore.getState().clearChannelMessages("#room");
    expect(onDisk(PHOTO)).toBe(false);
  });

  it("deletes every file a cleared conversation held", () => {
    useChatStore.getState().addMessage(row("dm:alice", PHOTO, 1));
    useChatStore.getState().addMessage(row("dm:alice", VIDEO, 2));
    useChatStore.getState().addMessage(row("dm:alice", undefined, 3));
    useChatStore.getState().clearChannelMessages("dm:alice");
    expect(onDisk(PHOTO)).toBe(false);
    expect(onDisk(VIDEO)).toBe(false);
  });

  it("deletes the file of the row a full thread trims", () => {
    useChatStore.getState().addMessage(row("#room", PHOTO, 0));
    for (let i = 1; i < MAX_PER_CHANNEL; i++) {
      useChatStore.getState().addMessage(row("#room", undefined, i));
    }
    expect(onDisk(PHOTO)).toBe(true);
    useChatStore
      .getState()
      .addMessage(row("#room", undefined, MAX_PER_CHANNEL));
    expect(onDisk(PHOTO)).toBe(false);
  });
});

describe("a file still being sent or received", () => {
  it("is skipped, then deleted on release if still unreferenced", () => {
    const release = holdAttachmentFile(PHOTO);
    const photo = row("dm:alice", PHOTO);
    useChatStore.getState().addMessage(photo);
    useChatStore.getState().removeMessage("dm:alice", photo.id);
    expect(onDisk(PHOTO)).toBe(true);

    release();
    expect(onDisk(PHOTO)).toBe(false);
  });

  it("survives release when a row took it meanwhile", () => {
    const release = holdAttachmentFile(PHOTO);
    const first = row("dm:alice", PHOTO);
    useChatStore.getState().addMessage(first);
    useChatStore.getState().removeMessage("dm:alice", first.id);
    useChatStore.getState().addMessage(row("dm:bob", PHOTO));

    release();
    expect(onDisk(PHOTO)).toBe(true);
  });

  it("stays held until every hold is released", () => {
    const releaseSend = holdAttachmentFile(PHOTO);
    const releaseForward = holdAttachmentFile(PHOTO);
    expect(deleteUnreferencedAttachments([PHOTO])).toBe(0);

    releaseSend();
    // A second call to the same release must not count as the other hold.
    releaseSend();
    expect(onDisk(PHOTO)).toBe(true);

    releaseForward();
    expect(onDisk(PHOTO)).toBe(false);
  });
});

describe("what is never deleted", () => {
  it.each([
    ["a file outside the cache", "file:///app/Documents/airhop_1_x.jpg"],
    ["a cache file without the prefix", `${CACHE}airhop-qr-aabb.png`],
    ["a file in a cache subdirectory", `${CACHE}ImagePicker/airhop_1_x.jpg`],
  ])("%s", (_label, uri) => {
    globalThis.__files.add(uri);
    expect(deleteUnreferencedAttachments([uri])).toBe(0);
    expect(onDisk(uri)).toBe(true);
  });

  it("a file no longer on disk, without throwing", () => {
    globalThis.__files.delete(PHOTO);
    expect(deleteUnreferencedAttachments([PHOTO])).toBe(0);
  });
});
