// NostrClient's connectivity tracks the relay sockets, not the pool's hooks.
//
// nostr-tools calls onRelayConnectionSuccess / onRelayConnectionFailure only on
// a connect attempt it was asked for (a subscribe, publish or count). A live
// socket that drops goes through the relay's own hard-close path, which calls
// neither, and the relay's automatic reconnect calls neither either. The pool's
// per-relay `connected` (listConnectionStatus) is the socket state, so these
// flip that map with no hook call and assert the client notices.

import { NostrClient } from "../nostr-client";

const mockStatus = new Map<string, boolean>();

jest.mock("nostr-tools/pool", () => ({
  SimplePool: class {
    onRelayConnectionSuccess?: () => void;
    onRelayConnectionFailure?: () => void;
    listConnectionStatus(): Map<string, boolean> {
      return new Map(mockStatus);
    }
    destroy(): void {}
  },
}));

let client: NostrClient | null = null;

beforeEach(() => {
  jest.useFakeTimers();
  mockStatus.clear();
});

afterEach(() => {
  client?.close();
  client = null;
  jest.useRealTimers();
});

test("isConnected reads the sockets, so a dropped relay reads offline at once", () => {
  const c = (client = new NostrClient());
  mockStatus.set("wss://a", true);
  expect(c.isConnected).toBe(true);
  // The socket closes under us: no pool hook runs.
  mockStatus.set("wss://a", false);
  expect(c.isConnected).toBe(false);
});

test("a drop and a self-reconnect each reach onConnectionChange", () => {
  const changes: boolean[] = [];
  client = new NostrClient({ onConnectionChange: (c) => changes.push(c) });
  mockStatus.set("wss://a", true);
  jest.advanceTimersByTime(10_000);
  expect(changes).toEqual([true]);

  mockStatus.set("wss://a", false);
  jest.advanceTimersByTime(10_000);
  expect(changes).toEqual([true, false]);

  mockStatus.set("wss://a", true);
  jest.advanceTimersByTime(10_000);
  expect(changes).toEqual([true, false, true]);
});

test("a closed client reports nothing further", () => {
  const changes: boolean[] = [];
  const c = new NostrClient({ onConnectionChange: (v) => changes.push(v) });
  c.close();
  mockStatus.set("wss://a", true);
  jest.advanceTimersByTime(60_000);
  expect(changes).toEqual([]);
});
