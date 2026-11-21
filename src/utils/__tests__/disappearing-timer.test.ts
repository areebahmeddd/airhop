// The row a timer change leaves: whose it is, and whether it reached the
// other phone at all.

import { timerChangeKey, timerDays } from "../disappearing-timer";

const DAY = 24 * 60 * 60 * 1000;

describe("timerChangeKey", () => {
  test("names who set it, for each of the four choices", () => {
    expect(timerChangeKey(7 * DAY, "me")).toBe("chat.timer.you_set_7");
    expect(timerChangeKey(DAY, "peer")).toBe("chat.timer.peer_set_1");
    expect(timerChangeKey(0, "me")).toBe("chat.timer.you_off");
    expect(timerChangeKey(0, "peer")).toBe("chat.timer.peer_off");
  });

  // A bitchat peer never hears of it, and the row must not suggest it did.
  test("says so when the change stays on this phone", () => {
    expect(timerChangeKey(30 * DAY, "me-only")).toBe(
      "chat.timer.you_set_local_30",
    );
    expect(timerChangeKey(0, "me-only")).toBe("chat.timer.you_off_local");
  });
});

test("timerDays reads a timer in whole days", () => {
  expect(timerDays(7 * DAY)).toBe(7);
  expect(timerDays(0)).toBe(0);
});
