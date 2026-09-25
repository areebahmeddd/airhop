/**
 * @jest-environment node
 */
import { HandshakeRateLimiter } from "../handshake-rate-limiter";

describe("HandshakeRateLimiter", () => {
  test("10 per peer per minute, bitchat-ios's number", () => {
    const l = new HandshakeRateLimiter();
    for (let i = 0; i < 10; i++) expect(l.allow("p", i)).toBe(true);
    expect(l.allow("p", 11)).toBe(false);
    expect(l.allowInboundInitiation("p", 12)).toBe(false);
    expect(l.allow("p", 60_001)).toBe(true);
  });

  test("inbound msg1 share a global 30 per minute", () => {
    const l = new HandshakeRateLimiter();
    for (let i = 0; i < 30; i++) {
      expect(l.allowInboundInitiation(`forged-${i}`, i)).toBe(true);
    }
    expect(l.allowInboundInitiation("genuine", 31)).toBe(false);
    expect(l.allowInboundInitiation("genuine", 60_001)).toBe(true);
  });

  test("our own initiations and continuations never meet the global bucket", () => {
    const l = new HandshakeRateLimiter();
    for (let i = 0; i < 30; i++) l.allowInboundInitiation(`forged-${i}`, i);
    expect(l.allow("friend", 40)).toBe(true);
  });

  test("a refusal by the peer bucket spends none of the global one", () => {
    const l = new HandshakeRateLimiter();
    for (let i = 0; i < 10; i++) l.allow("noisy", i);
    for (let i = 0; i < 50; i++) l.allowInboundInitiation("noisy", 20 + i);
    for (let i = 0; i < 30; i++) {
      expect(l.allowInboundInitiation(`peer-${i}`, 100 + i)).toBe(true);
    }
  });
});
