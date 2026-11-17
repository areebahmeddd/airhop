// The disappearing timer an Airhop DM carries: one TLV pair on the
// PrivateMessagePacket every route uses, and the same pair inside a ratchet
// message. Refused whole when malformed; a value off the four choices is read
// as the longest choice not above it, and never as less than a day.

import { decodeDmPayload, DmPayloadType, encodeDmMessage } from "../dm-payload";
import {
  encodeDmTimer,
  isTimerMs,
  TLV_DM_TIMER,
  TLV_DM_TIMER_SET_AT,
} from "../dm-timer";
import {
  decodePrivateMessagePacket,
  encodePrivateMessagePacket,
} from "../noise-payload";

const DAY = 24 * 60 * 60 * 1000;

describe("the DM timer TLVs", () => {
  test("only the four choices are timers", () => {
    for (const days of [0, 1, 7, 30]) expect(isTimerMs(days * DAY)).toBe(true);
    for (const ms of [1, 60_000, 2 * DAY, 31 * DAY]) {
      expect(isTimerMs(ms)).toBe(false);
    }
  });

  test("a message's timer, and a change's time, byte for byte", () => {
    expect(encodeDmTimer({ ms: DAY })).toEqual([
      TLV_DM_TIMER,
      4,
      0x00,
      0x01,
      0x51,
      0x80,
    ]);
    expect(encodeDmTimer({ ms: 0, setAtMs: 0x0102_0304_0506 })).toEqual([
      TLV_DM_TIMER,
      4,
      0,
      0,
      0,
      0,
      TLV_DM_TIMER_SET_AT,
      8,
      0x00,
      0x00,
      0x01,
      0x02,
      0x03,
      0x04,
      0x05,
      0x06,
    ]);
  });
});

describe("PrivateMessagePacket with a timer", () => {
  test("without one, the bytes are bitchat's", () => {
    const plain = encodePrivateMessagePacket("m1", "hi")!;
    expect(Array.from(plain)).toEqual([0, 2, 109, 49, 1, 2, 104, 105]);
    expect(decodePrivateMessagePacket(plain)).toEqual({
      messageID: "m1",
      content: "hi",
    });
  });

  test("round-trips a timer and a timer change", () => {
    const timed = encodePrivateMessagePacket("m1", "hi", { ms: 7 * DAY })!;
    expect(decodePrivateMessagePacket(timed)).toEqual({
      messageID: "m1",
      content: "hi",
      timer: { ms: 7 * DAY },
    });
    const change = encodePrivateMessagePacket("m2", "", {
      ms: 30 * DAY,
      setAtMs: 1_800_000_000_123,
    })!;
    expect(decodePrivateMessagePacket(change)).toEqual({
      messageID: "m2",
      content: "",
      timer: { ms: 30 * DAY, setAtMs: 1_800_000_000_123 },
    });
  });

  // A later version's choice must not cost the message: the sender would
  // resend it for a week, unacknowledged.
  test("reads a timer off the choices as the longest choice not above it, a day at least", () => {
    const base = Array.from(encodePrivateMessagePacket("m1", "hi")!);
    const timerOf = (seconds: number): number | undefined =>
      decodePrivateMessagePacket(
        Uint8Array.from([
          ...base,
          TLV_DM_TIMER,
          4,
          (seconds >>> 24) & 0xff,
          (seconds >>> 16) & 0xff,
          (seconds >>> 8) & 0xff,
          seconds & 0xff,
        ]),
      )?.timer?.ms;
    expect(timerOf(60)).toBe(DAY);
    expect(timerOf(3_600)).toBe(DAY);
    expect(timerOf((14 * DAY) / 1000)).toBe(7 * DAY);
    expect(timerOf((90 * DAY) / 1000)).toBe(30 * DAY);
    expect(timerOf(0)).toBe(0);
  });

  test("refuses a bad length, a change with no timer, or an unknown TLV", () => {
    const base = Array.from(encodePrivateMessagePacket("m1", "hi")!);
    const refuse = (extra: number[]): void =>
      expect(
        decodePrivateMessagePacket(Uint8Array.from([...base, ...extra])),
      ).toBeNull();
    refuse([TLV_DM_TIMER, 3, 0, 0, 0]);
    refuse([TLV_DM_TIMER_SET_AT, 8, 0, 0, 0, 0, 0, 0, 0, 1]);
    refuse([0x52, 0]);
  });
});

describe("a ratchet message with a timer", () => {
  test("round-trips, and reads text after the timer", () => {
    const bytes = encodeDmMessage("m1", "long text", 5, { ms: DAY });
    expect(decodeDmPayload(bytes)).toEqual({
      type: DmPayloadType.MESSAGE,
      messageId: "m1",
      text: "long text",
      sentAtMs: 5,
      timer: { ms: DAY },
    });
    expect(decodeDmPayload(encodeDmMessage("m1", "x", 5))).toEqual({
      type: DmPayloadType.MESSAGE,
      messageId: "m1",
      text: "x",
      sentAtMs: 5,
    });
  });

  test("refuses a length that runs past the message", () => {
    const bytes = encodeDmMessage("m1", "", 5, { ms: DAY });
    expect(decodeDmPayload(bytes.slice(0, 6))).toBeNull();
  });
});
