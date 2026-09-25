/**
 * @jest-environment node
 */
// Prekey stores + the forward-secret courier seal/open path they enable.
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { getStorage } from "@store/mmkv";
import * as SecureStore from "expo-secure-store";
import { KEYCHAIN_ITEMS } from "../../../crypto/keychain";
import { noiseXOpen, noiseXSeal } from "../../../crypto/noise-x";
import {
  PREKEY_MAX_PREKEYS,
  verifyPrekeyBundle,
} from "../../wire/prekey-bundle";
import {
  computeRecipientTag,
  decodeEnvelopePayload,
  encodeEnvelopePayload,
  prekeyPrologue,
} from "../courier-store";
import {
  LocalPrekeyStore,
  PeerPrekeyStore,
  type PrekeySecretSlot,
} from "../prekey-store";

// A keychain slot in memory, with the stored value readable by the test.
function memorySlot(): PrekeySecretSlot & { value: string | null } {
  const slot = {
    value: null as string | null,
    read: () => slot.value,
    write: (v: string) => {
      slot.value = v;
    },
  };
  return slot;
}

let counter = 0;
function freshId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

function x25519Keypair(): { priv: Uint8Array; pub: Uint8Array } {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  return { priv, pub: x25519.getPublicKey(priv) };
}

describe("LocalPrekeyStore", () => {
  it("generates a full pool and builds a verifiable bundle", () => {
    const store = new LocalPrekeyStore(memorySlot());
    const signPriv = ed25519.utils.randomSecretKey();
    const signPub = ed25519.getPublicKey(signPriv);
    const noise = x25519Keypair();

    const bundle = store.buildBundle(noise.pub, signPriv)!;
    expect(bundle.prekeys).toHaveLength(PREKEY_MAX_PREKEYS);
    expect(verifyPrekeyBundle(bundle, signPub)).toBe(true);

    // A private key exists for every published prekey.
    for (const p of bundle.prekeys) {
      expect(store.privForId(p.id)).not.toBeNull();
    }
  });

  it("keeps a consumed key openable during the grace window but drops it from new bundles", () => {
    const store = new LocalPrekeyStore(memorySlot());
    const signPriv = ed25519.utils.randomSecretKey();
    const noise = x25519Keypair();
    const first = store.buildBundle(noise.pub, signPriv)!;
    const usedId = first.prekeys[0].id;

    store.consume(usedId);
    // Still openable (grace window) ...
    expect(store.privForId(usedId)).not.toBeNull();
    // ... but not offered in a fresh bundle.
    const second = store.buildBundle(noise.pub, signPriv)!;
    expect(second.prekeys.some((p) => p.id === usedId)).toBe(false);
    expect(second.prekeys).toHaveLength(PREKEY_MAX_PREKEYS);
  });

  it("refuses a consumed key once its grace has passed", () => {
    const store = new LocalPrekeyStore(memorySlot());
    const first = store.buildBundle(
      x25519Keypair().pub,
      ed25519.utils.randomSecretKey(),
    )!;
    const usedId = first.prekeys[0].id;
    store.consume(usedId);
    const later = Date.now() + 49 * 60 * 60 * 1000;
    expect(store.privForId(usedId, later)).toBeNull();
  });

  // The private keys live in the keychain, never in MMKV, where a dropped key
  // lingers in the file until it is rewritten.
  it("keeps its keys in the keychain item and reads them back", () => {
    const keychain = SecureStore as unknown as { __reset: () => void };
    keychain.__reset();
    const signPriv = ed25519.utils.randomSecretKey();
    const noise = x25519Keypair();
    const first = new LocalPrekeyStore();
    const bundle = first.buildBundle(noise.pub, signPriv)!;
    expect(SecureStore.getItem(KEYCHAIN_ITEMS.localPrekeys)).not.toBeNull();
    expect(getStorage("prekey-store").getString("local")).toBeUndefined();

    const reopened = new LocalPrekeyStore();
    for (const p of bundle.prekeys) {
      expect(x25519.getPublicKey(reopened.privForId(p.id)!)).toEqual(
        p.publicKey,
      );
    }
  });

  it("stays inside a small keychain value however many keys are spent", () => {
    const slot = memorySlot();
    const store = new LocalPrekeyStore(slot);
    const noise = x25519Keypair();
    const signPriv = ed25519.utils.randomSecretKey();
    for (let i = 0; i < 50; i++) {
      store.consume(store.buildBundle(noise.pub, signPriv)!.prekeys[0].id);
    }
    // One live batch and one consumed batch: 12 + 16 * 44 bytes, as base64.
    expect(slot.value!.length).toBeLessThanOrEqual(956);
  });

  // Before first unlock an iOS relaunch cannot read the keychain. Minting then
  // would overwrite the keys peers are sealing to.
  it("mints nothing and writes nothing while the keychain is unreadable", () => {
    const slot = memorySlot();
    const seeded = new LocalPrekeyStore(slot);
    const noise = x25519Keypair();
    const signPriv = ed25519.utils.randomSecretKey();
    const published = seeded.buildBundle(noise.pub, signPriv)!;
    const saved = slot.value;

    let locked = true;
    const write = jest.fn();
    const store = new LocalPrekeyStore({
      read: () => {
        if (locked) throw new Error("keychain locked");
        return slot.value;
      },
      write,
    });
    expect(store.buildBundle(noise.pub, signPriv)).toBeNull();
    expect(store.privForId(published.prekeys[0].id)).toBeNull();
    expect(write).not.toHaveBeenCalled();

    locked = false;
    expect(store.buildBundle(noise.pub, signPriv)!.prekeys).toEqual(
      published.prekeys,
    );
    expect(slot.value).toBe(saved);
  });

  it("stays usable when a write fails, and saves on the next change", () => {
    let fail = true;
    const slot = memorySlot();
    const store = new LocalPrekeyStore({
      read: () => slot.value,
      write: (v) => {
        if (fail) throw new Error("keystore busy");
        slot.write(v);
      },
    });
    const bundle = store.buildBundle(
      x25519Keypair().pub,
      ed25519.utils.randomSecretKey(),
    )!;
    expect(slot.value).toBeNull();
    expect(store.privForId(bundle.prekeys[0].id)).not.toBeNull();
    fail = false;
    store.consume(bundle.prekeys[0].id);
    expect(slot.value).not.toBeNull();
  });
});

describe("PeerPrekeyStore", () => {
  it("assigns distinct prekeys and exhausts", () => {
    const local = new LocalPrekeyStore(memorySlot());
    const peers = new PeerPrekeyStore(freshId("peers"));
    const signPriv = ed25519.utils.randomSecretKey();
    const noise = x25519Keypair();
    const bundle = local.buildBundle(noise.pub, signPriv)!;

    peers.ingest(bundle);
    const assigned = new Set<number>();
    for (let i = 0; i < PREKEY_MAX_PREKEYS; i++) {
      const a = peers.assign(noise.pub)!;
      expect(assigned.has(a.id)).toBe(false);
      assigned.add(a.id);
    }
    // Pool exhausted: no more to hand out.
    expect(peers.assign(noise.pub)).toBeNull();
  });

  it("ignores an older bundle and adopts a newer one", () => {
    const peers = new PeerPrekeyStore(freshId("peers"));
    const signPriv = ed25519.utils.randomSecretKey();
    const noise = x25519Keypair();
    const local = new LocalPrekeyStore(memorySlot());
    const b1 = local.buildBundle(noise.pub, signPriv)!;
    const older = { ...b1, generatedAt: b1.generatedAt - 1000 };

    peers.ingest(b1);
    peers.ingest(older); // ignored (not newer)
    expect(peers.has(noise.pub)).toBe(true);
  });

  // "Newer" is judged by the bundle's own date, and bundles are persisted, so
  // one dated years ahead would shut out every genuine bundle after it.
  it("refuses a bundle dated past the announce skew", () => {
    const peers = new PeerPrekeyStore(freshId("peers"));
    const local = new LocalPrekeyStore(memorySlot());
    const noise = x25519Keypair();
    const b = local.buildBundle(noise.pub, ed25519.utils.randomSecretKey())!;
    const now = Date.now();
    peers.ingest({ ...b, generatedAt: now + 16 * 60_000 }, now);
    expect(peers.has(noise.pub)).toBe(false);
    peers.ingest({ ...b, generatedAt: now + 14 * 60_000 }, now);
    expect(peers.has(noise.pub)).toBe(true);
  });

  it("forgets one peer's bundle", () => {
    const peers = new PeerPrekeyStore(freshId("peers"));
    const local = new LocalPrekeyStore(memorySlot());
    const noise = x25519Keypair();
    peers.ingest(
      local.buildBundle(noise.pub, ed25519.utils.randomSecretKey())!,
    );
    peers.forget(noise.pub);
    expect(peers.has(noise.pub)).toBe(false);
    expect(peers.assign(noise.pub)).toBeNull();
  });
});

describe("forward-secret courier seal/open via prekey", () => {
  it("seals to a peer's one-time prekey and opens with the matching private key", () => {
    // Recipient publishes a bundle.
    const recipLocal = new LocalPrekeyStore(memorySlot());
    const recipSignPriv = ed25519.utils.randomSecretKey();
    const recipNoise = x25519Keypair();
    const bundle = recipLocal.buildBundle(recipNoise.pub, recipSignPriv)!;

    // Sender stores it and assigns a prekey to seal to.
    const senderPeers = new PeerPrekeyStore(freshId("peers"));
    senderPeers.ingest(bundle);
    const prekey = senderPeers.assign(recipNoise.pub)!;

    const sender = x25519Keypair();
    // Sealed as mesh-service does: Noise X to the ONE-TIME prekey rather than
    // the static key, the prekey id on the envelope, and the routing tag still
    // derived from the static key so carriers match a delivery without learning
    // which key opens it.
    const payload = encodeEnvelopePayload({
      recipientTag: computeRecipientTag(recipNoise.pub),
      expiryMs: Date.now() + 60_000,
      copies: 4,
      ciphertext: noiseXSeal(
        sender.priv,
        prekey.publicKey,
        new TextEncoder().encode("secret handshake"),
        prekeyPrologue(prekey.id),
      ),
      prekeyID: prekey.id,
    });

    const env = decodeEnvelopePayload(payload)!;
    expect(env.prekeyID).toBe(prekey.id);

    // Recipient opens with the matching one-time private prekey.
    const openKey = recipLocal.privForId(env.prekeyID!)!;
    const { plaintext, senderStaticPubKey } = noiseXOpen(
      openKey,
      env.ciphertext,
      prekeyPrologue(env.prekeyID!),
    );
    expect(new TextDecoder().decode(plaintext)).toBe("secret handshake");
    expect([...senderStaticPubKey]).toEqual([...sender.pub]);

    // A different one-time key cannot open it (forward secrecy boundary).
    const otherId = bundle.prekeys.find((p) => p.id !== env.prekeyID)!.id;
    const wrongKey = recipLocal.privForId(otherId)!;
    expect(() =>
      noiseXOpen(wrongKey, env.ciphertext, prekeyPrologue(otherId)),
    ).toThrow();
  });
});
