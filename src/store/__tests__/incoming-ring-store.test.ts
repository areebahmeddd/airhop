/**
 * @jest-environment node
 */
// The overlay's queue: one ring at a time, the rest waiting behind it with
// their own windows, and every way one leaves.

import {
  useIncomingRingStore,
  type IncomingRing,
} from "../incoming-ring-store";
import { RING_ALERT_DURATION_MS } from "../ring-store";

const ring = (peerID: string, receivedAtMs: number): IncomingRing => ({
  peerID,
  ringID: `${peerID}-${String(receivedAtMs)}`,
  senderName: peerID,
  receivedAtMs,
});

function state() {
  return useIncomingRingStore.getState();
}

beforeEach(() => {
  state().clearAll();
  jest.useFakeTimers();
  jest.setSystemTime(100_000);
});

afterEach(() => {
  jest.useRealTimers();
});

describe("show", () => {
  it("rings the first arrival at once", () => {
    state().show(ring("alice", 100_000));
    expect(state().current?.peerID).toBe("alice");
    expect(state().queue).toEqual([]);
  });

  it("queues a second person behind the first", () => {
    state().show(ring("alice", 100_000));
    state().show(ring("bob", 101_000));
    expect(state().current?.peerID).toBe("alice");
    expect(state().queue.map((r) => r.peerID)).toEqual(["bob"]);
  });

  it("lets a repeat from the person already ringing stand in, not stack", () => {
    state().show(ring("alice", 100_000));
    state().show(ring("alice", 102_000));
    expect(state().current?.receivedAtMs).toBe(102_000);
    expect(state().queue).toEqual([]);
  });

  it("keeps one queued ring per person", () => {
    state().show(ring("alice", 100_000));
    state().show(ring("bob", 101_000));
    state().show(ring("bob", 103_000));
    expect(state().queue.map((r) => r.receivedAtMs)).toEqual([103_000]);
  });
});

describe("dismiss", () => {
  it("moves on to the next person still inside their window", () => {
    state().show(ring("alice", 100_000));
    state().show(ring("bob", 101_000));
    state().dismiss();
    expect(state().current?.peerID).toBe("bob");
    expect(state().queue).toEqual([]);
  });

  it("drops a queued ring whose window passed while it waited", () => {
    state().show(ring("alice", 100_000));
    state().show(ring("bob", 101_000));
    state().show(ring("carol", 140_000));
    jest.setSystemTime(101_000 + RING_ALERT_DURATION_MS);
    state().dismiss();
    expect(state().current?.peerID).toBe("carol");
  });

  it("falls silent with nobody waiting", () => {
    state().show(ring("alice", 100_000));
    state().dismiss();
    expect(state().current).toBeNull();
  });
});

describe("removeFor", () => {
  it("takes a waiting person out without touching the ring in progress", () => {
    state().show(ring("alice", 100_000));
    state().show(ring("bob", 101_000));
    state().removeFor("bob");
    expect(state().current?.peerID).toBe("alice");
    expect(state().queue).toEqual([]);
  });

  it("advances when it is the ring in progress that was answered elsewhere", () => {
    state().show(ring("alice", 100_000));
    state().show(ring("bob", 101_000));
    state().removeFor("alice");
    expect(state().current?.peerID).toBe("bob");
  });

  it("changes nothing for somebody not ringing", () => {
    state().show(ring("alice", 100_000));
    const before = state().queue;
    state().removeFor("nobody");
    expect(state().current?.peerID).toBe("alice");
    expect(state().queue).toBe(before);
  });
});

describe("clearAll", () => {
  it("empties everything, for the panic wipe", () => {
    state().show(ring("alice", 100_000));
    state().show(ring("bob", 101_000));
    state().clearAll();
    expect(state().current).toBeNull();
    expect(state().queue).toEqual([]);
  });
});
