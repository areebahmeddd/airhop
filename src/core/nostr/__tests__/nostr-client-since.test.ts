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
    destroy(): void {}
  },
}));

const SINCE = 1_700_000_000;

// Closed after each test: a live client holds its connection poll open.
const clients: NostrClient[] = [];
function open(): NostrClient {
  const client = new NostrClient();
  clients.push(client);
  return client;
}

beforeEach(() => {
  mockFilters.length = 0;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

test("a reconnect cannot move a gift-wrap subscription's since", () => {
  open().subscribe(
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

test("a relay's reconnect does not move the caller's filter", () => {
  const channel: Filter = { kinds: [20000], since: SINCE };
  open().subscribe([channel], () => undefined);
  mockFilters[0].since = SINCE + 1_800;
  expect(channel.since).toBe(SINCE);
});
