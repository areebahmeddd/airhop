# Airhop: Glossary

Short definitions of the terms used across the docs and the code, for anyone reading them for the first time. Each entry says what the term means and where Airhop uses it; the behavior itself is specified in [ARCHITECTURE.md](../spec/ARCHITECTURE.md) and the constants in [PROTOCOLS.md](../spec/PROTOCOLS.md). For how bitchat does the same things, see [BITCHAT.md](BITCHAT.md).

## Airhop and bitchat Terms

**Announce**: A signed `ANNOUNCE` packet a phone broadcasts to say it is present, carrying its nickname, Noise static key and Ed25519 signing key. Peers learn who is nearby, and which key to verify each sender against, from announces.

**bitchat-ios / bitchat-android**: The two bitchat apps ([permissionlesstech/bitchat](https://github.com/permissionlesstech/bitchat)). Airhop is wire-compatible with both, and treats bitchat-ios as the source of truth where they differ.

**Bridge (mesh bridge)**: An opt-in setting, off by default, that joins the local `#bluetooth` room to another crowd too far away for radio by republishing it through a Nostr rendezvous cell. Not to be confused with a **Tor bridge**, an unlisted Tor entry point.

**Courier**: Store-and-forward delivery by people. When nothing can reach the recipient, a nearby phone carries a sealed envelope and hands it over when it meets them. The carrier cannot read it, and envelopes are capped at 16 KiB, so media never travels this way.

**Gateway (internet gateway)**: An opt-in setting, off by default, under which a phone with internet carries public location-channel traffic to and from Nostr for nearby phones that have none.

**Location channel**: A public room scoped to a geohash cell and carried over Nostr, from `#region` down to `#block`.

**One-time prekey**: A single-use X25519 key a phone publishes in advance, signed, in a prekey bundle (packet type `0x24`) gossiped over the mesh. A courier envelope is sealed to one, so mail left with a carrier stays safe if the recipient's long-term key leaks later.

**Peer ID**: A phone's 8-byte mesh address, `hex(SHA-256(noiseStaticPubKey)).slice(0, 16)`. It stays the same until a panic wipe replaces the identity.

**Safety number**: Six words derived from two peers' keys, read aloud to each other to verify a contact without a camera. The device transfer shows six words from its own handshake the same way.

## Cryptography

**[ChaCha20-Poly1305](https://datatracker.ietf.org/doc/html/rfc8439)**: An authenticated encryption cipher (AEAD). The symmetric cipher inside Noise XX and Noise X.

**[Double Ratchet](https://signal.org/docs/specifications/doubleratchet/)**: Signal's per-message key agreement, which gives each message its own key so one leaked key exposes no other message. Airhop runs it on live DMs between two Airhop phones, seeded from and bound to their Noise session. Courier mail gets its forward secrecy from one-time prekeys instead.

**[Ed25519](https://ed25519.cr.yp.to/)**: An elliptic curve signature scheme. Packets are signed with the sender's Ed25519 key, and a signature is verified before a packet is displayed or acted on; `LEAVE`, files, board posts and voice frames are also verified before they are relayed.

**[HKDF](https://datatracker.ietf.org/doc/html/rfc5869)**: HMAC-based Key Derivation Function. Derives keys from Diffie-Hellman outputs inside Noise, the Double Ratchet and the Nostr DM construction.

**[Noise Protocol / Noise XX / Noise X](https://noiseprotocol.org/noise.html)**: A framework for authenticated key exchange. Airhop uses `Noise_XX_25519_ChaChaPoly_SHA256` for live DM sessions over any direct link (mutual authentication, forward secrecy) and `Noise_X_25519_ChaChaPoly_SHA256` to seal courier envelopes one way.

**[SHA-256](https://en.wikipedia.org/wiki/SHA-2)**: A cryptographic hash. Derives the peer ID, packet deduplication IDs and GCS filter entries, and is the hash inside the Noise suite. Airhop does not use SipHash.

**[X25519](https://cr.yp.to/ecdh.html)**: Diffie-Hellman over Curve25519. The key agreement inside Noise XX, Noise X and the Double Ratchet.

**[X3DH](https://signal.org/docs/specifications/x3dh/)**: Signal's Extended Triple Diffie-Hellman, which starts a Double Ratchet with an offline recipient from prekeys published in advance. Airhop does not use it: the Noise handshake already seeds the ratchet, and one-time prekeys serve courier mail.

**[XChaCha20-Poly1305](https://libsodium.gitbook.io/doc/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction)**: ChaCha20-Poly1305 with a 192-bit nonce, long enough to draw at random safely. bitchat's Nostr DM construction uses it ([PROTOCOLS.md section 7.1](../spec/PROTOCOLS.md#71-the-nostr-dm-construction-is-not-the-published-nip-44)).

## Networking and Transport

**[BLE (Bluetooth Low Energy)](https://en.wikipedia.org/wiki/Bluetooth_Low_Energy)**: Low-power, short-range Bluetooth, and Airhop's primary offline transport. Every phone is a GATT Central and a GATT Peripheral at once.

**[DEFLATE (raw)](https://datatracker.ietf.org/doc/html/rfc1951)**: Lossless compression applied to packet payloads so more fits in a 512-byte BLE write. `packet-compression.ts` uses pako's `deflateRaw` / `inflateRaw`, matching bitchat's headerless zlib stream.

**[GATT (Generic Attribute Profile)](https://www.bluetooth.com/specifications/specs/)**: The client-server protocol on top of BLE. A Central scans and connects; a Peripheral advertises and accepts connections. Running both roles on one phone is what makes a mesh.

**GCS (Golomb-Coded Set)**: A compact probabilistic set of hashes, smaller than a Bloom filter. Gossip sync uses one so two peers can see which packets each holds and exchange only what is missing (`gossip-sync.ts`). See [Golomb coding](https://en.wikipedia.org/wiki/Golomb_coding).

**LAN transport**: Airhop's mesh over a shared WiFi network or hotspot, found by mDNS and carried over TCP. It carries the same packets as Bluetooth and works between an iPhone and an Android. Off by default.

**[LRU (Least Recently Used)](https://en.wikipedia.org/wiki/Cache_replacement_policies#LRU)**: An eviction policy that drops the least recently used entry when a cache is full. The packet deduplication seen-set uses it (1,000 entries, 5 minutes).

**[MultipeerConnectivity](https://developer.apple.com/documentation/multipeerconnectivity)**: Apple's older peer-to-peer framework, over the proprietary AWDL radio. Airhop does not use it; the iOS fast path is Apple's standards-based `WiFiAware` framework. The name appears in early commits.

**[NFC (Near Field Communication)](https://en.wikipedia.org/wiki/Near-field_communication)**: Tap-to-exchange radio with a range of a few centimeters. Not used: contact exchange is a camera QR scan (`add-contact-screen.tsx`), which gives the same in-person guarantee and works on every phone.

**TTL (Time To Live)**: A hop counter in each packet, decremented by every relay; the packet stops at zero. The ceiling is 7 hops. An announce always starts at 7, other broadcasts start a little below the relay ceiling for the sender's link count, and relays clamp broadcasts lower in dense meshes ([PROTOCOLS.md section 4](../spec/PROTOCOLS.md#4-routing-constants)).

**[WiFi Aware](https://www.wi-fi.org/discover-wi-fi/wi-fi-aware)**: The Wi-Fi Alliance's Neighbor Awareness Networking (NAN): direct phone-to-phone WiFi with no router. Android has it from API 26 (data path from API 29), iOS from 26 on iPhone 12 and later. Airhop uses it as the fast path between two phones on the same platform. It does not cross platforms: Apple requires a paired data path, which Android cannot complete.

## Nostr

**[Geohash](https://en.wikipedia.org/wiki/Geohash)**: A short string that names a rectangular area, with each extra character narrowing it. Location channels run from a 2-character region to a 7-character block; a city is 5 characters, about 5 km across. The named channels resolve their geohash from the phone's location, and any cell can be opened by typing its geohash.

**[Gift wrap (NIP-59)](https://github.com/nostr-protocol/nips/blob/master/59.md)**: A metadata-hiding envelope for Nostr events. The message is sealed inside two nested layers, and the outer one is signed by a throwaway key, so relay operators cannot see who is talking to whom.

**[Haversine formula](https://en.wikipedia.org/wiki/Haversine_formula)**: Great-circle distance between two coordinates. `geo-relay.ts` uses it to pick the relays nearest a geohash from `assets/data/nostr_relays.csv`.

**[Nostr](https://nostr.com)**: Notes and Other Stuff Transmitted by Relays. An open protocol where clients sign events with key pairs and publish them to relays. Airhop's internet transport when radio range runs out.

**NIP (Nostr Implementation Possibility)**: A numbered Nostr specification. The full list is at [github.com/nostr-protocol/nips](https://github.com/nostr-protocol/nips).

**[NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md)**: Nostr private direct messages, wrapped in gift wrap so relays see neither sender, recipient nor content.

**[NIP-29](https://github.com/nostr-protocol/nips/blob/master/29.md)**: Relay-managed groups. Not used, because it puts membership enforcement on a relay ([ARCHITECTURE.md section 6](../spec/ARCHITECTURE.md#nip-29-was-not-used)).

**[NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md)**: Nostr's versioned encryption standard: ChaCha20 with an HMAC-SHA256 tag. bitchat's variant, which Airhop implements byte for byte, uses XChaCha20-Poly1305 instead.

**[NIP-61](https://github.com/nostr-protocol/nips/blob/master/61.md)**: Nutzaps: Cashu ecash sent in a Nostr event, locked to the recipient's key.

## Payments

**[Cashu](https://cashu.space)**: Chaumian ecash backed by bitcoin. Tokens are signed bearer instruments that move between phones with no internet; a connection is needed only to move value in or out over Lightning and to redeem a received token at its mint.

**[DLEQ (Discrete Log Equality proof)](https://github.com/cashubtc/nuts/blob/main/12.md)**: A proof that a mint signed a coin correctly, checkable with the mint's public keys and no network. It proves a coin is genuine, not that it is unspent: only the mint knows that.

**Mint**: The server that issues and redeems ecash and holds the bitcoin behind it, and the only trusted party in the payment system. Airhop ships with no default mint.

**[NUT](https://github.com/cashubtc/nuts)**: A numbered Cashu specification ("Notation, Usage, and Terminology"). Airhop implements, among others, NUT-04 and NUT-05 (Lightning in and out), NUT-07 (proof state), NUT-09 (restore), NUT-11 (P2PK locks), NUT-12 (DLEQ), NUT-13 (deterministic secrets for the recovery phrase) and NUT-19 (cached responses).

**Nutzap**: A Cashu payment sent over Nostr under NIP-61. The ecash is locked to the recipient's key, so the event can be public while only they can spend it.

**Proof**: One ecash coin: an amount, a secret only its owner knows, and the mint's blind signature over it. A **token** is one or more proofs packed into a single `cashuB…` string, which is what moves between phones.

## Tools and Libraries

**[AAC (Advanced Audio Coding)](https://en.wikipedia.org/wiki/Advanced_Audio_Coding)**: Lossy audio compression. Push-to-talk voice is AAC-LC at 16 kHz mono, sent as `VOICE_FRAME` (`0x29`) bursts.

**[Arti](https://gitlab.torproject.org/tpo/core/arti)**: The Tor Project's Rust Tor client. Airhop embeds it on both platforms from `native/arti/`, as an xcframework on iOS and a JNI library on Android. Off by default; when on, it runs a SOCKS5 listener on loopback that every relay connection is dialled through.

**[TurboModule](https://reactnative.dev/docs/turbo-native-modules-introduction)**: React Native's native module system. The specs in `src/bridge/` are hand-maintained TypeScript interfaces over the Swift and Kotlin modules, resolved through the interop layer rather than generated by Codegen.

## Localization

**[BCP 47](https://www.rfc-editor.org/info/bcp47)**: The standard for language tags (`en`, `pt-BR`, `zh-Hans`). `src/i18n/languages.ts` is keyed on them.

**[CLDR plural category](https://cldr.unicode.org/index/cldr-spec/plural-rules)**: The grammatical number forms a language uses. English has `one` and `other`, Russian four, Arabic six, Chinese only `other`. `tPlural` picks one per call through the rules in `src/i18n/plurals.ts`.

**Endonym**: A language's name in its own script (`فارسی`, `русский`, `简体中文`). What the language picker lists, as bitchat's `AppLanguageSettings.endonym(for:)` does.

**[ICU](https://icu.unicode.org/)**: The Unicode internationalization library behind `Intl`. It backs date, time and number formatting, so `src/utils/format.ts` pins the locale and numbering system to keep output stable across OS versions. Hermes exposes `DateTimeFormat`, `NumberFormat` and `Collator` from it, but not `PluralRules`.

**Locale**: A language plus its formatting conventions. In Airhop a locale is a TypeScript module under `src/i18n/locales/`, compiled into the bundle rather than fetched; 35 ship.

**LTR / RTL**: Left-to-right and right-to-left layout. `I18nManager` sets the direction once per process, so switching between them applies on the next launch; layout uses logical properties plus the helpers in `src/i18n/layout.ts`.

**Translation key**: The identifier a string is looked up by (`chat.dm.clear`). Code holds keys, never sentences; `TranslationKey` is derived from `en.ts`, so an unknown key is a compile error.
