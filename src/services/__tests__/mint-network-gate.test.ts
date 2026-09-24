/**
 * @jest-environment node
 */
// When the wallet refuses to talk to a mint.
//
// The Internet switch closes the gate on both platforms. Tor closes it on iOS
// only: there Tor wraps nostr-tools' WebSockets but not `fetch`, so a mint call
// would leave in the clear carrying the user's mint, amounts and IP. On Android
// the proxy sits in the OkHttp client `fetch` is built from, so a mint call
// under Tor is tunnelled or fails, and refusing it would only take deposits and
// withdrawals away from every Android user. The Wallet screen disables its
// actions off this same predicate.
//
// Covered here rather than in the simulator, where `Platform.OS` is one global
// shared by every simulated phone.

jest.mock("@bridge/NativeAirhopBLE", () => ({
  __esModule: true,
  default: {},
}));
jest.mock("@bridge/NativeAirhopWiFi", () => ({
  __esModule: true,
  default: {},
}));

import { useMeshStateStore } from "@store/mesh-state-store";
import { useSettingsStore } from "@store/settings-store";
import { Platform } from "react-native";
import { mintNetworkBlock } from "../wallet-service";

function isMintNetworkBlocked(): boolean {
  return mintNetworkBlock() !== null;
}

function setPlatform(os: "ios" | "android"): void {
  Object.defineProperty(Platform, "OS", { value: os, configurable: true });
}

const originalOS = Platform.OS;

beforeEach(() => {
  useMeshStateStore.getState().setTorActive(false);
  useMeshStateStore.getState().setNostrBlockedByTor(false);
  useSettingsStore.getState().setTorEnabled(false);
  useSettingsStore.getState().setAllowMintOverClearnet(false);
  useSettingsStore.getState().setInternetEnabled(true);
});

afterAll(() => {
  setPlatform(originalOS as "ios" | "android");
});

describe("mint network gate", () => {
  it("allows mint calls with Tor down, on either platform", () => {
    for (const os of ["ios", "android"] as const) {
      setPlatform(os);
      expect(isMintNetworkBlocked()).toBe(false);
    }
  });

  it("blocks mint calls on iOS while Tor is up", () => {
    setPlatform("ios");
    useMeshStateStore.getState().setTorActive(true);
    expect(isMintNetworkBlocked()).toBe(true);
  });

  // The informed override: Settings explains the leak before it is allowed.
  it("lets an iOS user opt in to clearnet mint traffic knowingly", () => {
    setPlatform("ios");
    useMeshStateStore.getState().setTorActive(true);
    expect(isMintNetworkBlocked()).toBe(true);

    useSettingsStore.getState().setAllowMintOverClearnet(true);
    expect(isMintNetworkBlocked()).toBe(false);
  });

  it("does not block on Android in any Tor state", () => {
    // Swept, because the invariant is about the platform, not the flags. It
    // includes Tor wanted with no circuit yet, where the request points at a
    // port that tunnels or does not answer.
    setPlatform("android");
    for (const torEnabled of [false, true]) {
      for (const torActive of [false, true]) {
        for (const blocked of [false, true]) {
          useSettingsStore.getState().setTorEnabled(torEnabled);
          useMeshStateStore.getState().setTorActive(torActive);
          useMeshStateStore.getState().setNostrBlockedByTor(blocked);
          expect(isMintNetworkBlocked()).toBe(false);
        }
      }
    }
  });

  // The gate keys off the Tor preference and circuit, never `nostrBlocked`, so
  // a stale flag cannot take the wallet offline with Tor switched off.
  it("stays open on iOS when Tor was never asked for", () => {
    setPlatform("ios");
    useMeshStateStore.getState().setNostrBlockedByTor(true);
    expect(isMintNetworkBlocked()).toBe(false);
  });

  it("re-blocks the moment Tor comes back up", () => {
    setPlatform("ios");
    useMeshStateStore.getState().setTorActive(true);
    expect(isMintNetworkBlocked()).toBe(true);
    useMeshStateStore.getState().setTorActive(false);
    expect(isMintNetworkBlocked()).toBe(false);
    useMeshStateStore.getState().setTorActive(true);
    expect(isMintNetworkBlocked()).toBe(true);
  });

  // The Internet switch wins over Tor, so the screen names the switch.
  it("closes on either platform while the Internet switch is off", () => {
    for (const os of ["ios", "android"] as const) {
      setPlatform(os);
      useSettingsStore.getState().setInternetEnabled(false);
      expect(mintNetworkBlock()).toBe("internet-off");
      useSettingsStore.getState().setTorEnabled(true);
      expect(mintNetworkBlock()).toBe("internet-off");
      useSettingsStore.getState().setTorEnabled(false);
      useSettingsStore.getState().setInternetEnabled(true);
      expect(mintNetworkBlock()).toBeNull();
    }
  });

  it("names Tor as the reason on iOS when the internet is on", () => {
    setPlatform("ios");
    useSettingsStore.getState().setTorEnabled(true);
    expect(mintNetworkBlock()).toBe("tor");
  });
});
