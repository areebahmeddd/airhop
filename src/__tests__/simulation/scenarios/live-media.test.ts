// The Bluetooth connection priority a live stream raises (setLiveMediaActive):
// up while one is sent or received here, down once none is. Left up, every
// Bluetooth link keeps the short connection interval and the battery cost
// that comes with it long after the stream ends.
//
// The video module is a stub with no camera, so a stream here is its START
// and its ending, which is all the priority follows.

jest.mock("expo-location", () => ({}));
jest.mock("react-native/Libraries/EventEmitter/RCTDeviceEventEmitter", () =>
  (
    require("../harness/event-router") as { routerModule: () => unknown }
  ).routerModule(),
);
jest.mock("@bridge/NativeAirhopBLE", () => {
  const shim = require("../../harness/bridge-shim") as { bleBridge: unknown };
  return { __esModule: true, default: shim.bleBridge };
});
jest.mock("@bridge/NativeAirhopWiFi", () => {
  const shim = require("../../harness/bridge-shim") as { wifiBridge: unknown };
  return { __esModule: true, default: shim.wifiBridge };
});
jest.mock("expo-file-system", () =>
  (
    require("../harness/media-fabric") as {
      createExpoFileSystemMock: () => unknown;
    }
  ).createExpoFileSystemMock(),
);
jest.mock("@bridge/NativeAirhopVideo", () => ({
  __esModule: true,
  default: {
    startRecording: () => Promise.resolve(),
    appendVideo: () => undefined,
    appendAudio: () => undefined,
    finishRecording: () => Promise.resolve(null),
    cancelRecording: () => undefined,
    decodeVideo: () => undefined,
    releaseDecoder: () => undefined,
    startEncoding: () => Promise.resolve(),
    stopEncoding: () => Promise.resolve(),
    setBitrate: () => undefined,
    requestKeyframe: () => undefined,
    addListener: () => undefined,
    removeListeners: () => undefined,
  },
}));

import { LIVE_VIDEO_QUALITIES } from "@core/mesh/video/live-video-quality";
import { SimDevice } from "../harness/device";
import { noCrashes } from "../harness/invariants";
import { RadioFabric } from "../harness/radio-fabric";
import { advanceFor, Scenario, waitFor } from "../harness/scenario";

jest.setTimeout(180_000);

let scenario: Scenario | null = null;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  scenario?.close();
  scenario = null;
  jest.clearAllTimers();
});

afterAll(() => {
  jest.useRealTimers();
});

const ROOM = "#bluetooth";

interface LiveMesh {
  startLiveVideo: (
    channel: string,
    quality: unknown,
    withAudio: boolean,
    onFailure: () => void,
  ) => Promise<object | null>;
  stopLiveVideo: (canceled: boolean) => Promise<unknown>;
}

function live(device: SimDevice): LiveMesh {
  return device.mesh as unknown as LiveMesh;
}

function priority(device: SimDevice): boolean {
  return (device.native as unknown as { liveMediaActive: boolean })
    .liveMediaActive;
}

test("LM01 a stream raises the Bluetooth priority on both phones, and ending it lowers it", async () => {
  const s = (scenario = new Scenario({
    id: "LM01",
    title: "setLiveMediaActive follows a stream sent and received",
    seed: 1401,
  }));
  const radio = new RadioFabric(s.world);
  const alice = SimDevice.create(s.world, {
    id: "alice",
    platform: "android",
    seedByte: 11,
  });
  const bob = SimDevice.create(s.world, {
    id: "bob",
    platform: "ios",
    seedByte: 22,
  });
  radio.add(alice);
  radio.add(bob);
  s.track(alice, bob);
  alice.launch();
  bob.launch();
  s.check(
    "alice and bob hear each other",
    await waitFor(
      s.world,
      () =>
        alice.peers().includes(bob.peerID) &&
        bob.peers().includes(alice.peerID),
      20_000,
    ),
  );
  s.check(
    "neither has raised it before any stream",
    !priority(alice) && !priority(bob),
  );

  const started = await s.world.resolve(
    live(alice).startLiveVideo(
      ROOM,
      LIVE_VIDEO_QUALITIES.low,
      false,
      () => undefined,
    ),
  );
  s.check("alice went live in the room", started !== null);
  s.check(
    "alice raised it as her stream started",
    await waitFor(s.world, () => priority(alice), 2_000),
  );
  s.check(
    "bob raised it as her stream reached him",
    await waitFor(s.world, () => priority(bob), 5_000),
  );

  await advanceFor(s.world, 2_000);
  await s.world.resolve(live(alice).stopLiveVideo(true));
  s.check("alice lowered it once she stopped", !priority(alice));
  s.check(
    "and bob once her stream ended",
    await waitFor(s.world, () => !priority(bob), 10_000),
  );

  s.expectNone("process health", noCrashes([alice, bob]));
  s.assert();
});
