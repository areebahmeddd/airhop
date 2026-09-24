/**
 * @jest-environment node
 */
// Byte budgets for captions and forwards. Both are wire lengths in UTF-8 bytes,
// so every case here is one where counting UTF-16 units gives the wrong answer.

import { MAX_CAPTION_BYTES } from "@core/mesh/wire/file-packet";
import { PRIVATE_MESSAGE_MAX_CONTENT_BYTES } from "@core/mesh/wire/noise-payload";
import { utf8ByteLength } from "@utils/utf8-budget";
import { clampCaption, forwardTextFits } from "../compose-budget";

describe("clampCaption", () => {
  it("leaves a caption inside the budget alone", () => {
    const caption = "a".repeat(MAX_CAPTION_BYTES);
    expect(clampCaption(caption)).toBe(caption);
  });

  it("cuts by bytes, not UTF-16 units", () => {
    // 200 emoji are 400 UTF-16 units, which `maxLength={512}` admitted, and
    // 800 bytes, which the encoder drops without a word.
    const caption = "😀".repeat(200);
    const clamped = clampCaption(caption);
    expect(utf8ByteLength(clamped)).toBeLessThanOrEqual(MAX_CAPTION_BYTES);
    expect(clamped).toBe("😀".repeat(MAX_CAPTION_BYTES / 4));
  });

  it("never leaves half a surrogate pair", () => {
    const clamped = clampCaption("a" + "😀".repeat(200));
    expect(clamped.endsWith("\uD83D")).toBe(false);
    expect(utf8ByteLength(clamped)).toBeLessThanOrEqual(MAX_CAPTION_BYTES);
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
