# Airhop: Build Progress

Where the build stands: what exists and how it is verified, what is in flight, and what is blocked. Read it before starting work. It is updated when a milestone completes, a blocker appears or a decision is made. What comes next, and when, is in [ROADMAP.md](../design/ROADMAP.md); what each release contained is in [CHANGELOG.md](CHANGELOG.md).

## Current Version: v1.0.0

**Verified by tests:** the packet codec (v1 and v2 headers, padding, compression), fragment format and reassembly, Noise XX, the Double Ratchet, courier envelopes (static and prekey-sealed), one-time prekey bundles, gossip filters (including type-aware board rounds), bulletin-board wire and store quotas, private-group wire and epoch keys, the gateway carrier codec, mesh ping and pong, outbox delivery, contact-card binding, geohash derivation and relay determinism, the geohash DM round trip, Nostr gift wrap and the bitchat envelope, and proof selection. Wire decoders are fuzzed, and where bitchat publishes or implies a byte layout a vector test pins it: packet frames, payloads, courier seals ([`courier-seal-vectors.json`](../spec/courier-seal-vectors.json)), private media IDs and Nostr DMs.

**Verified by the multi-device simulation** (`src/__tests__/simulation/`): multi-hop delivery across a chain of phones that cannot hear each other, a 25-phone room converging on one channel, a live mixed Airhop and bitchat mesh in both directions, parallel attachment transfers, live push-to-talk sharing a radio with a file transfer, offline ecash transfer and double-spend refusal against a real BDHKE mint, recovery from a swap whose answer never came back, replay and Sybil floods, panic wipe, crash recovery, and a seeded soak of hundreds of random events across eight phones. Each simulated phone is a fully isolated copy of the app driven through a modeled OS and radio. `conformance.test.ts` checks Airhop's constants against a local bitchat checkout, and skips when there is none.

**Still cannot be verified without hardware:** real BLE discovery timing, MTU negotiation, CoreBluetooth on real silicon, OEM battery managers, and real Tor circuits. The simulation models the OS contract; it cannot prove the hardware honors it.

**Built with:** Claude Opus 5 (1M context) in Claude Code, working against local checkouts of bitchat-ios and bitchat-android as the protocol source of truth. The multi-device simulation, the adversarial scenarios, and the security review below were produced the same way. Every claim here is meant to be checkable against the code rather than taken on trust.

**Blocked:**

| Item                                                        | Waiting on                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| Mark copied recovery phrases and tokens sensitive (Android) | `expo-clipboard` 58, which ships with Expo SDK 58 (still a preview) |
| Collapse the per-relay Nostr subscriptions into one         | A nostr-tools release carrying #560                                 |
| Drop the Go dependency raise in the pluggable transports    | An IPtProxy release that carries it                                 |

**Known gaps, accepted:**

- More than 1,000 lost Double Ratchet messages in one chain (`MAX_SKIP`) leave a pair out of step until a restart or a `LEAVE`. A replay raises the same error, so healing on it would let any listener tear a session down; bitchat-ios makes the same trade.
- A courier hands mail over on any link bound by a direct announce, where bitchat-ios also requires a Noise session made on that link ([PROTOCOLS.md](../spec/PROTOCOLS.md#61-depositing-and-carrying)).
- The app-switcher snapshot cover needs Android API 33, leaving API 26 to 32 exposed ([ARCHITECTURE.md](../spec/ARCHITECTURE.md#countermeasures)).
- A public `#bluetooth` message retried after an app kill can show twice to a neighbor who had the first copy, since those packets carry no message ID.

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
- [x] Bridges and pluggable transports: obfs4 and Snowflake compiled in from `native/iptproxy/`, reached over loopback because iOS forbids the child processes Arti would otherwise manage. Built-in bridge lines are synced from the Tor Project; off by default
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
- [x] Navigation shell: 4-tab state machine (Chats / Mesh / Wallet / Profile), sub-tab segment (Channels / Direct), Android BackHandler for in-thread back navigation. The AI tab arrives with the assistant in v1.1.0; there is no placeholder tab for it
- [x] Accessibility audit
- [x] App Store and Play Store submission
- [x] YouTube demo series

## Security Analysis

The findings worth knowing: the ones that were subtle, cross-cutting or would have broken the security model. The full record of every finding, its fix and commit, the accepted risks and the upstream gaps is [SECURITY-REVIEW-1.0.9.md](SECURITY-REVIEW-1.0.9.md).

**Threat model.** Anyone in radio range can transmit anything: forge any plaintext header field, replay captured packets, mint unlimited identities, and drop or corrupt what passes through them. They cannot break Ed25519, Noise XX, or SHA-256 preimage resistance.

### Attacks run against a live mesh

Each row is an executable scenario in `src/__tests__/simulation/` (I04 in `src/services/__tests__/move-session.test.ts`), run against isolated copies of the app over a modeled radio. "Refused" means the app rejected it and told the user nothing false while refusing. Across every scenario the harness also asserts that nothing forged renders, nothing renders twice, delivery state never runs backwards and no sat is created or destroyed.

| ID   | Attack                                                                   | Outcome                                                                                                            |
| ---- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| C08  | Forged ANNOUNCE rebinding a known peer's signing key                     | Refused at all three layers; the real key survives and still verifies                                              |
| C14  | After a restart, an announce first as a saved contact, under another key | Everything sent in the contact's name refused; the real contact, one hop away through the attacker, still verifies |
| C14b | Contact saved from a forged link card carrying the attacker's key        | The real peer's session proof corrects the stored key                                                              |
| C15  | Stranger in a location DM forwards a friend's card, plain or re-signed   | Every forwarded card refused; the friend's key untouched                                                           |
| F10  | Private-room member seals a message in another member's name             | Dropped; a copy under the victim's message ID does not displace hers                                               |
| I04  | Someone who read the transfer code races the real old phone              | Nothing installs unless the person confirms matching words; a decline replaces the code                            |
| S03  | Stale packet with a perfect signature, into a phone that never saw it    | Refused on age; the matched fresh copy is accepted                                                                 |
| M07  | Recorded voice burst played out of a stranger's phone later              | Refused on freshness and not relayed; a valid signature does not make a burst live                                 |
| S15  | 1,100 forged messages under a real peer's ID, then a latecomer syncs     | The forgeries are neither kept nor served; the latecomer gets the real peer's messages                             |
| C11b | Genuine Double Ratchet packet replayed past dedup                        | The failed decrypt is discarded and the session kept                                                               |
| C12  | Handshake msg1 flood under 500 random IDs                                | Pending state bounded, at most 30 answered a minute; a genuine first contact completes                             |
| F03  | Store-and-forward carrier inspecting what it carries                     | Sealed; the carrier cannot read it                                                                                 |
| F04  | Tor unavailable                                                          | Fails closed; never silently falls back to the clear net                                                           |
| W24  | One real coin padded with forged ones, handed over in a dead zone        | Stored unconfirmed, never "genuine"; online the mint refuses it and none stays in the balance                      |
| W27  | 50 nutzaps locked to the recipient's key, from forged proofs             | No Activity rows, no retries; a genuine nutzap still lands                                                         |
| W29  | Token taken in a dead zone, then redeemed by someone else who read it    | Secured by the reconcile pass when the internet returns; the later redeemer is refused                             |
| C06  | Phone taken, panic wipe run                                              | Nothing survives; the rest of the room carries on                                                                  |

### Code review findings

| Finding                                                                                                                  | Severity | Fix                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------- |
| Double Ratchet root key seeded from the public handshake transcript hash                                                 | Critical | Seeded from the Noise exporter secret                                                                               |
| ANNOUNCE accepted unsigned, unbound to its key, and able to re-pin a peer's key                                          | High     | Mandatory signature, sender and key binding, TOFU pin                                                               |
| Signing-key pin displaced after a restart or eviction, saved and verified contacts included                              | High     | An announce contradicting a held key is refused whole; keys resolve session-proven, then contact, then announce pin |
| An announced npub written onto a saved contact before the key check, redirecting Nostr DMs                               | High     | Persisted only when a session proof or the contact's own key stands behind it                                       |
| A forwarded contact card merged a location pseudonym into a contact's DM thread                                          | High     | A card needs its owner's signature over both cell keys                                                              |
| An `airhop://` link minted a "Verified" contact                                                                          | High     | A linked card is never verified and may not re-pin keys                                                             |
| Double Ratchet state advanced before a message authenticated, and a ratchet outlived its session                         | High     | Signature first, decrypt on a copy, each ratchet bound to its Noise session                                         |
| Courier seal omitted bitchat-ios's Noise X prologue, so courier mail never opened across the two apps                    | High     | bitchat-ios's prologues, pinned by reference seals from Python `noiseprotocol`                                      |
| A nutzap redeemed from any mint the incoming event named                                                                 | High     | Only a mint the wallet already holds, as NIP-61 assumes                                                             |
| Noise replay window aged offsets the wrong way, so recent nonces replayed (inherited from bitchat)                       | Medium   | A new highest nonce shifts the window correctly                                                                     |
| Files, board posts and voice frames relayed before they were checked                                                     | Medium   | Checked before relay and before dedup, as bitchat-ios does                                                          |
| nostr-tools recorded an event as seen before verifying it, so one relay could hide another's copy                        | Medium   | One subscription per relay; Airhop records IDs only after verification                                              |
| Android HTTP clients outside React Native bypassed Tor, and place-name lookups ignored Tor and the internet switch       | Medium   | A default `ProxySelector` for web schemes; no lookups while Tor is on or the internet is off                        |
| A crash during Tor start, or a refused bridge change, put the relays on the clear net                                    | Medium   | Fails closed: Tor stays on and the relays are held until it connects                                                |
| A DM photo or voice note could go as signed cleartext before a session existed, or to a peer unable to read sealed media | Medium   | A DM attachment goes only sealed; with no session the handshake starts and the send waits                           |
| The offline check called a token genuine when only some coins carried a witness                                          | Medium   | "Genuine" only when every coin's DLEQ witness verifies                                                              |
| A slow keychain at launch read as no identity, sweeping the wallet secrets                                               | Medium   | "Unreadable" is its own outcome: a retry screen, nothing swept                                                      |
| Device transfer installed whichever identity finished the handshake first                                                | Medium   | Six matching words on both phones and a confirm before anything installs                                            |
| Android photos under 512 KiB kept their EXIF, GPS included                                                               | Medium   | JPEG and WebP are always re-encoded                                                                                 |
| The release APK could fall back to the public debug key                                                                  | Medium   | An empty signing secret fails the job; exactly one signer, the pinned certificate                                   |
| A DM to a peer gone for over a minute was never couriered                                                                | Medium   | Sealed to the last known key and handed to the next carrier                                                         |
