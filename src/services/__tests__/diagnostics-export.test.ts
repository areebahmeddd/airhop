// The report is the whole feature: a person reads it before choosing where it
// goes, and a maintainer reads it instead of asking twelve questions. So what it
// contains, and what it never contains, is pinned here.

jest.mock("@bridge/NativeAirhopApp", () => ({
  __esModule: true,
  default: null,
}));
jest.mock("@bridge/NativeAirhopWiFi", () => ({
  __esModule: true,
  default: null,
}));
jest.mock("expo-file-system", () => ({}));
jest.mock("expo-sharing", () => ({}));
jest.mock("../mesh-service", () => ({ getMeshService: () => null }));

import { useChatStore } from "@store/chat-store";
import { usePeerStore } from "@store/peer-store";
import {
  buildDiagnosticsReport,
  getDiagnosticsReport,
  type DiagnosticsSnapshot,
} from "../diagnostics-export";

const SNAPSHOT: DiagnosticsSnapshot = {
  generatedAt: "2026-09-11T12:00:00.000Z",
  app: "1.0.4",
  platform: "Android 14 (API 34)",
  device: "samsung SM-S928B",
  transports: {
    bluetooth: "none",
    lan: "off",
    wifiAware: "active",
    nostr: "connected",
    links: { ble: 2, lan: 0, wifi: 1 },
    ingressFaults: 0,
    lastIngressFault: null,
  },
  mesh: {
    reachablePeers: 1,
    presence: "online",
    internet: true,
    tor: "off",
    gateway: false,
    bridge: "off",
    powerSaving: false,
    clockSkewed: false,
  },
  settings: {
    lanTransport: false,
    geoRelayDiscovery: true,
    customRelays: 0,
    torBridgeMode: "off",
    liveVoice: true,
  },
};

describe("buildDiagnosticsReport", () => {
  it("carries every transport with its link count", () => {
    const report = buildDiagnosticsReport({ ...SNAPSHOT, log: "" });
    expect(report).toContain("Bluetooth: none · 2 links");
    expect(report).toContain("Local network: off · 0 links");
    expect(report).toContain("Wi-Fi Aware: active · 1 links");
    expect(report).toContain("Nostr: connected");
    expect(report).toContain("Reachable peers: 1");
  });

  it("says when the platform has no log rather than showing an empty one", () => {
    expect(buildDiagnosticsReport(SNAPSHOT)).toContain(
      "Not available on this platform.",
    );
    expect(buildDiagnosticsReport({ ...SNAPSHOT, log: "  \n" })).toContain(
      "Empty.",
    );
  });

  it("includes the native log when there is one", () => {
    const report = buildDiagnosticsReport({
      ...SNAPSHOT,
      log: "09-11 12:00:00.000 I/AirhopWiFiModule: WiFi Aware attached\n",
    });
    expect(report).toContain("WiFi Aware attached");
    expect(report).toContain("this app's tags only");
  });

  it("carries the WiFi transport's own account when the module has one", () => {
    const report = buildDiagnosticsReport({
      ...SNAPSHOT,
      log: "",
      wifiTransport: "attached: true for 12s\npeers: 1\n  ab12cd34 connected\n",
    });
    expect(report).toContain("Wi-Fi Aware transport");
    expect(report).toContain("  attached: true for 12s");
    expect(report).toContain("    ab12cd34 connected");
    // Nothing to say on a platform without it.
    expect(buildDiagnosticsReport({ ...SNAPSHOT, log: "" })).not.toContain(
      "Wi-Fi Aware transport",
    );
  });

  // A count alone cannot be acted on, so the last fault names where to look.
  it("names the last ingress fault by error and packet type", () => {
    expect(buildDiagnosticsReport(SNAPSHOT)).toContain("Ingress faults: 0\n");
    const withFault = (packetType: number | null): string =>
      buildDiagnosticsReport({
        ...SNAPSHOT,
        transports: {
          ...SNAPSHOT.transports,
          ingressFaults: 3,
          lastIngressFault: { error: "RangeError", packetType },
        },
      });
    expect(withFault(0x04)).toContain(
      "Ingress faults: 3 (last: RangeError, packet type 0x04)",
    );
    expect(withFault(null)).toContain(
      "Ingress faults: 3 (last: RangeError, undecoded)",
    );
  });

  // What keeps the bundle safe to hand to a stranger: whatever the stores
  // hold, no name, peer ID or message reaches the report built from them.
  it("leaves out nicknames, peer IDs and message text", async () => {
    const peerID = "a1b2c3d4e5f60718";
    const nickname = "marigold";
    const text = "the meeting is at four";
    usePeerStore.getState().upsertPeer({
      peerID,
      nickname,
      lastSeenMs: Date.now(),
      noisePubKeyHex: "00".repeat(32),
    });
    useChatStore.getState().addChannel("#bluetooth");
    useChatStore.getState().addMessage({
      id: "m1",
      channel: "#bluetooth",
      senderID: peerID,
      senderNickname: nickname,
      text,
      timestampMs: Date.now(),
      isMine: false,
    });

    const report = await getDiagnosticsReport();

    // The seeded peer did reach the collector, as a count.
    expect(report).toContain("Reachable peers: 1");
    for (const secret of [peerID, nickname, text]) {
      expect(report).not.toContain(secret);
    }
  });
});
