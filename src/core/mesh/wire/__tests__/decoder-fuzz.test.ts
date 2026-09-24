/** @jest-environment node */
// Every decoder that runs on unauthenticated bytes returns a value or null for
// any input and never throws. The mesh-service ingress catches a throw, but a
// decoder that throws is still a parser bug, and this is where it is found.
//
// Random bytes rarely get past a structured decoder's first field, so each of
// those is also fed damaged copies of its own encoding, built by the encoder
// the app sends with. Seeded, so a failure prints the bytes and replays.
//
// FUZZ_ITERATIONS=200000 npm test -- decoder-fuzz   for a deep run.

import { bytesToHex } from "@noble/hashes/utils.js";
import {
  decodeAirhopChannelPayload,
  decodeMeshPublicPayload,
} from "../../../router/message-router";
import {
  decodeEnvelopePayload,
  encodeEnvelopePayload,
} from "../../courier/courier-store";
import {
  decodeAnnouncePayload,
  decodeCapabilities,
  encodeAnnouncePayload,
} from "../../discovery/announce-manager";
import {
  decodeGroupEnvelope,
  decodeGroupState,
  decodeRoster,
  encodeGroupEnvelope,
  encodeGroupState,
  encodeRoster,
  type GroupMember,
} from "../../rooms/group-protocol";
import { decodeFragmentPayload } from "../../routing/fragment-manager";
import {
  decodeGcsFilter,
  decodeGossipFilterPayload,
  encodeGossipFilterPayload,
} from "../../sync/gossip-sync";
import { decodeBurstPacket, encodeBurstData } from "../../voice/voice-capture";
import { decodeBoardWire, encodeBoardWire } from "../board-packet";
import { decodeDmPayload } from "../dm-payload";
import { decodeFilePacket, encodeFilePacket } from "../file-packet";
import { decodeLocationPin, encodeLocationPin } from "../location-pin";
import { decodeMeshPing } from "../mesh-ping";
import {
  decodeNoisePayload,
  decodePrivateMessagePacket,
  encodePrivateMessagePacket,
} from "../noise-payload";
import {
  CarrierDirection,
  decodeNostrCarrier,
  encodeNostrCarrier,
} from "../nostr-carrier";
import { decodePacket, encodePacket, type Packet } from "../packet-codec";
import {
  decodePeerStatePacket,
  encodePeerStatePacket,
} from "../peer-state-packet";
import { decodePrekeyBundle, encodePrekeyBundle } from "../prekey-bundle";
import {
  decodeRing,
  decodeRingAck,
  decodeRingRefused,
  encodeRingRefused,
  RingRefusalReason,
} from "../ring-payload";

// A typo falls back to the default, not to NaN, which would run nothing and pass.
const ITERATIONS =
  Number.parseInt(process.env.FUZZ_ITERATIONS ?? "", 10) || 3_000;
const SEED = 0x9e3779b9;

// xorshift32: the run has to replay.
let state = SEED;
function rnd(): number {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) / 0x100000000;
}
function int(n: number): number {
  return Math.floor(rnd() * n);
}
function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = int(256);
  return out;
}
function pick<T>(items: readonly T[]): T {
  return items[int(items.length)];
}

// ---- Seeds: valid encodings for the mutator to damage ----

function packetSeed(): Uint8Array {
  const p: Packet = {
    type: pick([0x01, 0x02, 0x04, 0x20, 0x22, 0x24, 0x29, 0x50]),
    ttl: 1 + int(7),
    flags: int(256),
    senderID: bytes(8),
    recipientID: rnd() < 0.5 ? new Uint8Array(8) : bytes(8),
    timestamp: 1_700_000_000_000 + int(1_000_000),
    signature: bytes(64),
    payload: bytes(int(600)),
  };
  if (rnd() < 0.2) p.route = Array.from({ length: int(4) }, () => bytes(8));
  return encodePacket(p);
}

function fileSeed(): Uint8Array {
  return (
    encodeFilePacket({
      fileName: rnd() < 0.8 ? `img_${String(int(1e6))}.jpg` : undefined,
      mimeType: rnd() < 0.8 ? "image/jpeg" : undefined,
      content: bytes(1 + int(300)),
      channel: rnd() < 0.5 ? "#bluetooth" : undefined,
      durationMs: rnd() < 0.3 ? int(60_000) : undefined,
      caption: rnd() < 0.3 ? "x".repeat(int(40)) : undefined,
    }) ?? bytes(32)
  );
}

function members(): GroupMember[] {
  return Array.from({ length: 1 + int(4) }, () => ({
    fingerprint: bytesToHex(bytes(32)),
    signingKey: bytes(32),
    nickname: `n${String(int(1e4))}`,
  }));
}

// ---- Mutations that keep the frame plausible ----

const EXTREMES = [0, 1, 0xff, 0xffff, 0x7fffffff, 0xffffffff, 10 * 1024 * 1024];

function mutate(src: Uint8Array): Uint8Array {
  let b = new Uint8Array(src);
  const ops = 1 + int(4);
  for (let k = 0; k < ops; k++) {
    switch (int(7)) {
      case 0:
        if (b.length) b[int(b.length)] ^= 1 << int(8);
        break;
      case 1:
        if (b.length) b[int(b.length)] = pick([0, 1, 0x7f, 0x80, 0xfe, 0xff]);
        break;
      case 2:
        b = b.slice(0, int(b.length + 1));
        break;
      case 3: {
        const extra = bytes(int(64));
        const out = new Uint8Array(b.length + extra.length);
        out.set(b);
        out.set(extra, b.length);
        b = out;
        break;
      }
      case 4: {
        // A 32-bit extreme at a random offset: the length-prefix attack.
        if (b.length >= 4) {
          const o = int(b.length - 3);
          const v = pick(EXTREMES);
          b[o] = (v >>> 24) & 0xff;
          b[o + 1] = (v >>> 16) & 0xff;
          b[o + 2] = (v >>> 8) & 0xff;
          b[o + 3] = v & 0xff;
        }
        break;
      }
      case 5: {
        // A 16-bit extreme, the TLV length field.
        if (b.length >= 2) {
          const o = int(b.length - 1);
          const v = pick([0, 1, 0xff, 0x7fff, 0x8000, 0xffff]);
          b[o] = (v >>> 8) & 0xff;
          b[o + 1] = v & 0xff;
        }
        break;
      }
      case 6:
        if (b.length) b[0] = pick([0, 1, 2, 3, 0x7f, 0xff]);
        break;
    }
  }
  return b;
}

function randomInput(): Uint8Array {
  return rnd() < 0.5 ? bytes(int(700)) : bytes(int(24));
}

// ---- Targets ----

// A decoder that takes more than the bytes gets plausible values for the rest.
// `seed` is set only where random bytes rarely get past the first field: a TLV
// with a 16-bit length, a version byte, a fixed-size key.
interface Target {
  name: string;
  decode: (b: Uint8Array) => unknown;
  seed?: () => Uint8Array | null;
}

const senderID = bytes(8);
const targets: Target[] = [
  { name: "decodePacket", decode: decodePacket, seed: packetSeed },
  { name: "decodeFilePacket", decode: decodeFilePacket, seed: fileSeed },
  { name: "decodeNoisePayload", decode: decodeNoisePayload },
  {
    name: "decodePrivateMessagePacket",
    decode: decodePrivateMessagePacket,
    seed: () =>
      encodePrivateMessagePacket(`m${String(int(1e6))}`, "x".repeat(int(200))),
  },
  { name: "decodeDmPayload", decode: decodeDmPayload },
  { name: "decodeFragmentPayload", decode: decodeFragmentPayload },
  {
    name: "decodeGossipFilterPayload",
    decode: decodeGossipFilterPayload,
    seed: () =>
      encodeGossipFilterPayload({
        p: 1 + int(30),
        m: 1 + int(1 << 20),
        data: bytes(int(400)),
        types: rnd() < 0.5 ? int(256) : undefined,
        since: rnd() < 0.5 ? 1_700_000_000_000 : undefined,
      }),
  },
  {
    name: "decodeGcsFilter",
    decode: (b) => decodeGcsFilter(1 + int(30), 1 + int(1 << 20), b),
  },
  {
    name: "decodeNostrCarrier",
    decode: decodeNostrCarrier,
    seed: () =>
      encodeNostrCarrier({
        direction: pick([
          CarrierDirection.TO_GATEWAY,
          CarrierDirection.FROM_GATEWAY,
          CarrierDirection.TO_BRIDGE,
          CarrierDirection.FROM_BRIDGE,
        ]),
        geohash: "u4pruyd".slice(0, 1 + int(7)),
        eventJSON: bytes(1 + int(300)),
      }),
  },
  {
    name: "decodeAnnouncePayload",
    decode: (b) => decodeAnnouncePayload(b, senderID),
    seed: () =>
      encodeAnnouncePayload(
        {
          noiseStaticPrivKey: bytes(32),
          noiseStaticPubKey: bytes(32),
          signingPrivKey: bytes(32),
          signingPubKey: bytes(32),
          peerID: bytesToHex(senderID),
        },
        `peer${String(int(1e4))}`,
        Array.from({ length: int(4) }, () => bytes(8)),
        rnd() < 0.5 ? bytes(32) : undefined,
        int(1 << 16),
        rnd() < 0.3 ? "u4pru" : undefined,
      ),
  },
  { name: "decodeCapabilities", decode: decodeCapabilities },
  {
    name: "decodeEnvelopePayload",
    decode: decodeEnvelopePayload,
    seed: () =>
      encodeEnvelopePayload({
        recipientTag: bytes(16),
        expiryMs: 1_700_000_000_000 + int(1e6),
        copies: int(8),
        ciphertext: bytes(1 + int(300)),
        prekeyID: rnd() < 0.5 ? int(1 << 30) : undefined,
      }),
  },
  {
    name: "decodePrekeyBundle",
    decode: decodePrekeyBundle,
    seed: () =>
      encodePrekeyBundle({
        noiseStaticPublicKey: bytes(32),
        prekeys: Array.from({ length: 1 + int(4) }, () => ({
          id: int(1 << 30),
          publicKey: bytes(32),
        })),
        generatedAt: 1_700_000_000_000 + int(1e6),
        signature: bytes(64),
      }),
  },
  {
    name: "decodeBoardWire",
    decode: decodeBoardWire,
    seed: () =>
      encodeBoardWire({
        kind: "post",
        post: {
          postID: bytes(16),
          geohash: rnd() < 0.5 ? "" : "u4pru",
          content: "x".repeat(int(200)),
          authorSigningKey: bytes(32),
          authorNickname: `a${String(int(1e4))}`,
          createdAt: 1_700_000_000_000,
          expiresAt: 1_700_000_000_000 + int(1e8),
          flags: int(2),
          signature: bytes(64),
        },
      }),
  },
  {
    name: "decodePeerStatePacket",
    decode: decodePeerStatePacket,
    seed: () =>
      encodePeerStatePacket({
        capabilities: int(1 << 16),
        signingPubKey: bytes(32),
      }),
  },
  {
    name: "decodeLocationPin",
    decode: decodeLocationPin,
    seed: () =>
      encodeLocationPin({
        lat: rnd() * 180 - 90,
        lng: rnd() * 360 - 180,
        accuracyM: rnd() < 0.5 ? int(5000) : undefined,
        takenAtMs: 1_700_000_000_000,
      }),
  },
  { name: "decodeMeshPing", decode: decodeMeshPing },
  { name: "decodeRing", decode: decodeRing },
  { name: "decodeRingAck", decode: decodeRingAck },
  {
    name: "decodeRingRefused",
    decode: decodeRingRefused,
    seed: () =>
      encodeRingRefused(
        `r${String(int(1e6))}`,
        pick(Object.values(RingRefusalReason)),
      ),
  },
  {
    name: "decodeRoster",
    decode: decodeRoster,
    seed: () => encodeRoster(members()),
  },
  {
    name: "decodeGroupState",
    decode: decodeGroupState,
    seed: () =>
      encodeGroupState({
        groupID: bytes(16),
        name: `g${String(int(1e4))}`,
        epoch: int(1 << 20),
        members: members(),
        creatorFingerprint: bytesToHex(bytes(32)),
        key: bytes(32),
        signature: bytes(64),
      }),
  },
  {
    name: "decodeGroupEnvelope",
    decode: decodeGroupEnvelope,
    seed: () =>
      encodeGroupEnvelope({
        groupID: bytes(16),
        epoch: int(1 << 20),
        nonce: bytes(12),
        ciphertext: bytes(16 + int(300)),
      }),
  },
  {
    name: "decodeBurstPacket",
    decode: decodeBurstPacket,
    seed: () =>
      encodeBurstData(
        bytes(8),
        int(1 << 16),
        Array.from({ length: 1 + int(4) }, () => bytes(1 + int(80))),
      ),
  },
  { name: "decodeMeshPublicPayload", decode: decodeMeshPublicPayload },
  { name: "decodeAirhopChannelPayload", decode: decodeAirhopChannelPayload },
];

test(`no decoder throws on ${String(ITERATIONS)} hostile inputs`, () => {
  const failures: string[] = [];
  const attempt = (t: Target, b: Uint8Array, i: number): void => {
    try {
      t.decode(b);
    } catch (error) {
      failures.push(
        `${t.name} threw ${String(error)} at iteration ${String(i)} on ${String(b.length)} bytes: ${bytesToHex(b.slice(0, 64))}`,
      );
    }
  };
  for (let i = 0; i < ITERATIONS && failures.length < 10; i++) {
    const shared = randomInput();
    for (const t of targets) {
      attempt(t, shared, i);
      const valid = t.seed?.();
      if (valid) attempt(t, mutate(valid), i);
    }
  }
  expect(failures).toEqual([]);
});

// A seed is worth something only if its mutants get past the first guard, or
// every input was refused at the door and the loop above tested nothing.
test.each(targets.filter((t) => t.seed !== undefined))(
  "$name mutants still reach the parser",
  ({ decode, seed }) => {
    const valid = seed?.();
    if (!valid) throw new Error("the encoder refused its own seed");
    expect(decode(valid)).not.toBeNull();
    let decoded = 0;
    for (let i = 0; i < 300; i++) {
      const next = seed?.();
      if (next && decode(mutate(next)) !== null) decoded++;
    }
    expect(decoded).toBeGreaterThan(30);
  },
);
