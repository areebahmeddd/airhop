---
description: >
  Reference for the boundary between TypeScript and native code. Read this before
  adding or modifying anything in android/, ios/, native/ or src/bridge/. The
  rule is simple: native code exposes raw bytes; all protocol logic lives in
  TypeScript. Putting routing, parsing, or crypto decisions in Swift or Kotlin
  is an architectural violation.
---

# Native Boundary

What Swift and Kotlin may do, what they must leave to TypeScript, and the shape every native contract takes. The module inventory and background execution are in [ARCHITECTURE.md section 12](../../docs/spec/ARCHITECTURE.md#12-native-modules).

## Key Files

| Path                                                          | Holds                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/bridge/Native*.ts`                                       | The hand-maintained contracts, one per module                                                          |
| `ios/Airhop/`                                                 | Swift modules                                                                                          |
| `android/app/src/main/java/org/onemindlabs/airhop/`           | Kotlin modules, by radio: `ble/`, `wifi/`, `lan/`, `tor/`, `voice/`, `app/`, `service/`, `transport/`  |
| `native/arti/`, `native/iptproxy/`                            | Embedded Tor client (Rust) and pluggable transports (Go)                                               |
| `src/core/mesh/links/link-registry.ts`                        | Which peer is on which link                                                                            |
| `android/app/src/test/`, `ios/Tests/`                         | Native unit tests: framing, Aware dial rules, long writes, LAN interface filter, voice playback bursts |
| `bitchat/ios/bitchat/Services/BLE/`                           | Reference iOS BLE implementation                                                                       |
| `bitchat/android/app/src/main/java/com/bitchat/android/mesh/` | Reference Android BLE implementation                                                                   |

## The Rule

Native code is a thin I/O driver. It advertises, scans, connects, writes bytes and reports bytes and state changes. Everything else is in `src/core/`.

Native does **not**:

- parse packet headers, or check TTL, flags or type;
- make routing decisions, or know what a peer ID is;
- encrypt, decrypt or sign;
- decide whom to dial. LAN native reports mDNS names and opens the sockets it is told to (`lan-controller.ts`, `lan-dial-policy.ts`); `AirhopLANModule.localSubnets` reports interface addresses and judges nothing, and `isOnLocalSubnet` in `src/core/move/local-subnet.ts` decides whether a transfer code's address may be dialled.

The one exception is Arti (`native/arti/`): a Tor client owns a SOCKS5 listener and its own lifecycle. It still knows nothing about packets, routing or encryption, and both platforms compile the same crate.

## Contract Conventions

- **Hand-maintained, not Codegen input.** `package.json` declares no `codegenConfig`. The modules are legacy bridge modules resolved through the New Architecture interop layer; the spec shape is kept so both platforms expose one surface and a Codegen migration has a starting point. No business logic in these files.
- **Bytes cross as base64 strings.** Encode before calling, decode on receipt.
- **Stream framing** on Wi-Fi Aware and LAN is `[u32 BE length][bytes]`, applied by native, byte-identical on both. BLE writes are single ATT values, 512 bytes at most; fragmentation happens in TypeScript.
- **Refuse, never pretend.** A start that cannot run rejects with a `code` the caller branches on (`RADIO_OFF`, `PERMISSION_DENIED`, `UNSUPPORTED`, `LAN_UNAVAILABLE` and so on), rather than resolving and leaving a dead radio behind a UI that believes it runs.
- **Optional modules** use `TurboModuleRegistry.get` and callers optional-chain: a missing module is an answer (unsupported), not a crash. Only `AirhopBLE` is `getEnforcing`.
- **Events** go through `NativeEventEmitter`, named `<Module>.<event>`, and every spec carries `addListener` / `removeListeners`.
- **`linkID` is opaque**, assigned by native, and names a connection, not a peer. TypeScript binds a peer to a link when that peer announces directly on it, and `LinkRegistry.peerOf` attributes later traffic. A packet's `senderID` is plaintext and forgeable, so it never decides who is on the far end.

## Modules

TurboModule specs are named `Native<Name>.ts` in `src/bridge/`, Codegen's convention and the only PascalCase file names in `src/`.

| Spec                         | Registered as         | Platforms | Purpose                                                                                       |
| ---------------------------- | --------------------- | --------- | --------------------------------------------------------------------------------------------- |
| `NativeAirhopBLE.ts`         | `"AirhopBLE"`         | Both      | BLE peripheral and central I/O, radio state, power mode                                       |
| `NativeAirhopWiFi.ts`        | `"AirhopWiFi"`        | Both      | Wi-Fi Aware I/O; same-platform only (Android API 29+, iOS 26+)                                |
| `NativeAirhopWiFiPairing.ts` | `"AirhopWiFiPairing"` | iOS       | Wi-Fi Aware pairing sheet; absent on Android                                                  |
| `NativeAirhopLAN.ts`         | `"AirhopLAN"`         | Both      | mDNS discovery and TCP links, and the device-transfer socket                                  |
| `NativeAirhopVoice.ts`       | `"AirhopVoice"`       | Both      | AAC-LC capture and playback for live voice                                                    |
| `NativeAirhopTor.ts`         | `"AirhopTorModule"`   | Both      | Arti lifecycle                                                                                |
| `NativeAirhopTorSocket.ts`   | `"AirhopTorSocket"`   | iOS       | WebSocket over Arti's SOCKS5; Android proxies OkHttp instead                                  |
| `NativeAirhopApp.ts`         | `"AirhopApp"`         | Both      | Recent log on both; restart, boot start, APK share and ring alert on Android, rejected on iOS |

`AirhopForegroundService` (Kotlin) has no spec; `setBackgroundServiceEnabled` on the BLE module drives it.

## BLE Contract

```typescript
startAdvertising(serviceUUID: string, localName: string): Promise<void>
stopAdvertising(): Promise<void>
startScanning(serviceUUIDs: string[]): Promise<void>
stopScanning(): Promise<void>
writeToLink(linkID: string, dataBase64: string): Promise<void>
getRadioState(): Promise<{ supported, poweredOn, authorization, ... }>
setPowerMode(mode: string): Promise<void>        // no-op on iOS
setBackgroundServiceEnabled(enabled: boolean): Promise<void>
requestEnableBluetooth(): Promise<boolean>
openLocationSettings(): Promise<boolean>
```

| Event                           | Payload                                             |
| ------------------------------- | --------------------------------------------------- |
| `AirhopBLE.packetReceived`      | `{ linkID, dataBase64 }`                            |
| `AirhopBLE.linkConnected`       | `{ linkID, role: "central" \| "peripheral", rssi }` |
| `AirhopBLE.linkDisconnected`    | `{ linkID }`                                        |
| `AirhopBLE.rssiUpdated`         | `{ linkID, rssi }`                                  |
| `AirhopBLE.adapterStateChanged` | `{ enabled }`, on a real change only                |
| `AirhopBLE.scanFailed`          | `{ errorCode }`, Android                            |
| `AirhopBLE.powerStateChanged`   | `{ batteryPercent, charging }`, Android, coalesced  |
| `AirhopBLE.meshStopRequested`   | `{}`, Android notification button                   |

`localName` is Android's peer ID for scan-response service data; iOS accepts it for signature parity and advertises the service UUID alone, as bitchat-ios does.

## BLE UUIDs

Both native modules hold these as constants and advertise, scan and serve on them. The `serviceUUID` arguments are part of the bridge shape and are not read; TypeScript passes the same values from [PROTOCOLS.md section 1](../../docs/spec/PROTOCOLS.md#1-ble-identifiers), so all three copies must agree.

| Identifier          | Value                                  |
| ------------------- | -------------------------------------- |
| Service UUID        | `F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5C` |
| Characteristic UUID | `A1B2C3D4-E5F6-4A5B-8C9D-0E1F2A3B4C5D` |

## One Module per Contract

There is one BLE module (`AirhopBLEModule`). Extend it; never add a second. The same holds for every radio: a new capability goes into the module that owns the radio, and a new spec exists only for a genuinely separate contract, as pairing (a precondition to having Wi-Fi links) and the Tor socket (an iOS-only shim) are.

## What Not to Do

- Parse, route, sign or encrypt in Swift or Kotlin.
- Dial, or choose whom to dial, in native.
- Resolve a start that did not happen, or crash on a missing optional module.
- Treat a `linkID` as a peer, or a `senderID` as proof of who is on a link.
- Change a UUID in one of its three places.
- Hand-edit a built binary under `ios/Frameworks/`, `android/app/src/main/jniLibs/` or `android/app/libs/`; rebuild and re-record with `node scripts/verify-vendored.js --write`.
