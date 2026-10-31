// Byte budgets for captions and forwards. Both are wire lengths in UTF-8 bytes,
// so every case here is one where counting UTF-16 units gives the wrong answer.

import { MAX_CAPTION_BYTES } from "@core/mesh/wire/file-packet";
import { PRIVATE_MESSAGE_MAX_CONTENT_BYTES } from "@core/mesh/wire/noise-payload";
import {
  clampCaption,
  clampPublicText,
  forwardTextFits,
  PUBLIC_MESSAGE_MAX_CHARS,
} from "../compose-budget";

// utf8-budget.test.ts covers the cut itself; this pins that the caption is
// held to the caption field's budget.
describe("clampCaption", () => {
  it("cuts to the caption budget in bytes, not UTF-16 units", () => {
    // 200 emoji are 400 UTF-16 units, which `maxLength` would count, and 800
    // bytes, which the encoder drops without a word.
    const clamped = clampCaption("😀".repeat(200));
    expect(clamped).toBe("😀".repeat(MAX_CAPTION_BYTES / 4));
  });
});

describe("forwardTextFits", () => {
  const long = "a".repeat(PRIVATE_MESSAGE_MAX_CONTENT_BYTES + 1);

  it("refuses a DM text over the private-message budget", () => {
    expect(forwardTextFits("dm:aabbccdd00112233", long, false)).toBe(false);
  });

  it("counts the budget in bytes", () => {
    // 100 characters of Devanagari are 300 bytes: fine by length, too long
    // on the wire.
    const hindi = "क".repeat(100);
    expect(forwardTextFits("dm:aabbccdd00112233", hindi, false)).toBe(false);
  });

  it("accepts a DM text exactly at the budget", () => {
    const exact = "a".repeat(PRIVATE_MESSAGE_MAX_CONTENT_BYTES);
    expect(forwardTextFits("dm:aabbccdd00112233", exact, false)).toBe(true);
  });

  it("has no budget for a group or a private channel", () => {
    const essay = "a".repeat(PUBLIC_MESSAGE_MAX_CHARS + 1);
    expect(forwardTextFits("group:00ff", essay, false)).toBe(true);
    expect(forwardTextFits("#team", essay, true)).toBe(true);
  });

  // bitchat hides a public message over its spam filter's character budget.
  it.each(["#bluetooth", "#mesh", "geohash:u4pruy"])(
    "holds the public room %s to the spam filter's limit",
    (channel) => {
      const emoji = "😀".repeat(PUBLIC_MESSAGE_MAX_CHARS);
      expect(forwardTextFits(channel, emoji, false)).toBe(true);
      expect(forwardTextFits(channel, `${emoji}a`, false)).toBe(false);
    },
  );
});

describe("clampPublicText", () => {
  it("cuts at the limit in code points and leaves shorter text alone", () => {
    const over = "😀".repeat(PUBLIC_MESSAGE_MAX_CHARS + 5);
    expect(Array.from(clampPublicText(over))).toHaveLength(
      PUBLIC_MESSAGE_MAX_CHARS,
    );
    expect(clampPublicText("hello")).toBe("hello");
  });
});
