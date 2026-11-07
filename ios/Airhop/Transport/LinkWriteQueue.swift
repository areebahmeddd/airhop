// The writes waiting on one BLE link, oldest first. Pure, so the BLE module and
// the tests share one definition of the queue's rules.
//
// Strictly FIFO: a write never passes one queued before it on the same link,
// which keeps a fragmented packet's pieces in order. A write may carry a time to
// live, which TypeScript sets for live media; one that reaches the head past it
// is dropped unsent, since a stale live frame only costs airtime. Native never
// reads the bytes to decide this. Each hand-off checks only the head, as
// bitchat-ios's live branch does with its per-notification deadline, so it costs
// one comparison; an append sweeps the whole queue, so an expired frame stuck
// behind a live one never holds a slot. Dropping keeps the survivors' order.
//
// Times are monotonic nanoseconds from the caller, so the tests set the clock.
import Foundation

struct LinkWriteQueue {
  // bitchat-ios's notification buffer cap (blePendingNotificationsCapCount):
  // at most 64 KiB of 512-byte frames per link. Past it the caller hears
  // WRITE_BUSY rather than queueing more.
  static let capacity = 128

  // A day bounds the conversion, which traps past UInt64.max.
  private static let maxTTLMs = 86_400_000.0

  private struct Entry {
    let data: Data
    let enqueuedAt: UInt64
    // Zero never expires.
    let ttlNanos: UInt64
  }

  private var entries: [Entry] = []

  // Writes not yet handed to the radio, including any that expired since the
  // last append or hand-off.
  var depth: Int { entries.count }

  static func ttlNanos(fromMs ms: Double) -> UInt64 {
    guard ms.isFinite, ms > 0 else { return 0 }
    // At least one nanosecond, so a positive time to live never reads as none.
    return UInt64(max(1, (min(ms, maxTTLMs) * 1_000_000).rounded(.up)))
  }

  // Appends unless full. Every expired entry goes first, wherever it waits:
  // none of them will be sent, so a link full of stale live frames still takes
  // a fresh write.
  mutating func append(_ data: Data, ttlMs: Double, now: UInt64) -> Bool {
    entries.removeAll { Self.isExpired($0, now: now) }
    guard entries.count < Self.capacity else { return false }
    entries.append(Entry(data: data, enqueuedAt: now, ttlNanos: Self.ttlNanos(fromMs: ttlMs)))
    return true
  }

  // The write to hand over next, after dropping whatever expired on reaching
  // the head. It stays queued until removeHead, so a refused hand-off is the
  // first thing retried.
  mutating func head(now: UInt64) -> Data? {
    dropExpiredHead(now: now)
    return entries.first?.data
  }

  mutating func removeHead() {
    guard !entries.isEmpty else { return }
    entries.removeFirst()
  }

  private mutating func dropExpiredHead(now: UInt64) {
    while let first = entries.first, Self.isExpired(first, now: now) {
      entries.removeFirst()
    }
  }

  private static func isExpired(_ entry: Entry, now: UInt64) -> Bool {
    entry.ttlNanos > 0 && now > entry.enqueuedAt && now - entry.enqueuedAt > entry.ttlNanos
  }
}
