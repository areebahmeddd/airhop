// The timed rekey schedule. Pinned because both Airhop phones in a session
// must agree on it without talking, and bitchat-ios keeps the same clock.

import {
  REKEY_AT_MS,
  REKEY_CHECK_INTERVAL_MS,
  rekeyDue,
  SESSION_LIFETIME_MS,
} from "../session-rekey";

const HOUR = 60 * 60 * 1000;
const LOW = "0011223344556677";
const HIGH = "8899aabbccddeeff";

describe("session rekey schedule", () => {
  it("matches bitchat-ios: 24 h sessions, renewed at 90%, polled each minute", () => {
    expect(SESSION_LIFETIME_MS).toBe(24 * HOUR);
    expect(REKEY_AT_MS).toBe(21.6 * HOUR);
    expect(REKEY_CHECK_INTERVAL_MS).toBe(60_000);
  });

  // Exactly one side starts it, so two Airhop phones never cross.
  it("is due for the lower peer ID at 90%", () => {
    expect(rekeyDue(REKEY_AT_MS - 1, LOW, HIGH)).toBe(false);
    expect(rekeyDue(REKEY_AT_MS, LOW, HIGH)).toBe(true);
  });

  it("is due for the higher peer ID only at the full lifetime", () => {
    expect(rekeyDue(REKEY_AT_MS, HIGH, LOW)).toBe(false);
    expect(rekeyDue(SESSION_LIFETIME_MS - 1, HIGH, LOW)).toBe(false);
    expect(rekeyDue(SESSION_LIFETIME_MS, HIGH, LOW)).toBe(true);
  });
});
