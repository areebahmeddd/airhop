/**
 * @jest-environment node
 */
// The headless task Android runs after a reboot, with no Activity and no UI.
// It may only ever start the identity the user still has, and has to bring up
// what a running mesh owes the user with nobody looking: notifications.

const mockRegisterHeadlessTask = jest.fn();
const mockLoadIdentity = jest.fn();
const mockHasBlePermissions = jest.fn<Promise<boolean>, []>();
const mockInitMeshService = jest.fn();
const mockRetryRadios = jest.fn();
let mockMesh: { peerID: string; retryRadios: jest.Mock } | null = null;
const mockPrimeTor = jest.fn();
const mockStartPipeline = jest.fn();
const mockStartReachability = jest.fn();
const mockSweepMedia = jest.fn();
let mockWipePending = false;
let mockSettings = { autoStartOnBoot: true, backgroundMeshEnabled: true };

jest.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppRegistry: {
    registerHeadlessTask: (key: string, factory: () => unknown) =>
      mockRegisterHeadlessTask(key, factory),
  },
}));
jest.mock("@core/crypto/identity", () => ({
  loadIdentity: () => mockLoadIdentity(),
}));
jest.mock("@platform/ble-permissions", () => ({
  hasBlePermissions: () => mockHasBlePermissions(),
}));
jest.mock("@services/mesh-service", () => ({
  getMeshService: () => mockMesh,
  initMeshService: (identity: { peerID: string }, nickname: string) => {
    mockInitMeshService(identity, nickname);
    mockMesh = { peerID: identity.peerID, retryRadios: mockRetryRadios };
    return mockMesh;
  },
}));
jest.mock("@services/tor-routing", () => ({
  primeTorRoutingOnStartup: () => mockPrimeTor(),
}));
jest.mock("@store/settings-store", () => ({
  useSettingsStore: { getState: () => mockSettings },
}));
jest.mock("../boot-sync", () => ({ syncAutoStartOnBoot: jest.fn() }));
jest.mock("../notification-pipeline", () => ({
  startNotificationPipeline: (nickname: () => string) =>
    mockStartPipeline(nickname),
}));
jest.mock("../reachability", () => ({
  startReachabilityWatch: () => mockStartReachability(),
}));
jest.mock("../media-retention", () => ({
  sweepMediaIfDue: () => mockSweepMedia(),
}));
jest.mock("../wipe-marker", () => ({
  isPanicWipePending: () => mockWipePending,
}));

import { registerBootStartTask } from "../boot-start";

const IDENTITY = { peerID: "a1b2c3d4e5f60718" };

// The task the native service would run, as registered.
function bootTask(): () => Promise<void> {
  mockRegisterHeadlessTask.mockClear();
  registerBootStartTask();
  const factory = mockRegisterHeadlessTask.mock
    .calls[0][1] as () => () => Promise<void>;
  return factory();
}

// The task holds the process up for the radios to settle; nothing asserted
// here depends on that wait.
async function runBoot(): Promise<void> {
  const run = bootTask()();
  await jest.runAllTimersAsync();
  await run;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockMesh = null;
  mockWipePending = false;
  mockSettings = { autoStartOnBoot: true, backgroundMeshEnabled: true };
  mockLoadIdentity.mockResolvedValue(IDENTITY);
  mockHasBlePermissions.mockResolvedValue(true);
});

afterEach(() => {
  jest.useRealTimers();
});

describe("bootStartMesh", () => {
  test("starts the mesh and the notification pipeline for the stored identity", async () => {
    await runBoot();

    expect(mockInitMeshService).toHaveBeenCalledTimes(1);
    expect(mockStartPipeline).toHaveBeenCalledTimes(1);
    expect(mockStartReachability).toHaveBeenCalledTimes(1);
    // The mention check reads the name the mesh announces.
    const nickname = mockStartPipeline.mock.calls[0][0] as () => string;
    expect(nickname()).toBe(mockInitMeshService.mock.calls[0][1]);
  });

  test("an unfinished panic wipe keeps the identity down, keychain unread", async () => {
    mockWipePending = true;

    await runBoot();

    expect(mockLoadIdentity).not.toHaveBeenCalled();
    expect(mockInitMeshService).not.toHaveBeenCalled();
    expect(mockPrimeTor).not.toHaveBeenCalled();
    expect(mockStartPipeline).not.toHaveBeenCalled();
  });

  test("leaves a mesh already running for this identity alone", async () => {
    mockMesh = { peerID: IDENTITY.peerID, retryRadios: mockRetryRadios };

    await runBoot();

    expect(mockInitMeshService).not.toHaveBeenCalled();
  });

  test("never starts without the Bluetooth grant, since it cannot ask", async () => {
    mockHasBlePermissions.mockResolvedValue(false);

    await runBoot();

    expect(mockInitMeshService).not.toHaveBeenCalled();
    expect(mockStartPipeline).not.toHaveBeenCalled();
  });
});
