// The snapshot behind the background notice and the home screen widget: the
// reachable count, whether the mesh runs, whether Bluetooth is off, and when.
// Pushed once per settled burst and when the mesh or Bluetooth changes, never
// for an unchanged reading except the once-a-minute refresh that keeps its time
// current, and repeated on leaving the screen. On iOS, where every push reloads
// the widget against a daily budget, the app in the background pushes at most
// every ten minutes.

const mockSetSnapshot = jest.fn<
  Promise<void>,
  [number, boolean, boolean, number]
>(() => Promise.resolve());
const mockClearSnapshot = jest.fn<Promise<void>, []>(() => Promise.resolve());

jest.mock("@bridge/NativeAirhopApp", () => ({
  __esModule: true,
  default: {
    setMeshSnapshot: (
      count: number,
      meshOn: boolean,
      bluetoothOff: boolean,
      atMs: number,
    ) => mockSetSnapshot(count, meshOn, bluetoothOff, atMs),
    clearMeshSnapshot: () => mockClearSnapshot(),
    openBackgroundNoticeSettings: () => Promise.resolve(true),
  },
}));

import { useMeshStateStore } from "@store/mesh-state-store";
import { REACHABLE_TTL_MS, usePeerStore } from "@store/peer-store";
import { AppState, Platform, type AppStateStatus } from "react-native";
import {
  clearBackgroundNotice,
  startBackgroundNotice,
  stopBackgroundNotice,
} from "../background-notice";

function addPeer(peerID: string): void {
  usePeerStore.getState().upsertPeer({
    peerID,
    nickname: peerID,
    lastSeenMs: Date.now(),
    noisePubKeyHex: "00".repeat(32),
  });
}

// The pushes as [count, meshOn], and the rest on their own.
const readings = (): [number, boolean][] =>
  mockSetSnapshot.mock.calls.map(([count, meshOn]) => [count, meshOn]);
const lastBluetoothOff = (): boolean | undefined =>
  mockSetSnapshot.mock.lastCall?.[2];
const lastAt = (): number | undefined => mockSetSnapshot.mock.lastCall?.[3];

let onAppState: ((state: AppStateStatus) => void) | undefined;
const removeAppState = jest.fn();
// The jest preset stubs currentState with a function, so the tests set it here.
let appStateNow: AppStateStatus = "active";

beforeAll(() => {
  Object.defineProperty(AppState, "currentState", {
    configurable: true,
    get: () => appStateNow,
  });
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_type, listener) => {
      onAppState = listener;
      return { remove: removeAppState };
    });
  jest.useFakeTimers({ now: 1_800_000_000_000 });
  jest.replaceProperty(Platform, "OS", "android");
});

beforeEach(() => {
  stopBackgroundNotice();
  jest.replaceProperty(Platform, "OS", "android");
  appStateNow = "active";
  usePeerStore.getState().clearAll();
  useMeshStateStore.setState({ bleBlocker: "none" });
  useMeshStateStore.getState().setPresenceStatus("online");
  mockSetSnapshot.mockClear();
  mockSetSnapshot.mockImplementation(() => Promise.resolve());
  removeAppState.mockClear();
  startBackgroundNotice();
});

afterAll(() => {
  stopBackgroundNotice();
  jest.useRealTimers();
});

it("pushes the settled reachable count, and only when it moves", () => {
  expect(readings()).toEqual([[0, true]]);
  expect(lastAt()).toBe(Date.now());

  // A burst becomes one push of where it ended.
  addPeer("aaaaaaaaaaaaaaaa");
  addPeer("bbbbbbbbbbbbbbbb");
  addPeer("cccccccccccccccc");
  expect(mockSetSnapshot).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1_000);
  expect(readings()).toEqual([
    [0, true],
    [3, true],
  ]);

  // A change that leaves the count alone sends nothing.
  addPeer("aaaaaaaaaaaaaaaa");
  jest.advanceTimersByTime(1_000);
  expect(mockSetSnapshot).toHaveBeenCalledTimes(2);

  // All expire with no LEAVE and no store change; the recount catches it.
  jest.advanceTimersByTime(REACHABLE_TTL_MS + 15_000);
  expect(readings().at(-1)).toEqual([0, true]);

  // A second start stacks nothing.
  startBackgroundNotice();
  addPeer("dddddddddddddddd");
  jest.advanceTimersByTime(1_000);
  expect(readings().filter(([n]) => n === 1)).toHaveLength(1);
});

it("re-sends an unchanged reading once a minute, so its time stays current", () => {
  addPeer("aaaaaaaaaaaaaaaa");
  jest.advanceTimersByTime(1_000);
  const counted = mockSetSnapshot.mock.calls.length;
  const at = lastAt()!;

  // The 15 s recounts in between find nothing new.
  jest.advanceTimersByTime(45_000);
  addPeer("aaaaaaaaaaaaaaaa");
  jest.advanceTimersByTime(14_000);
  expect(mockSetSnapshot).toHaveBeenCalledTimes(counted);

  // The first recount a minute on sends the same count with a new time.
  jest.advanceTimersByTime(15_000);
  expect(mockSetSnapshot).toHaveBeenCalledTimes(counted + 1);
  expect(readings().at(-1)).toEqual([1, true]);
  expect(lastAt()! - at).toBeGreaterThanOrEqual(60_000);
  expect(lastAt()).toBe(Date.now());
});

it("replaces the reading at once when the clock is set back", () => {
  addPeer("aaaaaaaaaaaaaaaa");
  jest.advanceTimersByTime(1_000);
  const counted = mockSetSnapshot.mock.calls.length;

  // An hour back. Waiting for a minute of age would take an hour, with the
  // widget hiding a reading it sees as from the future the whole time.
  jest.setSystemTime(Date.now() - 3_600_000);
  addPeer("aaaaaaaaaaaaaaaa");
  jest.advanceTimersByTime(1_000);
  expect(mockSetSnapshot).toHaveBeenCalledTimes(counted + 1);
  expect(lastAt()).toBe(Date.now());
  expect(readings().at(-1)).toEqual([1, true]);

  // And from there it ages normally again.
  jest.advanceTimersByTime(30_000);
  expect(mockSetSnapshot).toHaveBeenCalledTimes(counted + 1);
});

it("says the mesh is paused within a second of going Away, and back on return", () => {
  addPeer("aaaaaaaaaaaaaaaa");
  jest.advanceTimersByTime(1_000);

  useMeshStateStore.getState().setPresenceStatus("away");
  jest.advanceTimersByTime(1_000);
  expect(readings().at(-1)).toEqual([1, false]);

  // Invisible still runs the mesh.
  useMeshStateStore.getState().setPresenceStatus("invisible");
  jest.advanceTimersByTime(1_000);
  expect(readings().at(-1)).toEqual([1, true]);

  // Nothing else in the store pushes.
  const before = mockSetSnapshot.mock.calls.length;
  useMeshStateStore.setState({ nostrConnected: true });
  jest.advanceTimersByTime(1_000);
  expect(mockSetSnapshot).toHaveBeenCalledTimes(before);
});

it("repeats the reading on leaving the screen, and only then", () => {
  addPeer("eeeeeeeeeeeeeeee");
  jest.advanceTimersByTime(1_000);

  const before = mockSetSnapshot.mock.calls.length;
  onAppState?.("inactive");
  onAppState?.("active");
  expect(mockSetSnapshot).toHaveBeenCalledTimes(before);

  jest.advanceTimersByTime(2_000);
  onAppState?.("background");
  expect(mockSetSnapshot).toHaveBeenCalledTimes(before + 1);
  expect(readings().at(-1)).toEqual([1, true]);
  expect(lastAt()).toBe(Date.now());
});

it("retries a push the native side refused, unchanged or not", () => {
  mockSetSnapshot.mockClear();
  mockSetSnapshot.mockImplementationOnce(() =>
    Promise.reject(new Error("refused")),
  );
  addPeer("aaaaaaaaaaaaaaaa");
  jest.advanceTimersByTime(1_000);
  expect(mockSetSnapshot).toHaveBeenCalledTimes(1);

  // Let the rejection land, then the next recount sends it again.
  return Promise.resolve().then(() => {
    jest.advanceTimersByTime(15_000);
    expect(mockSetSnapshot).toHaveBeenCalledTimes(2);
    expect(readings().at(-1)).toEqual([1, true]);
  });
});

it("stops pushing entirely once stopped, and starts again for the next mesh", () => {
  stopBackgroundNotice();
  const before = mockSetSnapshot.mock.calls.length;
  expect(removeAppState).toHaveBeenCalledTimes(1);

  // A burst already waiting to settle is dropped with the rest.
  addPeer("aaaaaaaaaaaaaaaa");
  useMeshStateStore.getState().setPresenceStatus("away");
  jest.advanceTimersByTime(10 * 60_000);
  expect(mockSetSnapshot).toHaveBeenCalledTimes(before);

  startBackgroundNotice();
  expect(mockSetSnapshot).toHaveBeenCalledTimes(before + 1);
  expect(readings().at(-1)).toEqual([0, false]);
});

it("clears through the native module", async () => {
  await clearBackgroundNotice();
  expect(mockClearSnapshot).toHaveBeenCalledTimes(1);
});

it("says Bluetooth is off within a second of it going off, and back on", () => {
  useMeshStateStore.setState({ bleBlocker: "adapter-off" });
  jest.advanceTimersByTime(1_000);
  expect(lastBluetoothOff()).toBe(true);

  // Any other blocker is not this state.
  useMeshStateStore.setState({ bleBlocker: "starting" });
  jest.advanceTimersByTime(1_000);
  expect(lastBluetoothOff()).toBe(false);
});

describe("on iOS", () => {
  beforeEach(() => {
    stopBackgroundNotice();
    jest.replaceProperty(Platform, "OS", "ios");
    startBackgroundNotice();
    mockSetSnapshot.mockClear();
  });

  it("pushes as Android does while the app is in front, where reloads are free", () => {
    addPeer("aaaaaaaaaaaaaaaa");
    jest.advanceTimersByTime(1_000);
    expect(readings()).toEqual([[1, true]]);
    jest.advanceTimersByTime(75_000);
    expect(mockSetSnapshot).toHaveBeenCalledTimes(2);
  });

  it("in the background, holds a changed count to one push in ten minutes", () => {
    appStateNow = "background";
    onAppState?.("background");
    expect(readings()).toEqual([[0, true]]);

    // Two people arrive and keep announcing every 30 s, as a real room does.
    const announce = (seconds: number): void => {
      for (let t = 0; t < seconds; t += 30) {
        addPeer("aaaaaaaaaaaaaaaa");
        addPeer("bbbbbbbbbbbbbbbb");
        jest.advanceTimersByTime(30_000);
      }
    };
    announce(9 * 60 + 30);
    expect(mockSetSnapshot).toHaveBeenCalledTimes(1);

    // Past ten minutes the count that moved goes out, once.
    announce(60);
    expect(readings()).toEqual([
      [0, true],
      [2, true],
    ]);
  });

  it("never holds back the mesh pausing or Bluetooth going off", () => {
    appStateNow = "background";
    onAppState?.("background");
    const before = mockSetSnapshot.mock.calls.length;

    useMeshStateStore.setState({ bleBlocker: "adapter-off" });
    jest.advanceTimersByTime(1_000);
    expect(mockSetSnapshot).toHaveBeenCalledTimes(before + 1);
    expect(lastBluetoothOff()).toBe(true);

    useMeshStateStore.getState().setPresenceStatus("away");
    jest.advanceTimersByTime(1_000);
    expect(mockSetSnapshot).toHaveBeenCalledTimes(before + 2);
    expect(readings().at(-1)).toEqual([0, false]);
  });
});
