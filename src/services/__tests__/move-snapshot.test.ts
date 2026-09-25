/**
 * @jest-environment node
 */

// Imports come first in source; Babel hoists jest.mock() calls above them.
import { generateIdentity, saveIdentity } from "@core/crypto/identity";
import { KEYCHAIN_ITEMS, readSecret, writeSecret } from "@core/crypto/keychain";
import { getStorage } from "@store/mmkv";
import * as SecureStore from "expo-secure-store";
import { readMoveMarker } from "../move-marker";
import {
  applyMove,
  isKnownSection,
  MoveApplyError,
  snapshotForMove,
} from "../move-snapshot";
import { MMKV_STORE_IDS } from "../panic-wipe";
import { condemnIdentity, isIdentityCondemned } from "../wipe-marker";

// The same three the panic wipe test replaces: each reaches a native runtime
// at import, and none of them is what a move does.
jest.mock("../file-transfer-service", () => ({
  wipeCacheDirectory: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../notification-service", () => ({
  dismissAllNotifications: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../notification-pipeline", () => ({
  stopNotificationPipeline: jest.fn(),
}));
// Flips a native layout flag; what matters here is only that it is asked.
jest.mock("@i18n", () => ({
  ...jest.requireActual("@i18n"),
  applyLayoutDirection: jest.fn(),
}));

// The same instance keychain.ts imports: the module mapper points both here.
const secureStore = SecureStore as unknown as { __reset: () => void };

const dec = new TextDecoder();

// Each store's own persist version, as its real writes carry it: a mismatched
// one is refused on rehydrate.
function persisted(state: Record<string, unknown>, version = 0): string {
  return JSON.stringify({ state, version });
}

function stateOf(id: string, key: string): Record<string, unknown> {
  const raw = getStorage(id).getString(key);
  return (JSON.parse(raw ?? "{}") as { state: Record<string, unknown> }).state;
}

// Everything a new phone starts without.
function freshPhone(): void {
  for (const id of MMKV_STORE_IDS) getStorage(id).clearAll();
  secureStore.__reset();
}

async function oldPhone() {
  freshPhone();
  const identity = await generateIdentity();
  await saveIdentity(identity);
  await writeSecret(KEYCHAIN_ITEMS.walletRecoveryPhrase, "twelve words here");
  await writeSecret(KEYCHAIN_ITEMS.walletP2pkKey, "ab".repeat(32));
  getStorage("contacts-store").set(
    "contacts-store",
    persisted({ contacts: { "0011223344556677": { nickname: "sam" } } }),
  );
  getStorage("chat-store").set(
    "airhop-chat",
    persisted({
      channels: ["dm:0011223344556677", "#treehouse"],
      messages: { "dm:0011223344556677": [{ id: "m1" }] },
      unreadCounts: { "dm:0011223344556677": 1 },
      lastThread: "dm:0011223344556677",
      channelKeys: { "#treehouse": "a2V5" },
    }),
  );
  getStorage("outbox-store").set(
    "outbox-store",
    persisted({ entries: [{ id: "m2" }] }),
  );
  getStorage("settings-store").set(
    "settings-store",
    persisted(
      {
        theme: "dark",
        permissionPrimerSeen: true,
        autoStartOnBoot: true,
      },
      1,
    ),
  );
  getStorage("prekey-store").set("local", '{"prekeys":["secret"]}');
  getStorage("activity-store").set("activity", persisted({ entries: [] }));
  return identity;
}

function asMap(sections: { name: string; data: Uint8Array }[]) {
  return new Map(sections.map((s) => [s.name, s.data]));
}

describe("transfer snapshot", () => {
  it("carries the identity and the stores that move, and nothing else", async () => {
    await oldPhone();
    const names = (await snapshotForMove(true)).map((s) => s.name);
    expect(names).toContain("secret:identity");
    expect(names).toContain("secret:walletRecoveryPhrase");
    expect(names).toContain("secret:walletP2pkKey");
    expect(names).toContain("mmkv:contacts-store");
    expect(names).toContain("mmkv:outbox-store");
    // One-time prekey privates never leave the phone that made them.
    expect(names).not.toContain("mmkv:prekey-store");
    expect(names).not.toContain("mmkv:activity-store");
    expect(names).not.toContain("secret:walletEncryptionKey");
    expect(names[names.length - 1]).toBe("secret:identity");
  });

  it("leaves messages behind but keeps rooms when history stays", async () => {
    await oldPhone();
    const sections = asMap(await snapshotForMove(false));
    expect(sections.has("mmkv:outbox-store")).toBe(false);
    const chat = JSON.parse(
      dec.decode(sections.get("mmkv:chat-store")),
    ) as Record<string, string>;
    const state = (
      JSON.parse(chat["airhop-chat"]) as {
        state: Record<string, unknown>;
      }
    ).state;
    expect(state.messages).toEqual({});
    expect(state.unreadCounts).toEqual({});
    expect(state.channelKeys).toEqual({ "#treehouse": "a2V5" });
  });

  it("strips the settings that describe the old phone", async () => {
    await oldPhone();
    const sections = asMap(await snapshotForMove(true));
    const settings = JSON.parse(
      dec.decode(sections.get("mmkv:settings-store")),
    ) as Record<string, string>;
    const state = (
      JSON.parse(settings["settings-store"]) as {
        state: Record<string, unknown>;
      }
    ).state;
    expect(state.theme).toBe("dark");
    expect(state).not.toHaveProperty("permissionPrimerSeen");
    expect(state).not.toHaveProperty("autoStartOnBoot");
  });
});

describe("transfer apply", () => {
  it("installs everything on a fresh phone and commits last", async () => {
    const identity = await oldPhone();
    const sections = asMap(await snapshotForMove(true));
    freshPhone();

    const peerID = await applyMove(sections, identity.noiseStaticPubKey);

    expect(peerID).toBe(identity.peerID);
    expect(readMoveMarker()).toBe("committed");
    expect(await readSecret(KEYCHAIN_ITEMS.walletRecoveryPhrase)).toBe(
      "twelve words here",
    );
    expect(stateOf("contacts-store", "contacts-store")).toHaveProperty(
      "contacts",
    );
    expect(getStorage("prekey-store").getString("local")).toBeUndefined();
  });

  it("clears a condemned identity's flag once the moved one is written over it", async () => {
    const identity = await oldPhone();
    const sections = asMap(await snapshotForMove(true));
    freshPhone();
    // An earlier wipe on this phone could not delete its identity.
    condemnIdentity();

    await applyMove(sections, identity.noiseStaticPubKey);

    // Otherwise the next launch would delete the identity that just arrived.
    expect(isIdentityCondemned()).toBe(false);
  });

  it("refuses an identity that is not the one the handshake proved", async () => {
    await oldPhone();
    const sections = asMap(await snapshotForMove(true));
    freshPhone();
    const stranger = await generateIdentity();

    await expect(
      applyMove(sections, stranger.noiseStaticPubKey),
    ).rejects.toBeInstanceOf(MoveApplyError);
    // Refused before the first write, so there is nothing to wipe.
    expect(readMoveMarker()).toBeNull();
    expect(await readSecret(KEYCHAIN_ITEMS.identity)).toBeNull();
    expect(
      getStorage("contacts-store").getString("contacts-store"),
    ).toBeUndefined();
  });

  it("refuses a section it would not know where to put", async () => {
    const identity = await oldPhone();
    const sections = asMap(await snapshotForMove(true));
    sections.set("mmkv:prekey-store", new TextEncoder().encode("{}"));
    freshPhone();
    await expect(
      applyMove(sections, identity.noiseStaticPubKey),
    ).rejects.toBeInstanceOf(MoveApplyError);
  });

  it("knows exactly which sections a move may carry", () => {
    expect(isKnownSection("secret:identity")).toBe(true);
    expect(isKnownSection("wallet")).toBe(true);
    expect(isKnownSection("mmkv:group-store")).toBe(true);
    expect(isKnownSection("secret:walletEncryptionKey")).toBe(false);
    expect(isKnownSection("mmkv:courier-store")).toBe(false);
    expect(isKnownSection("mmkv:move-marker")).toBe(false);
    expect(isKnownSection("mmkv:constructor")).toBe(false);
  });
});
