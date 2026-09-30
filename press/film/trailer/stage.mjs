// Everything in the trailer, as static markup. trailer/timeline.js finds these
// by id and cuts between them; nothing here knows about time.
//
// The phones, stacks and screens are the film's own, so a screen still has one
// drawing. The words are fewer than the film's: a trailer has no voice to carry
// the sentences, so each shot keeps the one claim its picture proves.

import { pixelBird } from "../../lib/icons.mjs";
import { AMBER, SELF } from "../../lib/screens.mjs";
import * as screens from "../src/screens.mjs";
import { BARS, phone, PROVEN, stack } from "../src/stage.mjs";

const { icon } = screens;

const hit = (id, text, cls = "") => `<div class="hit${cls}" id="${id}">${text}</div>`;

function chain() {
  const xs = [360, 660, 960, 1260, 1560];
  const labels = ["you", "a stranger", "a stranger", "a stranger", "amber"];
  const nodes = xs
    .map((x, i) => {
      const end = i === 0 || i === xs.length - 1;
      const sees = end
        ? ""
        : `<div class="csees" id="csees-${i}" style="left:${x}px"><b>to ${AMBER.id.slice(0, 8)}</b><span id="cipher-${i}"></span></div>`;
      return `<div class="cnode${end ? " cnode-end" : ""}" id="cnode-${i}" style="left:${x}px">${icon(end ? "message-circle" : "radio", 34, "currentColor", 1.6)}</div>
        <div class="clabel" id="clabel-${i}" style="left:${x}px">${labels[i]}</div>${sees}`;
    })
    .join("");
  return `<div id="chain">
    <div class="chain-line" id="chain-line"></div>
    ${nodes}
    <div id="packet">${icon("mail", 22, "currentColor", 2)}<span>sealed</span></div>
  </div>`;
}

const MORE = [
  ["hash", "Rooms."],
  ["mic", "Live voice."],
  ["map-pin", "Pinned notices."],
  ["globe", "35 languages."],
];

export function stageHtml(plan) {
  const total = plan.duration.toFixed(3);
  return `<div id="trailer" data-composition-id="airhop-trailer" data-start="0" data-width="1920" data-height="1080" data-fps="60" data-duration="${total}">
  <div id="backdrop"></div>
  <canvas id="world" width="3840" height="2160"></canvas>

  <div id="sig"><div id="sig-bars">${BARS}</div><div id="sig-wifi">${icon("wifi-off", 200, "currentColor", 1.4)}</div></div>
  ${hit("no-signal", "No signal.")}
  ${hit("no-wifi", "No Wi-Fi.")}

  ${hit("still", "Still talking.", " hit-low")}
  <div id="word">${"AIRHOP"
    .split("")
    .map((c) => `<span>${c}</span>`)
    .join("")}</div>
  <div id="intro-tag">Messaging that works without the internet.</div>

  ${stack("k-mesh", "k-left", ["Bluetooth", "mesh."])}
  ${phone("ph-radar", 1300, 1.12, [screens.radar("sc-radar")])}

  ${stack("k-e2e", "k-left k-mid", ["End-to-end", "encrypted."])}
  ${phone("ph-thread", 1400, 1.12, [screens.conversation("sc-thread")])}

  ${chain()}
  ${stack("k-relay", "k-top", ["Carried by strangers.", "Unreadable to them."])}

  ${hit("key-0", "No account.")}
  ${hit("key-1", "No phone number.")}
  ${hit("key-2", "Just a key.")}
  <div id="peer-id" data-text="${SELF.id.slice(0, 8)} · ${SELF.id.slice(8)}"></div>

  ${stack("k-far", "k-left k-mid", ["Out of", "range?"])}
  ${stack("k-nostr", "k-left", ["Nostr.", "Tor."])}

  ${MORE.map(([glyph, word], i) => `<div class="card" id="more-${i}">${icon(glyph, 150, "currentColor", 1.5)}<span>${word}</span></div>`).join("")}

  ${stack("k-pay", "k-left k-mid", ["Send money.", "No signal."])}
  ${stack("k-cashu", "k-left k-mid", ["Powered by", "Cashu."])}
  <div class="note k-sub" id="k-cashu-sub">ecash, backed by Bitcoin</div>
  ${phone("ph-pa", 1180, 1.12, [screens.threadPaying("sc-pa")])}
  ${phone("ph-pb", 1640, 1.12, [screens.threadReceiving("sc-pb")])}
  <div id="token">${icon("zap", 18, "currentColor", 2.4)}500</div>

  <div id="proven">${PROVEN.map(([name, from], i) => `<div class="proof" id="proof-${i}"><span class="proof-name">${name}</span><i></i><span class="proof-from">${from}</span></div>`).join("")}</div>
  <div class="note" id="primitives">X25519 · Ed25519 · ChaCha20-Poly1305</div>

  ${hit("free-0", "Free.")}
  ${hit("free-1", "Open source.")}
  ${hit("free-2", "Works with bitchat.")}

  <div id="end">
    <div id="end-lockup">${pixelBird(190, "var(--panelText)")}<span>AIRHOP</span></div>
    <div id="end-url">https://airhop.free</div>
  </div>

  <div id="touch-ring"></div><div id="touch"></div>
  <audio id="music" src="assets/music.wav" data-start="0" data-duration="${total}" data-track-index="10" data-volume="1"></audio>
</div>`;
}
