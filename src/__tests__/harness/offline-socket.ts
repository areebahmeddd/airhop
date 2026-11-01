// A WebSocket that never connects.
//
// For the lifecycle tests, and for a simulated phone with no relay fabric.
// Starting the mesh also builds the Nostr transport, and nostr-tools'
// SimplePool will happily open real sockets to relay.damus.io and friends from
// inside CI. That is wrong on four counts: a test must not depend on the
// internet, the connections outlive the test (Jest reported 32 open handles and
// force-killed the worker), a relay being slow would make an unrelated
// assertion flake, and on Node 22 a refused one kills the worker outright
// (nostr-tools closes the socket from its error handler, and that WebSocket
// fires the error again from close, until the stack runs out).
//
// Swapping the implementation rather than disabling the internet setting keeps
// the code path honest: buildNostrTransport still runs, the pool is still
// created, reconnect logic still schedules, and the sockets simply fail to
// open, which is exactly what a phone with no signal sees.

import { useWebSocketImplementation } from "nostr-tools/pool";

export class OfflineWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = OfflineWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;

  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(readonly url: string) {
    // Fail asynchronously, as a real connection failure does. The timer is
    // unref'd where the runtime supports it so it can never be the thing
    // keeping the process alive.
    this.timer = setTimeout(() => {
      this.readyState = OfflineWebSocket.CLOSED;
      this.onerror?.();
      this.onclose?.({ code: 1006, reason: "no network in tests" });
    }, 1);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  send(): void {
    /* nothing is connected */
  }

  close(): void {
    clearTimeout(this.timer);
    this.readyState = OfflineWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "" });
  }
}

// Call once at the top of a lifecycle test file.
export function installOfflineWebSocket(): void {
  // Not a React hook. `useWebSocketImplementation` is nostr-tools' socket
  // injection point and merely starts with "use", which is all the lint rule
  // matches on.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useWebSocketImplementation(OfflineWebSocket);
}
