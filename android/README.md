# Android

The Kotlin half of the native boundary. Every module here is a thin I/O
driver that hands raw bytes to TypeScript and takes raw bytes back; protocol
logic, routing and crypto live in `src/core/`.

## Directory layout

Sources are under `app/src/main/java/org/onemindlabs/airhop/`.

| Directory    | Holds                                                                 |
| ------------ | --------------------------------------------------------------------- |
| `app/`       | `AirhopAppModule`: restart, boot start, APK share, ring alert, logs   |
| `ble/`       | `AirhopBLEModule`: GATT server and central, the mesh's radio          |
| `wifi/`      | `AirhopWiFiModule`: the Wi-Fi Aware fast path, and its dial rules     |
| `lan/`       | `AirhopLANModule`: mDNS discovery and TCP links on one network        |
| `transport/` | `Framing`: the length-prefixed stream both TCP transports speak       |
| `voice/`     | `AirhopVoiceModule`: AAC-LC capture and playback for push-to-talk     |
| `tor/`       | `AirhopTorModule`, the Arti bindings, the SOCKS proxy, the transports |
| `service/`   | The foreground service that keeps the mesh alive, and the boot path   |

Each module has a `*Package.kt` beside it that registers it with the bridge.
The TypeScript side of every contract is in `src/bridge/`.

Elsewhere under `app/`:

| Path                | Holds                                                 |
| ------------------- | ----------------------------------------------------- |
| `libs/IPtProxy.aar` | The pluggable transports, built by `native/iptproxy/` |
| `src/main/jniLibs/` | The embedded Tor client, built by `native/arti/`      |
| `gradle.lockfile`   | Every resolved dependency, checked in CI              |

Both binaries are pinned by hash; see `native/README.md` for rebuilding them.

## Building

```sh
npm run android                    # debug build onto a device or emulator
cd android && ./gradlew assembleRelease
```

Adding or bumping a dependency changes what Gradle resolves. Regenerate the
lock in the same commit:

```sh
./gradlew dependencies --write-locks
./gradlew :app:dependencies --write-locks
```

## Tests

JVM tests, no device, under `app/src/test/`. They cover the pure pieces:
`Framing` and `AwareDial` (the Aware follow-up messages, hello frame, tiebreak
and backoff). Anything that touches a radio is covered by the simulator under
`src/__tests__/` and by devices.

```sh
cd android && ./gradlew :app:testDebugUnitTest
```

Keep new logic of that kind in a pure object beside its module, so it can be
tested the same way.

## Logging

Samsung retail builds drop every informational logcat line. The Wi-Fi Aware
module keeps its own ring buffer and peer table for that reason, read back by
`dumpState()` into the diagnostics export. Use `AirhopAppModule`'s tag
allowlist for anything that should reach the export.

## Formatting

ktfmt, pinned to one version and checked in CI.

```sh
curl -sSfL -o /tmp/ktfmt.jar https://repo1.maven.org/maven2/com/facebook/ktfmt/0.64/ktfmt-0.64-with-dependencies.jar
java -jar /tmp/ktfmt.jar --kotlinlang-style app/src            # format
java -jar /tmp/ktfmt.jar --kotlinlang-style --dry-run app/src  # what CI checks
```
