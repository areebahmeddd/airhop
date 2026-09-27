/**
 * @jest-environment node
 */
// A bubble aligns by its own text's direction, not only by the UI's.

import { contentTextAlign } from "../layout";

// The runner lays out left to right, as an English phone does.
describe("contentTextAlign", () => {
  it("leaves text running the UI's way at the leading edge", () => {
    expect(contentTextAlign("see you at the gate")).toBe("auto");
    expect(contentTextAlign("東京で会いましょう")).toBe("auto");
  });

  it("puts text running the other way at the trailing edge", () => {
    expect(contentTextAlign("نلتقي عند البوابة")).toBe("right");
    expect(contentTextAlign("נתראה בשער")).toBe("right");
  });

  it("decides on the first letter, past digits and emoji", () => {
    expect(contentTextAlign("12:30 🙂 نلتقي at noon")).toBe("right");
    expect(contentTextAlign("12:30 at noon نلتقي")).toBe("auto");
  });

  it("has no opinion on text without letters", () => {
    expect(contentTextAlign("")).toBe("auto");
    expect(contentTextAlign("👍 42")).toBe("auto");
  });
});
