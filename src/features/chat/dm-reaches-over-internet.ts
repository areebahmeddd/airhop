// Whether a DM to someone out of Bluetooth range goes out over the internet
// right now, which is the most the thread banner may claim.
//
// An address alone is not a route: with every relay down (no signal, the
// internet switch off, Tor still building or blocked) the message waits in the
// outbox like any other, so the banner must say it waits.
export function dmReachesOverInternet(
  peerID: string,
  contactNpub: string | undefined,
  relayConnected: boolean,
): boolean {
  if (!relayConnected) return false;
  return (
    peerID.startsWith("nostr_") ||
    (contactNpub !== undefined && contactNpub.length > 0)
  );
}
