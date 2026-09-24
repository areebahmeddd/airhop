/**
 * @jest-environment node
 */
// The module-level listeners that raise notifications with or without a
// screen. Every path that brings a mesh up starts them, so a second start must
// not double every banner, and the panic wipe must be able to silence them.

import type { ChatMessage } from "@store/chat-store";

type Listener<T> = (value: T) => void;

const mockHandleInbound = jest.fn();
const mockHandleNearby = jest.fn();
const mockRaiseRing = jest.fn();
const mockSetBadge = jest.fn();
const mockSetAppActive = jest.fn();
const mockConfigure = jest.fn();
const mockEndAllRings = jest.fn();
let mockReading = false;
let mockAppActive = false;

const mockMessageListeners = new Set<Listener<ChatMessage>>();
const mockRingListeners = new Set<Listener<unknown>>();
const mockChatSubs = new Set<() => void>();
const mockPeerSubs = new Set<(s: unknown, p: unknown) => void>();
const mockAppStateSubs = new Set<Listener<string>>();
let mockChat = {
  mutedChannels: [] as string[],
  unreadCounts: {} as Record<string, number>,
  activeChannel: "",
};
const mockRecord = jest.fn();
const mockShowRing = jest.fn();

jest.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: {
    currentState: "background",
    addEventListener: (_: string, fn: Listener<string>) => {
      mockAppStateSubs.add(fn);
      return { remove: () => mockAppStateSubs.delete(fn) };
    },
  },
}));
jest.mock("@platform/haptics", () => ({ ringPulse: jest.fn() }));
jest.mock("@store/activity-store", () => ({
  useActivityStore: { getState: () => ({ record: mockRecord }) },
}));
jest.mock("@store/chat-store", () => ({
  subscribeInboundMessages: (fn: Listener<ChatMessage>) => {
    mockMessageListeners.add(fn);
    return () => mockMessageListeners.delete(fn);
  },
  useChatStore: {
    getState: () => mockChat,
    subscribe: (fn: () => void) => {
      mockChatSubs.add(fn);
      return () => mockChatSubs.delete(fn);
    },
  },
}));
jest.mock("@store/incoming-ring-store", () => ({
  useIncomingRingStore: { getState: () => ({ show: mockShowRing }) },
}));
jest.mock("@store/peer-store", () => ({
  countReachablePeers: (peers: Record<string, unknown>) =>
    Object.keys(peers).length,
  usePeerStore: {
    subscribe: (fn: (s: unknown, p: unknown) => void) => {
      mockPeerSubs.add(fn);
      return () => mockPeerSubs.delete(fn);
    },
  },
}));
jest.mock("@store/ring-store", () => ({
  subscribeInboundRings: (fn: Listener<unknown>) => {
    mockRingListeners.add(fn);
    return () => mockRingListeners.delete(fn);
  },
}));
jest.mock("@utils/message-preview", () => ({
  messagePreviewEntry: () => ({ previewText: "hi" }),
}));
jest.mock("@utils/message-text", () => ({
  systemPreview: () => ({ previewKey: "chat.ring.received_summary" }),
}));
jest.mock("../notification-service", () => ({
  configureNotifications: () => mockConfigure(),
  endAllRingAlerts: () => mockEndAllRings(),
  handleInboundMessage: (...args: unknown[]) => mockHandleInbound(...args),
  handleNearbyPeers: (...args: unknown[]) => mockHandleNearby(...args),
  isAppActive: () => mockAppActive,
  isReadingChannel: () => mockReading,
  raiseRingNotification: (...args: unknown[]) => mockRaiseRing(...args),
  setAppBadgeCount: (n: number) => mockSetBadge(n),
  setNotificationsAppActive: (a: boolean) => mockSetAppActive(a),
}));

import { useSettingsStore } from "@store/settings-store";
import {
  startNotificationPipeline,
  stopNotificationPipeline,
} from "../notification-pipeline";

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    channel: "#mesh",
    senderID: "b0b0b0b0b0b0b0b0",
    senderNickname: "bob",
    text: "hello",
    timestampMs: 1,
    isMine: false,
    isSystem: false,
    ...over,
  } as ChatMessage;
}

function arrive(msg: ChatMessage): void {
  for (const fn of mockMessageListeners) fn(msg);
}

beforeEach(() => {
  stopNotificationPipeline();
  jest.clearAllMocks();
  mockChat = { mutedChannels: [], unreadCounts: {}, activeChannel: "" };
  mockReading = false;
  mockAppActive = false;
  useSettingsStore.setState({ ringAlertsEnabled: true });
});

describe("startNotificationPipeline", () => {
  test("a second start does not stack listeners", () => {
    startNotificationPipeline(() => "alice");
    startNotificationPipeline(() => "alice");

    arrive(message());

    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockMessageListeners.size).toBe(1);
    expect(mockRingListeners.size).toBe(1);
    expect(mockPeerSubs.size).toBe(1);
    expect(mockAppStateSubs.size).toBe(1);
  });

  // A boot start has no screen to say the app is in front, and the service
  // assumes it is: left alone, no background banner would ever be raised.
  test("tracks whether the app is in front by itself", () => {
    startNotificationPipeline(() => "alice");
    expect(mockSetAppActive).toHaveBeenLastCalledWith(false);

    for (const fn of mockAppStateSubs) fn("active");
    expect(mockSetAppActive).toHaveBeenLastCalledWith(true);
  });

  test("a muted conversation stays silent unless it names the user", () => {
    mockChat.mutedChannels = ["#mesh"];
    startNotificationPipeline(() => "alice");

    arrive(message({ text: "anyone around?" }));
    expect(mockHandleInbound).not.toHaveBeenCalled();

    arrive(message({ id: "m2", text: "@alice are you there" }));
    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
    expect(mockHandleInbound.mock.calls[0][2]).toBe(true);
  });

  test("reads the mute list and the open thread when a message arrives", () => {
    startNotificationPipeline(() => "alice");
    mockChat = { ...mockChat, activeChannel: "#mesh" };

    arrive(message());

    // Raised (the service decides between banner and haptic), but not logged
    // in the bell for the thread being read.
    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test("the latest start's nickname is the one a mention is matched against", () => {
    mockChat.mutedChannels = ["#mesh"];
    startNotificationPipeline(() => "alice");
    startNotificationPipeline(() => "carol");

    arrive(message({ text: "@alice hi" }));
    arrive(message({ id: "m2", text: "@carol hi" }));

    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
  });

  test("keeps the icon badge at total unread, writing only on a change", () => {
    startNotificationPipeline(() => "alice");
    expect(mockSetBadge).toHaveBeenLastCalledWith(0);
    mockSetBadge.mockClear();

    mockChat = { ...mockChat, unreadCounts: { "#mesh": 2, "dm:x": 1 } };
    for (const fn of mockChatSubs) fn();
    for (const fn of mockChatSubs) fn();

    expect(mockSetBadge).toHaveBeenCalledTimes(1);
    expect(mockSetBadge).toHaveBeenCalledWith(3);
  });

  test("a ring with the app in the background reaches the tray", () => {
    startNotificationPipeline(() => "alice");
    const ring = {
      peerID: "b0b0b0b0b0b0b0b0",
      senderName: "bob",
      ringID: "r1",
      receivedAtMs: 1,
    };

    for (const fn of mockRingListeners) fn(ring);

    expect(mockShowRing).toHaveBeenCalledWith(ring);
    expect(mockRaiseRing).toHaveBeenCalledWith(ring.peerID, "bob");
  });

  // On iOS a ring is pulses already handed to the OS, which the mesh's own
  // teardown of the overlay cannot reach.
  test("switching ring alerts off ends the rings already with the OS", () => {
    startNotificationPipeline(() => "alice");

    useSettingsStore.setState({ ringAlertsEnabled: true });
    expect(mockEndAllRings).not.toHaveBeenCalled();
    useSettingsStore.setState({ ringAlertsEnabled: false });
    expect(mockEndAllRings).toHaveBeenCalledTimes(1);
    useSettingsStore.setState({ ringAlertsEnabled: false });
    expect(mockEndAllRings).toHaveBeenCalledTimes(1);
  });

  test("configures channels and the handler, for a start with no screen", () => {
    startNotificationPipeline(() => "alice");
    expect(mockConfigure).toHaveBeenCalled();
  });
});

describe("stopNotificationPipeline", () => {
  test("removes every listener, and a later start brings them back once", () => {
    startNotificationPipeline(() => "alice");
    stopNotificationPipeline();

    expect(mockMessageListeners.size).toBe(0);
    expect(mockRingListeners.size).toBe(0);
    expect(mockPeerSubs.size).toBe(0);
    expect(mockChatSubs.size).toBe(0);
    expect(mockAppStateSubs.size).toBe(0);
    arrive(message());
    expect(mockHandleInbound).not.toHaveBeenCalled();

    startNotificationPipeline(() => "alice");
    arrive(message());
    expect(mockHandleInbound).toHaveBeenCalledTimes(1);
  });

  test("is safe when nothing is running", () => {
    expect(() => stopNotificationPipeline()).not.toThrow();
  });
});
