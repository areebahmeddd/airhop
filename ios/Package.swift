// swift-tools-version: 5.9
// Test harness for the pure parts of the iOS native modules. The app target
// compiles the same files from Airhop/Transport/; this package exists so
// `swift test` can run them on any Mac, and in CI, without a simulator or a
// scheme. Its own folder, because SwiftPM reads every *.lproj under a target
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
    ]
)
