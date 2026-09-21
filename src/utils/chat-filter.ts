// Which conversations a filter on the Chats screen keeps. Pure predicates
// over facts the caller holds, so both lists filter the same way and the rule
// is testable without a store.

export const DM_FILTERS = ["all", "unread", "verified", "nearby"] as const;
export type DmFilter = (typeof DM_FILTERS)[number];

export const CHANNEL_FILTERS = ["all", "unread", "private"] as const;
export type ChannelFilter = (typeof CHANNEL_FILTERS)[number];

export interface DmFilterFacts {
  unreadCount: (channel: string) => number;
  isVerified: (peerID: string) => boolean;
  isNearby: (peerID: string) => boolean;
}

export interface ChannelFilterFacts {
  unreadCount: (channel: string) => number;
  isPrivate: (channel: string) => boolean;
}

export function dmMatches(
  channel: string,
  filter: DmFilter,
  facts: DmFilterFacts,
): boolean {
  const peerID = channel.slice("dm:".length);
  switch (filter) {
    case "all":
      return true;
    case "unread":
      return facts.unreadCount(channel) > 0;
    case "verified":
      return facts.isVerified(peerID);
    case "nearby":
      return facts.isNearby(peerID);
  }
}

export function channelMatches(
  channel: string,
  filter: ChannelFilter,
  facts: ChannelFilterFacts,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "unread":
      return facts.unreadCount(channel) > 0;
    case "private":
      return facts.isPrivate(channel);
  }
}
