import { stripFormatting, tokenizeFormatting } from "../message-format";

describe("tokenizeFormatting", () => {
  it("returns one text token for plain text", () => {
    expect(tokenizeFormatting("hello there")).toEqual([
      { kind: "text", value: "hello there" },
    ]);
  });

  it("returns one text token for an empty string", () => {
    expect(tokenizeFormatting("")).toEqual([{ kind: "text", value: "" }]);
  });

  it("parses bold, italic, strike and code at the start of the string", () => {
    expect(tokenizeFormatting("*bold*")).toEqual([
      { kind: "bold", value: "bold" },
    ]);
    expect(tokenizeFormatting("_italic_")).toEqual([
      { kind: "italic", value: "italic" },
    ]);
    expect(tokenizeFormatting("~strike~")).toEqual([
      { kind: "strike", value: "strike" },
    ]);
    expect(tokenizeFormatting("`code`")).toEqual([
      { kind: "code", value: "code" },
    ]);
  });

  it("keeps the surrounding text as separate tokens", () => {
    expect(tokenizeFormatting("say *bold* now")).toEqual([
      { kind: "text", value: "say " },
      { kind: "bold", value: "bold" },
      { kind: "text", value: " now" },
    ]);
  });

  it("parses more than one span in the same message", () => {
    expect(tokenizeFormatting("*bold* and _italic_")).toEqual([
      { kind: "bold", value: "bold" },
      { kind: "text", value: " and " },
      { kind: "italic", value: "italic" },
    ]);
  });

  it("does not format across a snake_case identifier", () => {
    expect(tokenizeFormatting("keep_this_var")).toEqual([
      { kind: "text", value: "keep_this_var" },
    ]);
  });

  it("does not format a single delimiter mid-expression", () => {
    // The opening "*" is preceded by a digit, so it never opens a span.
    expect(tokenizeFormatting("5*3*2=30")).toEqual([
      { kind: "text", value: "5*3*2=30" },
    ]);
  });

  it("does not format when content touches the delimiter with whitespace", () => {
    expect(tokenizeFormatting("* not bold *")).toEqual([
      { kind: "text", value: "* not bold *" },
    ]);
  });

  it("does not format when the closing delimiter is glued to another word", () => {
    expect(tokenizeFormatting("*bold*ing")).toEqual([
      { kind: "text", value: "*bold*ing" },
    ]);
  });

  it("allows a formatted span to be the entire message", () => {
    expect(tokenizeFormatting("*only bold*")).toEqual([
      { kind: "bold", value: "only bold" },
    ]);
  });

  it("keeps whitespace inside a code span verbatim", () => {
    expect(tokenizeFormatting("`a  b`")).toEqual([
      { kind: "code", value: "a  b" },
    ]);
  });

  it("does not reinterpret a delimiter nested inside another span", () => {
    expect(tokenizeFormatting("*bold _still bold_ text*")).toEqual([
      { kind: "bold", value: "bold _still bold_ text" },
    ]);
  });

  it("does not format inside a code span", () => {
    expect(tokenizeFormatting("`*not bold*`")).toEqual([
      { kind: "code", value: "*not bold*" },
    ]);
  });

  it("closes a span at script punctuation, not just ASCII's", () => {
    expect(tokenizeFormatting("*bold*、")).toEqual([
      { kind: "bold", value: "bold" },
      { kind: "text", value: "、" },
    ]);
  });

  it("formats a single non-space character", () => {
    expect(tokenizeFormatting("*x*")).toEqual([{ kind: "bold", value: "x" }]);
  });

  it("leaves an unmatched delimiter as plain text", () => {
    expect(tokenizeFormatting("half *bold")).toEqual([
      { kind: "text", value: "half *bold" },
    ]);
  });
});

describe("stripFormatting", () => {
  it("returns plain text unchanged", () => {
    expect(stripFormatting("hello there")).toBe("hello there");
  });

  it("drops the delimiters and keeps the words", () => {
    expect(
      stripFormatting("say *bold* and _italic_ and ~struck~ and `code`"),
    ).toBe("say bold and italic and struck and code");
  });
});
