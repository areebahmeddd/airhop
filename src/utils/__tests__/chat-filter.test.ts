/**
 * @jest-environment node
 */
// A filter keeps exactly the conversations it names.

import { channelMatches, dmMatches } from "../chat-filter";

const facts = {
  unreadCount: (channel: string) => (channel.endsWith("unread") ? 2 : 0),
  isVerified: (peerID: string) => peerID === "verified",
  isNearby: (peerID: string) => peerID === "nearby",
};

describe("dmMatches", () => {
  it("keeps everything under all", () => {
    expect(dmMatches("dm:anyone", "all", facts)).toBe(true);
  });

  it("keeps only unread conversations under unread", () => {
    expect(dmMatches("dm:unread", "unread", facts)).toBe(true);
    expect(dmMatches("dm:read", "unread", facts)).toBe(false);
  });

  it("keeps only verified contacts under verified", () => {
    expect(dmMatches("dm:verified", "verified", facts)).toBe(true);
    expect(dmMatches("dm:stranger", "verified", facts)).toBe(false);
  });

  it("keeps only reachable peers under nearby", () => {
    expect(dmMatches("dm:nearby", "nearby", facts)).toBe(true);
    expect(dmMatches("dm:away", "nearby", facts)).toBe(false);
  });
});

describe("channelMatches", () => {
  const channelFacts = {
    unreadCount: facts.unreadCount,
    isPrivate: (channel: string) =>
      channel.startsWith("group:") || channel === "#keyed",
  };

  it("keeps everything under all", () => {
    expect(channelMatches("#public", "all", channelFacts)).toBe(true);
  });

  it("keeps only unread channels under unread", () => {
    expect(channelMatches("#unread", "unread", channelFacts)).toBe(true);
    expect(channelMatches("#public", "unread", channelFacts)).toBe(false);
  });

  it("keeps groups and keyed rooms under private", () => {
    expect(channelMatches("group:abc", "private", channelFacts)).toBe(true);
    expect(channelMatches("#keyed", "private", channelFacts)).toBe(true);
    expect(channelMatches("#public", "private", channelFacts)).toBe(false);
  });
});
