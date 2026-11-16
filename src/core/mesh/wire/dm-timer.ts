// The disappearing timer a DM carries between Airhop phones, as TLVs appended
// to its PrivateMessagePacket (noise-payload.ts) and to a ratchet MESSAGE's
// extension block (dm-payload.ts).
//
//   0x50  timer    u32 BE seconds the message disappears after, 0 for never
//   0x51  set at   u64 BE milliseconds: this message changes the chat's timer
//                  rather than carrying words, and the change dates from here
//
// Airhop-only and sent only to a peer proven to run Airhop, so bitchat, which
// refuses an unknown TLV, never reads one. A value outside the four the picker offers (a later version's
// choice) is read as the longest offered one not above it, and never as less
// than a day, so no peer can make a copy here vanish within the minute and no
// message is refused for its timer.

const DAY_MS = 24 * 60 * 60 * 1000;

// The four choices, here and in General (settings-store's
// MESSAGE_RETENTION_DAY_OPTIONS is this list), so the picker never offers a
// value the wire refuses.
export const DISAPPEARING_TIMER_DAYS = [0, 1, 7, 30] as const;

export const TLV_DM_TIMER = 0x50;
export const TLV_DM_TIMER_SET_AT = 0x51;

export interface DmTimer {
  // How long the message stays, 0 for as long as the chat is kept.
  ms: number;
  // Present on a timer change, which carries no words.
  setAtMs?: number;
}

export function isTimerMs(ms: number): boolean {
  return DISAPPEARING_TIMER_DAYS.some((days) => days * DAY_MS === ms);
}

function offeredTimerMs(ms: number): number {
  if (ms === 0) return 0;
  const below = DISAPPEARING_TIMER_DAYS.filter(
    (days) => days > 0 && days * DAY_MS <= ms,
  );
  return (below.at(-1) ?? DISAPPEARING_TIMER_DAYS[1]) * DAY_MS;
}

// The TLVs for a timer, appended after a message's own.
export function encodeDmTimer(timer: DmTimer): number[] {
  const seconds = timer.ms / 1000;
  const out = [
    TLV_DM_TIMER,
    4,
    (seconds >>> 24) & 0xff,
    (seconds >>> 16) & 0xff,
    (seconds >>> 8) & 0xff,
    seconds & 0xff,
  ];
  if (timer.setAtMs !== undefined) {
    const high = Math.floor(timer.setAtMs / 2 ** 32);
    const low = timer.setAtMs % 2 ** 32;
    out.push(TLV_DM_TIMER_SET_AT, 8);
    for (const word of [high, low]) {
      out.push(
        (word >>> 24) & 0xff,
        (word >>> 16) & 0xff,
        (word >>> 8) & 0xff,
        word & 0xff,
      );
    }
  }
  return out;
}

// Folds one TLV into `timer`. False for a malformed one, which refuses the
// whole message, as an unknown TLV does.
export function readDmTimerTlv(
  type: number,
  value: Uint8Array,
  timer: Partial<DmTimer>,
): boolean {
  if (type === TLV_DM_TIMER && value.length === 4) {
    const seconds =
      ((value[0] << 24) | (value[1] << 16) | (value[2] << 8) | value[3]) >>> 0;
    timer.ms = offeredTimerMs(seconds * 1000);
    return true;
  }
  if (type === TLV_DM_TIMER_SET_AT && value.length === 8) {
    const view = new DataView(value.buffer, value.byteOffset, 8);
    timer.setAtMs = view.getUint32(0) * 2 ** 32 + view.getUint32(4);
    return Number.isSafeInteger(timer.setAtMs);
  }
  return false;
}

// A timer from its TLVs, or undefined when none came. One that sets the chat's
// timer must say what to.
export function completeDmTimer(
  timer: Partial<DmTimer>,
): DmTimer | undefined | null {
  if (timer.ms === undefined)
    return timer.setAtMs === undefined ? undefined : null;
  return timer.setAtMs === undefined
    ? { ms: timer.ms }
    : { ms: timer.ms, setAtMs: timer.setAtMs };
}
