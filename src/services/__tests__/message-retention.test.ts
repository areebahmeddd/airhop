// Disappearing messages: when a message leaves this phone, and that every copy
// goes with it. Timed from when it reached this phone, never the sender's
// clock, and never on a clock that went back; swept at each deadline, never
// taking a token the wallet has not claimed, and never let back in by a
// resend. Uses the real stores over the in-memory MMKV mock, and
// attachment-cache's reference-counted cleanup over a fake disk.

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

jest.mock("../notification-service", () => ({
  dismissMessageNotificationFor: jest.fn(() => Promise.resolve()),
}));

import { getEncodedToken, type Token } from "@cashu/cashu-ts";
import { toProofLike } from "@core/payments/cashu";
import { useActivityStore } from "@store/activity-store";
import { useChatStore, type ChatMessage } from "@store/chat-store";
import { useOutboxStore } from "@store/outbox-store";
import {
  useSettingsStore,
  type MessageRetentionDays,
} from "@store/settings-store";
import { useWalletStore } from "@store/wallet-store";
import {
  isMessageExpired,
  messageRetentionWindowMs,
  withoutExpired,
} from "@utils/message-expiry";
import {
  INCOMING_FILE_PREFIX,
  startAttachmentCleanup,
} from "../attachment-cache";
import {
  startMessageRetention,
  stopMessageRetention,
  sweepMessagesIfDue,
  sweepMessagesNow,
} from "../message-retention";
import { dismissMessageNotificationFor } from "../notification-service";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const PHOTO = `file:///app/Library/Caches/${INCOMING_FILE_PREFIX}1_photo.jpg`;

const forgotten: string[][] = [];

let seq = 0;
// A message from someone else, arriving at the faked clock's now.
function arrive(overrides: Partial<ChatMessage> = {}): ChatMessage {
  seq += 1;
  const msg: ChatMessage = {
    id: `m${String(seq)}`,
    channel: "dm:alice",
    senderID: "aabbccdd00112233",
    senderNickname: "alice",
    text: "words",
    timestampMs: Date.now(),
    isMine: false,
    ...overrides,
  };
  useChatStore.getState().addMessage(msg);
  return msg;
}

function arriveAt(atMs: number, overrides: Partial<ChatMessage> = {}) {
  jest.setSystemTime(atMs);
  return arrive({ timestampMs: atMs, ...overrides });
}

function ids(channel = "dm:alice"): string[] {
  return (useChatStore.getState().messages[channel] ?? []).map((m) => m.id);
}

function setDays(days: MessageRetentionDays): void {
  useSettingsStore.getState().setMessageRetentionDays(days);
}

beforeAll(() => {
  startAttachmentCleanup();
});

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  stopMessageRetention();
  useChatStore.getState().clearAll();
  useActivityStore.getState().clearAll();
  useOutboxStore.getState().clearAll();
  useSettingsStore.getState().reset();
  useWalletStore.setState({ claimedTokens: [] });
  globalThis.__files = new Set([PHOTO]);
  forgotten.length = 0;
  jest.mocked(dismissMessageNotificationFor).mockClear();
});

afterEach(() => {
  stopMessageRetention();
  jest.useRealTimers();
});

describe("the setting", () => {
  it("deletes nothing while it is off", () => {
    arriveAt(NOW - 365 * DAY);
    sweepMessagesNow(NOW);
    expect(ids()).toHaveLength(1);
  });

  it("removes a message once it has been on this phone past the window", () => {
    setDays(1);
    arriveAt(NOW - DAY - 1);
    const fresh = arriveAt(NOW - DAY + HOUR);
    sweepMessagesNow(NOW);
    expect(ids()).toEqual([fresh.id]);
  });

  it("never takes a message still being sent", () => {
    setDays(1);
    arriveAt(NOW - 2 * DAY, { isMine: true, status: "sending" });
    sweepMessagesNow(NOW);
    expect(ids()).toHaveLength(1);
  });

  // A DM to someone away longer than the window: deleting it would discard
  // the outbox entry too, and the sender would never see it fail.
  it.each(["queued", "carried"] as const)(
    "never takes a DM still %s, nor its outbox entry",
    (status) => {
      setDays(1);
      const held = arriveAt(NOW - 2 * DAY, { isMine: true, status });
      useOutboxStore.getState().enqueue({
        id: held.id,
        recipientPeerID: "aabbccdd00112233",
        channel: "dm:alice",
        text: held.text,
        createdAtMs: held.timestampMs,
      });
      sweepMessagesNow(NOW);
      expect(ids()).toEqual([held.id]);
      expect(useOutboxStore.getState().pending.map((p) => p.id)).toEqual([
        held.id,
      ]);
    },
  );
});

// A courier drop or a Nostr message can be days old by the sender's clock
// when it gets here. Timed by the sender, it would vanish unread.
describe("a message arriving already past the window", () => {
  it("stays for the whole window from its arrival", () => {
    setDays(1);
    const late = arriveAt(NOW, { timestampMs: NOW - 10 * DAY });

    sweepMessagesNow(NOW + 23 * HOUR);
    expect(ids()).toEqual([late.id]);
    const row = useChatStore.getState().messages["dm:alice"][0];
    expect(isMessageExpired(row, NOW + 23 * HOUR, DAY)).toBe(false);

    sweepMessagesNow(NOW + DAY + 1);
    expect(ids()).toEqual([]);
  });

  it("is not kept longer for a sender whose clock runs ahead", () => {
    setDays(1);
    arriveAt(NOW, { timestampMs: NOW + 30 * DAY });
    sweepMessagesNow(NOW + DAY + 1);
    expect(ids()).toEqual([]);
  });
});

describe("the window shortened while a thread is open", () => {
  it("hides the older messages at once and removes them with the sweep", () => {
    setDays(30);
    arriveAt(NOW - 3 * DAY);
    const fresh = arriveAt(NOW - HOUR);
    const thread = useChatStore.getState().messages["dm:alice"];
    const month = messageRetentionWindowMs(30);
    expect(withoutExpired(thread, NOW, month)).toBe(thread);

    // What the thread renders the moment the setting changes, before any
    // sweep: its memo reads the new window.
    setDays(1);
    const shown = withoutExpired(thread, NOW, messageRetentionWindowMs(1));
    expect(shown.map((m) => m.id)).toEqual([fresh.id]);

    // What General runs after the confirm.
    sweepMessagesNow(NOW);
    expect(ids()).toEqual([fresh.id]);
  });
});

describe("a forwarded attachment", () => {
  it("survives while a kept message shows it, and goes with the last", () => {
    setDays(1);
    arriveAt(NOW - 2 * DAY, { attachment: { type: "image", uri: PHOTO } });
    const forward = arriveAt(NOW - HOUR, {
      channel: "#room",
      isMine: true,
      status: "sent",
      attachment: { type: "image", uri: PHOTO },
    });

    sweepMessagesNow(NOW);
    expect(ids()).toEqual([]);
    expect(ids("#room")).toEqual([forward.id]);
    expect(globalThis.__files.has(PHOTO)).toBe(true);

    sweepMessagesNow(NOW + DAY);
    expect(ids("#room")).toEqual([]);
    expect(globalThis.__files.has(PHOTO)).toBe(false);
  });
});

// A device clock set back makes every arrival look like it is in the future.
// Deleting on a bad clock is the worse failure, so nothing goes.
describe("the device clock moving backwards", () => {
  it("deletes nothing that arrived after the clock's new now", () => {
    setDays(1);
    arriveAt(NOW);
    arriveAt(NOW - HOUR);
    sweepMessagesNow(NOW - 30 * DAY);
    expect(ids()).toHaveLength(2);
  });

  it("still counts as a due sweep, rather than years of waiting", () => {
    setDays(1);
    expect(sweepMessagesIfDue(NOW)).toBe(true);
    expect(sweepMessagesIfDue(NOW + HOUR - 1)).toBe(false);
    expect(sweepMessagesIfDue(NOW - DAY)).toBe(true);
  });
});

describe("every copy of the text", () => {
  it("goes with the message: the bell, the outbox and owed read receipts", () => {
    setDays(1);
    startMessageRetention((expired) => forgotten.push([...expired]));
    forgotten.length = 0;

    const gone = arriveAt(NOW - 2 * DAY);
    jest.setSystemTime(NOW - 2 * DAY);
    useActivityStore.getState().record({
      id: gone.id,
      channel: "dm:alice",
      isDM: true,
      senderID: gone.senderID,
      senderNickname: "alice",
      preview: gone.text,
      timestampMs: gone.timestampMs,
    });
    // Awaiting its receipt, but a relay holds a copy that reaches alice
    // without this phone: the row reads "sent" and expires like any other.
    const relayed = arriveAt(NOW - 2 * DAY, { isMine: true, status: "sent" });
    // Also "sent", flooded over the mesh with nothing holding a copy: the
    // outbox retry is its only way to arrive, so it stays until it settles.
    const unheld = arriveAt(NOW - 2 * DAY, { isMine: true, status: "sent" });
    const kept = arriveAt(NOW - HOUR, { isMine: true, status: "queued" });
    for (const m of [relayed, unheld, kept]) {
      useOutboxStore.getState().enqueue({
        id: m.id,
        recipientPeerID: "aabbccdd00112233",
        channel: "dm:alice",
        text: m.text,
        createdAtMs: m.timestampMs,
      });
    }
    useOutboxStore.getState().markRelayAccepted(relayed.id);

    sweepMessagesNow(NOW);

    expect(useActivityStore.getState().entries).toEqual([]);
    expect(useOutboxStore.getState().pending.map((p) => p.id)).toEqual([
      unheld.id,
      kept.id,
    ]);
    expect(ids().sort()).toEqual([unheld.id, kept.id].sort());
    expect(forgotten.flat().sort()).toEqual([gone.id, relayed.id].sort());
  });
});

// The tray card shows the newest message's text, which would outlive the row.
describe("the conversation's notification", () => {
  it("is cleared once nothing left in the thread is unread", () => {
    setDays(1);
    arriveAt(NOW - 2 * DAY);
    arriveAt(NOW - 2 * DAY, { channel: "dm:bob" });
    arriveAt(NOW - HOUR, { channel: "dm:bob" });
    sweepMessagesNow(NOW);
    expect(useChatStore.getState().unreadCounts["dm:alice"]).toBe(0);
    expect(useChatStore.getState().unreadCounts["dm:bob"]).toBe(1);
    expect(jest.mocked(dismissMessageNotificationFor).mock.calls).toEqual([
      ["dm:alice"],
    ]);
  });

  it("is left alone when the sweep removed nothing", () => {
    setDays(1);
    arriveAt(NOW - HOUR);
    useChatStore.getState().markChannelRead("dm:alice");
    sweepMessagesNow(NOW);
    expect(dismissMessageNotificationFor).not.toHaveBeenCalled();
  });
});

describe("when sweeps run", () => {
  it("runs at start and then hourly while the process lives", () => {
    setDays(1);
    const msg = arriveAt(NOW);
    startMessageRetention(() => {});
    expect(ids()).toEqual([msg.id]);

    jest.setSystemTime(NOW + DAY);
    jest.advanceTimersByTime(HOUR);
    expect(ids()).toEqual([]);
  });

  // The lists, unread badges, the bell and owed receipts see only the store,
  // so an hour's wait would show an expired message that long.
  it("runs at the next message's deadline, not up to an hour after it", () => {
    setDays(1);
    const msg = arriveAt(NOW - DAY + 10 * MINUTE);
    jest.setSystemTime(NOW);
    startMessageRetention(() => {});
    expect(ids()).toEqual([msg.id]);

    jest.advanceTimersByTime(10 * MINUTE);
    expect(ids()).toEqual([msg.id]);
    jest.advanceTimersByTime(1);
    expect(ids()).toEqual([]);
  });

  // A suspended app ran no timer meanwhile.
  it("on a return to the app, sweeps at once only if a deadline passed", () => {
    setDays(1);
    const msg = arriveAt(NOW - DAY + 10 * MINUTE);
    sweepMessagesNow(NOW);

    expect(sweepMessagesIfDue(NOW + 5 * MINUTE)).toBe(false);
    expect(ids()).toEqual([msg.id]);
    expect(sweepMessagesIfDue(NOW + 10 * MINUTE + 1)).toBe(true);
    expect(ids()).toEqual([]);
    // Nothing left to wait for: the hourly throttle again.
    expect(sweepMessagesIfDue(NOW + 20 * MINUTE)).toBe(false);
  });
});

// Claimed only by hand from its bubble, so the row is the recipient's only
// copy of the money.
describe("a received token", () => {
  const TOKEN = getEncodedToken({
    mint: "https://mint.example.com",
    unit: "sat",
    proofs: [
      toProofLike({
        id: "00ad268c4d1f5826",
        amount: 8,
        secret: "token-secret",
        C: "02" + "00".repeat(32),
      }),
    ],
  } as unknown as Token);

  it("stays past the window until the wallet has claimed it", () => {
    setDays(1);
    const received = arriveAt(NOW - 2 * DAY, { text: TOKEN });
    arriveAt(NOW - 2 * DAY, { text: TOKEN, isMine: true, status: "sent" });

    sweepMessagesNow(NOW);
    expect(ids()).toEqual([received.id]);
    // And the thread still shows it, so it can be claimed.
    const thread = useChatStore.getState().messages["dm:alice"];
    expect(withoutExpired(thread, NOW, DAY)).toBe(thread);

    useWalletStore.getState().markTokenClaimed("token-secret");
    sweepMessagesNow(NOW + HOUR);
    expect(ids()).toEqual([]);
  });

  // The kept token was read long ago; only the two messages after it were
  // unread, and both went.
  it("holds up no unread badge or tray card once what was unread is gone", () => {
    setDays(1);
    arriveAt(NOW - 4 * DAY, { text: TOKEN });
    useChatStore.getState().markChannelRead("dm:alice");
    arriveAt(NOW - 2 * DAY);
    arriveAt(NOW - 2 * DAY + MINUTE);
    expect(useChatStore.getState().unreadCounts["dm:alice"]).toBe(2);

    sweepMessagesNow(NOW);
    expect(ids()).toHaveLength(1);
    expect(useChatStore.getState().unreadCounts["dm:alice"]).toBe(0);
    expect(dismissMessageNotificationFor).toHaveBeenCalledWith("dm:alice");
  });
});

// A sender whose DELIVERED was lost resends the same ID from its outbox for a
// week. Without a record, the store's dedup would take it as a new message.
describe("a resend of a removed DM", () => {
  it("is refused rather than shown again", () => {
    setDays(1);
    const gone = arriveAt(NOW - 2 * DAY);
    sweepMessagesNow(NOW);
    expect(ids()).toEqual([]);

    jest.setSystemTime(NOW + 6 * DAY);
    expect(useChatStore.getState().addMessage(gone)).toBe(false);
    expect(ids()).toEqual([]);
    expect(useChatStore.getState().unreadCounts["dm:alice"] ?? 0).toBe(0);
  });
});
