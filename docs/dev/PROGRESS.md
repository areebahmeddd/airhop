# Airhop: Build Progress

Where the build stands: what exists and how it is verified, what is in flight, and what is blocked. Read it before starting work. It is updated when a milestone completes, a blocker appears or a decision is made. What comes next, and when, is in [ROADMAP.md](../design/ROADMAP.md); what each release contained is in [CHANGELOG.md](CHANGELOG.md).

## Current Version: v1.0.0

**Verified by tests:** the packet codec (v1 and v2 headers, padding, compression), fragment format and reassembly, Noise XX, the Double Ratchet, courier envelopes (static and prekey-sealed), one-time prekey bundles, gossip filters (including type-aware board rounds), bulletin-board wire and store quotas, private-group wire and epoch keys, the gateway carrier codec, mesh ping and pong, outbox delivery, contact-card binding, geohash derivation and relay determinism, the geohash DM round trip, Nostr gift wrap and the bitchat envelope, and proof selection. Wire decoders are fuzzed, and where bitchat publishes or implies a byte layout a vector test pins it: packet frames, payloads, courier seals ([`courier-seal-vectors.json`](../spec/courier-seal-vectors.json)), private media IDs and Nostr DMs.

**Verified by the multi-device simulation** (`src/__tests__/simulation/`): multi-hop delivery across a chain of phones that cannot hear each other, a 25-phone room converging on one channel, a live mixed Airhop and bitchat mesh in both directions, parallel attachment transfers, live push-to-talk sharing a radio with a file transfer, offline ecash transfer and double-spend refusal against a real BDHKE mint, recovery from a swap whose answer never came back, replay and Sybil floods, panic wipe, crash recovery, and a seeded soak of hundreds of random events across eight phones. Each simulated phone is a fully isolated copy of the app driven through a modeled OS and radio. `conformance.test.ts` checks Airhop's constants against a local bitchat checkout, and skips when there is none.

**Still cannot be verified without hardware:** real BLE discovery timing, MTU negotiation, CoreBluetooth on real silicon, OEM battery managers, and real Tor circuits. The simulation models the OS contract; it cannot prove the hardware honors it.

**Built with:** Claude Opus 5 (1M context) in Claude Code, working against local checkouts of bitchat-ios and bitchat-android as the protocol source of truth. The multi-device simulation, the adversarial scenarios, and the security review below were produced the same way. Every claim here is meant to be checkable against the code rather than taken on trust.

**Blocked:**

| Item                                                | Waiting on                          |
| --------------------------------------------------- | ----------------------------------- |
| Collapse the per-relay Nostr subscriptions into one | A nostr-tools release carrying #560 |

**Known gaps, accepted:**

- More than 1,000 lost Double Ratchet messages in one chain (`MAX_SKIP`) leave a pair out of step until a restart or a `LEAVE`. A replay raises the same error, so healing on it would let any listener tear a session down; bitchat-ios makes the same trade.
- A courier hands mail over on any link bound by a direct announce, where bitchat-ios also requires a Noise session made on that link ([PROTOCOLS.md](../spec/PROTOCOLS.md#61-depositing-and-carrying)).
- The app-switcher snapshot cover needs Android API 33, leaving API 26 to 32 exposed ([ARCHITECTURE.md](../spec/ARCHITECTURE.md#countermeasures)).
- A public `#bluetooth` message retried after an app kill can show twice to a neighbor who had the first copy, since those packets carry no message ID.
- On Android the globe picker draws with Vulkan 1.1, which every 64-bit phone launched on Android 10 or later has. A phone without it (older, 32-bit or Android Go) still installs Airhop, since the manifest drops Skia's Vulkan requirement, but is not offered the globe and picks a location channel by typing its geohash. Every supported iPhone has Metal.

## What Exists

Each milestone lists what it delivered. The plan each one answered is in [ROADMAP.md](../design/ROADMAP.md#2-version-targets).

### v0.5.0: Foundation

- [x] Expo bare workflow, TypeScript strict, Jest over `src/core/`, folder layout per [ARCHITECTURE.md section 11](../spec/ARCHITECTURE.md#11-codebase-layout)
- [x] `AirhopBLEModule`: dual-role GATT on both platforms (`CBPeripheralManager` + `CBCentralManager`, `BluetoothGattServer` + `BluetoothLeScanner`), exposed through `src/bridge/NativeAirhopBLE.ts`
- [x] `AirhopForegroundService.kt` (`connectedDevice` type), started with the mesh, so the process, BLE and the Nostr socket survive backgrounding
- [x] `src/core/mesh/wire/packet-codec.ts`: binary encode and decode, matching [PROTOCOLS.md](../spec/PROTOCOLS.md#2-packet-frame-layout) byte for byte
- [x] `src/core/mesh/routing/flood-router.ts` and `deduplicator.ts`: TTL flood with 10 to 220 ms jitter by degree, LRU 1,000-entry seen-set
- [x] `src/core/mesh/links/link-registry.ts`: open links per radio, peer bindings, writes
- [x] `src/core/mesh/discovery/announce-manager.ts`: signed presence broadcasts
- [x] `src/core/crypto/identity.ts`: key generation, keychain storage, peer ID derivation
- [x] Local notifications (`expo-notifications`, no push server): per-conversation heads-up, tap to open, badge synced to unread

### v0.6.0: Core Messaging

- [x] `src/core/crypto/noise-xx.ts`: the full XX pattern over `@noble`, transport encrypt and decrypt, replay window
- [x] `src/core/crypto/noise-x.ts`: one-way Noise X for courier sealing
- [x] `src/core/mesh/routing/fragment-manager.ts`: split and reassemble (467 data bytes per 512-byte frame), 30 s idle timeout, 128 concurrent assemblies
- [x] `src/core/mesh/sync/gossip-sync.ts`: GCS filter reconciliation (Golomb-Rice, TLV wire format)
- [x] `src/core/mesh/courier/courier-store.ts`: sealed envelopes, trust tiers, spray-and-wait, daily recipient tags
- [x] `src/core/router/message-router.ts`: broadcast, unicast, courier fallback
- [x] `packet-frame-vectors.test.ts`: peer ID derivation, byte offsets, signature relay compatibility, ANNOUNCE TLV, fragment constants, BLE UUIDs
- [x] Basic UI: channel list, message thread, peer list

### v0.7.0: Internet Bridge and Voice

- [x] `src/core/nostr/nostr-client.ts`: SimplePool, auto-reconnect, proxy config
- [x] `src/core/nostr/gift-wrap.ts`: NIP-17/59 gift-wrap DMs, HKDF key derivation
- [x] `src/core/nostr/geo-relay.ts`: Haversine nearest relays from the bundled CSV; the channel info sheet lists the relays carrying a cell and marks the ones the user added
- [x] `src/core/nostr/geohash-presence.ts`: kind 20001 heartbeats every 40 to 80 s, never finer than precision 5
- [x] `src/core/nostr/courier-relay.ts`: Nostr courier drops (kind 1401, NIP-40 expiry)
- [x] Arti embedded on both platforms from one Rust crate (`native/arti/`) behind `AirhopTorModule` (`src/bridge/NativeAirhopTor.ts`): lifecycle, real bootstrap progress, dormancy, per-destination circuit isolation, and a SOCKS5 listener on 39050. Android installs the proxy into React Native's OkHttp client so `fetch` is covered too; iOS adds a WebSocket shim, which is the only thing the two platforms do differently
- [x] Bridges and pluggable transports: obfs4, Snowflake and WebTunnel compiled in from `native/iptproxy/`, reached over loopback because iOS forbids the child processes Arti would otherwise manage. Built-in bridge lines are synced from the Tor Project; off by default
- [x] Reproducible native builds: `native/arti/build-in-container.sh` pins Rust, the NDK and a Debian snapshot; `build-apple.sh` produces the xcframework; both verify exported symbols, and Android also verifies 16 KiB page alignment and that no build-machine path survived
- [x] `src/services/tor-routing.ts`: the single toggle and startup choke point. Every relay connection is dialled through the proxy, so Tor fails closed
- [x] Push-to-talk: `voice-capture.ts` and `voice-player.ts` (AAC-LC 16 kHz mono, 350 ms jitter buffer), with `AirhopVoiceModule` streaming mic and speaker off the JS thread. `VOICE_FRAME` (`0x29`) is relayed in the mesh, and DM bursts ride `NoisePayloadType.VOICE_FRAME` (`0x08`). Hold-to-talk UI with a live HUD, a floor-courtesy hint and autoplay gating
- [x] `src/core/router/message-router.ts`: Nostr added after the radios, before the courier

### v0.8.0: Identity and Forward Secrecy

- [x] `src/core/crypto/double-ratchet.ts`: Signal Double Ratchet, per-message forward secrecy. The root key comes from the Noise XX **exporter secret**, so it cannot be rebuilt from long-lived keys or from the public handshake bytes
- [x] One-time prekey bundles (`src/core/mesh/wire/prekey-bundle.ts`, `src/core/mesh/courier/prekey-store.ts`) gossiped as `0x24`, never published to Nostr. **X3DH is not used**: the handshake already seeds the ratchet ([ARCHITECTURE.md section 5](../spec/ARCHITECTURE.md#5-encryption))
- [x] `src/core/crypto/contact-exchange.ts`: binary contact card over the `airhop:v1/<base64url>` QR scheme, peer ID checked against the keys it carries; a card arriving by link is recorded unverified
- [x] `src/utils/username.ts`: deterministic adjective-noun-suffix name from the peer ID, 128-entry word lists
- [x] `src/services/panic-wipe.ts`: clears every keychain item, all MMKV partitions, the media cache, the notification tray and Arti's data directory, and reports whether the keys were destroyed. `wipe-marker.ts` records the intent first, so a wipe killed mid-run finishes on the next launch

### v0.9.0: Wi-Fi Transports

- [x] Wi-Fi Aware on both platforms: Apple's `WiFiAware` framework on iOS, `WifiAwareManager` on Android, on by default
- [x] `AirhopLANModule`: mDNS discovery plus TCP links (`NWListener` / `NWBrowser`, `NsdManager`), carrying the same packets the radio carries
- [x] `src/services/lan-controller.ts`: link lifecycle, registered beside BLE and Wi-Fi Aware, off by default behind `lanTransportEnabled`
- [x] `src/services/lan-dial-policy.ts`: the ring that caps LAN at 8 links per phone
- [x] Video and any other allowed file type shared as attachments, played inline
- [x] Battery optimization flow (`src/platform/battery-optimization.ts`: OEM deep links for 10 skins, standard Android fallback)

### v0.9.5: Localization

- [x] Translation runtime with no library (`src/i18n/index.ts`: `t` / `useT` / `tPlural`, named-placeholder interpolation)
- [x] Completeness enforced by `tsc` (`src/i18n/locales/types.ts`: every locale is a `Record<TranslationKey, string>` derived from `en.ts`, so a partial locale does not compile and there is no runtime fallback)
- [x] Every user-facing string in the catalog, zero hardcoded, enforced in CI
- [x] 35 catalogs, matching the set the landing site serves
- [x] Locale store, in-app picker, and device language negotiation through `Intl`
- [x] CLDR plurals for all 35 (`src/i18n/plurals.ts`), checked against Node's ICU for every integer 0 to 2000
- [x] Right to left for Arabic, Persian and Urdu (`src/i18n/layout.ts`: `textAlignEnd`, mirrored chevrons; logical properties app-wide; `radar-view.tsx` exempt as a polar plot of physical space)
- [x] Layout direction pinned at startup, and a direction change applied on the next launch rather than by restarting the process
- [x] Persisted rows carry a catalog key and translate on render, so history follows a language change
- [x] Formatting centralized in `src/utils/format.ts`: cached formatters, Latin numerals for machine data
- [x] `scripts/i18n-build-locale.js`: builds a catalog from a translation map, refusing one with a missing key, a dropped placeholder, a wrong plural category, a localized protocol token or a stray script
- [x] `scripts/i18n-audit.js`: hardcoded strings, unreferenced keys and frozen translations, read from the TypeScript AST so wrapped JSX text and template literals are in scope
- [x] CI guards: a hardcoded-string ceiling of zero, no translation frozen at module load or in a memo, no physical style properties
- [x] i18n tests (`src/i18n/__tests__/`: placeholder parity, plural categories, do-not-translate enforcement, terminal punctuation per script)
- [x] Catalog ordered by screen (shell, onboarding, chats, mesh, wallet, contacts, settings), so one screen's copy is one contiguous block

### v0.9.6: Cashu Wallet

- [x] `src/core/payments/cashu.ts`: detection (identical to bitchat's), decoding, NUT-12 DLEQ verification against cached keysets, fee-aware proof selection
- [x] `src/core/payments/nutzap.ts`: NIP-61 kind 9321 / 10019 construction and parsing
- [x] `src/core/payments/wallet-seed.ts`: BIP-39 recovery phrase, kept in the keychain
- [x] `src/store/wallet-store.ts`: AES-256 encrypted proofs, per (mint, unit) accounts, reserved bucket, history, NUT-13 counters
- [x] `src/services/wallet-service.ts`: the only module that talks to a mint
- [x] `src/services/payment-router.ts`: `payPerson`, one payment ladder (radio, nutzap, token, manual) shared by all four entry points: DM attach, contact sheet, Mesh peer sheet and Wallet Zap
- [x] Send that reserves rather than deletes, so an undelivered token is reclaimable
- [x] Lightning deposit and withdrawal (NUT-04 / NUT-05) with a quoted routing reserve
- [x] Opt-in recovery phrase (NUT-13 / NUT-09), off by default, with any uncovered balance shown
- [x] Mint management: validated add, per-mint balances, consolidate over Lightning
- [x] Nutzap send and receive, with an honest fallback when the recipient publishes no NIP-61 info
- [x] Tap the balance to read it in sats or bitcoin (display only, no price feed)
- [x] QR display and scan for tokens, so a hand-off works without BLE and with Cashu wallets that are not Airhop

### v1.0.0: UI and Store Release

- [x] Onboarding: welcome, animated identity generation, username reveal
- [x] Visual design: design tokens (`Colors`, `FontSize`, `FontWeight`, `Spacing`) in `src/ui/theme.ts`, light and dark themes, Feather icons
- [x] Animations: keyframe spin and fade during identity generation, fade-up reveal on the username screen
- [x] Navigation shell: 4-tab state machine (Chats / Mesh / Wallet / Profile), sub-tab segment (Channels / Direct)
- [x] Accessibility audit
- [x] App Store and Play Store submission
