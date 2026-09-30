// A relay subscription nostr-tools closes is reopened, not lost.
//
// nostr-tools drops a relay whose first connect fails along with every
// subscription on it; its reconnect covers only sockets that opened once. Left
// alone, that relay's inbox stays deaf while the banner reads connected.

import type { Filter } from "nostr-tools/filter";
import { NostrClient } from "../nostr-client";

interface MockSub {
  relay: string;
  onclose?: () => void;
  closed: boolean;
}

const mockSubs: MockSub[] = [];

jest.mock("nostr-tools/pool", () => ({
  SimplePool: class {
    onRelayConnectionSuccess?: () => void;
    onRelayConnectionFailure?: () => void;
    subscribeMany(
      relays: string[],
      _filter: Filter,
      params: { onclose?: () => void },
    ): { close: () => void } {
      const sub: MockSub = {
        relay: relays[0],
        onclose: params.onclose,
        closed: false,
      };
      mockSubs.push(sub);
      return {
        close: () => {
          sub.closed = true;
          sub.onclose?.();
        },
      };
    }
    listConnectionStatus(): Map<string, boolean> {
      return new Map();
    }
    destroy(): void {}
  },
}));

const RELAY = "wss://relay.example";

beforeEach(() => {
  jest.useFakeTimers();
  mockSubs.length = 0;
});

afterEach(() => {
  jest.useRealTimers();
});

test("reopens a relay's subscription after the relay drops it", () => {
  const client = new NostrClient();
  client.subscribe([{ kinds: [1059] }], () => undefined, undefined, [RELAY]);
  expect(mockSubs).toHaveLength(1);

  mockSubs[0].onclose?.();
  jest.advanceTimersByTime(15_000);
  expect(mockSubs).toHaveLength(2);
  expect(mockSubs[1].relay).toBe(RELAY);
  client.close();
});

test("stays closed once the caller or the client closes", () => {
  const client = new NostrClient();
  const sub = client.subscribe(
    [{ kinds: [1059] }],
    () => undefined,
    undefined,
    [RELAY],
  );
  sub.close();
  jest.advanceTimersByTime(10 * 60_000);
  expect(mockSubs).toHaveLength(1);

  client.subscribe([{ kinds: [1059] }], () => undefined, undefined, [RELAY]);
  mockSubs[1].onclose?.();
  client.close();
  jest.advanceTimersByTime(10 * 60_000);
  expect(mockSubs).toHaveLength(2);
});
