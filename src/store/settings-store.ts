// App preferences: theme, media auto-download, and upload quality.
// MMKV-persisted so choices survive app restarts. Reset to defaults by the
// panic wipe (via reset()), so a wipe leaves a true first-run state with no
// trace of the previous user's choices.

import { MAX_CUSTOM_RELAYS, validateRelayUrl } from "@core/nostr/geo-relay";
import type { BitcoinUnit } from "@core/payments/cashu";
import type { LanguageCode, LanguagePreference } from "@i18n";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { getStorage } from "./mmkv";

// "system" is the unset state, not a listed choice: until you pick a side the
// app is whichever the phone is, and follows it when the phone changes. The
// Appearance picker offers only light and dark, and ticks the resolved one, so
// there is never a row that means "no, really, the other one".
export type ThemePreference = "light" | "dark" | "system";
export type UploadQuality = "low" | "medium" | "high";
// The typeface for the app's monospace text (keys, IDs, geohashes, amounts):
// the device's built-in monospace, or a bundled coding font.
export type MonoFont = "system" | "jetbrains";

// expo-image-picker's `quality` option (0-1 JPEG compression factor).
export const UPLOAD_QUALITY_VALUES: Record<UploadQuality, number> = {
  low: 0.4,
  medium: 0.65,
  high: 0.85,
};

// How long an attachment stays on disk before the retention sweep removes it.
//
// A choice rather than a constant because the ends of the range are different
// situations the app cannot tell apart. A week suits a phone carried through a
// protest, where an old photo on a seized device is the risk. A month suits the
// mesh as an everyday messenger somewhere with no reliable signal, where losing
// a picture is the risk.
//
// No "keep forever": the threat model says an attachment must not outlive its
// conversation, and an unbounded option would retire that promise for whoever
// picked it.
export const MEDIA_RETENTION_DAY_OPTIONS = [7, 14, 30] as const;
export type MediaRetentionDays = (typeof MEDIA_RETENTION_DAY_OPTIONS)[number];

// Which bridge configuration Tor uses.
//
// "off" is a direct connection to a public relay: fastest, and what an
// uncensored network wants. The rest trade speed for hiding that Tor is in use
// at all, which is why none of them is the default.
export type TorBridgeMode = "off" | "obfs4" | "snowflake" | "custom";

interface SettingsState {
  theme: ThemePreference;
  // "system" follows the device language; an explicit choice pins Airhop to it.
  // The stored preference can differ from the rendered language while a restart
  // is required to apply a right-to-left layout direction.
  language: LanguagePreference;
  // Language recorded for the native layout direction. It lives outside MMKV,
  // so it survives the panic wipe along with the native RTL flag and is read
  // once during i18n startup to distinguish Arabic, Persian, and Urdu.
  frameLanguage: LanguageCode | null;
  // Monospace typeface for keys, IDs, geohashes, and amounts.
  monoFont: MonoFont;
  // Seconds to hold a sent message for undo. Zero sends immediately.
  undoSendSeconds: number;
  autoDownloadMedia: boolean;
  uploadQuality: UploadQuality;
  // Days an attachment stays on disk before the retention sweep removes it.
  mediaRetentionDays: MediaRetentionDays;
  // Whether holding the mic streams live or records a voice note.
  liveVoiceEnabled: boolean;
  // Whether notifications hide the sender and message body on the lock screen.
  hideNotificationPreviews: boolean;
  // Master switch for Ring, regardless of each contact's allowRing grant.
  ringAlertsEnabled: boolean;
  // Whether the mesh keeps running after the app is closed.
  backgroundMeshEnabled: boolean;
  // Android only: start the mesh automatically after boot.
  autoStartOnBoot: boolean;
  // Whether to run the mesh over the current WiFi network.
  lanTransportEnabled: boolean;
  // Whether to run the Wi-Fi Aware fast path. On by default; the switch exists
  // for phones whose Wi-Fi chip resets when a data path is opened.
  wifiAwareEnabled: boolean;
  // Master switch for Nostr and other internet-backed features.
  internetEnabled: boolean;
  // Off requires a custom relay; otherwise relay discovery could silently fall
  // back to the bundled directory. The store and merge hook enforce this too.
  geoRelayDiscovery: boolean;
  // User-added relay URLs, also the sole source when discovery is off.
  customRelays: string[];
  // Whether internet traffic uses the embedded Tor client. Persisted so startup
  // never briefly connects to a relay over the clear net.
  torEnabled: boolean;
  // Tor bridge mode and custom bridge lines.
  torBridgeMode: TorBridgeMode;
  torBridgeLines: string;
  // Set before native Tor startup and cleared on its response. If it survives a
  // relaunch, the previous bootstrap failed and the preference is reverted.
  torStartPending: boolean;
  // iOS mint requests use plain fetch, so Tor cannot cover them. This opt-in
  // allows that clear-net request; Android's proxied client does not need it.
  allowMintOverClearnet: boolean;
  // Whether this device relays nearby mesh traffic to the internet.
  gatewayEnabled: boolean;
  // Whether this device bridges public mesh chat to Nostr.
  bridgeEnabled: boolean;
  // Display unit only: satoshis or bitcoin. No conversion or price feed needed.
  bitcoinUnit: BitcoinUnit;
  // Whether the one-time Bluetooth and Location explanation was shown.
  permissionPrimerSeen: boolean;
  // Whether the OEM background-limit notice was acknowledged.
  backgroundLimitsAcknowledged: boolean;
  setTheme: (theme: ThemePreference) => void;
  setLanguage: (language: LanguagePreference) => void;
  setFrameLanguage: (code: LanguageCode) => void;
  setMonoFont: (font: MonoFont) => void;
  setUndoSendSeconds: (seconds: number) => void;
  setAutoDownloadMedia: (enabled: boolean) => void;
  setUploadQuality: (quality: UploadQuality) => void;
  setMediaRetentionDays: (days: MediaRetentionDays) => void;
  setLiveVoiceEnabled: (enabled: boolean) => void;
  setHideNotificationPreviews: (hide: boolean) => void;
  setRingAlertsEnabled: (enabled: boolean) => void;
  setBackgroundMeshEnabled: (enabled: boolean) => void;
  setAutoStartOnBoot: (enabled: boolean) => void;
  setLanTransportEnabled: (enabled: boolean) => void;
  setWifiAwareEnabled: (enabled: boolean) => void;
  setInternetEnabled: (enabled: boolean) => void;
  setGeoRelayDiscovery: (enabled: boolean) => void;
  addCustomRelay: (url: string) => void;
  removeCustomRelay: (url: string) => void;
  setTorEnabled: (enabled: boolean) => void;
  setTorBridgeMode: (mode: TorBridgeMode) => void;
  setTorBridgeLines: (lines: string) => void;
  setTorStartPending: (pending: boolean) => void;
  setAllowMintOverClearnet: (allowed: boolean) => void;
  setGatewayEnabled: (enabled: boolean) => void;
  setBridgeEnabled: (enabled: boolean) => void;
  setBitcoinUnit: (unit: BitcoinUnit) => void;
  markPermissionPrimerSeen: () => void;
  markBackgroundLimitsAcknowledged: () => void;
  // Restore first-run defaults. Used by the panic wipe.
  reset: () => void;
}

const DEFAULTS = {
  theme: "system",
  language: "system",
  // Unknown until the first `applyLayoutDirection`. A fresh install has never
  // called `forceRTL`, so its frame is left to right regardless.
  frameLanguage: null as LanguageCode | null,
  monoFont: "system",
  undoSendSeconds: 2,
  autoDownloadMedia: true,
  uploadQuality: "high",
  mediaRetentionDays: 7,
  liveVoiceEnabled: true,
  hideNotificationPreviews: true,
  ringAlertsEnabled: true,
  backgroundMeshEnabled: true,
  autoStartOnBoot: false,
  lanTransportEnabled: false,
  wifiAwareEnabled: true,
  internetEnabled: true,
  geoRelayDiscovery: true,
  customRelays: [] as string[],
  torEnabled: false,
  torBridgeMode: "off" as TorBridgeMode,
  torBridgeLines: "",
  torStartPending: false,
  allowMintOverClearnet: false,
  gatewayEnabled: false,
  bridgeEnabled: false,
  bitcoinUnit: "sat",
  permissionPrimerSeen: false,
  backgroundLimitsAcknowledged: false,
} satisfies Partial<SettingsState>;

// Settings about this install rather than the person, left behind by a
// transfer: native state, and what this OS has been asked.
export const DEVICE_SETTINGS = [
  "frameLanguage",
  "autoStartOnBoot",
  "torStartPending",
  "permissionPrimerSeen",
  "backgroundLimitsAcknowledged",
] as const satisfies readonly (keyof SettingsState)[];

const storage = getStorage("settings-store");

const mmkvStorage = {
  getItem: (name: string): string | null => storage.getString(name) ?? null,
  setItem: (name: string, value: string): void => storage.set(name, value),
  removeItem: (name: string): void => {
    storage.remove(name);
  },
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...DEFAULTS,

      setTheme(theme) {
        set({ theme });
      },
      setLanguage(language) {
        set({ language });
      },
      setFrameLanguage(code) {
        set({ frameLanguage: code });
      },
      setMonoFont(font) {
        set({ monoFont: font });
      },
      setUndoSendSeconds(seconds) {
        set({ undoSendSeconds: seconds });
      },
      setAutoDownloadMedia(enabled) {
        set({ autoDownloadMedia: enabled });
      },
      setUploadQuality(quality) {
        set({ uploadQuality: quality });
      },
      setMediaRetentionDays(days) {
        set({ mediaRetentionDays: days });
      },
      setLiveVoiceEnabled(enabled) {
        set({ liveVoiceEnabled: enabled });
      },
      setHideNotificationPreviews(hide) {
        set({ hideNotificationPreviews: hide });
      },
      setRingAlertsEnabled(enabled) {
        set({ ringAlertsEnabled: enabled });
      },
      setBackgroundMeshEnabled(enabled) {
        set({ backgroundMeshEnabled: enabled });
      },
      setAutoStartOnBoot(enabled) {
        set({ autoStartOnBoot: enabled });
      },
      setLanTransportEnabled(enabled) {
        set({ lanTransportEnabled: enabled });
      },
      setWifiAwareEnabled(enabled) {
        set({ wifiAwareEnabled: enabled });
      },
      setInternetEnabled(enabled) {
        set({ internetEnabled: enabled });
      },
      setGeoRelayDiscovery(enabled) {
        // Refused where it would break RELAY_SOURCE_INVARIANT. The screen blocks
        // this with an explanation; here it is the backstop for every other
        // writer.
        set((s) =>
          !enabled && s.customRelays.length === 0
            ? s
            : { geoRelayDiscovery: enabled },
        );
      },
      addCustomRelay(url) {
        // The screen validates first, for feedback. This is the backstop: a
        // relay that never met validateRelayUrl must not reach a socket.
        const normalized = validateRelayUrl(url);
        if (normalized === null) return;
        set((s) =>
          s.customRelays.includes(normalized) ||
          s.customRelays.length >= MAX_CUSTOM_RELAYS
            ? s
            : { customRelays: [...s.customRelays, normalized] },
        );
      },
      removeCustomRelay(url) {
        // Normalized as the add was, so a relay can be removed as it was typed.
        const normalized = validateRelayUrl(url) ?? url;
        set((s) => {
          // Replaced only when something actually left: the transport watches
          // this array by reference, and filter() returns a fresh one either
          // way, so a removal that removed nothing would rebuild every live cell.
          if (!s.customRelays.includes(normalized)) return s;
          const customRelays = s.customRelays.filter((r) => r !== normalized);
          return customRelays.length === 0
            ? { customRelays, geoRelayDiscovery: true }
            : { customRelays };
        });
      },
      setTorEnabled(enabled) {
        set({ torEnabled: enabled });
      },
      setTorBridgeMode(mode) {
        set({ torBridgeMode: mode });
      },
      setTorBridgeLines(lines) {
        set({ torBridgeLines: lines });
      },
      setTorStartPending(pending) {
        if (get().torStartPending === pending) return;
        set({ torStartPending: pending });
      },
      setAllowMintOverClearnet(allowed) {
        set({ allowMintOverClearnet: allowed });
      },
      setGatewayEnabled(enabled) {
        set({ gatewayEnabled: enabled });
      },
      setBridgeEnabled(enabled) {
        set({ bridgeEnabled: enabled });
      },
      setBitcoinUnit(unit) {
        set({ bitcoinUnit: unit });
      },
      markPermissionPrimerSeen() {
        set({ permissionPrimerSeen: true });
      },
      markBackgroundLimitsAcknowledged() {
        set({ backgroundLimitsAcknowledged: true });
      },
      reset() {
        // `frameLanguage` is carried through, not defaulted: it describes a
        // native flag a wipe cannot clear, so losing the record would leave the
        // next launch unable to name the direction it woke up in.
        set({ ...DEFAULTS, frameLanguage: get().frameLanguage });
      },
    }),
    {
      name: "settings-store",
      storage: createJSONStorage(() => mmkvStorage),
      version: 1,
      // Re-validate the custom relays coming off disk. MMKV is plain storage,
      // and unlike every other persisted field these are hostnames rehydration
      // hands to a socket, so one written by a looser build (or edited on disk)
      // would arrive having never met validateRelayUrl. Sanitizing can empty the
      // list, the one path that could rehydrate past RELAY_SOURCE_INVARIANT.
      merge: (persisted, current) => {
        const state = (persisted ?? {}) as Partial<SettingsState>;
        const seen = new Set<string>();
        const customRelays: string[] = [];
        for (const raw of state.customRelays ?? []) {
          const url = typeof raw === "string" ? validateRelayUrl(raw) : null;
          if (url === null || seen.has(url)) continue;
          seen.add(url);
          customRelays.push(url);
        }
        const merged = {
          ...current,
          ...state,
          customRelays: customRelays.slice(0, MAX_CUSTOM_RELAYS),
        };
        if (merged.customRelays.length === 0) merged.geoRelayDiscovery = true;
        return merged;
      },
    },
  ),
);
