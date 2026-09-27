// bitchat's favourite notice: a private message whose text is
//
//   [FAVORITED]:<npub>     or     [UNFAVORITED]:<npub>
//
// with the `:<npub>` part absent when the sender has no Nostr identity. bitchat
// sends one over the mesh or Nostr when its user stars or unstars someone, and
// both bitchat apps swallow it on receipt. Airhop has no favourites to update,
// so it only has to keep the control text out of a thread and a notification.
//
// Matched after trimming, as bitchat-android does. bitchat-ios matches the raw
// prefix, so this accepts everything either would.

const PREFIXES = ["[FAVORITED]", "[UNFAVORITED]"] as const;

export function isFavoriteControl(content: string): boolean {
  const trimmed = content.trim();
  return PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}
