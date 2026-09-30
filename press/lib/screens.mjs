// The app screens, redrawn at 393x852 logical points. Layout, spacing, type and
// colour come from src/ui/theme.ts and src/features/. Nothing here invents a
// control the app does not have, and every string is the app's own, from
// src/i18n/locales/en.ts.
//
// The store panels and the launch film both draw from this file. The film
// passes `offline` for a status bar with no signal, and finds the parts it
// animates by their `data-key`.

import { icon, pixelBird } from "./icons.mjs";
import { avatarColor, withAlpha } from "./theme.mjs";

export const SCREEN_W = 393;
export const SCREEN_H = 852;

// One identity across every screen, so the tab bar avatar, the profile and the
// "you" side of a conversation agree.
export const SELF = { id: "9d3ec41b77a2e058", name: "calm-atlas-9d3e" };
export const MINT = "mint.minibits.cash";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export function avatar(person, size, presence) {
  const color = avatarColor(person.id);
  const dot = Math.max(8, Math.round(size * 0.1875));
  const presenceDot =
    presence === undefined
      ? ""
      : `<span class="av-dot" style="width:${dot}px;height:${dot}px;background:var(--${presence});border-width:${Math.max(1.5, size * 0.02)}px"></span>`;
  return `<span class="av" style="width:${size}px;height:${size}px;background:${withAlpha(color, 0.13)}">
    <span class="av-txt" style="font-size:${(size * 0.36).toFixed(1)}px;color:${color}">${person.name.slice(0, 2).toUpperCase()}</span>${presenceDot}
  </span>`;
}

// `offline` dims the signal bars and drops the Wi-Fi glyph. The bars stay in
// the markup so a scene can bring them back.
function statusBar(platform, offline) {
  const cutout = platform === "android" ? '<span class="punch"></span>' : '<span class="island"></span>';
  const bars = `<svg class="sb-bars${offline ? " sb-bars-off" : ""}" width="17" height="11" viewBox="0 0 17 11" fill="currentColor"><rect x="0" y="7.5" width="3" height="3.5" rx="1"/><rect x="4.6" y="5.5" width="3" height="5.5" rx="1"/><rect x="9.2" y="3" width="3" height="8" rx="1"/><rect x="13.8" y="0" width="3" height="11" rx="1"/></svg>`;
  const wifi = offline
    ? ""
    : `<svg width="16" height="12" viewBox="0 0 24 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 8.55a11 11 0 0 1 14.08 0"/><path d="M1.42 5a16 16 0 0 1 21.16 0"/><path d="M8.53 12.11a6 6 0 0 1 6.95 0"/><path d="M12 16h.01"/></svg>`;
  const battery = `<svg width="25" height="12" viewBox="0 0 25 12" fill="none"><rect x="0.5" y="0.5" width="21" height="11" rx="3" stroke="currentColor" stroke-opacity="0.4"/><rect x="2" y="2" width="15" height="8" rx="1.5" fill="currentColor"/><path d="M23 4.2v3.6a2 2 0 0 0 0-3.6z" fill="currentColor" fill-opacity="0.5"/></svg>`;
  return `<div class="statusbar">${cutout}
    <span class="sb-time">9:41</span>
    <span class="sb-right">${bars}${wifi}${battery}</span>
  </div>`;
}

function iconBtn(name, size = 17, tone = "var(--textPrimary)") {
  return `<span class="icon-btn">${icon(name, size, tone)}</span>`;
}

function segmented(items) {
  return `<div class="seg-track">${items
    .map(
      (it) =>
        `<span class="seg${it.active ? " seg-on" : ""}">${icon(it.icon, 14, it.active ? "var(--textPrimary)" : "var(--textMuted)")}<span>${it.label}</span></span>`,
    )
    .join("")}</div>`;
}

function tabBar(active) {
  const tabs = [
    { id: "chats", label: "Chats", icon: "message-circle" },
    { id: "mesh", label: "Mesh", icon: "radio" },
    { id: "wallet", label: "Wallet", icon: "credit-card" },
    { id: "profile", label: "You", icon: null },
  ];
  const items = tabs
    .map((tab) => {
      const on = tab.id === active;
      const glyph =
        tab.icon === null
          ? `<span class="tab-av${on ? " tab-av-on" : ""}">${avatar(SELF, 20)}</span>`
          : icon(tab.icon, 22, on ? "var(--accent)" : "var(--textMuted)");
      return `<span class="tab">
        <span class="tab-ind${on ? " tab-ind-on" : ""}"></span>
        <span class="tab-icon">${glyph}</span>
        <span class="tab-label${on ? " tab-label-on" : ""}">${tab.label}</span>
      </span>`;
    })
    .join("");
  return `<div class="tabwrap"><div class="tabbar">${items}</div></div>
    <div class="home-indicator"></div>`;
}

// One screen: status bar, optional header, body, then the tab bar, or
// `footer` in its place. A message thread hides the tab bar (App.tsx gates it
// on !isInThread), so the composer owns the bottom of the screen there.
export function shell({ platform = "ios", offline = false, id, active, header = "", body, footer }) {
  return `<div class="screen"${id ? ` id="${id}"` : ""}>
    ${statusBar(platform, offline)}
    ${header}
    <div class="body">${body}</div>
    ${footer ?? tabBar(active)}
  </div>`;
}

// ---------------------------------------------------------------------------
// Mesh, radar
// ---------------------------------------------------------------------------

// Ring labels sit at about -64 degrees, so no peer goes in that arc.
const RADAR_PEERS = [
  {
    name: "amber-bolt-3f0c",
    id: "3f0c9a1b7d24e5f8",
    ring: 1,
    angle: 28,
    online: true,
  },
  {
    name: "arctic-atlas-7a19",
    id: "7a19b3c0d8e21f45",
    ring: 1,
    angle: 196,
    online: true,
  },
  {
    name: "bright-blade-b204",
    id: "b2045f6a8c13d970",
    ring: 2,
    angle: 138,
    online: true,
  },
  {
    name: "binary-ash-e6d1",
    id: "e6d1207f4b95a3c8",
    ring: 2,
    angle: 244,
    online: false,
  },
];
export const AMBER = RADAR_PEERS[0];

function radarScreen(platform, options = {}) {
  const canvas = 358;
  const c = canvas / 2;
  const fr = [0.3, 0.54, 0.78];
  const labels = ["Strong", "Medium", "Weak"];
  const outerR = c * fr[2];

  const rings = fr
    .map((f, i) => {
      const r = c * f;
      return `<span class="ring" style="width:${r * 2}px;height:${r * 2}px;top:${c - r}px;left:${c - r}px"></span>
        <span class="ring-label" style="top:${c - r + 5}px;left:${c + r * 0.48}px">${labels[i]}</span>`;
    })
    .join("");

  const compass = [
    { l: "N", top: -outerR - 22, left: -4 },
    { l: "E", top: -6, left: outerR + 12 },
    { l: "S", top: outerR + 8, left: -4 },
    { l: "W", top: -6, left: -outerR - 20 },
  ]
    .map((d) => `<span class="compass" style="top:${c + d.top}px;left:${c + d.left}px">${d.l}</span>`)
    .join("");

  const nodes = RADAR_PEERS.map((p) => {
    const r = c * fr[p.ring];
    const rad = (p.angle * Math.PI) / 180;
    const top = c + r * Math.sin(rad) - 17;
    const left = c + r * Math.cos(rad) - 17;
    return `<span class="peer-node" style="top:${top}px;left:${left}px">
      ${avatar(p, 34, p.online ? "online" : "offline")}
      <span class="peer-label">${p.name.split("-")[0]}</span>
    </span>`;
  }).join("");

  const header = `<div class="header">
    <span class="h-title">Mesh</span>
    <span class="h-controls">
      ${segmented([
        { label: "Radar", icon: "radio", active: true },
        { label: "List", icon: "list", active: false },
      ])}
      ${iconBtn("user-plus")}
    </span>
  </div>`;

  const body = `<div class="radar">
    <div class="radar-canvas" style="width:${canvas}px;height:${canvas}px">
      <span class="pulse" style="width:${outerR * 2}px;height:${outerR * 2}px;top:${c - outerR}px;left:${c - outerR}px"></span>
      ${rings}${compass}
      <span class="self-dot">${icon("radio", 14, "var(--textInverse)")}</span>
      ${nodes}
    </div>
    <div class="radar-status">
      <span class="radar-status-main">4 peers in range</span>
      <span class="radar-status-hint">Ring position reflects signal strength, not distance</span>
    </div>
  </div>`;

  return shell({ platform, ...options, active: "mesh", header, body });
}

// ---------------------------------------------------------------------------
// Direct message thread
// ---------------------------------------------------------------------------

const TICKS = { sending: "clock", sent: "check", delivered: "check-all" };

// The timestamp sits under the text, inside the bubble, with the delivery tick
// after it. `ticks` lists the states a bubble can show; the film stacks all
// three and reveals one at a time.
export function bubble({ text, mine, time, ticks = ["delivered"], key, card }) {
  const glyphs = mine
    ? `<span class="b-ticks">${ticks.map((state) => `<span class="b-tick b-tick-${state}">${icon(TICKS[state], 13, "currentColor", 2.4)}</span>`).join("")}</span>`
    : "";
  const body = card ?? `<span class="b-text" data-layout-allow-overlap>${text}</span>`;
  return `<div class="row ${mine ? "row-mine" : "row-theirs"}"${key ? ` data-key="${key}"` : ""}>
    <div class="bubble ${mine ? "b-mine" : "b-theirs"}">${body}<span class="b-meta" data-layout-allow-overlap>${time}${glyphs}</span></div>
  </div>`;
}

// Plus, the field, and a mic, which the send arrow replaces once there is a
// `draft`. `raised` lifts it clear of the part of a store panel that bleeds
// off the canvas.
export function composer({ raised = false, draft } = {}) {
  const field = draft
    ? `<span class="c-draft">${draft}</span>`
    : '<span class="c-placeholder" data-layout-allow-overlap>Message…</span>';
  const action = draft
    ? `<span class="c-send">${icon("arrow-up", 18, "var(--textInverse)")}</span>`
    : `<span class="c-mic">${icon("mic", 22, "var(--textMuted)")}</span>`;
  return `<div class="composer${raised ? " composer-raised" : ""}">
    <span class="c-plus" data-key="plus">${icon("plus", 20, "var(--textPrimary)")}</span>
    <span class="c-input">${field}</span>
    ${action}
  </div><div class="home-indicator"></div>`;
}

export function threadHeader(peer) {
  return `<div class="header header-thread">
    <span class="h-back">${icon("arrow-left", 22, "var(--textPrimary)")}</span>
    <span class="h-dm">${avatar(peer, 28, "online")}<span class="h-title">${peer.name}</span></span>
  </div>`;
}

function threadScreen(platform, options = {}) {
  const peer = RADAR_PEERS[1];
  const lines = [
    ["keep an eye on the board, notices are going up", true, "18:26"],
    ["already pinned the one about the south gate", false, "18:28"],
    ["nothing on the phone network since six. this is the only thing still working", true, "18:33"],
    ["power is out on this side too. you ok?", false, "18:42"],
    ["fine. sitting it out upstairs", true, "18:42"],
    ["water station is at the south gate. pass it on", false, "18:44"],
    ["relaying it to #block now", true, "18:44"],
  ];
  const body = `<div class="thread thread-raised">
    <div class="divider"><span>Today</span></div>
    ${lines.map(([text, mine, time]) => bubble({ text, mine, time })).join("")}
  </div>`;
  return shell({
    platform,
    ...options,
    header: threadHeader(peer),
    body,
    footer: composer({ raised: true, draft: "on my way" }),
  });
}

// ---------------------------------------------------------------------------
// You: the settings hub as profile-screen.tsx builds it on iOS, top to bottom.
// It is taller than the phone. A store panel shows the top; the film scrolls it.
// ---------------------------------------------------------------------------

export function settingRow({ name, label, desc, control = "chevron", key, value }) {
  const trailing = {
    chevron: icon("chevron-right", 18, "var(--textMuted)"),
    on: `<span class="switch switch-on"${key ? ` data-key="${key}-switch"` : ""}><span class="knob"></span></span>`,
    off: `<span class="switch"${key ? ` data-key="${key}-switch"` : ""}><span class="knob"></span></span>`,
    value: `<span class="set-value">${value}</span>${icon("chevron-right", 18, "var(--textMuted)")}`,
  }[control];
  return `<div class="set-row"${key ? ` data-key="${key}"` : ""}>
    <span class="set-icon">${icon(name, 18, "var(--textSecondary)")}</span>
    <span class="set-text"><span class="set-label" data-layout-allow-overlap>${label}</span><span class="set-desc" data-layout-allow-overlap>${desc}</span></span>
    ${trailing}</div>`;
}

export const CONNECTIVITY = {
  liveVoice: {
    name: "mic",
    label: "Live voice",
    desc: "Talk to nearby people like a walkie-talkie",
    control: "on",
  },
  bridge: {
    name: "git-merge",
    label: "Mesh bridge",
    desc: "Link this area’s public #bluetooth chat with another out-of-range Bluetooth crowd over the internet",
    control: "off",
  },
  gateway: {
    name: "cast",
    label: "Internet gateway",
    desc: "Lend your connection to a nearby offline phone so it can still reach the location channels",
    control: "off",
  },
  tor: {
    name: "globe",
    label: "Tor routing",
    desc: "Route Nostr traffic through Tor for extra privacy",
    control: "value",
    value: "Off",
  },
};

const SECTIONS = [
  ["settings", "General", "Optional features, undo send, media, reset"],
  ["lock", "Privacy &amp; security", "Forward secrecy, signed packets, blocked peers"],
  ["radio", "Network &amp; relays", "Internet fallback, Nostr relays, bitchat compatibility"],
  ["hard-drive", "Storage &amp; data", "Usage and cache"],
  ["key", "Permissions", "Bluetooth, location, notifications, camera, mic"],
  ["activity", "Diagnostics", "Connection status and nearby devices"],
  ["sliders", "Appearance", "Theme, font, and language"],
  ["help-circle", "Help &amp; feedback", "Contact us, report a bug, or read the FAQ"],
  ["heart", "Support", "Help keep development active"],
  ["info", "About", "Version, changelog, and source"],
];

const DIVIDER = '<div class="group-div div-icon"></div>';

function profileScreen(platform, options = {}) {
  const body = `<div class="you" data-key="scroll">
    <div class="you-head">${iconBtn("search", 17, "var(--textSecondary)")}${iconBtn("edit-2", 17, "var(--textSecondary)")}</div>
    <div class="p-identity">
      <span class="p-avatar">${avatar(SELF, 96)}<span class="p-status"></span></span>
      <span class="p-name">${SELF.name}</span>
      <span class="p-state">Online</span>
    </div>
    <div class="p-pills">
      <span class="p-pill">${icon("share", 13, "var(--textSecondary)")}<span>Share ID</span></span>
      <span class="p-pill">${icon("eye", 13, "var(--textSecondary)")}<span>Show QR</span></span>
    </div>
    <div class="group">${Object.values(CONNECTIVITY).map(settingRow).join(DIVIDER)}</div>
    <div class="group">${SECTIONS.map(([name, label, desc]) => settingRow({ name, label, desc })).join(DIVIDER)}</div>
    <div class="group">${settingRow({ name: "smartphone", label: "Transfer to a new phone", desc: "Move your identity, chats, and wallet to another device", key: "transfer" })}</div>
    <div class="group panic" data-key="panic">
      <div class="set-row"><span class="set-icon">${icon("alert-triangle", 18, "var(--danger)")}</span>
        <span class="set-text"><span class="set-label panic-label">Panic wipe</span><span class="set-desc">Instantly destroy all keys, messages, and ecash</span></span></div>
    </div>
  </div>`;
  return shell({ platform, ...options, active: "profile", body });
}

// ---------------------------------------------------------------------------
// Chats, channels
// ---------------------------------------------------------------------------

function channelRow({ name, scope, preview, sender, time, unread, pin }) {
  return `<div class="ch-row">
    <div class="ch-head">
      <span class="ch-namegroup">${pin ? icon("map-pin", 13, "var(--textMuted)") : ""}<span class="ch-name"><span class="ch-hash">#</span>${name}</span></span>
      <span class="ch-meta">${time}</span>
    </div>
    <span class="ch-scope">${scope}</span>
    <div class="ch-foot">
      <span class="ch-preview"><span class="ch-sender">${sender}: </span>${preview}</span>
      ${unread ? `<span class="badge">${unread}</span>` : ""}
    </div>
  </div>`;
}

function chatsScreen(platform, options = {}) {
  const header = `<div class="header">
    <span class="h-title">Chats</span>
    <span class="h-controls">
      ${segmented([
        { label: "Channels", icon: "hash", active: true },
        { label: "Direct", icon: "message-circle", active: false },
      ])}
      ${iconBtn("bell", 16)}${iconBtn("plus", 19)}
    </span>
  </div>`;

  const body = `<div class="list">
    <div class="search">${icon("search", 16, "var(--textMuted)")}<span>Search chats…</span></div>
    <div class="sec-head"><span>Default channels</span></div>
    ${channelRow({
      name: "bluetooth",
      scope: "Local mesh · Bluetooth only · 4 nearby",
      sender: "amber",
      preview: "anyone near the south gate? mesh is holding here",
      time: "18:46",
      unread: 3,
    })}
    ${channelRow({
      name: "block",
      scope: "City block · ~100m · ~Indiranagar · 12 active",
      sender: "arctic",
      preview: "water station is open, south entrance",
      time: "18:44",
      unread: 0,
    })}
    ${channelRow({
      name: "neighborhood",
      scope: "Neighborhood · ~1km · ~Indiranagar · 48 active",
      sender: "bright",
      preview: "power back on 12th main, still dark on 100ft",
      time: "18:31",
      unread: 7,
    })}
    ${channelRow({
      name: "city",
      scope: "City · ~10km · ~Bengaluru · 240 active",
      sender: "binary",
      preview: "relay list for tonight is pinned to the board",
      time: "17:58",
      unread: 0,
    })}
    ${channelRow({
      name: "region",
      scope: "Region · ~100km · ~Karnataka · 1,904 active",
      sender: "cold",
      preview: "grid status thread, update your area when you can",
      time: "17:20",
      unread: 0,
    })}
    <div class="sec-head"><span>Your channels</span></div>
    ${channelRow({
      name: "9q8yy",
      scope: "Neighborhood · teleported · 31 active",
      sender: "quiet",
      preview: "checking in from out of town, who is still up",
      time: "17:12",
      unread: 0,
      pin: true,
    })}
  </div>`;

  return shell({ platform, ...options, active: "chats", header, body });
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

function walletAction(name, label) {
  return `<span class="wa"><span class="wa-circle">${icon(name, 20, "var(--textInverse)")}</span><span class="wa-label">${label}</span></span>`;
}

function activityRow({ name, title, sub, amount, debit, key }) {
  return `<span class="act">
    ${icon(name, 18, "var(--textSecondary)")}
    <span class="act-text"><span class="act-title"${key ? ` data-key="${key}-title"` : ""}>${title}</span><span class="act-sub"${key ? ` data-key="${key}-sub"` : ""}>${sub}</span></span>
    <span class="act-amt ${debit ? "act-debit" : "act-credit"}">${amount}</span>
  </span>`;
}

const SETTLED = {
  balance: "12,480",
  rows: [
    {
      name: "arrow-down-left",
      title: "Received",
      sub: `2h · ${MINT}`,
      amount: "+500",
    },
    {
      name: "arrow-up-right",
      title: "Sent",
      sub: `5h · ${MINT}`,
      amount: "−1,200",
      debit: true,
    },
    {
      name: "download",
      title: "Lightning top-up",
      sub: `2d · ${MINT}`,
      amount: "+10,000",
    },
  ],
};

// `unconfirmed` is the amount claimed offline that the mint has not seen yet.
// The app states it under the balance and never folds it in.
function walletScreen(
  platform,
  { balance = SETTLED.balance, rows = SETTLED.rows, unconfirmed, ...options } = {},
) {
  const header = `<div class="header"><span class="h-title">Wallet</span>
    <span class="h-controls">${iconBtn("help-circle")}</span></div>`;
  const note =
    unconfirmed === undefined
      ? ""
      : `<span class="balance-note" data-key="note">${icon("clock", 12, "var(--textInverse)")}<span>${unconfirmed} sat not yet confirmed with the mint</span></span>`;
  const body = `<div class="wallet">
    <div class="balance">
      <span class="balance-mark">${pixelBird(22, "var(--textInverse)")}</span>
      <span class="balance-label">Spendable</span>
      <span class="balance-row"><span class="balance-amt" data-key="balance">${balance}</span><span class="balance-unit">sat</span></span>
      ${note}
      <div class="wa-row">
        ${walletAction("arrow-down", "Receive")}${walletAction("arrow-up", "Send")}${walletAction("maximize", "Scan")}${walletAction("database", "Mints")}
      </div>
    </div>
    <span class="backup">${icon("shield", 18, "var(--textSecondary)")}
      <span class="backup-text"><span class="backup-title">Recovery phrase</span><span class="backup-status">Backup on</span></span>
      ${icon("chevron-right", 18, "var(--textMuted)")}</span>
    <span class="sec-label sec-label-loose">Activity</span>
    <div class="act-list">${rows.map(activityRow).join("")}</div>
  </div>`;
  return shell({ platform, ...options, active: "wallet", header, body });
}

// ---------------------------------------------------------------------------
// Mesh, peer list
// ---------------------------------------------------------------------------

function peerListScreen(platform, options = {}) {
  const peers = [
    { ...RADAR_PEERS[0], seen: "now" },
    { ...RADAR_PEERS[1], seen: "now" },
    { ...RADAR_PEERS[2], seen: "now" },
    { ...RADAR_PEERS[3], seen: "2m" },
    {
      name: "cold-brace-51ff",
      id: "51ff8a2c7e04b6d3",
      online: false,
      seen: "6m",
    },
    {
      name: "clear-atom-08c7",
      id: "08c73b91fd526ae4",
      online: false,
      seen: "14m",
    },
    {
      name: "bold-beam-2c60",
      id: "2c6047ab9e1583df",
      online: false,
      seen: "21m",
    },
    {
      name: "azure-bone-d7b8",
      id: "d7b81f34c602ae95",
      online: false,
      seen: "33m",
    },
  ];

  const header = `<div class="header">
    <span class="h-title">Mesh</span>
    <span class="h-controls">
      ${segmented([
        { label: "Radar", icon: "radio", active: false },
        { label: "List", icon: "list", active: true },
      ])}
      ${iconBtn("user-plus")}
    </span>
  </div>`;

  const rows = peers
    .map(
      (p) => `<div class="peer-row">
      ${avatar(p, 46, p.online ? "online" : "offline")}
      <span class="peer-text">
        <span class="peer-name">${p.name}</span>
        <span class="peer-id">${p.id.slice(0, 8)} · ${p.id.slice(8)}</span>
      </span>
      <span class="peer-seen${p.online ? " peer-seen-on" : ""}">${p.seen}</span>
    </div>`,
    )
    .join('<div class="peer-sep"></div>');

  return shell({
    platform,
    ...options,
    active: "mesh",
    header,
    body: `<div class="list">${rows}</div>`,
  });
}

// ---------------------------------------------------------------------------

// Each takes the platform, then options: `offline`, an `id` for the screen's
// root, and whatever the screen itself accepts.
export const SCREENS = {
  radar: radarScreen,
  thread: threadScreen,
  profile: profileScreen,
  chats: chatsScreen,
  wallet: walletScreen,
  peers: peerListScreen,
};

// Every number below traces to a token in src/ui/theme.ts.
export const SCREEN_CSS = `
.screen{position:relative;width:${SCREEN_W}px;height:${SCREEN_H}px;background:var(--bg);
  color:var(--textPrimary);display:flex;flex-direction:column;overflow:hidden;
  font-family:var(--sans);-webkit-font-smoothing:antialiased}
.screen .ic{display:block;flex:none}

/* Status bar */
.statusbar{position:relative;height:54px;flex:none;display:flex;align-items:flex-start;
  justify-content:space-between;padding:16px 26px 0;color:var(--textPrimary)}
.sb-time{font-size:15px;font-weight:600;letter-spacing:0.1px}
.sb-right{display:flex;align-items:center;gap:5px}
.sb-bars-off{opacity:0.28}
.island{position:absolute;top:11px;left:50%;transform:translateX(-50%);width:122px;height:34px;
  border-radius:999px;background:#000}
.punch{position:absolute;top:12px;left:50%;transform:translateX(-50%);width:13px;height:13px;
  border-radius:999px;background:#000}

/* Header */
.header{flex:none;height:56px;display:flex;align-items:center;justify-content:space-between;
  padding:0 16px;border-bottom:1px solid var(--border)}
.header-thread{gap:8px;justify-content:flex-start;padding-left:10px}
.h-title{font-size:17px;font-weight:600;letter-spacing:-0.2px;color:var(--textPrimary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.h-controls{display:flex;align-items:center;gap:8px}
.h-controls-tight{gap:6px}
.h-back{display:flex;align-items:center;padding:0 4px}
.h-dm{display:flex;align-items:center;gap:8px;min-width:0}
.icon-btn{width:34px;height:34px;border-radius:999px;background:var(--surfaceRaised);
  display:flex;align-items:center;justify-content:center;flex:none}
.seg-track{display:flex;background:var(--surfaceRaised);border-radius:999px;padding:2px}
.seg{display:flex;align-items:center;gap:4px;padding:8px 11px;border-radius:999px;
  font-size:13px;font-weight:500;color:var(--textMuted);white-space:nowrap}
.seg-on{background:var(--surface);color:var(--textPrimary);
  box-shadow:0 1px 1px rgba(0,0,0,0.10)}

/* Body + tab bar */
.body{flex:1;min-height:0;overflow:hidden;position:relative}
.tabwrap{position:absolute;left:16px;right:16px;bottom:26px;border-radius:999px;
  box-shadow:0 6px 16px rgba(0,0,0,0.12)}
.tabbar{display:flex;background:var(--surface);border:1px solid var(--border);
  border-radius:999px;padding:4px 0 8px;overflow:hidden}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;padding-bottom:4px}
.tab-ind{width:24px;height:3px;border-radius:2px;background:transparent;margin-bottom:2px}
.tab-ind-on{background:var(--accent)}
.tab-icon{width:22px;height:22px;display:flex;align-items:center;justify-content:center}
.tab-av{border-radius:999px;border:1.5px solid var(--border);display:flex;opacity:0.45}
.tab-av-on{border-color:var(--accent);opacity:1}
.tab-label{font-size:10px;font-weight:500;color:var(--textMuted);letter-spacing:0.1px}
.tab-label-on{color:var(--accent)}
.home-indicator{position:absolute;left:50%;transform:translateX(-50%);bottom:9px;
  width:140px;height:5px;border-radius:3px;background:var(--textPrimary);opacity:0.85}

/* Avatar */
.av{position:relative;border-radius:999px;display:inline-flex;align-items:center;
  justify-content:center;border:1px solid var(--border);flex:none}
.av-txt{font-weight:600;letter-spacing:0.2px;line-height:1}
.av-dot{position:absolute;right:0;bottom:0;border-radius:999px;border-style:solid;
  border-color:var(--bg)}

/* --- Radar ------------------------------------------------------------- */
.radar{height:100%;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:8px;padding-bottom:96px}
.radar-canvas{position:relative}
.ring{position:absolute;border:1px solid var(--borderStrong);border-radius:999px}
.pulse{position:absolute;border:1.5px solid var(--accent);border-radius:999px;opacity:0.14}
.ring-label{position:absolute;font-size:10px;color:var(--textMuted);letter-spacing:0.2px}
.compass{position:absolute;font-size:10px;font-weight:600;color:var(--textMuted);letter-spacing:0.5px}
.self-dot{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:44px;height:44px;
  border-radius:999px;background:var(--accent);display:flex;align-items:center;justify-content:center}
.peer-node{position:absolute;width:34px;display:flex;flex-direction:column;align-items:center}
.peer-label{margin-top:3px;font-size:10px;color:var(--textSecondary);white-space:nowrap}
.radar-status{margin-top:14px;display:flex;flex-direction:column;align-items:center;gap:4px}
.radar-status-main{font-size:15px;font-weight:500;color:var(--textPrimary)}
.radar-status-hint{font-size:12px;color:var(--textMuted)}

/* --- Thread ------------------------------------------------------------ */
.thread{height:100%;padding:12px 16px;display:flex;flex-direction:column;justify-content:flex-end}
.divider{display:flex;justify-content:center;margin-bottom:10px}
.divider span{font-size:11px;color:var(--textMuted);background:var(--surfaceRaised);
  padding:4px 10px;border-radius:999px}
.row{display:flex;padding:2px 0;flex:none;overflow:hidden}
.row-mine{justify-content:flex-end}
.row-theirs{justify-content:flex-start}
.bubble{max-width:75%;padding:10px 12px;border-radius:20px;display:flex;flex-direction:column;gap:2px}
.b-mine{background:var(--myBubble);color:var(--myBubbleText);border-bottom-right-radius:6px}
.b-theirs{background:var(--theirBubble);color:var(--textPrimary);border-bottom-left-radius:6px}
.b-text{font-size:15px;line-height:22px}
.b-meta{align-self:flex-end;display:flex;align-items:center;gap:4px;font-size:11px;line-height:14px}
.b-theirs .b-meta{color:var(--textMuted)}
.b-mine .b-meta{color:var(--textInverse);opacity:0.55}
.b-ticks{position:relative;width:13px;height:13px}
.b-tick{position:absolute;left:0;top:0}
.composer{flex:none;display:flex;align-items:center;gap:10px;padding:8px 12px 34px;
  background:var(--bg);border-top:1px solid var(--border)}
.c-plus{width:36px;height:36px;border-radius:999px;background:var(--surfaceRaised);flex:none;
  display:flex;align-items:center;justify-content:center}
.c-input{flex:1;background:var(--surfaceRaised);border-radius:20px;padding:10px 14px;font-size:15px;
  line-height:20px;min-height:40px}
.c-placeholder{color:var(--textMuted)}
.c-draft{color:var(--textPrimary)}
.c-mic{width:40px;height:40px;flex:none;display:flex;align-items:center;justify-content:center}
.c-send{width:40px;height:40px;flex:none;border-radius:999px;background:var(--accent);
  display:flex;align-items:center;justify-content:center}
/* The bottom 46pt of a store panel fall in its bleed, off the canvas. Chrome
   that has to stay visible sits above that line. */
.thread-raised{padding-bottom:58px}
.composer-raised{padding-bottom:58px}

/* --- Lists ------------------------------------------------------------- */
.list{height:100%;overflow:hidden;padding-bottom:96px}
.search{margin:12px 16px 4px;display:flex;align-items:center;gap:8px;background:var(--surfaceRaised);
  border-radius:12px;padding:11px 12px;font-size:14px;color:var(--textMuted)}
.sec-head{display:flex;align-items:center;padding:16px 16px 8px}
.sec-head span{font-size:11px;font-weight:600;letter-spacing:0.8px;text-transform:uppercase;
  color:var(--textMuted)}
.ch-row{padding:12px 16px;display:flex;flex-direction:column;gap:3px;
  border-bottom:1px solid var(--border)}
.ch-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ch-namegroup{display:flex;align-items:center;gap:5px;min-width:0}
.ch-name{font-size:15px;font-weight:600;color:var(--textPrimary)}
.ch-hash{color:var(--textMuted)}
.ch-meta{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--textPrimary);flex:none}
.ch-scope{font-size:11px;color:var(--textMuted)}
.ch-foot{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ch-preview{font-size:13px;color:var(--textSecondary);white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis}
.ch-sender{color:var(--textMuted)}
.badge{min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--accent);
  color:var(--textInverse);font-size:10px;font-weight:700;display:flex;align-items:center;
  justify-content:center;flex:none}
.peer-row{display:flex;align-items:center;gap:12px;padding:13px 16px;min-height:72px}
.peer-sep{height:1px;background:var(--border);margin-left:62px}
.peer-text{flex:1;display:flex;flex-direction:column;gap:3px;min-width:0}
.peer-name{font-size:15px;font-weight:600;color:var(--textPrimary)}
.peer-id{font-family:var(--mono);font-size:11px;color:var(--textMuted);letter-spacing:0.2px}
.peer-seen{font-size:12px;color:var(--textMuted);flex:none}
.peer-seen-on{color:var(--online)}

/* --- Wallet ------------------------------------------------------------ */
.wallet{height:100%;padding:16px 16px 96px;display:flex;flex-direction:column;gap:12px}
.sec-label{font-size:11px;color:var(--textMuted);letter-spacing:0.8px;text-transform:uppercase;
  padding:0 4px}
.sec-label-loose{margin-top:4px}
/* The accent inverts with the theme, so text on it uses textInverse and dims
   by opacity: the grey tokens are tuned for the page, not this fill. */
.balance{position:relative;background:var(--accent);color:var(--textInverse);border-radius:20px;
  padding:20px;display:flex;flex-direction:column;align-items:center;gap:8px}
.balance-mark{position:absolute;top:20px;right:20px;opacity:0.72;display:flex}
.balance-label{font-size:11px;letter-spacing:0.8px;text-transform:uppercase;opacity:0.72}
.balance-row{display:flex;align-items:flex-end;gap:8px}
.balance-amt{font-size:38px;font-weight:700;line-height:44px;font-variant-numeric:tabular-nums}
.balance-unit{font-size:20px;font-weight:500;opacity:0.72;margin-bottom:4px}
.balance-note{display:flex;align-items:center;gap:4px;font-size:13px;opacity:0.72;height:18px;overflow:hidden}
.wa-row{align-self:stretch;display:flex;justify-content:space-between;margin-top:16px}
.wa{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;padding:4px 0}
.wa-circle{width:48px;height:48px;border-radius:999px;background:var(--onAccentFill);
  display:flex;align-items:center;justify-content:center}
.wa-label{font-size:13px;font-weight:500}
.backup{display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:14px;
  border:1px solid var(--border);background:var(--surface)}
.backup-text{flex:1;display:flex;flex-direction:column}
.backup-title{font-size:15px;font-weight:500}
.backup-status{font-size:13px;color:var(--textMuted)}
.act-list{display:flex;flex-direction:column}
.act{display:flex;align-items:center;gap:12px;padding:12px 4px;border-bottom:1px solid var(--border)}
.act-text{flex:1;display:flex;flex-direction:column;gap:2px}
.act-title{font-size:13px;font-weight:500}
.act-sub{font-size:11px;color:var(--textMuted)}
.act-amt{font-family:var(--mono);font-size:13px;font-weight:600}
.act-credit{color:var(--online)}
.act-debit{color:var(--danger)}

/* --- You --------------------------------------------------------------- */
.you{padding:0 16px 120px}
.you-head{display:flex;justify-content:space-between;padding:8px 0 0}
.p-identity{display:flex;flex-direction:column;align-items:center;gap:6px;padding:0 0 16px}
.p-avatar{position:relative;display:flex}
.p-status{position:absolute;right:4px;bottom:4px;width:18px;height:18px;border-radius:999px;
  background:var(--online);border:3px solid var(--bg)}
.p-name{font-size:22px;font-weight:700;letter-spacing:-0.3px;margin-top:6px}
.p-state{font-size:13px;color:var(--textMuted)}
.p-pills{display:flex;gap:10px;padding-bottom:18px}
.p-pill{flex:1;display:flex;align-items:center;justify-content:center;gap:7px;
  border:1px solid var(--border);border-radius:999px;padding:10px;font-size:13px;
  font-weight:500;color:var(--textSecondary)}
.group{background:var(--surface);border:1px solid var(--border);border-radius:14px;
  overflow:hidden;margin-bottom:14px}
.group-div{height:1px;background:var(--border);margin-left:16px}
.div-icon{margin-left:46px}
.set-row{display:flex;align-items:center;gap:12px;padding:13px 16px}
.set-icon{flex:none;display:flex}
.set-text{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0}
.set-label{font-size:15px;font-weight:500;color:var(--textPrimary)}
.set-desc{font-size:11px;line-height:15px;color:var(--textMuted)}
.set-value{font-size:13px;color:var(--textMuted);margin-right:-6px}
.switch{width:44px;height:26px;border-radius:999px;background:var(--surfacePressed);flex:none;
  display:flex;align-items:center;padding:3px}
.switch-on{background:var(--accent);justify-content:flex-end}
.knob{width:20px;height:20px;border-radius:999px;background:var(--surface);
  box-shadow:0 1px 2px rgba(0,0,0,0.2)}
.switch-on .knob{background:var(--textInverse)}
.panic{border-color:var(--danger);background:var(--dangerDim)}
.panic-label{color:var(--danger)}
`;
