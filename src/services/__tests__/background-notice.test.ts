// The notice follows the reachable count: once per settled burst, never for
// an unchanged count, and on the recount when peers expire silently. Leaving
// the screen repeats it, so native can post a notice that went up while
// notifications were not yet allowed.

const mockSetCount = jest.fn<Promise<void>, [number]>(() => Promise.resolve());

jest.mock("@bridge/NativeAirhopBLE", () => ({
  __esModule: true,
  default: {
    setBackgroundPeerCount: (count: number) => mockSetCount(count),
  },
}));

import { REACHABLE_TTL_MS, usePeerStore } from "@store/peer-store";
import { AppState, Platform, type AppStateStatus } from "react-native";
import { startBackgroundNotice } from "../background-notice";

function addPeer(peerID: string): void {
  usePeerStore.getState().upsertPeer({
    peerID,
    nickname: peerID,
    lastSeenMs: Date.now(),
    noisePubKeyHex: "00".repeat(32),
  });
}

let onAppState: ((state: AppStateStatus) => void) | undefined;

beforeAll(() => {
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_type, listener) => {
      onAppState = listener;
      return { remove: () => undefined };
    });
  jest.useFakeTimers({ now: 1_800_000_000_000 });
  jest.replaceProperty(Platform, "OS", "android");
  usePeerStore.getState().clearAll();
  startBackgroundNotice();
});

afterAll(() => {
  jest.useRealTimers();
});

it("pushes the settled reachable count, and only when it moves", () => {
  expect(mockSetCount.mock.calls).toEqual([[0]]);

  // A burst becomes one push of where it ended.
  addPeer("aaaaaaaaaaaaaaaa");
  addPeer("bbbbbbbbbbbbbbbb");
  addPeer("cccccccccccccccc");
  expect(mockSetCount).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1_000);
  expect(mockSetCount.mock.calls).toEqual([[0], [3]]);

  // A change that leaves the count alone sends nothing.
  addPeer("aaaaaaaaaaaaaaaa");
  jest.advanceTimersByTime(1_000);
  expect(mockSetCount).toHaveBeenCalledTimes(2);

  // All expire with no LEAVE and no store change; the recount catches it.
  jest.advanceTimersByTime(REACHABLE_TTL_MS + 15_000);
  expect(mockSetCount).toHaveBeenLastCalledWith(0);

  // A second start stacks nothing.
  startBackgroundNotice();
  addPeer("dddddddddddddddd");
  jest.advanceTimersByTime(1_000);
  expect(mockSetCount.mock.calls.filter(([n]) => n === 1)).toHaveLength(1);
});

it("repeats the shown count on leaving the screen, and only then", () => {
  // Its own settled count of one, whatever the test above left behind.
  usePeerStore.getState().clearAll();
  addPeer("eeeeeeeeeeeeeeee");
  jest.advanceTimersByTime(1_000);

  const before = mockSetCount.mock.calls.length;
  onAppState?.("inactive");
  onAppState?.("active");
  expect(mockSetCount).toHaveBeenCalledTimes(before);

  onAppState?.("background");
  expect(mockSetCount).toHaveBeenCalledTimes(before + 1);
  expect(mockSetCount).toHaveBeenLastCalledWith(1);
});
