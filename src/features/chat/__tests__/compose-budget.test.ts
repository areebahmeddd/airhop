// Byte budgets for captions and forwards. Both are wire lengths in UTF-8 bytes,
// so every case here is one where counting UTF-16 units gives the wrong answer.

import { MAX_CAPTION_BYTES } from "@core/mesh/wire/file-packet";
import { PRIVATE_MESSAGE_MAX_CONTENT_BYTES } from "@core/mesh/wire/noise-payload";
import { clampCaption, forwardTextFits } from "../compose-budget";

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
    expect(forwardTextFits("dm:aabbccdd00112233", long)).toBe(false);
  });

  it("counts the budget in bytes", () => {
    // 100 characters of Devanagari are 300 bytes: fine by length, too long
    // on the wire.
    const hindi = "क".repeat(100);
    expect(forwardTextFits("dm:aabbccdd00112233", hindi)).toBe(false);
  });

  it("accepts a DM text exactly at the budget", () => {
    const exact = "a".repeat(PRIVATE_MESSAGE_MAX_CONTENT_BYTES);
    expect(forwardTextFits("dm:aabbccdd00112233", exact)).toBe(true);
  });

  it.each(["#mesh", "group:00ff", "geohash:u4pruy"])(
    "has no budget for %s",
    (channel) => {
      expect(forwardTextFits(channel, long)).toBe(true);
    },
  );
});
