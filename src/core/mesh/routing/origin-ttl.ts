// The TTL a packet this phone authored leaves with.
//
// A relay takes a hop off the TTL, so a packet still carrying the most any
// relay could emit was written by whoever just transmitted it. To a passive
// listener that separates "this phone is nearby" from "this phone is talking".
// Drawing from the top three values of the range blurs it: relays at this
// degree emit at most one below the class ceiling (relayLimit), so the lower
// two values look relayed and about a third of packets, those at the ceiling,
// stay attributable. Removing the signal entirely needs relays that sometimes
// decline to decrement, which is a coordinated protocol change. Signature
// safe, since TTL is zeroed in the signed bytes so relays can decrement.
//
// The ceiling follows this phone's degree: 7 sparse, 6 at mid degree (7 for
// an urgent board post), 5 dense, and a live voice stream's 7 or 5. That is
// what neighbours at the same degree clamp to anyway, so reach is unchanged at
// the top. The cost is a dense originator whose neighbours are sparse: they
// would relay at full depth, and it starts up to two hops short of that.
// Public text, board posts and group messages backfill over gossip; the rest
// accept it.
//
// Applies to broadcasts that carry content we authored: public and private
// channel messages, group messages, board posts, public files, live voice.
// Not applied to:
//
//   * Announces. The direct-peer rule in mesh-service identifies a directly
//     heard announce by `packet.ttl === ANNOUNCE_TTL`, and that rule is what
//     stops one hostile peer inventing hundreds of "directly connected"
//     identities immune to eviction.
//   * Directed traffic (DMs, handshakes, courier, sealed files). Relays never
//     clamp it, and fewer hops means fewer deliveries.
//   * Prekey bundles and gateway carriers. A bundle already names its owner,
//     and a carrier is a rebroadcast, not authorship.

import { secureRandom } from "../../crypto/secure-random";
import type { PacketType } from "../wire/packet-codec";
import { relayLimit } from "./flood-router";

// How many values below the ceiling the draw reaches.
const ORIGIN_TTL_SPREAD = 2;

export function originTtl(
  type: PacketType,
  degree: number,
  isUrgentBoard = false,
): number {
  const ceiling = relayLimit(type, isUrgentBoard, degree);
  return (
    ceiling -
    ORIGIN_TTL_SPREAD +
    Math.floor(secureRandom() * (ORIGIN_TTL_SPREAD + 1))
  );
}
