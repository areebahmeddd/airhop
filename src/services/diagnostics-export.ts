// A support bundle the user hands over themselves: transport state, the
// relevant switches, and the process's own recent log.
//
// A file offered to the share sheet, never sent on its own, and there is no
// endpoint to send it to: an app whose pitch is that nothing leaves the phone
// unasked does not get to add telemetry. Built from a plain snapshot so what
// goes in is unit-testable and what stays out is deliberate: no message
// content, nicknames, keys, or peer IDs beyond the counts Diagnostics shows.

import NativeAirhopApp from "@bridge/NativeAirhopApp";
import NativeAirhopWiFi from "@bridge/NativeAirhopWiFi";
import type { TransportKind } from "@core/mesh/links/link-registry";
import { APP_VERSION } from "@data/app-info";
import { t } from "@i18n";
import { useMeshStateStore } from "@store/mesh-state-store";
import { usePeerStore } from "@store/peer-store";
import { useSettingsStore } from "@store/settings-store";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";
import type { LiveVideoSendSummary } from "./live-video-sender";
import { getMeshService, type IngressFault } from "./mesh-service";

export interface DiagnosticsSnapshot {
  generatedAt: string;
  app: string;
  platform: string;
  device: string;
  timeZone: string;
  transports: {
    bluetooth: string;
    lan: string;
    wifiAware: string;
    nostr: string;
    links: Record<TransportKind, number>;
    ingressFaults: number;
    lastIngressFault: IngressFault | null;
  };
  mesh: {
    reachablePeers: number;
    presence: string;
    internet: boolean;
    tor: string;
    gateway: boolean;
    bridge: string;
    powerSaving: boolean;
    clockSkewed: boolean;
  };
  liveVideo: {
    sending: LiveVideoSendSummary | null;
    receiving: number;
  };
  settings: {
    wifiAware: boolean;
    lanTransport: boolean;
    geoRelayDiscovery: boolean;
    customRelays: number;
    torBridgeMode: string;
    liveVoice: boolean;
    liveVideo: boolean;
  };
  // Absent only if the native module itself is missing. Empty where the
  // platform refused to hand back a log.
  log?: string;
  // The Wi-Fi Aware transport's own live counts. Android folds its recent
  // log in too (Samsung builds drop logcat info lines); iOS's is already in
  // the log section above.
  wifiTransport?: string;
}

export function buildDiagnosticsReport(s: DiagnosticsSnapshot): string {
  const yes = (b: boolean): string => (b ? "on" : "off");
  const lines = [
    "Airhop diagnostics",
    `Generated: ${s.generatedAt}`,
    `Time zone: ${s.timeZone}`,
    `App: ${s.app}`,
    `Platform: ${s.platform}`,
    `Device: ${s.device}`,
    "",
    "Transports",
    `  Bluetooth: ${s.transports.bluetooth} · ${linkCount(s.transports.links.ble)}`,
    `  Wi-Fi Aware: ${s.transports.wifiAware} · ${linkCount(s.transports.links.wifi)}`,
    `  Local network: ${s.transports.lan} · ${linkCount(s.transports.links.lan)}`,
    `  Nostr: ${s.transports.nostr}`,
    "",
    "Mesh",
    `  Reachable peers: ${s.mesh.reachablePeers}`,
    `  Presence: ${s.mesh.presence}`,
    `  Internet fallback: ${yes(s.mesh.internet)}`,
    `  Mesh bridge: ${s.mesh.bridge}`,
    `  Internet gateway: ${yes(s.mesh.gateway)}`,
    `  Tor routing: ${s.mesh.tor}`,
    `  Power saving: ${yes(s.mesh.powerSaving)}`,
    `  Clock skewed: ${yes(s.mesh.clockSkewed)}`,
    `  Ingress faults: ${ingressFaultLine(s.transports.ingressFaults, s.transports.lastIngressFault)}`,
    "",
    "Live video",
    ...liveVideoLines(s.liveVideo),
    "",
    "Settings",
    `  Wi-Fi Aware transport: ${yes(s.settings.wifiAware)}`,
    `  Local network transport: ${yes(s.settings.lanTransport)}`,
    `  Geo-relay discovery: ${yes(s.settings.geoRelayDiscovery)}`,
    `  Custom relays: ${s.settings.customRelays}`,
    `  Tor bridge mode: ${s.settings.torBridgeMode}`,
    `  Live voice: ${yes(s.settings.liveVoice)}`,
    `  Live video: ${yes(s.settings.liveVideo)}`,
    "",
  ];
  if (s.wifiTransport !== undefined && s.wifiTransport.trim().length > 0) {
    lines.push(
      "Wi-Fi Aware details",
      ...s.wifiTransport
        .trimEnd()
        .split("\n")
        .map((line) => `  ${line}`),
      "",
    );
  }
  if (s.log === undefined) {
    lines.push("Recent log", "  Not available on this platform.");
  } else if (s.log.trim().length === 0) {
    lines.push("Recent log", "  Empty.");
  } else {
    lines.push(
      "Recent log (this app's tags only, oldest first)",
      s.log.trimEnd(),
    );
  }
  return lines.join("\n") + "\n";
}

// The report is English by design, so the plural is settled here.
function linkCount(n: number): string {
  return n === 1 ? "1 link" : `${String(n)} links`;
}

const QUALITY_LABEL: Record<LiveVideoSendSummary["quality"], string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

// In the studio's own words for the signal meter, so a report and a
// screenshot of the studio describe a stream the same way.
function liveVideoLines(state: DiagnosticsSnapshot["liveVideo"]): string[] {
  const receiving =
    state.receiving === 1 ? "1 stream" : `${String(state.receiving)} streams`;
  const send = state.sending;
  if (send === null) return ["  Sending: no", `  Receiving: ${receiving}`];
  const signal = send.skipping
    ? "too slow for video, sending sound only"
    : send.congested
      ? "falling behind"
      : "keeping up";
  return [
    `  Sending: ${QUALITY_LABEL[send.quality]} for ${String(Math.floor(send.elapsedMs / 1000))} s, microphone ${send.withSound ? "on" : "off"}`,
    `  Video bitrate: ${String(Math.round(send.videoBitrate / 1000))} kbps, paced to ${String(send.packetBudget)} packets a second`,
    `  Signal: ${signal}`,
    `  Receiving: ${receiving}`,
  ];
}

/**
 * @public Exported for its test. getTimezoneOffset is minutes behind UTC, so
 * the sign flips.
 */
export function timeZoneLabel(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "UTC";
  const ahead = -offsetMinutes;
  const abs = Math.abs(ahead);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  const sign = ahead > 0 ? "+" : "-";
  return `UTC${sign}${String(hours)}${minutes === 0 ? "" : `:${String(minutes).padStart(2, "0")}`}`;
}

// A packet type names the handler to look at; none means the frame never
// decoded.
function ingressFaultLine(count: number, last: IngressFault | null): string {
  if (count === 0 || last === null) return String(count);
  const where =
    last.packetType === null
      ? "undecoded"
      : `packet type 0x${last.packetType.toString(16).padStart(2, "0")}`;
  return `${String(count)} (last: ${last.error}, ${where})`;
}

function deviceLabel(): string {
  const c = Platform.constants as Record<string, unknown>;
  if (Platform.OS === "android") {
    const make = typeof c.Manufacturer === "string" ? c.Manufacturer : "";
    const model = typeof c.Model === "string" ? c.Model : "";
    return `${make} ${model}`.trim() || "Android device";
  }
  // No model on iOS without another dependency; the OS version beside it is
  // the half a report needs.
  return typeof c.systemName === "string" ? c.systemName : "iOS device";
}

function platformLabel(): string {
  if (Platform.OS === "android") {
    const c = Platform.constants as Record<string, unknown>;
    const release = typeof c.Release === "string" ? c.Release : "?";
    return `Android ${release} (API ${String(Platform.Version)})`;
  }
  return `iOS ${String(Platform.Version)}`;
}

// Everything the report needs, read once. The native log is the only await.
async function collectDiagnostics(): Promise<DiagnosticsSnapshot> {
  const mesh = useMeshStateStore.getState();
  const settings = useSettingsStore.getState();
  const peers = usePeerStore.getState();
  const links = getMeshService()?.getLinkCounts() ?? {
    ble: 0,
    lan: 0,
    wifi: 0,
  };
  const ingress = getMeshService()?.getIngressFaults();
  // No mesh yet reads as idle, the way the link counts above do.
  const liveVideo = getMeshService()?.getLiveVideoState() ?? {
    sending: null,
    receiving: 0,
  };
  const tor = !settings.torEnabled
    ? "off"
    : mesh.torActive
      ? "on"
      : mesh.torBootstrap;
  const bridge = !settings.bridgeEnabled
    ? "off"
    : mesh.bridgeActive
      ? `on · ${mesh.bridgePeopleAcross} across`
      : "on · no cell";

  // Undefined, not empty, on a platform with no module: the report says which.
  const log = await NativeAirhopApp?.recentLog().catch(() => "");
  const wifiTransport = await NativeAirhopWiFi?.dumpState?.().catch(
    () => undefined,
  );

  const now = new Date();
  return {
    generatedAt: now.toISOString(),
    app: APP_VERSION,
    platform: platformLabel(),
    device: deviceLabel(),
    timeZone: timeZoneLabel(now.getTimezoneOffset()),
    transports: {
      // bleBlocker names what stops the mesh, so "none" means it is running.
      bluetooth: mesh.bleBlocker === "none" ? "active" : mesh.bleBlocker,
      lan: mesh.lanState,
      wifiAware: mesh.wifiFastPath,
      nostr: mesh.nostrConnected ? "connected" : "not connected",
      links,
      ingressFaults: ingress?.count ?? 0,
      lastIngressFault: ingress?.last ?? null,
    },
    mesh: {
      reachablePeers: peers.reachablePeers().length,
      presence: mesh.presenceStatus,
      internet: settings.internetEnabled,
      tor,
      gateway: settings.gatewayEnabled,
      bridge,
      powerSaving: mesh.powerSaving,
      clockSkewed: mesh.clockSkewed,
    },
    liveVideo,
    settings: {
      wifiAware: settings.wifiAwareEnabled,
      lanTransport: settings.lanTransportEnabled,
      geoRelayDiscovery: settings.geoRelayDiscovery,
      customRelays: settings.customRelays.length,
      torBridgeMode: settings.torBridgeMode,
      liveVoice: settings.liveVoiceEnabled,
      liveVideo: settings.liveVideoEnabled,
    },
    log,
    wifiTransport,
  };
}

// The report as text, for the copy action.
export async function getDiagnosticsReport(): Promise<string> {
  return buildDiagnosticsReport(await collectDiagnostics());
}

// Write the report to the cache and hand it to the share sheet. Returns false
// when the sheet could not be shown at all; a user dismissing it is not a
// failure and reads as true.
export async function shareDiagnostics(): Promise<boolean> {
  try {
    if (!(await Sharing.isAvailableAsync())) return false;
    const report = await getDiagnosticsReport();
    const file = new FileSystem.File(
      FileSystem.Paths.cache,
      "airhop-diagnostics.txt",
    );
    if (file.exists) file.delete();
    file.create();
    await file.write(report);
    await Sharing.shareAsync(file.uri, {
      mimeType: "text/plain",
      dialogTitle: t("settings.diag.share"),
    });
    return true;
  } catch {
    return false;
  }
}
