import XCTest

@testable import AirhopVideoSurfaces

final class SurfaceRegistryTests: XCTestCase {
  private final class Surface {}

  private let key = "peer:stream"

  private func ids(_ surfaces: [Surface]) -> [ObjectIdentifier] {
    surfaces.map(ObjectIdentifier.init)
  }

  func testEverySurfaceUnderAKeyGetsAKeyframe() {
    let registry = SurfaceRegistry<Surface>()
    let bubble = Surface()
    let viewer = Surface()
    registry.attach(bubble, key: key)
    registry.attach(viewer, key: key)

    XCTAssertEqual(ids(registry.receivers(key: key, keyframe: true)), ids([bubble, viewer]))
  }

  func testANewSurfaceWaitsForAKeyframeWhileTheOldOneKeepsPlaying() {
    let registry = SurfaceRegistry<Surface>()
    let bubble = Surface()
    registry.attach(bubble, key: key)
    _ = registry.receivers(key: key, keyframe: true)
    let viewer = Surface()
    registry.attach(viewer, key: key)

    XCTAssertEqual(ids(registry.receivers(key: key, keyframe: false)), ids([bubble]))
    XCTAssertEqual(ids(registry.receivers(key: key, keyframe: true)), ids([bubble, viewer]))
    XCTAssertEqual(ids(registry.receivers(key: key, keyframe: false)), ids([bubble, viewer]))
  }

  func testAttachingTwiceKeepsOneEntryAndItsPicture() {
    let registry = SurfaceRegistry<Surface>()
    let bubble = Surface()
    registry.attach(bubble, key: key)
    _ = registry.receivers(key: key, keyframe: true)
    registry.attach(bubble, key: key)

    XCTAssertEqual(ids(registry.receivers(key: key, keyframe: false)), ids([bubble]))
  }

  func testTheViewerLeavingLeavesTheBubblePlaying() {
    let registry = SurfaceRegistry<Surface>()
    let bubble = Surface()
    let viewer = Surface()
    registry.attach(bubble, key: key)
    registry.attach(viewer, key: key)
    _ = registry.receivers(key: key, keyframe: true)
    registry.detach(viewer, key: key)

    XCTAssertEqual(ids(registry.receivers(key: key, keyframe: false)), ids([bubble]))
  }

  func testASurfaceBackInTheWindowWaitsForAKeyframe() {
    // A full-screen presentation takes the thread out of the window and puts
    // it back; its layer missed every unit in between.
    let registry = SurfaceRegistry<Surface>()
    let bubble = Surface()
    registry.attach(bubble, key: key)
    _ = registry.receivers(key: key, keyframe: true)
    registry.detach(bubble, key: key)
    registry.attach(bubble, key: key)

    XCTAssertTrue(registry.receivers(key: key, keyframe: false).isEmpty)
    XCTAssertEqual(ids(registry.receivers(key: key, keyframe: true)), ids([bubble]))
  }

  func testResyncHoldsOnlyThatSurfaceUntilAKeyframe() {
    let registry = SurfaceRegistry<Surface>()
    let bubble = Surface()
    let viewer = Surface()
    registry.attach(bubble, key: key)
    registry.attach(viewer, key: key)
    _ = registry.receivers(key: key, keyframe: true)
    registry.resync(viewer, key: key)

    XCTAssertEqual(ids(registry.receivers(key: key, keyframe: false)), ids([bubble]))
  }

  func testDetachingASurfaceNeverAttachedChangesNothing() {
    let registry = SurfaceRegistry<Surface>()
    let bubble = Surface()
    registry.attach(bubble, key: key)
    registry.detach(Surface(), key: key)
    registry.detach(bubble, key: "peer:other")

    XCTAssertEqual(ids(registry.surfaces(for: key)), ids([bubble]))
  }

  func testAFreedSurfaceIsDropped() {
    let registry = SurfaceRegistry<Surface>()
    let bubble = Surface()
    registry.attach(bubble, key: key)
    do {
      let viewer = Surface()
      registry.attach(viewer, key: key)
    }

    XCTAssertEqual(ids(registry.surfaces(for: key)), ids([bubble]))
  }
}
