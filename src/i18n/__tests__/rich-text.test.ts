/** @jest-environment node */

import { fillRichText } from "../rich-text";

describe("fillRichText", () => {
  it("isolates a text var and strips its bidi controls, as t() does", () => {
    // A right-to-left override inside a nickname must not reorder the sentence.
    const parts = fillRichText("{name} says hi", {}, { name: "eve\u202Egnp" });
    expect(parts.join("")).toBe("\u2068evegnp\u2069 says hi");
  });

  it("leaves an unmatched placeholder visible", () => {
    expect(fillRichText("hi {who}", {}).join("")).toBe("hi {who}");
  });
});
