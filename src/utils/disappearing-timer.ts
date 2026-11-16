// The words for a private chat's disappearing timer, by the four values the
// picker offers (dm-timer.ts). Whole sentences per value, as the General
// screen's confirmations are, since "1 day" inflects differently inside a
// sentence than on its own.

import type { TranslationKey } from "@i18n";

const DAY_MS = 24 * 60 * 60 * 1000;

const SET_BY_ME: Record<number, TranslationKey> = {
  1: "chat.timer.you_set_1",
  7: "chat.timer.you_set_7",
  30: "chat.timer.you_set_30",
};

const SET_HERE_ONLY: Record<number, TranslationKey> = {
  1: "chat.timer.you_set_local_1",
  7: "chat.timer.you_set_local_7",
  30: "chat.timer.you_set_local_30",
};

const SET_BY_PEER: Record<number, TranslationKey> = {
  1: "chat.timer.peer_set_1",
  7: "chat.timer.peer_set_7",
  30: "chat.timer.peer_set_30",
};

// The row a timer change leaves in the thread: whose it is, and for a chat
// whose other phone is known not to share timers, that it is ours alone. The
// peer's keys take `{name}`.
export function timerChangeKey(
  ms: number,
  setBy: "me" | "me-only" | "peer",
): TranslationKey {
  const off =
    setBy === "peer"
      ? "chat.timer.peer_off"
      : setBy === "me-only"
        ? "chat.timer.you_off_local"
        : "chat.timer.you_off";
  const days = Math.round(ms / DAY_MS);
  const set = {
    me: SET_BY_ME,
    "me-only": SET_HERE_ONLY,
    peer: SET_BY_PEER,
  }[setBy][days];
  return set ?? off;
}

export function timerDays(ms: number): number {
  return Math.round(ms / DAY_MS);
}
