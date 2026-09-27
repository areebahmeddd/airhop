# Airhop: Roadmap

What Airhop adds to bitchat, what each version sets out to do, and the risks the plan carries. Read it before proposing a feature. Why Airhop exists is in [VISION.md](VISION.md), how it is built in [ARCHITECTURE.md](../spec/ARCHITECTURE.md), where the build stands today in [PROGRESS.md](../dev/PROGRESS.md), and what each release shipped in [CHANGELOG.md](../dev/CHANGELOG.md).

## 1. Where Airhop Fits: Gap Analysis vs bitchat

### Gap 1: Unified Codebase

**bitchat:** bitchat-ios and bitchat-android are separate native codebases that drift. bitchat-android has no courier and no packet type for board posts, prekey bundles or private groups, so those bitchat-ios features never reach an Android user, and a constant changed on one side alone breaks interop with no error on either.

**Airhop:** One TypeScript protocol stack. A protocol bug surfaces on both platforms at once, and a fix lands on both at once.

### Gap 2: Transports Beyond Bluetooth

**bitchat:** Bluetooth only in practice, around 18 KiB/s. bitchat-android has WiFi Aware behind a debug setting that is off by default, bitchat-ios has none, and neither can use an ordinary WiFi network.

**Airhop:** Two transports beside Bluetooth, picked per link, with Bluetooth as the fallback that always works. WiFi Aware ships enabled on both platforms as the fast path between two Androids or two iPhones; Apple requires a paired data path Android cannot complete, so it never crosses platforms. LAN closes that gap with mDNS discovery and plain TCP links, carrying the same packets the radio carries. It stays off until the user turns it on, since announcing yourself on a network is visible to everyone on it.

### Gap 3: Reaching the Network Where Tor Is Blocked

**bitchat:** Routes internet traffic through Tor, with no bridges and no pluggable transports. The first hop is a publicly listed relay, so a network that blocks Tor blocks bitchat's internet half outright, and deep packet inspection sees Tor in use.

**Airhop:** The same embedded Arti, plus obfs4 and Snowflake compiled into the app. A bridge is an unlisted entry point and the transport in front of it disguises the connection, so Tor keeps working where it is blocked and stops being visible where it is watched. Bridges are off by default, since they cost speed and only earn it on such a network. Built-in bridge lines are synced from the Tor Project rather than frozen at release.

### Gap 4: Per-Message Forward Secrecy

**bitchat:** A live DM runs on one Noise XX session, so a leaked session key exposes the whole session. Courier mail exists only on bitchat-ios, sealed to a one-time prekey when it holds one and to the recipient's long-term key otherwise, where a leak of that key exposes every piece of mail still waiting.

**Airhop:** Signal's Double Ratchet inside the Noise session for Airhop-to-Airhop DMs, so every message has its own key. One-time prekeys for courier mail on both platforms, in bitchat-ios's format: bundles travel signed over the mesh and never touch Nostr, and an envelope seals to a one-time prekey, so waiting mail survives the long-term key leaking later.

### Gap 5: Files and Video

**bitchat:** Accepts 1 MiB of any type, checked as a packet is decoded; bitchat-ios keeps the photos and voice notes it sends under 512 KiB. Video crosses the wire but neither platform plays it.

**Airhop:** Matches the ceiling and the send budgets, and does not raise them: bitchat-ios rejects a packet past the ceiling while decoding it, so a higher one would break interop in both directions. One packet per file, a MIME allow-list, magic bytes checked against the extension, and the fragment layer splits it for the radio. Video rides that path and plays inline on both platforms; a bitchat peer sees an ordinary file. There is no live video: Bluetooth is too slow, WiFi Aware cannot cross platforms, and LAN needs both peers on one network with it switched on.

### Gap 6: Cashu Wallet

**bitchat:** A Cashu token decoder. It recognizes a token in a message and shows what it is worth. There is no balance, no mint, no way to spend it.

**Airhop:** A full wallet in its own tab: encrypted proof storage, per-mint accounts, Lightning in and out, Nutzaps, and a BIP-39 recovery phrase. Tokens are plain strings, so value moves device to device over Bluetooth with no server in the middle, and a bitchat peer still sees an ordinary token.

### Gap 7: Non-Technical UX

**bitchat:** The protocol work is excellent. The app around it is hard to use.

**Airhop:** This is priority one, and has been from day one. It follows the conventions Apple's Human Interface Guidelines and Material Design agree on, so it behaves the way people expect a messaging app to, and it reads in 35 languages.

## 2. Version Targets

### Shipped

What each milestone delivered, item by item, is in [PROGRESS.md](../dev/PROGRESS.md#what-exists).

| Version             | Goal                                                          | Milestone                                                                                                                                     |
| ------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.5.0              | Foundation: a BLE mesh between two phones                     | Two phones discover each other and exchange signed announces                                                                                  |
| v0.6.0              | Core messaging, bitchat wire-compatible                       | Full offline mesh chat, with Airhop to bitchat delivery verified                                                                              |
| v0.7.0              | Internet bridge and live voice                                | DMs across a city over Nostr, through embedded Arti on both platforms; live push-to-talk over BLE, interoperating with bitchat                |
| v0.8.0              | Identity and forward secrecy                                  | Double Ratchet passing its tests; courier mail survives the recipient's long-term key leaking; a scanned card is trusted, a linked one is not |
| v0.9.0              | Two transports beside Bluetooth, one fast, one cross-platform | Attachments over same-platform WiFi Aware; an iPhone and an Android carrying the mesh over shared WiFi with Bluetooth idle                    |
| v0.9.5              | 35 languages, with the compiler enforcing completeness        | Every screen reads from the catalogs, and CI cannot regress it                                                                                |
| v0.9.6              | A real wallet, not a token viewer                             | Ecash sent and received offline over BLE, topped up and cashed out over Lightning, and rebuilt on a new phone from twelve words               |
| v1.0.0              | Production UI and public release                              | UI complete, accessibility audited, submitted to both stores                                                                                  |
| v1.0.9 (in release) | Device transfer and a hardening pass                          | The identity moves to a new phone with no server, and the security review's findings are fixed and tested                                     |

### Planned

#### v1.1.0: AI Assistant

**Goal:** An offline local AI assistant, shipped as a self-contained addition to the existing tab shell.

It is built to Airhop's core constraint: no network dependency for the on-device experience. The assistant never phones home for inference, and it does not touch the BLE mesh protocol, wire format, or crypto layer.

- [ ] Model picker and download flow: a short list of small, offline-capable GGUF models (1–3B parameters, e.g. Gemma 4) with size and RAM shown before download
- [ ] On-device inference engine (e.g. `llama.rn` / `llama.cpp` bindings) running fully offline, no server, no API key, no telemetry
- [ ] `src/core/ai/model-manager.ts`: download, verify checksum, store under app sandbox, delete/swap models
- [ ] `src/core/ai/inference.ts`: prompt/response loop against the loaded model, streamed token output
- [ ] Chat-style AI UI in a new `src/features/ai/ai-screen.tsx`: ask critical or general questions (first-aid, survival, navigation, general knowledge) when there is no network at all
- [ ] Conversation history kept local-only (MMKV), never leaves the device
- [ ] Clear on-screen indicator that the model is fully offline and no data is transmitted
- [ ] Low-end device fallback: warn and block download if the device lacks the RAM/storage for the selected model

**Milestone:** A user with zero connectivity downloads a model once, then asks it questions and gets answered fully offline, with no server round-trip of any kind.

#### v1.2.0: Relay Hardware

**Goal:** Run the relay path against real nodes.

Relay support is written and simulated but has never met hardware; see [PROTOCOLS.md section 10](../spec/PROTOCOLS.md#10-relay-nodes).

- [ ] [Bitle](https://bitle.org) firmware on the mesh: Noise XX, courier mailbox, gossip sync, and the `0xB1` relay flag read off a real announce
- [ ] The LoRa trunk carrying traffic between two nodes with no phone bridging the gap
- [ ] The same runs against bitchat, so one deployed node serves both clients

**Milestone:** A Bitle node relays between an Airhop phone and a bitchat phone, and the LoRa trunk carries traffic with no phone in between.

#### v1.3.0: Web / Browser

**Goal:** A Nostr-only web companion that shares the TypeScript protocol core.

Web Bluetooth cannot advertise as a GATT Peripheral, so a browser tab cannot join the BLE mesh. The web target is Nostr-only: private DMs, group channels, geo-relay discovery, Cashu payments, identity and crypto. A companion for desktop or remote use, not a mesh node. Chrome and Edge support Web Bluetooth; Firefox and Safari do not, and there is no polyfill path, so those get an explicit notice rather than a silent failure.

- [ ] `react-native-web` build target
- [ ] BLE-dependent code paths gated behind platform checks so the build does not fail
- [ ] Nostr client, gift-wrap DMs, geo-relay, and payments working in browser
- [ ] Progressive Web App manifest for offline caching
- [ ] Hosted as a static bundle (no server required)
- [ ] Unsupported browser notice for Firefox and Safari

**Milestone:** A browser tab exchanges encrypted DMs with an Airhop mobile node over Nostr.

#### v1.4.0: Terminal / CLI

**Goal:** A headless Node.js node for Linux, Raspberry Pi, or any server.

The TypeScript protocol core runs in Node.js without React Native. A terminal node participates in the Nostr bridge, acts as a persistent store-and-forward courier, and can run BLE on Linux via BlueZ. Useful for fixed relay infrastructure in a space where phones are not always present.

- [ ] Node.js build target for `src/core/` (strip React Native platform imports)
- [ ] Linux BLE via `@abandonware/noble` (BlueZ wrapper for Node.js)
- [ ] CLI interface: join channel, send message, peer list, relay stats
- [ ] Daemonize support for always-on relay nodes
- [ ] Docker image for straightforward deployment

**Milestone:** A Raspberry Pi running Airhop CLI relays BLE packets between two mobile nodes.

#### v1.5.0: Smartwatch Companions

**Goal:** Companion apps for Apple Watch and Wear OS, with no change to the core protocol.

Neither watchOS nor Wear OS provides the background BLE execution primitives needed to relay mesh traffic, so both are companion interfaces to the phone app rather than standalone nodes.

##### Apple Watch (watchOS)

- [ ] SwiftUI app talking to the iOS app over WatchConnectivity
- [ ] Incoming message notifications with sender name and channel
- [ ] Quick reply from a set of short pre-defined responses
- [ ] Panic wipe trigger: a gesture sends an immediate wipe command to the paired iPhone, destroying all keys and message content in under a second
- [ ] Glanceable recent-messages complication

##### Wear OS (Android)

- [ ] Kotlin app on Compose for Wear, using the Wearable Data Layer API
- [ ] Incoming message notifications mirrored from the Android app
- [ ] Quick reply support
- [ ] Panic wipe trigger matching the Apple Watch behavior
- [ ] Tile showing unread message count and last sender

**Milestone:** A user can read incoming messages and trigger a full panic wipe from their wrist on both Apple Watch and Wear OS.

#### v1.6.0: Desktop (macOS + Windows)

**Goal:** Native desktop apps, macOS first.

macOS is the priority: CoreBluetooth has the same API surface as iOS, so the existing Swift `AirhopBLEModule` needs minimal change, and bitchat already ships a macOS target. Windows is secondary and ships as a point release after macOS stabilizes, since WinRT needs a new native module that the Swift code cannot provide.

- [ ] `react-native-macos` target added to the project
- [ ] `AirhopBLEModule.swift` audited and tested on macOS (CoreBluetooth is identical)
- [ ] macOS-specific entitlements and sandbox config (`bitchat-macOS.entitlements` as reference)
- [ ] WiFi Aware enabled on macOS (Mac Catalyst 26 carries the same framework)
- [ ] Mac App Store submission
- [ ] `react-native-windows` target scoped and scheduled
- [ ] Windows BLE native module via WinRT Bluetooth APIs
- [ ] Microsoft Store submission

**Milestone:** A macOS node joins the BLE mesh alongside iOS and Android peers. Windows target scoped and in progress.

#### v1.7.0: Federated Social

**Goal:** Opt-in bridges to the open social networks, without touching the core protocol.

Airhop's identity model (Ed25519 keypairs, no accounts) maps onto both the [AT Protocol](https://atproto.com) used by Bluesky and [ActivityPub](https://w3.org/TR/activitypub/) used by Mastodon, so bridging is an integration and not a redesign. Both are off unless the user turns them on: enable neither and nothing changes, the mesh protocol and wire format are untouched, and neither reaches private keys or relay traffic without a per-action confirmation.

##### AT Protocol (Bluesky)

- [ ] DID resolution and keypair association (`did:key` derived from Airhop's Ed25519 identity)
- [ ] Read feed integration: Bluesky home and discovery feeds in a dedicated tab
- [ ] Post bridge: optionally publish channel messages as `app.bsky.feed.post` records
- [ ] Follow graph import: find which Bluesky contacts are also Airhop users via DID cross-referencing
- [ ] PDS (Personal Data Server) self-hosting option for full data sovereignty

##### ActivityPub (Mastodon)

- [ ] Actor construction from Airhop's Ed25519 identity
- [ ] Mastodon-compatible inbox and outbox: mentions and DMs from any compliant server
- [ ] Outbound posting: optionally broadcast public channel messages as Notes
- [ ] WebFinger lookup for contact discovery

**Milestone:** An Airhop identity linked to a Bluesky DID and a Mastodon actor, cross-posting to both.

#### v1.8.0: SDK / Library

**Goal:** Extract the protocol core into a versioned public package before the audit locks down the API surface.

`src/core/` is already a pure TypeScript library: named exports, strict mode, no UI coupling. Shipping the SDK before v1.9.0 puts the public API inside the audit scope, and lets developers build bitchat-compatible apps without reimplementing Noise XX, the GCS gossip filter, Double Ratchet, or the packet codec. More independent implementations of the same wire protocol means a larger, more resilient mesh for everyone.

##### SDK Packages

- [ ] Extract `src/core/` as a standalone npm package (`@airhop/core`) with semantic versioning
- [ ] Extract `AirhopBLEModule` as a distributable React Native library (`@airhop/ble`)
- [ ] Compile `@airhop/core` to WebAssembly for cross-language embedding
- [ ] Python SDK (`airhop-core` on PyPI) over the WASM build, for server-side relays and research tooling
- [ ] Rust crate (`airhop-core` on crates.io) for high-performance relay and IoT infrastructure
- [ ] Go module for server and container deployment
- [ ] Stabilize the public API surface; mark internal utilities as private
- [ ] Developer documentation: API reference, integration guide, example app per language
- [ ] Publish all packages under the MIT license
- [ ] Example: a minimal bitchat-compatible node on `@airhop/core` in under 200 lines

##### Custom Application Profiles

- [ ] Build-time configuration for enabling and disabling feature modules (`payments`, `voice`, `video`, `nostr`)
- [ ] Document the customization surface and the constraints that cannot change (crypto stack, packet signing, wire protocol)
- [ ] Reference build: emergency communications, location sharing prioritized, no payments
- [ ] Reference build: high anonymity, no persistent usernames, ephemeral-only channels, stricter Tor defaults

**Milestone:** `@airhop/core` published on npm, PyPI, and crates.io. A third-party app built on the SDK joins the mesh. Two reference custom builds ship.

#### v1.9.0: Security Hardening

**Goal:** Independent verification of every security guarantee before the v2.0.0 flagship release.

This phase exists because cryptographic correctness cannot be self-certified. The Noise XX state machine, Double Ratchet ratchet steps, key storage boundaries, and packet signing paths all require external eyes before Airhop can be recommended for high-risk use. The v1.8.0 SDK packages (`@airhop/core`, `@airhop/ble`) are included in the audit scope, because a public API that ships without independent review is a liability for every downstream developer building on it.

- [ ] Engage a third-party security firm (Cure53 or equivalent) for a full cryptographic audit covering `src/core/crypto/`, packet signing, key storage, and the public API surface of `@airhop/core`
- [ ] Engage a second independent auditor for the BLE mesh layer, Nostr bridge, and `@airhop/ble` (two firms, separate scopes)
- [ ] Verify that all unsigned and signature-invalid packets are silently dropped with no observable side effects
- [ ] Remediate all findings from both audits before proceeding to v2.0.0
- [ ] Publish audit reports publicly

**Milestone:** Both audits complete with no open critical or high findings. All recommendations addressed or formally accepted with documented rationale.

#### v2.0.0: Flagship Interface

**Goal:** A production-grade chat interface once the SDK and audit are complete, plus a standing transparency commitment.

Private communication should be understandable, not merely trusted. v2.0.0 redesigns the interface for both modern and constrained devices, and makes the documentation and audit trail a permanent obligation rather than a release artifact.

##### Flagship Chat Interface

- [ ] Full UI/UX audit against established messaging conventions (Signal, WhatsApp, Telegram interaction patterns)
- [ ] Redesign on a consistent design system: typography scale, spacing, color tokens, light and dark
- [ ] Accessibility audit: WCAG 2.1 AA, screen reader support, dynamic text sizing
- [ ] Performance profiling on low-end hardware (2GB RAM Android, iPhone 7 class)
- [ ] Battery-aware rendering
- [ ] Broad device compatibility: Android API 21+ (Android 5.0, 2014), iOS 14+
- [ ] Animations that degrade gracefully on old hardware

##### Transparency and Public Knowledge

- [ ] 100% of public API behavior documented; no undocumented features, no silent changes between releases
- [ ] CVEs and security findings disclosed as soon as a fix is available, with timeline and impact
- [ ] Audit reports published in full, unredacted
- [ ] Blog series on building private decentralized applications: Noise, offline-first architecture, BLE mesh design, Cashu, Nostr identity
- [ ] YouTube deep dives: how the BLE mesh works, how Noise XX is implemented, how Double Ratchet gives forward secrecy, how Cashu tokens move offline

**Milestone:** The redesigned UI ships across iOS, Android, macOS, and web, WCAG 2.1 AA verified, with audit reports and documentation public.

## 3. Risk Register

### Risk 1: iOS Background BLE

- **Probability:** High. iOS suspends background apps aggressively.
- **Impact:** Once Airhop leaves the foreground, CoreBluetooth moves its service UUID into the advertisement's overflow area, so Android stops discovering the iPhone until the app is reopened. Links already open keep carrying traffic, and iPhone-to-iPhone discovery continues.
- **Mitigation:** State restoration relaunches the app on a BLE event, the LAN transport carries the mesh on a shared network, and the limitation is documented rather than hidden ([ARCHITECTURE.md section 12](../spec/ARCHITECTURE.md#background-execution)).

### Risk 2: Android BLE and Battery Managers

- **Probability:** Medium. OEM BLE stacks differ, and many OEM battery managers kill background apps.
- **Impact:** Dual-role GATT or the background mesh fails on some devices.
- **Mitigation:** The foreground service holds the process; the battery optimization flow deep-links to the right setting on 10 OEM skins. Field reports from the Samsung testers drive the WiFi Aware and BLE quirk handling. Device checks stay manual, since the simulation models the OS contract rather than the silicon.

### Risk 3: Crypto Cost on Old Phones

- **Probability:** Medium. X25519 is well under a millisecond on a current phone and can be ten times slower on a budget one from 2019.
- **Impact:** A burst of handshakes blocks the JS thread, which also runs the UI.
- **Mitigation:** Sessions are cached, so the X25519 cost is paid per handshake rather than per message, and inbound handshakes are rate limited (10 a minute per claimed peer, 30 first messages a minute in total). Crypto still runs on the JS thread; moving it off is open, and is measured in the v2.0.0 low-end profiling.

### Risk 4: Drift From bitchat

- **Probability:** Medium. bitchat ships often, and bitchat-ios and bitchat-android disagree with each other.
- **Impact:** A changed constant or a new packet type breaks interop silently.
- **Mitigation:** bitchat-ios is the reference. Vector tests pin every byte layout bitchat defines, `conformance.test.ts` checks constants against a local bitchat checkout, and the multi-device simulation runs a bitchat actor in both directions. The `@upstream-sync` agent turns each bitchat release into an integration checklist.

### Risk 5: Self-Certified Cryptography

- **Probability:** Low to medium. Noise, the Double Ratchet and packet signing pass their tests and a full internal security review, but nobody outside the project has audited them.
- **Impact:** A subtle state-machine error could leak keys or break interop, and Airhop cannot yet be recommended for high-risk use.
- **Mitigation:** Reference vectors where bitchat or the specs publish them, adversarial scenarios in the simulation ([PROGRESS.md](../dev/PROGRESS.md#security-analysis)), and two independent audits in [v1.9.0](#v190-security-hardening).

## 4. Porting From bitchat

bitchat is public domain, so Airhop ports its logic freely. Which bitchat-ios and bitchat-android file each Airhop module follows is kept with the `@upstream-sync` agent (`.github/agents/upstream-sync.md`), which uses that map to check each bitchat release. Everything bitchat has no equivalent for, from dual-role GATT in React Native to Noise XX and the GCS filter in TypeScript, was written for Airhop.
