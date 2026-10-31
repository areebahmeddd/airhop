// Counts links: scheme URLs, `www.` hosts and bare domains such as
// `example.com/path`, but not email addresses or abbreviations like `e.g.`.
// bitchat's pattern, so every client rate-limits the same messages.

const LINK =
  /(?<![\w@.-])(?:https?:\/\/[^\s<>]+|www\.[^\s<>]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[^\s<>]*)?)(?![\w@])/gi;

export function countLinks(text: string): number {
  return text.match(LINK)?.length ?? 0;
}
