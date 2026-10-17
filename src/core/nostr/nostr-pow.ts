// NIP-13 proof of work, as bitchat-ios NostrPoW: 8 bits on each kind-20000
// message, which lets it skip the per-sender flood limit.
//
// The score is the committed target, and only if the ID meets it. Mining runs
// on the JS thread, so it is time-capped; at the cap the target halves, and a
// send is never held back.

import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";

export const POW_TARGET_BITS = 8;
export const POW_BYPASS_BITS = 8;

// About 256 hashes on average. bitchat-ios allows 2s, off the main thread.
const MINING_BUDGET_MS = 200;
const FALLBACK_BUDGET_MS = 30;
const CHECK_EVERY = 64;

const NONCE_HEX_LENGTH = 16;

export interface PowEventFields {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export function leadingZeroBits(bytes: Uint8Array): number {
  let total = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      total += 8;
      continue;
    }
    return total + Math.clz32(byte) - 24;
  }
  return total;
}

export function validatedDifficulty(idHex: string, tags: string[][]): number {
  let nonceTag: string[] | undefined;
  for (const tag of tags) if (tag[0] === "nonce") nonceTag = tag;
  if (nonceTag === undefined || nonceTag.length < 3) return 0;
  if (!/^\d{1,3}$/.test(nonceTag[2])) return 0;
  const committed = Number(nonceTag[2]);
  if (committed < 1 || committed > 256) return 0;
  if (!/^[0-9a-f]{64}$/i.test(idHex)) return 0;
  return leadingZeroBits(hexToBytes(idHex)) >= committed ? committed : 0;
}

// A nonce tag to append last to `fields.tags`, or null if time ran out.
export function mineNonceTag(
  fields: PowEventFields,
  targetBits: number = POW_TARGET_BITS,
  nowMs: () => number = Date.now,
): string[] | null {
  let target = Math.min(Math.max(Math.floor(targetBits), 0), 256);
  let budgetMs = MINING_BUDGET_MS;
  while (target > 0) {
    const tag = mineAttempt(fields, target, nowMs() + budgetMs, nowMs);
    if (tag !== null) return tag;
    target = Math.floor(target / 2);
    budgetMs = FALLBACK_BUDGET_MS;
  }
  return null;
}

// One pass at a fixed target: only the 16 nonce bytes change per hash.
function mineAttempt(
  fields: PowEventFields,
  target: number,
  deadlineMs: number,
  nowMs: () => number,
): string[] | null {
  const targetString = String(target);
  // JSON.stringify adds no whitespace, so this is nostr-tools' serialization.
  const tags = fields.tags.map((tag) => JSON.stringify(tag)).join(",");
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `${JSON.stringify([0, fields.pubkey, fields.created_at, fields.kind]).slice(0, -1)},` +
      `[${tags}${tags.length > 0 ? "," : ""}["nonce","`,
  );
  const tail = encoder.encode(
    `","${targetString}"]],${JSON.stringify(fields.content)}]`,
  );
  const buffer = new Uint8Array(head.length + NONCE_HEX_LENGTH + tail.length);
  buffer.set(head, 0);
  buffer.set(tail, head.length + NONCE_HEX_LENGTH);

  // Not secret: only keeps senders' nonces apart.
  const [high, low] = crypto.getRandomValues(new Uint32Array(2));
  let counter = low;
  for (let attempt = 1; ; attempt++) {
    const nonce = hex8(high) + hex8(counter);
    for (let i = 0; i < NONCE_HEX_LENGTH; i++) {
      buffer[head.length + i] = nonce.charCodeAt(i);
    }
    if (leadingZeroBits(sha256(buffer)) >= target) {
      return ["nonce", nonce, targetString];
    }
    counter = (counter + 1) >>> 0;
    if (attempt % CHECK_EVERY === 0 && nowMs() >= deadlineMs) return null;
  }
}

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}
