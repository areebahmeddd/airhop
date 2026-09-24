/**
 * @jest-environment node
 */
// The tray side of notifications that does not depend on the policy: where a
// tap goes when no screen is mounted, and what "Hide previews" clears.

let mockResponseListener: ((r: unknown) => void) | null = null;
const mockDismiss = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
let mockPresented: { request: { identifier: string } }[] = [];

jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve()),
  deleteNotificationChannelAsync: jest.fn(() => Promise.resolve()),
  addNotificationResponseReceivedListener: (fn: (r: unknown) => void) => {
    mockResponseListener = fn;
    return { remove: jest.fn() };
  },
  getLastNotificationResponse: () => null,
  getPresentedNotificationsAsync: () => Promise.resolve(mockPresented),
  dismissNotificationAsync: (id: string) => mockDismiss(id),
  dismissAllNotificationsAsync: jest.fn(() => Promise.resolve()),
  cancelAllScheduledNotificationsAsync: jest.fn(() => Promise.resolve()),
  cancelScheduledNotificationAsync: jest.fn(() => Promise.resolve()),
  setBadgeCountAsync: jest.fn(() => Promise.resolve()),
  AndroidImportance: { HIGH: 4, LOW: 2, MAX: 5 },
  AndroidNotificationVisibility: { PRIVATE: 0, PUBLIC: 1 },
}));
jest.mock("react-native", () => ({ Platform: { OS: "android" } }));
jest.mock("@i18n", () => ({ t: (key: string) => key }));
jest.mock("@platform/haptics", () => ({ succeeded: jest.fn() }));
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
jest.mock("../notification-policy", () => ({}));

import {
  configureNotifications,
  dismissAllNotifications,
  dismissPreviewNotifications,
  setMeshNavigator,
  setNotificationNavigator,
} from "../notification-service";

function tap(data: Record<string, unknown>): void {
  mockResponseListener?.({
    notification: { request: { identifier: "n", content: { data } } },
  });
}

beforeAll(async () => {
  await configureNotifications();
});

beforeEach(() => {
  mockDismiss.mockClear();
  setNotificationNavigator(null);
  setMeshNavigator(null);
});

describe("a tapped notification with no screen mounted", () => {
  // The mesh outlives the UI on Android, and a boot start never had one. The
  // tap launches the Activity, whose tree registers a navigator moments later.
  test("is held until a navigator registers, then routed once", () => {
    tap({ channel: "dm:abc" });

    const navigate = jest.fn();
    setNotificationNavigator(navigate);
    expect(navigate).toHaveBeenCalledWith("dm:abc");

    setNotificationNavigator(navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  test("a nearby notice waits for the mesh navigator the same way", () => {
    tap({ screen: "mesh" });

    const openMesh = jest.fn();
    setMeshNavigator(openMesh);
    expect(openMesh).toHaveBeenCalledTimes(1);
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
  test("clears message and ring cards, and leaves the nearby notice", async () => {
    mockPresented = [
      { request: { identifier: "msg_dm_abc" } },
      { request: { identifier: "ring_dm_abc" } },
      { request: { identifier: "nearby_peers" } },
    ];

    await dismissPreviewNotifications();

    expect(mockDismiss.mock.calls.map((c) => c[0]).sort()).toEqual([
      "msg_dm_abc",
      "ring_dm_abc",
    ]);
  });
});
