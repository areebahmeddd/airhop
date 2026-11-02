// The links in a message's text, found exactly as the bubble draws them, so a
// screen reader is offered the same links a sighted reader can tap.

import { tokenizeFormatting } from "@utils/message-format";

// An @mention (with a location channel's "#abcd" suffix) or a URL. One pattern
// for both, because a mention consumes characters a URL search alone would
// start inside ("@www.x" is a mention, not a link). Fresh per call: a global
// regex carries its position between uses.
export function inlineTokenPattern(): RegExp {
  return /(^|\s)(@[\p{L}\p{M}\p{N}_-]+)(#[0-9a-fA-F]{4}(?![\p{L}\p{N}_]))?|(https?:\/\/\S+|www\.\S+)/gu;
}

// Trailing punctuation is almost always the sentence's, not the URL's ("see
// https://x.com/a." or "(https://x.com/a)").
export function trimLink(url: string): string {
  return url.replace(/[.,!?;:)\]}'"]+$/, "");
}

export function linkHref(link: string): string {
  return link.startsWith("www.") ? `https://${link}` : link;
}

// Every link outside a code span, in order and without repeats, up to `limit`.
export function findMessageLinks(text: string, limit: number): string[] {
  const links: string[] = [];
  for (const token of tokenizeFormatting(text)) {
    if (token.kind === "code") continue;
    for (const match of token.value.matchAll(inlineTokenPattern())) {
      const url = match[4];
      if (url === undefined) continue;
      const link = trimLink(url);
      if (!links.includes(link)) links.push(link);
      if (links.length >= limit) return links;
    }
  }
  return links;
}
