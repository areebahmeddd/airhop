/**
 * @jest-environment node
 */
// A token Airhop sends must render as money inside bitchat.
//
// bitchat has no wallet (it never contacts a mint) and no NIP-61, so
// `findNutzapTarget` falls through to the token rail for its users. Its
// `/pay <token>` sends the bare token as the message body, exactly as
// `deliverTokenToPeer` does, and bitchat decodes it only far enough to draw a
// chip (amount, unit, mint host, memo). So the contract is the token encoding. bitchat's own strict CBOR reader (definite
// lengths, bounded depth, `/pay` needs a positive amount) must be able to walk
// whatever cashu-ts emits, or payments become silent blobs there.
//
// `decodeLikeBitchat` is a literal port of `CashuTokenDecoder.decodeV4` and its
// `CBORReader`, kept diffable against the Swift. A failure here means Airhop
// and bitchat have diverged on payments, with no error on either side.

import type { StoredProof } from "@store/wallet-store";
import { buildToken } from "../cashu";

const MINT = "https://mint.airhop.example";

function proof(amount: number, n: number): StoredProof {
  return {
    id: "00ad268c4d1f5826",
    amount,
    secret: `${String(n)}${"a".repeat(63)}`,
    C: "02" + "bb".repeat(32),
  };
}

type CBOR =
  | { k: "uint"; v: number }
  | { k: "text"; v: string }
  | { k: "array"; v: CBOR[] }
  | { k: "map"; v: [CBOR, CBOR][] }
  | { k: "opaque" };

const MAX_DEPTH = 16;
const MAX_CONTAINER = 10_000;

// Faithful to CBORReader in CashuTokenDecoder.swift, including its refusal of
// indefinite-length items (info 31) and reserved heads (28-30).
class Reader {
  private i = 0;
  private budget = 50_000;
  constructor(private readonly b: Uint8Array) {}

  parse(depth: number): CBOR | null {
    if (depth >= MAX_DEPTH || this.budget <= 0) return null;
    this.budget--;
    const head = this.head();
    if (!head) return null;
    const [major, arg] = head;
    switch (major) {
      case 0:
        return { k: "uint", v: Number(arg) };
      case 1:
        return { k: "opaque" };
      case 2:
        return this.bytes(arg) ? { k: "opaque" } : null;
      case 3: {
        const raw = this.bytes(arg);
        if (!raw) return null;
        return { k: "text", v: new TextDecoder().decode(raw) };
      }
      case 4: {
        if (arg > MAX_CONTAINER) return null;
        const items: CBOR[] = [];
        for (let n = 0; n < Number(arg); n++) {
          const item = this.parse(depth + 1);
          if (!item) return null;
          items.push(item);
        }
        return { k: "array", v: items };
      }
      case 5: {
        if (arg > MAX_CONTAINER) return null;
        const pairs: [CBOR, CBOR][] = [];
        for (let n = 0; n < Number(arg); n++) {
          const key = this.parse(depth + 1);
          const value = key ? this.parse(depth + 1) : null;
          if (!key || !value) return null;
          pairs.push([key, value]);
        }
        return { k: "map", v: pairs };
      }
      case 6:
        return this.parse(depth + 1);
      case 7:
        return { k: "opaque" };
      default:
        return null;
    }
  }

  private head(): [number, bigint] | null {
    if (this.i >= this.b.length) return null;
    const head = this.b[this.i++];
    const major = head >> 5;
    const info = head & 0x1f;
    if (info <= 23) return [major, BigInt(info)];
    const width =
      info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (width === 0) return null; // 28-30 reserved, 31 indefinite: refused
    const v = this.uint(width);
    return v === null ? null : [major, v];
  }

  private uint(width: number): bigint | null {
    if (this.b.length - this.i < width) return null;
    let v = 0n;
    for (let n = 0; n < width; n++) v = (v << 8n) | BigInt(this.b[this.i++]);
    return v;
  }

  private bytes(count: bigint): Uint8Array | null {
    if (count > BigInt(this.b.length - this.i)) return null;
    const len = Number(count);
    const slice = this.b.slice(this.i, this.i + len);
    this.i += len;
    return slice;
  }
}

function base64UrlDecode(input: string): Uint8Array | null {
  // Normalising to standard base64 then decoding, exactly as the Swift does.
  let s = input.replace(/-/g, "+").replace(/_/g, "/").replace(/=/g, "");
  const rem = s.length % 4;
  if (rem === 1) return null;
  if (rem > 0) s += "=".repeat(4 - rem);
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

interface Chip {
  version: string;
  amount: number | null;
  unit: string | null;
  mintHost: string | null;
  memo: string | null;
}

// Port of CashuTokenDecoder.decode(_:strict:) for the V4 path.
function decodeLikeBitchat(raw: string): Chip | null {
  const token = raw.trim();
  if (token.length < 12 || token.length > 60_000) return null;
  if (!token.startsWith("cashuA") && !token.startsWith("cashuB")) return null;
  if (!/^[A-Za-z0-9\-_+/=.]+$/.test(token)) return null;

  const version = token[5];
  const payload = base64UrlDecode(token.slice(6));
  if (!payload || payload.length === 0) return null;
  if (version !== "B") return null;

  const root = new Reader(payload).parse(0);
  if (!root || root.k !== "map") return null;

  let mintHost: string | null = null;
  let unit: string | null = null;
  let memo: string | null = null;
  let total = 0;
  let sawAmount = false;

  for (const [key, value] of root.v) {
    if (key.k !== "text") continue;
    if (key.v === "m" && value.k === "text") {
      try {
        mintHost = new URL(value.v).host.toLowerCase() || null;
      } catch {
        mintHost = null;
      }
    } else if (key.v === "u" && value.k === "text") {
      unit = value.v;
    } else if (key.v === "d" && value.k === "text") {
      memo = value.v;
    } else if (key.v === "t" && value.k === "array") {
      for (const group of value.v) {
        if (group.k !== "map") continue;
        for (const [gk, gv] of group.v) {
          if (gk.k !== "text" || gk.v !== "p" || gv.k !== "array") continue;
          for (const p of gv.v) {
            if (p.k !== "map") continue;
            for (const [pk, pv] of p.v) {
              if (pk.k === "text" && pk.v === "a" && pv.k === "uint") {
                total += pv.v;
                sawAmount = true;
              }
            }
          }
        }
      }
    }
  }
  return {
    version: "B",
    amount: sawAmount ? total : null,
    unit,
    mintHost,
    memo,
  };
}

describe("a token Airhop sends renders as money in bitchat", () => {
  it("decodes to the right amount, unit and mint under bitchat's reader", () => {
    const raw = buildToken(MINT, [proof(64, 1), proof(32, 2), proof(4, 3)]);
    const chip = decodeLikeBitchat(raw);

    expect(chip).not.toBeNull();
    // bitchat draws "100 sat" from exactly these three fields.
    expect(chip?.amount).toBe(100);
    expect(chip?.unit).toBe("sat");
    expect(chip?.mintHost).toBe("mint.airhop.example");
  });

  it("carries the memo bitchat shows on the chip", () => {
    const raw = buildToken(MINT, [proof(8, 1)], "sat", "coffee money");
    expect(decodeLikeBitchat(raw)?.memo).toBe("coffee money");
  });

  it("survives the single-proof and many-proof shapes", () => {
    // `/pay` refuses to relay a token that does not resolve to a positive
    // amount, so an unwalkable shape is a payment bitchat will not forward.
    const one = decodeLikeBitchat(buildToken(MINT, [proof(1, 1)]));
    expect(one?.amount).toBe(1);

    const many = Array.from({ length: 24 }, (_, n) => proof(2, n));
    expect(decodeLikeBitchat(buildToken(MINT, many))?.amount).toBe(48);
  });
});
