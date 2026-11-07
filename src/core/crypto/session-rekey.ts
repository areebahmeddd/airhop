// When a live Noise session is replaced by a fresh handshake, and how long the
// one it replaced keeps decrypting.
//
// bitchat-ios expires a session at 24 hours of age and starts a new handshake
// at 90% of that, polled once a minute (SecureNoiseSession.needsRenegotiation).
// Airhop keeps the same clock so a session with either client rotates on the
// same schedule, and a leaked transport key reads at most a day of traffic.
//
// Only one side starts the timed handshake. Two Airhop phones reach 90% within
// milliseconds of each other, and two crossed initiations cost a tiebreak and
// a wasted round trip every day, so the lower peer ID starts it, the same order
// the crossed-initiation tiebreak keeps. The higher side starts one only if the
// session reaches the full 24 hours, which means the lower side's attempt
// never landed. A bitchat peer starts its own at 90% whatever the order, and
// the tiebreak settles the rare crossing.

export const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const REKEY_AT_MS = SESSION_LIFETIME_MS * 0.9;
export const REKEY_CHECK_INTERVAL_MS = 60_000;

// How long a replaced session, and the ratchet bound to it, keeps decrypting.
// The far side may still be sending under it (it has not read our msg3, or a
// packet was relayed the long way round), and a straggler that decrypts under
// nothing is lost with no error on either phone. Receive only: nothing new is
// ever sealed under a held session.
export const HELD_SESSION_GRACE_MS = 60_000;

// How long the initiator of a timed rekey keeps sending under the old session
// while it waits for the responder's 0x21 under the new one, the proof its
// msg3 landed. Anything sealed under the new session before then is lost if
// msg3 was. bitchat sends 0x21 on completion too, so the wait is normally one
// round trip; this bounds it when the proof itself is lost.
export const REKEY_SWITCH_TIMEOUT_MS = 5_000;

// How long a first session we completed as initiator holds its queue for the
// peer's 0x21, which seeds the ratchet a long DM rides, before releasing it
// under plain Noise. Also one round trip, but a separate bound: a proof lost
// here costs that DM its ratchet, not a session, so it may be tuned apart.
export const FIRST_PROOF_TIMEOUT_MS = 5_000;

// Whether this side should start a timed rekey of a session `ageMs` old.
export function rekeyDue(
  ageMs: number,
  ourPeerID: string,
  theirPeerID: string,
): boolean {
  const threshold = ourPeerID < theirPeerID ? REKEY_AT_MS : SESSION_LIFETIME_MS;
  return ageMs >= threshold;
}
