// The one expiry check the thread, search, the lists and the sweep share. What
// it must never do is delete: with the setting off, on a clock that went back,
// a message still in flight or still live, or a received token not yet claimed.

import { getEncodedToken, type Token } from "@cashu/cashu-ts";
import { toProofLike } from "@core/payments/cashu";
import type { ChatMessage } from "@store/chat-store";
import {
  isMessageExpired,
  messageRetentionWindowMs,
  nextExpiryAtMs,
  withoutExpired,
  withoutExpiredInAll,
  type WalletClaims,
} from "../message-expiry";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m",
    channel: "dm:alice",
    senderID: "aabbccdd00112233",
    senderNickname: "alice",
    text: "words",
    timestampMs: NOW,
    receivedAtMs: NOW,
    isMine: false,
    ...overrides,
  };
}

describe("isMessageExpired", () => {
  it("counts from arrival on this phone, not the sender's clock", () => {
    const late = msg({ timestampMs: NOW - 30 * DAY, receivedAtMs: NOW });
    expect(isMessageExpired(late, NOW + DAY, DAY)).toBe(false);
    expect(isMessageExpired(late, NOW + DAY + 1, DAY)).toBe(true);
  });

  it("falls back to the sender's clock for a row without an arrival time", () => {
    const legacy = msg({ timestampMs: NOW - 2 * DAY, receivedAtMs: undefined });
    expect(isMessageExpired(legacy, NOW, DAY)).toBe(true);
  });

  it.each([
    ["the setting is off", msg({ receivedAtMs: 0 }), 0],
    ["the window is unreadable", msg({ receivedAtMs: 0 }), Number.NaN],
    [
      "it arrived after now, by a clock set back",
      msg({ receivedAtMs: NOW + DAY }),
      DAY,
    ],
    [
      "it is still being sent",
      msg({ receivedAtMs: 0, isMine: true, status: "sending" }),
      DAY,
    ],
    [
      "it is queued for a peer out of range",
      msg({ receivedAtMs: 0, isMine: true, status: "queued" }),
      DAY,
    ],
    [
      "a courier is still carrying it",
      msg({ receivedAtMs: 0, isMine: true, status: "carried" }),
      DAY,
    ],
    [
      "it is a live stream still drawing",
      msg({
        receivedAtMs: 0,
        liveVideo: {
          streamID: "0011223344556677",
          state: "live",
          startedAtMs: 0,
          width: 1,
          height: 1,
          hasAudio: false,
        },
      }),
      DAY,
    ],
  ])("never expires a message when %s", (_label, message, windowMs) => {
    expect(isMessageExpired(message, NOW, windowMs)).toBe(false);
  });

  it.each(["sent", "delivered", "read", "failed", "reclaimed"] as const)(
    "expires an own message that reached %s",
    (status) => {
      const own = msg({ receivedAtMs: 0, isMine: true, status });
      expect(isMessageExpired(own, NOW, DAY)).toBe(true);
    },
  );
});

// A real token, so the check runs the codec the chat card reads it with.
function token(secret: string): string {
  return getEncodedToken({
    mint: "https://mint.example.com",
    unit: "sat",
    proofs: [
      toProofLike({
        id: "00ad268c4d1f5826",
        amount: 8,
        secret,
        C: "02" + "00".repeat(32),
      }),
    ],
  } as unknown as Token);
}

function claims(...secrets: string[]): WalletClaims {
  return { claimed: new Set(secrets), keysets: [] };
}

// Claimed only by hand from its bubble, so the row is the only copy.
describe("a received token", () => {
  const old = { receivedAtMs: NOW - 2 * DAY };

  it("stays past the window while the wallet has not claimed it", () => {
    const row = msg({ ...old, text: `for lunch ${token("s-1")}` });
    expect(isMessageExpired(row, NOW, DAY)).toBe(false);
    expect(isMessageExpired(row, NOW, DAY, claims())).toBe(false);
    expect(isMessageExpired(row, NOW, DAY, claims("s-other"))).toBe(false);
  });

  it("goes once the wallet has claimed it, and only by the sweep", () => {
    const row = msg({ ...old, text: token("s-1") });
    expect(isMessageExpired(row, NOW, DAY, claims("s-1"))).toBe(true);
    // Without the wallet's word, as the thread asks, it is still kept.
    expect(isMessageExpired(row, NOW, DAY)).toBe(false);
  });

  it("stays while any one of several is unclaimed", () => {
    const row = msg({ ...old, text: `${token("s-1")} ${token("s-2")}` });
    expect(isMessageExpired(row, NOW, DAY, claims("s-1"))).toBe(false);
    expect(isMessageExpired(row, NOW, DAY, claims("s-1", "s-2"))).toBe(true);
  });

  it("does not hold a token this phone sent, or text that only names one", () => {
    const sent = msg({ ...old, isMine: true, text: token("s-1") });
    expect(isMessageExpired(sent, NOW, DAY)).toBe(true);
    const prose = msg({ ...old, text: "pay me in cashu: tokens" });
    expect(isMessageExpired(prose, NOW, DAY)).toBe(true);
  });

  it("does not hold a token posted to a room, which anyone there could claim", () => {
    for (const channel of ["#bluetooth", "#u4pruyd"]) {
      const row = msg({ ...old, channel, text: token("s-1") });
      expect(isMessageExpired(row, NOW, DAY)).toBe(true);
    }
  });
});

describe("nextExpiryAtMs", () => {
  it("is the earliest deadline still ahead, past those already reached", () => {
    const all = {
      "dm:alice": [
        msg({ id: "past", receivedAtMs: NOW - 2 * DAY }),
        msg({ id: "soon", receivedAtMs: NOW - DAY + 1_000 }),
      ],
      "#room": [msg({ id: "later", receivedAtMs: NOW })],
    };
    expect(nextExpiryAtMs(all, NOW, DAY)).toBe(NOW + 1_001);
    expect(isMessageExpired(all["dm:alice"][1], NOW + 1_000, DAY)).toBe(false);
    expect(isMessageExpired(all["dm:alice"][1], NOW + 1_001, DAY)).toBe(true);
  });

  it("is null with the setting off or nothing left to expire", () => {
    const all = { "dm:alice": [msg({ receivedAtMs: NOW - 2 * DAY })] };
    expect(nextExpiryAtMs(all, NOW, 0)).toBeNull();
    expect(nextExpiryAtMs(all, NOW, DAY)).toBeNull();
  });
});

describe("withoutExpired", () => {
  it("hands back the same array when nothing expired", () => {
    const list = [msg()];
    expect(withoutExpired(list, NOW, DAY)).toBe(list);
    const all = { "dm:alice": list };
    expect(withoutExpiredInAll(all, NOW, DAY)).toBe(all);
  });

  it("drops only the expired rows, in every thread", () => {
    const old = msg({ id: "old", receivedAtMs: NOW - 2 * DAY });
    const fresh = msg({ id: "fresh" });
    const room = [msg({ id: "room" })];
    const out = withoutExpiredInAll(
      { "dm:alice": [old, fresh], "#room": room },
      NOW,
      messageRetentionWindowMs(1),
    );
    expect(out["dm:alice"].map((m) => m.id)).toEqual(["fresh"]);
    expect(out["#room"]).toBe(room);
  });
});
