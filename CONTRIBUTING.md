# Contributing to Airhop

Thanks for your interest in contributing. This guide walks you from picking up an issue to a merged pull request. The rules the code itself must follow (crypto, storage, protocol compatibility, native boundary, copy, TypeScript, design and comments) live in [`AGENTS.md`](AGENTS.md), which binds human contributors and AI agents alike.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Found a vulnerability? Report it privately, as [`SECURITY.md`](SECURITY.md) describes, never in a public issue.

## 1. Read First

Read these before writing code:

1. [`docs/design/VISION.md`](docs/design/VISION.md): what Airhop is and what it will never compromise on
2. [`docs/spec/ARCHITECTURE.md`](docs/spec/ARCHITECTURE.md): the architecture decisions and why they were made
3. [`docs/spec/PROTOCOLS.md`](docs/spec/PROTOCOLS.md): the wire format and the constants you must not break
4. [`docs/dev/PROGRESS.md`](docs/dev/PROGRESS.md): what is done and what is next
5. [`AGENTS.md`](AGENTS.md): the rules, and where each part of the code lives

If your change touches one subsystem, also read its skill in [`.github/skills/`](.github/skills/); `AGENTS.md` lists which covers what. Skipping this step causes rework.

## 2. Set Up

[`README.md`](README.md), "Getting Started", covers cloning, `npm install`, and the Xcode and Android Studio setup. BLE does not run in the iOS Simulator or the Android Emulator, so mesh work needs two physical phones.

Before you change anything, confirm the tree is green:

```sh
npm run typecheck && npm run lint && npm test
```

For protocol work, clone the bitchat reference implementations into `bitchat/` as [`AGENTS.md`](AGENTS.md) describes. They are not part of this repository.

## 3. Make the Change

Work in the build order `AGENTS.md` sets: `src/core/` first, with tests, then native modules, then `src/features/`, then `src/ui/`. Keep the change to one concern, and follow the file's existing conventions before introducing your own.

A protocol change (packet layout, a new packet type, anything bitchat reads) needs a message exchange across an Airhop phone, a bitchat-ios phone and a bitchat-android phone before it ships. Say in the pull request what you tested.

## 4. Test

A change to `src/core/` comes with unit tests, and a bug fix comes with a test that fails without the fix. Beyond that:

- **Wire contracts** pin literal expected bytes (bitchat's, or a spec's), not a round trip through the code under test. `src/core/mesh/wire/__tests__/packet-frame-vectors.test.ts` and the courier vectors in `docs/spec/` are the pattern.
- **Behavior across the whole app** (lifecycles, several phones, lossy links) belongs in the suites under `src/__tests__/`.
- **Native code** keeps new logic in a pure object beside its module, so it can be unit tested without a radio.

Where the tests live and how to run them:

| Area                       | Guide                                             |
| -------------------------- | ------------------------------------------------- |
| TypeScript, and simulation | [`src/README.md`](src/README.md), "Testing"       |
| Android (Kotlin)           | [`android/README.md`](android/README.md), "Tests" |
| iOS (Swift)                | [`ios/README.md`](ios/README.md), "Tests"         |
| Tor client (Rust)          | [`native/README.md`](native/README.md), "Tests"   |

Each native README also gives its formatter. CI checks Kotlin with ktfmt and Swift with swift-format; Rust is formatted and linted with `cargo fmt` and `cargo clippy` on a host toolchain before you commit.

## 5. Review Agents

`AGENTS.md` lists three review agents in `.github/agents/` and when each one runs: Architect for `src/core/` and native changes, Security Review for crypto, key storage, packet signing and device transfer, and Upstream Sync for a new bitchat release. Run the ones your change calls for and address what they flag before asking for review.

## 6. Sign Off Your Commits (DCO)

Every commit carries a `Signed-off-by` trailer. `git commit -s` adds it:

```text
Signed-off-by: Your Name <your@email.com>
```

It certifies that you agree to the [Developer Certificate of Origin](https://developercertificate.org/): that you wrote the contribution or have the right to submit it under this project's license.

## 7. PR Checklist

Before opening any pull request:

- [ ] `npm run verify:invisibles` passes (no literal control, bidirectional, or zero-width characters in source)
- [ ] `npm run verify:vendored` passes (vendored binaries match their recorded hashes)
- [ ] `npm run i18n:audit -- --max 0` passes (no hardcoded user-facing strings)
- [ ] `npm run i18n:native` passes (native language, permission, and service notice strings are in sync)
- [ ] `npm run deadcode` reports nothing new (unused exports, files, and dependencies)
- [ ] `npm run typecheck` passes with zero errors
- [ ] `npm run format:check` passes (no uncommitted format changes)
- [ ] `npm run lint` passes with zero errors
- [ ] `npm run coverage` passes with zero failures
- [ ] `docs/dev/PROGRESS.md` updated if a milestone was completed or a decision was made
- [ ] `docs/design/ROADMAP.md` updated if a feature was added, removed, or reprioritized
- [ ] If touching `src/core/` or `android/` or `ios/`: invoke `@architect` agent for review
- [ ] If touching `src/core/crypto/`, key storage, or packet signing: invoke `@security-review` agent
