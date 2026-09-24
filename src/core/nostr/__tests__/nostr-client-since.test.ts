// A gift-wrap subscription keeps the `since` it was opened with.
//
// nostr-tools moves `since` to just past the newest `created_at` it delivered
// whenever a relay reconnects. Gift-wrap timestamps are blurred up to 15
// minutes either side of the send time, so that move could sit in the future
// and have relays withhold every newer DM.

import type { Filter } from "nostr-tools/filter";
import { NostrClient } from "../nostr-client";

const mockFilters: Filter[] = [];

jest.mock("nostr-tools/pool", () => ({
  SimplePool: class {
    onRelayConnectionSuccess?: () => void;
    onRelayConnectionFailure?: () => void;
    subscribeMany(_relays: string[], filter: Filter): { close: () => void } {
      mockFilters.push(filter);
      return { close: () => undefined };
    }
    listConnectionStatus(): Map<string, boolean> {
      return new Map();
    }
  },
}));

const SINCE = 1_700_000_000;

beforeEach(() => {
  mockFilters.length = 0;
});

test("a reconnect cannot move a gift-wrap subscription's since", () => {
  new NostrClient().subscribe(
    [{ kinds: [1059], "#p": ["ab"], since: SINCE }],
    () => undefined,
  );
  const [filter] = mockFilters;

  // What nostr-tools does to the filter object on a reconnect.
  filter.since = SINCE + 1_800;

  expect(filter.since).toBe(SINCE);
  expect(JSON.parse(JSON.stringify(filter))).toEqual({
    kinds: [1059],
    "#p": ["ab"],
    since: SINCE,
  });
});

test("other subscriptions are passed through untouched", () => {
  const channel: Filter = { kinds: [20000], since: SINCE };
  new NostrClient().subscribe([channel], () => undefined);
  expect(mockFilters[0]).toBe(channel);
});
