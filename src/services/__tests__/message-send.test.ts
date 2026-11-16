// The status a sent row settles on, and the hint that goes with it, for each
// kind of conversation. Shared by the thread and a notification reply, so a
// tick here is the same tick in both.

type Reach = {
  meshLinks: number;
  nostr: boolean;
  gateway: boolean;
  settled?: Promise<Reach>;
};

let mockDmResult = "sent";
let mockGroupResult = { sealed: true, meshLinks: 1 };
let mockChannelResult: Reach = { meshLinks: 1, nostr: false, gateway: false };
let mockMesh = true;

jest.mock("../mesh-service", () => ({
  getMeshService: () =>
    mockMesh
      ? {
          sendDm: () => mockDmResult,
          sendGroupMessage: () => mockGroupResult,
          sendChannelMessage: () => mockChannelResult,
        }
      : null,
}));
jest.mock("../geohash-channel-service", () => ({
  isGeoChannel: (channel: string) => channel.startsWith("geohash:"),
}));

import { useChatStore, type ChatMessage } from "@store/chat-store";
import { transmitMessage, type SendNotice } from "../message-send";

function send(channel: string): {
  status: () => ChatMessage["status"];
  notices: SendNotice[];
  failed: jest.Mock;
} {
  const msg = {
    id: `m-${channel}`,
    channel,
    senderID: "self",
    senderNickname: "me",
    text: "hi",
    timestampMs: Date.now(),
    isMine: true,
    status: "sending",
  } as ChatMessage;
  useChatStore.getState().addMessage(msg);
  const notices: SendNotice[] = [];
  const failed = jest.fn();
  transmitMessage(msg, { notice: (n) => notices.push(n), failed });
  return {
    status: () =>
      useChatStore.getState().messages[channel]?.find((m) => m.id === msg.id)
        ?.status,
    notices,
    failed,
  };
}

beforeEach(() => {
  useChatStore.getState().clearAll();
  mockMesh = true;
  mockDmResult = "sent";
  mockGroupResult = { sealed: true, meshLinks: 1 };
  mockChannelResult = { meshLinks: 1, nostr: false, gateway: false };
});

test("fails a send with no mesh to carry it", () => {
  mockMesh = false;
  const s = send("dm:0123456789abcdef");
  expect(s.status()).toBe("failed");
  expect(s.failed).toHaveBeenCalledTimes(1);
});

describe("a DM", () => {
  test("is sent when a route took it", () => {
    const s = send("dm:0123456789abcdef");
    expect(s.status()).toBe("sent");
    expect(s.notices).toEqual([]);
  });

  test("waits, and says so, when only the outbox or a courier holds it", () => {
    mockDmResult = "queued";
    expect(send("dm:0123456789abcdef").notices).toEqual(["queued"]);
    mockDmResult = "needs-courier";
    const carried = send("dm:fedcba9876543210");
    expect(carried.status()).toBe("carried");
    expect(carried.notices).toEqual(["queued"]);
  });
});

describe("a group message", () => {
  test("fails for good once the key is gone", () => {
    mockGroupResult = { sealed: false, meshLinks: 0 };
    const s = send("group:aa");
    expect(s.status()).toBe("failed");
    expect(s.notices).toEqual(["no-group-key"]);
    expect(s.failed).toHaveBeenCalledTimes(1);
  });

  test("waits for a member when nobody is in range", () => {
    mockGroupResult = { sealed: true, meshLinks: 0 };
    const s = send("group:aa");
    expect(s.status()).toBe("queued");
    expect(s.notices).toEqual(["group-queued"]);
    expect(s.failed).not.toHaveBeenCalled();
  });
});

describe("a channel message", () => {
  const nowhere = { meshLinks: 0, nostr: false, gateway: false };

  test("is carried by a gateway peer", () => {
    mockChannelResult = { ...nowhere, gateway: true };
    const s = send("#bluetooth");
    expect(s.status()).toBe("carried");
    expect(s.notices).toEqual(["gateway"]);
  });

  test("waits in a public room, and fails in a cell or a private channel", () => {
    mockChannelResult = nowhere;
    expect(send("#bluetooth").status()).toBe("queued");

    const cell = send("geohash:u4pruy");
    expect(cell.status()).toBe("failed");
    expect(cell.notices).toEqual(["no-reach"]);

    useChatStore.setState({ channelKeys: { "#secret": "a2V5" } });
    const secret = send("#secret");
    expect(secret.status()).toBe("failed");
    expect(secret.failed).toHaveBeenCalledTimes(1);
  });

  // A relay's answer has the last word over an open socket, with no hint by
  // then, since another thread may be on screen.
  test("fails late when every relay refuses", async () => {
    useChatStore.setState({ channelKeys: { "#secret": "a2V5" } });
    mockChannelResult = {
      ...nowhere,
      nostr: true,
      settled: Promise.resolve(nowhere),
    };

    const s = send("#secret");
    expect(s.status()).toBe("sent");
    await mockChannelResult.settled;
    await Promise.resolve();

    expect(s.status()).toBe("failed");
    expect(s.failed).toHaveBeenCalledTimes(1);
    expect(s.notices).toEqual([]);
  });
});
