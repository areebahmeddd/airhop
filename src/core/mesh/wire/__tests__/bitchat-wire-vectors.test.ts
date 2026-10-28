// Replays bitchat-ios's shared wire vectors (fixtures/bitchat-ios.json) against
// Airhop's own codecs.
//
// The file is bitchat-ios's, copied byte for byte from its test target, where
// BitchatVectorReplayTests and BitchatAppVectorReplayTests replay the same cases
// against the iOS codecs. Never edit or regenerate it here: refresh it from
// upstream, then fix whatever stops passing.
//
// Three outcomes per case. A plain test asserts bitchat-ios's expected value,
// adapted in place where a comment says why (DEFLATE streams, noise payload
// dispatch). A case in SKIPPED pins an input Airhop's API cannot express by
// design. A case in DIVERGES still asserts bitchat's value and is marked
// `test.failing`, so a fix turns it red and it can then move back to plain.
//
// Hex in the file is lowercase, and `repeat:xx*N` stands for byte xx repeated
// N times.

import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Identity } from "../../../crypto/identity";
import { peerIDFromNoiseKey } from "../../../crypto/peer-id";
import {
  decodeAnnouncePayload,
  decodeCapabilities,
  encodeAnnouncePayload,
  encodeCapabilities,
} from "../../discovery/announce-manager";
import { FragmentManager } from "../../routing/fragment-manager";
import { decodeFilePacket, encodeFilePacket } from "../file-packet";
import { optimalBlockSize, pad, unpad } from "../message-padding";
import {
  decodeNoisePayload,
  decodePrivateMessagePacket,
  encodeNoisePayload,
  encodePrivateMessagePacket,
  NoisePayloadType,
} from "../noise-payload";
import {
  BROADCAST_ID,
  decodePacket,
  encodePacket,
  Flags,
  verifyPacket,
  type Packet,
} from "../packet-codec";
import { compress, decompress, shouldCompress } from "../packet-compression";
import {
  decodePeerStatePacket,
  encodePeerStatePacket,
} from "../peer-state-packet";
import fixture from "./fixtures/bitchat-ios.json";

interface VectorCase<I, E> {
  kind: string;
  name: string;
  input: I;
  expected: E;
}

type Hex = string;

const ALL = fixture.cases as unknown as VectorCase<unknown, unknown>[];

// Cases whose input Airhop's API cannot express, keyed `kind/name`.
const SKIPPED = new Set([
  // Airhop never writes TLV 0x04: the list hands any listener the adjacency graph.
  "announce_tlv/announce_1_bob",
  "announce_tlv/announce_6_erin",
  // Airhop cuts a nickname to its 32-byte budget, where bitchat allows 255.
  "announce_tlv/announce_3_xxxxx",
  // The same budget truncates a 256-byte nickname instead of refusing it.
  "announce_tlv/announce_4_xxxxx",
  // Airhop folds an empty capability set into an absent TLV, as old clients send.
  "announce_tlv/announce_5_dave",
  // Capability bits are a JS number, written from the low 32 bits.
  "announce_tlv/announce_9_héllo",
  "capabilities/caps_encode_ffffffffffffffff",
  // Read back from the low 48 bits, to stay clear of float loss.
  "capabilities/caps_decode_ffffffffffffffffff",
  // The encoder declares the content length, so a different file_size is not expressible.
  "file_packet_tlv/file_packet_4_big.bin",
  "file_packet_tlv/file_packet_5_mismatch.bin",
  // Airhop refuses to encode empty content, which bitchat-ios refuses to decode.
  "file_packet_tlv/file_packet_3_empty.bin",
  // A Noise key under 32 bytes is refused: a peer ID is the hash of a 32-byte
  // Curve25519 key, so a shorter one can name nobody.
  "announce_decode/announce_noise_key_16_bytes_accepted",
]);

// Where Airhop's output differs from bitchat-ios's, keyed `kind/name`. Both
// are inputs Airhop never builds: it sends v2 frames and its own 32-byte key.
const DIVERGES = new Set([
  // A v1 payload past 0xffff wraps the u16 length instead of refusing to encode.
  "packet_encode/v1_zeros_65536_too_large",
  // A 31-byte signing key is zero-filled to 32 instead of refused.
  "peer_state_tlv/peer_state_encode_bad_key_len",
]);

function bytes(s: Hex): Uint8Array {
  const run = /^repeat:([0-9a-f]{2})\*(\d+)$/.exec(s);
  if (run) return new Uint8Array(Number(run[2])).fill(parseInt(run[1], 16));
  return hexToBytes(s);
}

// Compares as hex so a failure prints the bytes, and expands `repeat:` first.
const hex = (b: Uint8Array | null | undefined): Hex | null =>
  b == null ? null : bytesToHex(b);
const expand = (s: Hex | null | undefined): Hex | null =>
  s == null ? null : bytesToHex(bytes(s));

// Runs every case of `kind` through `body`, honouring SKIPPED and DIVERGES.
function replay<I, E>(
  kind: string,
  body: (input: I, expected: E, name: string) => void,
  cases = ALL.filter((c) => c.kind === kind) as VectorCase<I, E>[],
): void {
  const key = (c: VectorCase<I, E>): string => `${kind}/${c.name}`;
  const plain = cases.filter(
    (c) => !SKIPPED.has(key(c)) && !DIVERGES.has(key(c)),
  );
  const failing = cases.filter((c) => DIVERGES.has(key(c)));
  const skipped = cases.filter((c) => SKIPPED.has(key(c)));
  const run = ({ input, expected, name }: VectorCase<I, E>): void =>
    body(input, expected, name);
  // Jest refuses an empty table, so each runs only when it has a row.
  if (plain.length > 0) test.each(plain)("$name", run);
  if (failing.length > 0) test.failing.each(failing)("$name", run);
  if (skipped.length > 0) test.skip.each(skipped)("$name", run);
}

describe("the vector file", () => {
  // A kind this suite does not know would otherwise pass by running nothing.
  test("every kind it holds is replayed below", () => {
    expect(ALL).toHaveLength(181);
    expect([...new Set(ALL.map((c) => c.kind))].sort()).toEqual(
      [
        "announce_decode",
        "announce_tlv",
        "capabilities",
        "compress",
        "file_packet_tlv",
        "fragment_payload",
        "noise_payload",
        "optimal_block_size",
        "packet_decode_accept",
        "packet_decode_reject",
        "packet_encode",
        "padding",
        "peer_id",
        "peer_state_tlv",
        "private_message_tlv",
        "should_compress",
        "unpad",
      ].sort(),
    );
  });

  test("every SKIPPED and DIVERGES entry names a real case", () => {
    const names = new Set(ALL.map((c) => `${c.kind}/${c.name}`));
    for (const k of [...SKIPPED, ...DIVERGES]) expect(names).toContain(k);
  });
});

describe("padding", () => {
  replay<{ data: Hex; target: number }, { padded: Hex }>(
    "padding",
    ({ data, target }, { padded }) => {
      expect(hex(pad(bytes(data), target))).toBe(expand(padded));
    },
  );
});

describe("optimal_block_size", () => {
  replay<{ size: number }, { block: number }>(
    "optimal_block_size",
    ({ size }, { block }) => {
      expect(optimalBlockSize(size)).toBe(block);
    },
  );
});

describe("unpad", () => {
  replay<{ data: Hex }, { unpadded: Hex }>(
    "unpad",
    ({ data }, { unpadded }) => {
      expect(hex(unpad(bytes(data)))).toBe(expand(unpadded));
    },
  );
});

describe("should_compress", () => {
  replay<{ payload: Hex }, { result: boolean }>(
    "should_compress",
    ({ payload }, { result }) => {
      expect(shouldCompress(bytes(payload))).toBe(result);
    },
  );
});

describe("compress", () => {
  // DEFLATE output is not canonical, so the interop contract is that each side
  // inflates the other's stream and agrees on whether to compress at all. The
  // relay path never recompresses (WirePayload), so exact bytes are not needed.
  replay<{ payload: Hex }, { compressed: Hex | null }>(
    "compress",
    ({ payload }, { compressed }) => {
      const data = bytes(payload);
      const ours = compress(data);
      if (compressed === null) {
        expect(ours).toBeNull();
        return;
      }
      expect(hex(decompress(bytes(compressed), data.length))).toBe(hex(data));
      expect(ours).not.toBeNull();
      expect(hex(decompress(ours!, data.length))).toBe(hex(data));
    },
  );
});

interface PacketInput {
  version: number;
  type: number;
  ttl: number;
  timestamp: number;
  sender_id: Hex;
  recipient_id: Hex | null;
  route: Hex[] | null;
  payload: Hex;
  signature: Hex | null;
  is_rsr?: boolean;
}

function packetOf(i: PacketInput): Packet {
  return {
    version: i.version,
    type: i.type,
    ttl: i.ttl,
    timestamp: i.timestamp,
    flags: i.signature === null ? 0 : Flags.SIGNED,
    senderID: bytes(i.sender_id),
    recipientID:
      i.recipient_id === null ? new Uint8Array(8) : bytes(i.recipient_id),
    route: i.route?.map(bytes),
    payload: bytes(i.payload),
    signature: i.signature === null ? new Uint8Array(64) : bytes(i.signature),
    isRSR: i.is_rsr,
  };
}

// The signing preimage is private to the codec, so it is checked through
// verifyPacket: a signature over bitchat's preimage verifies only if Airhop
// rebuilds the same bytes.
const SIGNER = new Uint8Array(32).fill(0x5a);
function verifiesOver(p: Packet, preimage: Hex): boolean {
  const signature = ed25519.sign(bytes(preimage), SIGNER);
  return verifyPacket(
    { ...p, flags: p.flags | Flags.SIGNED, signature },
    ed25519.getPublicKey(SIGNER),
  );
}

describe("packet_encode", () => {
  interface Expected {
    padded: Hex | null;
    unpadded: Hex | null;
    signing_preimage?: Hex;
    decoded_flags?: number;
    decoded_payload?: Hex;
    decoded_ttl?: number;
    decoded_is_rsr?: boolean;
    decoded_sender_id?: Hex;
    decoded_recipient_id?: Hex | null;
    decoded_signature?: Hex | null;
    decoded_route?: Hex[] | null;
  }

  // bitchat-ios's DEFLATE matches zlib level 5 here and pako runs level 6, as
  // bitchat-android does, so a fresh encode carries a different stream.
  const deflateDiffers = new Set(["v1_a_b33_300_signed"]);

  replay<PacketInput, Expected>("packet_encode", (input, e, name) => {
    const p = packetOf(input);
    const ours = encodePacket(p, false);
    if (deflateDiffers.has(name)) {
      expect(hex(decodePacket(ours)?.payload)).toBe(hex(p.payload));
    } else {
      expect(hex(encodePacket(p, true))).toBe(expand(e.padded));
      expect(hex(ours)).toBe(expand(e.unpadded));
    }
    if (e.padded === null || e.unpadded === null) return;

    expect(ours[11]).toBe(e.decoded_flags);
    if (!deflateDiffers.has(name)) {
      expect(verifiesOver(p, e.signing_preimage!)).toBe(true);
    }

    // Decoding bitchat's own frame, which is what a receiver and a relay see.
    const d = decodePacket(bytes(e.padded))!;
    expect(d).not.toBeNull();
    expect(hex(d.payload)).toBe(expand(e.decoded_payload));
    expect(d.ttl).toBe(e.decoded_ttl);
    expect(d.isRSR === true).toBe(e.decoded_is_rsr);
    expect(hex(d.senderID)).toBe(e.decoded_sender_id);
    // Airhop decodes an absent recipient to BROADCAST_ID, and no signature to zeros.
    expect(hex(d.recipientID)).toBe(
      e.decoded_recipient_id ?? hex(BROADCAST_ID),
    );
    expect(hex(d.signature)).toBe(
      e.decoded_signature ?? hex(new Uint8Array(64)),
    );
    expect(d.route?.map(bytesToHex) ?? null).toEqual(e.decoded_route);
    // A relay re-signs nothing, so the decoded frame must rebuild the preimage too.
    expect(verifiesOver(d, e.signing_preimage!)).toBe(true);
    expect(hex(decodePacket(bytes(e.unpadded))?.payload)).toBe(hex(p.payload));
  });
});

describe("packet_decode_reject", () => {
  replay<{ bytes: Hex }, { decodes: false }>(
    "packet_decode_reject",
    (input) => {
      expect(decodePacket(bytes(input.bytes))).toBeNull();
    },
  );
});

describe("packet_decode_accept", () => {
  replay<
    { bytes: Hex },
    { payload: Hex; route?: Hex[] | null; flags?: number }
  >("packet_decode_accept", (input, e) => {
    const raw = bytes(input.bytes);
    const d = decodePacket(raw);
    expect(d).not.toBeNull();
    expect(hex(d!.payload)).toBe(e.payload);
    if (e.route !== undefined) {
      expect(d!.route?.map(bytesToHex) ?? null).toEqual(e.route);
    }
    if (e.flags !== undefined) expect(raw[11]).toBe(e.flags);
  });
});

describe("peer_id", () => {
  replay<{ noise_public_key: Hex }, { peer_id: string }>(
    "peer_id",
    ({ noise_public_key }, { peer_id }) => {
      expect(peerIDFromNoiseKey(bytes(noise_public_key))).toBe(peer_id);
    },
  );
});

describe("capabilities", () => {
  replay<
    { raw?: number; encoded?: Hex },
    { encoded?: Hex; raw?: number; reencoded?: Hex }
  >("capabilities", (input, e) => {
    if (input.raw !== undefined) {
      expect(hex(encodeCapabilities(input.raw))).toBe(e.encoded);
      return;
    }
    const raw = decodeCapabilities(bytes(input.encoded!));
    expect(raw).toBe(e.raw);
    expect(hex(encodeCapabilities(raw))).toBe(e.reencoded);
  });
});

interface AnnounceFields {
  nickname: string;
  noise_public_key: Hex;
  signing_public_key: Hex;
  capabilities: number | null;
  bridge_geohash: string | null;
}

// JSON parses bitchat's 2^64-1 to 2^64, and Airhop keeps only the low 48 bits.
const capsAsAirhopReads = (caps: number | null): number =>
  caps === null ? 0 : caps > Number.MAX_SAFE_INTEGER ? 2 ** 48 - 1 : caps;

// TLV 0x04 neighbours are not compared: Airhop skips them on decode.
function expectAnnounce(payload: Hex, e: AnnounceFields): void {
  const a = decodeAnnouncePayload(bytes(payload), new Uint8Array(8));
  expect(a).not.toBeNull();
  expect(a!.nickname).toBe(e.nickname);
  expect(hex(a!.noisePubKey)).toBe(e.noise_public_key);
  expect(hex(a!.signingPubKey)).toBe(e.signing_public_key);
  expect(a!.capabilities).toBe(capsAsAirhopReads(e.capabilities));
  expect(a!.bridgeGeohash ?? null).toBe(e.bridge_geohash);
}

describe("announce_tlv", () => {
  type Expected = { encoded: Hex | null; roundtrip?: AnnounceFields };
  const cases = ALL.filter((c) => c.kind === "announce_tlv") as VectorCase<
    AnnounceFields,
    Expected
  >[];

  describe("encodes", () => {
    replay<AnnounceFields, Expected>("announce_tlv", (i, { encoded }) => {
      const identity: Identity = {
        noiseStaticPrivKey: new Uint8Array(32),
        noiseStaticPubKey: bytes(i.noise_public_key),
        signingPrivKey: new Uint8Array(32),
        signingPubKey: bytes(i.signing_public_key),
        peerID: "",
      };
      const ours = encodeAnnouncePayload(
        identity,
        i.nickname,
        undefined,
        i.capabilities ?? 0,
        i.bridge_geohash ?? undefined,
      );
      expect(hex(ours)).toBe(expand(encoded));
    });
  });

  // Airhop reading bitchat-ios's encoding, which holds even where Airhop
  // cannot produce the same bytes itself.
  describe("decodes bitchat-ios's encoding", () => {
    test.each(cases.filter((c) => c.expected.roundtrip !== undefined))(
      "$name",
      ({ expected }) => {
        expectAnnounce(expected.encoded!, expected.roundtrip!);
      },
    );
  });
});

describe("announce_decode", () => {
  replay<{ bytes: Hex }, { decodes: boolean } & AnnounceFields>(
    "announce_decode",
    (input, e) => {
      if (e.decodes) {
        expectAnnounce(input.bytes, e);
      } else {
        expect(
          decodeAnnouncePayload(bytes(input.bytes), new Uint8Array(8)),
        ).toBeNull();
      }
    },
  );
});

describe("peer_state_tlv", () => {
  replay<
    { bytes?: Hex; capabilities?: number; signing_public_key?: Hex },
    {
      encoded?: Hex | null;
      decodes?: boolean;
      capabilities?: number;
      signing_public_key?: Hex;
    }
  >("peer_state_tlv", (input, e) => {
    if (input.bytes === undefined) {
      const ours = encodePeerStatePacket({
        capabilities: input.capabilities!,
        signingPubKey: bytes(input.signing_public_key!),
      });
      expect(hex(ours)).toBe(expand(e.encoded));
      return;
    }
    const d = decodePeerStatePacket(bytes(input.bytes));
    if (!e.decodes) {
      expect(d).toBeNull();
      return;
    }
    expect(d?.capabilities).toBe(e.capabilities);
    expect(hex(d?.signingPubKey)).toBe(e.signing_public_key);
  });
});

describe("private_message_tlv", () => {
  type Message = { message_id: string; content: string };
  replay<
    Partial<Message> & { bytes?: Hex },
    Partial<Message> & {
      encoded?: Hex | null;
      roundtrip?: Message;
      decodes?: boolean;
    }
  >("private_message_tlv", (input, e) => {
    if (input.bytes === undefined) {
      const ours = encodePrivateMessagePacket(
        input.message_id!,
        input.content!,
      );
      expect(hex(ours)).toBe(expand(e.encoded));
      if (e.roundtrip === undefined) return;
      expect(decodePrivateMessagePacket(ours!)).toEqual({
        messageID: e.roundtrip.message_id,
        content: e.roundtrip.content,
      });
      return;
    }
    const d = decodePrivateMessagePacket(bytes(input.bytes));
    expect(d).toEqual(
      e.decodes ? { messageID: e.message_id, content: e.content } : null,
    );
  });
});

describe("noise_payload", () => {
  const known = new Set<number>(Object.values(NoisePayloadType));

  // decodeNoisePayload only splits off the type byte. Refusing an unknown type
  // and folding 0x09 into 0x20 happen at dispatch, so a rejected case is checked
  // as a type no handler exists for.
  replay<
    { bytes?: Hex; type?: number; data?: Hex },
    { encoded?: Hex; decodes?: boolean; type?: number; data?: Hex }
  >("noise_payload", (input, e) => {
    if (input.bytes === undefined) {
      expect(hex(encodeNoisePayload(input.type!, bytes(input.data!)))).toBe(
        e.encoded,
      );
      return;
    }
    const d = decodeNoisePayload(bytes(input.bytes));
    if (!e.decodes) {
      if (d !== null) expect(known.has(d.type)).toBe(false);
      return;
    }
    const type =
      d!.type === NoisePayloadType.PRIVATE_FILE_LEGACY_ALIAS
        ? NoisePayloadType.PRIVATE_FILE
        : d!.type;
    expect(type).toBe(e.type);
    expect(hex(d!.body)).toBe(e.data);
  });
});

interface FileFields {
  file_name: string | null;
  mime_type: string | null;
  content: Hex;
  file_size: number | null;
}

// file_size is not compared: Airhop trusts the content bytes, not the declared size.
function expectFile(payload: Hex, e: FileFields | null): void {
  const f = decodeFilePacket(bytes(payload));
  if (e === null) {
    expect(f).toBeNull();
    return;
  }
  expect(f).not.toBeNull();
  expect(f!.fileName ?? null).toBe(e.file_name);
  expect(f!.mimeType ?? null).toBe(e.mime_type);
  expect(hex(f!.content)).toBe(expand(e.content));
}

describe("file_packet_tlv", () => {
  type Expected = FileFields & {
    encoded?: Hex | null;
    roundtrip?: FileFields | null;
    decodes?: boolean;
  };
  const cases = ALL.filter((c) => c.kind === "file_packet_tlv") as VectorCase<
    Partial<FileFields> & { bytes?: Hex },
    Expected
  >[];

  describe("encodes", () => {
    replay(
      "file_packet_tlv",
      (input, e: Expected) => {
        const ours = encodeFilePacket({
          fileName: input.file_name ?? undefined,
          mimeType: input.mime_type ?? undefined,
          content: bytes(input.content!),
        });
        expect(hex(ours)).toBe(expand(e.encoded));
      },
      cases.filter((c) => c.input.bytes === undefined),
    );
  });

  describe("decodes bitchat-ios's encoding", () => {
    test.each(cases.filter((c) => c.expected.roundtrip !== undefined))(
      "$name",
      ({ expected }) => {
        expectFile(expected.encoded!, expected.roundtrip!);
      },
    );
  });

  describe("decodes", () => {
    replay(
      "file_packet_tlv",
      (input, e: Expected) => {
        expectFile(input.bytes!, e.decodes ? e : null);
      },
      cases.filter((c) => c.input.bytes !== undefined),
    );
  });
});

describe("fragment_payload", () => {
  type Fragment = Omit<PacketInput, "sender_id" | "payload" | "signature"> & {
    payload: Hex;
    encoded_unpadded: Hex;
    encoded_padded: Hex;
  };

  // Chunk size, fragment count and the fragment ID are a sender's choice the
  // receiver never has to agree with, and Airhop's planner picks its own. What
  // is pinned is the inner frame, each fragment frame, and reassembly.
  replay<
    { packet: Omit<PacketInput, "signature">; pad: boolean },
    { full_data: Hex; fragments: Fragment[] }
  >("fragment_payload", ({ packet, pad: padded }, e) => {
    const inner = packetOf({ ...packet, signature: null });
    expect(hex(encodePacket(inner, padded))).toBe(e.full_data);

    const frames = e.fragments.map((f) => {
      const p = packetOf({
        ...f,
        sender_id: packet.sender_id,
        signature: null,
      });
      expect(hex(encodePacket(p, false))).toBe(f.encoded_unpadded);
      expect(hex(encodePacket(p, true))).toBe(f.encoded_padded);
      return decodePacket(bytes(f.encoded_padded))!;
    });

    const done: Packet[] = [];
    const manager = new FragmentManager();
    for (const frame of frames) {
      manager.receive(frame.senderID, frame.payload, (p) => done.push(p));
    }
    expect(done).toHaveLength(1);
    expect(hex(done[0].payload)).toBe(hex(inner.payload));
  });
});
