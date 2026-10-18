// NIP-13 mining and scoring, checked against the ID nostr-tools computes, which
// is the one every receiver computes.

import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
} from "nostr-tools";
import {
  leadingZeroBits,
  mineNonceTag,
  POW_TARGET_BITS,
  validatedDifficulty,
} from "../nostr-pow";

function signedWithPow(content: string, tags: string[][]) {
  const priv = generateSecretKey();
  const fields = {
    pubkey: getPublicKey(priv),
    created_at: 1_700_000_000,
    kind: 20000,
    tags,
    content,
  };
  const nonce = mineNonceTag(fields);
  expect(nonce).not.toBeNull();
  return finalizeEvent(
    {
      kind: fields.kind,
      created_at: fields.created_at,
      tags: [...tags, nonce!],
      content,
    },
    priv,
  );
}

describe("leadingZeroBits", () => {
  it("counts whole zero bytes and the first set bit", () => {
    expect(leadingZeroBits(new Uint8Array([0, 0, 0x10, 0xff]))).toBe(19);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0, 0]))).toBe(16);
  });
});

describe("mineNonceTag", () => {
  it("meets the target under the ID nostr-tools signs", () => {
    const event = signedWithPow("hello cell", [
      ["g", "u4pru"],
      ["n", "swift-falcon"],
    ]);
    expect(validatedDifficulty(event.id, event.tags)).toBe(POW_TARGET_BITS);
  });

  it("holds for content and tags that JSON has to escape", () => {
    const event = signedWithPow('quote " slash \\ newline \n emoji \u{1F985}', [
      ["g", "u4pru"],
      ["n", 'a "name"'],
    ]);
    expect(validatedDifficulty(event.id, event.tags)).toBe(POW_TARGET_BITS);
  });

  it("holds with no other tags", () => {
    const event = signedWithPow("bare", []);
    expect(validatedDifficulty(event.id, event.tags)).toBe(POW_TARGET_BITS);
  });

  it("steps down to an honest lower target rather than hold a send", () => {
    let t = 0;
    const clock = (): number => (t += 1000);
    const fields = {
      pubkey: "00".repeat(32),
      created_at: 1,
      kind: 20000,
      tags: [],
      content: "x",
    };
    const tag = mineNonceTag(fields, 256, clock);
    expect(tag === null || Number(tag[2]) < 32).toBe(true);
  });
});

describe("validatedDifficulty", () => {
  const zeroId = "00" + "f".repeat(62);

  it("scores the commitment, not the luck", () => {
    expect(validatedDifficulty(zeroId, [["nonce", "1", "4"]])).toBe(4);
  });

  it("voids a commitment the ID does not meet", () => {
    expect(validatedDifficulty(zeroId, [["nonce", "1", "9"]])).toBe(0);
  });

  it("scores nothing without a well-formed commitment", () => {
    expect(validatedDifficulty(zeroId, [])).toBe(0);
    expect(validatedDifficulty(zeroId, [["nonce", "1"]])).toBe(0);
    expect(validatedDifficulty(zeroId, [["nonce", "1", "0"]])).toBe(0);
    expect(validatedDifficulty(zeroId, [["nonce", "1", "x"]])).toBe(0);
    expect(validatedDifficulty("zz", [["nonce", "1", "4"]])).toBe(0);
  });
});
