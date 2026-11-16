// The tray side of notifications that does not depend on the policy: where a
// tap goes, including when no screen is mounted, what Reply and Mark as read
// hand over, and what "Hide previews", the app lock and opening the Wallet
// clear.

let mockResponseListener: ((r: unknown) => void) | null = null;
const mockDismiss = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
let mockPresented: { request: { identifier: string } }[] = [];
let mockScheduled: { identifier: string }[] = [];
const mockCancelScheduled = jest.fn<Promise<void>, [string]>(() =>
  Promise.resolve(),
);
const mockSchedule = jest.fn<Promise<string>, [unknown]>(() =>
  Promise.resolve("id"),
);
const mockSetCategory = jest.fn<Promise<unknown>, [string, unknown]>(() =>
  Promise.resolve(null),
);
const mockClearLast = jest.fn();
let mockLanguage = "en";

jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve()),
  addNotificationResponseReceivedListener: (fn: (r: unknown) => void) => {
    mockResponseListener = fn;
    return { remove: jest.fn() };
  },
  getLastNotificationResponse: () => null,
  clearLastNotificationResponse: () => mockClearLast(),
  setNotificationCategoryAsync: (id: string, actions: unknown) =>
    mockSetCategory(id, actions),
  scheduleNotificationAsync: (request: unknown) => mockSchedule(request),
  getPresentedNotificationsAsync: () => Promise.resolve(mockPresented),
  dismissNotificationAsync: (id: string) => mockDismiss(id),
  dismissAllNotificationsAsync: jest.fn(() => Promise.resolve()),
  cancelAllScheduledNotificationsAsync: jest.fn(() => Promise.resolve()),
  getAllScheduledNotificationsAsync: () => Promise.resolve(mockScheduled),
  cancelScheduledNotificationAsync: (id: string) => mockCancelScheduled(id),
  setBadgeCountAsync: jest.fn(() => Promise.resolve()),
  AndroidImportance: { HIGH: 4, LOW: 2, MAX: 5 },
  AndroidNotificationVisibility: { PRIVATE: 0, PUBLIC: 1 },
}));
jest.mock("react-native", () => ({ Platform: { OS: "android" } }));
jest.mock("@i18n", () => ({
  t: (key: string) => key,
  getLanguage: () => mockLanguage,
}));
jest.mock("@platform/haptics", () => ({ arrived: jest.fn() }));
jest.mock("@platform/ring-alert", () => ({
  stopRingAlert: jest.fn(() => Promise.resolve()),
}));
jest.mock("@store/incoming-ring-store", () => ({
  useIncomingRingStore: {
    getState: () => ({ current: { peerID: "x" }, removeFor: jest.fn() }),
  },
}));
jest.mock("@store/ring-store", () => ({ RING_ALERT_DURATION_MS: 30_000 }));
jest.mock("@store/settings-store", () => ({
  useSettingsStore: { getState: () => ({ hideNotificationPreviews: true }) },
}));
jest.mock("@utils/conversation-display-name", () => ({
  channelLabel: (c: string) => c,
}));
jest.mock("../notification-policy", () => ({
  shouldHapticPing: () => false,
  shouldSystemNotify: () => true,
  notificationContentFor: () => ({ title: "title", body: "body" }),
}));

import type { ChatMessage } from "@store/chat-store";
import type { QuickAction } from "@store/held-quick-actions";
import {
  configureNotifications,
  dismissAllNotifications,
  dismissMessageNotifications,
  dismissPaymentNotifications,
  dismissPreviewNotifications,
  handleInboundMessage,
  notifyReply,
  setNotificationNavigator,
  setQuickActionHandler,
  setTabNavigator,
} from "../notification-service";

function tap(data: Record<string, unknown>): void {
  mockResponseListener?.({
    notification: { request: { identifier: "n", content: { data } } },
  });
}

// Each answer is its own response: a card re-posted is a new date.
let responseDate = 0;

function answer(
  actionIdentifier: string,
  data: Record<string, unknown>,
  userText?: string,
  date = ++responseDate,
): void {
  mockResponseListener?.({
    actionIdentifier,
    userText,
    notification: {
      date,
      request: { identifier: "msg_dm_abc", content: { data } },
    },
  });
}

// The tray's dismissal is awaited before an answer is handed over.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeAll(async () => {
  await configureNotifications();
});

beforeEach(() => {
  mockDismiss.mockClear();
  mockSchedule.mockClear();
  setNotificationNavigator(null);
  setTabNavigator(null);
  setQuickActionHandler(null);
});

describe("a tapped notification", () => {
  // With no screen mounted it waits: the mesh outlives the UI on Android, and a
  // boot start never had one. The tap launches the Activity, whose tree
  // registers a navigator moments later.
  test("is held until a navigator registers, then routed once", () => {
    tap({ channel: "dm:abc" });

    const navigate = jest.fn();
    setNotificationNavigator(navigate);
    expect(navigate).toHaveBeenCalledWith("dm:abc");

    setNotificationNavigator(navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  test("a nearby notice waits for the tab navigator the same way", () => {
    tap({ screen: "mesh" });

    const openTab = jest.fn();
    setTabNavigator(openTab);
    expect(openTab).toHaveBeenCalledWith("mesh");
  });

  test("a payment notice opens the wallet", () => {
    const openTab = jest.fn();
    setTabNavigator(openTab);

    tap({ screen: "wallet" });

    expect(openTab).toHaveBeenCalledWith("wallet");
  });

  test("goes straight through when a screen is up", () => {
    const navigate = jest.fn();
    setNotificationNavigator(navigate);

    tap({ channel: "#mesh" });

    expect(navigate).toHaveBeenCalledWith("#mesh");
  });

  test("a held tap does not outlive a panic wipe", async () => {
    tap({ channel: "dm:abc" });
    await dismissAllNotifications();

    const navigate = jest.fn();
    setNotificationNavigator(navigate);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("dismissPreviewNotifications", () => {
  test("clears message, ring and payment cards, and leaves the nearby notice", async () => {
    mockPresented = [
      { request: { identifier: "msg_dm_abc" } },
      { request: { identifier: "ring_dm_abc" } },
      { request: { identifier: "payment_1_1" } },
      { request: { identifier: "nearby_peers" } },
    ];

    await dismissPreviewNotifications();

    expect(mockDismiss.mock.calls.map((c) => c[0]).sort()).toEqual([
      "msg_dm_abc",
      "payment_1_1",
      "ring_dm_abc",
    ]);
  });

  // Each iOS pulse was scheduled with the sender's name in it.
  test("cancels the ring pulses still to come, and nothing else scheduled", async () => {
    mockPresented = [];
    mockScheduled = [
      { identifier: "ring_dm_abc_1" },
      { identifier: "ring_dm_abc_2" },
      { identifier: "something_else" },
    ];
    mockCancelScheduled.mockClear();

    await dismissPreviewNotifications();

    expect(mockCancelScheduled.mock.calls.map((c) => c[0]).sort()).toEqual([
      "ring_dm_abc_1",
      "ring_dm_abc_2",
    ]);
  });
});

describe("opening the Wallet", () => {
  // Like a conversation's notices when it opens: once the Wallet is up, the
  // payments are in its Activity.
  test("clears payment notices and nothing else", async () => {
    mockPresented = [
      { request: { identifier: "payment_1_1" } },
      { request: { identifier: "payment_1_2" } },
      { request: { identifier: "msg_dm_abc" } },
    ];

    await dismissPaymentNotifications();

    expect(mockDismiss.mock.calls.map((c) => c[0]).sort()).toEqual([
      "payment_1_1",
      "payment_1_2",
    ]);
  });
});

describe("Reply and Mark as read", () => {
  test("hand the answer over without opening the chat", async () => {
    const navigate = jest.fn();
    setNotificationNavigator(navigate);
    const handle = jest.fn<void, [QuickAction]>();
    setQuickActionHandler(handle);

    answer("reply", { channel: "dm:abc" }, "on my way");
    answer("mark_read", { channel: "dm:abc" });
    await settle();

    expect(handle.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({
        kind: "reply",
        channel: "dm:abc",
        text: "on my way",
      }),
      expect.objectContaining({ kind: "read", channel: "dm:abc" }),
    ]);
    expect(navigate).not.toHaveBeenCalled();
    // Android keeps a replied card spinning until it is taken down.
    expect(mockDismiss).toHaveBeenCalledWith("msg_dm_abc");
  });

  // An iOS reply can launch the app in the background before the mesh is up,
  // and the process can end before it is; the answer waits on disk.
  test("wait for a handler, then run once", async () => {
    answer("reply", { channel: "dm:abc" }, "hi");
    await settle();

    const handle = jest.fn<void, [QuickAction]>();
    setQuickActionHandler(handle);
    setQuickActionHandler(handle);

    expect(handle).toHaveBeenCalledTimes(1);
  });

  // A cold start can hand one response to the listener and the last-response
  // read alike.
  test("act once on a response delivered twice", async () => {
    const handle = jest.fn<void, [QuickAction]>();
    setQuickActionHandler(handle);

    answer("reply", { channel: "dm:abc" }, "hi", 900);
    answer("reply", { channel: "dm:abc" }, "hi", 900);
    await settle();

    expect(handle).toHaveBeenCalledTimes(1);
    expect(mockClearLast).toHaveBeenCalled();
  });

  // The card it was typed into is gone, so another says it has not sent, and
  // that one goes once the reply does.
  test("a held reply says it is waiting, until it runs", async () => {
    answer("reply", { channel: "dm:abc" }, "hi");
    await settle();
    const posted = mockSchedule.mock.calls.at(-1)?.[0] as {
      identifier: string;
    };
    expect(posted.identifier).toBe("held_dm_abc");

    setQuickActionHandler(jest.fn());
    expect(mockDismiss).toHaveBeenCalledWith("held_dm_abc");
  });

  test("a held answer does not outlive a panic wipe", async () => {
    answer("reply", { channel: "dm:abc" }, "hi");
    await settle();
    await dismissAllNotifications();

    const handle = jest.fn<void, [QuickAction]>();
    setQuickActionHandler(handle);
    expect(handle).not.toHaveBeenCalled();
  });
});

describe("a message card", () => {
  const msg = { channel: "dm:abc", isMine: false } as ChatMessage;

  const lastContent = (): Record<string, unknown> =>
    (
      mockSchedule.mock.calls.at(-1)?.[0] as {
        content: Record<string, unknown>;
      }
    ).content;

  test("carries the buttons only when offered, registered once per language", async () => {
    mockSetCategory.mockClear();

    await handleInboundMessage(msg, 1, false, true);
    expect(lastContent().categoryIdentifier).toBe("message");
    await handleInboundMessage(msg, 1, false, true);
    expect(mockSetCategory).toHaveBeenCalledTimes(1);

    await handleInboundMessage(msg, 1, false, false);
    expect(lastContent().categoryIdentifier).toBeUndefined();

    mockLanguage = "de";
    await handleInboundMessage(msg, 1, false, true);
    expect(mockSetCategory).toHaveBeenCalledTimes(2);
    mockLanguage = "en";
  });

  test("says when a reply typed into it did not go out, and opens its chat", async () => {
    await notifyReply("dm:abc", "failed");

    const request = mockSchedule.mock.calls.at(-1)?.[0] as {
      identifier: string;
      content: { data: unknown };
    };
    expect(request.identifier).toBe("msg_dm_abc");
    expect(request.content.data).toEqual({ channel: "dm:abc" });
  });

  // Their Reply and Mark as read would act past the lock.
  test("is taken down when the app lock is switched on, and nothing else is", async () => {
    mockPresented = [
      { request: { identifier: "msg_dm_abc" } },
      { request: { identifier: "payment_1_1" } },
      { request: { identifier: "ring_dm_abc" } },
    ];

    await dismissMessageNotifications();

    expect(mockDismiss.mock.calls.map((c) => c[0])).toEqual(["msg_dm_abc"]);
  });
});
