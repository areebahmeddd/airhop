/**
 * @jest-environment node
 */
// The report is the whole feature: a person reads it before choosing where it
// goes, and a maintainer reads it instead of asking twelve questions. So what it
// contains, and what it never contains, is pinned here.

jest.mock("@bridge/NativeAirhopApp", () => ({
  __esModule: true,
  default: null,
}));
jest.mock("expo-file-system", () => ({}));
jest.mock("expo-sharing", () => ({}));
jest.mock("@services/mesh-service", () => ({ getMeshService: () => null }));

import {
  buildDiagnosticsReport,
  type DiagnosticsSnapshot,
} from "../diagnostics-export";

const SNAPSHOT: DiagnosticsSnapshot = {
  generatedAt: "2026-09-11T12:00:00.000Z",
  app: "1.0.4",
  platform: "Android 14 (API 34)",
  device: "samsung SM-S928B",
  transports: {
    bluetooth: "none",
    wifiAware: "active",
    lan: "off",
    nostr: "connected",
    links: { ble: 2, wifi: 1, lan: 0 },
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
    expect(report).toContain("Wi-Fi Aware: active · 1 links");
    expect(report).toContain("Local network: off · 0 links");
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

  // Nothing in the snapshot's shape can hold a message, a nickname or a key,
  // which is what keeps the bundle safe to hand to a stranger. Pinned so a
  // future field added for convenience is noticed.
  it("has no field that could carry user content", () => {
    const keys = new Set<string>();
    const walk = (o: object): void => {
      for (const [k, v] of Object.entries(o)) {
        keys.add(k);
        if (v !== null && typeof v === "object") walk(v);
      }
    };
    walk(SNAPSHOT);
    for (const k of ["text", "nickname", "name", "key", "peerID", "peers"]) {
      expect(keys.has(k)).toBe(false);
    }
  });
});
