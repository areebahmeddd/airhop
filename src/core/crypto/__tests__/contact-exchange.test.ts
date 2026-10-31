// The binary contact card and the signed airhop:v1/ QR that carries it.
import { base64UrlToBytes, bytesToBase64Url } from "@core/encoding/base64";
import { ed25519 } from "@noble/curves/ed25519.js";
import { concatBytes } from "@noble/hashes/utils.js";
import {
  decodeContactCard,
  decodeQRContent,
  encodeContactCard,
  encodeQRContent,
  isContactQR,
  type AirhopContactCard,
} from "../contact-exchange";

const signingPriv = new Uint8Array(32).fill(0x11);
const signingPub = ed25519.getPublicKey(signingPriv);

// Typed as the narrower card these functions actually round-trip: our own
// format always carries a Nostr key, so the fixtures do too.
function makeCard(
  overrides: Partial<AirhopContactCard> = {},
): AirhopContactCard {
  return {
    peerID: "3a9f2c1b4e5d6f70",
    noisePubKey: new Uint8Array(32).fill(0xaa),
    signingPubKey: new Uint8Array(32).fill(0xbb),
    nickname: "swift",
    nostrPubKey: new Uint8Array(32).fill(0xcc),
    ...overrides,
  };
}

describe("ContactCard binary encode/decode", () => {
  test("round-trip: all fields survive encode -> decode", () => {
    const card = makeCard();
    const encoded = encodeContactCard(card);
    const decoded = decodeContactCard(encoded);

    expect(decoded.peerID).toBe(card.peerID);
    expect(Array.from(decoded.noisePubKey)).toEqual(
      Array.from(card.noisePubKey),
    );
    expect(Array.from(decoded.signingPubKey)).toEqual(
      Array.from(card.signingPubKey),
    );
    expect(decoded.nickname).toBe(card.nickname);
    expect(Array.from(decoded.nostrPubKey)).toEqual(
      Array.from(card.nostrPubKey),
    );
  });

  // The card's name is the peer's choice, and it is saved as the contact's
  // own name, so it enters in the same canonical form an announced one does.
  test("the nickname is normalised where it enters", () => {
    const card = makeCard({ nickname: " M\u202Eo\u200Bm\n(verified)" });
    const decoded = decodeContactCard(encodeContactCard(card));
    expect(decoded.nickname).toBe("Mom (verified)");
  });

  test("empty nickname encodes and decodes correctly", () => {
    const card = makeCard({ nickname: "" });
    const decoded = decodeContactCard(encodeContactCard(card));
    expect(decoded.nickname).toBe("");
  });

  test("nickname longer than 32 bytes is silently truncated", () => {
    const card = makeCard({ nickname: "a".repeat(60) });
    const decoded = decodeContactCard(encodeContactCard(card));
    expect(decoded.nickname).toBe("a".repeat(32));
  });

  test("multi-byte UTF-8 nickname round-trips", () => {
    const card = makeCard({ nickname: "日本語" });
    const decoded = decodeContactCard(encodeContactCard(card));
    expect(decoded.nickname).toBe("日本語");
  });

  test("version byte is 1", () => {
    const buf = encodeContactCard(makeCard());
    expect(buf[0]).toBe(1);
  });

  test("peerID bytes are at offset 1-8", () => {
    const card = makeCard({ peerID: "aabbccddeeff0011" });
    const buf = encodeContactCard(card);
    const extracted = Array.from(buf.slice(1, 9)).map((b) =>
      b.toString(16).padStart(2, "0"),
    );
    expect(extracted.join("")).toBe("aabbccddeeff0011");
  });

  test("throws on truncated buffer", () => {
    expect(() => decodeContactCard(new Uint8Array(30))).toThrow("too short");
  });

  test("throws on wrong version byte", () => {
    const buf = encodeContactCard(makeCard());
    buf[0] = 99;
    expect(() => decodeContactCard(buf)).toThrow("unsupported version");
  });

  test("throws on trailing bytes", () => {
    const buf = encodeContactCard(makeCard());
    expect(() =>
      decodeContactCard(concatBytes(buf, new Uint8Array(1))),
    ).toThrow("trailing");
  });

  test("throws on invalid peerID length", () => {
    expect(() => encodeContactCard({ ...makeCard(), peerID: "short" })).toThrow(
      "16 hex chars",
    );
  });
});

describe("ContactCard Nostr pubkey", () => {
  const npub = new Uint8Array(32).fill(0xdd);

  test("the npub survives even with a max-length nickname (variable offset)", () => {
    const card = makeCard({ nickname: "a".repeat(32), nostrPubKey: npub });
    const decoded = decodeContactCard(encodeContactCard(card));
    expect(decoded.nickname).toBe("a".repeat(32));
    expect(Array.from(decoded.nostrPubKey)).toEqual(Array.from(npub));
  });

  test("throws on a card truncated in the npub field", () => {
    const buf = encodeContactCard(makeCard({ nostrPubKey: npub }));
    expect(() => decodeContactCard(buf.slice(0, buf.length - 4))).toThrow(
      "truncated",
    );
  });

  test("rejects an npub that is not 32 bytes", () => {
    expect(() =>
      encodeContactCard(makeCard({ nostrPubKey: new Uint8Array(16) })),
    ).toThrow("32 bytes");
  });
});

describe("QR content encode/decode", () => {
  // A QR carries a real signature, so its card names a real signing key.
  function signedCard(
    overrides: Partial<AirhopContactCard> = {},
  ): AirhopContactCard {
    return makeCard({ signingPubKey: signingPub, ...overrides });
  }

  // The QR's bytes, edited and put back in the scheme.
  function reencode(qr: string, edit: (bytes: Uint8Array) => Uint8Array) {
    const bytes = base64UrlToBytes(qr.slice("airhop:v1/".length));
    return "airhop:v1/" + bytesToBase64Url(edit(bytes));
  }

  test("QR content starts with airhop:v1/ scheme", () => {
    const qr = encodeQRContent(signedCard(), signingPriv);
    expect(qr.startsWith("airhop:v1/")).toBe(true);
    expect(isContactQR(qr)).toBe(true);
  });

  test("round-trip: QR encode -> decode recovers all fields", () => {
    const card = signedCard({ nickname: "falcon-relay" });
    const qr = encodeQRContent(card, signingPriv);
    const decoded = decodeQRContent(qr);

    expect(decoded).not.toBeNull();
    expect(decoded!.peerID).toBe(card.peerID);
    expect(decoded!.nickname).toBe(card.nickname);
    expect(Array.from(decoded!.noisePubKey)).toEqual(
      Array.from(card.noisePubKey),
    );
    expect(Array.from(decoded!.signingPubKey)).toEqual(
      Array.from(card.signingPubKey),
    );
    expect(Array.from(decoded!.nostrPubKey)).toEqual(
      Array.from(card.nostrPubKey),
    );
  });

  test("refuses to sign with a key other than the card's", () => {
    expect(() =>
      encodeQRContent(signedCard(), new Uint8Array(32).fill(0x22)),
    ).toThrow("signing key");
  });

  // The attack the signature exists for: a real person's card with someone
  // else's Nostr key, which would route their internet DMs elsewhere.
  test("a substituted Nostr key is refused", () => {
    const real = encodeQRContent(signedCard(), signingPriv);
    const forged = reencode(real, (bytes) => {
      // The Nostr key is the card's last 32 bytes, before the signature.
      const out = bytes.slice();
      const cardEnd = bytes.length - 64;
      out.set(new Uint8Array(32).fill(0xee), cardEnd - 32);
      return out;
    });
    expect(decodeQRContent(forged)).toBeNull();
  });

  test("a changed nickname is refused", () => {
    const real = encodeQRContent(
      signedCard({ nickname: "alice" }),
      signingPriv,
    );
    const forged = reencode(real, (bytes) => {
      // Byte 74 is the nickname's first.
      const out = bytes.slice();
      out[74] = "m".charCodeAt(0);
      return out;
    });
    expect(decodeQRContent(forged)).toBeNull();
  });

  test("flipping any byte of the card or signature is refused", () => {
    const real = encodeQRContent(signedCard(), signingPriv);
    const length = base64UrlToBytes(real.slice("airhop:v1/".length)).length;
    for (let i = 0; i < length; i++) {
      const forged = reencode(real, (bytes) => {
        const out = bytes.slice();
        out[i] ^= 0x01;
        return out;
      });
      expect(decodeQRContent(forged)).toBeNull();
    }
  });

  test("an unsigned card is refused", () => {
    const unsigned =
      "airhop:v1/" + bytesToBase64Url(encodeContactCard(signedCard()));
    expect(decodeQRContent(unsigned)).toBeNull();
  });

  test("decodeQRContent returns null for a bare peer ID rather than throwing", () => {
    // The scanner tries card-parsing first and falls back to a plain ID, so
    // this must fail softly.
    expect(decodeQRContent("aabbccdd00112233")).toBeNull();
    expect(isContactQR("aabbccdd00112233")).toBe(false);
  });

  test("decodeQRContent returns null for non-Airhop QR", () => {
    expect(decodeQRContent("https://example.com")).toBeNull();
    expect(decodeQRContent("")).toBeNull();
    expect(decodeQRContent("bitcoin:abc123")).toBeNull();
  });

  test("decodeQRContent returns null for corrupted base64url", () => {
    expect(decodeQRContent("airhop:v1/!!!invalid!!!")).toBeNull();
  });
});
