// What a reconnect may write into a subscription's `since`.
//
// nostr-tools moves `since` to just past the newest `created_at` it received
// whenever a relay reconnects. A validly signed event dated years ahead would
// then have that relay withhold every real event, so the write is bounded to
// 15 minutes behind the newer of now and the event. Gift-wrap timestamps are
// blurred up to 15 minutes either side of the send time, so a gift-wrap
// subscription keeps the `since` it was opened with.

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

describe("a reconnect after a far-future event", () => {
  const NOW = SINCE + 86_400;
  const SKEW = 15 * 60;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW * 1000);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("moves since no later than 15 minutes before now", () => {
    open().subscribe([{ kinds: [20000], since: SINCE }], () => undefined);
    const [filter] = mockFilters;

    filter.since = NOW + 10 * 365 * 86_400;

    expect(filter.since).toBe(NOW - SKEW);
  });

  test("keeps 15 minutes behind an ordinary event, never before the requested since", () => {
    open().subscribe([{ kinds: [20000], since: SINCE }], () => undefined);
    const [filter] = mockFilters;

    filter.since = NOW - 60;
    expect(filter.since).toBe(NOW - 60 - SKEW);

    filter.since = SINCE + 1;
    expect(filter.since).toBe(SINCE);
  });

  test("bounds a filter opened without a since too", () => {
    open().subscribe([{ kinds: [1] }], () => undefined);
    const [filter] = mockFilters;
    expect(JSON.parse(JSON.stringify(filter))).toEqual({ kinds: [1] });

    filter.since = NOW + 3_600;

    expect(filter.since).toBe(NOW - SKEW);
  });
});

test("a relay's reconnect does not move the caller's filter", () => {
  const channel: Filter = { kinds: [20000], since: SINCE };
  open().subscribe([channel], () => undefined);
  mockFilters[0].since = SINCE + 1_800;
  expect(channel.since).toBe(SINCE);
});
