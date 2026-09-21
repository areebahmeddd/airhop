/** @jest-environment node */
import type * as Network from "expo-network";

const mockOnNetworkChanged = jest.fn();
const mockRevalidateTor = jest.fn(async () => undefined);
jest.mock("../mesh-service", () => ({
  getMeshService: () => ({ onNetworkChanged: mockOnNetworkChanged }),
}));
jest.mock("../tor-routing", () => ({
  revalidateTorRouting: () => mockRevalidateTor(),
}));

type NetworkMock = typeof Network & {
  emit: (state: Network.NetworkState) => void;
  getNetworkStateAsync: jest.Mock;
  addNetworkStateListener: jest.Mock;
};

const WIFI: Network.NetworkState = { type: "WIFI" as never, isConnected: true };
const CELL: Network.NetworkState = {
  type: "CELLULAR" as never,
  isConnected: true,
};
const NONE: Network.NetworkState = {
  type: "NONE" as never,
  isConnected: false,
};

// Module state is per watch, so every test gets a fresh module.
let net: NetworkMock;
let start: () => void;

async function watch(
  initial: Network.NetworkState | null = WIFI,
): Promise<void> {
  jest.isolateModules(() => {
    net = require("expo-network") as NetworkMock;
    start = (require("../reachability") as typeof import("../reachability"))
      .startReachabilityWatch;
  });
  net.getNetworkStateAsync.mockImplementationOnce(() =>
    initial === null ? new Promise(() => undefined) : Promise.resolve(initial),
  );
  start();
  await Promise.resolve();
}

function emit(state: Network.NetworkState): void {
  net.emit(state);
}

beforeEach(() => {
  jest.useFakeTimers();
  mockOnNetworkChanged.mockClear();
  mockRevalidateTor.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

test("a network coming back nudges the mesh and Tor once, after it settles", async () => {
  await watch(WIFI);
  emit(NONE);
  jest.advanceTimersByTime(3_000);
  expect(mockOnNetworkChanged).not.toHaveBeenCalled();

  emit(WIFI);
  jest.advanceTimersByTime(2_000);
  expect(mockOnNetworkChanged).not.toHaveBeenCalled();
  jest.advanceTimersByTime(600);
  expect(mockOnNetworkChanged).toHaveBeenCalledTimes(1);
  expect(mockRevalidateTor).toHaveBeenCalledTimes(1);
});

test("a flap inside the window is one event, not several", async () => {
  await watch(WIFI);
  emit(NONE);
  jest.advanceTimersByTime(3_000);
  for (let i = 0; i < 5; i++) {
    emit(WIFI);
    jest.advanceTimersByTime(500);
    emit(NONE);
    jest.advanceTimersByTime(500);
  }
  emit(WIFI);
  jest.advanceTimersByTime(3_000);
  expect(mockOnNetworkChanged).toHaveBeenCalledTimes(1);
});

test("a handoff between two live networks nudges", async () => {
  await watch(WIFI);
  emit(CELL);
  jest.advanceTimersByTime(3_000);
  expect(mockOnNetworkChanged).toHaveBeenCalledTimes(1);
});

test("the same network reported again is not a change", async () => {
  await watch(WIFI);
  emit(WIFI);
  jest.advanceTimersByTime(3_000);
  expect(mockOnNetworkChanged).not.toHaveBeenCalled();
});

test("losing the network is never acted on", async () => {
  await watch(WIFI);
  emit(NONE);
  jest.advanceTimersByTime(3_000);
  expect(mockOnNetworkChanged).not.toHaveBeenCalled();
  expect(mockRevalidateTor).not.toHaveBeenCalled();
});

// The pool is being built at launch; the first reading is a baseline only.
test("the first reading after launch never nudges", async () => {
  await watch(null);
  emit(WIFI);
  jest.advanceTimersByTime(3_000);
  expect(mockOnNetworkChanged).not.toHaveBeenCalled();
  emit(CELL);
  jest.advanceTimersByTime(3_000);
  expect(mockOnNetworkChanged).toHaveBeenCalledTimes(1);
});

test("starting twice subscribes once", async () => {
  await watch(WIFI);
  const before = net.addNetworkStateListener.mock.calls.length;
  start();
  expect(net.addNetworkStateListener.mock.calls.length).toBe(before);
});
