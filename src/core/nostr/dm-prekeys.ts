// Forward secrecy for internet DMs between Airhop phones: the keys a phone
// hands each contact privately, and the seal a DM is put under with one.
//
// A gift wrap (NIP-17) is encrypted to the recipient's long-term Nostr key,
// and relays keep it, so a key leaked later opens every one kept. Between
// Airhop phones the bitchat1 envelope inside goes sealed (Noise X, as courier
// mail is) to a key the recipient handed over and later deletes:
//
//   one-time    used once, handed out a few at a time to one contact only,
//               deleted as it opens
//   last resort reused, replaced every week and deleted after a grace, so a
//               long one-way stretch still seals to a key that goes
//
// The batch travels inside a session (Noise payload 0x57) or inside a gift
// wrap (an Airhop bitchat1 envelope), never broadcast and never published,
// so relays learn nothing and no stranger can spend a contact's keys. It is
// signed by the issuer's Ed25519 key and names its recipient, so a batch
// forwarded to someone else is refused. A sender holding no key it may seal
// to (first contact, a long silence) sends under the long-term key as bitchat
// does, and the recipient answers with a batch.
//
//   batch  [version=1][flags u8: bit 0 resend queued mail][issuedAt u64]
//          [lastResort: id u32, pub 32, createdAt u64]
//          [n u8][n x (id u32, pub 32)][sig 64]
//   sealed "airhop1:" + base64url([kind u8][id u32][Noise X seal of
//          [len u16][bitchat1 envelope, UTF-8][zeros to the bucket]])

import { ed25519 } from "@noble/curves/ed25519.js";
import { concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { noiseXOpen, noiseXSeal } from "../crypto/noise-x";
import { base64UrlToBytes, bytesToBase64Url } from "../encoding/base64";

export const DM_PREKEY_ONE_TIME = 0;
export const DM_PREKEY_LAST_RESORT = 1;
export type DmPrekeyKind =
  typeof DM_PREKEY_ONE_TIME | typeof DM_PREKEY_LAST_RESORT;

export const SEALED_DM_PREFIX = "airhop1:";
// One-time keys in one batch: enough for a reply each way between top-ups.
export const DM_PREKEYS_PER_BATCH = 3;

const VERSION = 1;
const FLAG_RESEND = 0x01;
const HEADER_BYTES = 55;
const SIGN_DOMAIN = new TextEncoder().encode("airhop-dm-prekeys-v1");
const SEAL_PROLOGUE = new TextEncoder().encode("airhop-dm-prekey-seal-v1");
// bitchat's buckets. A private message carries at most 255 bytes of text
// (PRIVATE_MESSAGE_MAX_CONTENT_BYTES), so a short envelope fits 512 and the
// longest, incompressible text with a timer, fits 1024.
const PAD_BUCKETS = [256, 512, 1024, 2048];

export interface DmPrekey {
  id: number;
  pub: Uint8Array;
}

export interface DmPrekeyBatch {
  // Rises with every batch its issuer hands out, so a recipient keeps the
  // newest whatever order they arrive in.
  issuedAt: number;
  lastResort: DmPrekey & { createdAt: number };
  oneTime: DmPrekey[];
  // Sent because a message to the issuer did not open: the recipient sends
  // its queued mail to the issuer again, under these keys.
  resend: boolean;
}

function u32(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function u64(value: number): number[] {
  return [...u32(Math.floor(value / 2 ** 32)), ...u32(value % 2 ** 32)];
}

function body(batch: DmPrekeyBatch): Uint8Array {
  const out = [
    VERSION,
    batch.resend ? FLAG_RESEND : 0,
    ...u64(batch.issuedAt),
    ...u32(batch.lastResort.id),
    ...batch.lastResort.pub,
    ...u64(batch.lastResort.createdAt),
    batch.oneTime.length,
  ];
  for (const key of batch.oneTime) out.push(...u32(key.id), ...key.pub);
  return Uint8Array.from(out);
}

function signed(unsigned: Uint8Array, recipientPeerID: string): Uint8Array {
  return concatBytes(SIGN_DOMAIN, hexToBytes(recipientPeerID), unsigned);
}

export function encodeDmPrekeyBatch(
  batch: DmPrekeyBatch,
  recipientPeerID: string,
  signingPrivKey: Uint8Array,
): Uint8Array {
  const unsigned = body(batch);
  const sig = ed25519.sign(signed(unsigned, recipientPeerID), signingPrivKey);
  return concatBytes(unsigned, sig);
}

// A batch meant for `recipientPeerID` and signed by the issuer's key, or null.
export function decodeDmPrekeyBatch(
  bytes: Uint8Array,
  recipientPeerID: string,
  issuerSigningPubKey: Uint8Array,
): DmPrekeyBatch | null {
  if (bytes.length < HEADER_BYTES + 64 || bytes[0] !== VERSION) return null;
  const n = bytes[HEADER_BYTES - 1];
  if (n > DM_PREKEYS_PER_BATCH || bytes.length !== HEADER_BYTES + n * 36 + 64) {
    return null;
  }
  const unsigned = bytes.subarray(0, bytes.length - 64);
  const sig = bytes.subarray(bytes.length - 64);
  try {
    if (
      !ed25519.verify(
        sig,
        signed(unsigned, recipientPeerID),
        issuerSigningPubKey,
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const oneTime: DmPrekey[] = [];
  for (let i = 0; i < n; i++) {
    const at = HEADER_BYTES + i * 36;
    oneTime.push({
      id: view.getUint32(at),
      pub: bytes.slice(at + 4, at + 36),
    });
  }
  const u64At = (at: number): number =>
    view.getUint32(at) * 2 ** 32 + view.getUint32(at + 4);
  return {
    issuedAt: u64At(2),
    lastResort: {
      id: view.getUint32(10),
      pub: bytes.slice(14, 46),
      createdAt: u64At(46),
    },
    oneTime,
    resend: (bytes[1] & FLAG_RESEND) !== 0,
  };
}

function pad(plain: Uint8Array): Uint8Array | null {
  const bucket = PAD_BUCKETS.find((b) => b >= plain.length + 2);
  if (bucket === undefined) return null;
  const out = new Uint8Array(bucket);
  out[0] = plain.length >> 8;
  out[1] = plain.length & 0xff;
  out.set(plain, 2);
  return out;
}

function unpad(padded: Uint8Array): Uint8Array | null {
  if (padded.length < 2) return null;
  const length = (padded[0] << 8) | padded[1];
  return length + 2 <= padded.length ? padded.slice(2, 2 + length) : null;
}

// A bitchat1 envelope sealed to one of the recipient's keys, as the rumor's
// content. Null for one longer than any envelope a message makes.
export function sealDmToPrekey(
  envelope: string,
  kind: DmPrekeyKind,
  key: DmPrekey,
  senderNoisePrivKey: Uint8Array,
): string | null {
  const padded = pad(new TextEncoder().encode(envelope));
  if (padded === null) return null;
  const sealed = noiseXSeal(senderNoisePrivKey, key.pub, padded, SEAL_PROLOGUE);
  return (
    SEALED_DM_PREFIX +
    bytesToBase64Url(concatBytes(Uint8Array.of(kind, ...u32(key.id)), sealed))
  );
}

// Which key a sealed rumor names, or null for anything else.
export function parseSealedDm(
  content: string,
): { kind: DmPrekeyKind; id: number; sealed: Uint8Array } | null {
  if (!content.startsWith(SEALED_DM_PREFIX)) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(content.slice(SEALED_DM_PREFIX.length));
  } catch {
    return null;
  }
  if (bytes.length < 5) return null;
  const kind = bytes[0];
  if (kind !== DM_PREKEY_ONE_TIME && kind !== DM_PREKEY_LAST_RESORT) {
    return null;
  }
  const id = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1);
  return { kind, id, sealed: bytes.slice(5) };
}

// The bitchat1 envelope inside, and the Noise static key that sealed it, or
// null when this key does not open it.
export function openSealedDm(
  sealed: Uint8Array,
  priv: Uint8Array,
): { envelope: string; senderNoisePubKey: Uint8Array } | null {
  try {
    const { plaintext, senderStaticPubKey } = noiseXOpen(
      priv,
      sealed,
      SEAL_PROLOGUE,
    );
    const plain = unpad(plaintext);
    if (plain === null) return null;
    return {
      envelope: new TextDecoder("utf-8", { fatal: true }).decode(plain),
      senderNoisePubKey: senderStaticPubKey,
    };
  } catch {
    return null;
  }
}
