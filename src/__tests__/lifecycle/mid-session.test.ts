// What happens to a running app when the world changes under it: radios
// toggled, conversations in flight, the app put away and reopened, and a link
// handed over by another app.

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
    return require("../harness/bridge-shim").wifiBridge;
  },
}));

import type { Identity } from "@core/crypto/identity";
import { bytesToBase64 } from "@core/encoding/base64";
import { encodeAnnouncePayload } from "@core/mesh/discovery/announce-manager";
import { generateChannelKey } from "@core/mesh/rooms/channel-crypto";
import {
  encodePacket,
  Flags,
  PacketType,
  signPacket,
  type Packet,
} from "@core/mesh/wire/packet-codec";
import { hexToBytes } from "@noble/hashes/utils.js";
import { applyAirhopLink, joinSheetPrefill } from "@services/link-router";
import { getMeshService } from "@services/mesh-service";
import { applyPresence } from "@services/presence-service";
import { useChatStore } from "@store/chat-store";
import { computeMeshBanners, useMeshStateStore } from "@store/mesh-state-store";
import { useOutboxStore } from "@store/outbox-store";
import { usePeerStore } from "@store/peer-store";
import { useSettingsStore } from "@store/settings-store";
import { channelInviteLink, parseAirhopLink } from "@utils/deep-link";
import { AndroidBleModule } from "../harness/android-native";
import { AppShell, makeIdentity } from "../harness/app-shell";
import { installNativeBle } from "../harness/bridge-shim";
import { IosBleModule } from "../harness/ios-native";
import { installOfflineWebSocket } from "../harness/offline-socket";
import { DeviceOS } from "../harness/os";
import { Verdict } from "../harness/verdict";

// No test here needs a relay; without this the pool opens real sockets to public
// relays from CI and leaves them open when the test ends.
installOfflineWebSocket();

// Every field a scenario here can move, so one test's leftovers never decide
// the next one's verdict.
function resetStores(): void {
  useMeshStateStore.setState({
    bleBlocker: "starting",
    blePermissionBlocked: false,
    bleAdvertisingUnsupported: false,
    powerSaving: false,
    wifiFastPath: "unknown",
    lanState: "off",
    locationGranted: true,
    nostrConnected: false,
    torActive: false,
    bridgeActive: false,
    bridgePeopleAcross: 0,
    presenceStatus: "online",
  });
  // A start restores a kept Invisible, so Online has to be the saved choice too.
  useSettingsStore.getState().setStayInvisible(false);
  useSettingsStore.getState().setBackgroundMeshEnabled(true);
  usePeerStore.getState().clearAll();
  useOutboxStore.setState({ pending: [] });
}

// A signed ANNOUNCE from `peer`, as a neighbour sends one the moment a link
// comes up. Without it the mesh has never heard of anyone on the link, and a
// scenario about losing a peer has no peer to lose.
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

function isDirectPeer(peerID: string): boolean {
  return usePeerStore.getState().peers.get(peerID)?.isDirect === true;
}

// Bring an Android device up to a healthy, running mesh.
async function healthyAndroid(
  os: DeviceOS,
): Promise<{ app: AppShell; native: AndroidBleModule }> {
  const native = new AndroidBleModule(os);
  installNativeBle(native);
  native.initialize();
  const app = new AppShell({ os });
  app.bootJsRuntime();
  app.wireMeshStopListener();
  await app.startMeshWithPermissions();
  await os.advance(200);
  return { app, native };
}

describe("mid-session radio chaos and lifecycle", () => {
  let app: AppShell | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
    resetStores();
  });

  afterEach(() => {
    app?.teardown();
    app = null;
    installNativeBle(null);
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test("S11 Bluetooth toggled off then on from quick settings, app in front", async () => {
    const os = new DeviceOS({ platform: "android", apiLevel: 34 });
    const v = new Verdict(
      "S11",
      "Android: BT off then on while looking at the app",
      os,
    );
    const started = await healthyAndroid(os);
    app = started.app;
    const native = started.native;

    native.simulatePeerConnect("c:AA:BB:CC:DD:EE:01");
    await os.advance(100);

    os.setBluetooth(false);
    await os.advance(500);
    v.check(
      "process survived the switch-off",
      os.crashed === null,
      os.crashed ?? undefined,
    );
    v.check(
      "banner reports Bluetooth off",
      useMeshStateStore.getState().bleBlocker === "adapter-off",
      `blocker: ${useMeshStateStore.getState().bleBlocker}`,
    );

    os.setBluetooth(true);
    await os.advance(3000);

    v.check(
      "process survived the switch-on",
      os.crashed === null,
      os.crashed ?? undefined,
    );
    v.check("scanning came back on its own", native.scanning);
    v.check("advertising came back on its own", native.advertising);
    v.check(
      "banner is clear again",
      useMeshStateStore.getState().bleBlocker === "none",
      `blocker: ${useMeshStateStore.getState().bleBlocker}`,
    );
    v.assert();
  });

  test("S12 Bluetooth toggled while the JS runtime is not available", async () => {
    // Two real windows in one: the receiver is live from initialize(), which
    // runs before the JS bundle has finished loading, and Android leaves the app
    // in the same state when it destroys the Activity while the foreground
    // service keeps the process, the case the app's mount path describes.
    const os = new DeviceOS({ platform: "android", apiLevel: 34 });
    const v = new Verdict(
      "S12",
      "BT toggled during launch, before the JS bundle has loaded",
      os,
    );
    const native = new AndroidBleModule(os);
    installNativeBle(native);
    native.initialize();
    // Note: bootJsRuntime() has NOT been called. The app is on the splash screen.

    os.setBluetooth(false);
    await os.advance(300);

    v.check(
      "toggling Bluetooth during launch does not kill the app",
      os.crashed === null,
      os.crashed !== null
        ? `emitEvent() reached JS with no runtime attached. It must return early (hasActiveReactInstance) and catch, because BroadcastReceiver.onReceive is the main thread and an uncaught throw there is process death. ${os.crashed}`
        : undefined,
    );
    v.assert();
  });

  test("S12b Bluetooth toggled after the React instance is destroyed", async () => {
    const os = new DeviceOS({ platform: "android", apiLevel: 34 });
    const v = new Verdict(
      "S12b",
      "Activity destroyed, foreground service holds the process, then BT toggled",
      os,
    );
    const started = await healthyAndroid(os);
    app = started.app;
    const native = started.native;
    native.simulatePeerConnect("c:AA:BB:CC:DD:EE:01");
    await os.advance(100);

    await app.setAppState("background");
    // Android destroys the Activity and tears the React instance down; the
    // foreground service keeps the process (and this native module) alive.
    os.jsRuntimeReady = false;
    os.log("os", "REACT_INSTANCE_DESTROYED", "process kept alive by FGS");

    os.setBluetooth(false);
    await os.advance(300);

    v.check(
      "the process survives a Bluetooth toggle with no JS attached",
      os.crashed === null,
      os.crashed !== null
        ? `releaseRadioState() emits linkDisconnected for every live link; each of those must go through the guarded emitEvent(). ${os.crashed}`
        : undefined,
    );
    v.assert();
  });

  test("S16 Bluetooth flipped five times in two seconds", async () => {
    const os = new DeviceOS({ platform: "android", apiLevel: 34 });
    const v = new Verdict(
      "S16",
      "impatient user flips the switch repeatedly",
      os,
    );
    const started = await healthyAndroid(os);
    app = started.app;
    const native = started.native;

    for (let i = 0; i < 5; i++) {
      os.setBluetooth(false);
      await os.advance(200);
      os.setBluetooth(true);
      await os.advance(200);
    }
    await os.advance(4000);

    v.check("process survived", os.crashed === null, os.crashed ?? undefined);
    v.check("settles with scanning on", native.scanning);
    v.check("settles with advertising on", native.advertising);
    v.check(
      "settles with an accurate banner",
      useMeshStateStore.getState().bleBlocker === "none",
      `blocker: ${useMeshStateStore.getState().bleBlocker}`,
    );
    v.assert();
  });

  test("S14 Bluetooth dies mid-conversation while a DM is being sent", async () => {
    const os = new DeviceOS({ platform: "android", apiLevel: 34 });
    const v = new Verdict(
      "S14",
      "BT off mid-DM, nothing may be silently lost",
      os,
    );
    const started = await healthyAndroid(os);
    app = started.app;
    const native = started.native;

    const friend = makeIdentity(33);
    const linkID = "c:AA:BB:CC:DD:EE:01";
    native.simulatePeerConnect(linkID);
    await os.advance(100);
    native.fabricDeliver(linkID, announceFrom(friend, "friend"));
    await os.advance(200);
    v.check(
      "the friend is a direct neighbour before the outage",
      isDirectPeer(friend.peerID),
      "precondition: without a known peer the outage changes nothing",
    );

    const mesh = getMeshService();
    os.setBluetooth(false);
    await os.advance(400);
    v.check(
      "the outage took the friend's link with it",
      !isDirectPeer(friend.peerID),
      "a link map that still holds the dead link routes the DM into it",
    );

    const text = "are you still there?";
    const result = mesh?.sendDm(friend.peerID, text);
    await os.advance(500);

    v.check("process survived", os.crashed === null, os.crashed ?? undefined);
    v.check(
      "the message is not reported as delivered over a dead radio",
      result !== "sent",
      `sendDm returned ${String(result)}`,
    );
    const held = useOutboxStore
      .getState()
      .pending.filter(
        (m) => m.recipientPeerID === friend.peerID && m.text === text,
      );
    v.check(
      "this message is held for retry rather than dropped",
      held.length === 1,
      `outbox holds ${held.length} copy(ies) of it`,
    );
    v.assert();
  });

  test("S15 Bluetooth cycled while sitting inside a chat thread", async () => {
    const os = new DeviceOS({ platform: "android", apiLevel: 34 });
    const v = new Verdict(
      "S15",
      "BT off then on inside a thread, link maps must be honest",
      os,
    );
    const started = await healthyAndroid(os);
    app = started.app;
    const native = started.native;

    const friends = [makeIdentity(33), makeIdentity(45)];
    friends.forEach((friend, i) => {
      const linkID = `c:AA:BB:CC:DD:EE:0${i + 1}`;
      native.simulatePeerConnect(linkID);
      native.fabricDeliver(linkID, announceFrom(friend, `friend${i + 1}`));
    });
    await os.advance(200);
    v.check(
      "both friends are direct neighbours before the outage",
      friends.every((f) => isDirectPeer(f.peerID)),
      "precondition: without known peers the outage changes nothing",
    );

    os.setBluetooth(false);
    await os.advance(500);
    os.setBluetooth(true);
    await os.advance(3000);

    const stillDirect = friends.filter((f) => isDirectPeer(f.peerID));
    v.check("process survived", os.crashed === null, os.crashed ?? undefined);
    v.check(
      "nobody is still shown as in range over a link the outage killed",
      stillDirect.length === 0,
      `${stillDirect.length} peer(s) still shown as direct`,
    );
    v.check("radios are back", native.scanning && native.advertising);
    v.assert();
  });

  test("S18 'Stop mesh' from the notification, then the user reopens the app", async () => {
    const os = new DeviceOS({ platform: "android", apiLevel: 34 });
    const v = new Verdict(
      "S18",
      "Stop mesh, then reopen, there must be a way back",
      os,
    );
    const started = await healthyAndroid(os);
    app = started.app;
    const native = started.native;

    await app.setAppState("background");
    native.requestMeshStop();
    await os.advance(500);

    v.check("process survived", os.crashed === null, os.crashed ?? undefined);
    v.check(
      "the radios actually stopped",
      !native.scanning && !native.advertising,
    );

    // The user taps the icon again.
    await app.setAppState("active");
    await app.mount();
    await os.advance(3000);

    const presence = useMeshStateStore.getState().presenceStatus;
    // Stopping the mesh was a deliberate choice, made from outside the app.
    // Reopening must NOT quietly undo it: that would be the app overruling a
    // decision the user just made, from an event they did not trigger.
    v.check(
      "reopening does not silently restart a mesh the user stopped",
      presence === "away" && !native.scanning,
      `presence=${presence}, scanning=${native.scanning}`,
    );
    v.check(
      "the background service is released, so no notification outlives the mesh",
      !os.foregroundServiceRunning,
    );
    // What it must do instead is offer the way back where the user is looking.
    const paused = computeMeshBanners({
      presenceStatus: presence,
      bleBlocker: useMeshStateStore.getState().bleBlocker,
      locationGranted: true,
      nostrConnected: false,
      torActive: false,
      gatewayEnabled: false,
      bridgeActive: false,
      bridgePeopleAcross: 0,
      internetEnabled: true,
      peerCount: 0,
    });
    v.check(
      "the Mesh tab offers a one-tap Resume rather than burying it in Profile",
      paused[0]?.key === "paused" && paused[0]?.action?.kind === "resume",
      `banner: ${JSON.stringify(paused[0])}`,
    );

    // And that button works.
    applyPresence("online", "tester");
    await os.advance(3000);
    v.check(
      "tapping Resume brings the mesh back",
      native.scanning && native.advertising,
    );
    v.check("and the background service with it", os.foregroundServiceRunning);
    v.assert();
  });

  test("S19 Invisible presence must keep relaying in the background", async () => {
    const os = new DeviceOS({ platform: "android", apiLevel: 34 });
    const v = new Verdict(
      "S19",
      "Invisible: scan and relay, just don't advertise",
      os,
    );
    const started = await healthyAndroid(os);
    app = started.app;
    const native = started.native;

    applyPresence("invisible", "tester");
    await os.advance(500);

    v.check("process survived", os.crashed === null, os.crashed ?? undefined);
    v.check("advertising stopped, as Invisible means", !native.advertising);
    v.check("scanning continues, as Invisible means", native.scanning);
    v.check(
      "the mesh still survives backgrounding while Invisible",
      os.foregroundServiceRunning,
      "the foreground service went down with advertising, so choosing Invisible silently gives up background operation for a mesh that is still meant to be scanning and relaying. stopAdvertising() must leave the service alone",
    );

    applyPresence("online", "tester");
    await os.advance(500);
    v.check("coming back to Online restores advertising", native.advertising);
    v.assert();
  });

  // iOS: the same chaos, against CoreBluetooth.

  test("S11i iOS: Bluetooth toggled off then on", async () => {
    const os = new DeviceOS({ platform: "ios" });
    const v = new Verdict("S11i", "iOS: BT off then on mid-session", os);
    const native = new IosBleModule(os);
    installNativeBle(native);
    app = new AppShell({ os });
    app.bootJsRuntime();
    await app.startMeshWithPermissions();
    await os.advance(300);

    native.simulatePeerConnect("c:PERIPHERAL-UUID-1");
    await os.advance(100);
    const advertisingBefore = native.advertising;

    os.setBluetooth(false);
    await os.advance(600);
    os.setBluetooth(true);
    await os.advance(5000);

    v.check("process survived", os.crashed === null, os.crashed ?? undefined);
    v.check("was advertising before the toggle", advertisingBefore);
    v.check(
      "advertising comes back after Bluetooth returns",
      native.advertising,
      "the device is invisible to every peer until the app is force-quit. peripheralManagerDidUpdateState has to clear isAdvertising on poweredOff, or the `if isAdvertising { return }` guard skips rebuilding the service when poweredOn arrives",
    );
    v.check("scanning comes back after Bluetooth returns", native.scanning);
    v.check(
      "stale links from before the outage were retired",
      native.staleLinkCount() === 0,
      `${native.staleLinkCount()} link(s) still in centralLinks referencing a dead manager; JS was never told, so writes to them are silently discarded by CoreBluetooth`,
    );
    v.assert();
  });
});

// Any installed app, or a page that redirects, can hand Airhop a link. What the
// app does with one when it arrives is joinSheetPrefill (app.tsx); what the
// Join tap does is applyAirhopLink. Only the second may change anything.
describe("a link from another app", () => {
  beforeEach(() => {
    useChatStore.getState().clearAll();
  });

  test("S33 a private invite changes no store until Join", () => {
    const key = generateChannelKey();
    const url = channelInviteLink("#crew", key, true);
    const before = JSON.stringify(useChatStore.getState().channels);

    const prefill = joinSheetPrefill(url);

    expect(prefill).toBe(url);
    expect(JSON.stringify(useChatStore.getState().channels)).toBe(before);
    expect(useChatStore.getState().channelKeys["#crew"]).toBeUndefined();

    // The Join tap.
    const link = parseAirhopLink(prefill ?? "");
    const joined = link === null ? null : applyAirhopLink(link);
    if (joined === null || !("channel" in joined)) throw new Error("refused");
    expect(useChatStore.getState().channelKeys[joined.channel]).toBe(key);
  });

  test("S33b anything that is not an Airhop link opens nothing", () => {
    expect(joinSheetPrefill("https://example.com/")).toBeNull();
    expect(joinSheetPrefill(null)).toBeNull();
  });
});
