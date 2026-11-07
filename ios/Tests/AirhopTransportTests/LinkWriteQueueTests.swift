import XCTest

@testable import AirhopTransport

final class LinkWriteQueueTests: XCTestCase {
  private let ms: UInt64 = 1_000_000

  private func frame(_ value: UInt8) -> Data {
    Data(repeating: value, count: 20)
  }

  // Hands over everything left, in order, as the BLE module drains a link.
  private func drain(_ queue: inout LinkWriteQueue, now: UInt64) -> [Data] {
    var sent: [Data] = []
    while let next = queue.head(now: now) {
      sent.append(next)
      queue.removeHead()
    }
    return sent
  }

  func testWritesLeaveInTheOrderTheyWereMade() {
    var queue = LinkWriteQueue()
    for value in 1...5 {
      XCTAssertTrue(queue.append(frame(UInt8(value)), ttlMs: 0, now: 0))
    }

    XCTAssertEqual(drain(&queue, now: 0), (1...5).map { frame(UInt8($0)) })
  }

  func testARefusedHeadIsOfferedAgainBeforeAnythingBehindIt() {
    var queue = LinkWriteQueue()
    _ = queue.append(frame(1), ttlMs: 0, now: 0)
    _ = queue.append(frame(2), ttlMs: 0, now: 0)

    XCTAssertEqual(queue.head(now: 0), frame(1))
    XCTAssertEqual(queue.head(now: 5 * ms), frame(1))
    XCTAssertEqual(queue.depth, 2)
  }

  func testAHandOffDropsAnExpiredWriteOnlyOnReachingTheHead() {
    var queue = LinkWriteQueue()
    _ = queue.append(frame(1), ttlMs: 0, now: 0)
    _ = queue.append(frame(2), ttlMs: 10, now: 0)
    _ = queue.append(frame(3), ttlMs: 0, now: 0)

    // Frame 2 is stale, but no append has swept it, so it is still counted.
    XCTAssertEqual(queue.head(now: 50 * ms), frame(1))
    XCTAssertEqual(queue.depth, 3)

    queue.removeHead()
    XCTAssertEqual(queue.head(now: 50 * ms), frame(3))
    XCTAssertEqual(queue.depth, 1)
  }

  func testAWriteIsKeptUntilItsTimeToLiveHasPassed() {
    var queue = LinkWriteQueue()
    _ = queue.append(frame(1), ttlMs: 10, now: 100 * ms)

    XCTAssertEqual(queue.head(now: 110 * ms), frame(1))
    XCTAssertNil(queue.head(now: 110 * ms + 1))
    XCTAssertEqual(queue.depth, 0)
  }

  func testNoTimeToLiveNeverExpires() {
    var queue = LinkWriteQueue()
    _ = queue.append(frame(1), ttlMs: 0, now: 0)
    _ = queue.append(frame(2), ttlMs: -5, now: 0)
    _ = queue.append(frame(3), ttlMs: .nan, now: 0)

    XCTAssertEqual(drain(&queue, now: .max), [frame(1), frame(2), frame(3)])
  }

  func testExtremeTimesToLiveConvertWithoutTrapping() {
    XCTAssertGreaterThan(LinkWriteQueue.ttlNanos(fromMs: 1e300), 0)
    XCTAssertEqual(LinkWriteQueue.ttlNanos(fromMs: .infinity), 0)
    XCTAssertEqual(LinkWriteQueue.ttlNanos(fromMs: 1e-12), 1)
  }

  func testAFullQueueRefusesUntilTheRadioTakesOne() {
    var queue = LinkWriteQueue()
    for value in 0..<LinkWriteQueue.capacity {
      XCTAssertTrue(queue.append(frame(UInt8(value)), ttlMs: 0, now: 0))
    }

    XCTAssertFalse(queue.append(frame(0xFF), ttlMs: 0, now: 0))
    XCTAssertEqual(queue.depth, LinkWriteQueue.capacity)

    queue.removeHead()
    XCTAssertTrue(queue.append(frame(0xFF), ttlMs: 0, now: 0))
  }

  func testAFullQueueTakesAFreshWriteOnceItsStaleHeadExpires() {
    var queue = LinkWriteQueue()
    _ = queue.append(frame(1), ttlMs: 10, now: 0)
    for _ in 1..<LinkWriteQueue.capacity {
      _ = queue.append(frame(2), ttlMs: 0, now: 0)
    }
    XCTAssertFalse(queue.append(frame(3), ttlMs: 0, now: 5 * ms))

    XCTAssertTrue(queue.append(frame(3), ttlMs: 0, now: 20 * ms))
    XCTAssertEqual(queue.depth, LinkWriteQueue.capacity)
    XCTAssertEqual(queue.head(now: 20 * ms), frame(2))
  }

  func testAnExpiredWriteBehindALiveHeadFreesItsSlot() {
    var queue = LinkWriteQueue()
    _ = queue.append(frame(1), ttlMs: 0, now: 0)
    _ = queue.append(frame(2), ttlMs: 10, now: 0)
    for _ in 2..<LinkWriteQueue.capacity {
      _ = queue.append(frame(3), ttlMs: 0, now: 0)
    }
    XCTAssertFalse(queue.append(frame(4), ttlMs: 0, now: 5 * ms))

    // Frame 2 will never be sent, so it gives its slot to a write that will.
    XCTAssertTrue(queue.append(frame(4), ttlMs: 0, now: 20 * ms))
    XCTAssertEqual(queue.depth, LinkWriteQueue.capacity)

    let sent = drain(&queue, now: 20 * ms)
    XCTAssertEqual(sent.first, frame(1))
    XCTAssertEqual(sent.last, frame(4))
    XCTAssertFalse(sent.contains(frame(2)))
    XCTAssertEqual(sent.count, LinkWriteQueue.capacity)
  }
}
