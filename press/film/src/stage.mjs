// Everything on the stage, as static markup. timeline.js finds these by id and
// moves them; nothing here knows about time.
//
// On-screen words are few and large, because the narration carries the
// sentences. Copy follows press/lib/copy.mjs: plain words, no claim the
// picture beside it cannot back up.

import { pixelBird } from "../../lib/icons.mjs";
import * as screens from "./screens.mjs";

const { icon } = screens;
const SCREEN_W = 393;
const SCREEN_H = 852;
const BEZEL = 13;

// A phone centred on `x`, holding one or more stacked screens, inside a camera
// the timeline can push in on. The camera's origin is the phone's centre.
function phone(id, x, scale, layers) {
  const w = SCREEN_W * scale + BEZEL * 2;
  const h = SCREEN_H * scale + BEZEL * 2;
  const radius = w * 0.125;
  return `<div class="cam" id="cam-${id}" style="transform-origin:${x}px 540px"><div class="cam-in">
    <div class="ph" style="left:${x}px"><div class="phone" id="${id}" style="left:${-w / 2}px;top:${-h / 2}px;width:${w}px;height:${h}px;border-radius:${radius.toFixed(1)}px">
      <div class="phone-clip" style="border-radius:${(radius - BEZEL).toFixed(1)}px"><div class="phone-scale" style="zoom:${scale}">${layers.join("")}</div></div>
    </div></div>
  </div></div>`;
}

const words = (text) =>
  text
    .split(" ")
    .map((w, i, all) => `<span class="w">${w}${i < all.length - 1 ? " " : ""}</span>`)
    .join("");

const line = (id, text) => `<div class="line" id="${id}">${words(text)}</div>`;

// A stack of display lines, one block each, so a title can break where it is
// meant to without a forced line break.
const stack = (id, cls, lines) =>
  `<div class="stack ${cls}" id="${id}">${lines.map((l, i) => `<div class="stack-line" id="${id}-${i}">${l}</div>`).join("")}</div>`;

const ROUTE = "M760,620 L560,330 L960,200 L1360,330 L1160,620";

// `side` puts the label clear of the route, out to one side of its node.
function routeNode(id, x, y, glyph, label, cause, side) {
  const place = {
    left: `left:${x - 224}px;top:${y - 15}px;text-align:right`,
    right: `left:${x + 224}px;top:${y - 15}px;text-align:left`,
  }[side];
  return `<div class="rnode" id="${id}" style="left:${x}px;top:${y}px">${icon(glyph, 32, "currentColor", 1.6)}
      <div class="rnode-dead" id="${id}-dead">${icon("x", 32, "currentColor", 1.8)}</div></div>
    <div class="rlabel" id="${id}-label" style="${place}">${label}</div>
    <div class="rlabel rlabel-dead" id="${id}-cause" style="${place}">${cause}</div>`;
}

function longway() {
  return `<div id="longway">
    <svg viewBox="0 0 1920 1080"><path class="route-ghost" id="route-ghost" d="${ROUTE}"/><path class="route-live" id="route-live" d="${ROUTE}"/></svg>
    ${routeNode("rn-a", 560, 330, "radio", "cell tower", "down", "left")}
    ${routeNode("rn-b", 960, 200, "hard-drive", "someone else’s server", "unreachable", "left")}
    ${routeNode("rn-c", 1360, 330, "radio", "cell tower", "down", "right")}
    <div class="tag" id="tag-0" style="left:1040px;top:112px">your phone number</div>
    <div class="tag" id="tag-1" style="left:1040px;top:172px">who you talk to, and when</div>
    <div class="tag" id="tag-2" style="left:1040px;top:232px">a copy, kept</div>
    <div id="pulse"></div>
    <div class="measure" id="measure"></div>
    <div class="measure-label" id="measure-label">10 m</div>
    <div class="who" id="who-a" style="left:760px;top:652px">you</div>
    <div class="who" id="who-b" style="left:1160px;top:652px">amber</div>
  </div>`;
}

const BARS = `<svg class="bars" viewBox="0 0 68 44" width="136" height="88" fill="currentColor"><rect class="bar" x="0" y="30" width="12" height="14" rx="3"/><rect class="bar" x="18.6" y="22" width="12" height="22" rx="3"/><rect class="bar" x="37.2" y="12" width="12" height="32" rx="3"/><rect class="bar" x="55.8" y="0" width="12" height="44" rx="3"/></svg>`;

// The ridge Feather has no glyph for, drawn in its idiom.
const RIDGE = `<svg class="ic" width="300" height="300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M2 19l6.5-11 4 6.2L15 11l7 8z"/><path d="M6.6 11.2l1.9 1.6 1.7-1.2"/></svg>`;

function places() {
  const list = [
    [["A natural", "disaster."], icon("cloud-lightning", 300, "currentColor", 1)],
    ["A festival.", icon("users", 300, "currentColor", 1)],
    ["A trail.", RIDGE],
    ["A shutdown.", icon("wifi-off", 300, "currentColor", 1)],
  ];
  return list
    .map(
      ([text, glyph], i) => `<div class="place" id="place-${i}">
      <div class="place-col">
        <div class="place-text" id="place-text-${i}">${[text]
          .flat()
          .map((l) => `<span>${l}</span>`)
          .join("")}</div>
        <div class="place-bars" id="place-bars-${i}">${BARS}<span>no service</span></div>
      </div>
      <div class="place-art" id="place-art-${i}">${glyph}</div>
    </div>`,
    )
    .join("");
}

function chain() {
  const xs = [360, 660, 960, 1260, 1560];
  const labels = ["you", "a stranger", "a stranger", "a stranger", "amber"];
  const nodes = xs
    .map((x, i) => {
      const end = i === 0 || i === xs.length - 1;
      const sees = end
        ? ""
        : `<div class="csees" id="csees-${i}" style="left:${x}px"><b>to 3f0c9a1b</b><span id="cipher-${i}"></span></div>`;
      return `<div class="cgroup" id="cgroup-${i}"><div class="cnode${end ? " cnode-end" : ""}" id="cnode-${i}" style="left:${x}px">${icon(end ? "message-circle" : "radio", 34, "currentColor", 1.6)}</div>
        <div class="clabel" id="clabel-${i}" style="left:${x}px">${labels[i]}</div>${sees}</div>`;
    })
    .join("");
  return `<div id="chain">
    <div class="cam" id="cam-chain" style="transform-origin:960px 540px"><div class="cam-in">
      <div class="chain-line" id="chain-line"></div>
      ${nodes}
      <div id="packet">${icon("mail", 22, "currentColor", 2)}<span>sealed</span></div>
    </div></div>
    ${stack("k-hop", "k-top", ["Phone to phone."])}
    <div id="hopcount"><b id="hopnum">0</b><span>of 7 hops</span></div>
    <div class="k-sealed" id="k-sealed">${icon("lock", 120, "currentColor", 2)}<span>Sealed.</span></div>
    ${stack("k-carry", "k-top", ["Nobody in range?", "Carried there."])}
  </div>`;
}

function bigRow(id, row) {
  return `<div class="bigrow" id="${id}"><div class="group">${screens.settingRow({ ...row, key: id })}</div></div>`;
}

function card(n, title, visual) {
  return `<div class="mcard" id="card-${n}">
    ${stack(`card-title-${n}`, "mcard-title", title)}
    <div class="mcard-art" id="card-art-${n}">${visual}</div>
  </div>`;
}

function more() {
  const wave = Array.from({ length: 44 }, (_, i) => `<i id="wv-${i}"></i>`).join("");
  return [
    card(0, ["Rooms for", "where you are."], phone("ph-rooms", 1400, 1.12, [screens.chats("sc-rooms")])),
    card(
      1,
      ["Live voice."],
      `<div class="voice"><span class="live"><i></i>LIVE</span><div class="wave">${wave}</div></div>`,
    ),
    card(
      2,
      ["Pinned", "notices."],
      `<div class="notice"><span class="notice-top">${icon("map-pin", 26, "currentColor")}<span class="notice-urgent">URGENT</span><span>signed · 2 days left</span></span>
        <span class="notice-body">Water station at the south entrance</span></div>`,
    ),
    card(3, ["A gateway."], bigRow("row-gateway", screens.CONNECTIVITY.gateway)),
    card(4, ["A bridge."], bigRow("row-bridge", screens.CONNECTIVITY.bridge)),
    card(
      5,
      ["35 languages."],
      `<div class="tongues">${["Hello", "नमस्ते", "مرحبا", "你好", "Hola", "Привет", "Bonjour", "سلام"].map((w) => `<span>${w}</span>`).join("")}</div>`,
    ),
  ].join("");
}

// What is next, in roadmap order. No version numbers: a viewer needs to know
// it is coming, not which release carries it.
const ROADMAP = [
  ["Offline AI assistant"],
  ["Relay hardware"],
  ["Web"],
  ["Terminal"],
  ["Apple Watch and Wear OS"],
  ["macOS and Windows"],
  ["Bluesky and Mastodon bridges"],
  ["Two independent security audits", true],
];

// What Airhop adds to the protocol it shares with bitchat. The bracket is the
// detail for whoever pauses; the narration reads the first part.
const GAINS = [
  ["Double Ratchet algorithm", "a new key per message"],
  ["Wi-Fi Aware", "same platform, direct"],
  ["mDNS discovery", "iPhone to Android, on one Wi-Fi"],
  ["Tor, with bridges", "obfs4, Snowflake, webtunnel"],
  ["A full wallet", "powered by the Cashu protocol"],
  ["One codebase", "in TypeScript"],
];

// Tor is spelled out here and only here, where the point is where it comes from.
const PROVEN = [
  ["Noise XX handshake", "proven in WireGuard"],
  ["Double Ratchet algorithm", "from Signal"],
  ["The Onion Router (Tor)", "from the Tor Project"],
];

// Both wing positions of the mark, from src/ui/components/pixel-bird.tsx.
const WINGS = [
  ["11000000011", "01100000110", "00110101100", "00011111000", "00001110000", "00000100000"],
  ["00000000000", "00000100000", "00011111000", "11111111111", "01100100110", "11000100011"],
];

function wing(frame, id) {
  const cells = WINGS[frame]
    .flatMap((row, y) =>
      row.split("").map((c, x) => (c === "1" ? `<rect x="${x}" y="${y}" width="1.02" height="1.02"/>` : "")),
    )
    .join("");
  return `<svg id="${id}" viewBox="0 0 11 6" shape-rendering="crispEdges" fill="#111">${cells}</svg>`;
}

export function stageHtml(plan) {
  const total = plan.duration.toFixed(3);
  const audio = [
    `<audio id="music" src="assets/music.wav" data-start="0" data-duration="${total}" data-track-index="10" data-volume="0.85"></audio>`,
    `<audio id="sfx" src="assets/sfx.wav" data-start="0" data-duration="${total}" data-track-index="11" data-volume="1" data-audio-group="sfx"></audio>`,
    ...plan.lines.map(
      (l) =>
        `<audio id="vo-${l.id}" src="assets/vo/${l.id}.wav" data-start="${l.start.toFixed(3)}" data-duration="${l.seconds.toFixed(3)}" data-track-index="12" data-volume="1" data-audio-group="voiceover"></audio>`,
    ),
  ].join("\n  ");

  return `<div id="film" data-composition-id="airhop" data-start="0" data-width="1920" data-height="1080" data-fps="60" data-duration="${total}">
  <div id="backdrop"></div>
  <canvas id="world" width="3840" height="2160"></canvas>

  ${line("ln-e1", "Never more connected.")}
  ${line("ln-e2", "On a network that isn’t ours.")}
  ${line("ln-l3", "…you go quiet.")}
  ${line("ln-i1", "Still right there.")}
  ${line("ln-i2", "What if the phones just talked?")}
  ${longway()}
  ${places()}

  <div id="word">${"AIRHOP"
    .split("")
    .map((c) => `<span>${c}</span>`)
    .join("")}</div>
  <div id="intro-tag">Messaging that works without the internet.</div>

  ${stack("k-mesh", "k-left", ["Bluetooth", "mesh."])}
  ${phone("ph-mesh", 1300, 1.12, [screens.radar("sc-radar")])}
  <div class="note" id="note-signal" style="left:1560px;top:80px"><i></i>no signal, no Wi-Fi</div>

  ${chain()}

  <div class="big-bubble" id="q-ask">pretty cool?</div>
  <div class="big-bubble" id="q-typing"><i></i><i></i><i></i></div>
  <div class="big-bubble" id="q-answer">that’s not all.</div>

  ${stack("k-id", "k-left", ["No account.", "No phone number.", "Just a key."])}
  ${phone("ph-id", 1500, 1.12, [screens.generating("sc-gen"), screens.reveal("sc-reveal")])}

  <div class="note" id="k-far" style="left:150px;top:300px">${icon("bluetooth", 24, "currentColor")}out of Bluetooth range</div>
  ${stack("k-nostr", "k-left", ["Nostr."])}
  <div id="k-relays"><b id="relay-count">0</b><span>independent relays</span></div>
  ${stack("k-ours", "k-left k-mid", ["None of them", "ours."])}
  ${stack("k-wrap", "k-left", ["Gift-", "wrapped."])}
  <div class="note k-sub" id="k-wrap-sub">a relay sees only the recipient’s key</div>
  ${stack("k-tor", "k-left", ["Tor."])}
  <div class="note k-sub" id="k-tor-sub">and not where you are</div>
  ${stack("k-any", "k-left k-mid", ["Next door.", "Across the", "planet."])}

  ${stack("k-more", "k-centre", ["There’s more."])}
  ${more()}

  <div id="money">And money.</div>
  ${stack("k-wallet", "k-left k-mid", ["Send money", "with no", "signal."])}
  <div class="note k-sub" id="k-wallet-sub">checked offline · confirmed by the mint when you are back online</div>
  ${stack("k-cashu", "k-left k-mid", ["Powered by", "Cashu."])}
  <div class="note k-sub" id="k-cashu-sub">digital cash, backed by Bitcoin. Whoever holds a coin can spend it, like a banknote.</div>
  ${phone("ph-wa", 960, 1.12, [screens.threadPaying("sc-wa")])}
  ${phone("ph-wb", 1380, 1.12, [screens.threadReceiving("sc-wb"), screens.wallet("sc-wallet")])}
  <div id="token">${icon("zap", 18, "currentColor", 2.4)}500</div>
  <div class="note" id="note-online" style="left:1640px;top:80px"><i></i>back online</div>

  <div id="bitchat">
    <div id="pair">
      <div class="pair-a" id="pair-a">${pixelBird(84, "var(--panelText)")}<span>AIRHOP</span></div>
      <div class="pair-link" id="pair-link"><i id="pair-line"></i><span id="pair-note">same mesh · same wire format</span></div>
      <div class="pair-b" id="pair-b">bitchat</div>
    </div>
    ${stack("k-kept", "k-right", ["Then we", "kept going."])}
    <div id="gains">${GAINS.map(([g, note], i) => `<div class="gain" id="gain-${i}"><b>+</b><span>${g}</span><em>(${note})</em></div>`).join("")}</div>
  </div>

  <div id="crypto">
    ${stack("k-crypto", "k-top k-wide", ["We didn’t invent", "the cryptography."])}
    <div id="k-point">That’s the point.</div>
    <div id="proven">${PROVEN.map(([name, from], i) => `<div class="proof" id="proof-${i}"><span class="proof-name">${name}</span><i></i><span class="proof-from">${from}</span></div>`).join("")}</div>
    <div class="note" id="primitives">X25519 · Ed25519 · ChaCha20-Poly1305 · @noble, audited by Cure53</div>
    <div id="osp">${["Open.", "Studied.", "Proven."].map((w, i) => `<span id="osp-${i}">${w}</span>`).join("")}</div>
    <div id="k-easy">We just made it easy.</div>
  </div>

  <div id="nothing">
    <div id="no-0">No servers.</div><div id="no-1">No accounts.</div><div id="no-2">No tracking.</div>
    <div id="no-3">Nothing to hand over.<s id="no-rule"></s></div>
  </div>

  ${phone("ph-old", 440, 1.12, [screens.you("sc-you"), screens.notice("sc-moving", "Transferring 64%", "Keep both phones open until this finishes."), screens.welcome("sc-erased")])}
  ${phone("ph-new", 990, 1.12, [screens.transferIn("sc-code"), screens.notice("sc-receiving", "Receiving 64%", "Keep both phones open until this finishes."), screens.you("sc-you2"), screens.notice("sc-wiping", "Wiping", "Destroying your keys, messages and files."), screens.welcome("sc-welcome")])}
  ${stack("k-move", "k-col", ["New phone?", "It all moves."])}
  <div class="note k-sub" id="k-move-sub">identity · chats · wallet. The old phone erases itself.</div>
  ${stack("k-wipe", "k-col", ["Three taps.", "Gone."])}

  <div id="notdone">
    <div id="notdone-line"><span id="notdone-text"></span><u id="notdone-caret"></u></div>
    <div class="eyebrow" id="soon">Coming soon</div>
    <div id="roadmap">${ROADMAP.map(([label, strong], i) => `<div class="rm${strong ? " rm-strong" : ""}" id="rm-${i}">${label}</div>`).join("")}</div>
  </div>

  <div id="white"></div>
  <div id="k-try">Try Airhop.</div>
  <div id="flybird"><div id="flybird-in">${wing(0, "wing-0")}${wing(1, "wing-1")}</div></div>
  <div id="black"></div>
  <div id="end">
    <div id="end-lockup">${pixelBird(190, "var(--panelText)")}<span>AIRHOP</span></div>
    <div id="end-head">Free and open source.</div>
    <div id="end-url">https://airhop.free</div>
    <div id="end-mail">hi@areeb.dev</div>
    <div id="end-facts">iOS · Android · MIT · works with bitchat</div>
    <div id="end-lets"><span id="end-lets-text"></span><u id="end-caret"></u></div>
  </div>

  <div id="touch-ring"></div><div id="touch"></div>
  <div id="fade"></div>
  ${audio}
</div>`;
}
