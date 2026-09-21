import XCTest

@testable import AirhopTransport

final class FramingTests: XCTestCase {
    func testPrefixIsBigEndianLength() {
        let frame = Framing.encode(Data(count: 0x010203))
        XCTAssertEqual([UInt8](frame.prefix(4)), [0x00, 0x01, 0x02, 0x03])
        XCTAssertEqual(frame.count, 4 + 0x010203)
    }

    func testRoundTripsBody() {
        let body = Data([9, 8, 7, 6, 5])
        let frame = Framing.encode(body)
        XCTAssertEqual(Framing.length(frame.prefix(4)), body.count)
        XCTAssertEqual(frame.dropFirst(4), body)
    }

    func testEmptyFrameIsTheHeartbeat() {
        let frame = Framing.encode(Data())
        XCTAssertEqual([UInt8](frame), [0, 0, 0, 0])
        XCTAssertEqual(Framing.length(frame), 0)
    }

    func testLargestFrameIsAccepted() {
        let prefix = Framing.encode(Data(count: Framing.maxFrame)).prefix(4)
        XCTAssertEqual(Framing.length(prefix), Framing.maxFrame)
    }

    func testOversizedClaimIsRefused() {
        let prefix = Framing.encode(Data(count: Framing.maxFrame + 1)).prefix(4)
        XCTAssertNil(Framing.length(prefix))
    }

    func testHighBitIsRefused() {
        XCTAssertNil(Framing.length(Data([0x80, 0, 0, 0])))
        XCTAssertNil(Framing.length(Data([0xff, 0xff, 0xff, 0xff])))
    }

    func testWrongPrefixSizeIsRefused() {
        XCTAssertNil(Framing.length(Data([0, 0, 1])))
        XCTAssertNil(Framing.length(Data([0, 0, 0, 1, 0])))
    }

    // A prefix read out of the middle of a frame, as `Data` slices keep their
    // parent's indices.
    func testSliceIndicesDoNotMatter() {
        let frame = Framing.encode(Data([1, 2, 3]))
        let sliced = frame[frame.startIndex..<frame.startIndex + 4]
        XCTAssertEqual(Framing.length(sliced), 3)
    }
}
