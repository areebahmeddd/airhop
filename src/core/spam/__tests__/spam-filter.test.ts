// The public spam filter, case for case against bitchat's SpamFilterTests, so
// Airhop hides exactly what both bitchat clients hide.

import { countLinks } from "../link-counter";
import { normalizeForComparison } from "../repetition-detector";
import { SpamFilter, type SpamVerdict } from "../spam-filter";

// Deterministic clock, message IDs and filler words for one test.
function harness() {
  let now = 1_000_000_000;
  let nextID = 0;
  let seed = 7;
  const filter = new SpamFilter(() => now);
  const letter = (): string => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return String.fromCharCode(97 + (seed % 26));
  };
  // Unrelated synthetic words, so only the rule under test can fire.
  const prose = (length = 40): string => {
    let text = "";
    while (text.length < length) {
      if (text.length > 0) text += " ";
      const word = 2 + (letter().charCodeAt(0) % 6);
      for (let i = 0; i < word; i++) text += letter();
    }
    return text.slice(0, length);
  };
  const send = (
    content: string = prose(),
    opts: { sender?: string; at?: number; id?: string } = {},
  ): SpamVerdict =>
    filter.check(
      opts.sender ?? "alice",
      opts.id ?? `m${nextID++}`,
      content,
      opts.at ?? now,
    );
  return {
    filter,
    send,
    prose,
    letter,
    advance: (seconds: number) => (now += seconds * 1000),
    ago: (seconds: number) => now - seconds * 1000,
    now: () => now,
  };
}

describe("rate buckets", () => {
  test("the sixth message in a burst is shown and the seventh hidden", () => {
    const h = harness();
    for (let i = 0; i < 6; i++) expect(h.send()).toBe("allowed");
    expect(h.send()).toBe("message-rate");
  });

  test("the message budget refills one every ten seconds", () => {
    const h = harness();
    for (let i = 0; i < 6; i++) h.send();
    h.advance(9);
    expect(h.send()).toBe("message-rate");
    h.advance(1);
    expect(h.send()).toBe("allowed");
    expect(h.send()).toBe("message-rate");
  });

  test("hidden messages do not drain a flooding sender's budget", () => {
    const h = harness();
    let shown = 0;
    for (let i = 0; i < 120; i++) {
      if (h.send() === "allowed") shown++;
      h.advance(1);
    }
    expect(shown).toBe(6 + 11);
  });

  test("1200 characters a minute pass, and a longer message never does", () => {
    const h = harness();
    expect(h.send(h.prose(600))).toBe("allowed");
    expect(h.send(h.prose(600))).toBe("allowed");
    expect(h.send(h.prose(20))).toBe("character-rate");
    h.advance(2);
    expect(h.send(h.prose(20))).toBe("allowed");
    expect(harness().send(harness().prose(1201))).toBe("character-rate");
  });

  test("characters are counted as code points", () => {
    const h = harness();
    const text = Array.from({ length: 1200 }, (_, i) =>
      i % 3 === 0 ? "😀" : h.letter(),
    ).join("");
    expect(h.send(text)).toBe("allowed");
  });

  test("the third link within a minute is hidden", () => {
    const h = harness();
    expect(h.send("see https://example.org/a for details")).toBe("allowed");
    expect(h.send("mirror at www.example.net too")).toBe("allowed");
    expect(h.send("and example.com/promo as well")).toBe("link-rate");
    expect(h.send("no link in this one at all")).toBe("allowed");
    h.advance(30);
    expect(h.send("ok one more https://example.org/b")).toBe("allowed");
    expect(
      harness().send(
        "https://alpha.example/one and bravo.example plus www.charlie.example/three",
      ),
    ).toBe("link-rate");
  });

  test("links skip email addresses and abbreviations", () => {
    expect(countLinks("mail me at someone@example.com e.g. today")).toBe(0);
    expect(countLinks("pi is 3.14, version v1.2.3")).toBe(0);
    expect(
      countLinks("https://a.example/x, www.b.example and c.example."),
    ).toBe(3);
  });
});

describe("repetition", () => {
  test("the third copy within ten minutes is hidden", () => {
    const h = harness();
    const text = "anyone near the north gate tonight?";
    expect(h.send(text)).toBe("allowed");
    h.advance(60);
    expect(h.send(text)).toBe("allowed");
    h.advance(60);
    expect(h.send(text)).toBe("repeated-message");
  });

  test("near-copies with a changing suffix count as repeats", () => {
    const h = harness();
    expect(h.send("FREE SATS at the link below 101")).toBe("allowed");
    h.advance(20);
    expect(h.send("free sats at the link below 202")).toBe("allowed");
    h.advance(20);
    expect(h.send("free  sats at the link below 303")).toBe("repeated-message");
  });

  test("repeats spread beyond the window, and short replies, are allowed", () => {
    const h = harness();
    const text = "good morning everyone, coffee anyone?";
    h.send(text);
    h.advance(11 * 60);
    h.send(text);
    h.advance(11 * 60);
    expect(h.send(text)).toBe("allowed");
    for (let i = 0; i < 5; i++) {
      expect(h.send("lol yes", { sender: "bob" })).toBe("allowed");
      h.advance(10);
    }
  });

  test("a repeated character or phrase is hidden, prose is not", () => {
    const h = harness();
    expect(h.send("A".repeat(40))).toBe("repeated-characters");
    expect(h.send(`hey ${"!".repeat(60)}`)).toBe("repeated-characters");
    expect(h.send("buy now ".repeat(6))).toBe("repeated-characters");
    expect(h.send("A\u200b".repeat(40))).toBe("repeated-characters");
    expect(
      harness().send(
        "The market by the old bridge opens at nine, bring cash because the card reader is flaky.",
      ),
    ).toBe("allowed");
  });

  test("one text from many throwaway identities is hidden after three", () => {
    const h = harness();
    const text = "Free sats for everyone at freesats dot example";
    const verdicts = [1, 2, 3, 4, 5, 6].map((i) =>
      h.send(text, { sender: `npub${i}` }),
    );
    expect(verdicts).toEqual([
      "allowed",
      "allowed",
      "allowed",
      "repeated-across-users",
      "repeated-across-users",
      "repeated-across-users",
    ]);
  });

  test("small edits across identities are still near-copies", () => {
    const h = harness();
    const variants = [
      "Free sats for everyone, claim yours now",
      "free sats for everyone, claim yours now 1",
      "Free sats for everyone!! claim yours now",
      "free sats 4 everyone, claim yours now",
      "free  sats for everyone, claim yours now 55",
    ];
    expect(
      variants.map((text, i) => h.send(text, { sender: `npub${i}` })),
    ).toEqual([
      "allowed",
      "allowed",
      "allowed",
      "allowed",
      "repeated-across-users",
    ]);
  });

  test("short common replies and same-topic chat stay visible", () => {
    const h = harness();
    for (let i = 0; i < 8; i++) {
      expect(h.send("good morning!", { sender: `user${i}` })).toBe("allowed");
    }
    [
      "is the bakery on the corner still open?",
      "the bakery closes at eight I think",
      "bakery was still open when I walked by",
      "anyone know if the bakery has bread left?",
      "the corner bakery is open until eight",
    ].forEach((text, i) =>
      expect(h.send(text, { sender: `topic${i}` })).toBe("allowed"),
    );
  });

  test("a sender's own copies do not count toward the cross-user limit", () => {
    const h = harness();
    const text = "anyone near the north gate tonight?";
    h.send(text, { sender: "alice" });
    h.advance(60);
    h.send(text, { sender: "alice" });
    expect(h.send(text, { sender: "bob" })).toBe("allowed");
    expect(h.send(text, { sender: "carol" })).toBe("repeated-across-users");
  });

  test("disguised copies fold to the text a reader sees", () => {
    const base = "Free sats for everyone, claim yours now";
    const invisibles = ["\u200c", "\u200d", "\u2060", "\u00ad", "\u200e"];
    const disguises = [
      Array.from(base, (c) => `${c}\u200b`).join(""),
      Array.from(base, (c, i) => c + invisibles[i % invisibles.length]).join(
        "",
      ),
      Array.from(base, (c) => (/\p{L}/u.test(c) ? `${c}́` : c)).join(""),
      Array.from(base, (c) => {
        const code = c.codePointAt(0) as number;
        return code > 0x20 && code < 0x7f
          ? String.fromCodePoint(code + 0xfee0)
          : c;
      }).join(""),
    ];
    const plain = normalizeForComparison(base, 1000);
    for (const text of disguises) {
      expect(normalizeForComparison(text, 1000)).toEqual(plain);
      const h = harness();
      for (let i = 0; i < 3; i++) h.send(base, { sender: `npub${i}` });
      expect(h.send(text, { sender: "npub9" })).toBe("repeated-across-users");
    }
  });

  test("accents and other scripts are not mistaken for spam", () => {
    const h = harness();
    [
      "Tiếng Việt có dấu, chúng tôi đang ở quán cà phê gần chợ",
      "क्या कोई पास में चाय की दुकान जानता है? मैं स्टेशन के पास हूँ",
      "Café au lait, crème brûlée, s'il vous plaît",
      "家族と一緒に駅の近くのカフェにいます、誰か来ますか",
      "मैं स्टेशन के पास हूँ, बारिश हो रही है",
      "आज बाज़ार कितने बजे बंद होगा?",
    ].forEach((text, i) =>
      expect(h.send(text, { sender: `user${i}` })).toBe("allowed"),
    );
  });
});

describe("senders, duplicates and time", () => {
  test("one message ID is judged and counted once", () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.send();
    expect(h.send(undefined, { id: "dup" })).toBe("allowed");
    expect(h.send(undefined, { id: "dup" })).toBe("allowed");
    expect(h.send()).toBe("message-rate");
  });

  test("backfill delivered newest first is shown", () => {
    const h = harness();
    const verdicts = Array.from({ length: 10 }, (_, m) =>
      h.send(undefined, { at: h.ago(m * 60) }),
    );
    expect(verdicts.every((v) => v === "allowed")).toBe(true);
  });

  test("a backfilled burst is limited on its own timestamps", () => {
    const h = harness();
    const start = h.ago(5 * 60);
    const verdicts = Array.from({ length: 10 }, (_, i) =>
      h.send(undefined, { at: start + i * 1000 }),
    );
    expect(verdicts.filter((v) => v === "allowed")).toHaveLength(6);
  });

  // The service hands over every copy, stored ones too, for exactly this.
  test("a relaunch replaying the same history hides the same messages", () => {
    const now = 1_000_000_000;
    const history = [
      ...Array.from({ length: 10 }, (_, i) => ({
        sender: "alice",
        text: `message number ${i} about the weather`,
        at: now - 60_000 + i * 1000,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        sender: `throwaway${i}`,
        text: "join my channel for free sats now",
        at: now - 30_000 + i * 1000,
      })),
    ];
    const judge = (filter: SpamFilter) =>
      history.map((m, i) => filter.check(m.sender, `m${i}`, m.text, m.at));
    const before = judge(new SpamFilter(() => now));
    expect(before.filter((v) => v !== "allowed")).toHaveLength(11);
    expect(judge(new SpamFilter(() => now + 5_000))).toEqual(before);
  });

  test("backfill cannot be squeezed in before shown messages", () => {
    const h = harness();
    for (let i = 0; i < 6; i++) h.send(undefined, { at: h.ago(60) });
    expect(h.send(undefined, { at: h.ago(61) })).toBe("message-rate");
  });

  test("past and future timestamps are clamped", () => {
    const h = harness();
    const old = Array.from({ length: 10 }, (_, i) =>
      h.send(undefined, { at: h.ago((10 - i) * 86_400) }),
    );
    expect(old.filter((v) => v === "allowed")).toHaveLength(6);
    const f = harness();
    const future = Array.from({ length: 10 }, (_, i) =>
      f.send(undefined, { sender: "bob", at: f.now() + i * 60_000 }),
    );
    expect(future.filter((v) => v === "allowed")).toHaveLength(6);
  });

  test("senders have their own budgets, and off or reset lets all through", () => {
    const h = harness();
    for (let i = 0; i < 6; i++) h.send();
    expect(h.send(undefined, { sender: "bob" })).toBe("allowed");
    expect(h.send()).toBe("message-rate");
    h.filter.reset();
    expect(h.send()).toBe("allowed");
    h.filter.enabled = false;
    expect(h.send("A".repeat(40))).toBe("allowed");
  });
});
