# iOS

The Swift half of the native boundary. Every module here is a thin I/O driver
that hands raw bytes to TypeScript and takes raw bytes back; protocol logic,
routing and crypto live in `src/core/`.

## Directory layout

Sources are under `Airhop/`, one Swift file per module with an `.mm` beside it
that exposes it to the React Native bridge.

| File                      | Holds                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| `AirhopAppModule.swift`   | Process-level: recent log for diagnostics; the Android-only calls reject |
| `AirhopBLEModule.swift`   | GATT server and central, the mesh's radio                                |
| `AirhopWiFiModule.swift`  | The Wi-Fi Aware fast path (iOS 26, paired devices only)                  |
| `AirhopWiFiPairing.swift` | The system pairing sheet that transport needs                            |
| `AirhopLANModule.swift`   | Bonjour discovery and TCP links on one network                           |
| `AirhopVoiceModule.swift` | AAC-LC capture and playback for push-to-talk                             |
| `AirhopTorModule.swift`   | The bridge face of the embedded Tor client                               |
| `AirhopTorManager.swift`  | Boots Arti and owns its SOCKS5 proxy                                     |
| `AirhopTorSocket.swift`   | A WebSocket that rides that proxy, for relay connections                 |
| `AirhopIPtProxy.swift`    | The pluggable transports Arti dials to reach a bridge                    |
| `AirhopLog.swift`         | One `os_log` category per module, read back into the export              |
| `*.lproj/`                | Permission and service strings, checked against `src/i18n/` in CI        |
| `Transport/`              | `Framing` and `AwareDial`, the pure pieces under test (see Tests)         |

The TypeScript side of every contract is in `src/bridge/`.

Elsewhere:

| Path                      | Holds                                                    |
| ------------------------- | -------------------------------------------------------- |
| `Frameworks/`             | The Tor client and its transports, built under `native/` |
| `Podfile`, `Podfile.lock` | React Native and Expo pods; the lock is checked in CI    |
| `Package.swift`, `Tests/` | The Swift test harness, see below                        |

Both frameworks are pinned by hash; see `native/README.md` for rebuilding them.

## Building

macOS only.

```sh
cd ios && pod install
npm run ios                        # debug build onto a device or simulator
```

Pod versions come from `node_modules`, so a dependency change regenerates
`Podfile.lock`; CI fails on a stale one.

## Tests

The pure pieces, `Framing` and `AwareDial`, compile twice: into the app, and
into a Swift package rooted here (`Package.swift`) that exists only so they
can be tested without a simulator or a scheme. Anything that touches a radio is
covered by the simulator under `src/__tests__/` and by devices.

```sh
swift test --package-path ios
```

Keep new logic of that kind in a pure enum under `Airhop/Transport/`, the
package's source root, so it can be tested the same way.

## Formatting

swift-format, as shipped with Xcode, checked in CI.

```sh
swift format --in-place --recursive Airhop Tests Package.swift
git diff --exit-code -- .    # what CI checks: the formatter changed nothing
```

## Logging

The unified log redacts interpolated values in a release build. Mark
`privacy: .public` only what cannot identify a peer, device or key; the
categories in `AirhopLog` are what `AirhopAppModule` reads back for the
diagnostics export.
