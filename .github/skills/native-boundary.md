---
description: >
  Reference for the boundary between TypeScript and native code. Read this before
  adding or modifying anything in android/, ios/, or src/bridge/. The rule is
  simple: native code exposes raw bytes; all protocol logic lives in TypeScript.
  Putting routing, parsing, or crypto decisions in Swift or Kotlin is an
  architectural violation.
---

# Native Boundary

## The Rule

Native modules expose raw bytes to TypeScript. That is all. No packet parsing, no routing decisions, no crypto, no peer ID awareness in Swift or Kotlin.

Every feature is implemented in `src/core/`. Native code is a thin I/O driver.

## What Native Does

- Advertise as a GATT peripheral (BLE server)
- Scan as a GATT central (BLE client)
- Write raw bytes to connected peers
- Emit events when bytes are received or connections change

## What Native Does Not Do

- Parse packet headers
- Check TTL, flags, or packet type
- Make routing decisions
- Know what a peer ID is
- Perform encryption or decryption
- Decide which addresses may be dialled. `AirhopLANModule.localSubnets` reports each local interface's IPv4 address and prefix length and judges nothing; `isOnLocalSubnet` in `src/core/move/local-subnet.ts` decides whether a transfer code's address is on one

## TurboModule Contract

The spec file is `src/bridge/NativeAirhopBLE.ts`. It is hand-maintained, not Codegen input (`package.json` declares no `codegenConfig`): the modules behind it are legacy bridge modules resolved through the New Architecture interop layer, and the spec shape is kept so both platforms expose the same surface. Do not add business logic to this file.

### Methods

```typescript
startAdvertising(serviceUUID: string, localName: string): Promise<void>
stopAdvertising(): Promise<void>
startScanning(serviceUUIDs: string[]): Promise<void>
stopScanning(): Promise<void>
writeToLink(linkID: string, dataBase64: string): Promise<void>
```

`writeToLink` takes base64-encoded bytes. The bridge transfers binary data as base64 strings for safety across the JS/native boundary. Encode before calling, decode on receipt.

### Events (NativeEventEmitter)

| Event name                   | Payload                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| `AirhopBLE.packetReceived`   | `{ linkID: string, dataBase64: string }`                            |
| `AirhopBLE.linkConnected`    | `{ linkID: string, role: 'central' \| 'peripheral', rssi: number }` |
| `AirhopBLE.linkDisconnected` | `{ linkID: string }`                                                |
| `AirhopBLE.rssiUpdated`      | `{ linkID: string, rssi: number }`                                  |

`linkID` is an opaque string assigned by the native layer. It identifies a BLE connection, not a peer. TypeScript binds a peer to a link when that peer announces directly on it, and `LinkRegistry.peerOf` is what attributes later traffic. A packet's `senderID` header is plaintext and forgeable, so it is not used to decide who is on the far end of a link.

## Naming Convention

TurboModule spec files are named `Native<Name>.ts` (PascalCase) in `src/bridge/`. That is Codegen's convention, kept so the specs can become Codegen input without a rename. It is the only place in `src/` where PascalCase file names are used.

The modules:

| File                         | Registered as         | Purpose                                                                                     |
| ---------------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `NativeAirhopBLE.ts`         | `"AirhopBLE"`         | BLE peripheral and central I/O                                                              |
| `NativeAirhopWiFi.ts`        | `"AirhopWiFi"`        | WiFi Aware fast path I/O                                                                    |
| `NativeAirhopLAN.ts`         | `"AirhopLAN"`         | mDNS discovery and TCP links, and the device-transfer socket                                |
| `NativeAirhopWiFiPairing.ts` | `"AirhopWiFiPairing"` | iOS Wi-Fi Aware pairing sheet                                                               |
| `NativeAirhopVoice.ts`       | `"AirhopVoice"`       | AAC-LC capture and playback                                                                 |
| `NativeAirhopTor.ts`         | `"AirhopTorModule"`   | Tor lifecycle (embedded Arti)                                                               |
| `NativeAirhopTorSocket.ts`   | `"AirhopTorSocket"`   | The SOCKS socket Arti fronts                                                                |
| `NativeAirhopApp.ts`         | `"AirhopApp"`         | Process-level: recent log on both; restart, boot start, APK share and ring alert on Android |

## BLE UUIDs

Both native modules hold the Service and Characteristic UUIDs as constants and advertise, scan and serve on those. The `serviceUUID` arguments to `startAdvertising` and `startScanning` are part of the bridge shape and are not read; TypeScript passes the same values from `docs/spec/PROTOCOLS.md`, so all three copies must agree.

| Identifier          | Value                                  |
| ------------------- | -------------------------------------- |
| Service UUID        | `F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5C` |
| Characteristic UUID | `A1B2C3D4-E5F6-4A5B-8C9D-0E1F2A3B4C5D` |

## One Module Only

There is one native BLE module (`AirhopBLEModule`). Do not create a second BLE module. Extend the existing one if new native capabilities are needed. The same applies to Tor and WiFi.

## Where to Read More

- `bitchat/ios/bitchat/Services/BLE/BLEService.swift`: the reference iOS BLE implementation
- `bitchat/android/.../ble/`: the reference Android implementation
- `src/bridge/NativeAirhopBLE.ts`: the hand-maintained spec
