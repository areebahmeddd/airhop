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
- [x] Arti embedded on both platforms from one Rust crate (`native/arti/`): lifecycle, real bootstrap progress, dormancy, per-destination circuit isolation, and a SOCKS5 listener. Android installs the proxy into React Native's OkHttp client so `fetch` is covered too; iOS adds a WebSocket shim, which is the only thing the two platforms do differently
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

## Device Transfer ✅

- [x] Transfer to a new phone ([#8](https://github.com/areebahmeddd/airhop/issues/8)): the new phone shows a code, the old phone scans it, and the identity, contacts, groups, rooms, chat history and wallet cross one TCP connection on the local network. No internet, no server, no backup file
- [x] A move, not a copy: the old phone erases itself (the panic wipe) once the new one commits, and a transfer that ends unconfirmed freezes it until the person answers
- [x] `src/core/move/`: the code (`airhop-move:v1/`), a Noise XX handshake pinned to the scanned key with the code's token as prologue, the bundle and its messages (PROTOCOLS.md section 11)
- [x] `src/services/move-snapshot.ts`: what moves, as a table typed against the panic wipe's registry. One-time prekey private halves never leave the phone; the wallet lands under the new phone's own file key
- [x] Owner check before any key is read (Face ID, fingerprint or passcode, `expo-local-authentication`)
- [x] Six matching words on both phones, from the handshake, before anything moves: the old phone freezes only once the new phone's `CONFIRM` and its own Transfer tap are both in, and a declined match replaces the code. A code naming an address off the phone's own subnets is never dialled
- [x] Crash-safe on both sides through `move-marker.ts`: a half-written install is wiped, an unconfirmed send asks, and an Android boot start waits
- [x] A Mesh banner when this identity is running on another phone too: an announce under our own peer ID, signed with our key, that this run never sent
- [x] The wallet's file key survives the launch sweep and follows a reopen in the same process, so a wallet written before a relaunch or after a wipe stays readable
- [x] Verified end to end by `move-session.test.ts`: two isolated phones over an in-memory socket, with the happy path, a wrong phone, cancels on either side, an older app, a refused keychain, and the link dying mid-stream and after the commit
- [x] No wire change: the same keys give the same peer ID, name, npub and safety numbers, so contacts stay verified and bitchat peers notice nothing. A verified LEAVE drops the ratchet as well as the session, so the first DM to the moved identity re-handshakes

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
check itself. I04 runs in the transfer rig instead
(`src/services/__tests__/move-session.test.ts`): two isolated phones and a third
over an in-memory socket. "Refused" means the app rejected it _and_ told the user nothing
false while refusing. Grouped by what the attacker is after: be someone else,
replay them, read what is not theirs, exhaust or crash a node, borrow an honest
node's authority, forge money, or hold the phone.

| ID   | Attack                                                                              | Outcome                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01  | Message claiming a known peer's ID, unsigned or wrongly signed                      | Refused; a missing sender key is a failed check, not a skipped one                                                                                          |
| C02  | Correctly signed message from that peer (control)                                   | Accepted, so C01 is the signature rule rather than a blanket refusal                                                                                        |
| C08  | Forged ANNOUNCE rebinding a known peer's signing key                                | Refused at all three layers; the victim's real key survives and still verifies                                                                              |
| C09  | Forged LEAVE claiming a peer has departed                                           | Neither acted on nor relayed onward; a genuine departure still announces                                                                                    |
| C10  | Announce naming someone else's Nostr key                                            | Takes no thread and no queued mail; an in-person scan still folds both                                                                                      |
| C14  | After a restart, an announce first as a saved contact, under another key            | Their post, photo, prekey bundle, npub and LEAVE in the contact's name refused; the real contact, one hop away through them, still verifies with no session |
| C14b | Contact saved from a forged link card carrying the attacker's signing key           | The real peer's session proof corrects the stored key; her traffic verifies and she shows nearby                                                            |
| C15  | Stranger in a location DM forwards a friend's card, plain or re-signed              | Every forwarded card refused, nothing written, the friend's key untouched; her own proven card still merges                                                 |
| F10  | Private-room member seals a message in another member's name                        | Dropped on Bluetooth; a copy under the victim's message ID delivered first does not displace hers                                                           |
| C16  | Copied message ID with different text in a named room                               | Both rows shown, each under its author                                                                                                                      |
| I04  | Someone who read the transfer code races the real old phone                         | The new phone installs nothing unless its person confirms matching words; a decline replaces the code and the real phone then completes                     |
| M08  | Attachment forged, aimed at the wrong thread, or tagged into an unjoined room       | Refused on all three; an attachment carries the same rules text does                                                                                        |
| C03  | Replay of captured packets                                                          | Deduplicated; nothing renders twice                                                                                                                         |
| S03  | Stale packet with a perfect signature, into a phone that never saw it               | Refused on age; the matched fresh copy is accepted, so age is what refused it                                                                               |
| S09  | Old fragments opening a transfer, beside a genuine slow one                         | Refused and not relayed; the genuine transfer still completes past the window                                                                               |
| M07  | Recorded voice burst played out of a stranger's phone later                         | Refused on freshness; a valid signature does not make a burst live                                                                                          |
| C09b | Genuine old LEAVE replayed as a sync reply from a neighbour we asked                | Refused, and the peer stays; the same-age channel message is backfilled                                                                                     |
| S11  | Sync request relayed at TTL 7, unsigned, or under another peer's ID                 | No answer and no relay; the link peer's own signed request is answered                                                                                      |
| S12  | Old history tagged `IS_RSR` from a neighbour we asked                               | A two-day-old reply refused; ten-minute and five-hour-old ones backfilled                                                                                   |
| S13  | Sync reply carrying TTL                                                             | Refused at TTL 7; the same reply at TTL 0 is taken                                                                                                          |
| S14  | Stale packet at TTL 0 without `IS_RSR`                                              | Refused on age                                                                                                                                              |
| X04  | Gossip sync with a bitchat-ios phone right after first contact (control)            | Crosses both ways: a three-hour-old message and a day-old fragmented board post are taken, so S11 to S14 refuse nothing bitchat sends                       |
| F01  | Outsider standing next to a private group                                           | Ciphertext only; no metadata leak                                                                                                                           |
| M09  | Private photo crossing a relay that is not the recipient                            | Sealed inside the Noise session, never signed in the open                                                                                                   |
| F03  | Store-and-forward carrier inspecting what it carries                                | Sealed; the carrier cannot read it                                                                                                                          |
| F04  | Tor unavailable                                                                     | Fails closed; never silently falls back to clearnet                                                                                                         |
| C04  | Sybil flood of fabricated peers                                                     | Real neighbours never evicted; caps hold                                                                                                                    |
| C11  | Forged `DR_ENCRYPTED` between two Airhop peers, unsigned or wrongly signed          | Refused before the ratchet moves; the next DM lands in seconds, once, delivered                                                                             |
| C12  | Handshake msg1 flood under 500 random IDs                                           | Pending state stays bounded, at most 30 answered a minute; a genuine first-contact DM completes                                                             |
| C13  | Forged msg2 answering our msg1                                                      | Ignored; the genuine msg2 completes the handshake with no outbox retry                                                                                      |
| C13b | Forged msg1 under a peer's ID while its own handshake is live                       | Displaces it, as in bitchat-ios (accepted); the DM still recovers                                                                                           |
| B03  | Corrupted packets on the wire                                                       | Rejected; no crash                                                                                                                                          |
| B08  | DM into a peer that rebooted and lost its session                                   | Recovered: the receiver opens a handshake, the retry lands once, marked delivered                                                                           |
| B08b | The same, with the peer's last announce past its TTL                                | One ratchet on each side; the DM and its receipt land once                                                                                                  |
| M03  | File lying about its type (magic bytes vs extension)                                | Refused                                                                                                                                                     |
| M13  | More than 100 MiB of received media                                                 | The oldest received file goes first and the newest plays; sent files are untouched                                                                          |
| N14  | Deposit whose signed event names a different cell than its carrier                  | Refused on the `g` tag; a gateway will not relabel a deposit                                                                                                |
| N15  | Bridge deposits under rotating forged sender IDs, unsigned or signed by another key | None published; a depositor signing as itself still is                                                                                                      |
| N07  | Nearby-only message reaching the bridge                                             | Never bridged off-mesh                                                                                                                                      |
| W03  | Same ecash token redeemed twice                                                     | Refused by a real BDHKE mint                                                                                                                                |
| W14  | Tampered proof handed over with no mint reachable to ask                            | Refused offline on its NUT-12 witness; a real proof still clears                                                                                            |
| W24  | One real coin padded with forged ones, handed over in a dead zone                   | Stored as unconfirmed, never "genuine"; online the mint refuses it, none stays in the balance and its row keeps the token                                   |
| W25  | Token relabelling sats as another currency                                          | Refused online and offline; nothing stored, in any currency                                                                                                 |
| W26  | One forged receipt among honest ones taken offline                                  | One refresh swaps the honest ones and refuses the forged one alone; the next refresh has nothing to fail on                                                 |
| W27  | 50 nutzaps locked to the recipient's real key, from forged proofs                   | One mint request each and no Activity rows; a resubscribe replay costs none; a genuine nutzap still lands                                                   |
| W28  | Token from a keyset the mint has since rotated out                                  | Stored as unconfirmed offline rather than refused as forged; redeems online                                                                                 |
| W29  | Token taken in a dead zone, then redeemed by someone else who read it               | Secured by the reconcile pass on reconnect with no tap; the later redeemer is refused                                                                       |
| W22  | Deposit whose answer never arrived                                                  | Rebuilt on reconcile from the stored outputs, NUT-19 or NUT-09, credited once                                                                               |
| C06  | Phone taken, panic wipe run                                                         | Nothing survives; the rest of the room carries on                                                                                                           |

Invariants asserted across all of the above rather than per-scenario: everyone
converges, nothing renders twice, nothing forged renders at all, delivery state
never runs backwards, badges match their threads, and no sat is created or
destroyed.

### Code review findings

Automated security review over the whole codebase, by domain: crypto and key
lifecycle, radio-facing wire parsing, Nostr and payments, native BLE and the
other transports, the app layer, and the release supply chain.

| #   | Finding                                                                                                                              | Severity | Status                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Double Ratchet root key seeded from the PUBLIC handshake transcript hash                                                             | Critical | Fixed - seeded from the Noise exporter secret instead                                                                                                                               |
| 2   | ANNOUNCE accepted unsigned, unbound to its key, and could re-pin a peer's                                                            | High     | Fixed - mandatory signature, sender/key binding, TOFU pin                                                                                                                           |
| 3   | Nutzap redeemed from any mint an incoming event named                                                                                | High     | Fixed - the mint must be one the wallet already holds, which is what NIP-61 assumes                                                                                                 |
| 4   | `airhop://` contact-card link minted a "Verified" contact                                                                            | High     | Fixed - a linked card records `source: "link"`, never `"qr"`, and may not re-pin keys                                                                                               |
| 5   | ANNOUNCE replayable forever, so a departed peer kept looking present                                                                 | Medium   | Fixed - 15 min symmetric freshness window; dedup is per device and 5 min, so it was never the defence                                                                               |
| 6   | Attachment channel tag auto-joined arbitrary rooms                                                                                   | Medium   | Fixed - the tag must name a joined room that `canSendMedia` allows                                                                                                                  |
| 7   | `VOICE_FRAME` had no freshness window, so a burst replayed verbatim                                                                  | Medium   | Fixed - 30 s bound plus a broadcast requirement, matching bitchat                                                                                                                   |
| 8   | Group creator not pinned, so a higher epoch could replace it                                                                         | Medium   | Fixed - a group keeps its original creator. Also fixed upstream                                                                                                                     |
| 9   | Nutzap watcher race against a wipe during startup                                                                                    | Medium   | Fixed - startup captures a wipe generation before its first await and re-checks it before installing                                                                                |
| 10  | iOS `want*` latch set before validation                                                                                              | Low      | Fixed - the latch is set per state branch; transient states keep it, refusals no longer arm the radio                                                                               |
| 11  | Outbox receipts not scoped to the receipt's sender                                                                                   | Info     | Accepted - message IDs are 8 bytes of CSPRNG never sent in cleartext; availability-only impact                                                                                      |
| 12  | Double Ratchet state advanced before a message authenticated, DR packets never signature-checked, and a ratchet outlived its session | High     | Fixed - signature checked first, decryption on a copy kept only once it authenticates, each ratchet bound to its Noise session; a broken one heals only for a session-proven sender |
| 13  | Noise transport replay window aged offsets the wrong way, so recent nonces replayed (inherited from bitchat)                         | Medium   | Fixed - a new highest nonce shifts the LSB-first window left, carrying from the byte below                                                                                          |
| 14  | Noise handshakes unthrottled, pending state unbounded, and one bad msg2 or msg3 ended a good handshake                               | Medium   | Fixed - 10 a minute per claimed peer and 30 inbound msg1 a minute in total, pending entries expire, replies read on a clone                                                         |
| 15  | A forged msg1 under a peer's ID displaces its live handshake                                                                         | Low      | Accepted - bitchat-ios does the same, and the DM recovers (C13b)                                                                                                                    |
| 16  | Courier Noise X seal omitted bitchat-ios's prologue, so courier mail did not open across the two apps                                | High     | Fixed - bitchat-ios's static and prekey prologues, pinned by reference seals from Python `noiseprotocol`                                                                            |
| 17  | One-time prekey private keys stored in plaintext MMKV                                                                                | Medium   | Fixed - one keychain item, deleted by the panic wipe and left alone by the launch sweep                                                                                             |
| 18  | Signing-key pin displaced after a restart or eviction, saved and verified contacts included                                          | High     | Fixed - an announce contradicting a held key is refused whole; every signature check resolves session-proven, then contact, then announce pin                                       |
| 19  | An announced npub was written onto a saved contact before the key check, redirecting Nostr DMs                                       | High     | Fixed - persisted only from an announce a session proof or the contact's own key stands behind; the contact's npub wins                                                             |
| 20  | Prekey bundles refused from anyone quiet for a minute, and not bound to their sender                                                 | Low      | Fixed - accepted from the owner only, both signatures against its held key; a bundle dated ahead of the skew is refused                                                             |
| 21  | Private-room sender not checked against the sealed author, and all authors shared one message ID space                               | Low      | Fixed - sealed sender must be the signer; rows keyed by author and message ID                                                                                                       |
| 22  | Old signed LEAVE replayable through the sync-reply exemption                                                                         | Low      | Fixed - `IS_RSR` admits only types sync serves, and LEAVE is not one                                                                                                                |
| 23  | Chat-screen message IDs from `Math.random`                                                                                           | Low      | Fixed - `newMessageId`, so the premise of #11 holds everywhere                                                                                                                      |
| 24  | `REQUEST_SYNC` relayed, answered at any TTL, and answered unsigned                                                                   | Medium   | Fixed - never relayed; answered only at TTL 0 from the bound link peer, signed, on that peer's budget                                                                               |
| 25  | Sync-reply exemption wider than bitchat-ios's                                                                                        | Medium   | Fixed - `IS_RSR` judged alone, fresh or not; message and group windows raised to bitchat-ios's 6 h so its backfill still lands                                                      |
| 26  | No disk budget for received attachments                                                                                              | Medium   | Fixed - 100 MiB, oldest out first, sent files not counted                                                                                                                           |
| 27  | An untagged public file re-joined `#bluetooth`, and a failed write left half a file                                                  | Low      | Fixed - dropped unless the room is joined; a partial file is deleted                                                                                                                |
| 28  | Offline check called a token genuine when only some coins carried a witness                                                          | Medium   | Fixed - "valid" only when every coin's witness verifies                                                                                                                             |
| 29  | A token's declared unit trusted, never checked against its keysets                                                                   | Medium   | Fixed - a unit its keysets contradict is refused, online and off                                                                                                                    |
| 30  | Refresh marked coins verified from a state check, and one bad coin blocked the account for good                                      | Medium   | Fixed - verified only by a swap; each receipt swapped on its own, a refused one kept as a token on its row                                                                          |
| 31  | Coins locked to someone else accepted offline as money                                                                               | Medium   | Fixed - refused before anything is stored; coins locked to us are claimed online                                                                                                    |
| 32  | Nutzap spam became pending rows and unbounded mint traffic                                                                           | Medium   | Fixed - `#u` filter, lock and mint checked before any request, one event at a time, never retried once refused                                                                      |
| 33  | A nutzap from an unheld mint wrote a failed Activity row                                                                             | Low      | Fixed - settled with no row                                                                                                                                                         |
| 34  | Nutzap markers capped by count, so spam evicted genuine ones                                                                         | Low      | Fixed - pruned by the 30-day lookback                                                                                                                                               |
| 35  | Tokens from a rotated keyset refused as forged                                                                                       | Medium   | Fixed - "unchecked" offline; online the old keyset's keys are fetched by ID                                                                                                         |
| 36  | The recipient's kind 10019 was whichever event arrived first                                                                         | Low      | Fixed - newest by `created_at`, then lowest id                                                                                                                                      |
| 37  | Chat tokens drove keyset refreshes past the per-mint throttle                                                                        | Low      | Fixed - one fetch per mint every five minutes                                                                                                                                       |
| 38  | Receiving overwrote the mint's unit list                                                                                             | Low      | Fixed - only a mint snapshot writes units                                                                                                                                           |
| 39  | Airhop's own nutzaps dropped the DLEQ witness and the unit tag                                                                       | Low      | Fixed - both published                                                                                                                                                              |
| 40  | A recovery phrase the keychain would not read was treated as none, and could be replaced                                             | Low      | Fixed - only a confirmed absence starts a new phrase                                                                                                                                |
| 41  | A stored but invalid recovery phrase was treated as none                                                                             | Low      | Fixed - kept, with its flags, and never overwritten                                                                                                                                 |
| 42  | Wallet encryption overstated; the iOS Tor gate was checked once per reconcile pass                                                   | Low      | Fixed - docs say AES-256-CFB, confidentiality only; the gate is read before every request                                                                                           |
| 43  | Offline receipts never redeemed automatically when the network returned                                                              | Medium   | Fixed - the reconcile pass swaps them, two accounts per pass                                                                                                                        |
| 44  | A payment's confirm did not say its fee came from a stale cache                                                                      | Low      | Fixed - the note joins whichever question is asked                                                                                                                                  |
| 45  | A forwarded contact card merged a location pseudonym into a contact's DM thread                                                      | High     | Fixed - a card needs its owner's signature over both cell keys, and one contradicting a held key is refused                                                                         |
| 46  | Place-name geocoding ignored Tor and the internet switch                                                                             | Medium   | Fixed - no lookup while the internet is off or Tor is on or wanted                                                                                                                  |
| 47  | The geohash jump sheet read place names under the wrong key, re-querying                                                             | Low      | Fixed - reads through `placeNameKey`                                                                                                                                                |
| 48  | Bridge deposits reached BridgeService unauthenticated                                                                                | Low      | Fixed - addressed to us and signed by the depositor; cheap gates run before event verification                                                                                      |
| 49  | nostr-tools recorded an event ID as seen before verifying it, so one relay could hide another's copy                                 | Medium   | Fixed - one subscription per relay, and Airhop's own ID set recorded after verification                                                                                             |
| 50  | Android HTTP clients outside React Native's factory bypassed Tor; the update check ignored the internet switch                       | Medium   | Fixed - a default `ProxySelector` routes web schemes only; the Version screen checks both switches                                                                                  |
| 51  | Tor SOCKS route left pointing at the port on a failed start, and no per-destination isolation on Android                             | Medium   | Fixed - held on a dead proxy until Arti binds and while it stops; circuits isolated by destination, live with the next native rebuild                                               |
| 52  | Only one OkHttp connection pool evicted when Tor came on                                                                             | Low      | Fixed - one shared pool, emptied on every route change; a request on an old-route connection is refused and its socket closed                                                       |
| 53  | Presence heartbeats went to the default DM relays                                                                                    | Medium   | Fixed - to the cell's geo relays, skipped when it has none                                                                                                                          |
| 54  | A location channel message's `mid` tag was its row ID, so a copy with other text won the race                                        | Low      | Fixed - the row ID hashes the message ID with the text                                                                                                                              |
| 55  | `unwrapDm` did not type-check the rumor                                                                                              | Low      | Fixed - `validateEvent` and kind 14 before anything reads it                                                                                                                        |
| 56  | `validateRelayUrl` accepted hex and octal IPv4                                                                                       | Info     | Fixed - every spelling a WHATWG parser reads as IPv4 is refused                                                                                                                     |
| 57  | A crash during Tor start made the next launch run relays on the clear net                                                            | Low      | Fixed - fails closed: Tor stays on, relays held, Try again on the Tor screen                                                                                                        |
| 58  | A gateway publishes a deposit for any cell its carrier and event agree on                                                            | Info     | Accepted - teleported and region channels need it, and bitchat-ios restricts no cell either                                                                                         |
| 59  | Courier-drop backfill capped at 20 per relay                                                                                         | Low      | Fixed - 100, as bitchat-ios                                                                                                                                                         |
| 60  | The set of urgent board notices already announced grew without bound                                                                 | Info     | Fixed - bounded at 2,000                                                                                                                                                            |
| 61  | Android Wi-Fi Aware listener accepted any interface and reported a link before the hello                                             | Medium   | Fixed - Aware interfaces only; a link is reported after its first hello, inbound only on a path this side opened                                                                    |
| 62  | TCP listeners had no connection cap, a thread per socket, a per-read deadline and a fragile accept loop                              | Medium   | Fixed - caps of 16 LAN, 4 transfer and 4 awaiting a hello; 30 s frame and write-stall deadlines; the accept loop survives errors                                                    |
| 63  | iOS LAN listener and browser opted into AWDL                                                                                         | Low      | Fixed - peer-to-peer off; cellular and loopback refused                                                                                                                             |
| 64  | Device transfer: the new phone installed whichever identity finished the handshake first, with nothing to confirm                    | Low      | Fixed - six words on both phones and a `CONFIRM` (`0x07`); nothing freezes or installs before it                                                                                    |
| 65  | Device transfer dialled any IPv4 address the code named                                                                              | Medium   | Fixed - only an address on one of the phone's own subnets                                                                                                                           |
| 66  | A slow or refusing keychain at launch was read as no identity, sweeping the wallet secrets                                           | Medium   | Fixed - "unreadable" is its own outcome: a retry screen, nothing swept                                                                                                              |
| 67  | An iOS relaunch before first unlock reached onboarding, which then overwrote the identity                                            | Medium   | Fixed - the unreadable screen retries whenever the app comes to the front                                                                                                           |
| 68  | Android photos under 512 KiB kept their EXIF, GPS included                                                                           | Medium   | Fixed - JPEG and WebP are always re-encoded                                                                                                                                         |
| 69  | Announced nicknames kept bidi and invisible characters                                                                               | Low      | Fixed - stripped on arrival and in every translated placeholder, ZWNJ and ZWJ kept                                                                                                  |
| 70  | Picker copies escaped retention and Clear, and iOS `tmp` escaped the wipe                                                            | Medium   | Fixed - adopted into the attachment cache or deleted on cancel; the iOS wipe empties `tmp`                                                                                          |
| 71  | OS-delivered `airhop://` links joined rooms and imported contacts without a tap                                                      | Low      | Fixed - they open the Join sheet, filled in                                                                                                                                         |
| 72  | Received file names and types taken from the sender                                                                                  | Low      | Fixed - extension from the checked type; video held to MP4 and QuickTime by its box                                                                                                 |
| 73  | The wipe sheet did not say what stays behind                                                                                         | Info     | Fixed - it says gallery saves stay                                                                                                                                                  |
| 74  | A refused-key wipe followed by a kill reloaded the old identity                                                                      | Low      | Fixed - the identity is marked condemned, deleted again at launch, and never boots                                                                                                  |
| 75  | Release APK fell back to the public debug key                                                                                        | Medium   | Fixed - an empty signing secret fails the job; exactly one signer, the pinned certificate                                                                                           |
| 76  | Signing key beside npm and Gradle code, persisted checkout tokens, unpinned CocoaPods gems                                           | Medium   | Fixed - built unsigned with no secrets, signed in a job that checks out nothing; tokens not persisted; CocoaPods pinned with checksums in `Gemfile.lock`                            |
| 77  | Tor transports carried reachable Go panic advisories; Rust and rustls behind                                                         | Medium   | Fixed in source - pion/stun, pion/dtls and x/text raised, Rust 1.98.1, rustls 0.23.45; live with the next native rebuild                                                            |
| 78  | Sideloaded APKs could not be checked, and the documented verify command was loose                                                    | Low      | Fixed - the certificate's SHA-256 and strict verify commands published                                                                                                              |
| 79  | `verify-vendored` tied binaries to a lock, not to the build, and the docs overclaimed                                                | Low      | Fixed - the lock is checked against the build's `SHA256SUMS`, stray binaries are refused, and the claim is corrected                                                                |
| 80  | Expression injection in the release tag resolver                                                                                     | Low      | Fixed - no tag input; the ref reaches `run:` only through `env:`, and only a tag is accepted                                                                                        |
| 81  | `knip` fetched unpinned at run time                                                                                                  | Low      | Fixed - a locked devDependency                                                                                                                                                      |
| 82  | Gradle distribution unchecked, and JitPack consulted for every dependency                                                            | Low      | Fixed - `distributionSha256Sum` set; JitPack removed                                                                                                                                |
| 83  | Automation committed straight to the triggering branch, `main` included                                                              | Low      | Fixed - native rebuilds and lock syncs refuse `main` and tags                                                                                                                       |
| 84  | The landing site asked GitHub for the release from every visitor                                                                     | Low      | Fixed - the version is stamped at build time; `connect-src 'self'`                                                                                                                  |
| 85  | Bridge sync validated only a line's leading tokens                                                                                   | Low      | Fixed - one line of printable ASCII, or refused                                                                                                                                     |
| 86  | Release jobs checked out a same-named branch instead of the tag                                                                      | Medium   | Fixed - every job checks out the tag's commit and asserts it                                                                                                                        |
