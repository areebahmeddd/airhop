/**
 * @jest-environment node
 */
// Ring: rate limiting and snooze state. Covers what
// notification-policy.ringRefusal depends on (an active snooze, the
// receive-side cooldown clock) and what the contact sheet reads back on the
// sender's side: the "still ringing" window, the local cooldown, and the last
// refusal.

import { RingRefusalReason } from "@core/mesh/wire/ring-payload";
import {
  RING_ALERT_DURATION_MS,
  RING_COOLDOWN_MS,
  useRingStore,
} from "../ring-store";

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

  it("clears once the other phone has stopped ringing, with no ack", () => {
    state().recordSent("p1", 1_000);
    expect(state().isSending("p1", 1_000 + RING_ALERT_DURATION_MS)).toBe(false);
  });

  it("clears the moment the receiver refuses", () => {
    state().recordSent("p1", 1_000);
    state().recordRefused("p1", RingRefusalReason.SNOOZED, 1_200);
    expect(state().isSending("p1", 1_200)).toBe(false);
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

describe("cooldownRemainingMs", () => {
  it("is zero for a peer never rung", () => {
    expect(state().cooldownRemainingMs("p1", 1_000)).toBe(0);
  });

  it("counts down from the send, and reaches zero", () => {
    state().recordSent("p1", 1_000);
    expect(state().cooldownRemainingMs("p1", 1_000)).toBe(RING_COOLDOWN_MS);
    expect(state().cooldownRemainingMs("p1", 1_000 + RING_COOLDOWN_MS)).toBe(0);
  });

  it("keeps running after an ack: seen is not an invitation to ring again", () => {
    state().recordSent("p1", 1_000);
    state().recordAcked("p1", 1_500);
    expect(state().cooldownRemainingMs("p1", 2_000)).toBeGreaterThan(0);
  });

  it("keeps running after a refusal too", () => {
    state().recordSent("p1", 1_000);
    state().recordRefused("p1", RingRefusalReason.COOLDOWN, 1_500);
    expect(state().cooldownRemainingMs("p1", 2_000)).toBeGreaterThan(0);
  });
});

describe("lastRefusal", () => {
  it("is null with nothing refused", () => {
    state().recordSent("p1", 1_000);
    expect(state().lastRefusal("p1")).toBeNull();
  });

  it("reports the reason for the ring just sent", () => {
    state().recordSent("p1", 1_000);
    state().recordRefused("p1", RingRefusalReason.NOT_ALLOWED, 1_100);
    expect(state().lastRefusal("p1")).toBe(RingRefusalReason.NOT_ALLOWED);
  });

  it("forgets a refusal once a newer ring goes out", () => {
    state().recordSent("p1", 1_000);
    state().recordRefused("p1", RingRefusalReason.SNOOZED, 1_100);
    state().recordSent("p1", 2_000);
    expect(state().lastRefusal("p1")).toBeNull();
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
    state().recordRefused("p1", RingRefusalReason.SNOOZED, 1_100);
    state().recordReceived("p2", 1_000);
    state().snooze("p3", 5_000);
    state().clearAll();
    expect(state().isSending("p1", 1_000)).toBe(false);
    expect(state().cooldownRemainingMs("p1", 1_000)).toBe(0);
    expect(state().lastRefusal("p1")).toBeNull();
    expect(state().msSinceLastReceived("p2", 1_000)).toBeNull();
    expect(state().isSnoozed("p3", 1_000)).toBe(false);
  });
});
