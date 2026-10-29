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
import { useMeshStateStore } from "@store/mesh-state-store";
import { usePeerStore } from "@store/peer-store";
import {
  buildDiagnosticsReport,
  getDiagnosticsReport,
  timeZoneLabel,
  type DiagnosticsSnapshot,
} from "../diagnostics-export";

const SNAPSHOT: DiagnosticsSnapshot = {
  generatedAt: "2026-09-11T12:00:00.000Z",
  app: "1.0.0",
  platform: "Android 14 (API 34)",
  device: "samsung SM-S928B",
  timeZone: "UTC-7",
  transports: {
    bluetooth: "active",
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
  liveVideo: { sending: null, receiving: 0 },
  settings: {
    wifiAware: true,
    lanTransport: false,
    geoRelayDiscovery: true,
    customRelays: 0,
    torBridgeMode: "off",
    liveVoice: true,
    liveVideo: true,
    spamFilter: true,
  },
};

describe("timeZoneLabel", () => {
  it("names whole and part-hour offsets on both sides of UTC", () => {
    expect(timeZoneLabel(0)).toBe("UTC");
    expect(timeZoneLabel(420)).toBe("UTC-7");
    expect(timeZoneLabel(-330)).toBe("UTC+5:30");
    expect(timeZoneLabel(-345)).toBe("UTC+5:45");
    expect(timeZoneLabel(210)).toBe("UTC-3:30");
  });
});

describe("buildDiagnosticsReport", () => {
  it("carries every transport with its link count, in one order", () => {
    const report = buildDiagnosticsReport({ ...SNAPSHOT, log: "" });
    expect(report).toContain(
      [
        "Transports",
        "  Bluetooth: active · 2 links",
        "  Wi-Fi Aware: active · 1 link",
        "  Local network: off · 0 links",
        "  Nostr: connected",
        "",
      ].join("\n"),
    );
  });

  it("lists mesh state under the app's names, ingress faults last", () => {
    expect(buildDiagnosticsReport(SNAPSHOT)).toContain(
      [
        "Mesh",
        "  Reachable peers: 1",
        "  Presence: online",
        "  Internet fallback: on",
        "  Mesh bridge: off",
        "  Internet gateway: off",
        "  Tor routing: off",
        "  Power saving: off",
        "  Clock skewed: off",
        "  Ingress faults: 0",
        "",
      ].join("\n"),
    );
  });

  it("puts live video between the mesh and the settings", () => {
    const report = buildDiagnosticsReport(SNAPSHOT);
    expect(report).toContain(
      [
        "  Ingress faults: 0",
        "",
        "Live video",
        "  Sending: no",
        "  Receiving: 0 streams",
        "",
        "Settings",
        "",
      ].join("\n"),
    );
  });

  // It hides public messages without telling the sender, so a report of one
  // that never arrived needs to say whether it was on.
  it("says whether the spam filter is on", () => {
    expect(buildDiagnosticsReport(SNAPSHOT)).toContain("  Spam filter: on\n");
    expect(
      buildDiagnosticsReport({
        ...SNAPSHOT,
        settings: { ...SNAPSHOT.settings, spamFilter: false },
      }),
    ).toContain("  Spam filter: off\n");
  });

  it("describes a stream being sent in the studio's words", () => {
    const report = buildDiagnosticsReport({
      ...SNAPSHOT,
      liveVideo: {
        sending: {
          quality: "medium",
          elapsedMs: 84_900,
          withSound: true,
          videoBitrate: 41_500,
          packetBudget: 24,
          congested: true,
          skipping: false,
        },
        receiving: 1,
      },
    });
    expect(report).toContain(
      [
        "Live video",
        "  Sending: Medium for 84 s, microphone on",
        "  Video bitrate: 42 kbps, paced to 24 packets a second",
        "  Signal: falling behind",
        "  Receiving: 1 stream",
        "",
      ].join("\n"),
    );
  });

  it("says when a sent stream is down to sound", () => {
    const report = buildDiagnosticsReport({
      ...SNAPSHOT,
      liveVideo: {
        sending: {
          quality: "low",
          elapsedMs: 3_000,
          withSound: false,
          videoBitrate: 6_000,
          packetBudget: 300,
          congested: true,
          skipping: true,
        },
        receiving: 0,
      },
    });
    expect(report).toContain(
      "  Signal: too slow for video, sending sound only\n",
    );
    expect(report).toContain("microphone off");
  });

  it("states the time zone beside the UTC timestamp", () => {
    expect(buildDiagnosticsReport(SNAPSHOT)).toContain(
      "Generated: 2026-09-11T12:00:00.000Z\nTime zone: UTC-7\n",
    );
  });

  // Off by the user and on but idle must not read the same.
  it("lists both local transport switches, Wi-Fi Aware first", () => {
    const report = buildDiagnosticsReport({
      ...SNAPSHOT,
      settings: { ...SNAPSHOT.settings, wifiAware: false },
    });
    expect(report).toContain(
      "  Wi-Fi Aware transport: off\n  Local network transport: off\n",
    );
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
      log: "09-11 12:00:00.000 I/AirhopWiFiModule: Wi-Fi Aware attached\n",
    });
    expect(report).toContain("Wi-Fi Aware attached");
    expect(report).toContain("this app's tags only");
  });

  it("carries the Wi-Fi Aware module's own account when it has one", () => {
    const report = buildDiagnosticsReport({
      ...SNAPSHOT,
      log: "",
      wifiTransport:
        "Attached: yes, for 12 s\nPeers now: 1\n  ab12cd34 connected\n",
    });
    expect(report).toContain("\nWi-Fi Aware details\n");
    expect(report).toContain("  Attached: yes, for 12 s");
    expect(report).toContain("    ab12cd34 connected");
    // Nothing to say on a platform without it.
    expect(buildDiagnosticsReport({ ...SNAPSHOT, log: "" })).not.toContain(
      "Wi-Fi Aware details",
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

  it("reports a running Bluetooth mesh as active and a blocker by name", async () => {
    useMeshStateStore.setState({ bleBlocker: "none" });
    expect(await getDiagnosticsReport()).toContain("  Bluetooth: active · ");
    useMeshStateStore.setState({ bleBlocker: "adapter-off" });
    expect(await getDiagnosticsReport()).toContain(
      "  Bluetooth: adapter-off · ",
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
