import XCTest

@testable import AirhopTransport

final class LongWriteTests: XCTestCase {
  private func bytes(_ count: Int, _ value: UInt8) -> Data {
    Data(repeating: value, count: count)
  }

  func testPlainWriteIsOneFrame() {
    let outcome = LongWrite.join([(key: 1, offset: 0, data: bytes(20, 1))])
    XCTAssertEqual(outcome, .frames([.init(key: 1, data: bytes(20, 1))]))
  }

  func testLongWriteChunksAreJoinedInOrder() {
    let outcome = LongWrite.join([
      (key: 1, offset: 0, data: bytes(182, 1)),
      (key: 1, offset: 182, data: bytes(182, 2)),
      (key: 1, offset: 364, data: bytes(105, 3)),
    ])
    XCTAssertEqual(
      outcome, .frames([.init(key: 1, data: bytes(182, 1) + bytes(182, 2) + bytes(105, 3))]))
  }

  func testBatchedPlainWritesStaySeparate() {
    let outcome = LongWrite.join([
      (key: 1, offset: 0, data: bytes(20, 1)),
      (key: 1, offset: 0, data: bytes(20, 2)),
    ])
    XCTAssertEqual(
      outcome, .frames([.init(key: 1, data: bytes(20, 1)), .init(key: 1, data: bytes(20, 2))]))
  }

  func testTwoCentralsInOneCallDoNotMix() {
    let outcome = LongWrite.join([
      (key: 1, offset: 0, data: bytes(10, 1)),
      (key: 2, offset: 0, data: bytes(10, 2)),
      (key: 1, offset: 10, data: bytes(5, 3)),
    ])
    XCTAssertEqual(
      outcome,
      .frames([.init(key: 1, data: bytes(10, 1) + bytes(5, 3)), .init(key: 2, data: bytes(10, 2))])
    )
  }

  func testGapIsRefused() {
    let outcome = LongWrite.join([
      (key: 1, offset: 0, data: bytes(10, 1)),
      (key: 1, offset: 12, data: bytes(10, 2)),
    ])
    XCTAssertEqual(outcome, .gap)
  }

  func testContinuationWithNoOpenFrameIsRefused() {
    XCTAssertEqual(LongWrite.join([(key: 1, offset: 10, data: bytes(10, 1))]), .gap)
  }

  func testOverlapIsRefused() {
    let outcome = LongWrite.join([
      (key: 1, offset: 0, data: bytes(10, 1)),
      (key: 1, offset: 5, data: bytes(10, 2)),
    ])
    XCTAssertEqual(outcome, .gap)
  }

  func testLargestFrameIsAccepted() {
    let outcome = LongWrite.join([
      (key: 1, offset: 0, data: bytes(256, 1)),
      (key: 1, offset: 256, data: bytes(LongWrite.maxFrame - 256, 2)),
    ])
    guard case .frames(let frames) = outcome else { return XCTFail("refused") }
    XCTAssertEqual(frames.first?.data.count, LongWrite.maxFrame)
  }

  func testOversizedFrameIsRefused() {
    let outcome = LongWrite.join([
      (key: 1, offset: 0, data: bytes(256, 1)),
      (key: 1, offset: 256, data: bytes(LongWrite.maxFrame - 255, 2)),
    ])
    XCTAssertEqual(outcome, .oversized)
  }

  func testEmptyWriteDeliversNothing() {
    XCTAssertEqual(LongWrite.join([(key: 1, offset: 0, data: Data())]), .frames([]))
  }
}
