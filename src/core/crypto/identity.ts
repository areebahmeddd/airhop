// Key generation, peer ID derivation, and secure storage for Airhop identity.
//
// One identity = two key pairs. The X25519 static key is used only for Noise
// XX sessions and derives the peer ID. The Ed25519 key signs packets and seeds
// the Nostr identity. Both private keys live in the OS Keychain/Keystore via
// ./keychain and never leave the device.
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { KEYCHAIN_ITEMS, readSecret, writeSecret } from "./keychain";

// Not here: the Nostr public key. It is secp256k1, derived by HKDF over the
// signing PRIVATE key (deriveNostrPrivKey, core/nostr/gift-wrap), so the
// Ed25519 public key bears no relation to it. MeshService owns it as
// `nostrPubKeyHex`, derived once at construction, and that is what the
// ANNOUNCE TLV and the QR contact card carry.
export interface Identity {
  // X25519 static key pair - used for Noise XX session encryption only
  noiseStaticPrivKey: Uint8Array;
  noiseStaticPubKey: Uint8Array;
  // Ed25519 key pair. Signs packets, and is the SEED the Nostr identity is
  // derived from - not the Nostr identity itself.
  signingPrivKey: Uint8Array;
  signingPubKey: Uint8Array;
  // First 16 hex chars of SHA-256(noiseStaticPubKey) = 8 bytes
  peerID: string;
}

const STORAGE_KEY = KEYCHAIN_ITEMS.identity;

export async function generateIdentity(): Promise<Identity> {
  const noisePriv = crypto.getRandomValues(new Uint8Array(32));
  const noisePub = x25519.getPublicKey(noisePriv);

  const signingPriv = crypto.getRandomValues(new Uint8Array(32));
  const signingPub = ed25519.getPublicKey(signingPriv);

  const peerID = bytesToHex(sha256(noisePub)).slice(0, 16);

  return {
    noiseStaticPrivKey: noisePriv,
    noiseStaticPubKey: noisePub,
    signingPrivKey: signingPriv,
    signingPubKey: signingPub,
    peerID,
  };
}

export async function saveIdentity(id: Identity): Promise<void> {
  await writeSecret(
    STORAGE_KEY,
    JSON.stringify({
      noisePrivHex: bytesToHex(id.noiseStaticPrivKey),
      signingPrivHex: bytesToHex(id.signingPrivKey),
    }),
  );
}

export async function loadIdentity(): Promise<Identity | null> {
  const raw = await readSecret(STORAGE_KEY);
  if (!raw) return null;

  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("noisePrivHex" in parsed) ||
    !("signingPrivHex" in parsed) ||
    typeof (parsed as Record<string, unknown>).noisePrivHex !== "string" ||
    typeof (parsed as Record<string, unknown>).signingPrivHex !== "string"
  ) {
    return null;
  }

  const noisePriv = hexToBytes((parsed as Record<string, string>).noisePrivHex);
  const signingPriv = hexToBytes(
    (parsed as Record<string, string>).signingPrivHex,
  );
  const noisePub = x25519.getPublicKey(noisePriv);
  const signingPub = ed25519.getPublicKey(signingPriv);

  return {
    noiseStaticPrivKey: noisePriv,
    noiseStaticPubKey: noisePub,
    signingPrivKey: signingPriv,
    signingPubKey: signingPub,
    peerID: bytesToHex(sha256(noisePub)).slice(0, 16),
  };
}

// The panic wipe is `wipeAllSecrets` in ./keychain, called directly by
// utils/panic-wipe.ts. It walks the item registry, so it belongs beside it.
