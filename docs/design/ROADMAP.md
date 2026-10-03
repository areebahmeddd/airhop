# Airhop: Roadmap

What Airhop adds to bitchat, what each version sets out to do, and the risks the plan carries. Read it before proposing a feature. Why Airhop exists is in [VISION.md](VISION.md), how it is built in [ARCHITECTURE.md](../spec/ARCHITECTURE.md), where the build stands today in [PROGRESS.md](../dev/PROGRESS.md), and what each release shipped in [CHANGELOG.md](../dev/CHANGELOG.md).

## 1. Where Airhop Fits: Gap Analysis vs bitchat

### Gap 1: Unified Codebase

**bitchat:** bitchat-ios and bitchat-android are separate native codebases that drift. bitchat-android has no courier and no packet type for board posts, prekey bundles or private groups, so those bitchat-ios features never reach an Android user, and a constant changed on one side alone breaks interop with no error on either.

**Airhop:** One TypeScript protocol stack. A protocol bug surfaces on both platforms at once, and a fix lands on both at once.

### Gap 2: Transports Beyond Bluetooth

**bitchat:** Bluetooth only in practice, around 18 KiB/s. bitchat-android has Wi-Fi Aware behind a debug setting that is off by default, bitchat-ios has none, and neither can use an ordinary Wi-Fi network.

**Airhop:** Two transports beside Bluetooth, picked per link, with Bluetooth as the fallback that always works. Wi-Fi Aware ships enabled on both platforms as the fast path between two Androids or two iPhones; Apple requires a paired data path Android cannot complete, so it never crosses platforms. LAN closes that gap with mDNS discovery and plain TCP links, carrying the same packets the radio carries. It stays off until the user turns it on, since announcing yourself on a network is visible to everyone on it.

### Gap 3: Reaching the Network Where Tor Is Blocked

**bitchat:** Routes internet traffic through Tor, with no bridges and no pluggable transports. The first hop is a publicly listed relay, so a network that blocks Tor blocks bitchat's internet half outright, and deep packet inspection sees Tor in use.

**Airhop:** The same embedded Arti, plus obfs4 and Snowflake compiled into the app. A bridge is an unlisted entry point and the transport in front of it disguises the connection, so Tor keeps working where it is blocked and stops being visible where it is watched. Bridges are off by default, since they cost speed and only earn it on such a network. Built-in bridge lines are synced from the Tor Project rather than frozen at release.

### Gap 4: Per-Message Forward Secrecy

**bitchat:** A live DM runs on one Noise XX session, so a leaked session key exposes the whole session. Courier mail exists only on bitchat-ios, sealed to a one-time prekey when it holds one and to the recipient's long-term key otherwise, where a leak of that key exposes every piece of mail still waiting.

**Airhop:** Signal's Double Ratchet inside the Noise session for Airhop-to-Airhop DMs, so every message has its own key. One-time prekeys for courier mail on both platforms, in bitchat-ios's format: bundles travel signed over the mesh and never touch Nostr, and an envelope seals to a one-time prekey, so waiting mail survives the long-term key leaking later.

### Gap 5: Files and Video

**bitchat:** Accepts 1 MiB of any type, checked as a packet is decoded; bitchat-ios keeps the photos and voice notes it sends under 512 KiB. Video crosses the wire but neither platform plays it.

**Airhop:** Matches the ceiling and the send budgets, and does not raise them: bitchat-ios rejects a packet past the ceiling while decoding it, so a higher one would break interop in both directions. One packet per file, a MIME allow-list, magic bytes checked against the extension, and the fragment layer splits it for the radio. Video rides that path and plays inline on both platforms; a bitchat peer sees an ordinary file. There is no live video: Bluetooth is too slow, Wi-Fi Aware cannot cross platforms, and LAN needs both peers on one network with it switched on.

### Gap 6: Cashu Wallet

**bitchat:** A Cashu token decoder. It recognizes a token in a message and shows what it is worth. There is no balance, no mint, no way to spend it.

**Airhop:** A full wallet in its own tab: encrypted proof storage, per-mint accounts, Lightning in and out, Nutzaps, and a BIP-39 recovery phrase. Tokens are plain strings, so value moves device to device over Bluetooth with no server in the middle, and a bitchat peer still sees an ordinary token.

### Gap 7: Non-Technical UX

**bitchat:** The protocol work is excellent. The app around it is hard to use.

**Airhop:** This is priority one, and has been from day one. It follows the conventions Apple's Human Interface Guidelines and Material Design agree on, so it behaves the way people expect a messaging app to, and it reads in 35 languages.

## 2. Version Targets

### Shipped

What each milestone delivered, item by item, is in [PROGRESS.md](../dev/PROGRESS.md#what-exists).

| Version | Goal                                                          | Milestone                                                                                                                                     |
| ------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.5.0  | Foundation: a BLE mesh between two phones                     | Two phones discover each other and exchange signed announces                                                                                  |
| v0.6.0  | Core messaging, bitchat wire-compatible                       | Full offline mesh chat, with Airhop to bitchat delivery verified                                                                              |
| v0.7.0  | Internet bridge and live voice                                | DMs across a city over Nostr, through embedded Arti on both platforms; live push-to-talk over BLE, interoperating with bitchat                |
| v0.8.0  | Identity and forward secrecy                                  | Double Ratchet passing its tests; courier mail survives the recipient's long-term key leaking; a scanned card is trusted, a linked one is not |
| v0.9.0  | Two transports beside Bluetooth, one fast, one cross-platform | Attachments over same-platform Wi-Fi Aware; an iPhone and an Android carrying the mesh over shared Wi-Fi with Bluetooth idle                  |
| v0.9.5  | 35 languages, with the compiler enforcing completeness        | Every screen reads from the catalogs, and CI cannot regress it                                                                                |
| v0.9.6  | A real wallet, not a token viewer                             | Ecash sent and received offline over BLE, topped up and cashed out over Lightning, and rebuilt on a new phone from twelve words               |
| v1.0.0  | Production UI and public release                              | UI complete, accessibility audited, submitted to both stores                                                                                  |

### Planned

#### v1.1.0: AI Assistant

**Goal:** An assistant that runs entirely on the phone, opt-in behind a tab of its own.

Nothing typed into it leaves the phone, and it does not touch the mesh protocol, wire format or crypto layer. The one network call is the model download, held to the same internet and Tor rules as a mint call. A model can also be imported from a file or shared phone to phone, so someone with no connection can still get one. A small model can be confidently wrong, so it is a general assistant, not a source of medical advice.

- [ ] Off by default: switched on in General, Features, which adds an AI tab
- [ ] Inference through `llama.rn` (llama.cpp), built from source on both platforms, in the foreground only and released under memory pressure
- [ ] Pinned model catalog in `src/data/`: small multilingual GGUF models chosen by an eval across the languages Airhop ships, each with its size, RAM and SHA-256
- [ ] Download, import and share: resumable, hash-verified before the first load, refused on iOS while Tor is on
- [ ] Device fit: a model the phone lacks the memory or storage for is shown but cannot be downloaded
- [ ] Pure logic (device fit, context window, prompt) in `src/core/ai/`, the engine and model files in `src/services/`
- [ ] Chat UI in `src/features/ai/`: streamed answers, stop, and history kept on the phone, cleared by the panic wipe
- [ ] A bad answer reported by email from inside the app, since Google Play requires in-app reporting for generative AI and Airhop has no server to receive it; every answer labelled as AI-generated, as the EU AI Act requires

**Milestone:** A phone gets a model once, by download or from a nearby phone, then answers questions with no connection at all while the mesh keeps running.

#### v1.2.0: Relay Hardware

**Goal:** Run the relay path against real nodes.

Relay support is written and simulated but has never met hardware; see [PROTOCOLS.md section 10](../spec/PROTOCOLS.md#10-relay-nodes). LoRa carries text in practice, not files or live voice, and its band is regional: 915 MHz in the US, 868 MHz in the EU.

- [ ] [Bitle](https://github.com/bitleproject/bitle) firmware on the mesh: Noise XX, courier mailbox, gossip sync, and the `0xB1` relay flag read off a real announce
- [ ] The LoRa trunk carrying messages between two nodes with no phone bridging the gap
- [ ] The same runs against bitchat, so one deployed node serves both clients

**Milestone:** A Bitle node relays between an Airhop phone and a bitchat phone, and the LoRa trunk carries traffic with no phone in between.

#### v1.3.0: Web / Browser

**Goal:** A Nostr-only web client that shares the TypeScript protocol core.

A browser tab cannot advertise as a Bluetooth peripheral, so it cannot join the mesh and reaches people over Nostr only. It is its own identity rather than a mirror of a phone, since two devices answering for one identity break each other's sessions, and it holds no wallet. The browser weakens three guarantees, and the client says so: keys sit in browser storage rather than a keychain, relays see the IP because a page cannot embed Tor, and whoever serves the page serves the code.

- [ ] `react-native-web` build target, with Bluetooth, Wi-Fi, LAN, Tor and voice gated behind platform checks
- [ ] Nostr client, gift-wrap DMs and location channels working in the browser
- [ ] A wipe that clears the keys and all history
- [ ] Progressive Web App manifest for offline caching, served as a static bundle from a tagged release
- [ ] The storage, Tor and serving differences stated before first use

**Milestone:** A browser tab exchanges encrypted DMs with an Airhop mobile node over Nostr.

#### v1.4.0: Terminal / CLI

**Goal:** A headless Node.js node for Linux, Raspberry Pi, or any server.

A terminal node relays, carries courier mail and bridges to Nostr where phones are not always present. It is its own identity, never a copy of a phone's. The protocol pieces in `src/core/` are close to running in Node.js, but the node that drives them is `src/services/mesh-service.ts`, bound to the app's stores, so the engine moves into `src/core/` first.

- [ ] The mesh engine moved into `src/core/`, with storage and the keychain behind interfaces the app implements
- [ ] Linux BLE through the maintained `noble` (central) and `bleno` (peripheral) forks, which need raw HCI access
- [ ] CLI interface: join channel, send message, peer list, relay stats
- [ ] Daemonize support for always-on relay nodes
- [ ] Docker image, on host networking for Bluetooth

**Milestone:** A Raspberry Pi running Airhop CLI relays BLE packets between two mobile nodes.

#### v1.5.0: Smartwatch Companions

**Goal:** Companion apps for Apple Watch and Wear OS, with no change to the core protocol.

Neither watchOS nor Wear OS lets an app run the background Bluetooth a mesh node needs, so both are interfaces to the phone app rather than nodes. Both already mirror the phone's notifications, so reading and replying start on the phone, and the watch apps add what a notification cannot. What the watch shows follows the notification preview setting, and message text never sits on an always-on face.

- [ ] Reply from a notification on the phone, which both watches mirror
- [ ] Apple Watch app over WatchConnectivity: panic trigger and an unread-count complication
- [ ] Wear OS app over the Wearable Data Layer: panic trigger and an unread-count tile
- [ ] Panic trigger guarded against accidental taps; it reaches the phone only while the two are connected

**Milestone:** A user replies to a message and triggers a panic wipe from their wrist on both Apple Watch and Wear OS.

#### v1.6.0: Desktop (macOS + Windows)

**Goal:** Airhop on the desktop, macOS first.

The iOS app already runs on Apple silicon Macs, as an iPad app or through Mac Catalyst, with CoreBluetooth unchanged, so the Mac starts from the same binary. `react-native-macos` trails React Native and Expo covers macOS only in part, so a native target waits until that path falls short. Wi-Fi Aware is iPhone and iPad only, so Bluetooth and LAN carry the Mac. A desktop is its own identity, as in v1.3.0. Windows follows once the Mac is stable, since WinRT needs a BLE module of its own.

- [ ] The iOS app on Apple silicon Macs, as an iPad app or through Mac Catalyst
- [ ] Bluetooth, LAN and Tor tested on the Mac, with the sandbox entitlements it needs
- [ ] Mac App Store submission
- [ ] `react-native-windows` target scoped, with a WinRT BLE module and a Windows Tor build
- [ ] Microsoft Store submission

**Milestone:** A Mac joins the BLE mesh alongside iOS and Android peers. Windows target scoped and in progress.

#### v1.7.0: Federated Social

**Goal:** Opt-in sharing to Bluesky and Mastodon, without touching the core protocol.

A phone cannot be a Bluesky PDS or an ActivityPub server: both need a public, always-on HTTPS endpoint, the kind of server Airhop never runs. An Airhop key is not an AT Protocol identity either, which is a `did:plc` or `did:web` signed with secp256k1 or P-256. So Airhop acts as a client of accounts the person already has, and nothing changes for anyone who never connects one.

- [ ] Sign in to an existing Bluesky or Mastodon account through its own login, with the token in the keychain
- [ ] Share your own message or board post, with a preview and a confirmation each time
- [ ] Never other people's messages, never media, and no contact matching between Airhop and either network

**Milestone:** A user posts their own board notice to Bluesky and Mastodon, with no server run by Airhop.

#### v1.8.0: SDK / Library

**Goal:** Publish the protocol core as a versioned package before the audit locks down the API surface.

Since v1.4.0 the engine lives in `src/core/`, so it can ship on its own. Shipping it before v1.9.0 puts the public API inside the audit scope, and lets developers build bitchat-compatible apps without reimplementing Noise XX, the GCS gossip filter, Double Ratchet, or the packet codec. Other languages implement the protocol natively against the spec and its vectors rather than wrapping this one, since TypeScript does not compile to WebAssembly.

##### SDK Packages

- [ ] `@airhop/core` on npm with semantic versioning, running in Node.js, Deno, Bun and browsers
- [ ] `AirhopBLEModule` as a distributable React Native library (`@airhop/ble`)
- [ ] A conformance suite built from [PROTOCOLS.md](../spec/PROTOCOLS.md) and its vectors, runnable against any implementation
- [ ] Stabilize the public API surface; mark internal utilities as private
- [ ] Developer documentation: API reference and integration guide
- [ ] Example: a minimal bitchat-compatible node on `@airhop/core` in under 200 lines

##### Custom Application Profiles

- [ ] Build-time configuration for enabling and disabling feature modules (`payments`, `voice`, `video`, `nostr`)
- [ ] Document the customization surface and the constraints that cannot change (crypto stack, packet signing, wire protocol)
- [ ] Reference build: emergency communications, no payments
- [ ] Reference build: high anonymity, internet off by default, Tor with bridges when it is on

**Milestone:** `@airhop/core` published on npm, and a third-party app built on it joins the mesh. Two reference custom builds ship.

#### v1.9.0: Security Hardening

**Goal:** Independent verification of every security guarantee before the v2.0.0 flagship release.

This phase exists because cryptographic correctness cannot be self-certified. The Noise XX state machine, Double Ratchet ratchet steps, key storage boundaries, and packet signing paths all require external eyes before Airhop can be recommended for high-risk use. The v1.8.0 SDK packages are included in the audit scope, because a public API that ships without independent review is a liability for every downstream developer building on it. [OTF's Security Lab](https://www.opentech.fund/labs/security-lab/) funds audits of internet freedom tools and publishes the reports.

- [ ] Engage a third-party security firm (Cure53 or equivalent) for a full cryptographic audit covering `src/core/crypto/`, packet signing, key storage, the wallet, and the public API surface of `@airhop/core`
- [ ] Engage a second independent auditor for the BLE mesh layer, Nostr bridge, device transfer, Tor integration, and `@airhop/ble` (two firms, separate scopes)
- [ ] Verify that every packet type that requires a signature is silently dropped without a valid one, with no observable side effects
- [ ] Remediate all findings from both audits before proceeding to v2.0.0
- [ ] Publish audit reports publicly

**Milestone:** Both audits complete with no open critical or high findings. All recommendations addressed or formally accepted with documented rationale.

#### v2.0.0: Flagship Interface

**Goal:** A production-grade chat interface once the SDK and audit are complete, plus a standing transparency commitment.

Private communication should be understandable, not merely trusted. v2.0.0 redesigns the interface for both modern and constrained devices, and makes the documentation and audit trail a permanent obligation rather than a release artifact.

##### Flagship Chat Interface

- [ ] Full UI/UX audit against established messaging conventions (Signal, WhatsApp, Telegram interaction patterns)
- [ ] Redesign on the existing design system: typography scale, spacing, color tokens, light and dark
- [ ] Accessibility audit: WCAG 2.2 AA, screen reader support, dynamic text sizing
- [ ] Performance profiling on the oldest supported hardware (2 GiB RAM Android, iPhone 8)
- [ ] Animations that degrade gracefully on old hardware

##### Transparency and Public Knowledge

- [ ] 100% of public API behavior documented; no undocumented features, no silent changes between releases
- [ ] CVEs and security findings disclosed as soon as a fix is available, with timeline and impact
- [ ] Audit reports published in full, unredacted
- [ ] Blog series on building private decentralized applications: Noise, offline-first architecture, BLE mesh design, Cashu, Nostr identity
- [ ] YouTube deep dives: how the BLE mesh works, how Noise XX is implemented, how Double Ratchet gives forward secrecy, how Cashu tokens move offline

**Milestone:** The redesigned UI ships across iOS, Android, macOS, and web, WCAG 2.2 AA verified, with audit reports and documentation public.

## 3. Risk Register

### Risk 1: iOS Background BLE

- **Probability:** High. iOS suspends background apps aggressively.
- **Impact:** Once Airhop leaves the foreground, CoreBluetooth moves its service UUID into the advertisement's overflow area, so Android stops discovering the iPhone until the app is reopened. Links already open keep carrying traffic, and iPhone-to-iPhone discovery continues.
- **Mitigation:** State restoration relaunches the app on a BLE event, the LAN transport carries the mesh on a shared network, and the limitation is documented rather than hidden ([ARCHITECTURE.md section 12](../spec/ARCHITECTURE.md#background-execution)).

### Risk 2: Android BLE and Battery Managers

- **Probability:** Medium. OEM BLE stacks differ, and many OEM battery managers kill background apps.
- **Impact:** Dual-role GATT or the background mesh fails on some devices.
- **Mitigation:** The foreground service holds the process; the battery optimization flow deep-links to the right setting on 10 OEM skins. Field reports from the Samsung testers drive the Wi-Fi Aware and BLE quirk handling. Device checks stay manual, since the simulation models the OS contract rather than the silicon.

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
