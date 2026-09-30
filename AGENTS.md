# Airhop: Agent Guide

> The rules and conventions for changing Airhop's code. Written for AI agents (Claude, GitHub Copilot, Codex and others), and binding on human contributors too. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers the contributor workflow: setup, tests, sign-off and pull requests. [`.github/copilot-instructions.md`](.github/copilot-instructions.md) only points Copilot here.

## What You're Working In

**Airhop** is a React Native app (Expo bare workflow, New Architecture) for iOS and Android: offline-first, end-to-end encrypted messaging over a Bluetooth mesh, with Wi-Fi Aware and LAN links, Nostr for internet reach, embedded Tor, and a Cashu wallet. It is wire-compatible with bitchat, so Airhop and bitchat phones talk to each other over BLE with no configuration.

The bitchat reference implementations are **not part of this repository**. Clone them into `bitchat/` yourself, which is where every path in this guide, `.github/agents/` and `.github/skills/` expects them:

| Local path           | Repository                           | What it is                                              |
| -------------------- | ------------------------------------ | ------------------------------------------------------- |
| `bitchat/ios/`       | `permissionlesstech/bitchat`         | bitchat-ios, in Swift. The canonical spec               |
| `bitchat/android/`   | `permissionlesstech/bitchat-android` | bitchat-android, in Kotlin                              |
| `bitchat/georelays/` | `permissionlesstech/georelays`       | The relay discovery toolchain behind `nostr_relays.csv` |

Both bitchat apps are public domain (the Unlicense), so copy from them freely. Nothing under `bitchat/` is committed, so a `bitchat/...` path is a dangling reference for anyone without the checkout. Never cite one from **shipping source** (`src/`, `scripts/`, `android/`, `ios/`, `native/`): read it, then write the conclusion rather than the citation. This guide, `.github/agents/` and `.github/skills/` are the exception, since telling an agent where to look is their job.

## Read Before You Write Code

Read these four documents before making any code suggestion:

1. [`docs/design/VISION.md`](docs/design/VISION.md): the non-negotiable principles
2. [`docs/spec/ARCHITECTURE.md`](docs/spec/ARCHITECTURE.md): architecture and stack decisions
3. [`docs/spec/PROTOCOLS.md`](docs/spec/PROTOCOLS.md): the wire format you must not break
4. [`docs/dev/PROGRESS.md`](docs/dev/PROGRESS.md): what exists, what's next, what's blocked

Then read the [skill](#skills) for the subsystem you are about to touch.

## Where Things Live

| Thing                                                          | Location                                           |
| -------------------------------------------------------------- | -------------------------------------------------- |
| Crypto (Noise XX and X, identity, Double Ratchet, keychain)    | `src/core/crypto/`                                 |
| Wire format: the packet frame and every payload                | `src/core/mesh/wire/`                              |
| Mesh routing, dedup, fragmentation, source routes              | `src/core/mesh/routing/`                           |
| Open links per radio, and the writes that go down them         | `src/core/mesh/links/`                             |
| GCS gossip sync                                                | `src/core/mesh/sync/`                              |
| Announces and nickname normalization                           | `src/core/mesh/discovery/`                         |
| Private-channel and private-group crypto                       | `src/core/mesh/rooms/`                             |
| Courier (store-and-forward) envelopes and one-time prekeys     | `src/core/mesh/courier/`                           |
| Live push-to-talk capture and playback                         | `src/core/mesh/voice/`                             |
| Which transport a message leaves on                            | `src/core/router/`                                 |
| Base64 shared across the protocol                              | `src/core/encoding/`                               |
| Device transfer: the code, handshake and bundle (pure)         | `src/core/move/`                                   |
| Device transfer: what moves, and both phones' sides            | `src/services/move-*.ts`                           |
| Nostr (client, gift wrap, geo-relays, presence, courier relay) | `src/core/nostr/`                                  |
| Payments: tokens, DLEQ, NIP-61, seed (pure)                    | `src/core/payments/`                               |
| Runtime wiring: mesh, wallet, Tor, anything touching a mint    | `src/services/`                                    |
| Which peers the LAN transport dials, and the cap on it         | `src/services/lan-dial-policy.ts`                  |
| Screen logic                                                   | `src/features/`                                    |
| UI components, hooks, theme tokens                             | `src/ui/`                                          |
| Thin wrappers over OS APIs (permissions, haptics)              | `src/platform/`                                    |
| State management (Zustand over MMKV)                           | `src/store/`                                       |
| UI copy: the catalog, the runtime, right-to-left helpers       | `src/i18n/`                                        |
| Stateless helpers                                              | `src/utils/`                                       |
| Generated and static tables (relays, bridges, licenses)        | `src/data/`                                        |
| Bundled relay list, refreshed by CI                            | `assets/data/nostr_relays.csv`                     |
| Native module specs (hand-maintained, interop layer)           | `src/bridge/`                                      |
| Root component and tab state machine                           | `src/app/`                                         |
| Whole-app lifecycle and simulation suites                      | `src/__tests__/`                                   |
| Native unit tests (the pure pieces beside each module)         | `android/app/src/test/`, `ios/Tests/`              |
| iOS native                                                     | `ios/`                                             |
| Android native                                                 | `android/`                                         |
| Embedded Tor client (Rust, both platforms)                     | `native/arti/`                                     |
| Pluggable transports (Go, both platforms)                      | `native/iptproxy/`                                 |
| Every protocol constant                                        | [`docs/spec/PROTOCOLS.md`](docs/spec/PROTOCOLS.md) |

[`src/README.md`](src/README.md) describes each `src/` layer and how to run its tests.

## Rules Every Agent Must Follow

### Crypto

- **`@noble/curves`, `@noble/ciphers`, `@noble/hashes` only.** No other crypto library: no `crypto-js`, no `elliptic`, no `tweetnacl`, no `crypto.subtle`.
- **No `Math.random()` for anything security- or privacy-relevant.** Use `crypto.getRandomValues`, or `secureRandom()` from `src/core/crypto/secure-random.ts` for a number that hides something (a timestamp blur, an origin TTL). `Math.random()` is fine for relay jitter and nothing else of consequence.
- `react-native-get-random-values` is the **first import** in `src/app/app.tsx`, before anything that pulls in `@noble`. The root `App.tsx` is a one-line re-export that Expo's AppEntry resolves.
- **Packets are signed.** Every packet this node originates is Ed25519-signed, apart from a few kinds it leaves unsigned exactly as bitchat does. A signed packet is verified before display or action, and a failure is dropped silently. The [Security Review agent](.github/agents/security-review.md) lists the unsigned kinds and the relay rules.
- **Never log** private keys, session keys, plaintext message content or Cashu proofs.

### Storage

- Private keys: `src/core/crypto/keychain.ts` only, never `expo-secure-store` directly. It holds the registry the panic wipe deletes (SecureStore has no clear-all), so a secret written outside it survives a wipe. Add new ones to `KEYCHAIN_ITEMS`.
- Non-secret state: `react-native-mmkv` (JSI, synchronous), through `getStorage()` in `src/store/mmkv.ts` so each partition has one handle.
- Never store a private key in MMKV, AsyncStorage, SQLite, the filesystem or a Zustand store (Zustand persists to MMKV).
- Message content lives in MMKV and the app's cache directory, which OS file encryption covers and the backup exclusions keep on the phone ([ARCHITECTURE.md](docs/spec/ARCHITECTURE.md), "Data at rest"). A new store anywhere else needs the same exclusion.

### Protocol Compatibility

- Never change the `packet-codec.ts` byte layout without bumping the protocol version and keeping a decode path for the old one.
- Never change the BLE Service UUID (`F47B5E2D...`) or Characteristic UUID (`A1B2C3D4...`). A change partitions the network.
- Never change peer ID derivation (`hex(SHA-256(noiseStaticPubKey)).slice(0, 16)`, defined once in `src/core/crypto/peer-id.ts`). Gossip sync and DM addressing depend on it.
- Airhop-only packet types start at `0x50`. bitchat allocates forward from below and has reached `0x2C`, with `0x2A` and `0x2B` reserved upstream. `0x29` (push-to-talk) is bitchat's too and stays wire-identical. [PROTOCOLS.md](docs/spec/PROTOCOLS.md) section 3 is the registry.
- A protocol change ships only after a message exchange across Airhop, bitchat-ios and bitchat-android.

### Native Code

- Swift lives in `ios/`, Kotlin in `android/`. They expose **raw bytes** to TypeScript: no protocol logic, no routing decisions, no crypto.
- Each spec in `src/bridge/` has one module behind it. `AirhopBLEModule`, `AirhopVoiceModule`, `AirhopWiFiModule`, `AirhopLANModule`, `AirhopTorModule` and `AirhopAppModule` exist on both platforms; `AirhopTorSocket` and `AirhopWiFiPairing` are iOS only. Android also runs `AirhopForegroundService`, and `AirhopBootReceiver` with `AirhopBootService` for the opt-in start after a reboot; these are services, not modules.
- `AirhopAppModule` diverges by platform: iOS rejects `restart`, `setAutoStartOnBoot`, `copyApkToCache`, `startRingAlert` and `stopRingAlert`, since it can relaunch nothing, has no boot receiver, has no sideloading to share an APK into, and has no ringtone loop outside CallKit.
- `native/arti/` (Rust) and `native/iptproxy/` (Go) are the one exception to "raw bytes only": a Tor client and its pluggable transports, each owning a SOCKS5 listener and its own lifecycle. They still know nothing about mesh packets, routing or message encryption, and both platforms build the same sources.

### Build Order

```text
src/core/ -> Native modules -> src/features/ -> src/ui/
```

- No `src/features/` code until the `src/core/` service it depends on has passing unit tests.
- No `src/ui/` code until the feature logic behind it works.
- Native code changes when a radio or the OS demands it (a transport's connection handling, a platform quirk, a Tor bump), never to carry protocol logic.

### Pinned Artifacts

Two kinds of files are pinned and checked in CI. Both fail the build rather than drift quietly, so a change to either has to be deliberate.

- **Native binaries** (`ios/Frameworks/`, `android/app/src/main/jniLibs/`, `android/app/libs/`: the Tor client and its pluggable transports). Built from `native/arti/` and `native/iptproxy/`, not vendored, but committed rather than compiled on every CI run, and nobody reviews a binary diff. Rebuild on a branch with the **Build Native Libraries** workflow, which commits the binaries and their hashes, or locally with each tree's `build-in-container.sh` (Android, Docker) or `build-apple.sh` (macOS only) followed by `node scripts/verify-vendored.js --write` in the same commit. [`native/README.md`](native/README.md) has the steps. CI runs `npm run verify:vendored`. Never hand-edit a binary or a hash.
- **Native lockfiles** (`android/app/gradle.lockfile`, `android/settings-gradle.lockfile`, `ios/Podfile.lock`). Adding or bumping an npm package with a native side can change what Gradle or CocoaPods resolves. The **Sync Native Lockfiles** workflow regenerates and commits them on any push to a branch other than `main` that touches `package.json` or the native build files. By hand: `./gradlew dependencies --write-locks` then `./gradlew :app:dependencies --write-locks` in `android/`, and `bundle exec pod install --project-directory=ios`.

### User-Facing Copy

- **Never hardcode a user-facing string.** Add a key to `src/i18n/locales/en.ts` and use `T("your.key")` in a component (from `useT()`) or `t("your.key")` outside React. CI fails on a hardcoded string (`npm run i18n:audit`).
- **Never translate at module load.** `const X = { label: t("k") }` freezes in whichever language the app started in. Module constants hold keys; the component translates on render. The audit catches this too.
- `en.ts` is the source catalog; every other locale is generated from a translation map and checked against it. Adding a language is a new file, never a sweep of every screen.
- Placeholders are named (`{count}`), never positional. Plurals go through `tPlural`, never `count === 1` at a call site.
- **Some strings must never be translated** because they cross the wire: the `username.ts` word lists, the transmitted `/hug` and `/slap` text (bitchat matches it as an English substring), slash command tokens, channel names. Read [`i18n.md`](.github/skills/i18n.md) before touching any of them.
- **Text is not ASCII.** `t()` wraps every substituted value in a directional isolate, so build sentences with a placeholder rather than concatenation, and strip with `stripIsolates` before comparing its output. Normalize to NFC before matching, match a word boundary with `[^\p{L}\p{N}_]`, and never call `toLocaleString` (use the formatters in `src/utils/format.ts`).
- Layout uses logical properties (`marginStart`, `start`, `textAlignEnd` from `src/i18n/layout.ts`), never `marginLeft` / `left` / `textAlign: "right"`. Arabic, Persian and Urdu ship, so a physical side is a visible bug rather than a latent one. ESLint rejects the physical margin, padding and border properties and `textAlign: "left" | "right"`.
- **No em dashes**, in copy, comments or docs, and no `--` standing in for one. Use a comma, parentheses or a full stop.
- **Byte sizes follow IEC 80000-13, everywhere, copy included.** `KiB` / `MiB` are 1024-based, `KB` / `MB` are 1000-based, and the label must match the arithmetic. Every size Airhop controls is a power of two (the 1 MiB file cap, the 512 KiB photo budget, the 16 KiB envelope) and `formatBytes` divides by 1024, so all of it reads `KiB` / `MiB`. Decimal units stay only for genuinely decimal figures, such as an observed camera file size.

## TypeScript Conventions

- `tsc --strict` passes with zero errors.
- No `any` in `src/core/` or `src/bridge/`.
- Named exports only in `src/core/`. A `src/bridge/` spec default-exports its module, per React Native's spec convention, and names everything else.
- File naming: `kebab-case.ts`. The one exception is `src/bridge/Native*.ts`, which keeps React Native's spec naming. A file's name and its primary export agree (`alert-modal.tsx` exports `AlertModal`).
- Module specifiers: leaving your top-level `src/` layer means a path alias (`@core/mesh/wire/packet-codec`); staying inside the layer stays relative (`./message-bubble`, `../shared`). Aliases are declared in `tsconfig.json` and mirrored in `package.json` for Jest.
- Write escape sequences, never the literal byte. A regex holding a raw backspace instead of `\b` matches nothing and makes git treat the file as binary, so it is unenforced and unreviewable at once. CI runs `npm run verify:invisibles` over control characters, bidirectional overrides and zero-width characters.
- One protocol concern per `src/core/` module, each independently testable. A file that needs "and" to describe it is two files.
- `src/services/mesh-service.ts` and several `src/features/` screens are far past that. They are known refactor targets, **not** precedent. Add a new packet type's codec as a focused module in `src/core/mesh/wire/` and keep the mesh-service side to wiring.

## Design Language

Every visual value comes from a token in `src/ui/theme.ts`. [`ui-ux.md`](.github/skills/ui-ux.md) has the detail.

- Read the palette through `useThemeColors()`, never by importing `Colors` or `DarkColors`, or the screen stops answering the theme setting. Check both themes: a wash that reads on white can vanish on near-black.
- Tokens, not literals, for spacing, radius, font size, weight, duration and elevation. Never arithmetic on one (`FontSize.xs - 1`): if the scale lacks a value, add it to the scale.
- `MIN_TOUCH` (44pt) is the floor. A smaller control carries `hitSlopFor(visualSize)`, and adjacent controls must not overlap slop.
- Color carries meaning, never decoration. Green is end-to-end encrypted, blue is a verified contact, and neither is reused.
- Reuse `BottomSheet`, `EmptyState`, `PrimaryButton`, `AlertModal` and the rows in `src/features/settings/settings-primitives.tsx` before writing a variant.
- Motion respects the OS reduce-motion switch. Reanimated honors it already; anything on `Animated` uses `useReducedMotion()`.

## Comments and Documentation

Comments here are dense on purpose. The bar for keeping one is that it says something the code cannot.

- **Explain why, not what.** Justify a magic number, name a platform quirk, state an invariant. A comment restating the signature below it is noise.
- **No history.** A file is not a changelog. Keep the rule a war story justified and drop the story; the commit message is where it belongs.
- **File headers stay** on every non-trivial module: one sentence on what it is, then only what a reader needs to change it safely. Length tracks load-bearing content, not the file's age.
- **`//` everywhere**, headers and members alike. The only block comments are tool pragmas a line comment is invisible to: `/** @jest-environment node */`, and knip's `@public` (an intentionally unused export) and `@alias` (an intentional duplicate export) tags.
- **Section banners** (`// ---- Name ----`) belong only in a long file or a flat data table, where they are the only navigation.
- **Style blocks**: justify a number, a touch target or a platform quirk, or say nothing.
- **Describe the system, not the authors.** The exception is protocol code, where "we" means _this node_ rather than the peer, a distinction the prose needs.

## Common Mistakes to Avoid

| Mistake                                     | Correct approach                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| Using `Math.random()` for a nonce           | `crypto.getRandomValues`, or `secureRandom()` for a privacy-relevant number       |
| Storing keys in a Zustand store             | Zustand persists to MMKV; keys go through `src/core/crypto/keychain.ts`           |
| Writing routing logic in Swift or Kotlin    | Routing lives in `src/core/mesh/routing/flood-router.ts`                          |
| Creating a new native module for BLE        | Extend `AirhopBLEModule`; there is one BLE module                                 |
| Hardcoding a relay URL                      | `GeoRelayDirectory` reads `src/data/relays.ts`, generated from `nostr_relays.csv` |
| Writing a user-facing string inline         | Add a key to `src/i18n/locales/en.ts` and use `T("key")`                          |
| Using `marginLeft` / `left` in a stylesheet | Use `marginStart` / `start`, so right-to-left flips                               |
| Changing packet byte layout "to fix a bug"  | Understand the wire format in `docs/spec/PROTOCOLS.md` first                      |

## Specialized Agents

Three review agents live in `.github/agents/`. In VS Code, pick one from the agent dropdown in Copilot Chat; any other agent can read the file and follow its checklist.

| Agent                                                | When to run it                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| [Architect](.github/agents/architect.md)             | Before merging any `src/core/`, `android/`, `ios/` or `native/` change |
| [Security Review](.github/agents/security-review.md) | Before any change to crypto, key storage, packet signing or transfer   |
| [Upstream Sync](.github/agents/upstream-sync.md)     | When bitchat-ios or bitchat-android ships a release                    |

## Skills

Skills are reference files in `.github/skills/`. Read the relevant one before working on a subsystem. They hold dense reference material cross-checked against the source and the bitchat implementations.

| Skill                                                             | Read before working on                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`bitchat-wire-format.md`](.github/skills/bitchat-wire-format.md) | `packet-codec.ts`, BLE native modules, any packet encoding or decoding        |
| [`native-boundary.md`](.github/skills/native-boundary.md)         | `android/`, `ios/`, `src/bridge/`, TurboModule specs                          |
| [`mesh-routing.md`](.github/skills/mesh-routing.md)               | `flood-router.ts`, `deduplicator.ts`, `fragment-manager.ts`, `gossip-sync.ts` |
| [`noise-sessions.md`](.github/skills/noise-sessions.md)           | `noise-xx.ts`, `noise-x.ts`, handshake logic, transport encryption            |
| [`courier-envelopes.md`](.github/skills/courier-envelopes.md)     | `prekey-bundle.ts`, `prekey-store.ts`, `courier-store.ts`, offline mail       |
| [`nostr-gift-wrap.md`](.github/skills/nostr-gift-wrap.md)         | `gift-wrap.ts`, `courier-relay.ts`, any Nostr DM or event handling            |
| [`i18n.md`](.github/skills/i18n.md)                               | `src/i18n/`, any user-facing copy anywhere, right-to-left layout              |
| [`ui-ux.md`](.github/skills/ui-ux.md)                             | `src/ui/`, any style block, component, tappable surface or dark-mode work     |
