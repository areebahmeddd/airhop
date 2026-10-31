// Native events reaching JavaScript on iOS, and a mesh built late knowing which
// side of the screen it is on.
//
// iOS's RCTEventEmitter sends nothing while its listener count is zero, and
// only the module's own addListener raises it. A subscription made through
// DeviceEventEmitter alone works on Android and is silent on an iPhone, so
// every Airhop module's events are checked here against the calls its module
// received.

jest.mock("expo-location", () => ({}));
jest.mock("@bridge/NativeAirhopBLE", () => ({
  __esModule: true,
  get default() {
    return require("../harness/bridge-shim").bleBridge;
  },
}));
jest.mock("@bridge/NativeAirhopWiFi", () => ({
  __esModule: true,
  get default() {
    return mockCounted(
      "AirhopWiFi",
      require("../harness/bridge-shim").wifiBridge,
    );
  },
}));
jest.mock("@bridge/NativeAirhopLAN", () => ({
  __esModule: true,
  get default() {
    return mockCounted(
      "AirhopLAN",
      require("../harness/bridge-shim").lanBridge,
    );
  },
}));
jest.mock("@bridge/NativeAirhopWiFiPairing", () => ({
  __esModule: true,
  get default() {
    return mockCounted("AirhopWiFiPairing", {
      getPairingState: () => Promise.resolve({ supported: true, count: 1 }),
      presentPairing: () => Promise.resolve(),
      addListener: () => undefined,
      removeListeners: () => undefined,
    });
  },
}));

// Event names each module was asked to count, and its running count.
const mockModuleEvents = new Map<string, Set<string>>();
const mockModuleCounts = new Map<string, number>();
const mockWrapped = new Map<string, object>();

// Records what a module is asked to count, then passes the call on.
function mockCounting(
  name: string,
  addListener: (eventName: string) => void,
  removeListeners: (count: number) => void,
): {
  addListener(eventName: string): void;
  removeListeners(count: number): void;
} {
  return {
    addListener: (eventName: string) => {
      const events = mockModuleEvents.get(name) ?? new Set<string>();
      events.add(eventName);
      mockModuleEvents.set(name, events);
      mockModuleCounts.set(name, (mockModuleCounts.get(name) ?? 0) + 1);
      addListener(eventName);
    },
    removeListeners: (count: number) => {
      mockModuleCounts.set(name, (mockModuleCounts.get(name) ?? 0) - count);
      removeListeners(count);
    },
  };
}

// One wrapper per module, so every caller holds the same object.
function mockCounted<
  T extends {
    addListener(eventName: string): void;
    removeListeners(count: number): void;
  },
>(name: string, module: T): T {
  const held = mockWrapped.get(name);
  if (held !== undefined) return held as T;
  const wrapped: T = {
    ...module,
    ...mockCounting(
      name,
      (e) => module.addListener(e),
      (n) => module.removeListeners(n),
    ),
  };
  mockWrapped.set(name, wrapped);
  return wrapped;
}

import type { Identity } from "@core/crypto/identity";
import { bytesToBase64 } from "@core/encoding/base64";
import { encodeAnnouncePayload } from "@core/mesh/discovery/announce-manager";
import {
  encodePacket,
  Flags,
  PacketType,
  signPacket,
  type Packet,
} from "@core/mesh/wire/packet-codec";
import { hexToBytes } from "@noble/hashes/utils.js";
import { getMeshService } from "@services/mesh-service";
import { subscribeMoveLink } from "@services/move-link";
import { useMeshStateStore } from "@store/mesh-state-store";
import { usePeerStore } from "@store/peer-store";
import { useSettingsStore } from "@store/settings-store";
import { DeviceEventEmitter } from "react-native";
import { AppShell, makeIdentity } from "../harness/app-shell";
import { installNativeBle } from "../harness/bridge-shim";
import { IosBleModule } from "../harness/ios-native";
import { installOfflineWebSocket } from "../harness/offline-socket";
import { DeviceOS } from "../harness/os";

installOfflineWebSocket();

const MODULE_PREFIXES = [
  "AirhopBLE",
  "AirhopWiFiPairing",
  "AirhopWiFi",
  "AirhopLAN",
];

function announceFrom(peer: Identity, nickname: string): string {
  const packet: Packet = {
    type: PacketType.ANNOUNCE,
    ttl: 7,
    flags: Flags.SIGNED,
    senderID: hexToBytes(peer.peerID),
    recipientID: new Uint8Array(8),
    timestamp: Date.now(),
    signature: new Uint8Array(64),
    payload: encodeAnnouncePayload(peer, nickname),
  };
  packet.signature = signPacket(packet, peer.signingPrivKey);
  return bytesToBase64(encodePacket(packet));
}

// The module an event name belongs to. Longest prefix first, since
// "AirhopWiFiPairing." also starts with "AirhopWiFi".
function moduleOf(eventName: string): string | undefined {
  return MODULE_PREFIXES.find((p) => eventName.startsWith(`${p}.`));
}

describe("native events on iOS", () => {
  let app: AppShell | null = null;
  let subscribed: Set<string>;
  let spy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    useMeshStateStore.setState({ presenceStatus: "online" });
    useSettingsStore.getState().setStayInvisible(false);
    useSettingsStore.getState().setBackgroundMeshEnabled(true);
    usePeerStore.getState().clearAll();
    mockModuleEvents.clear();
    mockModuleCounts.clear();
    subscribed = new Set();
    const original = DeviceEventEmitter.addListener.bind(DeviceEventEmitter);
    spy = jest
      .spyOn(DeviceEventEmitter, "addListener")
      .mockImplementation((eventName, listener, context) => {
        subscribed.add(String(eventName));
        return original(eventName, listener, context);
      });
  });

  afterEach(() => {
    app?.teardown();
    app = null;
    spy.mockRestore();
    installNativeBle(null);
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  async function iosMesh(
    os: DeviceOS,
  ): Promise<{ app: AppShell; native: IosBleModule }> {
    const native = new IosBleModule(os);
    // The shim forwards to whatever is installed, so count on the module.
    const counting = mockCounting(
      "AirhopBLE",
      native.addListener.bind(native),
      native.removeListeners.bind(native),
    );
    native.addListener = counting.addListener;
    native.removeListeners = counting.removeListeners;
    installNativeBle(native);
    const shell = new AppShell({ os });
    shell.bootJsRuntime();
    await shell.startMeshWithPermissions();
    await os.advance(3000);
    return { app: shell, native };
  }

  test("every Airhop event is subscribed through the module that raises it", async () => {
    const os = new DeviceOS({ platform: "ios" });
    const started = await iosMesh(os);
    app = started.app;
    const unsubscribeMove = subscribeMoveLink(() => undefined);

    const airhopEvents = [...subscribed].filter(
      (e) => moduleOf(e) !== undefined,
    );
    expect(airhopEvents.length).toBeGreaterThan(0);
    const missed = airhopEvents.filter(
      (e) => !(mockModuleEvents.get(moduleOf(e) ?? "")?.has(e) ?? false),
    );
    expect(missed).toEqual([]);
    // Android-only events, absent from the iOS module's supportedEvents: a
    // debug build raises a red box for a listener on one.
    expect(subscribed.has("AirhopBLE.scanFailed")).toBe(false);
    expect(subscribed.has("AirhopBLE.powerStateChanged")).toBe(false);
    for (const module of MODULE_PREFIXES) {
      expect(mockModuleCounts.get(module) ?? 0).toBeGreaterThan(0);
    }

    // The gate is real: Bluetooth link and frame events reach the mesh.
    const friend = makeIdentity(41);
    const linkID = "c:AA:BB:CC:DD:EE:41";
    started.native.simulatePeerConnect(linkID);
    await os.advance(100);
    started.native.fabricDeliver(linkID, announceFrom(friend, "friend"));
    await os.advance(200);
    expect(usePeerStore.getState().peers.get(friend.peerID)?.isDirect).toBe(
      true,
    );
    expect(os.trace.some((e) => e.kind === "EVENT_DROPPED_NO_LISTENERS")).toBe(
      false,
    );

    // Stopping hands every count back, so iOS stops sending.
    unsubscribeMove();
    app.teardown();
    app = null;
    for (const module of MODULE_PREFIXES) {
      expect(mockModuleCounts.get(module) ?? 0).toBe(0);
    }
  });

  test("a mesh started off screen learns it at once", async () => {
    const os = new DeviceOS({ platform: "ios" });
    // A Bluetooth state-restoration relaunch: the process starts in the
    // background with no screen.
    os.appForeground = false;
    const started = await iosMesh(os);
    app = started.app;
    const mesh = getMeshService() as unknown as { appForeground: boolean };
    expect(mesh.appForeground).toBe(false);
  });
});
