# Store metadata and release

Store listings for Google Play, the App Store and Zapstore, plus the fastlane lanes that ship the iOS build. Keeping the copy in the repository makes it reviewable and keeps the listings in sync.

## Layout

```text
fastlane/
├── Appfile                  # bundle identifier, team ID
├── Fastfile                 # ios beta (TestFlight), ios metadata (listing)
├── screenshots/en-US/       # App Store, 1290x2796, from press/
└── metadata/
    ├── android/en-US/       # Google Play, Zapstore
    │   ├── title.txt                    # 30 characters
    │   ├── short_description.txt        # 80 characters
    │   ├── full_description.txt         # 4000 characters, markdown
    │   ├── images/                      # icon.png, phoneScreenshots/
    │   └── changelogs/<versionCode>.txt # 500 characters, one per release
    └── ios/
        ├── copyright.txt
        ├── primary_category.txt
        └── en-US/
            ├── name.txt                 # 30 characters
            ├── subtitle.txt             # 30 characters
            ├── description.txt          # 4000 characters, plain text
            ├── keywords.txt             # 100 characters, comma separated
            ├── privacy_url.txt
            ├── support_url.txt
            └── marketing_url.txt
```

## Who reads what

- **Google Play** reads nothing from the repository. Copy `android/en-US` into the Play Console by hand.
- **Zapstore** reads `android/en-US` from GitHub on every publish.
- **App Store** is pushed by `fastlane ios metadata` after every TestFlight upload: `metadata/ios` plus `screenshots/`. What's New comes from `android/en-US/changelogs/<versionCode>.txt`, so one changelog file serves both stores.

Screenshots and the Android images are rendered by `press/`, not captured. After changing a panel there, run `node press/build.mjs --fastlane=./fastlane` to refresh both sets.

## Changelog files

Named by the Android `versionCode`, which is also the iOS build number:

```text
major * 10000 + minor * 100 + patch
```

| Version  | File        |
| -------- | ----------- |
| `v1.0.0` | `10000.txt` |
| `v1.2.3` | `10203.txt` |
| `v2.5.1` | `20501.txt` |

Add the file before tagging. Without it the release still builds and the App Store version is still created; What's New is left blank.

## iOS release

Tagging `vX.Y.Z` runs `ios-release` in `.github/workflows/release.yml` on a macOS runner:

1. Stamp `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` from the tag.
2. Decode the distribution certificate and App Store profile from secrets.
3. `fastlane ios beta`: import them into a temporary keychain, archive, upload to TestFlight.
4. Attest the IPA and keep it as a workflow artifact for 90 days.
5. `fastlane ios metadata`: create or update the App Store version, listing and screenshots.

Submitting for review is done by hand in App Store Connect.

### Secrets

| Secret                            | Holds                                      |
| --------------------------------- | ------------------------------------------ |
| `APP_STORE_CONNECT_KEY_ID`        | API key ID                                 |
| `APP_STORE_CONNECT_ISSUER_ID`     | API key issuer                             |
| `APP_STORE_CONNECT_KEY_P8`        | base64 of the `.p8`                        |
| `IOS_CERTIFICATE_BASE64`          | base64 of the Apple Distribution `.p12`    |
| `IOS_CERTIFICATE_PASSWORD`        | password set when the `.p12` was exported  |
| `IOS_PROVISIONING_PROFILE_BASE64` | base64 of the App Store `.mobileprovision` |

### Making the certificate and profile

Once, on any machine with `openssl`. Nothing here needs a Mac.

```bash
openssl req -new -newkey rsa:2048 -nodes -keyout distribution.key -out distribution.csr -subj "/CN=Airhop Distribution"
```

Upload `distribution.csr` at developer.apple.com, Certificates, Apple Distribution, and download `distribution.cer`. Then:

```bash
openssl x509 -in distribution.cer -inform DER -out distribution.pem
openssl pkcs12 -export -inkey distribution.key -in distribution.pem -out airhop-distribution.p12
```

The export password becomes `IOS_CERTIFICATE_PASSWORD`. Under Profiles, create an App Store Connect profile for `org.onemindlabs.airhop` with that certificate and download it. base64 both files into the secrets:

```bash
base64 -w0 airhop-distribution.p12
base64 -w0 airhop.mobileprovision
```

Both expire; the portal shows the dates. Regenerate the profile whenever a capability is added to the App ID, since the profile pins the entitlement set.

## Adding a language

Copy `en-US` under `android/` or `ios/` to the new locale and translate each file. Play and App Store locale codes differ; check each console.

These files are store copy only. In-app strings live under `src/i18n/`.
