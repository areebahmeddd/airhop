// A reply typed into a message card, and Mark as read: what reaches the wire,
// what the thread shows afterwards, and when the card is no longer allowed to
// answer for the user.

const PEER = "0123456789abcdef";
const SELF = "fedcba9876543210";

const mockSendDm = jest.fn<string, [string, string, string]>(() => "sent");
const mockSendGroup = jest.fn(() => ({ sealed: true, meshLinks: 1 }));
const mockSendChannel = jest.fn(() => ({
  meshLinks: 0,
  nostr: false,
  gateway: false,
}));
const mockReceipts = jest.fn();
const mockReplyCard = jest.fn((_channel: string, _outcome: string) =>
  Promise.resolve(),
);
const mockAckRings = jest.fn();

jest.mock("../mesh-service", () => ({
  getMeshService: () => ({
    peerID: SELF,
    sendDm: (peer: string, text: string, id: string) =>
      mockSendDm(peer, text, id),
    sendGroupMessage: () => mockSendGroup(),
    sendChannelMessage: () => mockSendChannel(),
    sendReadReceipts: (peer: string) => mockReceipts(peer),
    acknowledgeRingsIn: (channel: string, peer: string) =>
      mockAckRings(channel, peer),
  }),
}));
jest.mock("../geohash-channel-service", () => ({
  isGeoChannel: (channel: string) => channel.startsWith("geohash:"),
}));
jest.mock("../notification-service", () => ({
  notifyReply: (channel: string, outcome: string) =>
    mockReplyCard(channel, outcome),
}));

import { useBlockedStore } from "@store/blocked-store";
import { useChatStore, type ChatMessage } from "@store/chat-store";
import { useGroupStore } from "@store/group-store";
import { useSettingsStore } from "@store/settings-store";
import { utf8ByteLength } from "@utils/utf8-budget";
import { handleQuickAction } from "../notification-actions";

const DM = `dm:${PEER}`;

function act(
  action:
    | { kind: "reply"; channel: string; text: string }
    | { kind: "read"; channel: string },
): void {
  handleQuickAction({ ...action, atMs: Date.now() });
}

function rows(channel: string): ChatMessage[] {
  return useChatStore.getState().messages[channel] ?? [];
}

beforeEach(() => {
  jest.clearAllMocks();
  useChatStore.getState().clearAll();
  useSettingsStore.setState({
    hideNotificationPreviews: false,
    appLockEnabled: false,
  });
  useGroupStore.setState({ groups: [] });
  useBlockedStore.setState({ blockedPeerIDs: [], blockedAliases: {} });
});

describe("Reply", () => {
  test("sends into the DM as the thread would, and reads it", () => {
    useChatStore.setState({ unreadCounts: { [DM]: 3 } });

    act({ kind: "reply", channel: DM, text: "  on my way " });

    expect(mockSendDm).toHaveBeenCalledWith(PEER, "on my way", rows(DM)[0].id);
    expect(rows(DM)).toMatchObject([
      { text: "on my way", isMine: true, senderID: SELF, status: "sent" },
    ]);
    expect(useChatStore.getState().channels).toContain(DM);
    expect(useChatStore.getState().unreadCounts[DM]).toBe(0);
    expect(mockReceipts).toHaveBeenCalledWith(PEER);
  });

  // The composer stops at the DM's 255 bytes; a card's text field does not.
  test("splits a reply too long for one DM rather than losing its end", () => {
    const long = "word ".repeat(120).trim();

    act({ kind: "reply", channel: DM, text: long });

    const sent = mockSendDm.mock.calls.map((c) => c[1]);
    expect(sent.length).toBeGreaterThan(1);
    for (const part of sent)
      expect(utf8ByteLength(part)).toBeLessThanOrEqual(255);
    expect(sent.join(" ").replace(/\s+/g, " ")).toBe(long);
  });

  test("bounds a pasted wall of text, and says its end did not go", () => {
    act({ kind: "reply", channel: DM, text: "x".repeat(10_000) });
    expect(mockSendDm).toHaveBeenCalledTimes(8);
    expect(mockReplyCard).toHaveBeenCalledWith(DM, "cut");
  });

  test("keeps the parts of a split reply in the order written", () => {
    act({ kind: "reply", channel: DM, text: "a".repeat(300) + " " + "b" });
    expect(rows(DM).map((m) => m.text.at(-1))).toEqual(["a", "b"]);
  });

  test("cuts through marks a clean cut cannot get past", () => {
    const zalgo = "a" + String.fromCodePoint(0x301).repeat(400);
    act({ kind: "reply", channel: DM, text: zalgo });
    const sent = mockSendDm.mock.calls.map((c) => c[1]);
    expect(sent.join("")).toBe(zalgo);
  });

  test("turns /hug into the action line bitchat reads", () => {
    act({ kind: "reply", channel: DM, text: "/hug" });
    expect(mockSendDm.mock.calls[0][1]).toMatch(/^\* 🫂 .+ hugs you \*$/);
  });

  test("sends nothing for an empty reply, and still reads the chat", () => {
    useChatStore.setState({ unreadCounts: { [DM]: 1 } });
    act({ kind: "reply", channel: DM, text: "   " });
    expect(mockSendDm).not.toHaveBeenCalled();
    expect(rows(DM)).toEqual([]);
    expect(useChatStore.getState().unreadCounts[DM]).toBe(0);
  });

  // The card was posted before the lock went on; its buttons are still there.
  test("does nothing once the app lock or hidden previews are on", () => {
    useSettingsStore.setState({ appLockEnabled: true });
    act({ kind: "reply", channel: DM, text: "hi" });
    useSettingsStore.setState({
      appLockEnabled: false,
      hideNotificationPreviews: true,
    });
    act({ kind: "read", channel: DM });

    expect(mockSendDm).not.toHaveBeenCalled();
    expect(mockReceipts).not.toHaveBeenCalled();
    // The reply was typed in good faith, so its card says it did not go.
    expect(mockReplyCard.mock.calls).toEqual([[DM, "failed"]]);
  });

  test("never answers into a public room", () => {
    act({ kind: "reply", channel: "#bluetooth", text: "hi" });
    expect(mockSendChannel).not.toHaveBeenCalled();
  });

  test("goes to a group still held, and not to one since left", () => {
    const channel = "group:aabb";
    act({ kind: "reply", channel, text: "hi" });
    expect(mockSendGroup).not.toHaveBeenCalled();
    expect(useChatStore.getState().channels).not.toContain(channel);

    useGroupStore.setState({
      groups: [{ groupID: "aabb" } as never],
    });
    act({ kind: "reply", channel, text: "hi" });
    expect(mockSendGroup).toHaveBeenCalledTimes(1);
    expect(rows(channel)[0].status).toBe("sent");
  });

  // Blocking from a room bubble leaves the DM thread, and its card, behind.
  test("does not answer a peer blocked since the card was posted", () => {
    useBlockedStore.getState().blockPeer(PEER);

    act({ kind: "reply", channel: DM, text: "hi" });
    act({ kind: "read", channel: DM });

    expect(mockSendDm).not.toHaveBeenCalled();
    expect(mockReceipts).not.toHaveBeenCalled();
    expect(rows(DM)).toEqual([]);
    expect(mockReplyCard).toHaveBeenCalledWith(DM, "failed");
  });

  // A room sender blocked by their Nostr key whose DM thread has since been
  // folded into a peer the block does not name.
  test("does not answer a card whose own sender is blocked, whatever it folds into", () => {
    const alias = "nostr_" + "ab".repeat(32);
    useChatStore.setState({ channelRedirects: { [`dm:${alias}`]: DM } });
    useBlockedStore.getState().blockPeer(alias);

    act({ kind: "reply", channel: `dm:${alias}`, text: "hi" });

    expect(mockSendDm).not.toHaveBeenCalled();
    expect(rows(DM)).toEqual([]);
  });

  // Nobody is watching the thread turn red, so the card says it instead.
  test("says once when a private channel reply reaches nobody", () => {
    const channel = "#secret";
    useChatStore.setState({ channelKeys: { [channel]: "a2V5" } });

    act({ kind: "reply", channel, text: "hi" });

    expect(rows(channel)[0].status).toBe("failed");
    expect(mockReplyCard).toHaveBeenCalledTimes(1);
    expect(mockReplyCard).toHaveBeenCalledWith(channel, "failed");
  });

  // Stamped when it goes, as its wire copy is, so a thread cleared in between
  // cannot swallow it.
  test("stamps a held reply when it is sent", () => {
    const before = Date.now();
    handleQuickAction({
      kind: "reply",
      channel: DM,
      text: "hi",
      atMs: before - 60_000,
    });
    expect(rows(DM)[0].timestampMs).toBeGreaterThanOrEqual(before);
  });
});

describe("Mark as read", () => {
  test("clears the unread count and acknowledges, nothing else", () => {
    useChatStore.setState({ unreadCounts: { [DM]: 2 } });

    act({ kind: "read", channel: DM });

    expect(useChatStore.getState().unreadCounts[DM]).toBe(0);
    expect(mockReceipts).toHaveBeenCalledWith(PEER);
    // Receipts and rings go together, as when the thread opens.
    expect(mockAckRings).toHaveBeenCalledWith(DM, PEER);
    expect(mockSendDm).not.toHaveBeenCalled();
  });
});
