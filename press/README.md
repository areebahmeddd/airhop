# Press

Everything Airhop shows the outside world: store screenshots, the feature graphic and icon, social banners, the launch film and its trailer. All of it is rendered from HTML, so it is rebuilt, not recaptured.

## Layout

```text
press/
├── build.mjs                # renders every image into out/
├── lib/                     # shared by the images and the film
│   ├── screens.mjs          # the app screens and their CSS
│   ├── copy.mjs             # panel headlines, subheads, order
│   ├── brand.mjs            # title card, glyph field, icon
│   ├── theme.mjs            # colour tokens, mirroring src/ui/theme.ts
│   ├── icons.mjs            # icon() and the pixel bird
│   ├── feather.mjs          # generated, do not hand-edit
│   ├── world.mjs            # generated, do not hand-edit
│   └── fonts.css            # JetBrains Mono, embedded
├── tools/
│   ├── generate-icons.mjs   # writes lib/feather.mjs from feather-icons
│   └── generate-world.mjs   # writes lib/world.mjs from the relay list
├── out/                     # the images, committed
└── film/                    # the launch film and trailer, with their own README
```

## Images

```bash
node press/build.mjs                       # everything, light and dark
node press/build.mjs --light               # light only
node press/build.mjs --only=social         # one group: screens | social | icon
node press/build.mjs --fastlane=./fastlane # also refresh the store sets in fastlane/
```

Each image is an HTML page screenshot by headless Chrome at 2x. The pages stay in `press/.build/` and open in a browser.

| #   | Screen                | Headline                          |
| --- | --------------------- | --------------------------------- |
| 01  | Mesh, radar           | Works when the network doesn't    |
| 02  | Direct message thread | Nobody in the middle can read it  |
| 03  | Chats, channels       | A room for wherever you are       |
| 04  | You                   | No sign up. No phone number.      |
| 05  | Wallet                | Send money with no signal         |
| 06  | Globe                 | Bluetooth ends. The mesh doesn't. |

Plus `00-brand`, a centred title card for social and press. The stores get the six panels.

```text
out/
├── screenshots/
│   ├── ios/{light,dark}/          # 1290x2796, App Store
│   └── android/{light,dark}/      # 1080x1920, Play and Zapstore
├── graphics/
│   ├── feature-graphic/{light,dark}/
│   │   ├── feature-graphic.png        # 1024x500, centred mark. Ship this one
│   │   └── feature-graphic-device.png # alternate, carries a device
│   └── icon-512.png               # Play and Zapstore
└── social/{light,dark}/
    ├── og-1200x630.png            # Open Graph, Twitter large card
    ├── x-header-1500x500.png
    ├── linkedin-banner-1584x396.png
    ├── instagram-square-1080x1080.png
    ├── instagram-story-1080x1920.png
    ├── github-social-1280x640.png
    └── youtube-thumbnail-1280x720.png
```

Apple scales the 6.9in size down to smaller iPhones, so one iOS set covers every device. `supportsTablet` is `false` in `app.json`, so there are no iPad sizes. Ship one theme: light is the default.

## Film

```bash
cd press/film
npm run render           # renders/airhop-launch.mp4, 4K at 60 fps
npm run render:trailer   # renders/airhop-trailer.mp4, the same
```

A three-minute narrated launch film and a thirty-second trailer, built with HyperFrames. Setup, the stories and how they are timed are in [film/README.md](film/README.md).

## Screens

The screens are redrawn in HTML, not captured from a device: a capture is about 450px wide against the 1290 the App Store wants. The images and the film both draw from [lib/screens.mjs](lib/screens.mjs), so a screen has one drawing. When a screen changes in the app, change it there, then rebuild.

- Every string is the app's own, from `src/i18n/locales/en.ts`. Nothing invents a control the app does not have.
- The wallet names `mint.minibits.cash`. Swap `MINT` for whichever mint you want shown.
- Panel 06 has no device. Each dot is a Nostr relay location from `landing/src/data/relays.ts`, and the arcs are a minimum spanning tree over great-circle distance.

## After a rebuild

The store sets and the landing site carry copies.

```bash
node press/build.mjs --fastlane=./fastlane

for theme in light dark; do
  for panel in 01-offline-mesh 02-encrypted 03-channels 04-no-accounts 05-payments; do
    cp press/out/screenshots/ios/$theme/$panel.png landing/public/screens/$panel-$theme.png
  done
done
cp press/out/social/light/og-1200x630.png landing/public/brand/airhop-og.png
cp press/out/graphics/icon-512.png landing/public/brand/airhop-mark-512.png
```

`--fastlane` writes the light sets, numbered from 1 in panel order, where Zapstore reads the Android one and `fastlane ios metadata` uploads the iOS one.

## Listing

The listing copy lives in [`fastlane/metadata/`](../fastlane/README.md), one file per field. Brand rules are at [airhop.1mindlabs.org/brand](https://airhop.1mindlabs.org/brand), with downloads in `landing/public/brand/`.

### App Store Connect

- [ ] Screenshots, name, subtitle, keywords and description are pushed by the release workflow. Promotional text is set by hand
- [ ] App Privacy: no data collected, no tracking
- [ ] Export compliance: non-exempt encryption, open source implementation, so the standard exemption applies
- [ ] Review notes: a Bluetooth mesh needs two physical devices. A reviewer on one sees an empty Mesh tab

### Play Console

- [ ] `out/screenshots/android/light/*`, `feature-graphic.png` and `icon-512.png`
- [ ] Title, short description, full description
- [ ] Data safety: no data collected, no data shared, encrypted in transit
- [ ] Declare nearby-devices and location, and why. Android requires location for Bluetooth scanning; it is not used to locate anyone

### Zapstore

- [ ] Nothing to upload: it reads `fastlane/metadata/android/en-US` from a tagged release

### Social

- [ ] `out/social/light/github-social-1280x640.png` into repo Settings, Social preview
- [ ] Profile headers on X and LinkedIn from `out/social/light/`
