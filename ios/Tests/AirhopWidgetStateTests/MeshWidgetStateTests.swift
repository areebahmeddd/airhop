import XCTest

@testable import AirhopWidgetState

// The same cases as MeshWidgetStateTest.kt, so the two widgets are held to one
// reading of a snapshot.
final class MeshWidgetStateTests: XCTestCase {
  private let now: Int64 = 1_800_000_000_000
  // Well before the hour-long cutoff, so the age tests test age, not boot.
  private var boot: Int64 { now - 6 * 3_600_000 }

  private func state(_ snapshot: MeshSnapshot?, nowMs: Int64? = nil) -> MeshWidgetState {
    MeshWidgetState(snapshot, nowMs: nowMs ?? now, bootMs: boot)
  }

  private func snap(
    _ count: Int,
    at atMs: Int64,
    meshOn: Bool = true,
    bluetoothOff: Bool = false
  ) -> MeshSnapshot {
    MeshSnapshot(count: count, meshOn: meshOn, bluetoothOff: bluetoothOff, atMs: atMs)!
  }

  // Each line names its inputs, so a test reads which branch drew it.
  private struct Copy: MeshWidgetCopy {
    func asOf(atMs: Int64) -> String {
      "asOf \(atMs)"
    }

    func inRange(count: Int) -> String {
      "inRange(\(count))"
    }

    func nobody() -> String {
      "nobody"
    }

    func paused() -> String {
      "paused"
    }

    func unset() -> String {
      "unset"
    }

    func stale() -> String {
      "stale"
    }

    func bluetoothOff() -> String {
      "bluetoothOff"
    }
  }

  // ---- The snapshot ----

  func testASnapshotTheAppCannotHaveWrittenIsNone() {
    XCTAssertNil(MeshSnapshot(count: -1, meshOn: true, bluetoothOff: false, atMs: now))
    XCTAssertNil(MeshSnapshot(count: 3, meshOn: true, bluetoothOff: false, atMs: 0))
    XCTAssertNil(MeshSnapshot(count: 3, meshOn: true, bluetoothOff: false, atMs: -5))
  }

  func testANumberTheBridgeCannotHoldIsNoneRatherThanATrap() {
    XCTAssertNil(MeshSnapshot(fromBridge: .nan, meshOn: true, bluetoothOff: false, atMs: 1.0))
    XCTAssertNil(MeshSnapshot(fromBridge: 1.0, meshOn: true, bluetoothOff: false, atMs: .infinity))
    XCTAssertNil(MeshSnapshot(fromBridge: 1e300, meshOn: true, bluetoothOff: false, atMs: 1.0))
    XCTAssertEqual(
      MeshSnapshot(fromBridge: 4.0, meshOn: true, bluetoothOff: false, atMs: Double(now)),
      snap(4, at: now)
    )
  }

  func testTheStoreRoundTripsAndClears() throws {
    let defaults = try XCTUnwrap(UserDefaults(suiteName: "MeshWidgetStateTests"))
    MeshSnapshot.clear(defaults)
    XCTAssertNil(MeshSnapshot.read(from: defaults))

    let written = snap(5, at: now, bluetoothOff: true)
    written.write(to: defaults)
    XCTAssertEqual(MeshSnapshot.read(from: defaults), written)

    MeshSnapshot.clear(defaults)
    XCTAssertNil(MeshSnapshot.read(from: defaults))
  }

  func testAValueOfTheWrongTypeReadsAsNoSnapshot() throws {
    let defaults = try XCTUnwrap(UserDefaults(suiteName: "MeshWidgetStateTests.damaged"))
    snap(5, at: now).write(to: defaults)
    defaults.set("five", forKey: "count")
    XCTAssertNil(MeshSnapshot.read(from: defaults))
    MeshSnapshot.clear(defaults)
  }

  // ---- Which state ----

  func testNothingWrittenAsksForTheApp() {
    XCTAssertEqual(state(nil), .unset)
  }

  func testAFreshReadingIsShownWithItsTime() {
    XCTAssertEqual(state(snap(4, at: now)), .counted(count: 4, atMs: now))
    XCTAssertEqual(state(snap(0, at: now)), .counted(count: 0, atMs: now))
  }

  func testAReadingAgesOutAtItsCutoff() {
    let at = now - MeshWidgetState.staleAfterMs
    XCTAssertEqual(state(snap(2, at: at)), .counted(count: 2, atMs: at))
    XCTAssertEqual(state(snap(2, at: at - 1)), .stale)
  }

  func testAReadingFromTheFutureMeansTheClockMovedAndIsNotShown() {
    XCTAssertEqual(state(snap(2, at: now + 1)), .stale)
  }

  func testAReadingFromBeforeThisBootIsNotShownHoweverRecent() {
    let at = now - 60_000
    // Rebooted a minute after the last push: young, but no mesh survived it.
    XCTAssertEqual(MeshWidgetState(snap(5, at: at), nowMs: now, bootMs: at + 1), .stale)
    XCTAssertEqual(
      MeshWidgetState(snap(5, at: at), nowMs: now, bootMs: at),
      .counted(count: 5, atMs: at)
    )
  }

  func testPausedOutranksAgeAndBoot() {
    let old = boot - MeshWidgetState.staleAfterMs * 10
    XCTAssertEqual(state(snap(7, at: old, meshOn: false)), .paused)
    XCTAssertEqual(state(snap(7, at: now + 1, meshOn: false)), .paused)
  }

  func testBluetoothOffWithNobodyReachableSaysSoRatherThanAnEmptyRoom() {
    XCTAssertEqual(state(snap(0, at: now, bluetoothOff: true)), .bluetoothOff)
  }

  func testPeersStillReachableWithBluetoothOffAreACount() {
    XCTAssertEqual(state(snap(2, at: now, bluetoothOff: true)), .counted(count: 2, atMs: now))
  }

  func testBluetoothOffAgesOutAndGivesWayToPaused() {
    let old = now - MeshWidgetState.staleAfterMs - 1
    XCTAssertEqual(state(snap(0, at: old, bluetoothOff: true)), .stale)
    XCTAssertEqual(state(snap(0, at: boot - 1, bluetoothOff: true)), .stale)
    XCTAssertEqual(state(snap(0, at: now, meshOn: false, bluetoothOff: true)), .paused)
  }

  // ---- The timeline ----

  func testAReadingTurnsStaleJustPastItsCutoffAndTheRestHold() {
    let reading = snap(3, at: now)
    XCTAssertEqual(
      MeshWidgetState.staleAtMs(for: reading, state: state(reading)),
      now + MeshWidgetState.staleAfterMs + 1
    )
    let off = snap(0, at: now, bluetoothOff: true)
    XCTAssertEqual(
      MeshWidgetState.staleAtMs(for: off, state: state(off)),
      now + MeshWidgetState.staleAfterMs + 1
    )
    // The entry it schedules really is stale.
    XCTAssertEqual(state(reading, nowMs: now + MeshWidgetState.staleAfterMs + 1), .stale)

    let paused = snap(3, at: now, meshOn: false)
    XCTAssertNil(MeshWidgetState.staleAtMs(for: paused, state: state(paused)))
    XCTAssertNil(MeshWidgetState.staleAtMs(for: nil, state: .unset))
  }

  // ---- What it draws ----

  func testACountIsNeverDrawnWithoutItsTime() {
    let snapshots: [MeshSnapshot?] = [
      nil,
      snap(3, at: now),
      snap(0, at: now),
      snap(3, at: now, meshOn: false),
      snap(3, at: now - MeshWidgetState.staleAfterMs - 1),
      snap(3, at: boot - 1),
      snap(3, at: now + 1),
      snap(0, at: now, bluetoothOff: true),
      snap(4, at: now, bluetoothOff: true),
    ]
    for snapshot in snapshots {
      let lines = MeshWidgetLines(state(snapshot), copy: Copy())
      XCTAssertEqual(lines.count == nil, lines.asOf == nil, "\(String(describing: snapshot))")
      if let asOf = lines.asOf, let snapshot {
        XCTAssertEqual(asOf, "asOf \(snapshot.atMs)")
      }
    }
  }

  func testEachStateDrawsItsOwnLines() {
    let copy = Copy()
    XCTAssertEqual(
      MeshWidgetLines(.counted(count: 3, atMs: now), copy: copy),
      MeshWidgetLines(count: "3", caption: "inRange(3)", asOf: "asOf \(now)")
    )
    XCTAssertEqual(
      MeshWidgetLines(.counted(count: 0, atMs: now), copy: copy),
      MeshWidgetLines(count: "0", caption: "nobody", asOf: "asOf \(now)")
    )
    XCTAssertEqual(
      MeshWidgetLines(.paused, copy: copy),
      MeshWidgetLines(count: nil, caption: "paused", asOf: nil)
    )
    XCTAssertEqual(
      MeshWidgetLines(.unset, copy: copy),
      MeshWidgetLines(count: nil, caption: "unset", asOf: nil)
    )
    XCTAssertEqual(
      MeshWidgetLines(.stale, copy: copy),
      MeshWidgetLines(count: nil, caption: "stale", asOf: nil)
    )
    XCTAssertEqual(
      MeshWidgetLines(.bluetoothOff, copy: copy),
      MeshWidgetLines(count: nil, caption: "bluetoothOff", asOf: nil)
    )
  }
}
