# Launch film

A three-minute narrated launch film, built as a [HyperFrames](https://hyperframes.heygen.com) composition: an HTML page with one paused GSAP timeline, which HyperFrames seeks frame by frame and encodes. The stage is 1920x1080 and renders at 4K by raising the device scale, so nothing is upscaled.

## Layout

```text
film/
├── script.mjs               # the narration, one entry per spoken clip
├── plan.mjs                 # the edit: when everything happens
├── src/
│   ├── stage.mjs            # everything on stage as markup, and the on-screen words
│   ├── screens.mjs          # screens only the film shows; the rest come from ../lib/
│   ├── stage.css            # stage styles, on the tokens in ../lib/theme.mjs
│   ├── timeline.js          # the motion: one GSAP timeline, placed at the plan's moments
│   └── world.js             # the canvas: globe, street, the mesh folding into the mark
├── scripts/
│   ├── narrate.mjs          # speaks the script with Kokoro and measures each clip
│   ├── score.mjs            # writes the music and the effects stem
│   ├── build.mjs            # assembles index.html and runs the voiceover carve
│   ├── render.mjs           # builds, renders, and brings the mix up to delivery level
│   ├── hyperframes.mjs      # runs any HyperFrames command at the pinned version
│   └── tools.mjs            # paths and tool wrappers the other scripts share
├── assets/                  # generated: narration, music, effects
├── renders/                 # generated: airhop-launch.mp4
└── index.html               # generated, with data.js and vendor/
```

`script.mjs` and `plan.mjs` are the two files an edit usually touches. Nothing generated is committed.

## Setup

```bash
cd press/film
npm install
npx skills experimental_install   # the HyperFrames agent skills, from skills-lock.json
```

HyperFrames needs these on `PATH`, or under `.tools/` in this folder, which the scripts look in first:

| Needs                     | For               | Get it                                                           |
| ------------------------- | ----------------- | ---------------------------------------------------------------- |
| FFmpeg and FFprobe, 7.x+  | encoding, probing | `winget install --id Gyan.FFmpeg -e`, or `.tools/ffmpeg/bin/`    |
| Python with `kokoro-onnx` | the narration     | `pip install kokoro-onnx soundfile`, or a venv at `.tools/venv/` |
| Chrome                    | rendering         | found automatically                                              |

`node scripts/hyperframes.mjs doctor` reports what is missing. `landing/node_modules` must be installed too: the globe reads `d3-geo` and `world-atlas` from there.

The interface sounds are the library bundled with the HyperFrames `media-use` skill (Pixabay licence):

```bash
npx skills add heygen-com/hyperframes -s media-use -a claude-code -y --copy
mkdir -p assets/sfx && cp .claude/skills/media-use/audio/assets/sfx/* assets/sfx/
```

## Usage

```bash
npm run narrate   # assets/vo/*.wav, only the lines whose text changed
npm run score     # assets/music.wav and assets/sfx.wav
npm run check     # build index.html, then lint, layout, motion and contrast
npm run preview   # watch it in HyperFrames Studio, with sound
npm run render    # renders/airhop-launch.mp4, 3840x2160 at 60 fps
```

Run them in that order after a script change: the narration sets the timing, the score follows the timing, the build reads both.

- A 4K render takes about half an hour and needs roughly 50 GB of temporary disk. `npm run render -- --1080` is faster and lighter.
- `node scripts/hyperframes.mjs snapshot --at 31,104.5` captures single frames.
- VS Code's video preview has no AAC decoder, so the render opens there silent. Play it in a media player or a browser.

## How it works

- **The narration leads.** `plan.mjs` starts each line on the next quarter beat after the one before it, and a scene is as long as its lines need. Rewrite a line and the cut re-times itself; `timeline.js` holds no number of seconds.
- **The tempo is 100 BPM.** A beat is then exactly 36 frames at 60 fps, and a quarter beat is 9. A scene that changes the music starts on a bar line.
- **A frame is a pure function of its time.** No clocks, no unseeded randomness, no CSS animation. Typing, counters and the sonar are functions of `t`, run from the timeline's `onUpdate`.
- **HyperFrames mixes the sound.** Music, effects and each narration line are separate `<audio>` clips. The build runs the voiceover carve, which makes room in the music for the speech, and `render.mjs` lifts the result from about -19 LUFS to about -15 under a limiter.

## Story

Monochrome, as the brand is. Colour appears only where the app gives it a meaning: green for end-to-end encrypted, red for danger and live audio, purple for Tor.

| Scene    | What the viewer should come away with                                                         |
| -------- | --------------------------------------------------------------------------------------------- |
| Earth    | One light, then all of them. Then one street, and the route a message takes through towers    |
| Lost     | The route dies. A natural disaster, a festival, a trail, a shutdown. The music stops with it  |
| The idea | They are still ten metres apart. One phone rings out, the other answers, strangers join       |
| The mark | The 22 phones of the mesh are the 22 pixels of the bird. The beat drops here                  |
| Mesh     | The radar finds four peers with no signal and no Wi-Fi                                        |
| Hops     | What a relaying phone holds: a recipient ID and bytes it cannot open. Then the courier        |
| The turn | "Pretty cool? That's not all." The beat drops out for it                                      |
| Identity | Four lines of key generation where a sign-up form would be. Account required: None            |
| Nostr    | Out of range: 300+ independent relays, gift-wrapped, optionally through Tor                   |
| And more | Rooms, live voice, notices, the gateway, the bridge, 35 languages. One card per line          |
| Wallet   | Half-time. 500 sats cross between two phones with no network on either. Then what Cashu is    |
| bitchat  | Same protocol, so the two talk. Then what Airhop adds                                         |
| Crypto   | Noise from WireGuard, the Double Ratchet from Signal, The Onion Router from the Tor Project   |
| Nothing  | No servers, no accounts, no tracking. Nothing to hand over                                    |
| Leaving  | The real settings list, scrolled to its end: transfer to a new phone, then the three-tap wipe |
| Not done | What is coming soon, ending on the two independent audits                                     |
| End      | White. The bird crosses, comes at the lens, and its black is the ground the mark sits on      |

## Accuracy

Nothing in the film invents a control the app does not have. Strings inside a phone are from `src/i18n/locales/en.ts`.

- The thread header has no padlock and bubbles have no hop count, because the app has neither. Hops are a diagram.
- A relay is shown holding the recipient ID in the clear above the ciphertext. Packet headers are readable; only the content is sealed.
- The wallet balance never counts up, and an offline claim does not raise it. It reads `500 sat not yet confirmed with the mint` until the phone is back online, and only then does the phone buzz.
- "A new key for every message" is the Double Ratchet between two Airhop phones. A bitchat peer gets Noise alone.
- The gateway and the bridge carry public traffic only.
- webtunnel is listed with the bridges. Its row in `tor-screen.tsx` is present but not selectable yet.
- Offline AI, desktop, web and the social bridges appear only under "coming soon".
- Signal, WireGuard, Tor and bitchat are named in type. No other project's logo appears.
- The transfer code is a drawing of a QR code, not one that scans.

The attach sheet, the send-ecash sheet, the confirmation alert and the transfer screens are redrawn from source. Compare them with a build before publishing.

## Sound

- **Narration** is Kokoro-82M (Apache 2.0), voice `af_heart`, generated locally. `VOICE` and `SPEED` are in `script.mjs`. Each line's `say` is spelled for the ear ("Noster", "bit chat", "Cashoo"); `text` is what a viewer would read.
- **Music** is synthesized in `scripts/score.mjs`, so it carries no licence. To use another track, save it as `assets/music.wav` with its first downbeat at zero and rebuild.
- **Effects** are recorded, from the `media-use` library.

`plan.mjs` tells the music where to turn: silence when the network dies and in the turn, the drop at the mark, half-time for the wallet, a hard stop on the third tap.
