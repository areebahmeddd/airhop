/** @jest-environment node */
// Every decoder that runs on unauthenticated bytes returns a value or null
// for any input, and never throws. mesh-service's ingress would catch a throw
// and drop the frame, but a decoder that can throw is a parser bug, and this
// is where it is found.
//
// Random bytes fail the first length check and never reach the code worth
// testing, so most inputs start as a valid encoding and are damaged. Seeded,
// so a failure prints the bytes and replays.
//
// FUZZ_ITERATIONS=200000 npm test -- decoder-fuzz   for a deep run.

import { bytesToHex } from "@noble/hashes/utils.js";
import { decodeEnvelopePayload } from "../../courier/courier-store";
import {
  decodeAnnouncePayload,
  decodeCapabilities,
} from "../../discovery/announce-manager";
import {
  decodeGroupEnvelope,
  decodeGroupState,
  decodeRoster,
} from "../../rooms/group-protocol";
import { decodeFragmentPayload } from "../../routing/fragment-manager";
import {
  decodeGcsFilter,
  decodeGossipFilterPayload,
} from "../../sync/gossip-sync";
import { decodeBurstPacket } from "../../voice/voice-capture";
import { decodeBoardWire } from "../board-packet";
import { decodeDmPayload } from "../dm-payload";
import { decodeFilePacket, encodeFilePacket } from "../file-packet";
import { decodeLocationPin } from "../location-pin";
import { decodeMeshPing } from "../mesh-ping";
import {
  decodeNoisePayload,
  decodePrivateMessagePacket,
} from "../noise-payload";
import { decodeNostrCarrier } from "../nostr-carrier";
import { decodePacket, encodePacket, type Packet } from "../packet-codec";
import { decodePeerStatePacket } from "../peer-state-packet";
import { decodePrekeyBundle } from "../prekey-bundle";
import { decodeRing, decodeRingAck, decodeRingRefused } from "../ring-payload";

const ITERATIONS = Number(process.env.FUZZ_ITERATIONS ?? 3_000);
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
      fileName: rnd() < 0.8 ? `img_${int(1e6)}.jpg` : undefined,
      mimeType: rnd() < 0.8 ? "image/jpeg" : undefined,
      content: bytes(1 + int(300)),
      channel: rnd() < 0.5 ? "#bluetooth" : undefined,
      durationMs: rnd() < 0.3 ? int(60_000) : undefined,
      caption: rnd() < 0.3 ? "x".repeat(int(40)) : undefined,
    }) ?? bytes(32)
  );
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

function input(): Uint8Array {
  const r = rnd();
  if (r < 0.4) return mutate(packetSeed());
  if (r < 0.7) return mutate(fileSeed());
  if (r < 0.85) return bytes(int(700));
  return bytes(int(24));
}

// A decoder that takes more than the bytes gets plausible values for the rest.
const senderID = bytes(8);
const decoders: [string, (b: Uint8Array) => unknown][] = [
  ["decodePacket", (b) => decodePacket(b)],
  ["decodeFilePacket", (b) => decodeFilePacket(b)],
  ["decodeNoisePayload", (b) => decodeNoisePayload(b)],
  ["decodePrivateMessagePacket", (b) => decodePrivateMessagePacket(b)],
  ["decodeDmPayload", (b) => decodeDmPayload(b)],
  ["decodeFragmentPayload", (b) => decodeFragmentPayload(b)],
  ["decodeGossipFilterPayload", (b) => decodeGossipFilterPayload(b)],
  ["decodeGcsFilter", (b) => decodeGcsFilter(1 + int(30), 1 + int(1 << 20), b)],
  ["decodeNostrCarrier", (b) => decodeNostrCarrier(b)],
  ["decodeAnnouncePayload", (b) => decodeAnnouncePayload(b, senderID)],
  ["decodeCapabilities", (b) => decodeCapabilities(b)],
  ["decodeEnvelopePayload", (b) => decodeEnvelopePayload(b)],
  ["decodePrekeyBundle", (b) => decodePrekeyBundle(b)],
  ["decodeBoardWire", (b) => decodeBoardWire(b)],
  ["decodePeerStatePacket", (b) => decodePeerStatePacket(b)],
  ["decodeLocationPin", (b) => decodeLocationPin(b)],
  ["decodeMeshPing", (b) => decodeMeshPing(b)],
  ["decodeRing", (b) => decodeRing(b)],
  ["decodeRingAck", (b) => decodeRingAck(b)],
  ["decodeRingRefused", (b) => decodeRingRefused(b)],
  ["decodeRoster", (b) => decodeRoster(b)],
  ["decodeGroupState", (b) => decodeGroupState(b)],
  ["decodeGroupEnvelope", (b) => decodeGroupEnvelope(b)],
  ["decodeBurstPacket", (b) => decodeBurstPacket(b)],
];

test(`no decoder throws on ${String(ITERATIONS)} hostile inputs`, () => {
  const failures: string[] = [];
  for (let i = 0; i < ITERATIONS && failures.length < 10; i++) {
    const b = input();
    for (const [name, decode] of decoders) {
      try {
        decode(b);
      } catch (error) {
        failures.push(
          `${name} threw ${String(error)} at iteration ${String(i)} on ${String(b.length)} bytes: ${bytesToHex(b.slice(0, 64))}`,
        );
      }
    }
  }
  expect(failures).toEqual([]);
});

// A share of the damaged packets must still decode, or every input was
// refused at the door and the loop above tested nothing.
test("mutated packets still reach the parser", () => {
  let decoded = 0;
  for (let i = 0; i < 500; i++) {
    if (decodePacket(mutate(packetSeed())) !== null) decoded++;
  }
  expect(decoded).toBeGreaterThan(50);
});
