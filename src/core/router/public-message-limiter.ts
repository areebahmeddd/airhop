// Flood limit on inbound public messages, as bitchat-ios MessageRateLimiter:
// a token bucket per sender and one per normalized text across senders. NIP-13
// work skips the sender bucket only, and a refused sender spends no text
// bucket. Both tables are capped, since keys come off the air.

import { POW_BYPASS_BITS } from "@core/nostr/nostr-pow";

// How many public messages one sender may post in a row before the one-a-second
// refill applies. The forward sheet caps a bulk public forward at it.
export const SENDER_CAPACITY = 5;
const SENDER_REFILL_PER_SEC = 1;
const CONTENT_CAPACITY = 3;
const CONTENT_REFILL_PER_SEC = 0.5;
const MAX_BUCKETS = 2000;
const BUCKET_IDLE_MS = 10 * 60 * 1000;

// bitchat-ios contentKeyPrefixLength.
const CONTENT_KEY_CHARS = 256;

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

// As bitchat-ios ContentNormalizer, without the hash.
export function publicContentKey(text: string): string {
  const collapsed = text
    .toLowerCase()
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1")
    .trim()
    .replace(/\s+/g, " ");
  return [...collapsed].slice(0, CONTENT_KEY_CHARS).join("");
}

export class PublicMessageLimiter {
  private readonly senders = new Map<string, Bucket>();
  private readonly contents = new Map<string, Bucket>();

  allow(
    senderKey: string,
    contentKey: string,
    powBits: number,
    nowMs: number,
  ): boolean {
    if (powBits < POW_BYPASS_BITS) {
      const sender = take(this.senders, senderKey, SENDER_CAPACITY, nowMs);
      if (!spend(sender, SENDER_REFILL_PER_SEC, SENDER_CAPACITY, nowMs)) {
        return false;
      }
    }
    const content = take(this.contents, contentKey, CONTENT_CAPACITY, nowMs);
    return spend(content, CONTENT_REFILL_PER_SEC, CONTENT_CAPACITY, nowMs);
  }

  reset(): void {
    this.senders.clear();
    this.contents.clear();
  }
}

function take(
  buckets: Map<string, Bucket>,
  key: string,
  capacity: number,
  nowMs: number,
): Bucket {
  const existing = buckets.get(key);
  if (existing !== undefined) return existing;
  if (buckets.size >= MAX_BUCKETS) evict(buckets, nowMs);
  const bucket = { tokens: capacity, lastRefillMs: nowMs };
  buckets.set(key, bucket);
  return bucket;
}

function spend(
  bucket: Bucket,
  refillPerSec: number,
  capacity: number,
  nowMs: number,
): boolean {
  const elapsedMs = nowMs - bucket.lastRefillMs;
  if (elapsedMs > 0) {
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + (elapsedMs / 1000) * refillPerSec,
    );
    bucket.lastRefillMs = nowMs;
  }
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function evict(buckets: Map<string, Bucket>, nowMs: number): void {
  for (const [key, bucket] of buckets) {
    if (nowMs - bucket.lastRefillMs >= BUCKET_IDLE_MS) buckets.delete(key);
  }
  if (buckets.size < MAX_BUCKETS) return;
  let oldestKey: string | null = null;
  let oldestMs = Infinity;
  for (const [key, bucket] of buckets) {
    if (bucket.lastRefillMs < oldestMs) {
      oldestMs = bucket.lastRefillMs;
      oldestKey = key;
    }
  }
  if (oldestKey !== null) buckets.delete(oldestKey);
}
