// RelayWebSocket against a scripted native module: the WebSocket surface
// nostr-tools' AbstractRelay drives, and the route each socket dials.

let mockListener: ((event: Record<string, unknown>) => void) | null = null;
const mockRemove = jest.fn();
const mockConnect = jest.fn<void, [string, string, boolean]>();
const mockSend = jest.fn<void, [string, string]>();
const mockClose = jest.fn<void, [string, number, string]>();

jest.mock("@bridge/NativeAirhopRelaySocket", () => ({
  __esModule: true,
  AirhopRelaySocketNative: {
    connect: (id: string, url: string, viaTor: boolean) =>
      mockConnect(id, url, viaTor),
    send: (id: string, data: string) => mockSend(id, data),
    close: (id: string, code: number, reason: string) =>
      mockClose(id, code, reason),
  },
  subscribeRelaySocket: (fn: (event: Record<string, unknown>) => void) => {
    mockListener = fn;
    return { remove: mockRemove };
  },
}));

import { RelayWebSocket, setRelaySocketRoute } from "../relay-websocket";

function open(url = "wss://relay.example"): { ws: RelayWebSocket; id: string } {
  const ws = new RelayWebSocket(url);
  return { ws, id: mockConnect.mock.calls.at(-1)![0] };
}

function emit(event: Record<string, unknown>): void {
  mockListener?.(event);
}

beforeEach(() => {
  jest.clearAllMocks();
  setRelaySocketRoute(false);
});

describe("RelayWebSocket", () => {
  it("dials the route set when it is constructed", () => {
    open();
    setRelaySocketRoute(true);
    open();

    expect(mockConnect.mock.calls.map((c) => c[2])).toEqual([false, true]);
  });

  it("gives every socket its own id", () => {
    const a = open().id;
    const b = open().id;

    expect(a).not.toBe(b);
  });

  it("holds frames sent before open and flushes them in order", () => {
    const { ws, id } = open();
    const onopen = jest.fn();
    ws.onopen = onopen;

    ws.send("a");
    ws.send("b");
    expect(mockSend).not.toHaveBeenCalled();

    emit({ id, type: "open" });

    expect(ws.readyState).toBe(RelayWebSocket.OPEN);
    expect(mockSend.mock.calls).toEqual([
      [id, "a"],
      [id, "b"],
    ]);
    expect(onopen).toHaveBeenCalledTimes(1);
  });

  it("delivers a message as a MessageEvent, and ignores other sockets' events", () => {
    const { ws, id } = open();
    const onmessage = jest.fn();
    ws.onmessage = onmessage;

    emit({ id: "someone-else", type: "message", data: "x" });
    emit({ id, type: "message", data: '["EOSE","s"]' });

    expect(onmessage).toHaveBeenCalledTimes(1);
    expect(onmessage).toHaveBeenCalledWith({ data: '["EOSE","s"]' });
  });

  it("reports an error, then a close that ends the socket", () => {
    const { ws, id } = open();
    const onerror = jest.fn();
    const onclose = jest.fn();
    ws.onerror = onerror;
    ws.onclose = onclose;

    emit({ id, type: "error", message: "receive failed" });
    emit({ id, type: "close", code: 1006, reason: "receive failed" });

    expect(onerror).toHaveBeenCalledWith({
      type: "error",
      message: "receive failed",
    });
    expect(onclose).toHaveBeenCalledWith({
      code: 1006,
      reason: "receive failed",
    });
    expect(ws.readyState).toBe(RelayWebSocket.CLOSED);
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it("defaults a close that carries no code to abnormal", () => {
    const { ws, id } = open();
    const onclose = jest.fn();
    ws.onclose = onclose;

    emit({ id, type: "close" });

    expect(onclose).toHaveBeenCalledWith({ code: 1006, reason: "" });
  });

  it("asks native to close once, and drops sends after it", () => {
    const { ws, id } = open();
    emit({ id, type: "open" });

    ws.close();
    ws.close(4000, "again");
    ws.send("late");

    expect(ws.readyState).toBe(RelayWebSocket.CLOSING);
    expect(mockClose.mock.calls).toEqual([[id, 1000, ""]]);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
