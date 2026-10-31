# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v1.0.10 · Albatross (2026-10-19)

### What's New

- feat: upgrade to Expo SDK 58 and React Native 0.88 (by @areebahmeddd) [75cd869]
- fix: improve background service reliability; add optional app lock (by @areebahmeddd) [792c580]

**Full changelog:** [v1.0.9..v1.0.10](https://github.com/areebahmeddd/airhop/compare/v1.0.9..v1.0.10)

## v1.0.9 · Albatross (2026-09-27)

### What's New (Security Update)

- feat(identity): transfer to a new phone (by @areebahmeddd) [d695f3c]
- feat(wallet): redesign the wallet screen (by @areebahmeddd) [a289c36]
- fix(core): security findings from claude opus 5.5 (by @areebahmeddd) [4749185]
- refactor: cleanup kotlin and swift code (by @areebahmeddd) [29a8b2b]

**Full changelog:** [v1.0.8..v1.0.9](https://github.com/areebahmeddd/airhop/compare/v1.0.8..v1.0.9)

## v1.0.8 · Albatross (2026-09-21)

### What's New

- feat(chat): filter sheet on the chats screen and a verified badge (by @areebahmeddd) [9f18d90]
- fix(lan): heartbeat and close idle links, time out dials on both platforms (by @areebahmeddd) [ab76b5a]
- fix(wifi): pause wifi aware for the session when it keeps resetting the phone's wifi (by @areebahmeddd) [b89faec]
- fix(ring): hand a foreground ring to the tray when the app is backgrounded (by @areebahmeddd) [09bb8c2]

**Full changelog:** [v1.0.7..v1.0.8](https://github.com/areebahmeddd/airhop/compare/v1.0.7..v1.0.8)

## v1.0.7 · Albatross (2026-09-19)

### What's New

- fix: wifi aware connection logic with retries, heartbeats and self-healing discovery (by @areebahmeddd) [25900a6]
- fix: ring alert functionality and notification handling (by @areebahmeddd) [31d26f9]

**Full changelog:** [v1.0.6..v1.0.7](https://github.com/areebahmeddd/airhop/compare/v1.0.6..v1.0.7)

## v1.0.6 · Albatross (2026-09-18)

### What's New

- feat: add Ring, an opt-in urgent alert (by @areebahmeddd) [9fa8205]
- feat: add APK sharing on Android (by @areebahmeddd) [b020162]
- feat: auto-start on device boot (by @areebahmeddd) [8df606e]
- fix(lan): implement network state watchers for improved connectivity handling (by @areebahmeddd) [699c9d0]
- fix(wifi-aware): recognise a peer across its session restart, restart idle discovery (by @areebahmeddd) [996969f]

Special thanks to @robdplatt for identifying and reporting several issues in production! 🙂

**Full changelog:** [v1.0.5..v1.0.6](https://github.com/areebahmeddd/airhop/compare/v1.0.5..v1.0.6)

## v1.0.5 · Albatross (2026-09-11)

### What's New

- feat: add diagnostics sharing (by @areebahmeddd) [ae081d1]
- feat: privacy cover for app switcher (by @areebahmeddd) [e391a97]
- fix: display new banner messages based on local transport states (by @areebahmeddd) [63e20d3]
- chore: update dependencies and improve platform compatibility with wifi aware (by @areebahmeddd) [d58d513]

**Full changelog:** [v1.0.4..v1.0.5](https://github.com/areebahmeddd/airhop/compare/v1.0.4..v1.0.5)

## v1.0.4 · Albatross (2026-09-04)

> [!NOTE]
> The APK is significantly larger than the previous release because [Arti](https://gitlab.torproject.org/tpo/core/arti) (Tor) is now bundled with the Android app, including bridge and pluggable transport support for additional privacy on censored networks.

### What's New

- feat: LAN transport over mDNS and TCP (by @areebahmeddd) [6a9f1b2]
- feat: add bridges and pluggable transports for Tor (by @areebahmeddd) [7477564]
- feat: embedded Tor via Arti on iOS and Android (by @areebahmeddd) [3790036]

**Full changelog:** [v1.0.3..v1.0.4](https://github.com/areebahmeddd/airhop/compare/v1.0.3..v1.0.4)

## v1.0.3 · Albatross (2026-08-30)

### What's New

- feat: Wi-Fi Aware fast path for iOS (by @areebahmeddd) [99b000f]
- feat: auto-updater for Android (by @areebahmeddd) [d576d16]
- refactor: mesh service to utilize LinkRegistry for managing links across radios (by @areebahmeddd) [1dee3ed]

Special thanks to @robdplatt for identifying and reporting several issues in production! 🙂

**Full changelog:** [v1.0.2..v1.0.3](https://github.com/areebahmeddd/airhop/compare/v1.0.2..v1.0.3)

## v1.0.2 · Albatross (2026-08-25)

### What's New

- feat: improve ui/ux, micro-interactions and onboarding experience (by @areebahmeddd) [c6efeb6]
- feat: add setProvenKeys to bind mesh keys to contacts (by @areebahmeddd) [9a00889]
- feat: add unseen peers tracking and update Mesh screen behavior (by @areebahmeddd) [cb5fb41]
- fix(wifi): wait for the responder before requesting the Aware data path (by @areebahmeddd) [a497193]
- fix(permissions): check optional grants in the fast path (by @areebahmeddd) [13bf94e]

**Full changelog:** [v1.0.1..v1.0.2](https://github.com/areebahmeddd/airhop/compare/v1.0.1..v1.0.2)

## v1.0.1 · Albatross (2026-08-20)

### What's New

- feat: add support for 35 languages (by @areebahmeddd) [4396db4]
- feat: enhance relay management and discovery features (by @areebahmeddd) [6d217a4]
- feat: add funding.json and manifest files (by @areebahmeddd) [73c5493]
- fix: static HTML plugin with inline boot script and CSP support (by @areebahmeddd) [a06ff32]

**Full changelog:** [v1.0.0..v1.0.1](https://github.com/areebahmeddd/airhop/compare/v1.0.0..v1.0.1)

## v1.0.0 · Albatross (2026-08-14)

### What's New

- refactor: file and folder structure (#30) (by @areebahmeddd) [63e9006]

**Full changelog:** [v0.9.15..v1.0.0](https://github.com/areebahmeddd/airhop/compare/v0.9.15..v1.0.0)

## v0.9.15 (2026-08-12)

### What's New

- feat: enhance haptic feedback and notification handling (by @areebahmeddd) [bc755c2]
- feat: enhance QR scan and contact management with verification and copy functionality (by @areebahmeddd) [4af924c]

**Full changelog:** [v0.9.14..v0.9.15](https://github.com/areebahmeddd/airhop/compare/v0.9.14..v0.9.15)

## v0.9.14 (2026-08-11)

### What's New

- feat: enhance contact management and display names (by @areebahmeddd) [a66e515]
- feat: add internationalization (i18n) with language management (by @areebahmeddd) [c516e64]
- feat: add LanguagePicker and ThemeToggle components (by @areebahmeddd) [d55c98d]
- feat: enhance audio capture and playback with loudness level tracking (by @areebahmeddd) [6bcebfd]

**Full changelog:** [v0.9.13..v0.9.14](https://github.com/areebahmeddd/airhop/compare/v0.9.13..v0.9.14)

## v0.9.13 (2026-08-10)

### What's New

- feat: enhance geohash channel service with deletion management (by @areebahmeddd) [1646ae9]
- feat(landing): revamp website design (by @areebahmeddd) [a2a0c98]
- fix(ui): ui/ux and micro-interaction polish (by @areebahmeddd) [5841b05]
- fix(core): fixes from field testing (by @areebahmeddd) [bde4ace]

**Full changelog:** [v0.9.12..v0.9.13](https://github.com/areebahmeddd/airhop/compare/v0.9.12..v0.9.13)

## v0.9.12 (2026-08-07)

### What's New

- fix(router): stop dropping DMs from a direct peer between announces (by @areebahmeddd) [c1fbe19]
- refactor: improve fragment pacing logic and update related comments for clarity (by @areebahmeddd) [d1bd03e]
- refactor: update metadata handling and improve code consistency across components (by @areebahmeddd) [f9b067f]

**Full changelog:** [v0.9.11..v0.9.12](https://github.com/areebahmeddd/airhop/compare/v0.9.11..v0.9.12)

## v0.9.11 (2026-08-06)

### What's New

- feat: enhance NostrClient relay handling and settings (by @areebahmeddd) [e1f2e62]
- fix: sync with bitchat and fix field-testing bugs (by @areebahmeddd) [b84be44]

**Full changelog:** [v0.9.10..v0.9.11](https://github.com/areebahmeddd/airhop/compare/v0.9.10..v0.9.11)

## v0.9.10 (2026-08-05)

### What's New

- feat: add source manifest script and vendored verification (by @areebahmeddd) [e7f5de0]
- feat(landing): add new graphics and screenshots for dark and light themes, and implement world generation tool (by @areebahmeddd) [817fbba]
- fix: update AndroidManifest and iOS list (by @areebahmeddd) [95e012c]
- fix: minor apk build failure (by @areebahmeddd) [ef00b39]
- fix: update repository references from "Airhop" to "airhop" across the project (by @areebahmeddd) [36031eb]
- fix(core): sync with upstream bitchat and fix testing bugs (by @areebahmeddd) [87fadcb]

**Full changelog:** [v0.9.9..v0.9.10](https://github.com/areebahmeddd/airhop/compare/v0.9.9..v0.9.10)

## v0.9.9 (2026-08-01)

### What's New

- feat(settings): add language options and complete string extraction (by @areebahmeddd) [8d9ca99]
- feat: enforce timestamp freshness for ANNOUNCE packets to prevent replay attacks (by @areebahmeddd) [7434a86]
- feat: implement permission primer for Bluetooth and Location requests (by @areebahmeddd) [24dd0ab]
- feat: add hooks for pull-to-refresh colors and reduced motion settings (by @areebahmeddd) [bae500d]
- feat: enhance token scanner and wallet screen functionality (by @areebahmeddd) [cd65ac5]
- feat(core): add live voice detection, mesh bridge, qr for cashu payments (by @areebahmeddd) [21f1865]
- fix(landing): enhance privacy policy details and clarify features (by @areebahmeddd) [adc433f]
- fix(ci): allow re-publishing a tag that sits behind main (by @areebahmeddd) [9c18802]
- fix: apk signing and openssf score (by @areebahmeddd) [21a0568]

**Full changelog:** [v0.9.8..v0.9.9](https://github.com/areebahmeddd/airhop/compare/v0.9.8..v0.9.9)

## v0.9.8 (2026-07-31)

### What's New

- feat(app/core): add geohash support (by @areebahmeddd) [f0dc507]
- feat(chat): add unseen notices tracking and display in message thread (by @areebahmeddd) [16dfba6]
- feat: add monospace font selection and update UI components (by @areebahmeddd) [fdb64f9]
- feat: update UI elements and improve user experience across various screens (by @areebahmeddd) [34a68ad]
- feat(faq): enhance FAQ section with detailed encryption and payment information (by @areebahmeddd) [012f367]
- feat(wallet): rebuild Cashu ecash end to end, with Lightning and recovery (by @areebahmeddd) [aaaa15a]
- feat(landing): add architecture diagrams for airhop (by @areebahmeddd) [f323a58]
- fix(core): Tor, internet gateway and minor ui fixes (by @areebahmeddd) [7322a68]
- fix: fixes from local testing (by @areebahmeddd) [c88a6fa]
- refactor: rename "Your Channels" to "Your Rooms" for clarity and consistency (by @areebahmeddd) [837173d]

**Full changelog:** [v0.9.7..v0.9.8](https://github.com/areebahmeddd/airhop/compare/v0.9.7..v0.9.8)

## v0.9.7 (2026-07-31)

### What's New

- feat: update footer with new links and add PixelHeart animation (by @areebahmeddd) [6c79d4b]
- feat(landing): dockerize the frontend (by @areebahmeddd) [b9874a2]
- feat(chat): full-screen photo viewer, video tap-to-load, payment card restyle (by @areebahmeddd) [b3122fd]
- feat(file-transfer): raise attachment cap to 50 MB to match bitchat (by @areebahmeddd) [70d5333]
- feat(mesh): adapt relay jitter and announce cadence to mesh density (by @areebahmeddd) [c942bde]
- feat(chat): live attachment transfer progress with cancel (by @areebahmeddd) [6a92ed5]
- feat(chat): local message notifications with activity bell (by @areebahmeddd) [7105d0a]
- feat(settings): tappable links in Terms and Privacy screens (by @areebahmeddd) [f45ac39]
- feat(onboarding): require agreeing to terms before continuing (by @areebahmeddd) [4d186f7]
- feat(settings): open-source licenses screen with repos and grouping (by @areebahmeddd) [cb92153]
- feat(settings): version screen with update check and release codenames (by @areebahmeddd) [8aa8c54]
- feat(project): bitchat compatibility pass with claude fable 5 (by @areebahmeddd) [2c4ae56]
- fix(identity): label Nostr peers by npub tail, never "undefined" (by @areebahmeddd) [ce97219]
- refactor(chat): share pinned+recent conversation ordering, add DM pinning (by @areebahmeddd) [5112a93]
- refactor(settings): tidy feature rows, network/storage/donate copy (by @areebahmeddd) [482dc8e]
- style(chat): rounded-pill action buttons across sheets and modals (by @areebahmeddd) [b9e79ce]
- docs: pre-field-test hardening changelog, transports table, reference guide (by @areebahmeddd) [21b53e7]
- docs(legal): panic wipe is now on the Profile screen; bullet crypto/nostr sections (by @areebahmeddd) [ac0cfc8]
- docs: notifications + foreground-service lifecycle (by @areebahmeddd) [4ed7840]
- docs(landing): copy tweaks, footer order, sitemap refresh (by @areebahmeddd) [f989e94]
- chore(data): regenerate Nostr geo-relay directory (417 relays) (by @areebahmeddd) [396c118]

**Full changelog:** [v0.9.6..v0.9.7](https://github.com/areebahmeddd/airhop/compare/v0.9.6..v0.9.7)

## v0.9.6 (2026-07-22)

### What's New

- feat(mesh): update packet-codec, deduplicator, file-transfer, announce, voice, and video (by @areebahmeddd) [ada633f]
- feat(nostr,payments): update courier-relay, presence, gift-wrap, and cashu (by @areebahmeddd) [c8bda28]
- feat(core): add message router (by @areebahmeddd) [b10f447]
- feat(services): add mesh-service orchestration layer (by @areebahmeddd) [f5bce18]
- feat(store): update chat, peer, and wallet stores (by @areebahmeddd) [94d4ee7]
- feat(features): add QR scan, radar view, and update chat/discovery/onboarding/settings/wallet screens (by @areebahmeddd) [65e4fb2]
- feat(landing): add RelayMap component, relay coords data, and refresh all pages/components (by @areebahmeddd) [484fac7]
- feat(wallet): wire decodeToken for receive; add balance validation for send and zap (by @areebahmeddd) [53d5305]
- feat(settings): add QR modal, share pills, and live Tor toggle wired to AirhopTorModule (by @areebahmeddd) [13c1fd4]
- feat(contacts): add NFC tap-to-add and camera QR scan to QrScanScreen (by @areebahmeddd) [d6056d4]
- feat(app): add + new-channel button to Chats header; pass trigger counter to ChannelList (by @areebahmeddd) [354ed8d]
- feat(chat): add voice recording UI, real attach actions, channel/DM info sheets to MessageThread (by @areebahmeddd) [ee3ddb6]
- feat(chat): accept newChannelTrigger prop in ChannelList; update DmList layout (by @areebahmeddd) [f8d1f7e]
- feat(chat): add ChannelInfoSheet bottom-sheet component (by @areebahmeddd) [ca01a53]
- feat(store): add channel-leave, metadata, and clearAll helpers to chat-store (by @areebahmeddd) [d166cc8]
- feat(mesh): wire WiFi transport, Noise XX handshake, DR, file transfer, and fix BLE ad name prefix (by @areebahmeddd) [191a868]
- feat(services): add FileTransferService for chunked mesh file transfer (by @areebahmeddd) [c4c7434]
- feat(payments): expand cashu.ts decode helpers for V3/V4 tokens (by @areebahmeddd) [b58e3ce]
- feat(landing): add favicon set and enrich JSON-LD structured data (by @areebahmeddd) [0d9e431]
- feat(landing): add useSEO and useInView hooks (by @areebahmeddd) [5102dc4]
- feat(landing): wire per-page SEO metadata and skip-to-content link (by @areebahmeddd) [7316202]
- feat(landing): fetch live relay locations from CSV and animate relay arcs (by @areebahmeddd) [e5589c9]
- feat(landing): lazy-load relay map and animate on scroll into view (by @areebahmeddd) [df5efe2]
- feat(landing): respect prefers-reduced-motion in feature illustrations (by @areebahmeddd) [c0c4533]
- feat(landing): add App Store / Play Store download dropdown to hero (by @areebahmeddd) [b6636a0]
- fix(crypto): patch double-ratchet and noise-xx session handling (by @areebahmeddd) [f1f6077]
- fix(ui,utils): update theme and battery-optimization utility (by @areebahmeddd) [0c89d8b]
- fix: build issues (by @areebahmeddd) [c53ebad]
- fix(discovery): refine controls-row layout and add-contact button accessibility (by @areebahmeddd) [dd65fa5]
- fix(codec): minor packet-codec correction (by @areebahmeddd) [a0ae380]
- fix(security): clear Zustand in-memory state on panic wipe (by @areebahmeddd) [594e0e5]
- fix(android): suppress deprecated ReactPackage override warnings in BLE and WiFi packages (by @areebahmeddd) [b3da90d]
- fix(tests): repair panic-wipe test suite (by @areebahmeddd) [04d479b]
- fix: stop peer selector update loop and stabilize Expo runtime (by @areebahmeddd) [4261b7d]
- refactor(android): rename package from tech.permissionless to org.onemindlabs (by @areebahmeddd) [d7ef1a4]
- style(landing): improve text contrast and clean up focus/comments in nav, footer, explore, contribute (by @areebahmeddd) [17acd74]
- docs: replace em dashes in skills/landing; fix CHANGELOG formatting (by @areebahmeddd) [eee8b44]
- docs(landing): expand FAQ with bitchat comparison and richer formatting (by @areebahmeddd) [fba3a5d]
- docs(landing): update llms.txt and sitemap for latest copy (by @areebahmeddd) [ba8adf7]
- docs(landing): rewrite README with tech stack table and Lighthouse metrics (by @areebahmeddd) [f367e8a]
- docs(landing): expand About section with bitchat attribution and links (by @areebahmeddd) [fa039d6]
- docs: update README and ROADMAP with new links and feature milestones (by @areebahmeddd) [1650379]
- chore: update App.tsx, package deps, and prettier config (by @areebahmeddd) [3dc32dd]
- chore(android): delete old files (by @areebahmeddd) [7b781e3]
- chore(android): add CAMERA, RECORD_AUDIO, NFC, media permissions; add dark-mode colors stub (by @areebahmeddd) [208c019]
- chore(landing): self-host JetBrains Mono and respect prefers-reduced-motion (by @areebahmeddd) [e866b1f]

**Full changelog:** [v0.9.5..v0.9.6](https://github.com/areebahmeddd/airhop/compare/v0.9.5..v0.9.6)

## v0.9.5 (2026-07-18)

### What's New

- feat(ui): add centralised design token system (by @areebahmeddd) [a657634]
- feat(ui): add Avatar, StatusDot, and MeshStatusBar components (by @areebahmeddd) [5c13a5a]
- feat(onboarding): add welcome, identity generation, and username reveal screens (by @areebahmeddd) [0b36c31]
- feat(chat): add channel list, DM list, and message thread screens (by @areebahmeddd) [4acf079]
- feat(mesh): add peer discovery list with BLE peer detail sheet (by @areebahmeddd) [89cfe41]
- feat(wallet): add Cashu ecash wallet screen (by @areebahmeddd) [a433dc2]
- feat(settings): add profile and settings screen with panic wipe (by @areebahmeddd) [fac5044]
- feat(app): wire root navigation with SafeAreaProvider and 4-tab layout (by @areebahmeddd) [93849c7]
- feat(landing): add Airhop landing page source (by @areebahmeddd) [d5c9f2b]
- chore(deps): install react-native-safe-area-context and expo-status-bar (by @areebahmeddd) [1a74e91]
- chore(config): update ESLint config for v1.0 feature set (by @areebahmeddd) [1dbd51b]
- chore(landing): init Vite + React landing page scaffold (by @areebahmeddd) [621aab9]
- chore: add landing page to gitignore, prettierignore, and dependabot (by @areebahmeddd) [5f4fe70]
- chore(landing): add public assets and Cloudflare Pages config (by @areebahmeddd) [c9df1bd]
- chore(ci): update Codecov action configuration for coverage reporting (by @areebahmeddd) [433e137]

**Full changelog:** [v0.9.0..v0.9.5](https://github.com/areebahmeddd/airhop/compare/v0.9.0..v0.9.5)

## v0.9.0 (2026-07-18)

### What's New

- refactor: naming conventions, known gap fixes, docs, and agent skills (v0.9) (by @areebahmeddd) [502be8a]
- chore: add release automation, git-cliff changelog, and fix eslint config (by @areebahmeddd) [93c8134]
- chore: scaffold future platform directories (by @areebahmeddd) [1570204]

**Full changelog:** [v0.8.0..v0.9.0](https://github.com/areebahmeddd/airhop/compare/v0.8.0..v0.9.0)

## v0.8.0 (2026-07-17)

### What's New

- feat(crypto): implement Signal Double Ratchet (double-ratchet.ts) (by @areebahmeddd) [1211db0]
- feat(crypto): implement X3DH prekey agreement (x3dh.ts) (by @areebahmeddd) [c5d9164]
- feat(android): add WiFi Aware high-bandwidth transport (AirhopWiFiModule) (by @areebahmeddd) [8c3bb3a]
- feat(ios): add MultipeerConnectivity high-bandwidth transport (AirhopMCModule) (by @areebahmeddd) [dd3c4f8]
- feat(bridge): add NativeAirhopWiFi TurboModule spec (by @areebahmeddd) [a84f801]
- feat(mesh): add chunked streaming file transfer (file-transfer.ts) (by @areebahmeddd) [cb4e064]
- feat(mesh): add VIDEO_FRAME capture and jitter-buffer player (video-capture/player.ts) (by @areebahmeddd) [569469c]
- docs: clarify guidance for ai agents (by @areebahmeddd) [092d192]

**Full changelog:** [v0.7.0..v0.8.0](https://github.com/areebahmeddd/airhop/compare/v0.7.0..v0.8.0)

## v0.7.0 (2026-07-17)

### What's New

- feat(nostr): add Nostr client with SimplePool, auto-reconnect, and Tor proxy config (by @areebahmeddd) [6d8f3bb]
- feat(nostr): add NIP-17/59 gift-wrap DMs (by @areebahmeddd) [5c08d2b]
- feat(nostr): add geo-relay selection from bundled relays.csv (by @areebahmeddd) [c617fd2]
- feat(nostr): add kind-20001 geohash presence heartbeats (by @areebahmeddd) [1812653]
- feat(nostr): add courier relay for offline store-and-forward (kind 1401) (by @areebahmeddd) [e3866b8]
- feat(payments): add Cashu token parsing, embed, and DLEQ validation (by @areebahmeddd) [7dd533d]
- feat(payments): add NIP-61 nutzap and MMKV-backed wallet store (by @areebahmeddd) [06da7bc]
- feat(mesh): add PTT voice capture and jitter-buffered playback (by @areebahmeddd) [26259c7]
- feat(router): add Nostr as priority-2 transport (BLE > Nostr > Courier) (by @areebahmeddd) [82b9542]
- feat(bridge): add TurboModule spec for Tor module; update BLE spec (by @areebahmeddd) [8123222]
- feat(ios): add Arti Tor integration with bundled xcframework (by @areebahmeddd) [0532c83]
- feat(android): add Orbot SOCKS5 proxy detection via TCP probe (by @areebahmeddd) [ad770b9]

**Full changelog:** [v0.6.0..v0.7.0](https://github.com/areebahmeddd/airhop/compare/v0.6.0..v0.7.0)

## v0.6.0 (2026-07-17)

### What's New

- feat(crypto): Noise XX handshake+transport and Noise X one-way sealing (by @areebahmeddd) [9d7d0cf]
- feat(mesh): BLE packet fragmentation and reassembly (by @areebahmeddd) [d3c3c82]
- feat(mesh): GCS gossip reconciliation, wire-compatible with bitchat (by @areebahmeddd) [dc69f81]
- feat(mesh): courier store-and-forward with TLV envelope, bitchat-compatible (by @areebahmeddd) [20c5f6b]
- feat(router): message routing: broadcast, unicast, courier fallback (by @areebahmeddd) [2483f2e]
- feat(store): Zustand + MMKV chat state and in-memory peer registry (by @areebahmeddd) [be3fed3]
- feat(ui): channel list, message thread, and peer list screens (by @areebahmeddd) [0b30310]
- fix(mesh): align packet types with bitchat MessageType.swift (by @areebahmeddd) [f92f684]
- docs: correct protocol constants (GCS, courier, packet types) (by @areebahmeddd) [609b648]

**Full changelog:** [v0.5.0..v0.6.0](https://github.com/areebahmeddd/airhop/compare/v0.5.0..v0.6.0)

## v0.5.0 (2026-07-17)

### What's New

- feat(core/crypto): identity generation, peer ID derivation, Keychain storage (by @areebahmeddd) [768abfc]
- feat(core/mesh): bitchat v2 packet codec with flags preservation and Ed25519 signing (by @areebahmeddd) [268acc4]
- feat(core/mesh): deduplicator (LRU nonce cache) and TTL flood router with jitter (by @areebahmeddd) [6a71607]
- feat(core/mesh): signed ANNOUNCE broadcast manager with TLV payload and peer validation (by @areebahmeddd) [ce3474e]
- feat(bridge): TurboModule spec for AirhopBLE native module (by @areebahmeddd) [9a31028]
- feat(ios): AirhopBLEModule Swift dual-role GATT central+peripheral with RSSI polling (by @areebahmeddd) [27cda57]
- feat(android): AirhopBLEModule Kotlin dual-role GATT, AirhopForegroundService, package registration (by @areebahmeddd) [65df2bf]
- test(core/mesh): unit tests for packet-codec, deduplicator and flood-router (by @areebahmeddd) [e6b1e3f]
- chore: configure Jest and TypeScript for noble ESM modules (by @areebahmeddd) [c674718]

**Full changelog:** [v0.5.0](https://github.com/areebahmeddd/airhop/commits/v0.5.0)
