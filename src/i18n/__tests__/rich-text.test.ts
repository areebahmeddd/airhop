/** @jest-environment node */

import { fillRichText } from "../rich-text";

describe("fillRichText", () => {
  it("isolates a text var and strips its bidi controls, as t() does", () => {
    // A right-to-left override inside a nickname must not reorder the sentence.
    const parts = fillRichText("{name} says hi", {}, { name: "eve‮gnp" });
    expect(parts.join("")).toBe("⁨evegnp⁩ says hi");
  });

  it("leaves an unmatched placeholder visible", () => {
    expect(fillRichText("hi {who}", {}).join("")).toBe("hi {who}");
  });
});
