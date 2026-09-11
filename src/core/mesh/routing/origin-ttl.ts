// The TTL a packet this phone authored leaves with.
//
// A relay decrements TTL, so a packet still carrying the protocol maximum was
// written by whoever just transmitted it. To a passive listener that separates
// "this phone is nearby" from "this phone is talking". Drawing from a small
// range blurs it: in a dense graph relays already clamp to 5, so an origin at
// 5 looks relayed, and a 6 could be an origin or one hop from a 7. Signature
// safe, since TTL is zeroed in the signed bytes so relays can decrement.
//
// Applies to broadcasts that carry content we authored: public and private
// channel messages, group messages, board posts, public files, live voice.
// A start of 5 reaches two hops fewer; text, board posts and group messages
// backfill over gossip, the rest accept the cost. Not applied to:
//
//   * Announces. The direct-peer rule in mesh-service identifies a directly
//     heard announce by `packet.ttl === ANNOUNCE_TTL`, and that rule is what
//     stops one hostile peer inventing hundreds of "directly connected"
//     identities immune to eviction.
//   * Directed traffic (DMs, handshakes, courier, sealed files). Fewer hops
//     means fewer deliveries, and the trade needs its own look.
//   * Prekey bundles and gateway carriers. A bundle already names its owner,
//     and a carrier is a rebroadcast, not authorship.
//
// The top of the range is still unambiguous, so about a third of packets stay
// attributable. Removing the signal needs relays that sometimes decline to
// decrement, which is a coordinated protocol change.

const ORIGIN_TTL_MIN = 5;
const ORIGIN_TTL_MAX = 7;

export function originTtl(): number {
  return (
    ORIGIN_TTL_MIN +
    Math.floor(Math.random() * (ORIGIN_TTL_MAX - ORIGIN_TTL_MIN + 1))
  );
}
