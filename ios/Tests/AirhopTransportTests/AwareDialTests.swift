import XCTest

@testable import AirhopTransport

final class AwareDialTests: XCTestCase {
    private let low = Data([0, 0, 0, 0, 0, 0, 0, 1])
    private let high = Data([0, 0, 0, 0, 0, 0, 0, 2])

    // ---- Tiebreak ----

    func testLowerTokenIsLower() {
        XCTAssertTrue(AwareDial.isLower(low, than: high))
        XCTAssertFalse(AwareDial.isLower(high, than: low))
        XCTAssertFalse(AwareDial.isLower(low, than: low))
    }

    func testBytesCompareUnsigned() {
        let a = Data([0x7f, 0, 0, 0, 0, 0, 0, 0])
        let b = Data([0x80, 0, 0, 0, 0, 0, 0, 0])
        XCTAssertTrue(AwareDial.isLower(a, than: b))
    }

    func testShorterTokenSortsFirst() {
        XCTAssertTrue(AwareDial.isLower(Data([9]), than: Data([0, 0])))
    }

    // Both ends dial, so a pair holds two connections. Both ends of each one
    // must reach the same answer, and the two connections must get opposite
    // answers: the one whose initiator holds the lower token survives.
    func testExactlyOneConnectionSurvives() {
        // The connection dialled by the lower token: kept at both ends.
        XCTAssertTrue(AwareDial.keeps(localToken: low, peerToken: high, weInitiated: true))
        XCTAssertTrue(AwareDial.keeps(localToken: high, peerToken: low, weInitiated: false))
        // The connection dialled by the higher token: dropped at both ends.
        XCTAssertFalse(AwareDial.keeps(localToken: high, peerToken: low, weInitiated: true))
        XCTAssertFalse(AwareDial.keeps(localToken: low, peerToken: high, weInitiated: false))
    }

    func testEqualTokensKeepNeither() {
        XCTAssertFalse(AwareDial.keeps(localToken: low, peerToken: low, weInitiated: true))
        XCTAssertFalse(AwareDial.keeps(localToken: low, peerToken: low, weInitiated: false))
    }

    // ---- Redial ----

    func testRedialDoublesFromTwoSecondsToAMinute() {
        XCTAssertEqual(AwareDial.nextRedial(after: nil), .seconds(4))
        XCTAssertEqual(AwareDial.nextRedial(after: .seconds(2)), .seconds(4))
        XCTAssertEqual(AwareDial.nextRedial(after: .seconds(16)), .seconds(32))
        XCTAssertEqual(AwareDial.nextRedial(after: .seconds(32)), .seconds(60))
        XCTAssertEqual(AwareDial.nextRedial(after: .seconds(60)), .seconds(60))
    }
}
