// How many Noise handshake messages this node processes or starts, per claimed
// peer and in total. The numbers are bitchat-ios's (NoiseSecurityConstants:
// 10 per peer and 30 globally, per minute).
//
// Where the global bucket applies differs on purpose. bitchat-ios counts every
// handshake message in it, so 30 forged msg1 a minute also starve our own
// initiations and the msg2/msg3 that complete them. Here it counts inbound msg1
// only: the one message that is unauthenticated, creates state and floods a
// reply. Everything else is bounded per peer, and a continuation is only
// processed against a handshake this node already holds.
import { SlidingWindowLimiter } from "./sliding-window-limiter";

const WINDOW_MS = 60_000;
const MAX_PER_PEER = 10;
const MAX_INBOUND_INITIATIONS = 30;
const GLOBAL_KEY = "";

export class HandshakeRateLimiter {
  private readonly perPeer = new SlidingWindowLimiter(MAX_PER_PEER, WINDOW_MS);
  private readonly initiations = new SlidingWindowLimiter(
    MAX_INBOUND_INITIATIONS,
    WINDOW_MS,
  );

  // An inbound msg1. Checks both buckets before recording either, so a
  // refusal by one never spends the other.
  allowInboundInitiation(peerID: string, now: number): boolean {
    if (!this.initiations.allows(GLOBAL_KEY, now)) return false;
    if (!this.perPeer.allows(peerID, now)) return false;
    this.initiations.record(GLOBAL_KEY, now);
    this.perPeer.record(peerID, now);
    return true;
  }

  // Our own msg1, or an inbound msg2/msg3 for a handshake we hold.
  allow(peerID: string, now: number): boolean {
    return this.perPeer.tryAcquire(peerID, now);
  }
}
