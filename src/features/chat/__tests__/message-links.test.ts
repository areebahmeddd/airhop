// The links a screen reader is offered are the links the bubble draws.

import { findMessageLinks, linkHref, trimLink } from "../message-links";

describe("findMessageLinks", () => {
  it("finds links in reading order, without sentence punctuation", () => {
    expect(
      findMessageLinks("see https://x.com/a. and (www.y.org/b)", 3),
    ).toEqual(["https://x.com/a", "www.y.org/b"]);
  });

  it("stops at the limit and skips repeats", () => {
    const text = "https://a.io https://a.io https://b.io https://c.io";
    expect(findMessageLinks(text, 2)).toEqual(["https://a.io", "https://b.io"]);
  });

  it("leaves code spans alone, as the bubble does", () => {
    expect(findMessageLinks("`https://hidden.io` https://shown.io", 3)).toEqual(
      ["https://shown.io"],
    );
  });

  it("treats a mention as a mention, not a link", () => {
    expect(findMessageLinks("hi @www.example", 3)).toEqual([]);
  });

  it("finds a link inside a formatting span", () => {
    expect(findMessageLinks("*https://bold.io*", 3)).toEqual([
      "https://bold.io",
    ]);
  });
});

describe("linkHref", () => {
  it("gives a bare www link a scheme", () => {
    expect(linkHref(trimLink("www.x.com,"))).toBe("https://www.x.com");
    expect(linkHref("http://x.com")).toBe("http://x.com");
  });
});
