# Security Policy

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately via [GitHub Security Advisory](https://github.com/areebahmeddd/airhop/security/advisories/new) (preferred, encrypted) or email [hi@areeb.dev](mailto:hi@areeb.dev).

## Verifying a Release

Android release APKs for `org.onemindlabs.airhop` are signed with one certificate, whose SHA-256 is:

```text
60:D0:94:87:08:7C:3E:A4:C3:FB:B3:25:AE:BD:35:4B:E6:29:BE:99:09:20:20:DC:48:B5:78:06:5C:18:A9:49
```

`apksigner verify --print-certs airhop.apk` must print exactly one signer with that digest, and `gh attestation verify` must pass with `--signer-workflow areebahmeddd/airhop/.github/workflows/release.yml --source-ref refs/tags/<tag> --deny-self-hosted-runners`. The [README](README.md#verifying-an-apk) has both commands in full. An APK that fails either is not ours: report where it came from, as below.

## What to Include

- A clear description of the vulnerability
- Steps to reproduce or a proof-of-concept
- The affected component (`src/core/crypto/`, BLE module, key storage, etc.)
- Potential impact (key extraction, packet forgery, session compromise, etc.)

## Response Timeline

| Stage               | Target                                    |
| ------------------- | ----------------------------------------- |
| Acknowledgement     | 48 hours                                  |
| Triage and severity | 5 business days                           |
| Critical fix        | 7 days                                    |
| High fix            | 14 days                                   |
| Public disclosure   | Coordinated with reporter after fix ships |

We will credit you in the advisory unless you prefer to stay anonymous.

## In Scope

- Cryptographic implementation (`@noble/curves`, `@noble/ciphers`, `@noble/hashes`)
- Noise XX handshake and session key derivation
- Packet signature verification bypass
- Private key extraction from storage
- BLE packet forgery or replay attacks
- Double Ratchet forward secrecy breaks
- Cashu token double-spend or redemption bypass
- Tor proxy bypass leaking real IP

## Out of Scope

- Social engineering or phishing
- Vulnerabilities in third-party relays or services we do not operate
- Denial-of-service against the BLE mesh (inherent to the open protocol)
- Issues requiring physical access to an unlocked device
- Theoretical attacks without a proof-of-concept
