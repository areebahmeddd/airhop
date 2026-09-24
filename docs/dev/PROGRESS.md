# Airhop: Build Progress

> Updated when milestones complete, blockers are found, or decisions are made. It is the canonical answer to "where are we right now?"

## Current Version: v1.0.0

**Verified by tests:** packet codec (v1 and v2 headers, padding, compression),
fragment format and reassembly progress, Noise XX, Double Ratchet, courier
envelopes (static and prekey-sealed), one-time prekey bundles, gossip filters
(including type-aware board rounds), bulletin-board wire and store quotas,
private-group wire and epoch keys, gateway carrier codec, mesh ping/pong,
outbox delivery, contact-card binding, geohash derivation + relay determinism,
geohash DM round trip, Nostr gift-wrap and the bitchat envelope, proof selection.

**Verified by the multi-device simulation** (`src/__tests__/simulation/`):
multi-hop delivery across a chain of phones that cannot hear each other, a
25-phone room converging on one channel, a live mixed Airhop/bitchat mesh in both
directions, parallel attachment transfers, live push-to-talk sharing a radio with
a file transfer, offline ecash transfer and double-spend refusal against a real
BDHKE mint, recovery from a swap whose answer never came back, replay and Sybil
floods, panic wipe, crash recovery, and a seeded soak of hundreds of random
events across eight phones. Each simulated phone is a
fully isolated copy of the app driven through a modelled OS and radio.

**Still cannot be verified without hardware:** real BLE discovery timing, MTU
negotiation, CoreBluetooth behaviour on real silicon, OEM battery managers, and
real Tor circuits. The simulation models the OS contract; it cannot prove the
hardware honours it.

**Built with:** Claude Opus 5 (1M context) in Claude Code, working against the
vendored `bitchat/ios` and `bitchat/android` sources as the protocol source of
truth. The multi-device simulation, the adversarial scenarios, and the security
review below were produced the same way. Every claim here is meant to be
checkable against the code rather than taken on trust.

## v0.5.0: Foundation ✅

- [x] Expo bare workflow, TypeScript strict, Jest over `src/core/`, folder layout per `ARCHITECTURE.md` section 11
- [x] `AirhopBLEModule`: dual-role GATT on both platforms (`CBPeripheralManager` + `CBCentralManager`, `BluetoothGattServer` + `BluetoothLeScanner`)
- [x] `AirhopForegroundService.kt`, started with the mesh, so the process, BLE and the Nostr socket survive backgrounding
- [x] `src/core/mesh/wire/packet-codec.ts`: binary encode/decode, matches `PROTOCOLS.md` byte for byte
- [x] `src/core/mesh/routing/flood-router.ts` and `deduplicator.ts`: TTL flood with jitter, LRU 1000-entry seen-set
- [x] `src/core/mesh/links/link-registry.ts`: open links per radio, peer bindings, writes
- [x] `src/core/mesh/discovery/announce-manager.ts`: signed presence broadcasts
- [x] `src/core/crypto/identity.ts`: key generation, Keychain storage, peer ID derivation
- [x] Local notifications (`expo-notifications`, no push server): per-conversation heads-up, tap to open, badge synced to unread

## v0.6.0: Core Messaging ✅

- [x] `src/core/crypto/noise-xx.ts`: full XX pattern over `@noble`, transport encrypt/decrypt, replay window
- [x] `src/core/crypto/noise-x.ts`: one-way Noise X for courier sealing
- [x] `src/core/mesh/routing/fragment-manager.ts`: split/reassemble, 30s timeout, 128-slot concurrent cap
- [x] `src/core/mesh/sync/gossip-sync.ts`: GCS filter reconciliation (Golomb-Rice, TLV wire format)
- [x] `src/core/mesh/courier/courier-store.ts`: sealed envelopes, trust tiers, spray-and-wait, daily recipient tags
- [x] `src/core/router/message-router.ts`: BLE broadcast, unicast, courier fallback
- [x] Cross-language Noise XX test: JS client ↔ bitchat-ios Swift server
- [x] `packet-frame-vectors.test.ts`: peer ID derivation, byte offsets, signature relay compat, ANNOUNCE TLV, fragment constants, BLE UUIDs
- [x] Basic UI: channel list, message thread, peer list

## v0.7.0: Internet Bridge + Voice ✅

- [x] `src/core/nostr/nostr-client.ts`: SimplePool, auto-reconnect, proxy config
- [x] `src/core/nostr/gift-wrap.ts`: NIP-17/59 gift-wrap DMs, HKDF key derivation
- [x] `src/core/nostr/geo-relay.ts`: Haversine nearest relay from the bundled CSV, surfaced in the channel info sheet
- [x] `src/core/nostr/geohash-presence.ts`: kind 20001 heartbeats
- [x] `src/core/nostr/courier-relay.ts`: Nostr bridge courier drops (kind 1401, NIP-40 expiry)
- [x] Arti embedded on both platforms from one Rust crate (`native/arti/`): lifecycle, real bootstrap progress, dormancy, per-relay circuit isolation, and a SOCKS5 listener. Android installs the proxy into React Native's OkHttp client so `fetch` is covered too; iOS adds a WebSocket shim, which is the only thing the two platforms do differently
- [x] Reproducible native build: `native/arti/build-in-container.sh` pins Rust, the NDK and a Debian snapshot; `build-apple.sh` produces the xcframework; both verify exported symbols, and Android additionally verifies 16 KiB page alignment and that no build-machine path survived
- [x] `src/services/tor-routing.ts`: the single toggle and startup choke point. Every relay connection is dialled through the proxy, so Tor fails closed
- [x] PTT voice: `voice-capture.ts` + `voice-player.ts`, streaming mic and speaker off the JS thread, `VOICE_FRAME` (0x29) relayed in the mesh
- [x] `src/core/router/message-router.ts`: Nostr added as priority-2 transport (BLE > Nostr > Courier)

## v0.8.0: Identity + Forward Secrecy ✅

- [x] `src/core/crypto/double-ratchet.ts`: Signal DR per-message forward secrecy. The root key comes from the Noise XX **exporter secret**, so it cannot be rebuilt from long-lived keys or from the public handshake bytes
- [x] One-time prekey bundles (`prekey-bundle.ts`, `prekey-store.ts`) gossiped as `0x24`. **X3DH is not used**: the handshake already seeds the ratchet (see `ARCHITECTURE.md` section 5)
- [x] `src/core/crypto/contact-exchange.ts`: binary ContactCard over the QR scheme, peer ID checked against the keys it carries; a card arriving by link is recorded unverified
- [x] `src/utils/username.ts`: deterministic adjective-noun-suffix from peer ID, 128-entry word lists
- [x] `src/services/panic-wipe.ts`: clears every keychain item, all MMKV partitions, the media cache, the notification tray and Arti's data directory, and reports whether the keys were destroyed. `wipe-marker.ts` records the intent first, so a wipe killed mid-run is finished on next launch

## v0.9.0: WiFi Transports ✅

- [x] WiFi Aware on both platforms: Apple's `WiFiAware` framework on iOS, `WifiAwareManager` on Android, enabled by default
- [x] `AirhopLANModule`: mDNS discovery plus TCP links (`NWListener` / `NWBrowser`, `NsdManager`), carrying the same packets the radio carries
- [x] `src/services/lan-controller.ts`: link lifecycle, registered beside BLE and WiFi Aware, off by default behind `lanTransportEnabled`
- [x] `src/services/lan-dial-policy.ts`: the ring that caps LAN at 8 links per phone
- [x] Video and any other allowed file type shared as attachments, played inline
- [x] Battery optimization flow (`src/platform/battery-optimization.ts`: OEM deep links for 10 skins, standard Android fallback)

## v0.9.5: Localization ✅

- [x] Translation runtime, no library (`src/i18n/index.ts`: `t` / `useT` / `tPlural`, named-placeholder interpolation)
- [x] Completeness enforced by `tsc` (`src/i18n/locales/types.ts`: every locale is `Record<TranslationKey, string>` derived from `en.ts`, so a partial locale does not compile and no runtime fallback exists)
- [x] Full extraction: every user-facing string in the catalog, zero hardcoded, enforced in CI
- [x] 35 catalogs, matching the set the landing site serves
- [x] Locale store, in-app picker, and device language negotiation through `Intl`
- [x] CLDR plurals for all 35 (`src/i18n/plurals.ts`), checked against Node's ICU for every integer 0 to 2000
- [x] Right to left for Arabic, Persian and Urdu (`src/i18n/layout.ts`: `textAlignEnd`, mirrored chevrons; logical properties app-wide; `radar-view.tsx` exempt as a polar plot of physical space)
- [x] Layout direction pinned at startup, and a direction change applied on next launch rather than by restarting the process
- [x] Persisted rows carry a catalog key and translate on render, so history follows a language change
- [x] Formatting centralised in `src/utils/format.ts`, cached formatters, Latin numerals for machine data
- [x] `scripts/i18n-build-locale.js`: builds a catalog from a translation map, refusing one with a missing key, a dropped placeholder, a wrong plural category, a localised protocol token or a stray script
- [x] `scripts/i18n-audit.js`: hardcoded strings, unreferenced keys, and frozen translations. Reads the TypeScript AST, so wrapped JSX text and template literals are in scope
- [x] CI guards: hardcoded-string ceiling at zero, translations frozen at module load or in a memo, and physical style properties
- [x] i18n tests (`src/i18n/__tests__/`: placeholder parity, plural categories, do-not-translate enforcement, terminal punctuation per script)
- [x] Catalog ordered by screen (shell, onboarding, chats, mesh, wallet, contacts, settings), so one screen's copy is one contiguous block

## v0.9.6: Cashu Wallet ✅

- [x] `src/core/payments/cashu.ts`: detection (bitchat-identical), decoding, NUT-12 DLEQ verification, fee-aware proof selection
- [x] `src/core/payments/nutzap.ts`: NIP-61 kind 9321 / 10019 construction and parsing
- [x] `src/core/payments/wallet-seed.ts`: BIP-39 recovery phrase, kept in the keychain
- [x] `src/store/wallet-store.ts`: AES-256 encrypted proofs, per (mint, unit) accounts, reserved bucket, history, NUT-13 counters
- [x] `src/services/wallet-service.ts`: the only module that talks to a mint
- [x] `src/services/payment-router.ts`: `payPerson`, one payment ladder (radio, nutzap, token, manual) shared by all four entry points: DM attach, contact sheet, Mesh peer sheet and Wallet Zap
- [x] Send that reserves rather than deletes, so an undelivered token is reclaimable
- [x] Lightning deposit and withdrawal (NUT-04 / NUT-05)
- [x] Opt-in recovery phrase (NUT-13 / NUT-09), off by default
- [x] Mint management: validated add, per-mint balances, consolidate over Lightning
- [x] Nutzap send and receive, with honest fallback when the recipient publishes no NIP-61 info
- [x] Tap the balance to read it in sats or bitcoin (display only, no price feed)
- [x] QR display and scan for tokens

## v1.0.0: UI + App Store Release ✅

- [x] Onboarding flow: welcome, animated identity generation, username reveal
- [x] Visual design: monochromatic dark theme (`#080808` base, single white accent), Feather icon system, design token system (`Colors`, `FontSize`, `FontWeight`, `Spacing`) in `src/ui/theme.ts`
- [x] Animations: keyframe spin and fade during identity generation, fade-up reveal on the username screen
- [x] Navigation shell: 4-tab state machine (Chats / Mesh / Wallet / Profile), sub-tab segment (Channels / Direct), Android BackHandler for in-thread back navigation. The AI tab arrives with the assistant in v1.1.0; there is no placeholder tab for it today
- [x] Accessibility audit
- [x] App Store and Play Store submission
- [x] YouTube demo series

## v1.1.0: AI Assistant

- [ ] Model picker and download flow: small offline-capable GGUF models (1–3B params, e.g. Gemma 4), size and RAM shown before download
- [ ] On-device inference engine (e.g. `llama.rn` / `llama.cpp` bindings), fully offline, no server, no telemetry
- [ ] `src/core/ai/model-manager.ts`: download, checksum verify, store under app sandbox, delete/swap models
- [ ] `src/core/ai/inference.ts`: prompt/response loop against the loaded model, streamed token output
- [ ] Chat-style AI UI in `src/features/ai/` (the directory does not exist yet): ask critical or general questions with zero network
- [ ] Conversation history kept local-only (MMKV)
- [ ] Low-end device fallback: block download if device lacks RAM/storage for the selected model

## v1.2.0: Relay Hardware

- [ ] [Bitle](https://bitle.org) firmware on the mesh: Noise XX, courier mailbox, gossip sync, and the `0xB1` relay flag read off a real announce
- [ ] The LoRa trunk carrying traffic between two nodes with no phone bridging the gap
- [ ] The same runs against bitchat, so one deployed node serves both clients

## v1.3.0: Web / Browser

- [ ] `react-native-web` build, Nostr-only (no BLE mesh in browser)
- [ ] Chrome and Edge supported; Firefox and Safari unsupported (Web Bluetooth limitation)
- [ ] PWA manifest, static hosting

## v1.4.0: Terminal / CLI

- [ ] Node.js build target for `src/core/`
- [ ] Linux BLE via `@abandonware/noble` (BlueZ)
- [ ] CLI interface + daemonize support + Docker image

## v1.5.0: Smartwatch Companions

- [ ] Apple Watch app (SwiftUI, WatchConnectivity): message notifications, quick reply, panic wipe trigger
- [ ] Wear OS app (Kotlin, Compose for Wear, Wearable Data Layer): notifications, quick reply, panic wipe trigger

## v1.6.0: Desktop (macOS + Windows)

- [ ] `react-native-macos` target, macOS BLE via CoreBluetooth
- [ ] `react-native-windows` target, Windows BLE via WinRT
- [ ] Mac App Store + Microsoft Store submission

## v1.7.0: Federated Social

- [ ] AT Protocol (Bluesky): DID association, feed integration, post bridge, follow graph import
- [ ] ActivityPub (Mastodon): Actor construction, inbox/outbox, outbound posting, WebFinger lookup
- [ ] Both off by default, strict data boundary, no key access without a per-action confirmation

## v1.8.0: SDK / Library

- [ ] Extract `src/core/` as `@airhop/core` npm package with stable public API
- [ ] Extract `AirhopBLEModule` as `@airhop/ble` React Native library
- [ ] WASM build of `@airhop/core`; Python (PyPI), Rust (crates.io), Go language SDKs
- [ ] Custom application profiles: emergency communications and high-anonymity reference builds
- [ ] Developer documentation and API reference

## v1.9.0: Security Hardening

- [ ] Third-party cryptographic audit (Cure53 or equivalent), covering `src/core/crypto/`, packet signing, key storage, and `@airhop/core` public API
- [ ] Second independent audit, BLE mesh layer, Nostr bridge, and `@airhop/ble` scope
- [ ] Remediate all audit findings; publish reports publicly

## v2.0.0: Flagship Interface

- [ ] Full UI/UX redesign with design system, accessibility audit (WCAG 2.1 AA), low-end device support
- [ ] Android API 21+ (Android 5.0) and iOS 14+ compatibility verified
- [ ] All docs kept in sync with every release; CVEs disclosed publicly with timeline and impact
- [ ] Audit reports published in full; blog series on building private decentralized applications

## Security Analysis

Two passes, kept separate on purpose: an **adversarial simulation** that runs
attacks against a live mesh, and a **code review** of the diff. The simulation
finds things the review cannot (behaviour under interleaving) and vice versa.

**Threat model.** Anyone in radio range can transmit anything: they can forge
any plaintext header field, replay captured packets, mint unlimited identities,
and drop or corrupt what passes through them. They cannot break Ed25519, Noise
XX, or SHA-256 preimage resistance. Everything below is written against that.

### Attacks run against a live mesh

Each row is an executable scenario in `src/__tests__/simulation/`, run against
fully isolated copies of the app over a modelled radio, not a unit test of the
check itself. "Refused" means the app rejected it _and_ told the user nothing
false while refusing. Grouped by what the attacker is after: be someone else,
replay them, read what is not theirs, exhaust or crash a node, borrow an honest
node's authority, forge money, or hold the phone.

| ID  | Attack                                                                        | Outcome                                                                           |
| --- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| C01 | Message claiming a known peer's ID, unsigned or wrongly signed                | Refused; a missing sender key is a failed check, not a skipped one                |
| C02 | Correctly signed message from that peer (control)                             | Accepted, so C01 is the signature rule rather than a blanket refusal              |
| C08 | Forged ANNOUNCE rebinding a known peer's signing key                          | Refused at all three layers; the victim's real key survives and still verifies    |
| C09 | Forged LEAVE claiming a peer has departed                                     | Neither acted on nor relayed onward; a genuine departure still announces          |
| C10 | Announce naming someone else's Nostr key                                      | Takes no thread and no queued mail; an in-person scan still folds both            |
| M08 | Attachment forged, aimed at the wrong thread, or tagged into an unjoined room | Refused on all three; an attachment carries the same rules text does              |
| C03 | Replay of captured packets                                                    | Deduplicated; nothing renders twice                                               |
| S03 | Stale packet with a perfect signature, into a phone that never saw it         | Refused on age; the matched fresh copy is accepted, so age is what refused it     |
| S09 | Old fragments opening a transfer, beside a genuine slow one                   | Refused and not relayed; the genuine transfer still completes past the window     |
| M07 | Recorded voice burst played out of a stranger's phone later                   | Refused on freshness; a valid signature does not make a burst live                |
| F01 | Outsider standing next to a private group                                     | Ciphertext only; no metadata leak                                                 |
| M09 | Private photo crossing a relay that is not the recipient                      | Sealed inside the Noise session, never signed in the open                         |
| F03 | Store-and-forward carrier inspecting what it carries                          | Sealed; the carrier cannot read it                                                |
| F04 | Tor unavailable                                                               | Fails closed; never silently falls back to clearnet                               |
| C04 | Sybil flood of fabricated peers                                               | Real neighbours never evicted; caps hold                                          |
| B03 | Corrupted packets on the wire                                                 | Rejected; no crash                                                                |
| B08 | DM into a peer that rebooted and lost its session                             | Recovered: the receiver opens a handshake, the retry lands once, marked delivered |
| M03 | File lying about its type (magic bytes vs extension)                          | Refused                                                                           |
| N14 | Gateway asked to publish a deposit aimed at a cell it is not in               | Refused on the `g` tag; a gateway is not an open proxy                            |
| N07 | Nearby-only message reaching the bridge                                       | Never bridged off-mesh                                                            |
| W03 | Same ecash token redeemed twice                                               | Refused by a real BDHKE mint                                                      |
| W14 | Tampered proof handed over with no mint reachable to ask                      | Refused offline on its NUT-12 witness; a real proof still clears                  |
| W22 | Deposit whose answer never arrived                                            | Rebuilt on reconcile from the stored outputs, NUT-19 or NUT-09, credited once     |
| C06 | Phone taken, panic wipe run                                                   | Nothing survives; the rest of the room carries on                                 |

Invariants asserted across all of the above rather than per-scenario: everyone
converges, nothing renders twice, nothing forged renders at all, delivery state
never runs backwards, badges match their threads, and no sat is created or
destroyed.

### Code review findings

Automated security review over the whole codebase, by domain: crypto and key
lifecycle, radio-facing wire parsing, Nostr and payments, native BLE, and the
app layer.

| #   | Finding                                                                   | Severity | Status                                                                                                |
| --- | ------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Double Ratchet root key seeded from the PUBLIC handshake transcript hash  | Critical | Fixed - seeded from the Noise exporter secret instead                                                 |
| 2   | ANNOUNCE accepted unsigned, unbound to its key, and could re-pin a peer's | High     | Fixed - mandatory signature, sender/key binding, TOFU pin                                             |
| 3   | Nutzap redeemed from any mint an incoming event named                     | High     | Fixed - the mint must be one the wallet already holds, which is what NIP-61 assumes                   |
| 4   | `airhop://` contact-card link minted a "Verified" contact                 | High     | Fixed - a linked card records `source: "link"`, never `"qr"`, and may not re-pin keys                 |
| 5   | ANNOUNCE replayable forever, so a departed peer kept looking present      | Medium   | Fixed - 15 min symmetric freshness window; dedup is per device and 5 min, so it was never the defence |
| 6   | Attachment channel tag auto-joined arbitrary rooms                        | Medium   | Fixed - the tag must name a joined room that `canSendMedia` allows                                    |
| 7   | `VOICE_FRAME` had no freshness window, so a burst replayed verbatim       | Medium   | Fixed - 30 s bound plus a broadcast requirement, matching bitchat                                     |
| 8   | Group creator not pinned, so a higher epoch could replace it              | Medium   | Fixed - a group keeps its original creator. Also fixed upstream                                       |
| 9   | Nutzap watcher race against a wipe during startup                         | Medium   | Fixed - startup captures a wipe generation before its first await and re-checks it before installing  |
| 10  | iOS `want*` latch set before validation                                   | Low      | Fixed - the latch is set per state branch; transient states keep it, refusals no longer arm the radio |
| 11  | Outbox receipts not scoped to the receipt's sender                        | Info     | Accepted - message IDs are 8 bytes of CSPRNG never sent in cleartext; availability-only impact        |
