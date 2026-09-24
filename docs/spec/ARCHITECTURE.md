# Airhop: Architecture

Every layer and the reasoning behind it. For what is being built and when, see
[ROADMAP.md](../design/ROADMAP.md). For exact protocol constants, see
[PROTOCOLS.md](PROTOCOLS.md).

## Table of Contents

1. [Feature Matrix](#1-feature-matrix)
2. [Identity](#2-identity)
3. [Transport Stack](#3-transport-stack)
4. [Messaging Protocol](#4-messaging-protocol)
5. [Encryption](#5-encryption)
6. [Channels and Groups](#6-channels-and-groups)
7. [Payments](#7-payments)
8. [Privacy and Tor](#8-privacy-and-tor)
9. [Threat Model](#9-threat-model)
10. [Localization](#10-localization)
11. [Codebase Layout](#11-codebase-layout)
12. [Native Modules](#12-native-modules)
13. [Decision Log](#13-decision-log)

## 1. Feature Matrix

| Feature                   | Offline (BLE)            | Online (Nostr)      | Notes                                                                                                                                                                                            |
| ------------------------- | ------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Peer discovery            | Yes, announce broadcasts | Yes, kind 20001     | Peers show on the mesh radar and in the location cell                                                                                                                                            |
| Public channels           | Yes, TTL flood           | Yes, kind 20000     | `#bluetooth` stays local; `#block` to `#region` also bridge                                                                                                                                      |
| Private channels          | Yes, sealed `0x50`       | Optional, same blob | Airhop only. Key rides an invite link, no member cap                                                                                                                                             |
| Private groups            | Yes, sealed `0x25`       | No                  | bitchat compatible. Creator-signed roster, max 16, Bluetooth only                                                                                                                                |
| Private DMs               | Yes, Noise XX (+DR)      | Yes, NIP-17 wrap    | Receipts on every path. DR only between Airhop peers                                                                                                                                             |
| Bulletin board            | Yes, signed `0x23`       | Yes, kind 1 mirror  | Public and signed, 1 to 7 day expiry, gossip catch-up. An urgent post also writes one line into the chat it belongs to                                                                           |
| Voice notes               | Yes, as a file           | No                  | Recorded AAC, not live                                                                                                                                                                           |
| Live push-to-talk         | Yes, `0x29` bursts       | No                  | AAC-LC 16 kHz mono, 350 ms jitter buffer. Also shipped by bitchat, so it works between the two                                                                                                   |
| Video sharing             | Yes, as a file           | No                  | Recorded and played inline. Live streaming is not possible across platforms                                                                                                                      |
| File transfer             | Yes, per-type caps       | No                  | 512 KiB photos and voice, 1 MiB otherwise. Enforced by bitchat's decoder, so not ours to raise                                                                                                   |
| Location pin              | Yes, sealed `0x50`       | No                  | One point in a DM, sent once. No live sharing, no map, never couriered                                                                                                                           |
| Ring                      | Yes, sealed `0x51`       | No                  | Airhop only. A doorbell for someone in range: opt-in per contact, proven per session, rings for 45 s or until answered, and every refusal is answered so the sender is never left guessing       |
| Store-and-forward courier | Yes, sealed envelope     | Yes, parked drop    | 24 hour life, as bitchat carriers enforce. Sealed to a one-time prekey for forward secrecy                                                                                                       |
| Contact verification      | Yes, QR or safety number | n/a                 | Two ways in: a camera scan, or reading a six-word safety number to each other. `source` records how keys arrived, `verification` whether a human checked. Only an in-person scan may re-pin keys |
| Panic wipe                | Yes                      | Yes                 | Panic button on Profile. Destroys keys, messages, groups, board, prekeys                                                                                                                         |
| Payments (Cashu)          | Yes, token in a message  | Yes, NIP-61 nutzap  | Transfer works offline, redemption needs internet                                                                                                                                                |
| LAN mesh                  | Yes, mDNS + TCP          | No                  | Same wire format as Bluetooth. Runs the whole mesh over a shared WiFi network or a phone hotspot, iPhone to Android unlike WiFi Aware                                                            |
| WiFi Aware                | Yes, NAN                 | No                  | Faster file transfers between two Android devices, or two iPhones. Not across platforms                                                                                                          |
| Internet gateway          | Relays for others        | Yes                 | Off by default. Carries public location traffic for offline peers                                                                                                                                |
| Tor routing               | n/a                      | Yes                 | Embedded Arti on both. BLE is local, so nothing to route                                                                                                                                         |
| Relay discovery           | n/a                      | Yes                 | Bundled CSV, refreshed from the georelays repo                                                                                                                                                   |
| bitchat compatibility     | Yes                      | Yes                 | Same wire format both directions. Airhop-only types are ignored by bitchat                                                                                                                       |

Optional, shipped but switchable:

| Feature         | Needs internet | Notes                                                                                             |
| --------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| Cashu ecash     | Only to redeem | Tokens move device to device over the mesh                                                        |
| Lightning       | Yes            | Top up or cash out through the mint you choose (NUT-04 / NUT-05)                                  |
| Nutzaps         | Yes            | NIP-61 ecash locked to the recipient key                                                          |
| Wallet recovery | Yes            | Off by default. 12-word phrase rebuilds a balance from the mints that signed it (NUT-13 / NUT-09) |
| Local assistant | No             | On-device inference, nothing leaves the phone                                                     |
| AT Protocol     | Yes            | Opt-in bridge to Bluesky using the Airhop identity                                                |
| ActivityPub     | Yes            | Opt-in bridge to Mastodon using the Airhop identity                                               |

## 2. Identity

An Airhop identity is a key pair generated on the device, stored in the OS
keychain, and never transmitted to any server. There are no accounts.

### Key pair

```
Identity
├── Noise Static Key   (X25519)     - session encryption (Noise XX handshake)
├── Signing Key        (Ed25519)    - packet, board, prekey and group authentication
├── Nostr Key          (secp256k1)  - derived from the signing key; the Nostr identity
└── Peer ID            (string)     - SHA-256(noiseStaticPub).slice(0, 8 bytes), 16 hex chars
```

Nostr uses secp256k1, so the Ed25519 signing key cannot serve as an `npub`. The
Nostr key is derived from it by HKDF (`deriveNostrPrivKey`), which gives one root
identity a single stable Nostr identity across mesh, relays and payments with no
link to a phone number or email. Location channels derive a further per-geohash
secp256k1 identity, so presence in one cell cannot be linked to another.

### Names

Usernames are derived from the public key, never chosen:

```
peerID 3a9f2c1b -> "swift-falcon-3a9f"
```

A name cannot be claimed without the key it comes from, so no Airhop user can
take another's. It does not make impersonation impossible on the mesh: a bitchat
peer chooses its own nickname freely and Airhop renders what it announces, which
is why a public-channel sender is always shown with a `#last4` suffix taken from
the peer ID.

Your generated nickname is fixed after setup. Real identity is confirmed
separately, two ways:

- **Scanning their QR in person.** The camera witnesses the exchange, so this is
  also the only route allowed to re-pin keys already bound to a peer ID.
- **Comparing a safety number.** Six words derived from both parties' Noise and
  signing keys, identical on both phones, read to each other over a channel they
  trust. Confirms keys already held rather than importing any, so it grants no
  re-pinning power and needs none. This is what lets somebody you can only reach
  by call or radio be verified at all.

Both earn the same badge. `source` records how the keys arrived (`qr`, `link` or
`manual`), `verification` records whether a human has checked them; they are
independent, so a contact learned from a link can be verified on a call.

Either person may assign the other a local nickname once their keys are held.
That label never leaves the device and never touches the cryptographic identity,
and the sheet keeps showing the name the peer chose beside it.

### Anti-impersonation

- Every packet carries an Ed25519 signature from the sender.
- Receivers verify signatures before displaying or acting on a message.
- Unsigned and invalid-signature packets are dropped before display.
- Relaying is separate from verification. A node forwards opaque bytes it may not
  be able to check, since it may not hold the sender's key yet, and the flood
  router runs before per-type verification.

### Key storage

| Secret                 | Storage                       | Backed by                         |
| ---------------------- | ----------------------------- | --------------------------------- |
| `noiseStaticPrivKey`   | `expo-secure-store`           | iOS Keychain / Android Keystore   |
| `signingPrivKey`       | `expo-secure-store`           | iOS Keychain / Android Keystore   |
| Wallet AES-256 key     | `expo-secure-store`           | iOS Keychain / Android Keystore   |
| Nutzap P2PK privkey    | `expo-secure-store`           | iOS Keychain / Android Keystore   |
| Recovery phrase        | `expo-secure-store`           | iOS Keychain / Android Keystore   |
| Cashu proofs           | `react-native-mmkv` (AES-256) | File encrypted with the key above |
| Noise and DR sessions  | Memory only                   | Not persisted                     |
| Group and channel keys | `react-native-mmkv`           | See "Data at rest" below          |
| Message history        | `react-native-mmkv`           | See "Data at rest" below          |

All five go through `src/core/crypto/keychain.ts`; nothing else calls
`expo-secure-store` directly. The module exports a union type of the item names,
so a caller cannot write a secret outside the registry.

That registry is what the panic wipe walks, since `expo-secure-store` has no
delete-all. A secret stored under an ad-hoc key would survive the wipe. Every
item is attempted even after one fails, and anything left behind is reported as
`keysDestroyed: false` rather than as success.

Items are written `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` rather than the
`WHEN_UNLOCKED` default. `AFTER_FIRST_UNLOCK` because iOS relaunches the app on a
BLE event after termination and that relaunch must load the identity to join the
mesh; `WHEN_UNLOCKED` refuses the read on a locked phone. `THIS_DEVICE_ONLY`
because the default class is included in encrypted iCloud and iTunes backups and
restorable onto another device. The trade is that the keychain is unreadable
between boot and the first unlock.

### Storage key names

Three families of string, all currently at `v1`.

| Family                    | Shape                        | Example                 | Renaming costs                      |
| ------------------------- | ---------------------------- | ----------------------- | ----------------------------------- |
| Keychain item             | `airhop.<domain>.<thing>.v1` | `airhop.wallet.p2pk.v1` | The secret becomes unreachable      |
| HKDF domain separator     | `airhop-<purpose>-v1`        | `airhop-dr-root-v1`     | Every key derived from it changes   |
| Persisted store / MMKV id | `<name>-store`               | `wallet-store`          | The user's data becomes unreachable |

The third family has three names that predate the convention: `airhop-chat`,
`wallet-state` (beside the `wallet-store` partition), and `activity`. They stay
as they are. A persisted name is the address of the data, not a label on it, so
renaming one points the next launch at a file that has never been written while
the old data stays on disk with nothing referencing it. No store declares a
`migrate`. Changing these safely means a per-store migration that reads the old
name and writes the new, shipped at least one release before the old name is
dropped.

### Wallet partition

Cashu proofs are bearer instruments, so `wallet-store` is the one MMKV partition
opened with an explicit `encryptionKey`. The key is 24 random bytes, base64
encoded to the 32 ASCII characters AES-256 allows, generated on first run and
held in the keychain. It is fetched asynchronously, so the store cannot exist at
module scope: `bootstrapWalletStorage()` opens it and every `zustand/persist`
read and write awaits that promise. If the keychain refuses, the wallet reports
itself locked rather than opening unencrypted, and no proof reaches plaintext
disk.

The panic wipe empties an open partition with `clearAll`, since `deleteMMKV`
would free the native instance under a write still in flight, and uses
`deleteMMKV` only when nothing opened it. Either way the same wipe destroys the
key, so what stays on disk cannot be read.

### Data at rest

Outside the keychain, only the wallet partition carries a key of Airhop's own.
The rest (the other MMKV stores, Arti's state, and attachments in the cache
directory) relies on the OS: iOS Data Protection and Android file-based
encryption, keyed to the device passcode, with the same after-first-unlock
availability as the keychain items. A second key held in this phone's keychain
would add nothing against someone who can read the app's files on an unlocked
phone, since they can use the keychain too, and it would make every store open
asynchronously, as the wallet does.

What such a key would stop is a copy leaving the phone, and that is closed at
the source instead. Nothing is backed up or transferred:

- **iOS:** `AppDelegate` marks `Documents/mmkv` and `Application Support/airhop`
  (Arti's guards and consensus) excluded from iCloud and iTunes backup on every
  launch, before JS runs. The cache directory is never backed up.
- **Android:** `allowBackup="false"`, plus `data_extraction_rules.xml` excluding
  every domain from cloud backup and device-to-device transfer. On Android 12+,
  `allowBackup` alone leaves device-to-device transfer on for some
  manufacturers.

Nothing is lost by it. A restored copy would not bring Airhop back, since the
identity is a this-device-only keychain item, so a backup only ever copied the
data off the phone. Moving to a new phone belongs to an in-app transfer that
moves the identity rather than cloning it, which is not built yet.

## 3. Transport Stack

Messages route through the best available transport with no user involvement.
The interface is the same whichever radio carries the message.

```
MessageRouter.ts - transport selection

Local radios, used together:
  BLE Mesh          - recipient is nearby, confirmed by announce
  WiFi Aware        - both parties have it active and are in range (~30m), and on iOS are paired

Ordered fallbacks, tried when no local radio reaches the recipient:
1. Nostr Relay       - internet available, recipient confirmed offline
2. Courier           - everything else failed (spray-and-wait through mesh peers)
```

The two local radios are not a priority ladder. A message addressed to a peer is
TTL bounded and flooded on every link the device has, because no node knows the
mesh topology and the recipient may be several hops away. WiFi and BLE therefore
carry the same packet at the same time, and a packet that enters on one radio is
relayed out on the other. Duplicates are collapsed by the seen set and by a
sender generated message ID, so a message is displayed once however many radios
delivered it.

The one place a radio is chosen rather than used alongside the other is the
direct link shortcut. Once a peer has been mapped to a specific link, a packet
addressed to it goes over WiFi if that mapping is a WiFi link, since the point of
the fast path is to move an attachment that BLE would have to fragment into
hundreds of writes. This is an optimization, not the delivery guarantee.

### BLE mesh

Identical to bitchat's design:

- Dual-role: every device is both GATT Central (scanner) and GATT Peripheral (advertiser)
- Service UUID `F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5C`, bitchat-compatible
- TTL 7 hops, decremented per relay
- Jitter of 10 to 220 ms before relay, which prevents cascade storms
- Dedup against a 1000-entry LRU seen-set, 5 minute nonce expiry
- Fragments of 467 data bytes inside a 512-byte frame, the BLE write ceiling
- Up to 128 concurrent reassemblies
- Range of roughly 30 to 50 m per hop, so 7 hops reaches about 350 m

### LAN transport

WiFi Aware is a radio protocol rather than a way of using a network: two phones
on the same router cannot reach each other over it, and it cannot cross
platforms, because Apple demands a paired data path that Android cannot
complete. So an iPhone and an Android sharing a WiFi network have no local path
between them, which is the gap on a ship, in a hotel, at a conference, or
anywhere with WiFi and no route out.

mDNS discovery on `_airhop-lan-v1._tcp` plus TCP links closes it. The links carry
the same packet frames BLE carries, so the mesh engine needs no new concept and
the wire format does not move. It sits beside WiFi Aware rather than replacing
it: Aware needs no network at all, which mDNS cannot do, and mDNS reaches
everyone on a network, which Aware cannot. The service name is kept apart from
Aware's `_airhop-mesh-v1._tcp` so neither reads as a typo of the other.

Two decisions are unique to it.

**Who to connect to.** Bluetooth answers this with physics: the radio holds six
or so links and refuses more. mDNS returns the whole network, and taking all of
it is quadratic. Thirty phones fully connected is 435 sockets, and one broadcast
costs 841 writes instead of 29 because every phone relays to everyone it holds
and the deduplicator discards the copies; a channel photo turns that into
millions of writes for one file. The arithmetic is not LAN's. Bluetooth is saved
from it only by the radio refusing the links.

So LAN caps at 8, sized against bitchat's `bleMaxCentralLinks` of 6, which keeps
a LAN room reading the way a Bluetooth room does to every constant tuned for
Bluetooth density. Names are sorted into one ring and a device links to the four
either side of it, dialling only those sorting after its own so no pair is
dialled twice. Both ends compute the same ring, so they agree without
negotiating, and below the cap the ring wraps and everyone is a neighbour, which
is right for a hotspot. `src/services/lan-dial-policy.ts` holds the rule as a
pure function; the native modules open the sockets they are told to.

**What to publish.** The instance name is random and minted per publishing
session, never the peer ID: an mDNS record is cleartext to the network and is
logged by ordinary infrastructure, so a stable name would let anyone holding
logs from two networks link them. The ring sorts on that random name, so
discovery needs no durable identifier, and identity is proven in the ANNOUNCE
once the link is up.

This is the only transport off by default. Publishing tells every device on the
network, and whoever runs it, that this phone is carrying Airhop, which on a
workplace or venue network is an attendance list. The Settings copy says that
rather than selling the speed.

Links carry the same liveness as Wi-Fi Aware: a zero-length heartbeat every
8 s, closed after 30 s of silence, on both platforms. A LAN link outranks
Bluetooth for a peer held on both, so a phone that walked off the network
without a FIN must be noticed in seconds rather than minutes or every DM to it
goes into a dead socket. Dials time out at 5 s on both platforms; on iOS a
connection left `.waiting` by a network that drops peer traffic is treated as a
failed dial, since Network framework would otherwise wait for a better path
forever.

| Constraint       | Consequence                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Client isolation | Most guest and venue WiFi blocks peer-to-peer traffic at the access point, and it cannot be detected before trying. The UI has to say "No Airhop devices on this network" rather than spin                                                                                                                         |
| mDNS filtering   | Common even where ordinary traffic works. A manual join by address covers it                                                                                                                                                                                                                                       |
| iOS background   | A TCP socket has no equivalent of `bluetooth-central`, and a suspended app has its listener reclaimed without getting it back on resume. Foreground only, which WiFi Aware already is on iOS                                                                                                                       |
| Hotspot hosts    | A phone sharing its connection serves the network rather than joins it, so `ConnectivityManager` has no `Network` for it. Availability is read off the interfaces instead. Android has served mDNS on that interface since 13; below that the host sees an empty network, which reads the same as client isolation |

### Same-platform WiFi

Both platforms run WiFi Aware, the Wi-Fi Alliance's NAN: the same service name,
the same length-prefixed frames, one TypeScript contract
(`src/bridge/NativeAirhopWiFi.ts`) and one reconciler
(`src/services/wifi-controller.ts`). The mesh engine sees the same `Transport`
interface it sees for BLE.

> [!IMPORTANT]
> It is not a cross-platform path. Apple requires a paired device for every data
> path and refuses an open one; Android cannot complete Apple's pairing. So this
> is an Android-to-Android or iPhone-to-iPhone accelerator, and anything crossing
> platforms uses Bluetooth, LAN or Nostr.

| Platform | Framework                                                                                | Floor             | Notes                                                                                                                                                                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android  | [`WifiAwareManager`](https://developer.android.com/develop/connectivity/wifi/wifi-aware) | API 29            | The peer's address is a link-local IPv6 in `WifiAwareNetworkInfo`, which does not exist below 29, so the module is not registered there and TypeScript reads its absence as unsupported. Android 17 gates the socket behind `ACCESS_LOCAL_NETWORK`, already declared |
| iOS      | [`WiFiAware`](https://developer.apple.com/documentation/WiFiAware) on Network framework  | iOS 26, iPhone 12 | Needs the `com.apple.developer.wifi-aware` entitlement, a managed capability, and the service under `WiFiAwareServices` in `Info.plist`                                                                                                                              |

Neither has a power policy of its own. `src/services/power-policy.ts` scales
the BLE radios and leaves this one alone: the OS withdraws Aware under battery
saver, which arrives as `availabilityChanged(false)` and the controller's retry
ladder.

An attachment crosses at link speed. The 467-byte fragments stay, since the
receiver reassembles by index and the next hop may be Bluetooth, but the 25 ms
gap between them goes: it exists because the BLE stack drops writes handed over
faster than it can make them, and a socket has flow control of its own.
`src/services/file-transfer-service.ts` paces on one question, whether anything
on the path touches the Bluetooth radio.

**Android.** Three framework facts decide the module's shape. A subscriber is
told about a peer once: the framework subscribes with `MATCH_ONCE` and match
expiry off, so `onServiceDiscovered` fires a single time per peer per subscribe
session. Follow-up messages are best effort and arrive dropped, reordered or
twice. And a data path that is released, replaced or lost destroys every socket
on it, which the far side sees as `ECONNABORTED`.

So connecting is a per-peer state machine driven by a 15 s maintenance tick
rather than a chain of reactions to callbacks. A peer is keyed by the 8-byte
instance id it advertises beside its tiebreak token and keeps the handles both
discovery sessions issued for it. The connect request carries an attempt epoch:
a repeat gets another ready, a newer one replaces what the last attempt left.
The request (12 s), the data path (30 s) and the connect (750 ms to settle, then
three tries) each have a deadline, and a failure returns the peer to idle with a
backoff of 3 s doubling to a minute. The lower token dials at once and the other
side dials after 20 s if nothing has happened, since discovery is often
one-directional; crossed dials are settled by the same tokens on both ends.
bitchat/android reaches the same place with a maintenance loop and explicit role
reversal.

A hello naming the sender is the first frame on every socket, both ways, so an
accepted socket is attributed to its peer and a peer holds one link, the newest.
After it both ends send a zero-length heartbeat every 8 s and close after 30 s of
silence, or after 5 s with no hello at all.

Discovery is reopened under the same attach, keeping the links, after a session
the framework ended (with a rebuild if it keeps happening), after three idle
minutes with no link, and when a peer has failed four attempts over two minutes.
`availabilityChanged(false)` means the radio is gone or the attach must be
rebuilt, nothing less, so the JS ladder is a backstop rather than the recovery
path. The ladder also carries a breaker: three sessions the framework ends
within three minutes of attaching, inside a quarter of an hour, pause the
transport for the session, because on some phones opening a data path resets
the Wi-Fi chip and a plain retry would drop the router connection once a minute
for as long as the app runs. A radio the user switched off never counts; the
drop names which it was. The transport has a switch on the Network screen, on
by default, and flipping it is what clears the breaker. The module keeps its own event log and peer table for Diagnostics
(`dumpState()`), because Samsung retail builds drop every informational logcat
line.

**iOS.** The browser reports a device once and stays silent while it remains in range, so a link that ends is redialled by both sides after 2 s, doubling to a minute, and the tiebreak collapses the pair. Three constraints are Apple's, and each shapes the code:

| Constraint                                                                                                                                        | Consequence                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No unpaired mode. Every target a listener or browser can name comes from the app's paired list, and the only way into that list is a system sheet | A pairing gate in the controller, a second native module for the sheet (`AirhopWiFiPairing`), and an `unpaired` state that is reported rather than retried, because only a pairing changes it |
| Discovery is symmetric and there is no `serviceSpecificInfo` to break a tie with before connecting                                                | An 8-byte token exchanged as the first frame of every connection. Both ends keep the one whose initiator holds the lower token, and the loser is closed before TypeScript hears of it         |
| `NetworkConnection` has no cancel; a connection ends when its last reference is dropped                                                           | One task per link owns its connection for the link's life. Closing means cancelling that task, and the framework owns liveness, so there is no heartbeat                                      |

Pairing is two-sided, like Bluetooth pairing: one phone browses and the other
advertises at the same moment. That is a user-visible cost with no one-tap
version to build, so it lives on one screen (Settings, Network) that says which
half each person is playing.

### Nostr

- 300+ public relays from the georelays dataset, bundled as `assets/data/nostr_relays.csv`
- Relays selected by [Haversine](https://en.wikipedia.org/wiki/Haversine_formula) distance from the device, for lowest latency
- NIP-17-shaped gift-wrap for private DMs, so no message content or metadata reaches relays. The layering is NIP-17's; the encryption inside each layer is bitchat's `nip44-v2` rather than the published NIP-44, and has to be, since the event signature covers the ciphertext and interop is byte-for-byte. See [PROTOCOLS.md section 7.1](PROTOCOLS.md#71-the-nostr-dm-construction-is-not-the-published-nip-44)
- Kinds 20000 and 20001 for geohash channels and presence heartbeats
- `SimplePool` connects to 3 to 5 relays at once and takes the first ACK, so no single relay is load-bearing
- nostr-tools retries a relay that drops, but never one whose first connect fails, so a pool is built only when it has a route: with Tor on, it waits for the circuit
- A network coming back is one debounced event (`src/services/reachability.ts`), not a wait on a timer: it rebuilds the pool when the network it was built on has gone or no relay is live, re-checks Tor, retries queued mail and settles wallet leftovers. A nudge only; nothing refuses to connect because the OS reports no network, since the mesh is offline-first and a captive portal reads as connected
- Tor off by default on both platforms, behind one toggle

### Radio power policy (Android)

BLE scanning is the largest battery cost in the app. A continuous
`SCAN_MODE_LOW_LATENCY` scan costs roughly an order of magnitude more than
`SCAN_MODE_LOW_POWER`, and the app is meant to run in a pocket all day, so the
radios scale with what the device can afford.

Policy lives in TypeScript, mechanism in Kotlin. `src/services/power-policy.ts`
is a pure function of five facts; the native module reports the battery and the
OS Battery Saver switch and applies whichever mode it is given, and decides
nothing itself. This keeps the
decision testable without a device and puts "how hard to run the radios" beside
"whether to run them at all" in `src/services/radio-controller.ts`.

Battery bands match bitchat-android's `AppConstants.Power`: critical at `≤10%`,
low at `≤20%`.

| Mode              | Scan          | Advertise     | TX power    | RSSI poll | Duty cycle      |
| ----------------- | ------------- | ------------- | ----------- | --------- | --------------- |
| `performance`     | `LOW_LATENCY` | `LOW_LATENCY` | `HIGH`      | 5s        | continuous      |
| `balanced`        | `BALANCED`    | `BALANCED`    | `MEDIUM`    | 10s       | continuous      |
| `power-saver`     | `LOW_POWER`   | `LOW_POWER`   | `LOW`       | 30s       | 2s on / 28s off |
| `ultra-low-power` | `LOW_POWER`   | `LOW_POWER`   | `ULTRA_LOW` | 60s       | 1s on / 29s off |

Selection order follows bitchat's `PowerProfileResolver`, with one input added,
and the order carries the policy:

1. Backgrounded gives `power-saver`, or `ultra-low-power` on a critical battery.
   Nobody is waiting on discovery latency off screen, and this is where a phone
   spends nearly all of its day.
2. Battery Saver on gives the same two answers in the foreground. It is the user
   saying outright to spend less, so it outranks the charger, which only implies
   what they can afford. Android turns it off on the charger by default, so the
   two rarely meet. bitchat does not read it.
3. Charging in the foreground gives `performance`, since the cost is someone else's.
4. Otherwise the battery band decides: critical gives `ultra-low-power`, low
   gives `power-saver`, anything else gives `balanced`.

Foreground on battery is `balanced` rather than `performance` because a balanced
scan still finds peers within seconds, and reserving the most expensive setting
for "plugged in" is what stops the app being the reason a phone dies.

> [!NOTE]
> The five knobs move together. A duty-cycled `LOW_POWER` scan beside a
> `LOW_LATENCY` advertise at full TX power saves almost nothing, since the
> advertiser transmits continuously either way.

Hysteresis is Airhop's addition. bitchat re-resolves on every
`ACTION_BATTERY_CHANGED`, which fires per 1%, so a phone hovering at a threshold
flips modes repeatedly and every flip restarts the scanner. Dropping into a lower
band is immediate, since running hard on a nearly flat phone is the failure that
matters; climbing back out needs `+3%`.

The duty cycle is invisible above the native boundary. JS asks for scanning and
keeps getting it while native decides the rate. A burst ending is never reported
as an adapter or link change, or the reconciler would try to repair a state that
is working correctly.

In the foreground on a low battery or under Battery Saver, peers can take up to
half a minute to appear,
which is indistinguishable from a broken mesh unless it is stated. The Mesh tab
shows a muted `Battery saver · scanning less often` note, with no button since
charging or leaving Battery Saver is the fix, and no dismiss since it clears
itself. It stays silent while
backgrounded, where nobody is waiting on the scan.

> [!IMPORTANT]
> iOS is a declared no-op. CoreBluetooth exposes no scan-rate control and already
> throttles background BLE aggressively. `setPowerMode` exists on both platforms
> so the shared reconciler has one code path, and `getRadioState` reports
> `batteryPercent: -1` there, which the policy reads as unknown and leaves the
> mode alone. Low Power Mode is reported as `powerSaveMode: false` for the same
> reason: the OS already throttles BLE under it, and reading it would only raise
> a "scanning less often" note for a change nothing here can make.

## 4. Messaging Protocol

### Wire format (bitchat v2)

Airhop is wire-compatible with bitchat in both directions. Airhop nodes appear as
ordinary peers to bitchat devices, and bitchat drops Airhop's extension packet
types as unknown without disruption.

> See [`PROTOCOLS.md`](PROTOCOLS.md) for the [byte layout](PROTOCOLS.md#2-packet-frame-layout), [packet type registry](PROTOCOLS.md#3-packet-type-registry), [routing constants](PROTOCOLS.md#4-routing-constants) and every other protocol constant.

### Routing

| Traffic          | Method                                                             |
| ---------------- | ------------------------------------------------------------------ |
| Public channel   | TTL flood; every peer rebroadcasts with TTL decremented            |
| Direct message   | Flood with a recipient ID; only the recipient decrypts             |
| Courier envelope | Spray-and-wait; trusted peers carry sealed blobs for offline peers |

## 5. Encryption

### Sessions: Noise XX

```
Protocol: Noise_XX_25519_ChaChaPoly_SHA256
```

Used for every live DM session, over whichever direct link the peer is on.

- Pattern XX mutually authenticates both parties, each sending their static key encrypted
- Ephemeral keys are fresh per session, so a leaked static key does not expose past sessions
- Neither party can prove to a third party what was said

The handshake produces `send` and `recv` keys. Messages are then encrypted with
[ChaCha20-Poly1305](https://datatracker.ietf.org/doc/html/rfc7539) under a counter
nonce, which prevents replay.

### Stored messages: [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/)

Used for DMs held in the courier and the offline outbox.

- Per-message forward secrecy: compromise of message N does not expose N-1 or N+1
- Break-in recovery: if current keys leak, future messages are protected again after a few ratchet steps
- One-time prekeys are signed and gossiped over the mesh as `0x24`, never published to Nostr. A sender seals courier mail to one, so undelivered mail stays protected even if the recipient's long-lived key leaks later

X3DH is not used, since the Noise handshake already seeds the ratchet.

The seed is the handshake's exporter secret, a third HKDF output of `split()`
alongside the two transport keys, descending from the Noise chaining key. Both
sides already hold it, so it costs no extra round trips, and because the chaining
key absorbs ephemeral DH outputs whose private halves are destroyed at split, it
cannot be reconstructed from long-term keys. It must not be the transcript hash:
`mixHash` absorbs only bytes that went over the wire, so that value is public to
anyone who captured the handshake, and handshakes flood the mesh at TTL 7. Nor a
static-static ECDH, which would stay derivable from long-term keys forever.

### Packet signing: [Ed25519](https://ed25519.cr.yp.to/)

- Signed before transmission, verified before display or action
- The signature covers every packet field except TTL and the signature itself
- Replay is bounded by a millisecond timestamp plus a deduplicator that rejects any packet ID already seen. There is no nonce field. Where staleness is itself the attack, a freshness window backs this up: 15 minutes for announces, 30 seconds for live voice. The deduplicator is per-device and cannot speak for a phone that never heard the original

### Summary

| Traffic          | Protection                                                                 |
| ---------------- | -------------------------------------------------------------------------- |
| Live DM session  | Noise XX: mutual auth, forward secrecy per session                         |
| Stored DM        | Double Ratchet: forward secrecy per message                                |
| Public channel   | Plaintext plus Ed25519 signature, readable by every peer                   |
| Courier envelope | Noise X one-way seal to the recipient's static key, wrapping DR ciphertext |
| Nostr DM         | bitchat's `nip44-v2` inside a NIP-17-shaped gift-wrap. See below           |

## 6. Channels and Groups

### Mesh channels

Channels are prefixed with `#`, as in bitchat, and are registered nowhere.
Anyone broadcasting on `#channel-name` participates.

- No server and no registration
- A 6 hour public message window, reconciled by gossip sync on connect
- A channel exists as soon as someone broadcasts on it; there is no membership advertisement
- Moderation is a client-side block list; muted peer IDs are not surfaced

### Private channels (Airhop only)

An invite-only room. A symmetric key is generated at creation and travels inside
the invite link, so anyone holding the link can read. There is no roster and no
member cap, so the link can spread faster than anyone could add people by hand.

- Sealed with XChaCha20-Poly1305 and broadcast as `0x50`
- Reach is the creator's choice: Bluetooth only, or Bluetooth plus Nostr, where the same sealed blob is published so out-of-range members receive it
- bitchat relays `0x50` without interpreting it, so the two coexist

### Private groups (bitchat compatible)

A fixed set of people rather than a place. The creator signs a roster of up to 16
members and delivers the group key to each member inside their Noise session. No
link exists, so nobody can forward their way in.

- Messages are sealed with ChaCha20-Poly1305 under the current epoch key and broadcast as `0x25`, with group ID and epoch in the clear so relays can carry them
- Bluetooth only. Group messages do not bridge to Nostr, so a member who walks out of range stops receiving until they return
- Rotating the key bumps the epoch; older epochs are refused
- A group pins the `creatorFingerprint` it was created with, and a state naming a different creator is refused even at a higher epoch

### NIP-29 was not used

Relay-hosted groups put membership enforcement on a relay, which makes a server
the authority on who may speak. Both models above keep that decision on the
devices holding the keys.

### One channel, two transports

A public location channel exists on both transports at once:

1. BLE mesh when offline, relaying through nearby devices
2. Nostr when internet is available, through relays chosen near the cell

Reconnecting after time offline reconciles the gap through GCS gossip sync, the
mechanism bitchat uses.

A teleported cell is the exception. When a user opens a location channel by its
geohash rather than by being there, nobody in Bluetooth range is in it, so it runs
over Nostr only. Its messages carry a `t=teleport` tag, and bitchat lists the
sender as teleported rather than nearby.

## 7. Payments

### Why Cashu

Cashu is Chaumian ecash: a token is a string that carries value, signed blind so
the mint cannot link issuance to redemption. That fits a mesh app.

- Transfer is offline. A token sent over BLE moves the value at once, and whoever holds it owns it.
- Only the mint knows whether a proof is spent, so a received token is confirmed by a swap once the mint is reachable.
- Redemption to Lightning needs the mint, and so the internet.

### Token in a message

A payment is a message whose body is a token string. Whatever carries text
carries it (encrypted in a DM, always signed), and the recipient sees a payment
card.

A `cashuB` token names a v2 keyset by an 8-byte short id that only the mint's
keyset list expands. When a token from a held mint names a keyset newer than the
cached list, the wallet fetches that list (on Claim, and for the card at most
once per mint and unit every five minutes) and decodes again. A mint the user has not
added is never contacted, and Claim refuses its token.

### Nutzaps (NIP-61)

Online, a payment can address a Nostr identity instead of a conversation.

1. Fetch the recipient's `kind:10019`: trusted mints and a P2PK pubkey
2. Lock proofs at one of those mints to that pubkey
3. Publish a `kind:9321` to **the recipient's** relays, where they subscribe
4. The recipient swaps it in, refusing one from a mint they do not hold

History stays local in `wallet-store`. Airhop publishes no NIP-60 events.

### Paying a person

Every entry point that pays somebody (DM attach menu, contact sheet, Mesh peer
sheet, Wallet Zap) calls `payPerson` in `services/payment-router.ts`, which
walks one ladder:

| Order | Rail   | When                                                                                       | Reclaimable |
| ----- | ------ | ------------------------------------------------------------------------------------------ | ----------- |
| 1     | Radio  | A direct BLE or WiFi link exists (`hasDirectLink`)                                         | Yes         |
| 2     | Nutzap | No radio link, their Nostr key and `kind:10019` are known, and we hold value at their mint | No          |
| 3     | Token  | Otherwise. `sendDm` picks Nostr gift-wrap, a courier or the outbox                         | Yes         |
| 4     | Manual | Nothing carried it, so the token returns for the user to hand over                         | Yes         |

Radio leads so a person in front of you does not wait on a mint, and so it
works with no internet. A nutzap beats a token because locked proofs are the
recipient's whether or not they come online.

- **One confirm.** The user is asked once, after the rail is known, and the question says whether the payment can be undone. A nutzap that fails to lock falls through to a token without asking again. An inexact token amount asks its overpay question in place of the confirm.
- **One commitment.** Proofs are reserved (rails 1, 3, 4) or P2PK-locked (rail 2), never both. A failure before committing falls through; after committing, only delivery retries. A lock whose request may have reached the mint stops the ladder.
- **Finality is reported.** `PayResult.final` is true only for nutzaps, and the result names the rail and whether Activity will offer the money back.

### Mint network gate

Every mint call passes `assertMintNetworkAllowed` in `wallet-service.ts`.

- **Internet switch off:** no mint call at all, since the switch promises Bluetooth only. The refusal is `offline`, so a received token is stored unconfirmed and checked once the switch is back on, and Lightning actions say why they are off.
- **Tor on, iOS:** refused (`tor-blocked`) unless the user allows mint calls over the clear net. Tor wraps only Nostr WebSockets there, so `fetch` would expose the IP. Android routes every socket through the proxy and needs no refusal.

`mintNetworkBlock()` gives the same answer ahead of time, so the Wallet tab shows
a banner and disables what would fail.

### Payment security model

| Attack              | Mitigation                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Double-spend        | The mint is the only authority. An offline receipt is stored unverified; `refreshAccount` runs a NUT-07 state check and a swap, and drops what is spent |
| Fake token          | NUT-12 DLEQ against the mint's cached keys on every receive. A failing witness is rejected; missing keys report "unchecked", never "valid"              |
| Inflated amount     | Amounts come from the decoded proofs, each bounded before summing, never from a declared field                                                          |
| Token interception  | DMs encrypt the token. A token posted to a public channel is redeemable by any reader, which the UI says before sending                                 |
| Interrupted send    | Proofs move to a reserved bucket and the token stays on the transaction, so a crash or an unrouted DM leaves the value reclaimable                      |
| Mint failure        | The user picks mints. Balances are per (mint, unit) and never pooled, so one failing mint cannot take the rest                                          |
| Proofs at rest      | The MMKV partition is AES-256 under a keychain-held key. Without the key the wallet locks rather than falling back to plaintext                         |
| IP linkage over Tor | The mint network gate above                                                                                                                             |

Two limits hold regardless. DLEQ proves the mint signed a proof, not that the
sender has not spent it. And reclaiming an undelivered send races the recipient:
if they also hold the token, whoever reaches the mint first keeps it, which the
UI says before reclaiming.

### Recovery

A 12-word BIP-39 phrase is generated at first launch and kept in the keychain
beside the identity keys, so every proof the wallet creates uses NUT-13
deterministic secrets. NUT-09 restore re-derives them on any device and asks
each mint which it signed, so the balance is rebuilt from the mint's records,
not a backup file. What starts off is the backup, because "covered" is a promise
about the person, not the crypto: `backupEnabled` records that the user has seen
the words and `backupVerified` that they proved they wrote them down. The
recovery phrase row reads safe only with both, since a phrase never copied out
looks protected and is not.

| Coverage |                                                                                             |
| -------- | ------------------------------------------------------------------------------------------- |
| Covers   | Ecash derived from the phrase, at mints the user re-adds                                    |
| Excludes | The Airhop identity, chats, contacts and the mint list                                      |
| Excludes | Coins received and not yet swapped, which carry the sender's secrets until `refreshAccount` |

- The keychain is the source of truth. If the phrase is missing, startup clears `backupEnabled` and every `derived` mark, then seeds a fresh phrase. If the keychain refuses the write, secrets fall back to random and nothing claims coverage.
- `StoredProof.derived` marks what the phrase can rebuild, and the UI shows the uncovered remainder.
- Backup cannot be turned off, since deleting a phrase coins derive from deletes the coins. Only the panic wipe removes it.
- The per-keyset counter only moves forward, and restore pushes it past everything the mint has signed. A reused counter recreates a signed secret, the mint rejects the swap and the inputs are untouched, so the failure is a retry rather than a loss.

### Fiat units

A Cashu amount is an integer in the unit's smallest denomination (NUT-00), so
150 in a `usd` keyset is 1.50 USD. `formatAmount` scales a three-letter fiat
unit by its minor digits (two, or none for ISO 4217 zero-decimal currencies such
as JPY) and labels it with the code. Only `sat` switches to BTC, and no exchange
rate is ever applied.

### Wallet tab

- **Balance card:** the primary unit's spendable balance, with unconfirmed, reserved, other-unit and pending-deposit amounts stated beside it rather than folded in (units are separate currencies and never summed), and four actions: Receive, Send, Scan and Mints.
- **Receive** lists scan a QR code, paste a token and top up over Lightning. **Send** lists create a token, zap a Nostr contact and pay a Lightning invoice. The rail is a choice inside the verb.
- **Scan** reads a token, a bolt11 invoice or an npub and opens the sheet that handles it, filled in. It never claims or pays by itself.
- **Recovery phrase row:** the backup's status, opening its sheet.
- **Activity:** sends still waiting to be claimed lead with their actions, then the latest 3 transactions, expandable.

### Wallet operations

| Operation   | Behaviour                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Balance     | Spendable proofs per (mint, unit), with unverified and reserved amounts shown apart from the headline                                                                                               |
| Deposit     | bolt11 from the mint (NUT-04), polled while the sheet is open and reconciled on next launch                                                                                                         |
| Withdraw    | Pay a bolt11 from ecash (NUT-05), quoted with the routing reserve first, unused reserve returned as change                                                                                          |
| Send        | Build a token from held proofs, fee-aware so the recipient can claim the amount asked                                                                                                               |
| Receive     | Paste, scan or claim from a message. Swapped when the mint is reachable, stored unverified when not                                                                                                 |
| Pay         | The `payPerson` ladder                                                                                                                                                                              |
| Refresh     | NUT-07 state check, then a swap of everything unverified or outside the recovery phrase                                                                                                             |
| Backup      | The 12-word phrase (NUT-13, NUT-09), with the uncovered remainder shown                                                                                                                             |
| Consolidate | A token names one mint, so two mints' ecash never combine. `consolidateMints` moves it instead: the destination mint issues an invoice and the source pays it, for one routing fee and no other app |
| History     | Every send, receive, deposit, withdrawal, nutzap and swap, with status                                                                                                                              |

## 8. Privacy and Tor

### Metadata minimization

- No phone numbers, email addresses or registered usernames
- No IP address reaches a relay while Tor is active
- NIP-17 gift-wrap hides who is talking to whom from relay operators
- BLE mesh is radio-local, requires physical proximity, and leaves no internet signature
- Geolocation is opt-in, used for geohash presence, and never stored or transmitted otherwise
- No plaintext message is written to disk, and the panic wipe destroys all keys

### Tor

Both platforms embed [Arti](https://gitlab.torproject.org/tpo/core/arti), the
Tor Project's Rust client, built from `native/arti/`: one crate, one SOCKS5
listener on `127.0.0.1:39050`, two thin FFI faces. There is no `tor` binary, no
`torrc`, no control port and no third-party app. Off by default on both.

| Platform | How it is linked                     | What it covers                               |
| -------- | ------------------------------------ | -------------------------------------------- |
| iOS      | Static library in `arti.xcframework` | Nostr relay WebSockets only                  |
| Android  | `libarti_airhop.so` in `jniLibs`     | Every socket the app opens, `fetch` included |

The coverage column is the one asymmetry, and it is a platform limit rather than
a choice. React Native on Android is OkHttp end to end, so installing the proxy
into `OkHttpClientProvider` at application start covers `fetch` and WebSocket at
once. iOS has no equivalent hook, so nostr-tools is handed a WebSocket that
speaks SOCKS5 and everything else stays outside the tunnel. That is why a Cashu
mint call is refused on iOS while Tor is on, and needs no such refusal on
Android. See [section 7](#7-payments).

Both fail closed at the socket, and for the same reason: Arti has no clearnet
path. A request made before a circuit exists fails rather than falling back, so
protection starts when the user consents rather than when the circuit finishes
forming.

Failing closed is about traffic. Failing safe is a separate promise about the
rest of the app: a bug in the Tor client must cost the user Tor and nothing else.
Two things carry it. Every FFI entry point runs inside a `catch_unwind`, so a
panic in Arti returns an error code rather than terminating a process that is
also running the Bluetooth mesh, the wallet and the courier store. And
`torStartPending` is written across the native start and read back at launch, so
a failure severe enough to end the process is not replayed by the next launch:
Tor comes up off, the Tor screen says why, and the mesh starts normally. Without
it, persisting the preference before the client exists (which is what stops a
relaunch mid-bootstrap from landing on the clear net) would turn one native crash
into an app that cannot be opened, whose only remedy is deleting the user's
keys.

Tor covers internet traffic only. BLE, WiFi Aware and LAN are local radios and
have nothing to route.

Tor hides the device IP from the relay and DM metadata from the relay operator.
On a direct connection it does not conceal that Tor is in use, since the first
hop goes to a publicly listed relay. Settings, Tor, Connection closes that: a
bridge is an unlisted entry point, and the transport in front of it disguises
the connection.

| Connection | What it hides                             | Cost                                   |
| ---------- | ----------------------------------------- | -------------------------------------- |
| Direct     | The IP, from the relay                    | None. The default                      |
| Snowflake  | That Tor is in use, with no list to block | Slowest to connect                     |
| Bridge     | That Tor is in use, over obfs4            | Public lines, some networks block them |
| Custom     | The same, from lines you supply           | You fetch them yourself                |

Bridges stay off by default: one is slower than a direct connection and only
earns that cost on a network that blocks or watches for Tor.

obfs4 and Snowflake are Go, and Arti would normally run them as the child
processes iOS forbids, so they are compiled into the app
([`native/iptproxy`](../../native/iptproxy)) and reached over loopback as
unmanaged transports. Built-in lines are synced from the Tor Project by
`.github/workflows/sync-bridges.yml`, because a list frozen at release time goes
stale between store updates and would fail exactly where a user needed it.

The client refuses to start rather than fall back: a line that does not parse, a
transport Airhop does not ship, or one whose local proxy is not running stops
the start before anything binds. A user who asked for a bridge is likely
somewhere a direct connection is unsafe.

### Building the Tor client

The binaries are committed, and both are built here rather than vendored.
`native/arti/build-in-container.sh` produces the Android libraries inside a
pinned container (Rust, NDK, Debian snapshot and `Cargo.lock` all fixed by
`TOOLCHAIN.env`), and `native/arti/build-apple.sh` produces the xcframework on
macOS. `scripts/verify-vendored.js` records every resulting file by hash and CI
fails a build whose binaries moved without the source that claims to produce
them moving too.

### Panic wipe

Triggered from the Profile screen (`src/features/settings/profile-screen.tsx`).
One tap opens a confirmation sheet; three quick taps skip it and wipe
immediately.

1. Remove every private key from the keychain
2. Clear or delete every MMKV partition, including the encrypted wallet file
3. Empty the cache directory. Not just the files Airhop prefixes: a sent
   document, a sent video, an image small enough to send unmodified and the
   saved QR card all live under other names or in the pickers' own
   subdirectories, and a prefix-only sweep leaves every one of them behind
4. Stop Arti and delete its data directory, on both platforms. It sits outside
   the media cache (Application Support on iOS, the files directory on Android)
   and holds a cached consensus, chosen guard nodes and timestamps, which is
   evidence that this device used Tor and roughly when
5. Take every delivered notification out of the system tray, and cancel any
   still scheduled (a ring pulse). Each carries a sender name and a message
   preview, and they outlive the process

The keychain step is best-effort like the rest, and the wipe continues past a
failure rather than abandoning the data. It is the one step whose outcome is
reported: `panicWipe` returns `keysDestroyed`, and the Profile screen says so
when the OS refused, because a locked keychain on a booted-but-unlocked device
is exactly the seizure case and "your keys are gone" must never be claimed
falsely.

The app is left in a first-run state and drops to onboarding. The process is not
terminated and the sandbox is not otherwise touched.

## 9. Threat Model

### The attacker

Anyone within radio range can transmit anything. They can forge any plaintext
header field (`senderID`, `ttl`, `flags`, `timestamp`), replay captured packets,
mint unlimited identities, and drop or alter anything passing through them. They
cannot break Ed25519, X25519, ChaCha20-Poly1305, or SHA-256 preimage resistance.

### Countermeasures

| Threat                             | Countermeasure                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Message forgery                    | Ed25519 signature verified against the key bound to the claimed sender. A missing key or missing SIGNED flag is a failed check, never a skipped one                                                                                                                                                                                                                                                                              |
| System-line spoofing               | A peer's `* … *` text renders as an action only when it is exactly the `/hug` or `/slap` template with the wire sender as actor and a single name as target. Anything else is a normal bubble under their name                                                                                                                                                                                                                   |
| Identity impersonation             | `peerID == SHA-256(noiseStaticPubKey)[0:16]`, enforced on announces and completed Noise sessions, so a peer ID cannot be claimed without its key                                                                                                                                                                                                                                                                                 |
| Signing-key substitution           | Two tiers. An announce is self-signed, so TOFU pinning holds the first key seen and never replaces it over the air. A key proven inside a Noise session (payload `0x21`) outranks that and may correct a pin an attacker won the race for. No announce can overwrite a proven key, and only an in-person QR scan may re-pin otherwise                                                                                            |
| Nostr key claim in an announce     | The npub a peer names for itself is a forwarding address for that peer, nothing more: first claim stands, no claim folds a thread keyed by that npub or re-addresses mail queued for it. Only a card scanned in person may. See [PROTOCOLS.md section 3.3](PROTOCOLS.md#33-noise-inner-payload-types)                                                                                                                            |
| Capability downgrade               | Announced bits are a discovery hint and never authorise a change in how we send. Encrypted private media is selected only on an authenticated capability, so nobody in radio range can force an attachment into the clear by announcing the bit off                                                                                                                                                                              |
| Replay                             | Content-derived packet IDs, a deduplicator, and a ±2 minute freshness window on every packet at ingress, so stale packets are neither relayed nor acted on. Solicited sync responses are exempt only when tagged `IS_RSR` and attributable to a request made in the last 30 s. Live voice uses a tighter 30 s window                                                                                                             |
| Sync amplification                 | `REQUEST_SYNC` and every packet answering one ride at TTL 0, so a rejoining peer's catch-up cannot re-flood the mesh. Responses to one peer are capped at 8 per 30 s                                                                                                                                                                                                                                                             |
| Man-in-the-middle (session)        | Noise XX mutual authentication, with the authenticated static key required to derive the peer ID it claims                                                                                                                                                                                                                                                                                                                       |
| Traffic analysis (Nostr)           | NIP-17 gift-wrap hides sender, recipient and content from the relay; Tor hides the IP; geohash channels use per-cell ephemeral identities                                                                                                                                                                                                                                                                                        |
| Traffic analysis (BLE)             | Payloads are encrypted and padded to fixed buckets, so an observer sees uniform random bytes                                                                                                                                                                                                                                                                                                                                     |
| Relay censorship                   | Several relays are queried in parallel, so any single relay failure is transparent                                                                                                                                                                                                                                                                                                                                               |
| Forged departure                   | A LEAVE is checked against the pinned signing key before the relay decision, so an unverifiable one is neither acted on nor passed to nodes that may check less strictly. See [PROTOCOLS.md section 3.6](PROTOCOLS.md#36-leave-is-verified-before-it-is-relayed)                                                                                                                                                                 |
| Sybil flooding                     | TTL bounds propagation. The registry and radar are capped with oldest-first eviction that never drops a peer holding a real BLE link                                                                                                                                                                                                                                                                                             |
| Key compromise (session)           | Noise XX forward secrecy, so past sessions stay safe if a static key later leaks                                                                                                                                                                                                                                                                                                                                                 |
| Key compromise (DM history)        | Double Ratchet per-message keys seeded from the Noise exporter secret rather than the public transcript hash, so the chain is not derivable by observers                                                                                                                                                                                                                                                                         |
| Malicious relay injecting messages | A relay cannot produce the sender's signature, and forwarding is separate from delivery                                                                                                                                                                                                                                                                                                                                          |
| Confused-deputy delivery           | Directed packets are relayed but rendered only by the addressee, so a relay never surfaces someone else's private content                                                                                                                                                                                                                                                                                                        |
| Group takeover                     | A group keeps the creator it was created with, and a state naming a different creator is refused even at a higher epoch. Enforced in two places, since a group state can either update or delete a group: the store pins it for every write, and `groupStateAction` pins it before the removal branch, which never reaches the store                                                                                             |
| Group eviction by a stranger       | A group ID travels in the clear on every group message so relays can carry it. Without the ordering above, anyone who saw one could craft a self-signed state naming themselves creator with a roster omitting the victim, and the victim's client would destroy its own key and drop the room. The creator pin is checked first                                                                                                 |
| Hostile payment source             | Ecash is redeemed only from a mint the user already added, and incoming proofs are DLEQ-verified before anything is stored                                                                                                                                                                                                                                                                                                       |
| Cashu double-spend                 | The mint enforces this with blind-signature tracking; the receiver redeems promptly                                                                                                                                                                                                                                                                                                                                              |
| Physical device seizure            | Panic wipe by triple-tap, with keys in the keychain, hardware-backed on modern devices. Attachments are swept on a schedule (Privacy -> Keep media for: 7 days by default, 14 or 30 by choice, with no unbounded option), so a stored photo does not outlive its conversation                                                                                                                                                    |
| Cloud backup or phone transfer     | Nothing on either platform is backed up or moved by the OS, so a backup held by Apple or Google holds no history, contacts or keys. See [Data at rest](#data-at-rest)                                                                                                                                                                                                                                                            |
| Screen surveillance                | Notification previews can be withheld (Settings, Security), since the system renders them on the lock screen. The app-switcher snapshot is covered on both platforms, hung off leaving the app rather than losing focus so a system dialog never raises it; Android needs API 33, leaving 26 to 32 exposed. Screenshots stay possible on purpose, and one taken inside a chat is announced to the other side rather than blocked |

### Out of scope

- **Physical proximity.** BLE mesh reveals that you are near certain peers.
- **A location you chose to send.** A location pin carries real coordinates. It is encrypted inside the recipient's Noise session, so no relay can read it, but the recipient holds it and can do what they like with it, including screenshotting it. Sent only on an explicit tap, to one contact, never automatically, never as a reply in kind, and never forwarded onward by the app.
- **A stable peer ID.** It derives from the long-term Noise key and does not rotate, so the same device is linkable across sessions until the identity is regenerated. Only per-cell geohash identities are ephemeral.
- **Attachment confidentiality in a public room.** A photo posted to `#bluetooth` is signed but not encrypted, exactly like the text beside it. A private attachment is sealed inside the recipient's Noise session (payload `0x20`) whenever they have proven they can read one; the signed cleartext form survives only for peers that have not, and it is the wire form bitchat is retiring. Media stays restricted to `#bluetooth` and mesh DMs, and is never bridged.
- **The fact that Tor is in use, on a direct connection.** The first hop then goes to a publicly listed relay and deep packet inspection sees it. A bridge closes this and is a setting rather than the default, because it costs speed. See [section 8](#8-privacy-and-tor).
- **Traffic timing correlation.** An observer watching several BLE radios could infer communication patterns.
- **Courier mail linkability.** The courier recipient tag is keyed on the recipient's public Noise key, which every announce broadcasts, so anyone in radio range can compute a peer's tags for any day and follow their mail. Inherited from bitchat, which documents the same flaw. Fixing it needs a coordinated v2 tag. See [PROTOCOLS.md section 6](PROTOCOLS.md#6-store-and-forward-courier-constants).
- **Authorship of a broadcast, some of the time.** A packet this phone authored leaves with a TTL drawn from 5 to 7, not the fixed maximum: channel messages, group messages, board posts, public files, and live voice with one draw per burst. That removes the deterministic "this radio wrote it" marker but not the top of the range. Announces and directed traffic keep 7.
- **Who you are talking to on the mesh.** Packet headers carry sender and recipient IDs in the clear, as bitchat's do.
- **A compromised OS.** All guarantees are void.
- **Mint trust.** Cashu requires trusting the mint to honour redemption.

Not every packet is signed. Noise handshake messages are unsigned, matching
bitchat, because the peer may not hold our signing key yet and the handshake
authenticates itself. Messages inside a Noise session or a ratchet carry no
redundant signature, since the session already authenticates them. Signatures are
required where a claimed sender is otherwise unverifiable: announces, public and
private channel messages, attachments, voice frames, board posts and gateway
uplinks.

## 10. Localization

Airhop ships in 35 languages. Every user-facing string lives in one catalog per
language under `src/i18n/locales/`, compiled into the bundle and byte-identical
on every device. Working reference:
[`.github/skills/i18n.md`](../../.github/skills/i18n.md).

### Why this sits in the spec

The app is scoped to blackouts, protests and disasters. The languages spoken
there are Persian, Arabic, Urdu, Hindi, Bengali, Punjabi, Tamil, Indonesian,
Filipino, Nepali, Ukrainian and Russian. An English-only UI during a shutdown in
Tehran or Dhaka does not reach the person it was built for.

Three of those read right to left and several are written in scripts with
rendering rules the code has to know about, so this is a correctness concern
rather than a presentation one. A mention that never fires, a name that reorders
the punctuation around it and a row frozen in last week's language are all
silent: nothing looks broken, and the feature simply does not work.

### Decisions

| Decision                                         | Rationale                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundled catalogs, never fetched                  | A translation download is a network call and a fingerprint, and it would fail in exactly the conditions this app exists for                                                                                                                                                                             |
| No i18n library                                  | i18next and react-intl bring namespaces, lazy network backends and untyped runtime keys, none of which suits an offline-first app with a bundled catalog                                                                                                                                                |
| Completeness enforced by `tsc`                   | Every locale is `Record<TranslationKey, string>` derived from `en.ts`, so a partial locale does not compile and needs no runtime fallback                                                                                                                                                               |
| Plural rules hand-written, not polyfilled        | Hermes has no `Intl.PluralRules`. 35 languages reduce to nine CLDR rule shapes, so `plurals.ts` is nine functions rather than a dependency plus a locale-data module per language. `plurals.test.ts` checks every rule against Node's ICU                                                               |
| Device language read through `Intl`              | `Intl.DateTimeFormat().resolvedOptions().locale` is present on Hermes on both platforms. `expo-localization` would mean a config plugin against native trees that must never see `prebuild`                                                                                                             |
| Translation happens at display, never at storage | A `t()` result written into MMKV freezes in the language of the day it was stored. Persisted rows keep a `systemKey` and translate on render                                                                                                                                                            |
| A right-to-left switch waits for the next launch | React Native fixes layout direction at process start and iOS has no sanctioned self-restart, so the preference is stored and applied next launch. Both facts it depends on are read rather than assumed: `I18nManager.isRTL` for the direction in force, `frameLanguage` for the language it belongs to |
| Every substituted value is bidi-isolated         | A placeholder holds text of unknown direction. Unisolated, the bidirectional algorithm resolves the punctuation around it against whichever way that text reads, so an Arabic name in an English sentence drags the comma to the wrong side. One wrap in `interpolate` covers every key                 |
| Word boundaries are Unicode, not ASCII           | A closing `[\s.,!?;:]` is the punctuation of a third of these languages, so "@name。" has to count as a mention or it passes no mute and raises no notification. Comparisons normalise to NFC, since two keyboards spell the same accented character differently                                        |
| One digit system, locale grouping                | Every number the app renders uses Latin digits, prose counts included, and `catalog.test.ts` forbids a catalog its own. Grouping still follows the locale, which is the half that helps: Hindi and Tamil group by lakh                                                                                  |
| Strings the OS renders stay where it reads them  | Passing them through the app would mean a native shim on both platforms for a permission dialog and a notification. `npm run i18n:native` holds them to the shipped set instead                                                                                                                         |
| A generated pseudolocale, debug builds only      | `qps-ploc` accents every string, brackets it and pads it past the longest real translation of the same key, so a layout can be proven against all 35 languages at once without reading any of them                                                                                                      |

### Which language each surface follows

Both platforms offer a per-app language of their own: Android 13's picker, which
`res/xml/locales_config.xml` opts into, and iOS's, which appears once a bundle
carries more than one localization. Airhop ships its own as well, because
neither exists below Android 13 and because changing a system setting is not
something to ask of somebody using this app under duress.

Two settings for one question, so the split is deliberate:

| Surface                                             | Follows              |
| --------------------------------------------------- | -------------------- |
| Everything rendered by React Native                 | The in-app picker    |
| iOS permission dialogs, Android's foreground notice | The OS per-app value |
| Reverse-geocoded place names                        | The OS per-app value |

On the default "system" preference the two agree, because the device language is
re-sampled on every foreground edge. Android needs that: it recreates the
Activity for a language change while keeping the JS context alive.

Picking a language explicitly pins the app and leaves the OS-rendered strings on
the system value. Writing through to `LocaleManager.setApplicationLocales` would
close that gap and is not done: it recreates the Activity underneath a live
mesh, in-flight transfers and possibly live voice, for five notification
strings.

### What never gets translated

Some strings cross the wire or derive an identity, so a translated variant is an
interop bug rather than a cosmetic one. `catalog.test.ts` enforces the full
list, which lives in the skill file. The two that matter here:

- **The username word lists** (`src/utils/username.ts`). A generated name must resolve identically on every device, and in bitchat.
- **The transmitted `/hug` and `/slap` text.** bitchat/ios recognises an incoming emote by matching the English substrings.

Terms of Service and Privacy Policy stay in English, with the reader chrome
around them translated. English is the authoritative version.

Nothing on the wire carries a language, a locale or a script. A Persian reader
and an English one are indistinguishable at the protocol layer, and a courier
holding sealed mail for either cannot tell them apart.

### What varies between devices

Text is identical everywhere because it is compiled in. Three things are not:

| Varies                                        | Handling                                                                                                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Intl` date and number output, per OS and OEM | Centralised in `src/utils/format.ts`, formatted in the app's language rather than the device's, with cached formatters and Latin digits throughout                                                                                                           |
| Font glyph coverage for non-Latin scripts     | JetBrains Mono covers Latin, Greek and Cyrillic and none of the other ten scripts shipped, so the monospace face is reserved for machine data: a value from a formatter or a constant may use it, a value through a catalog key is prose                     |
| Cached reverse-geocoded place names           | The OS geocoder answers in the device's language. Both native APIs accept a locale and `expo-location` exposes neither, and a native shim for a room-header label is not worth it, so `place-names-store.ts` keys its cache on that language and re-resolves |

## 11. Codebase Layout

Anything that compiles to JS lives in `src/`. Anything that touches hardware
lives in `android/` or `ios/`.

| Path               | Holds                                                                             |
| ------------------ | --------------------------------------------------------------------------------- |
| `android/`         | Kotlin BLE module and the foreground service that keeps the mesh alive            |
| `ios/`             | Swift BLE module built on CoreBluetooth                                           |
| `native/arti/`     | The embedded Tor client in Rust, and the pinned build that produces it            |
| `native/iptproxy/` | The obfs4 and Snowflake transports in Go, and the pinned build that produces them |
| `src/app/`         | The root component and the four-tab state machine                                 |
| `src/bridge/`      | TurboModule specs, the only place native and TypeScript meet                      |
| `src/core/`        | The protocol in pure TypeScript: crypto, mesh, nostr, payments, routing           |
| `src/services/`    | Long-lived runtime wiring, chiefly the mesh service that owns the radios          |
| `src/features/`    | Screens and screen-level logic                                                    |
| `src/store/`       | Zustand state with MMKV persistence                                               |
| `src/ui/`          | Shared components, hooks, and theme tokens                                        |
| `src/platform/`    | Thin wrappers over OS APIs: permissions, haptics, battery settings                |
| `src/utils/`       | Stateless helpers, free of side effects                                           |
| `src/i18n/`        | Translation runtime and the bundled English catalog                               |
| `src/__tests__/`   | Whole-app suites: the device harness, lifecycle, and the simulator                |
| `assets/data/`     | Bundled relay list, refreshed by CI                                               |

### Inside the mesh engine

`src/core/mesh/` is the one subsystem large enough to be grouped further, into
`wire/`, `routing/`, `links/`, `sync/`, `discovery/`, `rooms/`, `courier/` and
`voice/`. Two of them carry rules worth stating here:

- `wire/` is the byte layout [section 4](#4-messaging-protocol) and
  [PROTOCOLS.md](PROTOCOLS.md) describe, so a diff that changes the wire format
  shows up under one directory.
- `links/` is the one table of links the device holds, over every transport, and
  the only place bytes are written to one. It answers what is connected and
  writes down a named link; every decision about what to send, and what a
  refused write means, stays in `src/services/mesh-service.ts`.

### Module boundaries

A module specifier that leaves its top-level layer is written as a path alias
(`@core/mesh/wire/packet-codec`); one that stays inside the layer stays
relative. Aliases live in `tsconfig.json` and are mirrored in `package.json`
for jest.

`src/core/` imports nothing native, so the whole protocol is testable in CI
without a phone: the wire format, the handshakes and the routing. The radios
stay unproven until a field test.

The native layer exposes an identical TypeScript interface on both platforms, so
a fix in gossip sync fixes iOS and Android at once and protocol changes ship
together.

### Builds and CI

Gradle builds `android/` into an `.aab` and Xcode builds `ios/` into an `.ipa`,
and the stores treat the result as a fully native app.

Android is automated end to end. `ci.yml` builds a full R8-minified release on
every change, so a broken keep rule or a dependency that stops being 16 KB
aligned fails a pull request rather than a tagged release, and `release.yml`
builds and signs the shipped APK and AAB.

iOS is automated up to signing. `ci.yml` compiles an unsigned Release build on a
macOS runner, so native and release-only breakage fails the same pull request
Android does. Distribution credentials do not exist yet, so the `ios-release` job
in `release.yml` is a placeholder and the shipped `.ipa` is still produced by
hand from Xcode.

Neither platform uses EAS, and likely never will: its main draws are prebuild
and managed credentials, and this project does not run prebuild.

### Toolchain versions

Language and build-tool versions, separate from the npm dependencies in
`package.json`. Some are ours to pick; the rest arrive with React Native or
Expo and move only when those do.

Android:

| Tool                  | Version         | Pinned in                           | Ours to bump                 |
| --------------------- | --------------- | ----------------------------------- | ---------------------------- |
| JDK (Temurin)         | `21`            | `setup-android/action.yml`          | Yes, within what AGP accepts |
| Gradle                | `9.3.1`         | `android/gradle/wrapper/`           | Yes                          |
| Kotlin                | `2.1.20`        | React Native's `libs.versions.toml` | No                           |
| Android Gradle plugin | `8.12.0`        | React Native's catalog              | No                           |
| NDK                   | `27.1.12297006` | `setup-android/action.yml`          | No, matches React Native     |
| `minSdk`              | `26`            | `android/gradle.properties`         | Yes                          |
| `compileSdk`          | Expo's          | the `expo-root-project` plugin      | No, bump Expo                |

Apple:

| Tool                | Version  | Pinned in                            | Ours to bump                      |
| ------------------- | -------- | ------------------------------------ | --------------------------------- |
| Swift language mode | `5.0`    | `SWIFT_VERSION` in `project.pbxproj` | Yes, but mode 6 is a migration    |
| swift-tools-version | `5.9`    | `ios/Package.swift`                  | Yes, in step with the mode        |
| Deployment target   | `16.4`   | `project.pbxproj`                    | Yes                               |
| CocoaPods           | `1.17.0` | `ios/Podfile.lock`                   | No, the lockfile workflow owns it |

The Tor client and its transports, all in `native/arti/TOOLCHAIN.env`:

| Tool        | Version                | Note                                                             |
| ----------- | ---------------------- | ---------------------------------------------------------------- |
| Rust        | `1.98.0`               |                                                                  |
| Arti client | `0.46.0`               |                                                                  |
| cbindgen    | `0.29.4`               | Generates `arti.h`                                               |
| Go          | `1.26.8`               |                                                                  |
| IPtProxy    | `5.5.1`                | Release and commit, so a tag cannot move under us                |
| gomobile    | pinned commit          | Upstream would otherwise resolve `@latest`                       |
| NDK         | `28.2.13676358` (r28c) | Ahead of the app's: r28 gives the 16 KiB alignment Play requires |

One value, several files. Each carries a comment saying so, and a mismatch fails
a build rather than drifting quietly:

- **Deployment target**: `project.pbxproj`, `ios/Podfile`, `ios/Arti.podspec`,
  `ios/IPtProxy.podspec`, `IOS_MIN_VERSION`.
- **`minSdk`**: `android/gradle.properties`, `ANDROID_MIN_SDK`.
- **Rust**: `TOOLCHAIN.env`, `native/arti/rust-toolchain.toml`.
- **Arti client**: `TOOLCHAIN.env`, `native/arti/Cargo.toml`.
- **NDK (app)**: `setup-android/action.yml`, React Native's `ndkVersion`.

Changing anything under `native/` means rebuilding the committed binaries and
re-recording their hashes in the same commit (`node scripts/verify-vendored.js
--write`); see `native/README.md`.

## 12. Native Modules

Hardware requires native code. Routing, crypto, Nostr and payments do not, and
native code is harder to test, keep consistent across platforms and reason about.
So there is one module per hardware capability and no more.

| Module              | Platform | Capability                                               |
| ------------------- | -------- | -------------------------------------------------------- |
| `AirhopBLEModule`   | Both     | BLE GATT Peripheral and Central, radio state, power mode |
| `AirhopVoiceModule` | Both     | AAC-LC capture and playback for voice notes and PTT      |
| `AirhopWiFiModule`  | Both     | WiFi Aware same-platform fast path                       |
| `AirhopLANModule`   | Both     | mDNS discovery and the TCP links behind it               |
| `AirhopWiFiPairing` | iOS      | The system pairing sheet that fast path needs            |
| `AirhopTorModule`   | Both     | Embedded Arti's lifecycle and bootstrap status           |
| `AirhopTorSocket`   | iOS      | The SOCKS5 WebSocket that iOS needs and Android does not |

None of them knows anything about packets, routing or encryption.

### The native contract

Bridge specs live in `src/bridge/`. They are hand-maintained, not Codegen
input: the native modules are legacy bridge modules reached through the New
Architecture interop layer, and the spec shape keeps both platforms exposing
the same surface. Bytes cross base64-encoded, the only representation both
runtimes agree on safely.

`src/bridge/NativeAirhopBLE.ts` is the largest, at ten methods:

1. `startAdvertising` / `stopAdvertising`: GATT Peripheral
2. `startScanning` / `stopScanning`: GATT Central
3. `writeToLink`: raw bytes to a connected peer
4. `getRadioState`: support, power, authorization, location and battery in one answer
5. `setPowerMode`: how hard to run the radios
6. `requestEnableBluetooth` / `openLocationSettings`: one-tap fixes for the Mesh banner
7. `setBackgroundServiceEnabled`: hold the process up, independent of advertising

Nothing about Tor is asked of it. `AirhopTorModule` owns that and answers
directly; a radio module reporting on Tor would be a boundary violation.

Native calls back with eight events: `packetReceived`, `linkConnected`,
`linkDisconnected`, `rssiUpdated`, `adapterStateChanged`, `powerStateChanged`,
`scanFailed` and `meshStopRequested`.

`AirhopWiFiModule` mirrors the shape with four of its own: `packetReceived`,
`linkConnected`, `linkDisconnected` and `availabilityChanged`. The last is what
lets the fast path recover without a relaunch, and it is sent only when the
radio is gone or the attach has to be rebuilt; everything Android recovers from
on its own (a discovery session ending, a peer not answering, a data path
dropping) stays inside the module and the links survive it. Android carries
both edges, from the framework's WiFi Aware state broadcast; iOS has no such
broadcast and reports only the falling edge, so the reconciler answers a drop
with its retry ladder rather than by waiting to be told the radio came back.

`AirhopWiFiPairing` is iOS-only and not part of that contract:
pairing is a precondition to HAVING links on one platform, not a property of a
link, so folding it in would make the Kotlin module answer three questions that
mean nothing there. Two methods (`getPairingState`, `presentPairing`) and one
event (`devicesChanged`), which is also how a pairing removed in the Settings app
reaches the transport.

Anything richer would put protocol knowledge on the native side, which this
design exists to prevent.

### Background execution

| Platform | Mechanism                                           | Result                                             |
| -------- | --------------------------------------------------- | -------------------------------------------------- |
| iOS      | `UIBackgroundModes: bluetooth-central`              | Receives BLE data while backgrounded               |
| iOS      | `UIBackgroundModes: bluetooth-peripheral`           | Keeps advertising, though not visibly to Android   |
| iOS      | `CBCentralManagerOptionRestoreIdentifierKey`        | Relaunches the app on a BLE event after suspension |
| Android  | `AirhopForegroundService` (persistent notification) | Survives Doze and battery optimization             |
| Android  | `FOREGROUND_SERVICE_CONNECTED_DEVICE`               | Required for that service on Android 14+           |
| Android  | `neverForLocation` on `BLUETOOTH_SCAN`              | Delivers scan results without a location grant     |

The scan flag is what makes the rest deliver. Android treats a BLE scan as a
location access unless the manifest says otherwise, and an app counts as
foreground for location only with a visible activity or a `location`-typed
foreground service. A `connectedDevice` service does not qualify, so a
backgrounded Airhop held its process up, kept a notification reading
"Discovering and relaying nearby messages", and was handed no scan results.

bitchat solves this with `ACCESS_BACKGROUND_LOCATION` and a `location` service
type. Airhop asserts `neverForLocation` instead, which is accurate here: a scan
result is read for its service UUID, its 8-byte peer ID and its RSSI, none of
which is a position. From API 31 that removes the coupling entirely. API 26 to 30
keeps it, since the flag does not exist there; `getRadioState` reports which
regime applies through `locationRequiredForScan`, read only by `blockerFor`.

Location is still requested, but only for geohash channels, and only when the
user opens one.

A backgrounded iPhone is not discoverable from Android. Once the app leaves the
foreground, CoreBluetooth moves the service UUID into the advertisement's
overflow area and drops the local name, where only another iOS device scanning
for that exact UUID can see it. iPhone-to-iPhone still works, iPhone-to-Android
discovery stops until the app is reopened, and an already connected link keeps
carrying traffic. Android has no equivalent restriction, since the foreground
service keeps it advertising normally.

## 13. Decision Log

### Nostr over Matrix, XMPP or Signal

| Protocol        | Verdict      | Reason                                                                                                                                            |
| --------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Matrix          | Rejected     | Requires a homeserver, which is a single point of failure. Federated but not serverless                                                           |
| XMPP            | Rejected     | Also requires an always-on server, with a complex extension ecosystem and a limited offline story                                                 |
| Signal Protocol | Rejected     | Signal owns the relay infrastructure and requires a phone number, so it is not permissionless                                                     |
| SimpleX         | Close second | No persistent identifiers and privacy-first, but no BLE mesh story, a smaller ecosystem and fewer relays                                          |
| Nostr           | Chosen       | Permissionless keypair identity, 300+ independent relays, NIP-17 gift-wrap for DMs, NIP-61 for payments, and bitchat already validated the choice |

### Noise XX over TLS or X3DH

- TLS requires CAs and server certificates, which a serverless system cannot have
- X3DH alone does not mutually authenticate: the receiver does not authenticate the sender in the handshake
- Noise XX gives mutual authentication and forward secrecy with no CAs, is proven in WireGuard, and is what bitchat uses

### Relay URLs stay strict

`validateRelayUrl` refuses `ws://`, bare IP addresses, `.local`, `localhost`,
`.internal` and single-label hosts. That is deliberate and stays.

Relaxing it would compromise two things at once. Android blocks cleartext from
API 28 and its network security config cannot scope an exception to an address
range, so permitting `ws://` to a user-typed address means permitting cleartext
for the whole app, including the mint URLs that carry bearer ecash. And a
`ws://` public host would put gift-wrapped DMs on the open internet unencrypted,
which is worse than anything the change would buy.

A relay reachable only on a local network is served by the LAN transport in
[section 3](#lan-transport), which needs no cleartext exception because it does
not go through the HTTP stack at all.

### Cashu over Lightning alone

- Lightning needs internet at the moment of payment, since routing happens live
- Cashu tokens are strings that flow over BLE like any message
- Transfer is fully offline and redemption happens later
- NIP-61 integrates Cashu with Nostr identity for online payments

### Double Ratchet alongside Noise XX

- Noise XX gives forward secrecy per session, with a new key on each reconnect
- It does not give per-message forward secrecy within a session
- Double Ratchet rotates keys per message, so one message's key does not expose its neighbours
- It also covers offline mail: a ratcheted message sent by courier keeps forward secrecy while the recipient is away
