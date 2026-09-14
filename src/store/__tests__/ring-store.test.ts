/**
 * @jest-environment node
 */
// Ring: rate limiting and snooze state. Covers what
// notification-policy.shouldAllowRing depends on: the sender's own
// "still ringing" window, an active snooze, the receive-side cooldown clock.

import { RING_SENDER_TIMEOUT_MS, useRingStore } from "../ring-store";

beforeEach(() => {
  useRingStore.getState().clearAll();
});

function state() {
  return useRingStore.getState();
}

describe("isSending", () => {
  it("is false for a peer never rung", () => {
    expect(state().isSending("p1", 1_000)).toBe(false);
  });

  it("is true right after sending, before any ack", () => {
    state().recordSent("p1", 1_000);
    expect(state().isSending("p1", 1_000)).toBe(true);
  });

  it("clears once the ring is acknowledged", () => {
    state().recordSent("p1", 1_000);
    state().recordAcked("p1", 1_500);
    expect(state().isSending("p1", 1_500)).toBe(false);
  });

  it("clears once the sender-side timeout passes with no ack", () => {
    state().recordSent("p1", 1_000);
    expect(state().isSending("p1", 1_000 + RING_SENDER_TIMEOUT_MS)).toBe(false);
  });

  it("does not confuse an ack for a different, earlier ring", () => {
    // Ack for a ring sent before this one must not mask the new one as answered.
    state().recordAcked("p1", 500);
    state().recordSent("p1", 1_000);
    expect(state().isSending("p1", 1_000)).toBe(true);
  });

  it("tracks each peer independently", () => {
    state().recordSent("p1", 1_000);
    expect(state().isSending("p2", 1_000)).toBe(false);
  });
});

describe("isSnoozed", () => {
  it("is false with no snooze set", () => {
    expect(state().isSnoozed("p1", 1_000)).toBe(false);
  });

  it("is true before the snooze expires", () => {
    state().snooze("p1", 2_000);
    expect(state().isSnoozed("p1", 1_500)).toBe(true);
  });

  it("is false once the snooze has passed", () => {
    state().snooze("p1", 2_000);
    expect(state().isSnoozed("p1", 2_000)).toBe(false);
  });

  it("clearSnooze lifts it immediately", () => {
    state().snooze("p1", 2_000);
    state().clearSnooze("p1");
    expect(state().isSnoozed("p1", 1_500)).toBe(false);
  });
});

describe("msSinceLastReceived", () => {
  it("is null for a peer that has never rung us", () => {
    expect(state().msSinceLastReceived("p1", 1_000)).toBeNull();
  });

  it("reports elapsed time since the last accepted ring", () => {
    state().recordReceived("p1", 1_000);
    expect(state().msSinceLastReceived("p1", 1_800)).toBe(800);
  });
});

describe("clearAll", () => {
  it("resets every peer's state at once, for the panic wipe", () => {
    state().recordSent("p1", 1_000);
    state().recordReceived("p2", 1_000);
    state().snooze("p3", 5_000);
    state().clearAll();
    expect(state().isSending("p1", 1_000)).toBe(false);
    expect(state().msSinceLastReceived("p2", 1_000)).toBeNull();
    expect(state().isSnoozed("p3", 1_000)).toBe(false);
  });
});
