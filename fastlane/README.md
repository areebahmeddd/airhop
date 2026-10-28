# Store metadata and release

Store listings for Google Play, the App Store and Zapstore, plus the fastlane lanes that ship the iOS build. Keeping the copy in the repository makes it reviewable and keeps the listings in sync.

## Layout

```text
fastlane/
├── Appfile                  # bundle identifier
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

`scripts/release.sh X.Y.Z` stamps the app and the widget extension with `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` before it commits and tags, so the tag already carries both. Pushing the tag `vX.Y.Z` runs `ios-release` in `.github/workflows/release.yml` on a macOS runner:

1. Check every signing secret is set, so a missing one fails with its name rather than deep inside fastlane.
2. Decode the distribution certificate and the two App Store profiles, the app's and the widget extension's, from secrets.
3. `fastlane ios beta`: import them into a temporary keychain, sign both targets for `APPLE_TEAM_ID`, archive, upload to TestFlight.
4. Attest the IPA and keep it as a workflow artifact for 90 days.
5. `fastlane ios metadata`: create or update the App Store version, listing and screenshots.

Submitting for review is done by hand in App Store Connect.

### Secrets

| Secret                                   | Holds                                               |
| ---------------------------------------- | --------------------------------------------------- |
| `APPLE_TEAM_ID`                          | the 10-character team ID, under Membership details  |
| `APP_STORE_CONNECT_KEY_ID`               | API key ID                                          |
| `APP_STORE_CONNECT_ISSUER_ID`            | API key issuer                                      |
| `APP_STORE_CONNECT_KEY_P8`               | base64 of the `.p8`                                 |
| `IOS_CERTIFICATE_BASE64`                 | base64 of the Apple Distribution `.p12`             |
| `IOS_CERTIFICATE_PASSWORD`               | password set when the `.p12` was exported           |
| `IOS_PROVISIONING_PROFILE_BASE64`        | base64 of the app's App Store `.mobileprovision`    |
| `IOS_WIDGET_PROVISIONING_PROFILE_BASE64` | base64 of the widget's App Store `.mobileprovision` |

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

The export password becomes `IOS_CERTIFICATE_PASSWORD`.

The app embeds a widget extension, and the two share an App Group, which is where the app leaves the mesh snapshot the widget draws. Each needs its own App ID and profile:

1. Under Identifiers, App Groups, register `group.org.onemindlabs.airhop`.
2. On the App ID `org.onemindlabs.airhop`, enable App Groups and select that group, beside the capabilities it already has.
3. Register the App ID `org.onemindlabs.airhop.widget`, with App Groups enabled and the same group selected. It needs nothing else.
4. Under Profiles, create an App Store Connect profile for each App ID with the distribution certificate, and download both. The app's profile has to be made after step 2, so it carries the group.

base64 the certificate and both profiles into the secrets:

```bash
base64 -w0 airhop-distribution.p12
base64 -w0 airhop.mobileprovision
base64 -w0 airhop-widget.mobileprovision
```

All three expire; the portal shows the dates. Regenerate a profile whenever a capability is added to its App ID, since the profile pins the entitlement set. The group ID is also written in `ios/Airhop/Airhop.entitlements`, `ios/AirhopWidget/AirhopWidget.entitlements` and `MeshWidgetState.swift`; all four must agree, or the widget reads an empty store and shows "Open Airhop".

## Adding a language

Copy `en-US` under `android/` or `ios/` to the new locale and translate each file. Play and App Store locale codes differ; check each console.

These files are store copy only. In-app strings live under `src/i18n/`.
