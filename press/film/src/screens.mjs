// The screens only the film needs: a thread with its sheets open, onboarding,
// a transfer, the wipe. The ones a store panel also shows (radar, chats,
// wallet, You) come from ../../lib/screens.mjs, so a screen has one drawing.
//
// Every string is the app's own, from src/i18n/locales/en.ts, and every screen
// has no signal: the film happens with the network gone.

import { icon, pixelBird } from "../../lib/icons.mjs";
import {
  AMBER,
  avatar,
  bubble,
  composer,
  CONNECTIVITY,
  MINT,
  SCREENS,
  SELF,
  settingRow,
  shell,
  threadHeader,
} from "../../lib/screens.mjs";
import { avatarColor } from "../../lib/theme.mjs";

export { CONNECTIVITY, icon, settingRow };

const screen = (id, parts) => shell({ id, offline: true, ...parts });
const bare = (id, body) => screen(id, { body, footer: '<div class="home-indicator"></div>' });

export const radar = (id) => SCREENS.radar("ios", { id, offline: true });
export const chats = (id) => SCREENS.chats("ios", { id, offline: true });
export const you = (id) => SCREENS.profile("ios", { id, offline: true });

// The paid phone's wallet, as it stands before the mint has seen the token.
export const wallet = (id) =>
  SCREENS.wallet("ios", {
    id,
    offline: true,
    balance: "2,000",
    unconfirmed: "500",
    rows: [
      {
        name: "arrow-down-left",
        title: "Received, unconfirmed",
        sub: `now · ${MINT} · pending`,
        amount: "+500",
        key: "recv",
      },
      { name: "download", title: "Lightning top-up", sub: `2d · ${MINT}`, amount: "+2,000" },
    ],
  });

// ---------------------------------------------------------------------------
// Direct message thread
// ---------------------------------------------------------------------------

// The card a Cashu message renders as. The receiving side gets a Claim button.
function tokenCard({ amount, memo, claim }) {
  const footer = claim
    ? `<span class="f-claim"><span class="f-claim-btn" data-key="claim"><span data-key="claim-label">Claim</span></span>
        <span class="f-claimed" data-key="claimed">${icon("check", 13, "var(--online)", 2.6)}<span>Claimed</span></span></span>`
    : "";
  return `<div class="f-pay">
    <span class="f-pay-head">${icon("zap", 17, "currentColor")}<span class="f-pay-amt">${amount} sat</span></span>
    <span class="f-pay-mint">${MINT}</span>
    <span class="f-pay-memo">${memo}</span>${footer}
  </div>`;
}

const HISTORY = [
  { text: "power is out on this side too. you ok?", mine: false, time: "18:42" },
  { text: "fine. sitting it out upstairs", mine: true, time: "18:42" },
  { text: "water station is open at the south gate. pass it on", mine: false, time: "18:47" },
  { text: "on my way. telling the others", mine: true, time: "18:47" },
  { text: "they only take cash and i have none on me", mine: false, time: "18:52" },
];

const thread = (rows) =>
  `<div class="thread"><div class="divider"><span data-layout-allow-overlap>Today</span></div>${rows}</div>`;

function sheet(key, title, body) {
  return `<div class="f-sheet" data-key="${key}"><span class="f-grab"></span>
    <span class="f-sheet-title">${title}</span>${body}</div>`;
}

function attachRow(name, label, desc, key) {
  return `<span class="f-attach"${key ? ` data-key="${key}"` : ""}>
    <span class="f-attach-icon">${icon(name, 18, "var(--textPrimary)")}</span>
    <span class="f-attach-text"><span class="set-label">${label}</span>${desc ? `<span class="set-desc">${desc}</span>` : ""}</span>
  </span>`;
}

// The thread on the paying phone, with the attach sheet, the send sheet, the
// confirmation and the outgoing token.
export function threadPaying(id) {
  const token = bubble({
    mine: true,
    time: "18:53",
    ticks: ["sending", "sent", "delivered"],
    key: "token",
    card: tokenCard({ amount: "500", memo: "for the water" }),
  });
  const overlays = `<div class="f-scrim" data-key="scrim"></div>
    ${sheet(
      "attach",
      "Attach",
      `<div class="f-attach-list">
        ${attachRow("camera", "Camera")}
        ${attachRow("image", "Photo library")}
        ${attachRow("file-text", "Document")}
        ${attachRow("mic", "Voice note")}
        ${attachRow("zap", "Send ecash", "Send Cashu sats from your wallet", "ecash-row")}
        ${attachRow("map-pin", "Location")}
      </div>`,
    )}
    ${sheet(
      "send-sheet",
      "Send ecash",
      `<span class="f-sheet-sub">To ${AMBER.name}</span>
      <span class="f-field"><span class="f-field-hint" data-key="amount-hint">Amount in sats</span><span class="f-field-value" data-key="amount"></span></span>
      <span class="f-field"><span class="f-field-hint" data-key="memo-hint">Memo (optional, public)</span><span class="f-field-value" data-key="memo"></span></span>
      <span class="f-sheet-actions"><span class="f-btn f-btn-ghost">Cancel</span><span class="f-btn f-btn-solid" data-key="sheet-send">Send</span></span>`,
    )}
    <div class="f-alert" data-key="alert">
      <span class="f-alert-title">Send 500 sat to ${AMBER.name}?</span>
      <span class="f-alert-body">You can reclaim it from Activity until they claim it.</span>
      <span class="f-sheet-actions"><span class="f-btn f-btn-ghost">Cancel</span><span class="f-btn f-btn-solid" data-key="alert-send">Send 500</span></span>
    </div>`;

  return screen(id, {
    header: threadHeader(AMBER),
    body: thread(HISTORY.map(bubble).join("") + token),
    footer: composer() + overlays,
  });
}

// The same conversation on the other phone, where the token lands.
export function threadReceiving(id) {
  const rows = HISTORY.slice(1).map((b) => bubble({ ...b, mine: !b.mine }));
  const token = bubble({
    mine: false,
    time: "18:53",
    key: "token",
    card: tokenCard({ amount: "500", memo: "for the water", claim: true }),
  });
  return screen(id, { header: threadHeader(SELF), body: thread(rows.join("") + token), footer: composer() });
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export function generating(id) {
  const lines = [
    "Generating X25519 static key pair",
    "Generating Ed25519 signing key pair",
    "Storing keys in OS Keychain",
    "Deriving peer ID",
  ];
  return bare(
    id,
    `<div class="f-onboard">
      <span class="f-spinner"><span class="f-spinner-arc" data-key="spinner"></span><span class="f-spinner-dot"></span></span>
      <span class="f-ob-title">Generating your identity</span>
      <span class="f-ob-sub">Creating your cryptographic keys on this device. Nothing is sent anywhere.</span>
      <div class="f-ob-card">${lines
        .map(
          (l, i) =>
            `<span class="f-ob-line" data-key="line-${i}">${icon("check", 13, "var(--textMuted)", 2.6)}<span>${l}</span></span>`,
        )
        .join("")}</div>
    </div>`,
  );
}

export function reveal(id) {
  const row = (k, v, strong, key) =>
    `<span class="f-rv-row"${key ? ` data-key="${key}"` : ""}><span class="f-rv-k">${k}</span><span class="f-rv-v${strong ? " f-rv-strong" : ""}">${v}</span></span>`;
  return bare(
    id,
    `<div class="f-onboard f-reveal">
      <div class="f-rv-card">
        ${avatar(SELF, 72)}
        <span class="f-rv-label">Your name on the mesh</span>
        <span class="f-rv-name" style="color:${avatarColor(SELF.id)}" data-key="name">${SELF.name}</span>
        <span class="f-rv-label f-rv-gap">Peer ID</span>
        <span class="f-rv-id" data-key="peer-id">${SELF.id.slice(0, 8)} · ${SELF.id.slice(8)}</span>
        <div class="f-rv-rows">
          ${row("Algorithm", "Ed25519 + X25519")}
          ${row("Storage", "OS Keychain only")}
          ${row("Account required", "None", true, "none")}
        </div>
      </div>
      <span class="f-rv-note">This username is deterministically derived from your public key. It is the same on every device that sees your peer ID.</span>
      <span class="f-cta">Enter Airhop</span>
    </div>`,
  );
}

export function welcome(id) {
  return bare(
    id,
    `<div class="f-onboard f-welcome">
      <span class="f-wl-bird">${pixelBird(190, "var(--textPrimary)")}</span>
      <span class="f-wl-word">airhop</span>
      <span class="f-wl-tag">Private mesh communication</span>
      <span class="f-wl-spacer"></span>
      <span class="f-cta f-cta-off">Get started</span>
      <span class="f-cta f-cta-outline f-cta-off">Transfer from another phone</span>
    </div>`,
  );
}

// A full-screen notice: the wipe, and both ends of a transfer.
export function notice(id, title, sub) {
  return screen(id, {
    body: `<div class="f-onboard f-notice">
      <span class="f-ob-title" data-key="title">${title}</span>
      <span class="f-ob-sub" data-key="sub">${sub}</span>
    </div>`,
    footer: "",
  });
}

// A stand-in for the transfer code: the three finder squares of a QR and a
// seeded fill. Deliberately not a code anything can scan.
function transferCode(size) {
  const n = 29;
  let seed = 0x51f2;
  const bit = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed >>> 31;
  };
  const finder = (x, y) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
  const ring = (x, y, ox, oy) => {
    const dx = x - ox;
    const dy = y - oy;
    if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return null;
    const edge = dx === 0 || dy === 0 || dx === 6 || dy === 6;
    const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
    return edge || core;
  };
  let cells = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const on = finder(x, y)
        ? (ring(x, y, 0, 0) ?? ring(x, y, n - 7, 0) ?? ring(x, y, 0, n - 7))
        : bit() === 1;
      if (on) cells += `<rect x="${x}" y="${y}" width="1.02" height="1.02"/>`;
    }
  }
  return `<svg width="${size}" height="${size}" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" rx="1.5" fill="#fff"/><g fill="#111">${cells}</g></svg>`;
}

// The new phone, waiting to be scanned.
export function transferIn(id) {
  return bare(
    id,
    `<div class="f-onboard f-transfer">
      <span class="f-ob-title">Scan this code with your old phone</span>
      <span class="f-code">${transferCode(232)}</span>
      <span class="f-ob-sub">Both phones need the same Wi-Fi or a hotspot. Nothing goes over the internet.</span>
    </div>`,
  );
}
