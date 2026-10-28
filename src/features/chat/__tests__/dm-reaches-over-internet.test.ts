// The DM banner's internet claim: an address is not a route without a relay.
import { dmReachesOverInternet } from "../dm-reaches-over-internet";

const PEER = "aabbccdd00112233";
const NPUB = "ab".repeat(32);

describe("dmReachesOverInternet", () => {
  it("claims the internet for a contact with an npub while a relay is live", () => {
    expect(dmReachesOverInternet(PEER, NPUB, true)).toBe(true);
  });

  it("does not while every relay is down, whatever address we hold", () => {
    expect(dmReachesOverInternet(PEER, NPUB, false)).toBe(false);
    expect(dmReachesOverInternet(`nostr_${NPUB}`, undefined, false)).toBe(
      false,
    );
  });

  it("claims it for a Nostr-only correspondent while a relay is live", () => {
    expect(dmReachesOverInternet(`nostr_${NPUB}`, undefined, true)).toBe(true);
  });

  it("never for a contact with no npub", () => {
    expect(dmReachesOverInternet(PEER, undefined, true)).toBe(false);
    expect(dmReachesOverInternet(PEER, "", true)).toBe(false);
  });
});
