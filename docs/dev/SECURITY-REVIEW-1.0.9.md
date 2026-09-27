# Airhop v1.0.9: security and engineering review

## 1. Scope and method

|                 |                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version         | Airhop 1.0.9, branch `v1.0.9` ([PR #74](https://github.com/areebahmeddd/airhop/pull/74))                                                                                                                                        |
| Commits         | `a7f2506..469ef37`: the fixes, then a comment-hygiene pass ([`4011635`](https://github.com/areebahmeddd/airhop/commit/4011635) to [`469ef37`](https://github.com/areebahmeddd/airhop/commit/469ef37)) that changes no behaviour |
| Date            | 2026-09-27                                                                                                                                                                                                                      |
| Code in scope   | `src/`, `android/`, `ios/`, `native/`, `scripts/`, `.github/`, `landing/`                                                                                                                                                       |
| Source of truth | bitchat-ios (local checkout) for every protocol behaviour. bitchat-android deviations are reported, never accommodated                                                                                                          |

**Reference sources.**

| Area         | Checked against                                                                                                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions     | Noise Protocol Framework rev 34 (XX and X patterns, prologue, split); the Signal Double Ratchet specification (section 3.5: a failed message is discarded along with its state changes); the RFC 4303 replay window  |
| Nostr        | NIP-01 (replaceable events), NIP-17 and NIP-59 (gift wrap), NIP-44, NIP-61 (nutzaps); nostr-tools 2.25.2                                                                                                             |
| Payments     | Cashu NUT-00, 01, 02, 07, 10, 11, 12, 13 and 19; cashu-ts 4.11.0; reference wallets CDK, Nutshell, cashu.me, Minibits, NDK (for NIP-61), Phoenix and Muun; Rob Woodgate's review (cashubtc/cashu-ts discussion #963) |
| Tor          | Arti (arti-client 0.46.0), the Tor SOCKS extensions, IPtProxy 5.5.1, Snowflake v2.14.1, the Go vulnerability database and OSV                                                                                        |
| Platform     | expo-secure-store, expo-clipboard, expo-image-picker, expo-file-system, react-native-mmkv, OkHttp 4.12, Android and Apple platform documentation                                                                     |
| Supply chain | GitHub Actions hardening guidance, actions/checkout at the pinned SHA, Gradle wrapper verification, Cloudflare DNS and header documentation                                                                          |

**Method.**

1. Each candidate finding was traced on the branch, including the chaos cases: races, a kill at any `await`, a panic wipe mid-flight, a device transfer mid-flight and radio or network toggles. It was then compared with bitchat-ios and with the installed library source.
2. An independent second review corrected several first-pass claims (its items C-1 to C-11) and raised thirteen new items, R-1 to R-13. Both are folded into the entries below.
3. The owner decided the open questions (section 5).
4. Every behaviour fix carries a test that fails without it. Pure copy, comment and documentation changes are the exception.
5. Three later rounds walked the finished branch again: a pre-merge sanity audit screen by screen, a final pass of each subsystem against its specification, and a trace of every in-chat payload through the interruptions people actually meet. Their items carry IDs that continue each area's numbering.

**Ground rules applied to every fix.** bitchat-ios wire compatibility holds; Airhop-only payloads (the Double Ratchet, geo contact cards, private channels, device transfer) may change. No code path for older Airhop builds, since only testers run them. No reinvention: existing helpers and installed libraries first, and an upstream report where the defect is upstream.

## 2. Executive summary

The cryptographic primitives and the wire format were sound on arrival: the Noise XX pattern and split, low-order point rejection, decode caps, the DEFLATE ratio, the freshness window and dedup all match bitchat-ios. The defects sat in the state and wiring around them. A forged packet could permanently desynchronise the Double Ratchet. Signing-key pins, including those of verified contacts, did not survive a restart. Courier mail never opened between Airhop and bitchat-ios. A location-channel stranger could fold themselves into a friend's DM thread. A DM photo could go out in the clear. The release pipeline would have built a same-named branch instead of the tag.

**Verdict.** Every High and Medium finding is fixed on the branch, except SUP-5, a repository setting the owner holds. One Low item is blocked on an upstream release (APP-9). What remains before the release is operational: a green CI run including the iOS build, and the device checks in section 9. The rebuilt native binaries are committed ([`2bf32ae`](https://github.com/areebahmeddd/airhop/commit/2bf32ae)).

**By severity and status** (164 items):

| Severity     | Items | Fixed | Fixed in part | Fixed earlier | Accepted | Owner | Blocked |
| ------------ | ----- | ----- | ------------- | ------------- | -------- | ----- | ------- |
| High         | 7     | 7     |               |               |          |       |         |
| Medium       | 48    | 47    |               |               |          | 1     |         |
| Low          | 83    | 78    | 3             |               | 1        |       | 1       |
| Info         | 24    | 18    | 1             | 1             | 4        |       |         |
| Not recorded | 2     | 1     |               |               |          | 1     |         |
| **Total**    | 164   | 151   | 4             | 1             | 5        | 2     | 1       |

Status meanings: **Fixed** (on the branch, with the commit given); **Fixed in part** (the defect is closed, and a proposed extra was declined or is blocked); **Fixed earlier** (before this pass); **Accepted** (a deliberate trade-off, section 6); **Owner** (a setting or decision outside the repository); **Blocked** (waits on an upstream release, section 7).

"Not recorded" covers R-3 and R-12, whose descriptions lived only in the second review, which is no longer in the tree. The pass record lists R-3 as fixed with its parent finding and R-12 as an owner item alongside SUP-5.

## 3. Status table

Rd (round): 1 hardening pass, 2 pre-merge sanity audit, 3 final pre-merge pass, 4 message lifecycle and live voice.

### Crypto, sessions and identity

| ID     | Title                                                                             | Sev    | Rd  | Status   | Commit(s)                                                                                                                              |
| ------ | --------------------------------------------------------------------------------- | ------ | --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| CRY-1  | Double Ratchet committed state before authenticating; DR signatures never checked | High   | 1   | Fixed    | [`e923f00`](https://github.com/areebahmeddd/airhop/commit/e923f00)                                                                     |
| CRY-2  | Courier Noise X seal omitted bitchat-ios's prologue                               | High   | 1   | Fixed    | [`c97f0f6`](https://github.com/areebahmeddd/airhop/commit/c97f0f6)                                                                     |
| CRY-3  | Signing-key pin displaced after a restart, contacts included                      | High   | 1   | Fixed    | [`f56667d`](https://github.com/areebahmeddd/airhop/commit/f56667d)                                                                     |
| R-1    | Announced npub written onto a saved contact before the key check                  | High   | 1   | Fixed    | [`f56667d`](https://github.com/areebahmeddd/airhop/commit/f56667d)                                                                     |
| CRY-4  | Noise transport replay window shifted the wrong way                               | Medium | 1   | Fixed    | [`bce9c4b`](https://github.com/areebahmeddd/airhop/commit/bce9c4b)                                                                     |
| CRY-5  | Handshakes unthrottled, pending state unbounded, one bad reply ended a handshake  | Medium | 1   | Fixed    | [`aa693a4`](https://github.com/areebahmeddd/airhop/commit/aa693a4)                                                                     |
| CRY-6  | One-time prekey private keys in plaintext MMKV                                    | Medium | 1   | Fixed    | [`1d72c37`](https://github.com/areebahmeddd/airhop/commit/1d72c37)                                                                     |
| CRY-7  | Device transfer installed whichever identity finished the handshake first         | Medium | 1   | Fixed    | [`231e858`](https://github.com/areebahmeddd/airhop/commit/231e858)                                                                     |
| CRY-11 | A condemned identity's prekeys survived the launch-time delete                    | Medium | 2   | Fixed    | [`c1dce21`](https://github.com/areebahmeddd/airhop/commit/c1dce21)                                                                     |
| CRY-12 | A forged card's Nostr key survived the proof that corrected its keys              | Medium | 2   | Fixed    | [`8b1cf31`](https://github.com/areebahmeddd/airhop/commit/8b1cf31), [`75536cc`](https://github.com/areebahmeddd/airhop/commit/75536cc) |
| CRY-13 | A lost msg3 left a pair on two different sessions until a restart                 | Medium | 3   | Fixed    | [`6b8cdc1`](https://github.com/areebahmeddd/airhop/commit/6b8cdc1)                                                                     |
| CRY-14 | A replayed signed DR packet could tear down a working session                     | Medium | 3   | Fixed    | [`f5dc854`](https://github.com/areebahmeddd/airhop/commit/f5dc854)                                                                     |
| CRY-8  | Private-channel sender not checked against the sealed author                      | Low    | 1   | Fixed    | [`d784075`](https://github.com/areebahmeddd/airhop/commit/d784075)                                                                     |
| CRY-9  | Old signed LEAVE replayable through the sync-reply exemption                      | Low    | 1   | Fixed    | [`99fd893`](https://github.com/areebahmeddd/airhop/commit/99fd893) (MESH-3)                                                            |
| CRY-10 | Chat-screen message IDs from `Math.random`                                        | Low    | 1   | Fixed    | [`43b1789`](https://github.com/areebahmeddd/airhop/commit/43b1789)                                                                     |
| R-2    | Prekey bundles not bound to their sender                                          | Low    | 1   | Fixed    | [`f56667d`](https://github.com/areebahmeddd/airhop/commit/f56667d)                                                                     |
| R-10   | A forged msg1 under a peer's ID displaces its pending handshake                   | Low    | 1   | Accepted | [`aa693a4`](https://github.com/areebahmeddd/airhop/commit/aa693a4) (test)                                                              |
| CRY-15 | A blocked peer's Noise session outlived the block                                 | Low    | 2   | Fixed    | [`380d0fa`](https://github.com/areebahmeddd/airhop/commit/380d0fa)                                                                     |
| CRY-16 | Names from cards, verify QRs, geohash tags and bridge events not normalised       | Low    | 2   | Fixed    | [`01d0dbd`](https://github.com/areebahmeddd/airhop/commit/01d0dbd)                                                                     |

### Mesh ingress, relay, sync and courier

| ID      | Title                                                                     | Sev    | Rd  | Status   | Commit(s)                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------- | ------ | --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MESH-1  | REQUEST_SYNC relayed, answered at any TTL, answered unsigned              | Medium | 1   | Fixed    | [`99fd893`](https://github.com/areebahmeddd/airhop/commit/99fd893)                                                                                                                                         |
| MESH-2  | Files, board posts and voice frames relayed before they were checked      | Medium | 1   | Fixed    | [`bf21a57`](https://github.com/areebahmeddd/airhop/commit/bf21a57)                                                                                                                                         |
| MESH-3  | Sync-reply exemption wider than bitchat-ios's                             | Medium | 1   | Fixed    | [`99fd893`](https://github.com/areebahmeddd/airhop/commit/99fd893)                                                                                                                                         |
| MESH-4  | No disk budget for received attachments                                   | Medium | 1   | Fixed    | [`32d5753`](https://github.com/areebahmeddd/airhop/commit/32d5753)                                                                                                                                         |
| MESH-15 | A public file tagged with a DM thread landed in that thread               | Medium | 2   | Fixed    | [`53b5bfc`](https://github.com/areebahmeddd/airhop/commit/53b5bfc)                                                                                                                                         |
| MESH-16 | A DM to a peer gone for over a minute never reached a courier             | Medium | 3   | Fixed    | [`5e5c4c8`](https://github.com/areebahmeddd/airhop/commit/5e5c4c8)                                                                                                                                         |
| MESH-17 | Carriers sprayed toward peers heard only through relays                   | Medium | 3   | Fixed    | [`8cc6e01`](https://github.com/areebahmeddd/airhop/commit/8cc6e01)                                                                                                                                         |
| MESH-18 | A re-seal spent a new prekey, and a prekey that opened mail stayed live   | Medium | 3   | Fixed    | [`f4e965c`](https://github.com/areebahmeddd/airhop/commit/f4e965c)                                                                                                                                         |
| MESH-5  | Gossip stored packets before verifying them, in one shared bucket         | Low    | 1   | Fixed    | [`9afd45f`](https://github.com/areebahmeddd/airhop/commit/9afd45f), [`3ff7622`](https://github.com/areebahmeddd/airhop/commit/3ff7622), [`1dadbe9`](https://github.com/areebahmeddd/airhop/commit/1dadbe9) |
| MESH-6  | Receiving cards for anyone, uncapped, under a claimed name                | Low    | 1   | Fixed    | [`b7ff30a`](https://github.com/areebahmeddd/airhop/commit/b7ff30a)                                                                                                                                         |
| MESH-7  | Relay targeting and TTL did not follow bitchat-ios                        | Low    | 1   | Fixed    | [`0fb7d72`](https://github.com/areebahmeddd/airhop/commit/0fb7d72)                                                                                                                                         |
| MESH-8  | Untagged public file re-joined #bluetooth; failed write left half a file  | Low    | 1   | Fixed    | [`32d5753`](https://github.com/areebahmeddd/airhop/commit/32d5753)                                                                                                                                         |
| MESH-9  | Owed read receipts grew until the thread was opened                       | Low    | 1   | Fixed    | [`2959ad1`](https://github.com/areebahmeddd/airhop/commit/2959ad1)                                                                                                                                         |
| MESH-10 | Maps that never shrank                                                    | Low    | 1   | Fixed    | [`9afd45f`](https://github.com/areebahmeddd/airhop/commit/9afd45f), [`2959ad1`](https://github.com/areebahmeddd/airhop/commit/2959ad1)                                                                     |
| MESH-11 | GCS request decode accepted `m = 0` and `p` outside 1..32                 | Low    | 1   | Fixed    | [`9afd45f`](https://github.com/areebahmeddd/airhop/commit/9afd45f)                                                                                                                                         |
| MESH-19 | Gateway ran its Schnorr check before the cheap carrier gates              | Low    | 2   | Fixed    | [`94626fc`](https://github.com/areebahmeddd/airhop/commit/94626fc)                                                                                                                                         |
| MESH-20 | Mail written with nobody in range waited for the next foreground          | Low    | 3   | Fixed    | [`e5674b5`](https://github.com/areebahmeddd/airhop/commit/e5674b5), [`4eccb05`](https://github.com/areebahmeddd/airhop/commit/4eccb05)                                                                     |
| MESH-21 | Pins, Rings and group states counted as sent with no link                 | Low    | 4   | Fixed    | [`6265499`](https://github.com/areebahmeddd/airhop/commit/6265499)                                                                                                                                         |
| MESH-12 | Fragment reassembly accepted empty and tiny non-final fragments           | Info   | 1   | Fixed    | [`a30c75b`](https://github.com/areebahmeddd/airhop/commit/a30c75b)                                                                                                                                         |
| MESH-13 | Specs, skills and comments contradicted by the code or bitchat-ios        | Info   | 1   | Fixed    | [`10417a6`](https://github.com/areebahmeddd/airhop/commit/10417a6), [`5f9d1d8`](https://github.com/areebahmeddd/airhop/commit/5f9d1d8), [`5a1fd9e`](https://github.com/areebahmeddd/airhop/commit/5a1fd9e) |
| MESH-14 | Group invites unlimited                                                   | Info   | 1   | Accepted |                                                                                                                                                                                                            |
| MESH-22 | Bridge loop caches off bitchat-ios's 512 IDs; bounded-set code duplicated | Info   | 2   | Fixed    | [`f0f181b`](https://github.com/areebahmeddd/airhop/commit/f0f181b), [`3243022`](https://github.com/areebahmeddd/airhop/commit/3243022)                                                                     |

### Payments

| ID     | Title                                                                        | Sev    | Rd  | Status        | Commit(s)                                                                                                                              |
| ------ | ---------------------------------------------------------------------------- | ------ | --- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| PAY-1  | Offline check called a token genuine when only some coins had a witness      | Medium | 1   | Fixed         | [`c5539d7`](https://github.com/areebahmeddd/airhop/commit/c5539d7)                                                                     |
| PAY-2  | Token's declared unit trusted, never checked against its keysets             | Medium | 1   | Fixed         | [`7e21949`](https://github.com/areebahmeddd/airhop/commit/7e21949)                                                                     |
| PAY-3  | Refresh marked coins verified from a state check; one bad coin blocked it    | Medium | 1   | Fixed         | [`d4587bf`](https://github.com/areebahmeddd/airhop/commit/d4587bf)                                                                     |
| PAY-4  | Coins locked to someone else accepted offline as money                       | Medium | 1   | Fixed         | [`7e21949`](https://github.com/areebahmeddd/airhop/commit/7e21949)                                                                     |
| PAY-5  | Nutzap spam became pending rows and unbounded mint traffic                   | Medium | 1   | Fixed         | [`8cefa6d`](https://github.com/areebahmeddd/airhop/commit/8cefa6d)                                                                     |
| PAY-6  | Tokens from a rotated keyset refused as forged                               | Medium | 1   | Fixed         | [`c5539d7`](https://github.com/areebahmeddd/airhop/commit/c5539d7)                                                                     |
| PAY-7  | Offline receipts never redeemed automatically when the network returned      | Medium | 1   | Fixed         | [`100f8f6`](https://github.com/areebahmeddd/airhop/commit/100f8f6)                                                                     |
| PAY-15 | Receipts and nutzaps refused on any error, not a definite mint refusal       | Medium | 2   | Fixed         | [`8a346ba`](https://github.com/areebahmeddd/airhop/commit/8a346ba)                                                                     |
| PAY-16 | A mint key rotation mid-swap surfaced library English and closed nutzaps     | Medium | 3   | Fixed         | [`1030f3c`](https://github.com/areebahmeddd/airhop/commit/1030f3c)                                                                     |
| PAY-8  | Recipient's kind 10019 was whichever event arrived first                     | Low    | 1   | Fixed         | [`7a0b8ef`](https://github.com/areebahmeddd/airhop/commit/7a0b8ef)                                                                     |
| PAY-9  | Chat tokens drove keyset refreshes past the per-mint throttle                | Low    | 1   | Fixed         | [`7a0b8ef`](https://github.com/areebahmeddd/airhop/commit/7a0b8ef)                                                                     |
| PAY-10 | Receiving overwrote the mint's unit list                                     | Low    | 1   | Fixed         | [`7e21949`](https://github.com/areebahmeddd/airhop/commit/7e21949)                                                                     |
| PAY-11 | Airhop's nutzaps dropped the DLEQ witness and the unit tag                   | Low    | 1   | Fixed         | [`7a0b8ef`](https://github.com/areebahmeddd/airhop/commit/7a0b8ef)                                                                     |
| PAY-12 | Wallet encryption overstated; iOS Tor gate read once per reconcile pass      | Low    | 1   | Fixed         | [`4909b98`](https://github.com/areebahmeddd/airhop/commit/4909b98), [`24e641f`](https://github.com/areebahmeddd/airhop/commit/24e641f) |
| PAY-13 | Pay confirm did not say its fee came from a stale cache                      | Low    | 1   | Fixed         | [`7a0b8ef`](https://github.com/areebahmeddd/airhop/commit/7a0b8ef)                                                                     |
| R-4    | A nutzap from an unheld mint wrote a failed Activity row                     | Low    | 1   | Fixed         | [`8cefa6d`](https://github.com/areebahmeddd/airhop/commit/8cefa6d)                                                                     |
| R-5    | Nutzap markers capped by count, so spam evicted genuine ones                 | Low    | 1   | Fixed         | [`8cefa6d`](https://github.com/areebahmeddd/airhop/commit/8cefa6d)                                                                     |
| R-9    | A stored but invalid recovery phrase treated as none                         | Low    | 1   | Fixed         | [`7aef64f`](https://github.com/areebahmeddd/airhop/commit/7aef64f)                                                                     |
| PAY-14 | Recovery phrase: read error taken as absence; clipboard; unguarded reveal    | Low    | 1   | Fixed in part | [`7aef64f`](https://github.com/areebahmeddd/airhop/commit/7aef64f), [`bdae6d5`](https://github.com/areebahmeddd/airhop/commit/bdae6d5) |
| PAY-17 | Wallet stayed locked after a keychain failure until a force-quit             | Low    | 2   | Fixed         | [`4473571`](https://github.com/areebahmeddd/airhop/commit/4473571)                                                                     |
| PAY-18 | Offline receipts not redeemed when the internet switch came back on          | Low    | 2   | Fixed         | [`3ecbc82`](https://github.com/areebahmeddd/airhop/commit/3ecbc82)                                                                     |
| PAY-19 | Refresh read the mint gate once, not before each request                     | Low    | 2   | Fixed         | [`e518320`](https://github.com/areebahmeddd/airhop/commit/e518320)                                                                     |
| PAY-20 | A refused receipt kept its token's claimed mark                              | Low    | 2   | Fixed         | [`d7d484b`](https://github.com/areebahmeddd/airhop/commit/d7d484b)                                                                     |
| PAY-21 | An offline receipt paid onward stayed "unconfirmed"                          | Low    | 2   | Fixed         | [`1475f6a`](https://github.com/areebahmeddd/airhop/commit/1475f6a)                                                                     |
| PAY-22 | An offline reclaim the recipient beat was not marked sent                    | Low    | 2   | Fixed         | [`7d4559f`](https://github.com/areebahmeddd/airhop/commit/7d4559f)                                                                     |
| PAY-23 | A refused reclaim offered no token to copy                                   | Low    | 2   | Fixed         | [`04531e9`](https://github.com/areebahmeddd/airhop/commit/04531e9)                                                                     |
| PAY-24 | A stale fee was not said on the nutzap-to-token fallback                     | Low    | 2   | Fixed         | [`9b0cc9e`](https://github.com/areebahmeddd/airhop/commit/9b0cc9e)                                                                     |
| PAY-25 | A token memo could carry bidi controls                                       | Low    | 2   | Fixed         | [`1cc535f`](https://github.com/areebahmeddd/airhop/commit/1cc535f)                                                                     |
| PAY-26 | A retried claim left a receipt stuck on unconfirmed                          | Low    | 3   | Fixed         | [`9f37f9b`](https://github.com/areebahmeddd/airhop/commit/9f37f9b)                                                                     |
| PAY-27 | An x-only kind 10019 key (NDK wallets) was refused                           | Low    | 3   | Fixed         | [`5badae6`](https://github.com/areebahmeddd/airhop/commit/5badae6)                                                                     |
| PAY-28 | A queued token over the 255-byte cap promised a delivery no route could make | Low    | 4   | Fixed         | [`6f02f34`](https://github.com/areebahmeddd/airhop/commit/6f02f34)                                                                     |
| PAY-29 | The Tor hold on a payment locked to us was not named                         | Info   | 2   | Fixed         | [`023a9b5`](https://github.com/areebahmeddd/airhop/commit/023a9b5)                                                                     |
| PAY-30 | The simulated mint skipped NUT-11 and inactive-keyset checks                 | Info   | 2   | Fixed         | [`f88f1a9`](https://github.com/areebahmeddd/airhop/commit/f88f1a9), [`ed8e905`](https://github.com/areebahmeddd/airhop/commit/ed8e905) |
| PAY-31 | Claim on our own unsettled send said "+N stored"                             | Info   | 3   | Fixed         | [`f938fc1`](https://github.com/areebahmeddd/airhop/commit/f938fc1)                                                                     |

### Nostr, Tor and network egress

| ID     | Title                                                                                 | Sev    | Rd  | Status   | Commit(s)                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------------- | ------ | --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NET-1  | Forwarded contact card merged a location pseudonym into a contact's DM thread         | High   | 1   | Fixed    | [`00cfa06`](https://github.com/areebahmeddd/airhop/commit/00cfa06)                                                                                                                                         |
| NET-2  | Place-name geocoding ignored Tor and the internet switch                              | Medium | 1   | Fixed    | [`7899dde`](https://github.com/areebahmeddd/airhop/commit/7899dde)                                                                                                                                         |
| NET-3  | Bridge deposits reached BridgeService unauthenticated                                 | Medium | 1   | Fixed    | [`b78c0c8`](https://github.com/areebahmeddd/airhop/commit/b78c0c8)                                                                                                                                         |
| NET-4  | nostr-tools recorded an event ID as seen before verifying it                          | Medium | 1   | Fixed    | [`c612fd6`](https://github.com/areebahmeddd/airhop/commit/c612fd6)                                                                                                                                         |
| NET-5  | Android HTTP clients outside RN's factory bypassed Tor; update check ignored a switch | Medium | 1   | Fixed    | [`8efd0c2`](https://github.com/areebahmeddd/airhop/commit/8efd0c2), [`7899dde`](https://github.com/areebahmeddd/airhop/commit/7899dde)                                                                     |
| NET-6  | SOCKS route left on a failed start; no per-destination isolation on Android           | Medium | 1   | Fixed    | [`8efd0c2`](https://github.com/areebahmeddd/airhop/commit/8efd0c2), [`4b614d9`](https://github.com/areebahmeddd/airhop/commit/4b614d9), [`2bf32ae`](https://github.com/areebahmeddd/airhop/commit/2bf32ae) |
| NET-7  | Only one OkHttp connection pool evicted when Tor came on                              | Medium | 1   | Fixed    | [`8efd0c2`](https://github.com/areebahmeddd/airhop/commit/8efd0c2)                                                                                                                                         |
| NET-8  | Presence heartbeats went to the default DM relays                                     | Medium | 1   | Fixed    | [`8658080`](https://github.com/areebahmeddd/airhop/commit/8658080)                                                                                                                                         |
| NET-16 | The held Tor state was lost through a refused Try again or an internet cycle          | Medium | 2   | Fixed    | [`2e2eba5`](https://github.com/areebahmeddd/airhop/commit/2e2eba5), [`f551afb`](https://github.com/areebahmeddd/airhop/commit/f551afb)                                                                     |
| NET-17 | A refused bridge change turned Tor off and reopened relays on the clear net           | Medium | 3   | Fixed    | [`e0d5f3a`](https://github.com/areebahmeddd/airhop/commit/e0d5f3a)                                                                                                                                         |
| NET-18 | Channel retries went out as new messages, could reach the internet, misreported reach | Medium | 4   | Fixed    | [`c527416`](https://github.com/areebahmeddd/airhop/commit/c527416)                                                                                                                                         |
| NET-9  | Location and room `mid` tag used as the row ID                                        | Low    | 1   | Fixed    | [`d784075`](https://github.com/areebahmeddd/airhop/commit/d784075)                                                                                                                                         |
| NET-10 | `unwrapDm` did not type-check the rumor                                               | Low    | 1   | Fixed    | [`78fdb11`](https://github.com/areebahmeddd/airhop/commit/78fdb11)                                                                                                                                         |
| NET-11 | A crash during Tor start made the next launch go clear-net                            | Low    | 1   | Fixed    | [`4eba016`](https://github.com/areebahmeddd/airhop/commit/4eba016)                                                                                                                                         |
| NET-12 | Courier-drop backfill capped at 20 per relay                                          | Low    | 1   | Fixed    | [`5d6cc3e`](https://github.com/areebahmeddd/airhop/commit/5d6cc3e)                                                                                                                                         |
| R-6    | An ID recorded for an event the full pump dropped                                     | Low    | 1   | Fixed    | [`c612fd6`](https://github.com/areebahmeddd/airhop/commit/c612fd6)                                                                                                                                         |
| R-7    | Geohash jump sheet read place names under the wrong key                               | Low    | 1   | Fixed    | [`7899dde`](https://github.com/areebahmeddd/airhop/commit/7899dde)                                                                                                                                         |
| NET-19 | iOS reported every Tor start as blocked, and stopped watching past 75 s               | Low    | 3   | Fixed    | [`67922bb`](https://github.com/areebahmeddd/airhop/commit/67922bb), [`8362ec9`](https://github.com/areebahmeddd/airhop/commit/8362ec9)                                                                     |
| NET-20 | Relay connectivity not read from the sockets, so a dead gateway kept advertising      | Low    | 3   | Fixed    | [`f16a456`](https://github.com/areebahmeddd/airhop/commit/f16a456)                                                                                                                                         |
| NET-21 | A bridged copy kept its row over the signed radio copy                                | Low    | 3   | Fixed    | [`40713f3`](https://github.com/areebahmeddd/airhop/commit/40713f3)                                                                                                                                         |
| NET-22 | A location-chat contact card no relay accepted stayed marked shared                   | Low    | 4   | Fixed    | [`9893211`](https://github.com/areebahmeddd/airhop/commit/9893211)                                                                                                                                         |
| NET-13 | `validateRelayUrl` accepted hex and octal IPv4                                        | Info   | 1   | Fixed    | [`c2cca65`](https://github.com/areebahmeddd/airhop/commit/c2cca65)                                                                                                                                         |
| NET-14 | Urgent board notice set unbounded                                                     | Info   | 1   | Fixed    | [`eb0d335`](https://github.com/areebahmeddd/airhop/commit/eb0d335)                                                                                                                                         |
| NET-15 | Gateway publishes a well-formed deposit for any cell                                  | Info   | 1   | Accepted | [`10417a6`](https://github.com/areebahmeddd/airhop/commit/10417a6), [`6b79c53`](https://github.com/areebahmeddd/airhop/commit/6b79c53) (docs)                                                              |
| R-13   | Whether `HttpURLConnection` resolves DNS at the exit through SOCKS                    | Info   | 1   | Accepted |                                                                                                                                                                                                            |

### Native transports

| ID    | Title                                                                          | Sev    | Rd  | Status        | Commit(s)                                                                                                                              |
| ----- | ------------------------------------------------------------------------------ | ------ | --- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| NAT-1 | Android Wi-Fi Aware listener accepted any interface and announced before hello | Medium | 1   | Fixed         | [`c1f4ecc`](https://github.com/areebahmeddd/airhop/commit/c1f4ecc)                                                                     |
| NAT-2 | TCP listeners uncapped, thread per socket, per-read deadline, fragile accept   | Medium | 1   | Fixed         | [`c1f4ecc`](https://github.com/areebahmeddd/airhop/commit/c1f4ecc), [`1a40156`](https://github.com/areebahmeddd/airhop/commit/1a40156) |
| NAT-3 | iOS LAN listener and browser opted into AWDL                                   | Low    | 1   | Fixed         | [`1a40156`](https://github.com/areebahmeddd/airhop/commit/1a40156)                                                                     |
| NAT-6 | iOS mDNS discovery uncapped                                                    | Low    | 2   | Fixed         | [`2fcb99e`](https://github.com/areebahmeddd/airhop/commit/2fcb99e)                                                                     |
| NAT-7 | Android live-voice playback bursts shared one queue across a handoff           | Low    | 4   | Fixed         | [`56a3f0f`](https://github.com/areebahmeddd/airhop/commit/56a3f0f)                                                                     |
| NAT-8 | A live burst's last few hundred milliseconds were cut on the listener's phone  | Low    | 4   | Fixed         | [`522fbd0`](https://github.com/areebahmeddd/airhop/commit/522fbd0)                                                                     |
| NAT-4 | iOS long writes and write-only centrals                                        | Info   | 1   | Fixed earlier | [`3946eb8`](https://github.com/areebahmeddd/airhop/commit/3946eb8)                                                                     |
| NAT-5 | No recents-snapshot cover on Android 8 to 12L                                  | Info   | 1   | Accepted      |                                                                                                                                        |

### App layer

| ID     | Title                                                                          | Sev    | Rd  | Status        | Commit(s)                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------------ | ------ | --- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| APP-11 | A DM photo or voice note could go out as signed cleartext                      | High   | 4   | Fixed         | [`c0a725d`](https://github.com/areebahmeddd/airhop/commit/c0a725d), [`a88bfd9`](https://github.com/areebahmeddd/airhop/commit/a88bfd9)                                                                     |
| APP-1  | Device transfer dialled any IPv4 address the code named                        | Medium | 1   | Fixed         | [`231e858`](https://github.com/areebahmeddd/airhop/commit/231e858)                                                                                                                                         |
| APP-2  | Slow or refusing keychain at launch read as "no identity"                      | Medium | 1   | Fixed         | [`df6ffcb`](https://github.com/areebahmeddd/airhop/commit/df6ffcb)                                                                                                                                         |
| APP-3  | Android photos under 512 KiB kept their EXIF, GPS included                     | Medium | 1   | Fixed         | [`7b668b6`](https://github.com/areebahmeddd/airhop/commit/7b668b6)                                                                                                                                         |
| APP-4  | Picker copies escaped retention and Clear; iOS `tmp/` escaped the wipe         | Medium | 1   | Fixed         | [`3f611ac`](https://github.com/areebahmeddd/airhop/commit/3f611ac)                                                                                                                                         |
| R-8    | An iOS relaunch before first unlock reached onboarding                         | Medium | 1   | Fixed         | [`df6ffcb`](https://github.com/areebahmeddd/airhop/commit/df6ffcb)                                                                                                                                         |
| APP-12 | A photo the encoder could not open went out as the original, EXIF included     | Medium | 2   | Fixed         | [`4d4f937`](https://github.com/areebahmeddd/airhop/commit/4d4f937)                                                                                                                                         |
| APP-13 | Invisible presence dropped on every relaunch and boot start                    | Medium | 3   | Fixed         | [`630d9eb`](https://github.com/areebahmeddd/airhop/commit/630d9eb)                                                                                                                                         |
| APP-5  | OS-delivered `airhop://` links joined and imported without a tap               | Low    | 1   | Fixed         | [`c4d099e`](https://github.com/areebahmeddd/airhop/commit/c4d099e)                                                                                                                                         |
| APP-6  | Received file names and types taken from the sender                            | Low    | 1   | Fixed         | [`3819301`](https://github.com/areebahmeddd/airhop/commit/3819301)                                                                                                                                         |
| APP-7  | A refused-key wipe followed by a kill reloaded the old identity                | Low    | 1   | Fixed         | [`df6ffcb`](https://github.com/areebahmeddd/airhop/commit/df6ffcb)                                                                                                                                         |
| APP-8  | Announced nicknames kept bidi and invisible characters                         | Low    | 1   | Fixed in part | [`3819301`](https://github.com/areebahmeddd/airhop/commit/3819301)                                                                                                                                         |
| APP-9  | Recovery phrase and tokens copied without a sensitive flag                     | Low    | 1   | Blocked       |                                                                                                                                                                                                            |
| APP-14 | A refused wipe told the person to wipe again rather than reopen                | Low    | 2   | Fixed         | [`100538b`](https://github.com/areebahmeddd/airhop/commit/100538b)                                                                                                                                         |
| APP-15 | Transfer refused a condemned identity's phone; cancel left a listener          | Low    | 2   | Fixed         | [`103e69b`](https://github.com/areebahmeddd/airhop/commit/103e69b)                                                                                                                                         |
| APP-16 | Right-to-left reordered the six safety words                                   | Low    | 2   | Fixed         | [`0ae1115`](https://github.com/areebahmeddd/airhop/commit/0ae1115)                                                                                                                                         |
| APP-17 | A cancelled pick or recording left its file behind                             | Low    | 2   | Fixed         | [`1cc39b0`](https://github.com/areebahmeddd/airhop/commit/1cc39b0)                                                                                                                                         |
| APP-18 | Sent files aged from the wrong time; Clear missed the iOS tmp copies           | Low    | 2   | Fixed         | [`7917964`](https://github.com/areebahmeddd/airhop/commit/7917964)                                                                                                                                         |
| APP-19 | A receive card's X did nothing useful; its title was concatenated              | Low    | 2   | Fixed         | [`a98260a`](https://github.com/areebahmeddd/airhop/commit/a98260a)                                                                                                                                         |
| APP-20 | An unsent private-channel message showed "Waiting to send" with no Retry       | Low    | 2   | Fixed         | [`ea7f609`](https://github.com/areebahmeddd/airhop/commit/ea7f609)                                                                                                                                         |
| APP-21 | A refused contact card gave no reason                                          | Low    | 2   | Fixed         | [`9f76fe0`](https://github.com/areebahmeddd/airhop/commit/9f76fe0)                                                                                                                                         |
| APP-22 | Layout direction not re-pinned by reset or wipe; notice misnamed the direction | Low    | 3   | Fixed         | [`4085cd2`](https://github.com/areebahmeddd/airhop/commit/4085cd2), [`a2cee07`](https://github.com/areebahmeddd/airhop/commit/a2cee07)                                                                     |
| APP-23 | Read receipts had no route once the sender left; outbox evicted DMs silently   | Low    | 4   | Fixed         | [`9b548db`](https://github.com/areebahmeddd/airhop/commit/9b548db)                                                                                                                                         |
| APP-24 | A channel or group message queued at a kill kept its hourglass with no Retry   | Low    | 4   | Fixed         | [`1749235`](https://github.com/areebahmeddd/airhop/commit/1749235)                                                                                                                                         |
| APP-25 | Private photos and voice notes never reached delivered                         | Low    | 4   | Fixed         | [`dec8fcd`](https://github.com/areebahmeddd/airhop/commit/dec8fcd)                                                                                                                                         |
| APP-26 | A send orphaned by a quick kill and relaunch stayed on sending                 | Low    | 4   | Fixed         | [`37aaf5e`](https://github.com/areebahmeddd/airhop/commit/37aaf5e)                                                                                                                                         |
| APP-27 | A retried photo's caption skipped bitchat peers                                | Low    | 4   | Fixed         | [`ea43cc1`](https://github.com/areebahmeddd/airhop/commit/ea43cc1)                                                                                                                                         |
| APP-28 | A voice note and a live burst played over each other                           | Low    | 4   | Fixed         | [`256e281`](https://github.com/areebahmeddd/airhop/commit/256e281)                                                                                                                                         |
| APP-10 | What the wipe and hidden previews leave behind                                 | Info   | 1   | Fixed in part | [`2c0d097`](https://github.com/areebahmeddd/airhop/commit/2c0d097)                                                                                                                                         |
| APP-29 | Launch branching had no direct test                                            | Info   | 2   | Fixed         | [`520d34b`](https://github.com/areebahmeddd/airhop/commit/520d34b), [`a64c3ee`](https://github.com/areebahmeddd/airhop/commit/a64c3ee)                                                                     |
| APP-30 | The new phone did not say the old phone's turn after They match                | Info   | 2   | Fixed         | [`1bc762e`](https://github.com/areebahmeddd/airhop/commit/1bc762e)                                                                                                                                         |
| APP-31 | The missing-attachment note and the retention location copy were wrong         | Info   | 2   | Fixed         | [`f3b3503`](https://github.com/areebahmeddd/airhop/commit/f3b3503), [`dfd4151`](https://github.com/areebahmeddd/airhop/commit/dfd4151), [`90feca0`](https://github.com/areebahmeddd/airhop/commit/90feca0) |
| APP-32 | A location channel's header lacked its place name                              | Info   | 2   | Fixed         | [`2d0b146`](https://github.com/areebahmeddd/airhop/commit/2d0b146)                                                                                                                                         |
| APP-33 | Version credit line built from fragments; one unreferenced key                 | Info   | 2   | Fixed         | [`d28440c`](https://github.com/areebahmeddd/airhop/commit/d28440c), [`4f30901`](https://github.com/areebahmeddd/airhop/commit/4f30901)                                                                     |
| APP-34 | The Help sheet said an offline token waits for a refresh                       | Info   | 2   | Fixed         | [`9c4ce74`](https://github.com/areebahmeddd/airhop/commit/9c4ce74)                                                                                                                                         |
| APP-35 | The Profile hub's own buttons showed no press state                            | Info   | 3   | Fixed         | [`335030a`](https://github.com/areebahmeddd/airhop/commit/335030a)                                                                                                                                         |
| APP-36 | The Tor timeout copy named a minute                                            | Info   | 3   | Fixed         | [`c35c911`](https://github.com/areebahmeddd/airhop/commit/c35c911)                                                                                                                                         |
| APP-37 | A refused DM photo or voice note gave no reason                                | Info   | 4   | Fixed         | [`9d66256`](https://github.com/areebahmeddd/airhop/commit/9d66256)                                                                                                                                         |

### Supply chain, release, tooling and docs

| ID     | Title                                                                        | Sev    | Rd  | Status        | Commit(s)                                                                                                                                                                                                  |
| ------ | ---------------------------------------------------------------------------- | ------ | --- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SUP-1  | Release jobs checked out a same-named branch instead of the tag              | High   | 1   | Fixed         | [`2ff6e08`](https://github.com/areebahmeddd/airhop/commit/2ff6e08), [`7ddca01`](https://github.com/areebahmeddd/airhop/commit/7ddca01), [`e6b6a91`](https://github.com/areebahmeddd/airhop/commit/e6b6a91) |
| SUP-2  | Release APK silently fell back to the public debug key                       | Medium | 1   | Fixed         | [`2ff6e08`](https://github.com/areebahmeddd/airhop/commit/2ff6e08)                                                                                                                                         |
| SUP-3  | Signing key beside npm and Gradle; persisted tokens; unpinned CocoaPods      | Medium | 1   | Fixed         | [`fda1f72`](https://github.com/areebahmeddd/airhop/commit/fda1f72), [`2ff6e08`](https://github.com/areebahmeddd/airhop/commit/2ff6e08), [`f863655`](https://github.com/areebahmeddd/airhop/commit/f863655) |
| SUP-4  | Tor transports carried reachable Go panic advisories; Rust and rustls behind | Medium | 1   | Fixed         | [`fb539b9`](https://github.com/areebahmeddd/airhop/commit/fb539b9), [`8c3836d`](https://github.com/areebahmeddd/airhop/commit/8c3836d), [`2bf32ae`](https://github.com/areebahmeddd/airhop/commit/2bf32ae) |
| SUP-5  | Signing secrets repo-wide; no release Environment gate                       | Medium | 1   | Owner         |                                                                                                                                                                                                            |
| SUP-6  | Sideloaded APKs unverifiable; verify command too loose                       | Low    | 1   | Fixed         | [`2ff6e08`](https://github.com/areebahmeddd/airhop/commit/2ff6e08), [`c5a00bd`](https://github.com/areebahmeddd/airhop/commit/c5a00bd)                                                                     |
| SUP-7  | verify-vendored tied binaries to a lock, not the build; docs overclaimed     | Low    | 1   | Fixed         | [`8b6c024`](https://github.com/areebahmeddd/airhop/commit/8b6c024)                                                                                                                                         |
| SUP-8  | Expression injection in the release tag resolver                             | Low    | 1   | Fixed         | [`2ff6e08`](https://github.com/areebahmeddd/airhop/commit/2ff6e08)                                                                                                                                         |
| SUP-9  | `knip` fetched unpinned at run time                                          | Low    | 1   | Fixed         | [`86f0081`](https://github.com/areebahmeddd/airhop/commit/86f0081)                                                                                                                                         |
| SUP-10 | Gradle distribution unchecked; JitPack consulted for everything              | Low    | 1   | Fixed         | [`b70a066`](https://github.com/areebahmeddd/airhop/commit/b70a066)                                                                                                                                         |
| SUP-11 | Automation committed straight to the triggering branch, `main` included      | Low    | 1   | Fixed         | [`f3d3dfb`](https://github.com/areebahmeddd/airhop/commit/f3d3dfb)                                                                                                                                         |
| SUP-12 | Bridge sync validated only a line's leading tokens                           | Low    | 1   | Fixed         | [`2075cf3`](https://github.com/areebahmeddd/airhop/commit/2075cf3)                                                                                                                                         |
| R-11   | Automation could also run on and push to tags                                | Low    | 1   | Fixed         | [`f3d3dfb`](https://github.com/areebahmeddd/airhop/commit/f3d3dfb)                                                                                                                                         |
| SUP-13 | Dependabot's rubyzip bump (PR #75) needed a fastlane that allows rubyzip 3   | Low    | 1   | Fixed         | [`17d2e98`](https://github.com/areebahmeddd/airhop/commit/17d2e98)                                                                                                                                         |
| SUP-14 | Landing: a GitHub request per visitor; DNS hardening; header and build nits  | Low    | 1   | Fixed in part | [`c8989fc`](https://github.com/areebahmeddd/airhop/commit/c8989fc)                                                                                                                                         |
| SUP-15 | Stale docs, comments and duplicated scenario IDs after the hardening pass    | Info   | 2   | Fixed         | see entry                                                                                                                                                                                                  |
| R-12   | Repository settings item (description not retained)                          | n/r    | 1   | Owner         |                                                                                                                                                                                                            |

### Unplaced

| ID  | Title                                         | Sev | Rd  | Status | Commit(s)    |
| --- | --------------------------------------------- | --- | --- | ------ | ------------ |
| R-3 | Second-review item (description not retained) | n/r | 1   | Fixed  | not recorded |

## 4. Findings by area

Each entry gives what was wrong and why it mattered, then the fix or the decision. Commits are in section 3.

### 4.1 Crypto, sessions and identity

#### CRY-1 · Double Ratchet committed state before authenticating

High · Fixed. **What:** `ratchetDecrypt` stepped the DH ratchet and advanced the receiving chain before the AEAD check; `trySkippedKey` deleted a cached key before its decrypt; `onDREncrypted` never checked the packet's signature; a ratchet could outlive the session it was seeded from. **Impact:** one forged or replayed `DR_ENCRYPTED` from anyone in range desynchronised two Airhop users for good, silently. **Fix:** decryption runs on a copy committed only after authentication (Signal section 3.5); the sender's signature is checked first; each ratchet is bound to its `{session, role}` and counts as absent under any other session; a responder that receives a signed ratchet message before seeding one seeds its receiving side. The first design's self-heal on a failed decrypt is withdrawn by CRY-14.

#### CRY-2 · Courier Noise X seal omitted bitchat-ios's prologue

High · Fixed. **What:** Airhop's Noise X transcript skipped `MixHash(prologue)`, which Noise rev 34 section 5.3 requires and bitchat-ios performs. **Impact:** every courier envelope and relay drop between the two apps failed to open, in both directions, with no error. The test vectors never exercised the seal. **Fix:** the prologue is a required argument: `bitchat-courier-v1` for static seals, `bitchat-prekey-v1 || u32BE(id)` for prekey seals. Open-direction vectors generated with Python `noiseprotocol` are in `docs/spec/courier-seal-vectors.json` (D1). Vectors from bitchat-ios's own XCTest need macOS and remain optional.

#### CRY-3 · Signing-key pin displaced after a restart, contacts included

High · Fixed. **What:** the peer registry starts empty after a restart or an eviction flood, so whoever announced a saved contact's peer ID first had their own key pinned. **Impact:** they could post, send files and LEAVEs as the contact, and plant prekey bundles that made our courier mail to the contact readable by them. **Fix:** one TTL-free resolver, `knownSigningKey`, answers every signature check in the order: key proven in a Noise session, verified contact, unverified contact, announce pin. `onAnnounce` refuses an announce that contradicts it before anything is written. A session proof corrects an unverified contact and drops prekey data taken under the wrong key; a proof contradicting a verified contact is refused (QR-only re-pin). **Declined (D2):** persisting strangers' pins as bitchat-ios does; a durable table of everyone met is the record the vision's privacy principles avoid. Review C-4 withdrew the first-pass claim that [`8aacf4d`](https://github.com/areebahmeddd/airhop/commit/8aacf4d) widened this.

#### R-1 · Announced npub written onto a saved contact before the key check

High · Fixed. **Impact:** a forged announce redirected a contact's Nostr DMs. **Fix:** an npub is stored on a contact only from an announce whose key is vouched for, and the Nostr DM fallback prefers the contact's npub.

#### CRY-4 · Noise transport replay window shifted the wrong way

Medium · Fixed. **What:** `ReplayWindow.markSeen` shifted each byte right instead of left when the highest nonce advanced, so after nonces 0..100 in order, 93..99 were accepted again. `NOISE_ENCRYPTED` is unsigned and its dedup key covers an unsigned timestamp, so a re-stamped capture passed every other check. **Impact:** a recent Ring, voice burst or receipt could be replayed. **Fix:** the two shift operators swapped; checked against a set model over 2,000 random orders. The same defect is in bitchat-ios and bitchat-android (section 8).

#### CRY-5 · Handshakes unthrottled, pending state unbounded, one bad reply ended a handshake

Medium · Fixed. **What:** msg1 from any claimed ID created responder state and a flooded msg2 with no limit; responder entries never expired; a garbage or valid-but-foreign msg2 or msg3 destroyed the pending handshake the genuine reply needed. **Fix:** bitchat-ios's limit of 10 a minute per claimed peer; the global 30 a minute applies to inbound msg1 only (D3), so forged IDs cannot starve our own initiations; entries expire after 30 s on every insert; msg2 and msg3 are read on a clone, and the pending entry is replaced only by a bound session. One shared `SlidingWindowLimiter` serves this and sync.

#### CRY-6 · One-time prekey private keys in plaintext MMKV

Medium · Fixed. **What:** private keys, including consumed ones in their grace period, sat as hex in an append-only MMKV file where deleted values linger. **Impact:** a later copy of the file from an unlocked phone could open old courier mail, defeating the forward secrecy prekeys exist for. **Fix:** one keychain item (`localPrekeys` in `KEYCHAIN_ITEMS`), deleted by the panic wipe and left alone by the launch sweep; consumed keys refused past their grace; a failed read mints and overwrites nothing. **Declined:** encrypting the partition instead (its key sits beside the file, and stale ciphertext stays openable). **Later:** bitchat-ios's 30-day rotation of unconsumed keys.

#### CRY-7 · Device transfer installed whichever identity finished the handshake first

Medium · Fixed with APP-1. **What:** anyone who saw the new phone's code and shared its network could race the real old phone; nothing let the person confirm the pair. **Fix:** both phones show six words, `sha256("airhop-move-sas-v1" || handshakeHash)` rendered with `safetyNumberWords` and never translated. The new phone confirms with They match, which sends `CONFIRM` (`0x07`); the old phone freezes and streams only after it. The old phone's tap count is unchanged; the new phone gains one. The words appear before the first crash-recovery marker on either phone. Showing only the arriving username was rejected: it can be ground in about 65,000 key generations.

#### CRY-8 · Private-channel sender not checked against the sealed author

Low · Fixed. On Bluetooth the outer signer is the authenticated identity; a message whose sealed sender differs is dropped. Rows are keyed `ch-<sender>-<msgId>`, so a copy claiming another author cannot collapse a genuine one. The Nostr path stays self-asserted among members by design (the room key is the credential); an author signature inside the seal was declined as a payload change that only relabels an accepted threat.

#### CRY-9 · Old signed LEAVE replayable through the sync-reply exemption

Low · Fixed by MESH-3. The first-pass path (a plain replay minutes old) was refuted, since the ±2 min window applies to LEAVE; the real path was the type-agnostic sync-reply exemption, which MESH-3 narrows.

#### CRY-10 · Chat-screen message IDs from `Math.random`

Low · Fixed. All IDs come from `newMessageId()` (8 bytes of CSPRNG), which is what lets a receipt resolve the outbox by message ID alone.

#### R-2 · Prekey bundles not bound to their sender

Low · Fixed. A bundle is kept only when the packet names its owner and both the outer and inner signatures verify against the resolver's key; one dated past the 15 min announce skew is refused. bitchat-ios has no future bound (section 8).

#### R-10 · A forged msg1 displaces a pending handshake

Low · Accepted. bitchat-ios behaves the same, and the DM recovers through the outbox. Documented in code and pinned by scenario C13b.

#### CRY-11 to CRY-16 (later rounds)

| ID     | What was wrong                                                                                                                                                          | Fix                                                                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CRY-11 | After a wipe the keychain refused, the launch retry deleted only the identity; the next identity loaded the old prekey blob and published it, linking the two           | The retry deletes both before any mesh can mint                                                                                                                                      |
| CRY-12 | A session proof that corrected an unverified contact's keys kept the npub and name the forged card brought, so internet DMs kept going to the forger                    | Replacing a held key drops the card's npub and name and unmaps them; an in-person scan replaces the npub with the keys (scenarios C14b, C14c)                                        |
| CRY-13 | A lost msg3 left the initiator on the new session and the responder on the old one; neither side recovered until a restart                                              | As in bitchat-ios, a responder attempt that expires over a held session owes one initiator attempt, under the handshake limiter; the new session replaces the old only on completion |
| CRY-14 | CRY-1's self-heal tore down a session on any failed signed DR packet; dedup is a 1,000-entry window anyone in range can flush, so a replay past it evicted working keys | A failed decrypt is discarded (Signal section 3.5, bitchat-ios); genuine desync converges through CRY-13's re-initiation                                                             |
| CRY-15 | Blocking dropped the ratchet but kept the Noise session, so after an unblock the peer's DR packets met a session with no ratchet and were dropped                       | The block clears the session, so the next packet takes the existing recovery path                                                                                                    |
| CRY-16 | Names on contact cards, bitchat verify QRs, geohash `n` tags and bridge events skipped `normalizeNickname`, so a bidi override reached the contact list                 | Each is normalised once where it is decoded; the bitchat QR only after its signature check, which covers the bytes as sent                                                           |

**Checked and sound.** The Noise XX token order, prologue and three-output split match bitchat-ios bit for bit. The ratchet root is seeded from the exporter secret through HKDF. `@noble/curves` 2.4.0 rejects the low-order X25519 points and a zero output. `sessionBindsTo` runs on both completion paths before a session is stored. The tie-break (lower peer ID initiates) matches bitchat-ios. The group creator is pinned. `keychain.ts` is the only `expo-secure-store` importer, and every call passes `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`.

### 4.2 Mesh ingress, relay, sync and courier

#### MESH-1 · REQUEST_SYNC relayed, answered at any TTL, answered unsigned

Medium · Fixed. **Impact:** one crafted request turned every node within seven hops into a full-store responder, and the per-peer budget could be spread across forged IDs. **Fix:** as bitchat-ios: never relayed; answered only at TTL 0, from the peer bound to the link, with a signature against its key, on that peer's budget. Airhop and bitchat-ios both send requests only to peers whose announce they verified, so first contact still syncs.

#### MESH-2 · Files, board posts and voice frames relayed before they were checked

Medium · Fixed. **Impact:** forged or stale packets were re-flooded (a forged 1 MiB file over LAN became about 2,250 Bluetooth fragments), and a forged copy reaching dedup first shadowed the genuine one. **Fix:** a pre-relay gate runs the handlers' own predicates for the four types bitchat-ios gates (LEAVE, FILE_TRANSFER, BOARD_POST including expiry, VOICE_FRAME) before dedup, and again on reassembled packets, since bitchat-ios can fragment voice on small MTUs.

#### MESH-3 · Sync-reply exemption wider than bitchat-ios's

Medium · Fixed. **What:** a ttl-0 packet counted as solicited without `IS_RSR`; any type was exempt; an exempt packet with TTL headroom relayed with the flag kept. **Impact:** a neighbour could replay a week-old signed message as current, hop by hop. **Fix:** an `IS_RSR` packet is judged on its own, fresh or not: ttl 0, from the link peer we asked, and a type sync serves within the age we would serve it for (fragments get the board window). The ttl-0 allowance, which only accommodated bitchat-android, is gone. Message and group windows rose to bitchat-ios's six hours in the same change (review C-1), so its backfill still lands.

#### MESH-4 · No disk budget for received attachments

Medium · Fixed. Received media is capped at 100 MiB (bitchat-ios's quota), oldest out first; sent files are not counted. An evicted file shows the existing "not on this device" state. A per-sender quota was declined: minting identities defeats it.

#### MESH-5 · Gossip stored packets before verifying them, in one shared bucket

Low · Fixed. Packets are tracked only after acceptance, in per-kind stores with bitchat-ios's sizes; announces keep one per sender. Sync runs bitchat-ios's rounds (announces, messages and groups every 15 s; board posts alone every 60 s), so old board posts backfill on busy rooms too (D5). Refused replies are advertised but never served, so they are not offered every round. A block drops the peer's stored public messages, as bitchat-ios does. A per-sender cap was declined: bitchat-ios has none, and each slot now costs a signed packet.

#### MESH-6 · Receiving cards for anyone, uncapped, under a claimed name

Low · Fixed. A card appears only for a sender whose key is held (and a session, for a sealed file), at most three at once, and unnamed in public rooms, since fragments prove no sender.

#### MESH-7 · Relay targeting and TTL did not follow bitchat-ios

Low · Fixed. `relayDecision` transcribes bitchat-ios's `RelayController`: nothing addressed to us or claiming our ID is relayed (our own announce is still handled, for identity-elsewhere); directed traffic keeps full depth; broadcasts clamp by degree. Origin TTL is drawn from `[ceiling-2, ceiling]` of the same limit at this phone's degree, so about a third of authored packets stay attributable at every density (D6). An all-0xFF recipient counts as broadcast.

#### MESH-8 · Untagged public file re-joined #bluetooth; failed write left half a file

Low · Fixed. An untagged public file is dropped unless #bluetooth is joined, and a partial file is deleted. Enforcing 512 KiB per-type caps on receive was refuted: they are send budgets in bitchat-ios too, and receive checks only the 1 MiB total.

#### MESH-9 · Owed read receipts grew until the thread was opened

Low · Fixed. Bounded per conversation at the thread's message cap, and dropped with a deleted or blocked thread.

#### MESH-10 · Maps that never shrank

Low · Fixed. A closed link's pong budget, idle sync-limiter keys and stale sync requests are pruned on link close or on the sync tick.

#### MESH-11 · GCS request decode accepted `m = 0` and `p` outside 1..32

Low · Fixed. Refused at decode, as bitchat-ios does, before any response budget is spent; the legitimate empty filter (`m = 1`) still draws a full reply.

#### MESH-12 · Fragment reassembly limits

Info · Fixed (optional hardening). Empty fragments and non-final ones under 64 bytes are refused; bitchat-ios never emits smaller. The 128 slots and the 10,000-fragment ceiling stay at bitchat-ios's values.

#### MESH-13 · Documentation and comment drift

Info · Fixed. Fourteen statements in PROTOCOLS, `mesh-routing.md` and code comments contradicted the code or bitchat-ios (the channel sync bit, sync bits 5 and 7, triggered sync, the relay of REQUEST_SYNC, the reassembly timeout, the ttl-0 allowance, the origin-TTL header). Each was corrected with its fix.

#### MESH-14 · Group invites unlimited

Info · Accepted. There is no pending queue; a creator-signed invite over a Noise session applies at once, as in bitchat-ios. Blocking the creator stops further invites; a per-creator cap is defeated by minting identities.

#### MESH-15 to MESH-22 (later rounds)

| ID      | What was wrong                                                                                                                                                                  | Fix                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MESH-15 | A signed public file could carry a `dm:<peer>` tag and land in that contact's thread, which shows no sender                                                                     | The tag is refused, as the text path already refused it; a DM attachment is addressed by recipient ID and never tagged                                                                   |
| MESH-16 | A DM to a peer gone for over a minute never reached a courier: the seal key was read through the registry's 60 s TTL, and a held ratchet flooded at a room the peer had left    | Seal to the pinned key, else the contact's, as bitchat-ios reads its favourites; send over the mesh only to a peer the registry still shows                                              |
| MESH-17 | Every announce, direct or relayed, made a carrier hand over and spray; with no link the copy flooded at full depth, so every phone within seven hops ended up carrying the mail | bitchat-ios's split: a linked peer gets handover and spray; a peer heard through relays gets only its own mail, at most once per envelope per 10 minutes, never a spray                  |
| MESH-18 | Each re-seal took a fresh one-time prekey, draining the owner's bundle; a prekey that opened a message could stay live                                                          | One prekey per message ID, consumed straight after the Noise X open, as bitchat-ios does                                                                                                 |
| MESH-19 | The gateway verified every event's Schnorr signature before any cheaper gate, even with the gateway off                                                                         | Structural gates, carrier signature, dedup and rate limit first, in bitchat-ios's order; an event is recorded as seen only once verified                                                 |
| MESH-20 | Mail written with nobody in range waited for the next foreground instead of the first carrier                                                                                   | A direct announce offers every queued DM for an absent recipient to the carriers in range (bitchat-ios `courierBecameAvailable`); PROTOCOLS section 6 states the deposit and carry rules |
| MESH-21 | A pin and a Ring reported sent with no link, and a group invite or key update was treated as delivered and lost                                                                 | Pins and Rings refuse without a link; group states queue and flush on the announce that brings the peer back                                                                             |
| MESH-22 | The bridge loop caches were built at 2,000 IDs against bitchat-ios's 512; four hand-written bounded-set copies and two limiters existed                                         | One `BoundedIdSet` and one `SlidingWindowLimiter`; bridge caches at 512                                                                                                                  |

**Checked and sound.** Decode caps and the DEFLATE ratio match bitchat-ios number for number. The ±2 min ingress window, the 1,000-entry and 5 min dedup, the 8-per-30 s response limit, the GCS parameters (P = 7, 400-byte budget, newest-first trim), the fragment header rules, the 30 s voice frame age, the board limits and the 200-peer prekey store all equal bitchat-ios's. A reassembled packet's inner type must equal the claimed type.

### 4.3 Payments

Rob Woodgate's review points on cashu-ts discussion #963 were checked first. Short keyset IDs, per-unit restore, persisted swap previews for NUT-19 replay, seed derivation at first run, `selectProofsToSend` for melts, ambiguous swap timeouts, the melt timeout and swap-down before a melt were already addressed. Phantom balances and stale fees were addressed only in part; PAY-7 and PAY-13 close them. The local `swap-preview.ts` is kept over cashu-ts 4.10's serialisers because it preserves input byte order for stored previews, and its header says so.

#### PAY-1 · Offline check called a token genuine when only some coins had a witness

Medium · Fixed. One real 1-sat coin with a DLEQ witness made a token of any size read "genuine" offline, the one assurance a seller in a dead zone acts on. "Valid" now means every coin's witness verifies (CDK's `verify_token_dleq`); otherwise the result is "unchecked" with a reason code, and the screen chooses the sentence. Refusing witness-less tokens was declined: NUT-12 makes witnesses optional and many wallets strip them.

#### PAY-2 · Token's declared unit trusted, never checked against its keysets

Medium · Fixed. The unit comes from the keysets; a label they contradict makes the token malformed (NUT-00), refused online and off, and shown as text rather than a card. Crediting under the keyset's unit was declined: it guesses at a sender's bug, and CDK and cashu-ts both refuse.

#### PAY-3 · Refresh marked coins verified from a state check; one bad coin blocked the account

Medium · Fixed. NUT-07 reports unknown coins as unspent, so forged coins were marked verified, and one refused coin in a pooled swap failed every later refresh. Verified now comes only from a swap; unverified coins are screened locally, then swapped one receipt at a time (at most eight per refresh). A definitely refused receipt is closed as failed, keeping its token so the user can return it (more conservative than CDK, which deletes). Bisecting a pooled batch was declined in favour of grouping by receipt.

#### PAY-4 · Coins locked to someone else accepted offline as money

Medium · Fixed. A token with coins P2PK- or HTLC-locked to another key is refused before anything is stored, and the chat card shows "Locked". Coins locked to us are claimed online through cashu-ts's sign-then-authorise path, which also handles NUT-28 blinded locks (review C-3).

#### PAY-5 · Nutzap spam became pending rows and unbounded mint traffic

Medium · Fixed. The subscription carries NIP-61's `#u` filter; the lock, mint, unit and any present witness are checked before a row or a request; events are redeemed one at a time and settled after a local or definite refusal, so a replay costs no request. A DLEQ witness is not required: NDK-based senders strip it.

#### PAY-6 · Tokens from a rotated keyset refused as forged

Medium · Fixed. An inactive keyset is listed with no keys cached; that is "unchecked" offline, not "forged". Online, cashu-ts fetches the keyset's keys by ID and the swap decides.

#### PAY-7 · Offline receipts never redeemed automatically when the network returned

Medium · Fixed. The reconcile pass swaps unverified receipts, two accounts per pass, with a single-flight refresh per account so a pull-to-refresh joins rather than races. This closes the double-spend window the copy already promised to close.

#### PAY-8 · Recipient's kind 10019 was whichever event arrived first

Low · Fixed. The newest by NIP-01 replaceable order is used; an unparseable newest event means the recipient opted out, so the payment falls back to a token.

#### PAY-9 · Chat tokens drove keyset refreshes past the per-mint throttle

Low · Fixed. The throttle is keyed by mint alone, and no wallet is cached for a unit the mint does not issue.

#### PAY-10 · Receiving overwrote the mint's unit list

Low · Fixed. Only a mint snapshot writes units.

#### PAY-11 · Airhop's nutzaps dropped the DLEQ witness and the unit tag

Low · Fixed. Both are published, the witness with its blinding factor so third parties can verify.

#### PAY-12 · Wallet encryption wording; iOS Tor gate read once per pass

Low · Fixed. The docs say AES-256 in CFB mode, confidentiality only, under a 192-bit key from the keychain; MMKV's CRC detects corruption, not tampering, which the threat model accepts because writing the app's files needs the same access that reads the keychain. The mint gate is read before every request a reconcile pass makes (completed by PAY-19).

#### PAY-13 · Pay confirm did not say its fee came from a stale cache

Low · Fixed. The confirm carries the stale-fee note past a day, from one shared threshold, and the note is a `tPlural` entry.

#### R-4 and R-5 · Nutzap settlement

Low · Fixed. A nutzap from an unheld mint settles with no Activity row (R-4). Settled markers are kept with their `created_at` and pruned by the 30-day lookback, never by count, so spam cannot evict a genuine zap's marker (R-5).

#### R-9 · A stored but invalid recovery phrase treated as none

Low · Fixed with PAY-14(a). An invalid phrase is kept with its flags and never overwritten; the session runs on random secrets that the next refresh brings under the phrase.

#### PAY-14 · Recovery phrase handling

Low · Fixed in part. (a) A failed keychain read was treated as "no phrase", clearing the backup marks and trying to write a new phrase; only a confirmed absence starts one now. Moving the phrase to the "when unlocked" class was rejected: it breaks locked background relaunch and protects nothing the MMKV key does not already expose. (b) The clipboard flag is APP-9, blocked. (c) Both ways to the words ask for Face ID or the passcode through `confirmDeviceOwner`, as the identity transfer does; a phone with no lock shows them (D7).

#### PAY-15 to PAY-31 (later rounds)

| ID     | What was wrong                                                                                                                                      | Fix                                                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| PAY-15 | Before staging, any failure other than the radio or the Tor gate counted as a refusal, so a 429 removed an honest receipt and settled a real nutzap | Only a NUT error or a local check the mint's own keys disprove refuses; anything else waits for the next try                                      |
| PAY-16 | cashu-ts's `StaleKeysetError` after a rotation surfaced as library English, called a nutzap lock in doubt, and could close a nutzap for good        | Each staged site drops its row and prepares once more on the refreshed keysets, as cashu-ts documents; an unrepaired rejection is translated copy |
| PAY-17 | A launch before first unlock cached the failed wallet open for the life of the process                                                              | An unreadable keychain resets the partition, and the next open rehydrates it                                                                      |
| PAY-18 | Turning the internet switch back on, or lifting the iOS Tor block, started no redemption                                                            | The reachability watch follows the mint gate and runs the reconcile pass, unthrottled, when it reopens                                            |
| PAY-19 | Refresh read the mint gate once, so Tor switched on mid-redemption let later swaps out on iOS                                                       | The gate is read before the state check and before each receipt's prepare and swap                                                                |
| PAY-20 | A refused receipt kept its token marked as taken, so the user could not take it back in                                                             | The mark is cleared with the refusal                                                                                                              |
| PAY-21 | A receipt paid onward in a dead zone read "Received, unconfirmed" for good                                                                          | Any delivery that leaves a receipt with no coins here closes it                                                                                   |
| PAY-22 | A reclaim the recipient had already redeemed, settled by refresh, read "Reclaimed" beside a spent-proofs debit                                      | The refresh completes the send, files no second debit, and the chat card follows                                                                  |
| PAY-23 | A refused reclaim offered no token to copy, and its reason spoke of someone else's coins                                                            | Any failed row holding a token offers Copy; a refused reclaim has its own wording                                                                 |
| PAY-24 | The fallback token after a failed nutzap lock could be priced from an old fee schedule without saying so                                            | The reclaimable confirm carries the stale-fee note                                                                                                |
| PAY-25 | A token memo could carry U+202E or an isolate into the chat payment card                                                                            | The memo goes through the shared `stripInvisibles`                                                                                                |
| PAY-26 | A new claim staged a swap for coins an unanswered earlier claim still owned                                                                         | The earlier claim's replay runs first, then the claim decides afresh                                                                              |
| PAY-27 | An x-only kind 10019 key, as NDK publishes, was treated as no nutzap info                                                                           | Normalised to `02` plus the key, as NIP-61 instructs; NUT-11 signatures are BIP-340, so either parity spends                                      |
| PAY-28 | A queued token over the 255-byte private-message cap promised delivery that no Noise, Nostr or courier route can make                               | The copy says which route can carry it and points at Activity                                                                                     |
| PAY-29 | A payment locked to us held back by the iOS Tor block said "claim it once you are online"                                                           | It carries the Tor refusal, which names the setting                                                                                               |
| PAY-30 | The simulated mint skipped NUT-11 and signed under inactive keysets, so locked-coin tests passed without the key                                    | The simulation applies NUT-11 and refuses inactive keysets with 12002; the refresh's dead branch for stored locked coins is removed               |
| PAY-31 | Claim on our own unsettled send said "+N stored"                                                                                                    | It says the payment is our own, as Receive does                                                                                                   |

**Checked and sound.** Unheld mints are never contacted. Mint URL normalisation agrees with cashu-ts. Keyset IDs are verified on every build. Amounts are bounded and credited from proofs, never from a declared field. Every swap, mint and melt persists its preview or outputs before its only network step, and only a definite refusal releases value. BIP-39 entropy comes from `@scure/bip39`. NUT-13 counters only move forward. No proof, secret or phrase is logged.

### 4.4 Nostr, Tor and network egress

#### NET-1 · Forwarded contact card merged a location pseudonym into a contact's DM thread

High · Fixed. **What:** a stranger in a location channel could forward a friend's public contact card; once the user shared theirs back, the stranger's pseudonymous thread folded into the friend's real DM thread, where bubbles carry no sender name. **Fix:** the `0x22` card carries an Ed25519 proof by the durable signing key over `airhop-geo-card-v1 || senderCell || recipientCell || card`, verified against the key already held for that peer ID; an unproven card writes nothing. Merging only after a mesh contact was rejected: it defeats the feature for people who met only in a location channel.

#### NET-2 · Place-name geocoding ignored Tor and the internet switch

Medium · Fixed. The OS geocoder is a system service outside any app proxy on both platforms. Lookups run only with the internet on and Tor neither on nor wanted, through one `network-gate.ts`. Persisting bookmark names only was declined (D8); the gate alone closes the leak.

#### NET-3 · Bridge deposits reached BridgeService unauthenticated

Medium · Fixed. A deposit must be addressed to us and signed by its depositor; the cheap gates and the rate limit, keyed by the authenticated ID, run before event verification. The proposed neighbourhood cell gate was dropped at review: bitchat-ios accepts any valid cell.

#### NET-4 · nostr-tools recorded an event ID as seen before verifying it

Medium · Fixed locally. In nostr-tools 2.25.2 one relay sending a bad-signature copy under a genuine ID dropped the real event from every relay in the pool call, and a rejected far-future event moved every relay's reconnect cursor. `NostrClient` opens one subscription per relay, each with its own filter copy, and keeps its own ID set recorded only after verification. Upstream PR nbd-wtf/nostr-tools#560 fixes it and is unmerged (section 7).

#### NET-5 · Android HTTP clients outside RN's factory bypassed Tor

Medium · Fixed. With Tor on, the in-app APK download went out in the clear through expo-file-system's own OkHttp client, and the update check ignored the internet switch. A default `ProxySelector` routes http, https, ws and wss through Arti (review C-2: plain sockets for LAN, Wi-Fi Aware and transfer stay direct); the Version screen checks both switches.

#### NET-6 · SOCKS route left on a failed start; no per-destination isolation on Android

Medium · Fixed. **What:** Android pointed its HTTP stack at `127.0.0.1:39050` before Arti bound, and a failed launch-time start left it there, so an app squatting the port received wallet traffic; Android's SOCKS client always offers username auth, collapsing every stream onto one isolation key. **Fix:** the proxy is held on a dead route until Arti binds and while it stops; `socks.rs` isolates by destination and caps its isolation map (in the binaries since [`2bf32ae`](https://github.com/areebahmeddd/airhop/commit/2bf32ae)). **Declined (D9):** SOCKS credentials (iOS support undocumented) and an ephemeral port. The fixed port is shared with bitchat-ios.

#### NET-7 · Only one OkHttp connection pool evicted when Tor came on

Medium · Fixed. Every factory-built client shares one pool, emptied on each route change, and a request on a connection opened on the wrong route is refused after the stale socket is closed.

#### NET-8 · Presence heartbeats went to the default DM relays

Medium · Fixed. Heartbeats go to the cell's geo relays, where bitchat and Airhop read presence, and are skipped when the cell has none (review C-10), so DM relays no longer learn each per-cell key's cell.

#### NET-9 · Location and room `mid` tag used as the row ID

Low · Fixed. The row ID hashes the length-prefixed message ID with the text (the proposed `msgId|text` could collide), so a copy with other text becomes its own row. An exact copy can still take credit for the same words; nothing false is shown.

#### NET-10 · `unwrapDm` did not type-check the rumor

Low · Fixed. `validateEvent` and kind 14 before anything reads it. The comments and skill state the ±15 min window.

#### NET-11 · A crash during Tor start made the next launch go clear-net

Low · Fixed (D10). On a surviving crash marker Tor stays on, native Tor is not started, Nostr and the Android route are held, and the Tor screen offers Try again. The Mesh banner opens the Tor screen.

#### NET-12 · Courier-drop backfill capped at 20 per relay

Low · Fixed. 100, as bitchat-ios. Pagination was declined: an attacker floods past any page budget, and courier over Nostr is a fallback.

#### R-6 · An ID recorded for an event the full pump dropped

Low · Fixed with NET-4. An ID is recorded only when the pump accepted the event, so another relay's copy still arrives.

#### R-7 · Jump sheet read place names under the wrong key

Low · Fixed. It reads through `placeNameKey`, so neighbour names show and stop re-querying.

#### NET-13 · `validateRelayUrl` accepted hex and octal IPv4

Info · Fixed. Every host a WHATWG parser reads as IPv4 is refused. bitchat-ios shares the gap (section 8).

#### NET-14 · Urgent board notice set unbounded

Info · Fixed. Bounded at 2,000 through the shared `BoundedIdSet`.

#### NET-15 · Gateway publishes a deposit for any cell

Info · Accepted. Restricting it breaks teleported and region channels, and bitchat-ios restricts no cell.

#### R-13 · DNS resolution for `HttpURLConnection` through SOCKS

Info · Accepted, unverified. OkHttp hands unresolved hosts to SOCKS; whether Android's `HttpURLConnection` does the same was not checked on a device, so no document claims remote DNS for it.

#### NET-16 to NET-22 (later rounds)

| ID     | What was wrong                                                                                                                                                                    | Fix                                                                                                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| NET-16 | Try again from the held Tor state ran the toggle path, whose catch unwinds to the clear net; an internet off and on cycle cleared the marker and restarted Tor quietly            | A refused retry lands back in the held state; the marker stays unless a start was in flight. Only Tor off or an accepted Try again leaves it |
| NET-17 | A bridge change restarts Tor through disable then enable, and a refused enable read the disable as a user on the clear net: a bad bridge line turned Tor off                      | A refused restart falls back to the held state: Tor stays on, relays and route held                                                          |
| NET-18 | A channel retry minted a new wire ID (duplicates for anyone with both); a nearby-only message could be bridged to the internet on retry; a relay post read sent on an open socket | The row ID is the wire ID; nearby-only is stored on the row; relay publishes report their outcome and the row settles on it                  |
| NET-19 | iOS posted its start event before the client existed, so every start read "could not connect"; its status poll stopped at 75 s, stranding a slow Snowflake bootstrap              | The start event follows `airhop_tor_start`; the poll runs while Arti runs, at the Android cadence                                            |
| NET-20 | `isConnected` never saw a dropped socket, so a gateway that lost signal kept advertising and published deposits into a dead pool                                                  | Connectivity is read from the pool's socket status, with a 5 s poll driving the change handler                                               |
| NET-21 | A bridged copy that arrived first held the row, and the signed radio copy was dropped behind it                                                                                   | The radio copy replaces a bridged row, without a second notification, matching bitchat-ios's "radio wins"                                    |
| NET-22 | "Keep this person" was marked shared before the publish answered, so a card every relay refused spent the one tap                                                                 | A refused card clears the shared mark unless the exchange already completed                                                                  |

**Checked and sound.** The seal and rumor pubkeys must match and the seal signature is verified first. The bitchat NIP-44 variant refuses anything without its `v2:` prefix. Every pool build checks both the internet switch and the Tor hold. iOS URLSession uses the same SOCKS dictionary as bitchat-ios. OkHttp and `socks.rs` resolve DNS at the exit, and Arti refuses local targets. Every Rust FFI entry runs inside `catch_panic`.

### 4.5 Native transports

#### NAT-1 · Android Wi-Fi Aware listener accepted any interface and announced before the hello

Medium · Fixed. The Aware server socket listened on every interface, so anyone on the same Wi-Fi could scan it, receive a signed ANNOUNCE and inject mesh traffic from outside radio range. Inbound sockets are accepted only on `aware_data*` interfaces (resolved through the scoped interface, then the scope ID, then the address; an unresolvable one is accepted with a log line, so no device build loses Aware), and a link reaches JavaScript only after its first hello, inbound only for a data path this side is responding to. LAN keeps announcing on accept, by design, but refuses non-local interfaces. The data-path timing tuned for the Samsung testers is untouched.

#### NAT-2 · TCP listeners uncapped, thread per socket, per-read deadline, fragile accept loop

Medium · Fixed. One host on the network could exhaust threads and crash the process. A shared `FrameReader` enforces a 30 s whole-frame deadline; accept caps are 16 LAN, 4 transfer and 4 awaiting a hello; a write stalled 30 s closes its link; the accept loop survives errors. iOS applies the same caps and uses `tcp.persistTimeout` for stalled writes.

#### NAT-3 · iOS LAN listener and browser opted into AWDL

Low · Fixed. Peer-to-peer is off, and cellular and loopback are prohibited. AWDL reached Apple devices on no shared network and skewed the LAN ring Android computes.

#### NAT-4 · iOS long writes and write-only centrals

Info · Fixed earlier ([`3946eb8`](https://github.com/areebahmeddd/airhop/commit/3946eb8)). A central that writes without subscribing keeps one small entry until Bluetooth power-cycles, as in bitchat-ios.

#### NAT-5 · No recents-snapshot cover on Android 8 to 12L

Info · Accepted. Toggling `FLAG_SECURE` in `onUserLeaveHint` was refuted: the snapshot is taken before the hint (Google issue 232890407). A persistent flag would block the screenshots the app allows on purpose. An opt-in "hide in recents" switch was declined (D11).

#### NAT-6 to NAT-8 (later rounds)

| ID    | What was wrong                                                                                                                                 | Fix                                                                                                                                              |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| NAT-6 | iOS announced every mDNS name Bonjour returned, while Android stopped at 64                                                                    | Capped at 64; lost names retire first                                                                                                            |
| NAT-7 | A floor handoff landed while the previous Android playback thread was inside a blocking write, splitting or silencing the next speaker's burst | Each burst gets its own queue and generation (`PlaybackBursts`, JVM-tested)                                                                      |
| NAT-8 | END and the idle timeout stopped playback at once, so every listener lost the last syllable still in the 350 ms jitter buffer                  | `finishPlayback` drains the queue before releasing the speaker, as bitchat-ios's `finishAfterDrain`; a new burst still supersedes a draining one |

**Checked and sound.** Stream framing refuses negative or oversized lengths on both platforms. BLE prepared and long writes refuse gaps and frames over 512 bytes. Only `MainActivity` and the boot receiver are exported. PendingIntents are immutable. Backup and device-transfer extraction exclude everything. Cleartext traffic is blocked. On-disk attachment names cannot traverse. Diagnostics exports hold no content, names, keys or peer IDs. The iOS Aware listener admits only paired devices.

### 4.6 App layer

#### APP-1 · Device transfer dialled any IPv4 address the code named

Medium · Fixed with CRY-7. A forged code could make the old phone send the whole identity and wallet over the internet, then wipe itself. Native code reports the phone's own subnets and TypeScript refuses an address outside them before a byte leaves (review C-9); `ncm` joins the local interface prefixes. An RFC 1918 allow-list was rejected: campus Wi-Fi hands out public addresses, and VPNs route private ones.

#### APP-2 · Slow or refusing keychain at launch read as "no identity"

Medium · Fixed. An 8 s timeout or a throwing read took the first-install branch, sweeping the recovery phrase and P2PK key and letting onboarding overwrite the identity. Launch tells present, absent and unreadable apart; unreadable shows "Can't open your keys" with Try again and a confirmed Erase and start over, and sweeps nothing. Straight after a wipe an unreadable keychain still goes to welcome. Making `saveIdentity` refuse to overwrite was dropped: after a refused wipe, overwriting is what destroys the old identity.

#### APP-3 · Android photos under 512 KiB kept their EXIF, GPS included

Medium · Fixed. JPEG and WebP are always re-encoded; GIF and PNG that fit go unchanged. iOS stills and Android library picks were already clean. Location inside sent videos is out of scope and documented.

#### APP-4 · Picker copies escaped retention and Clear; iOS `tmp/` escaped the wipe

Medium · Fixed. Sent documents and videos are adopted into the attachment cache (or deleted on cancel), and the iOS wipe empties `tmp`.

#### R-8 · An iOS relaunch before first unlock reached onboarding

Medium · Fixed with APP-2. The unreadable screen retries whenever the app becomes active.

#### APP-5 · OS-delivered `airhop://` links joined and imported without a tap

Low · Fixed. They open the Join sheet, filled in, with one Join tap.

#### APP-6 · Received file names and types taken from the sender

Low · Fixed. Names pass through `stripInvisibles`; the on-disk extension follows the validated MIME; video is held to MP4 and QuickTime by its box type.

#### APP-7 · A refused-key wipe followed by a kill reloaded the old identity

Low · Fixed. A refused delete marks the identity condemned outside the wiped partitions; launch deletes it again or, if still refused, goes to welcome with the wipe-incomplete banner. Writing a new identity clears the mark.

#### APP-8 · Announced nicknames kept bidi and invisible characters

Low · Fixed in part (D12). `stripInvisibles` removes bidi controls, zero-width and tag characters (ZWNJ and ZWJ kept for Persian and emoji) from nicknames, file names and every translated placeholder. **Declined:** the `#last4` suffix on names that collide with a contact, our own name or the generated-name shape; the owner kept the key-bound naming design.

#### APP-9 · Recovery phrase and tokens copied without a sensitive flag

Low · Blocked. `expo-clipboard`'s `android.isSensitive` ships with Expo SDK 58, which is still a preview; mixing one SDK 58 module into SDK 57 is ruled out. A native helper was declined as reinvention.

#### APP-10 · What the wipe and hidden previews leave behind

Info · Fixed in part. The wipe sheet says gallery saves stay, and ARCHITECTURE section 8 lists iOS Wi-Fi Aware pairings and gallery saves as out of the wipe's reach. Hiding private room names under hidden previews was left (D13).

#### APP-11 to APP-37 (later rounds)

| ID     | What was wrong                                                                                                                                                                   | Fix                                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| APP-11 | A DM photo or voice note went out as signed cleartext to a peer with no session yet, or one that had not proven it reads sealed files, under a thread that says it is encrypted  | A DM attachment goes only sealed: with no session the handshake starts and the send waits; a peer that cannot read sealed media is told so. Cleartext is still received |
| APP-12 | A JPEG or WebP the encoder could not open went out as the original, EXIF included; every resize rung was adopted into the cache                                                  | Only GIF and PNG may go unencoded; anything else is refused; only the sent render is kept                                                                               |
| APP-13 | Every mesh start set presence to Online, so Invisible was lost after any process death or boot start, with nothing to prompt the user                                            | Invisible persists and applies on the same tick as the mesh start; the wipe resets it, Reset settings keeps it, a transfer carries it                                   |
| APP-14 | A refused in-session wipe told the person to wipe again from Welcome, which has no wipe control                                                                                  | The alert says to unlock and reopen Airhop, as the banner does                                                                                                          |
| APP-15 | The new-phone side of a transfer failed on a condemned identity; Cancel while connecting left a listener                                                                         | A condemned identity counts as absent, the install deletes leftover prekeys, and cancel tears down cleanly                                                              |
| APP-16 | The safety-word grid mirrored under right-to-left, so two phones showed the same words in different orders                                                                       | The grid is pinned left to right; the words are Latin and never translated                                                                                              |
| APP-17 | Dismissing a caution sheet any way but Cancel left the picker copy; a cancelled recording stayed                                                                                 | Adopted before the caution, deleted on cancel                                                                                                                           |
| APP-18 | A moved file kept its source's time, so an iOS document could expire on send; Clear and Storage missed the iOS tmp copies                                                        | Retention reads the adoption time from the name; Clear and Storage cover tmp and Inbox                                                                                  |
| APP-19 | A receive card's X called cancel, which acts only on sends; the card title was concatenated in JSX                                                                               | X hides a receive card; titles come from one key per shape                                                                                                              |
| APP-20 | A private-channel message that reached nobody showed "Waiting to send", though nothing would ever send it                                                                        | It fails with Retry, as a location-channel message does                                                                                                                 |
| APP-21 | A refused contact card always showed the tampered-card copy, which a key conflict cannot fix                                                                                     | The refusal says which check failed; a conflict says only an in-person scan replaces the key                                                                            |
| APP-22 | Reset settings and the wipe changed the language without re-pinning the layout direction, so a direction change took two reopens; the notice called every language right to left | The i18n module pins direction for every writer; the notice is neutral                                                                                                  |
| APP-23 | A DM read after its sender left had no route for its read receipt; the outbox's per-recipient cap evicted the oldest DM silently                                                 | The receipt goes over Nostr, as bitchat-ios routes it; couriered mail owes one too; evicted bubbles say failed                                                          |
| APP-24 | A channel or group message queued at an app kill kept its hourglass with no Retry                                                                                                | The launch sweep fails every queued row outside a DM                                                                                                                    |
| APP-25 | Private photos and voice notes were keyed by a random ID, so bitchat-ios's DELIVERED matched nothing and Airhop never sent one                                                   | `privateMediaStableID` derives bitchat-ios's identity byte for byte (checked against its golden vector) and is acknowledged both ways                                   |
| APP-26 | The orphan sweep used "older than 60 s" as a stand-in for "left by a dead process"                                                                                               | A once-per-runtime flag settles every orphan on the first mount                                                                                                         |
| APP-27 | A retried photo's caption was not re-sent to a bitchat peer, which has no caption field                                                                                          | The retry sends the caption as a DM, as a first send does                                                                                                               |
| APP-28 | A voice note and a live burst played over each other                                                                                                                             | The note pauses when someone starts talking, as bitchat-ios does                                                                                                        |
| APP-29 | The launch decision lived in a render effect with no test                                                                                                                        | A pure `planLaunch`, checked by scenarios K05 and K07 to K09                                                                                                            |
| APP-30 | After They match the new phone showed "Receiving 0%" with nothing saying the next step was on the old phone                                                                      | An awaiting phase: "Tap Transfer on your old phone"                                                                                                                     |
| APP-31 | The missing-attachment note repeated its title and named one cause; the privacy policy sent people to the wrong screen for retention; docs called send budgets receive caps      | The note names retention, the storage cap, Clear and a transfer; the policy points at General                                                                           |
| APP-32 | A location thread looked up place names by bare geohash and never found one                                                                                                      | Reads through `placeNameKey` and retries when the network gate opens                                                                                                    |
| APP-33 | The Version credit line joined catalog fragments with a hardcoded "by"; `settings.wipe.got_it` was unreferenced                                                                  | One key with rich-text nodes; the dead key removed                                                                                                                      |
| APP-34 | The Help sheet said an offline token stays unconfirmed "until you refresh"                                                                                                       | It says the token is confirmed automatically once online                                                                                                                |
| APP-35 | The Profile hub's buttons showed no press state; on the wipe row that invited extra taps                                                                                         | The shared pressed treatment per surface                                                                                                                                |
| APP-36 | The Tor timeout copy said "longer than a minute" for 60, 120 or 180 s deadlines                                                                                                  | The duration is dropped                                                                                                                                                 |
| APP-37 | A refused DM attachment used the channel-only notice, which a DM never renders                                                                                                   | The DM says whether it lacks a link or is setting up encryption                                                                                                         |

### 4.7 Supply chain, release, tooling and docs

#### SUP-1 · Release jobs checked out a same-named branch instead of the tag

High · Fixed. `actions/checkout` prefers a branch over a tag for a bare name, and the working branch is named `v1.0.9`, so the release would have built, signed and attested the branch tip labelled 1.0.8. Every job checks out the tag's commit SHA and asserts it; the tag is pushed as `refs/tags/…`; `release.sh` no longer needs the same-named branch deleted first. `[skip ci]` is gone from the release commit, so the tag push starts the release (D14).

#### SUP-2 · Release APK silently fell back to the public debug key

Medium · Fixed. An empty signing secret fails the job; the signed APK must have exactly one signer with the pinned certificate SHA-256 (`60d09487087c3ea4c3fbb325aebd354be629be99092020dc48b578065c18a949`), and the AAB the same. Local release builds keep the debug fallback.

#### SUP-3 · Signing key beside npm and Gradle; persisted tokens; unpinned CocoaPods

Medium · Fixed (D15). Android builds unsigned with no secrets; a separate job that checks out nothing signs with the preinstalled build tools. Checkouts do not persist tokens. CocoaPods is pinned in `Gemfile.lock` with every gem's SHA-256. Release jobs use no caches.

#### SUP-4 · Tor transports and toolchain

Medium · Fixed. IPtProxy 5.5.1 carried Snowflake's pion/stun, pion/dtls and x/text versions with Go panic advisories that a malicious Snowflake proxy could reach, and a Go panic ends the whole process, mesh included. The build raises them within the same major version with plain `go get` (stun 3.1.7, dtls 3.1.9, x/text 0.42.0; D16), recorded as `IPTPROXY_GO_RAISES` in `native/arti/TOOLCHAIN.env`; govulncheck went from three reachable to none. Rust 1.98.1 (a vtable miscompilation fix) and rustls 0.23.45. The binaries are rebuilt ([`2bf32ae`](https://github.com/areebahmeddd/airhop/commit/2bf32ae)). Moving to pion/stun v4 is impossible without Snowflake changing its import paths, and a `replace` is ruled out.

#### SUP-5 · Signing secrets repo-wide; no release Environment gate

Medium · Owner. A `release` Environment with a `v*.*.*` tag rule, a tag ruleset and "Automatically delete head branches" are repository settings the repo cannot apply; the owner has not applied them and treats them as optional. SUP-2, SUP-3 and SUP-1 close the defects that do not depend on them. Immutable releases would need a draft-then-publish restructure and are left for later.

#### SUP-6 · Sideloaded APKs unverifiable; verify command too loose

Low · Fixed. README, SECURITY.md and the landing FAQ publish the certificate digest and a strict `gh attestation verify` (signer workflow, tag source ref, no self-hosted runners). An in-app signer display was dropped: a tampered APK can display any digest.

#### SUP-7 · verify-vendored tied binaries to a lock, not the build

Low · Fixed. The lock must equal the union of the build scripts' `SHA256SUMS`, stray binaries outside the vendored paths are refused, and the docs no longer claim a tie to source; reproducing the build is the only source binding.

#### SUP-8 · Expression injection in the release tag resolver

Low · Fixed. No tag input; the ref reaches `run:` only through `env:`, and only a tag is accepted.

#### SUP-9 · `knip` fetched unpinned at run time

Low · Fixed. A locked devDependency.

#### SUP-10 · Gradle distribution unchecked; JitPack consulted for everything

Low · Fixed. `distributionSha256Sum` set; JitPack removed, since nothing resolves there. `verification-metadata.xml` was declined as trust-on-first-use upkeep for a solo maintainer.

#### SUP-11 and R-11 · Automation pushed to the triggering branch

Low · Fixed. Native rebuilds and lock syncs refuse `main` and tags, and the native rebuild re-runs CI on the branch it pushed to.

#### SUP-12 · Bridge sync validated only leading tokens

Low · Fixed. A line must be one line of printable ASCII, or the sync fails.

#### SUP-13 · Dependabot's rubyzip bump (PR #75)

Low · Fixed on this branch: fastlane 2.240.1, the first to allow rubyzip 3, with rubyzip 3.7.0 and recorded checksums. PR #75 is closed.

#### SUP-14 · Landing site

Low · Fixed in part. The version is stamped at build time, so no visitor's browser calls GitHub, and `connect-src` is `'self'`; `static-html.ts` uses function replacements; `landing/Dockerfile`, which served without security headers, is deleted (D18). DNSSEC, CAA, NEL and Bot Fight Mode are dashboard items left to the owner. HSTS preload is an organisation-wide decision, not taken.

#### SUP-15 · Stale docs, comments and scenario IDs

Info · Fixed. Stale lines on LAN, sync TTL, the REQUEST_SYNC relay, prekey flooding, the held Tor state, the move connection and media ([`ee0defe`](https://github.com/areebahmeddd/airhop/commit/ee0defe), [`1882500`](https://github.com/areebahmeddd/airhop/commit/1882500), [`aa2a77d`](https://github.com/areebahmeddd/airhop/commit/aa2a77d), [`f551afb`](https://github.com/areebahmeddd/airhop/commit/f551afb), [`a6dd8c3`](https://github.com/areebahmeddd/airhop/commit/a6dd8c3), [`7a003b4`](https://github.com/areebahmeddd/airhop/commit/7a003b4), [`75536cc`](https://github.com/areebahmeddd/airhop/commit/75536cc)); a reused lifecycle scenario ID, renumbered S34 ([`a9c6076`](https://github.com/areebahmeddd/airhop/commit/a9c6076)); an unquoted sync window ([`a75bdd2`](https://github.com/areebahmeddd/airhop/commit/a75bdd2)). The comment pass [`4011635`](https://github.com/areebahmeddd/airhop/commit/4011635) to [`469ef37`](https://github.com/areebahmeddd/airhop/commit/469ef37) restates history comments as rules across the tree.

**Checked and sound.** No `pull_request_target` or `workflow_run`. Top-level `contents: read` everywhere, writes granted per job. Every third-party action pinned to a full SHA. `npm ci`, Gradle lock files, `cargo --locked` and `GOTOOLCHAIN=local`. The native build container pinned by digest, archives verified by hash, `SOURCE_DATE_EPOCH` fixed. SLSA provenance on the APK, AAB and IPA, verifiable with `gh attestation verify`. The Gradle wrapper jar validated.

## 5. Owner decisions

| #   | Finding      | Decision                                                                                                                                                                                                                                                                                     |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | CRY-2        | Open-direction seal vectors from Python `noiseprotocol`; bitchat-ios XCTest vectors optional                                                                                                                                                                                                 |
| D2  | CRY-3        | No persisted stranger pins, no eviction side map; trust order session proof, verified contact, unverified contact, announce                                                                                                                                                                  |
| D3  | CRY-5        | Global handshake bucket on inbound msg1 only; per-peer limits as bitchat-ios                                                                                                                                                                                                                 |
| D4  | MESH-4       | Cause-neutral wording for the missing-attachment note                                                                                                                                                                                                                                        |
| D5  | MESH-5       | Per-kind sync rounds, as bitchat-ios (done)                                                                                                                                                                                                                                                  |
| D6  | MESH-7       | Origin TTL from `[ceiling-2, ceiling]` at this phone's degree                                                                                                                                                                                                                                |
| D7  | PAY-14(c)    | Owner check before showing the phrase: first skipped, then requested and done                                                                                                                                                                                                                |
| D8  | NET-2        | Gate only; no bookmark-only persistence                                                                                                                                                                                                                                                      |
| D9  | NET-6        | No SOCKS credentials, no ephemeral port; hold and route-after-bind, destination isolation                                                                                                                                                                                                    |
| D10 | NET-11       | Fail closed after a crash during Tor start                                                                                                                                                                                                                                                   |
| D11 | NAT-5        | No opt-in "hide in recents"                                                                                                                                                                                                                                                                  |
| D12 | APP-8        | `stripInvisibles` only; no `#last4` suffix                                                                                                                                                                                                                                                   |
| D13 | APP-10       | Hidden previews keep showing room names                                                                                                                                                                                                                                                      |
| D14 | SUP-1, SUP-8 | Drop `[skip ci]` so the tag push releases by itself                                                                                                                                                                                                                                          |
| D15 | SUP-3        | Split Android build from signing                                                                                                                                                                                                                                                             |
| D16 | SUP-4        | Same-major `go get` raises of pion/stun, pion/dtls and x/text until upstream tags                                                                                                                                                                                                            |
| D17 | SUP-5        | No required reviewer on the Environment                                                                                                                                                                                                                                                      |
| D18 | SUP-14       | Delete `landing/Dockerfile`                                                                                                                                                                                                                                                                  |
| D19 | Share texts  | `chat.thread.invite_body` and `settings.qr.share_body` keep their em dash. [`df8aeac`](https://github.com/areebahmeddd/airhop/commit/df8aeac) removed it; the owner restored it in all 35 catalogs (uncommitted in the working tree). A deliberate exception to the copy rule, not a finding |

Standing decisions: the gitignored release keystore stays where it is; `"private": true` is not added to `package.json`; bridge-list freshness and the `sync-bridges.yml` push permission are the owner's; dependency upgrades are done by hand, not by Dependabot.

## 6. Limitations and accepted risks

| Item                                  | Behaviour                                                                                                                                                                                                                                                                                                                                   | Why it is accepted                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Ratchet desync past `MAX_SKIP`        | More than 1,000 lost DR messages in one chain leave a pair out of step until a restart or a LEAVE                                                                                                                                                                                                                                           | A replay raises the same error, so healing on it would bring back CRY-14's teardown. bitchat-ios makes the same trade |
| No courier handover link binding      | bitchat-ios hands over only on a link whose Noise session was made on that link; Airhop does not record which link a session came from                                                                                                                                                                                                      | Written into PROTOCOLS section 6 as a known difference                                                                |
| #bluetooth retry duplicate            | A public #bluetooth message retried after an app kill can show twice to a neighbour who had the first copy                                                                                                                                                                                                                                  | Those packets carry no message ID, and resending under the old timestamp would fail freshness                         |
| Bridged downlink already spent        | A downlink broadcast spent on a bridge-first copy is not recalled when the radio copy wins the row                                                                                                                                                                                                                                          | It would need a delayed queue nothing else needs                                                                      |
| Forged msg1 displacement (R-10)       | A handshake in progress can be displaced by a forged msg1                                                                                                                                                                                                                                                                                   | bitchat-ios behaves the same, and the DM recovers (C13b)                                                              |
| Stranger pins not persisted           | After a restart or an eviction flood, a stranger's pin is first-come again                                                                                                                                                                                                                                                                  | D2; contacts are protected through the durable tier                                                                   |
| Private-channel attribution on Nostr  | Every member signs with the shared key, so a member can claim another's ID; it renders as unverified                                                                                                                                                                                                                                        | The room key is the membership credential (CRY-8)                                                                     |
| Exact-copy credit (NET-9)             | Someone who copies a location message's text exactly and reaches a recipient first takes credit for the same words                                                                                                                                                                                                                          | Nothing false is shown; binding the sender would link the per-cell key to the peer ID                                 |
| Gateway any-cell deposits (NET-15)    | A gateway publishes a consistent deposit for any cell                                                                                                                                                                                                                                                                                       | Teleported and region channels need it; bitchat-ios restricts no cell                                                 |
| Group invites (MESH-14)               | Anyone who completes a handshake can add us to any number of groups                                                                                                                                                                                                                                                                         | Matches bitchat-ios; blocking the creator stops it                                                                    |
| Recents snapshot (NAT-5)              | Android 8 to 12L keep a screenshot of the last screen in the app switcher                                                                                                                                                                                                                                                                   | No reliable dynamic fix exists; documented in ARCHITECTURE section 9                                                  |
| Write-only centrals (NAT-4)           | A central that writes without subscribing keeps one entry until Bluetooth power-cycles                                                                                                                                                                                                                                                      | Matches bitchat-ios; Airhop and bitchat centrals always subscribe                                                     |
| DNS for `HttpURLConnection` (R-13)    | Not verified to resolve at the exit                                                                                                                                                                                                                                                                                                         | No current remote URL uses it; no doc claims it; a device check is listed                                             |
| Fixed SOCKS port 39050                | Any local app can probe the port to learn Airhop's Tor is on, or use it                                                                                                                                                                                                                                                                     | D9; shared with bitchat-ios. The squat-and-leak case is closed by the hold                                            |
| Out of the wipe's reach               | iOS Wi-Fi Aware pairings (no unpairing API) and photos saved to the gallery                                                                                                                                                                                                                                                                 | Outside the app; the wipe sheet says so                                                                               |
| Location inside sent files            | A video, a document, and a GIF or PNG that fits are sent byte for byte                                                                                                                                                                                                                                                                      | Stripping video atoms needs new native code on both platforms; documented in ARCHITECTURE section 9                   |
| Hidden previews show room names (D13) | Private room and group names stay visible in notifications with previews hidden                                                                                                                                                                                                                                                             | Low value against the loss of context                                                                                 |
| bitchat-android deviations            | Its 256-fragment cap and its sync replies without `IS_RSR` are refused or undersized                                                                                                                                                                                                                                                        | bitchat-android is never accommodated; bitchat-ios behaves the same                                                   |
| iOS wallet with Tor on                | Mint calls and the update check refuse while Tor is on                                                                                                                                                                                                                                                                                      | Arti wraps only WebSockets on iOS                                                                                     |
| Reset settings keeps Invisible        | Status is set in the presence picker, not among the preferences Reset lists                                                                                                                                                                                                                                                                 | By design                                                                                                             |
| Housekeeping left as is               | Scenario IDs S11 and S14 each name two lifecycle tests; `OpenedGiftWraps` and `rememberEventID` keep their own sets; a location note's `n` tag is not normalised, so it keeps matching the mesh copy; the wallet's AppState retry is device-checked only; ru, uk and my carry em dashes in older strings (grammar in Russian and Ukrainian) | Each is pre-existing and harmless, or would change behaviour for no user-visible gain                                 |

## 7. Blockers and dependencies

| Item                    | Waits on                                                                                                  | State (checked 2026-09-27)                               | Then                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| APP-9 and PAY-14(b)     | Expo SDK 58 (`expo-clipboard` 58 adds `android.isSensitive`)                                              | `latest` 57.0.25; `next` 58.0.0-preview.7                | Pass `{ android: { isSensitive: true } }` on the phrase and token copies with the SDK bump        |
| NET-4 local measure     | nbd-wtf/nostr-tools#560                                                                                   | Open, unmerged; latest release 2.25.2                    | Upgrade and collapse back to one `subscribeMany`; keep the post-verify set only if #560 lacks one |
| SUP-4 interim raise     | An IPtProxy tag above 5.5.1 and a Snowflake tag above v2.14.1 carrying the fixed pion and x/text versions | IPtProxy 5.5.1 and Snowflake v2.14.1 are the latest tags | Delete `IPTPROXY_GO_RAISES` from `TOOLCHAIN.env` and rebuild                                      |
| CRY-2 reference vectors | A macOS machine to run bitchat-ios's XCTest                                                               | Optional; Python `noiseprotocol` vectors are committed   | Commit seal vectors produced by bitchat-ios                                                       |
| Swift changes           | CI's iOS build (Swift is not compiled on the development machine)                                         | Required before merge                                    | Section 9                                                                                         |

## 8. bitchat-ios upstream findings

Gaps found in bitchat-ios while using it as the reference. None is accommodated; where Airhop differs, the difference is local and does not affect the wire.

| Gap in bitchat-ios                                                                                                                                                       | What Airhop does                                                       | Priority |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | -------- |
| The Noise replay window shifts bits the wrong way (after nonces 0..100, 93..99 are accepted again). Also in bitchat-android                                              | Fixed receive-side (CRY-4); safe for either app to ship alone          | High     |
| The `IS_RSR` exemption is type-agnostic, so an old signed LEAVE can come back as a sync reply                                                                            | Replies admitted only for types sync serves, within their age (MESH-3) | Low      |
| No future bound on a prekey bundle's `generatedAt`; a far-future bundle blocks every later one                                                                           | Refused past the 15 min announce skew (R-2)                            | Low      |
| `BLEFragmentHandler` validates a reassembled `IS_RSR` packet against its author, not the link peer, so fragmented third-party sync replies are refused, its own included | Validates against the link peer                                        | Low      |
| The 30 s reassembly timeout counts from the first fragment and cannot complete a 1 MiB file at 30 ms spacing (about 67 s)                                                | An idle timeout                                                        | Low      |
| Courier seals have only round-trip tests, no vector                                                                                                                      | Open-direction vectors committed (CRY-2)                               | Low      |
| `/pay` reports "sent" for a Cashu token over the 255-byte private-message cap, which no Noise, Nostr or courier path can carry                                           | Says which route can carry it (PAY-28)                                 | Low      |
| `sendNoisePayload` treats a kept session as a route after the link drops, so a group state sent just after a peer walks away is dropped with no retry                    | Queued and flushed on the next announce (MESH-21)                      | Low      |
| The geocoder is not gated on Tor                                                                                                                                         | Gated (NET-2)                                                          | Info     |
| The relay URL check accepts hex and octal IPv4                                                                                                                           | Refused (NET-13)                                                       | Info     |

For the record only, bitchat-android: the 256-fragment cap (permissionlesstech/bitchat-android#940) and sync replies without `IS_RSR`, both refused by bitchat-ios as well.

**Drafted, not filed.** Every item above except the geocoder note, to permissionlesstech/bitchat, with CRY-4 also to bitchat-android as a courtesy. Also drafted: a comment on nbd-wtf/nostr-tools#560 with Airhop's reproduction (not a duplicate issue); an issue on tladesignz/IPtProxy asking for 5.5.2 with the raised pion and x/text minimums and the govulncheck output; a request on the Snowflake GitLab for a v2.14.2 tag from `main`, which already carries the fixes.

## 9. Owner actions

### Device checks

**Tor and network**

- Android with Tor on, with each of Direct, Snowflake and obfs4: bootstrap reaches a circuit; LAN and Wi-Fi Aware link up and carry a photo, and a phone transfer completes (plain sockets stay direct); the APK update download goes through Tor; a held route fails fast instead of hanging.
- iOS with Tor on: a start shows "starting", not "could not connect"; a Snowflake bootstrap slower than 75 s still opens the relays.
- Crash during Tor start: kill the app mid-start and relaunch. Tor stays on, the internet stays paused, the Mesh banner opens the Tor screen, and Try again recovers.
- A refused bridge change and a refused Try again both leave Tor on and held.
- R-13: with Tor on, check whether an `HttpURLConnection` request resolves DNS at the exit.

**Transports**

- Wi-Fi Aware on the Samsung testers (S21, S22+, S25 Ultra): links come up as before. Watch Diagnostics for "Refused inbound on", "Inbound interface unknown, accepting" and "unsolicited hello".
- iOS LAN: two iPhones on one Wi-Fi link; two on different networks no longer see each other (AWDL off); a transfer over Personal Hotspot works.

**Identity, launch and transfer**

- Transfer: both phones show the same six words, in the same order on a right-to-left phone; it works over each phone's hotspot and over USB tethering; a code carrying a non-local address fails with "same Wi-Fi".
- iOS launch before first unlock (R-8): a background relaunch shows the keys screen, the app boots normally once unlocked, and the Wallet tab opens without a force-quit.

**Messaging and courier**

- A DM written to an absent contact with nobody near is taken by the next phone that walks up and delivered.
- A DM photo to a peer with no session starts the handshake and goes sealed.

**Live voice**

- On both platforms the last word of a live burst is heard, and two people talking back to back both come through.
- A playing voice note pauses when someone starts talking.

**Wallet**

- A token received with Wi-Fi off confirms on its own after reconnecting, including by turning the internet switch back on.
- A refused receipt's Copy button works, in both themes and right to left.
- A "Locked" label shows for a token locked to someone else.
- A nutzap to an NDK-based wallet locks rather than falling back to a token.

**bitchat-ios interop**

- DMs, courier mail (both prologues) and sync in both directions, board posts included.
- `#city` presence counted on both phones.
- A three-hop chain and a dense room of six or more phones carrying text, live voice and a photo.
- A private photo and a voice note reach delivered in both directions.

### Later

- APP-9 with the Expo SDK 58 bump.
- Collapse the per-relay Nostr subscriptions once a nostr-tools release carries #560.
- Drop the IPtProxy Go raises once IPtProxy and Snowflake tag.
- SUP-14 dashboard items: DNSSEC (Cloudflare, then the DS record at Namecheap), a CAA record, NEL off, Bot Fight Mode off. HSTS preload only as an organisation-wide decision.
- Immutable releases (needs draft-then-publish), and a strict landing `style-src` alongside other landing work.
- bitchat-ios's 30-day rotation of unconsumed prekeys.
- The next Arti release, in a later cycle.
- File the upstream notes in section 8.
