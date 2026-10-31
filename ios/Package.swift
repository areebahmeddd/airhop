// swift-tools-version: 5.9
// Test harness for the pure parts of the iOS native modules. The app target
// compiles the same files from Airhop/Transport/, Airhop/VideoSurfaces/ and
// Airhop/VideoTranscode/, and the app and the widget extension both compile
// AirhopWidget/State/; this
// package exists so `swift test` can run them on any Mac, and in CI, without a
// simulator or a scheme. Their own folders, because SwiftPM reads every *.lproj under a target
// path as a resource.
import PackageDescription

let package = Package(
  name: "AirhopTransport",
  platforms: [.macOS(.v13), .iOS(.v16)],
  targets: [
    .target(
      name: "AirhopTransport",
      path: "Airhop/Transport"
    ),
    .testTarget(
      name: "AirhopTransportTests",
      dependencies: ["AirhopTransport"],
      path: "Tests/AirhopTransportTests"
    ),
    .target(
      name: "AirhopWidgetState",
      path: "AirhopWidget/State"
    ),
    .testTarget(
      name: "AirhopWidgetStateTests",
      dependencies: ["AirhopWidgetState"],
      path: "Tests/AirhopWidgetStateTests"
    ),
    .target(
      name: "AirhopVideoSurfaces",
      path: "Airhop/VideoSurfaces"
    ),
    .testTarget(
      name: "AirhopVideoSurfacesTests",
      dependencies: ["AirhopVideoSurfaces"],
      path: "Tests/AirhopVideoSurfacesTests"
    ),
    .target(
      name: "AirhopVideoTranscode",
      path: "Airhop/VideoTranscode"
    ),
    .testTarget(
      name: "AirhopVideoTranscodeTests",
      dependencies: ["AirhopVideoTranscode"],
      path: "Tests/AirhopVideoTranscodeTests"
    ),
  ]
)
