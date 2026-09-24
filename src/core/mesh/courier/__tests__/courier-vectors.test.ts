/**
 * @jest-environment node
 */
// The courier wire format, checked against two published vector files.
//
// `courier-test-vectors.json` is ours, so another implementation can be written
// without reading this code. `courier-test-vectors-bitchat.json` is bitchat's,
// kept as published. Every value is read from the files, so neither can drift
// from the code while this suite passes.
//
// Three mistakes fail silently, each pinned below: expiry in seconds rather
// than milliseconds, a copies TLV written at 1 rather than omitted, and a
// recipient tag not rotated daily off the recipient's public key.
//
// Signature bytes are not pinned: Ed25519 signing is randomized in some
// implementations, and both forms verify. The signed pre-image is what must
// match.

import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import upstream from "../../../../../docs/spec/courier-test-vectors-bitchat.json";
import vectors from "../../../../../docs/spec/courier-test-vectors.json";
import {
  decodePacket,
  encodePacket,
  Flags,
  PacketType,
  signPacket,
  verifyPacket,
  type Packet,
} from "../../wire/packet-codec";
import {
  computeRecipientTag,
  decodeEnvelopePayload,
  encodeEnvelopePayload,
  ENVELOPE_TTL_MS,
} from "../courier-store";

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("the published vector file", () => {
  // A rename or a bad merge that empties a section must fail loudly rather than
  // skipping every assertion below it and reporting green.
  it("has the sections the tests below read", () => {
    expect(vectors.recipientTag.cases.length).toBeGreaterThan(0);
    expect(vectors.envelopeTLV.cases.length).toBeGreaterThan(0);
    expect(vectors.recipientTag.label).toBe("bitchat-courier-tag-v1");
  });
});

describe("recipient tag", () => {
  const key = hexToBytes(vectors.recipientTag.recipientNoisePublicKeyHex);

  it.each(vectors.recipientTag.cases)(
    "matches the published tag at epoch day $epochDay",
    ({ nowMillis, tagHex }) => {
      expect(hex(computeRecipientTag(key, nowMillis))).toBe(tagHex);
    },
  );

  it("rotates daily, so mail cannot be followed by tag across days", () => {
    // The rotation is the only unlinkability the scheme has, and it is weak
    // (the HMAC key is public). Losing it entirely would be worse.
    const [day0, day20000] = vectors.recipientTag.cases;
    expect(day0.tagHex).not.toBe(day20000.tagHex);
  });

  it("is 16 bytes, the length the TLV declares", () => {
    for (const c of vectors.recipientTag.cases) {
      expect(hexToBytes(c.tagHex)).toHaveLength(16);
    }
  });
});

describe("envelope TLV", () => {
  const { recipientTagHex, expiryMillis, ciphertextHex } = vectors.envelopeTLV;

  const build = (copies: number): Uint8Array =>
    encodeEnvelopePayload({
      recipientTag: hexToBytes(recipientTagHex),
      expiryMs: expiryMillis,
      copies,
      ciphertext: hexToBytes(ciphertextHex),
    });

  it.each(vectors.envelopeTLV.cases)(
    "encodes byte-for-byte as published at copies=$copies",
    ({ copies, encodedHex }) => {
      expect(hex(build(copies))).toBe(encodedHex);
    },
  );

  it("omits the copies TLV at 1 rather than writing it", () => {
    // The silent-failure case. A decoder that requires 0x04 refuses every
    // carry-only envelope, and the sender never learns.
    const one = hex(build(1));
    const four = hex(build(4));
    expect(four.endsWith("04000104")).toBe(true);
    expect(one.includes("04000104")).toBe(false);
    expect(four.startsWith(one)).toBe(true);
  });

  it("writes expiry as eight bytes of milliseconds, big-endian", () => {
    // Seconds would be ~1000x too small, so every envelope would read as long
    // expired and be dropped at deposit with nothing logged.
    const encoded = hex(build(4));
    const expected = expiryMillis.toString(16).padStart(16, "0");
    expect(encoded).toContain(`020008${expected}`);
    // And the value really is a millisecond timestamp, not a second one: a
    // seconds reading of the same number lands far outside any plausible date.
    expect(new Date(expiryMillis).getUTCFullYear()).toBeGreaterThan(2020);
    expect(new Date(expiryMillis).getUTCFullYear()).toBeLessThan(2100);
  });

  it("uses u16 lengths, so the tag TLV declares 0x0010", () => {
    expect(hex(build(4)).startsWith("010010")).toBe(true);
  });
});

describe("published limits match the implementation", () => {
  it("carries the same envelope lifetime the code enforces", () => {
    // A sender that stamps a longer expiry gets no carriage rather than longer
    // carriage, so publishing the wrong number here would produce envelopes
    // that are refused everywhere.
    expect(vectors.limits.envelopeTtlMillis).toBe(ENVELOPE_TTL_MS);
  });
});

describe("bitchat's published vectors", () => {
  const input = upstream.inputs;
  const envelope = (copies: number, prekeyID?: number): Uint8Array =>
    encodeEnvelopePayload({
      recipientTag: hexToBytes(input.recipientTag),
      expiryMs: input.expiryMillis,
      copies,
      ciphertext: hexToBytes(input.ciphertext),
      ...(prekeyID === undefined ? {} : { prekeyID }),
    });

  it("encodes and decodes the envelope, prekey ID included", () => {
    const { copies, prekeyID, encoded } = upstream.envelopeTLV;
    expect(hex(envelope(copies, prekeyID))).toBe(encoded);
    const decoded = decodeEnvelopePayload(hexToBytes(encoded));
    expect(decoded?.copies).toBe(copies);
    expect(decoded?.prekeyID).toBe(prekeyID);
  });

  it.each(upstream.copiesClamping.cases)(
    "clamps a requested $requested copies to $stored rather than refusing",
    ({ requested, stored }) => {
      expect(decodeEnvelopePayload(envelope(requested))?.copies).toBe(stored);
    },
  );

  it("derives the same recipient tag", () => {
    const { epochDay, expected } = upstream.recipientTagDerivation;
    const tag = computeRecipientTag(
      hexToBytes(input.noiseStaticKey),
      epochDay * 86_400_000,
    );
    expect(hex(tag)).toBe(expected);
  });

  // The pre-image is private to the codec, so it is checked the way the vector
  // file says a second implementation should be: a signature made here must
  // verify against bitchat's published pre-image under bitchat's key.
  it("signs the same pre-image, so a bitchat carrier accepts the deposit", () => {
    const packet: Packet = {
      version: upstream.packetSigning.packet.version,
      type: PacketType.COURIER_ENV,
      ttl: upstream.packetSigning.packet.ttlOnWire,
      flags: Flags.SIGNED,
      senderID: hexToBytes(input.senderID),
      recipientID: hexToBytes(input.recipientID),
      timestamp: input.timestampMillis,
      signature: new Uint8Array(64),
      payload: hexToBytes(upstream.envelopeTLV.encoded),
    };
    const seed = hexToBytes(input.signingSeed);
    const publicKey = ed25519.getPublicKey(seed);
    expect(hex(publicKey)).toBe(upstream.signature.publicKey);

    packet.signature = signPacket(packet, seed);
    expect(
      ed25519.verify(
        packet.signature,
        hexToBytes(upstream.packetSigning.signingPreimage),
        publicKey,
      ),
    ).toBe(true);

    const wire = encodePacket(packet);
    expect(wire).toHaveLength(upstream.packetSigning.signedWireLength);
    const received = decodePacket(wire);
    expect(received).not.toBeNull();
    expect(verifyPacket(received!, publicKey)).toBe(true);
  });

  it("frames the unsigned packet as published", () => {
    const unsigned = encodePacket(
      {
        version: upstream.packetSigning.packet.version,
        type: PacketType.COURIER_ENV,
        ttl: upstream.packetSigning.packet.ttlOnWire,
        flags: 0,
        senderID: hexToBytes(input.senderID),
        recipientID: hexToBytes(input.recipientID),
        timestamp: input.timestampMillis,
        signature: new Uint8Array(0),
        payload: hexToBytes(upstream.envelopeTLV.encoded),
      },
      false,
    );
    expect(hex(unsigned)).toBe(upstream.packetSigning.unsignedUnpadded);
  });
});
