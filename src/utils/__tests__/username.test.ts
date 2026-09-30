/**
 * @jest-environment node
 */
// The name shown for a peer who has never told us one.
//
// Derived from the peer ID rather than stored, so every device shows the same
// person the same name with nothing to sync. It must be total (any id yields a
// name), stable (never changes for the same id), and never expose the raw id.
import { isNostrId, nostrShortLabel, peerIDToUsername } from "../username";

describe("peerIDToUsername", () => {
  test("produces adjective-noun-suffix format", () => {
    const name = peerIDToUsername("3a9f2c1b4e5d6f70");
    expect(name).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  });

  test("suffix is always the first 4 hex chars of peerID", () => {
    const peerID = "3a9f2c1b4e5d6f70";
    const name = peerIDToUsername(peerID);
    expect(name.endsWith(`-${peerID.slice(0, 4)}`)).toBe(true);
  });

  test("deterministic: same peerID always produces same name", () => {
    const peerID = "aabbccddeeff0011";
    const a = peerIDToUsername(peerID);
    const b = peerIDToUsername(peerID);
    expect(a).toBe(b);
  });

  test("known vector: 3a9f picks ADJECTIVES[0x3a % 128] and NOUNS[0x9f % 128]", () => {
    // 0x3a = 58 and 0x9f % 128 = 31: ADJECTIVES[58] is "lunar", NOUNS[31] is
    // "drift". Pins the byte-to-word mapping, not just the shape.
    expect(peerIDToUsername("3a9f000000000000")).toBe("lunar-drift-3a9f");
  });

  test("all-zeros peerID produces a valid name", () => {
    const name = peerIDToUsername("0000000000000000");
    expect(name).toMatch(/^[a-z]+-[a-z]+-0000$/);
  });

  test("all-ff peerID produces a valid name", () => {
    const name = peerIDToUsername("ffffffffffffffff");
    expect(name).toMatch(/^[a-z]+-[a-z]+-ffff$/);
  });

  test("throws on short peerID", () => {
    expect(() => peerIDToUsername("ab")).toThrow("at least 4");
  });

  // A Nostr id fed into the byte math would index the word lists with NaN and
  // render "undefined-undefined-nost", so this low-level fallback resolves it to
  // the peer's npub-style label instead. (Display surfaces name a
  // geohash pseudonym as `anon#<last4>` via resolveDisplayName; peerIDToUsername
  // is only the never-undefined safety net.)
  test("Nostr id resolves to an npub-style label, never 'undefined'", () => {
    const nostrID =
      "nostr_53624313fcb11263cdb2562c440e0f5f0356a653ae9d449d09bc8c349c5ea763";
    const name = peerIDToUsername(nostrID);
    expect(name).toBe("npub…5ea763");
    expect(name).not.toContain("undefined");
    expect(isNostrId(nostrID)).toBe(true);
    expect(nostrShortLabel(nostrID)).toBe("npub…5ea763");
  });

  test("non-hex id falls back to a stable label rather than 'undefined'", () => {
    const name = peerIDToUsername("zzzzzz");
    expect(name).not.toContain("undefined");
    expect(name).toBe("peer-zzzzzz");
  });
});
