// @-mention parsing: the composer picker and the "was I mentioned" check both
// hinge on these, so token boundaries and edge cases are pinned here.

import {
  activeMentionQuery,
  applyMention,
  mentionsNickname,
} from "../mentions";

describe("activeMentionQuery", () => {
  it("returns the partial while typing a mention at the end", () => {
    expect(activeMentionQuery("@an")).toBe("an");
    expect(activeMentionQuery("hey @an")).toBe("an");
    expect(activeMentionQuery("@")).toBe("");
  });

  it("returns null when the caret is not in a mention", () => {
    expect(activeMentionQuery("hello")).toBeNull();
    expect(activeMentionQuery("@ana done")).toBeNull(); // space closed it
    expect(activeMentionQuery("email@host")).toBeNull(); // not a word-start @
  });
});

describe("activeMentionQuery mid-draft", () => {
  // The word "everyone" selected and replaced with "@al".
  const draft = "hey @al, see you tomorrow";
  const caret = "hey @al".length;

  it("finds the mention that ends at the caret", () => {
    expect(activeMentionQuery(draft, caret)).toBe("al");
  });

  it("offers nothing with the caret inside a longer name", () => {
    expect(activeMentionQuery("hey @alice, hi", "hey @al".length)).toBeNull();
    expect(
      activeMentionQuery("hey @swift-otter", "hey @swift".length),
    ).toBeNull();
  });

  it("offers nothing with the caret past the mention", () => {
    expect(activeMentionQuery(draft, draft.length)).toBeNull();
  });

  it("counts emoji and combining accents before the @ by code unit", () => {
    const before = "ok 👍 café @be";
    expect(activeMentionQuery(`${before} later`, before.length)).toBe("be");
  });
});

describe("applyMention", () => {
  it("completes a mention at the end with a trailing space", () => {
    expect(applyMention("@an", "anabelle")).toEqual({
      text: "@anabelle ",
      caret: 10,
    });
    expect(applyMention("hey @an", "anabelle").text).toBe("hey @anabelle ");
    expect(applyMention("@", "anabelle").text).toBe("@anabelle ");
  });

  it("keeps the rest of the draft and puts the caret after the name", () => {
    const draft = "hey @al, see you tomorrow";
    const next = applyMention(draft, "alice", "hey @al".length);
    expect(next.text).toBe("hey @alice, see you tomorrow");
    expect(next.caret).toBe("hey @alice".length);
    const spaced = applyMention("@al and more", "alice", 3);
    expect(spaced.text).toBe("@alice and more");
  });

  it("handles nicknames with regex-special characters safely", () => {
    expect(applyMention("@sw", "swift.otter").text).toBe("@swift.otter ");
  });
});

describe("mentionsNickname", () => {
  it("detects a whole-token mention, case-insensitively", () => {
    expect(mentionsNickname("hey @ana how are you", "ana")).toBe(true);
    expect(mentionsNickname("@Ana!", "ana")).toBe(true);
    expect(mentionsNickname("ping @ana", "ana")).toBe(true);
  });

  it("does not match a prefix of a longer name", () => {
    expect(mentionsNickname("hey @anabelle", "ana")).toBe(false);
  });

  it("ignores a non-word-start @ and an empty nickname", () => {
    expect(mentionsNickname("mail me at ana@host", "ana")).toBe(false);
    expect(mentionsNickname("@ana", "")).toBe(false);
  });
});

// bitchat writes "@name#abcd" in a location channel, where names are not unique.
describe("mentionsNickname with a location channel suffix", () => {
  it("matches our own suffix, in any case", () => {
    expect(mentionsNickname("@ana#d2c4 nice", "ana", "d2c4")).toBe(true);
    expect(mentionsNickname("@ana#D2C4 nice", "ana", "d2c4")).toBe(true);
  });

  it("refuses another person's suffix on the same name", () => {
    expect(mentionsNickname("@ana#9c02 nice", "ana", "d2c4")).toBe(false);
  });

  it("still matches when either mention carries ours", () => {
    expect(mentionsNickname("@ana#9c02 and @ana#d2c4", "ana", "d2c4")).toBe(
      true,
    );
  });

  it("goes by the name alone when the mention has no suffix", () => {
    expect(mentionsNickname("hey @ana", "ana", "d2c4")).toBe(true);
  });

  it("goes by the name alone outside a location channel", () => {
    expect(mentionsNickname("@ana#9c02 nice", "ana", null)).toBe(true);
  });
});

// The cross-platform case. One keyboard produces the composed form, another the
// decomposed form, and the two render identically. Without normalization the
// mention never fires: the mentioned peer is not notified and neither side can
// see why.
describe("mentionsNickname across Unicode encodings", () => {
  const COMPOSED = "Jos\u00e9";
  const DECOMPOSED = "Jose\u0301";

  it("a decomposed nickname matches a composed mention", () => {
    expect(mentionsNickname(`hey @${COMPOSED} here`, DECOMPOSED)).toBe(true);
  });

  it("a composed nickname matches a decomposed mention", () => {
    expect(mentionsNickname(`hey @${DECOMPOSED} here`, COMPOSED)).toBe(true);
  });

  it("still refuses a prefix of a longer accented name", () => {
    expect(mentionsNickname(`hey @${COMPOSED}fina`, DECOMPOSED)).toBe(false);
  });
});

// Every script's full stop, not ASCII's. A mention closed by one of the marks
// below has to count, or it does not pass a mute and raises no mention
// notification, in a third of the languages Airhop ships.
describe("mentionsNickname across scripts", () => {
  const TERMINATORS: [string, string][] = [
    ["Japanese full stop", "。"],
    ["Japanese comma", "、"],
    ["fullwidth question mark", "？"],
    ["fullwidth exclamation", "！"],
    ["Arabic comma", "،"],
    ["Arabic question mark", "؟"],
    ["Devanagari danda", "।"],
    ["Burmese section mark", "။"],
    ["Ethiopic full stop", "።"],
    ["ASCII full stop", "."],
  ];

  it.each(TERMINATORS)("closes a mention on a %s", (_name, mark) => {
    expect(mentionsNickname(`@areeb${mark} hello`, "areeb")).toBe(true);
  });

  it("matches a nickname written in a non-Latin script", () => {
    // A nickname is arbitrary UTF-8 off the wire, so the pattern has to hold
    // for one sharing no characters with the boundary class.
    expect(mentionsNickname("こんばんは @あさひ です", "あさひ")).toBe(true);
    expect(mentionsNickname("مرحبا @أحمد،", "أحمد")).toBe(true);
  });

  it("still refuses a prefix, since a letter is not a boundary", () => {
    expect(mentionsNickname("@あさひこ hello", "あさひ")).toBe(false);
  });

  it("keeps refusing an email, which is why the OPENING boundary stays strict", () => {
    // Relaxing the leading side would read the host out of "ali@example.com" as
    // a mention of "example". The cost is that Chinese and Japanese, which write
    // no spaces, need the mention at a word start.
    expect(mentionsNickname("mail me at ali@example.com", "example")).toBe(
      false,
    );
  });
});
