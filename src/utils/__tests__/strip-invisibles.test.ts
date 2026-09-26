/**
 * @jest-environment node
 */
// Characters that change how text reads without being seen. Every one below is
// written as an escape: the literal would be invisible in review, and CI
// refuses it (npm run verify:invisibles).
import { stripInvisibles } from "../strip-invisibles";

const RLO = "\u202E";
const LRI = "\u2066";
const PDI = "\u2069";
const ZWSP = "\u200B";
const BOM = "\uFEFF";
const ZWNJ = "\u200C";
const ZWJ = "\u200D";
const LRM = "\u200E";
// TAG LATIN SMALL LETTER A, then CANCEL TAG.
const TAGS = "\u{E0061}\u{E007F}";

describe("stripInvisibles", () => {
  it("drops a bidi override, so a file name cannot disguise its extension", () => {
    expect(stripInvisibles(`invoice${RLO}fdp.exe`)).toBe("invoicefdp.exe");
  });

  it("drops isolates, zero-width space, the BOM and tag characters", () => {
    expect(stripInvisibles(`${LRI}m${ZWSP}o${BOM}m${PDI}${TAGS}`)).toBe("mom");
  });

  it("drops C0 and C1 controls", () => {
    expect(stripInvisibles("a\u0000b\u0007c\u001Bd\u0085e\u009Ff")).toBe(
      "abcdef",
    );
  });

  it("keeps ZWJ, which joins an emoji sequence", () => {
    // WOMAN, ZWJ, LAPTOP: one glyph, and it must stay one.
    const technologist = `\u{1F469}${ZWJ}\u{1F4BB}`;
    expect(stripInvisibles(technologist)).toBe(technologist);
  });

  it("keeps ZWNJ, which Persian spelling needs", () => {
    // "mi" + ZWNJ + "khaham", the Persian for "I want".
    const persian = `\u0645\u06CC${ZWNJ}\u062E\u0648\u0627\u0647\u0645`;
    expect(stripInvisibles(persian)).toBe(persian);
  });

  it("keeps LRM, which only settles the neutrals beside it", () => {
    expect(stripInvisibles(`a${LRM}b`)).toBe(`a${LRM}b`);
  });

  it("keeps line breaks and tabs, unless the text is a name", () => {
    expect(stripInvisibles("one\ntwo\tthree")).toBe("one\ntwo\tthree");
    expect(stripInvisibles("Mom\n(verified)", { singleLine: true })).toBe(
      "Mom (verified)",
    );
    expect(stripInvisibles("a\u2028b", { singleLine: true })).toBe("a b");
  });
});
