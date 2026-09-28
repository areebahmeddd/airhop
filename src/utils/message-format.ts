// Inline text formatting: the same delimiters WhatsApp and Slack use, since
// those are the convention most people already type without thinking about
// it. *bold*, _italic_, ~strike~, `code`. bitchat has no wire syntax for any
// of this (confirmed against both native apps): a peer that does not parse it
// just sees the literal asterisks, so this is purely a local rendering
// choice, safe to change without a protocol version bump.
//
// A delimiter only opens at the start of the text or after whitespace, and
// only closes at the end or before a non-word character (the same boundary
// `mentions.ts` uses for `@name`). That is what keeps `snake_case_name` and
// `5*3*2` from being misread as formatting. The content between a pair may
// not start or end with whitespace, so `* not bold *` is left alone too.
// Code is the one exception: its content is kept byte-for-byte, since a
// literal space is often the point of writing code inline.
//
// Delimiters do not nest: whatever a pair encloses is returned as plain text
// for the caller to run its own mention/link pass over, but a second
// formatting marker inside it is not reinterpreted. WhatsApp draws the same
// line.

export type FormatToken =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "bold"; value: string }
  | { kind: "italic"; value: string }
  | { kind: "strike"; value: string };

// Boundary reused from mentions.ts: everything that is not a letter, digit or
// underscore, so every script's own punctuation closes a span, not just ASCII's.
const CLOSE = String.raw`(?=$|[^\p{L}\p{N}_])`;

// Under the `u` flag, only ECMAScript's syntax characters may be
// backslash-escaped. `_` and `~` are not among them, and are not special
// inside a class either, so escaping them there throws a SyntaxError. `*`
// is the one mark of the three that actually needs it.
function pair(mark: string, lead: string, body: string): string {
  const m = mark === "*" ? "\\*" : mark;
  // A single non-delimiter, non-space character, or one that also allows a
  // non-empty run of anything but the delimiter in between.
  const inner = `[^\\s${m}][^${m}\\n]*?[^\\s${m}]|[^\\s${m}]`;
  return `(?<${lead}>^|\\s)${m}(?<${body}>${inner})${m}${CLOSE}`;
}

function formatRe(): RegExp {
  const code = `(?<codeLead>^|\\s)\`(?<code>[^\`\\n]+)\`${CLOSE}`;
  return new RegExp(
    [
      code,
      pair("*", "boldLead", "bold"),
      pair("_", "italicLead", "italic"),
      pair("~", "strikeLead", "strike"),
    ].join("|"),
    "gu",
  );
}

// Never throws: an empty or unmatched string comes back as one "text" token,
// and the returned tokens always account for every character of the input.
export function tokenizeFormatting(text: string): FormatToken[] {
  const re = formatRe();
  const tokens: FormatToken[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const g = m.groups as Record<string, string | undefined>;
    const lead = g.codeLead ?? g.boldLead ?? g.italicLead ?? g.strikeLead ?? "";
    const start = m.index + lead.length;
    if (start > last)
      tokens.push({ kind: "text", value: text.slice(last, start) });
    if (g.code !== undefined) tokens.push({ kind: "code", value: g.code });
    else if (g.bold !== undefined) tokens.push({ kind: "bold", value: g.bold });
    else if (g.italic !== undefined)
      tokens.push({ kind: "italic", value: g.italic });
    else tokens.push({ kind: "strike", value: g.strike as string });
    last = m.index + m[0].length;
  }
  if (last < text.length)
    tokens.push({ kind: "text", value: text.slice(last) });
  if (tokens.length === 0) tokens.push({ kind: "text", value: text });
  return tokens;
}

// The delimiters stripped back out, for a context that shows message text
// without rendering it: a conversation list preview or a notification body.
export function stripFormatting(text: string): string {
  const tokens = tokenizeFormatting(text);
  if (tokens.length === 1 && tokens[0].kind === "text") return text;
  return tokens.map((t) => t.value).join("");
}
