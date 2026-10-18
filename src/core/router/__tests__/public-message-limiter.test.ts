// The public-room flood limit, at bitchat-ios's numbers.

import {
  PublicMessageLimiter,
  publicContentKey,
} from "../public-message-limiter";

describe("PublicMessageLimiter", () => {
  it("lets a sender burst five, then one a second", () => {
    const limiter = new PublicMessageLimiter();
    const sent = Array.from({ length: 6 }, (_, i) =>
      limiter.allow("mesh:a", `msg ${i}`, 0, 0),
    );
    expect(sent).toEqual([true, true, true, true, true, false]);
    expect(limiter.allow("mesh:a", "later", 0, 1000)).toBe(true);
  });

  it("caps the same text across senders", () => {
    const limiter = new PublicMessageLimiter();
    const sent = ["a", "b", "c", "d"].map((s) =>
      limiter.allow(`nostr:${s}`, "buy now", 0, 0),
    );
    expect(sent).toEqual([true, true, true, false]);
    expect(limiter.allow("nostr:e", "buy now", 0, 2000)).toBe(true);
  });

  it("lets proof of work skip the sender bucket but not the text one", () => {
    const limiter = new PublicMessageLimiter();
    for (let i = 0; i < 10; i++) {
      expect(limiter.allow("nostr:a", `msg ${i}`, 8, 0)).toBe(true);
    }
    expect(limiter.allow("nostr:a", "same", 8, 0)).toBe(true);
    expect(limiter.allow("nostr:a", "same", 8, 0)).toBe(true);
    expect(limiter.allow("nostr:a", "same", 8, 0)).toBe(true);
    expect(limiter.allow("nostr:a", "same", 8, 0)).toBe(false);
  });

  it("does not spend the text bucket on a refused sender", () => {
    const limiter = new PublicMessageLimiter();
    for (let i = 0; i < 5; i++) limiter.allow("mesh:spam", `x${i}`, 0, 0);
    for (let i = 0; i < 10; i++) limiter.allow("mesh:spam", "hello", 0, 0);
    expect(limiter.allow("mesh:b", "hello", 0, 0)).toBe(true);
  });

  it("stays bounded under a flood of fresh keys", () => {
    const limiter = new PublicMessageLimiter();
    for (let i = 0; i < 5; i++) limiter.allow("nostr:victim", `m${i}`, 0, 0);
    expect(limiter.allow("nostr:victim", "m5", 0, 0)).toBe(false);
    // All at one instant, so no bucket refills: only eviction can free it.
    for (let i = 0; i < 2000; i++) limiter.allow(`nostr:${i}`, `t${i}`, 0, 0);
    // The oldest sender was evicted and starts with a full bucket again,
    // rather than the table growing without limit.
    expect(limiter.allow("nostr:victim", "again", 0, 0)).toBe(true);
  });
});

describe("publicContentKey", () => {
  it("ignores case, spacing and link tracking", () => {
    expect(publicContentKey("  Join  NOW\nhttps://x.io/a?ref=1#top ")).toBe(
      publicContentKey("join now https://x.io/a"),
    );
  });

  it("keeps different words different", () => {
    expect(publicContentKey("hello")).not.toBe(publicContentKey("hellO there"));
  });
});
