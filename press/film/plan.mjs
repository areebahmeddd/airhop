// The edit: when everything happens. Picture (src/timeline.js) and sound
// (scripts/score.mjs) both read the plan this file builds, so neither can drift.
//
// The narration leads. Each scene lists its lines, and a line starts on the
// next quarter beat after the one before it ends, so speech sits on the music's
// grid without being squeezed to fit it. A scene is then as many whole bars as
// its lines need. Rewrite a line, regenerate it, and the cut re-times itself.
//
// 100 BPM puts a beat on exactly 36 frames at 60 fps, and a quarter beat on 9,
// so every time here is a whole frame.

export const BPM = 100;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;

const snap = (t, grid = BEAT / 4) => Math.ceil(t / grid - 1e-6) * grid;

// `lines` is [id, beats of air before it]. `lead` and `tail` are beats of
// picture with no speech at either end. `music` names the arrangement in
// scripts/score.mjs. `beats` pins a scene whose length is set by its action, not its
// lines; it may be a function of the clip lengths.
//
// A scene that changes the arrangement starts a chapter, and chapters begin on
// a bar line so the music can turn there. Scenes inside a chapter only need to
// land on a beat, which saves a second or more at every join.
const SCENES = [
  {
    id: "earth",
    music: "air",
    lead: 3.5,
    tail: 0.5,
    lines: [
      ["e1", 0],
      ["e2", 1],
    ],
  },
  {
    id: "lost",
    music: "light",
    lead: 0.5,
    tail: 1.5,
    lines: [
      ["l1", 0],
      ["l2a", 0.5],
      ["l2b", 0.25],
      ["l2c", 0.25],
      ["l2d", 0.25],
      ["l3", 1],
    ],
  },
  {
    id: "idea",
    music: "pulse",
    lead: 1,
    tail: 3,
    lines: [
      ["i1", 0],
      ["i2", 2.5],
    ],
  },
  {
    id: "mark",
    music: "full",
    lead: 0.5,
    tail: 1.5,
    lines: [
      ["m1", 0],
      ["m2", 1],
    ],
  },
  { id: "mesh", music: "full", lead: 1.5, tail: 1, lines: [["h1", 0]] },
  {
    id: "hops",
    music: "full",
    lead: 1,
    tail: 1,
    lines: [
      ["h2", 0],
      ["h3", 1],
      ["h4", 1.5],
    ],
  },
  {
    id: "turn",
    music: "break",
    lead: 0.5,
    tail: 0.5,
    lines: [
      ["t1", 0],
      ["t2", 1.5],
    ],
  },
  {
    id: "identity",
    music: "full",
    lead: 1,
    tail: 2,
    lines: [
      ["d1", 0],
      ["d2", 0.5],
      ["d3", 0.5],
    ],
  },
  {
    id: "nostr",
    music: "full",
    lead: 1,
    tail: 1,
    lines: [
      ["n1", 0],
      ["n2", 0.5],
      ["n3", 1],
      ["n4", 0.5],
      ["n5", 1],
    ],
  },
  {
    id: "more",
    music: "cuts",
    lead: 0.5,
    tail: 0.5,
    lines: [
      ["r1", 0],
      ["r2", 0.5],
      ["r3", 0.25],
      ["r4", 0.25],
      ["r5", 0.25],
      ["r6", 0.25],
      ["r7", 0.25],
    ],
  },
  {
    id: "wallet",
    music: "half",
    lead: 0.5,
    lines: [["w1", 0]],
    // The demo runs 19 beats, then Cashu is explained over the settled wallet.
    beats: (seconds) => 19.5 + (seconds("w4") + seconds("w5") + seconds("w3")) / BEAT + 5,
  },
  {
    id: "bitchat",
    music: "full",
    lead: 1,
    tail: 1,
    lines: [
      ["b1", 0],
      ["b2", 0.5],
      ["b3", 0.25],
      ["b4", 0.25],
      ["b5", 0.25],
      ["b6", 0.25],
      ["b7", 0.25],
      ["b8", 0.25],
    ],
  },
  {
    id: "crypto",
    music: "light",
    lead: 0.5,
    tail: 1,
    lines: [
      ["c1", 0],
      ["c2", 0.5],
      ["c3", 0.25],
      ["c4", 0.25],
      ["c5", 0.75],
    ],
  },
  {
    id: "nothing",
    music: "cuts",
    lead: 0.5,
    tail: 0.5,
    lines: [
      ["x1", 0],
      ["x2", 0.25],
      ["x3", 0.25],
      ["x4", 0.25],
    ],
  },
  {
    id: "leaving",
    music: "cuts",
    lead: 1.5,
    tail: 4,
    lines: [
      ["x5", 0],
      ["x6", 3.5],
    ],
  },
  {
    id: "notdone",
    music: "out",
    lead: 0.5,
    tail: 1,
    lines: [
      ["z1", 0],
      ["z2", 0.5],
    ],
    extra: 4.5,
  },
  { id: "end", music: "end", beats: 16, lead: 1, lines: [["f1", 0]] },
];

export function buildPlan(vo) {
  const seconds = (id) => {
    if (vo[id] === undefined) throw new Error(`plan: no narration clip for "${id}". Run npm run narrate.`);
    return vo[id].seconds;
  };

  const scenes = {};
  const L = {};
  const E = {};
  let start = 0;
  SCENES.forEach((spec, index) => {
    let cursor = start + spec.lead * BEAT;
    for (const [id, gap] of spec.lines) {
      const at = snap(cursor + gap * BEAT);
      L[id] = at;
      E[id] = at + seconds(id);
      cursor = E[id];
    }
    const next = SCENES[index + 1];
    const turns = next === undefined || next.music !== spec.music;
    const pinned = typeof spec.beats === "function" ? spec.beats(seconds) : spec.beats;
    const needed =
      pinned === undefined ? cursor - start + ((spec.tail ?? 0) + (spec.extra ?? 0)) * BEAT : pinned * BEAT;
    const end = snap(start + needed, turns ? BAR : BEAT);
    scenes[spec.id] = { start, end, music: spec.music };
    start = end;
  });
  const duration = start;
  const S = (id, beats = 0) => scenes[id].start + beats * BEAT;

  // Lines a scene places by its action, not by the line before.
  const place = (id, at) => {
    L[id] = snap(at);
    E[id] = L[id] + seconds(id);
  };

  // -------------------------------------------------------------------------
  // Named moments. timeline.js animates to these; the cue sheet below sounds them.
  // -------------------------------------------------------------------------

  const T = {};
  const spread = (from, to, count) =>
    Array.from({ length: count }, (_, i) => from + ((to - from) * i) / Math.max(1, count - 1));

  // Earth: one light, the pull back, then down to one street on the second line.
  T.seed = 0.15;
  T.pull = S("earth", 1);
  T.dive = L.e2 - BEAT * 0.5;
  T.route = L.e2 + BEAT;
  T.tags = spread(L.e2 + seconds("e2") * 0.55, E.e2 + BEAT * 0.5, 3);

  // Lost: the route dies under the first line, then four places it happens.
  T.dead = spread(L.l1 + 0.1, L.l1 + 0.1 + BEAT, 3);
  T.places = ["l2a", "l2b", "l2c", "l2d"].map((id) => L[id]);
  T.quiet = L.l3;
  T.stop = L.l3 - BEAT * 0.5;

  // Idea: a ring out, a ring back, a link. Then strangers join and one message
  // crosses them.
  T.ring = L.i1 + seconds("i1") * 0.45;
  T.answer = E.i1 + BEAT * 0.75;
  T.link = T.answer + BEAT * 0.75;
  T.pullback = L.i2;
  T.join = L.i2 + BEAT * 0.5;
  T.relay = E.i2 + BEAT * 0.5;
  T.fold = S("mark");

  // Mark: the mesh lands as the bird on the downbeat, the name on its word.
  T.lockup = L.m1 + seconds("m1") * 0.45;
  T.tagline = L.m2;
  T.markOut = scenes.mark.end - 0.4;

  // Mesh: the phone arrives, peers appear through the back half of the line.
  T.meshIn = S("mesh", 0.25);
  T.peers = spread(L.h1 + seconds("h1") * 0.28, L.h1 + seconds("h1") * 0.78, 4);
  T.meshWord = L.h1 + seconds("h1") * 0.8;
  T.sonarTap = E.h1 + BEAT * 0.5;
  T.meshOut = scenes.mesh.end - 0.36;

  // Hops: four arrivals across the line, the push in on "sealed", the courier.
  T.chainIn = S("hops", 0.1);
  T.packet = L.h2;
  T.hops = spread(L.h2 + seconds("h2") * 0.3, L.h2 + seconds("h2") * 0.95, 4);
  T.seal = L.h3;
  T.cantOpen = L.h3 + seconds("h3") * 0.55;
  T.sealOut = E.h3 + BEAT * 0.5;
  T.courier = L.h4;
  T.carry = L.h4 + seconds("h4") * 0.35;
  T.handover = E.h4 - 0.3;
  T.hopsOut = scenes.hops.end - 0.36;

  // The turn.
  T.ask = L.t1;
  T.typing = E.t1 + BEAT * 0.4;
  T.reply = L.t2;
  T.turnOut = scenes.turn.end - 0.3;

  // Identity: key generation under the first two lines, the name on the third.
  T.idIn = S("identity", 0.1);
  T.keys = spread(L.d1 + 0.2, L.d2 + seconds("d2") * 0.8, 4);
  T.reveal = L.d3;
  T.named = L.d3 + seconds("d3") * 0.55;
  T.none = E.d3 + BEAT * 0.75;
  T.idOut = scenes.identity.end - 0.36;

  // Nostr.
  T.globeIn = S("nostr", 0.1);
  T.tooFar = L.n1 + 0.2;
  T.nostrWord = E.n1 - 0.55;
  T.relays = L.n2;
  T.notOurs = E.n2 - 0.9;
  T.wrapped = L.n3 + 0.3;
  T.arrived = E.n3;
  T.tor = L.n4;
  T.anywhere = L.n5;
  T.nostrOut = scenes.nostr.end - 0.36;

  // And more: one card per line, cut on the line.
  T.more = L.r1;
  T.cards = ["r2", "r3", "r4", "r5", "r6", "r7"].map((id) => L[id]);
  T.cardsEnd = scenes.more.end;
  T.switchOn = [L.r5 + seconds("r5") * 0.45, L.r6 + seconds("r6") * 0.5];

  // Wallet: action sets the pace, in beats from the top of the scene.
  const w = (beats) => S("wallet", beats);
  T.money = L.w1;
  T.moneyOut = w(2.75);
  T.phoneA = w(2.75);
  T.plus = w(4.5);
  T.ecashRow = w(6);
  T.digits = [w(7.5), w(8), w(8.5)];
  T.memo = w(9);
  T.memoEnd = w(10);
  T.sheetSend = w(10.75);
  T.alert = w(11.1);
  T.confirm = w(12.5);
  T.tokenOut = w(13);
  T.fly = w(14);
  T.land = w(15);
  T.claim = w(16.5);
  T.claimed = w(17.5);
  T.walletScreen = w(19);
  place("w2", w(5));
  place("w4", w(19.75));
  place("w5", E.w4 + BEAT * 0.5);
  T.cashu = L.w5;
  T.banknote = L.w5 + seconds("w5") * 0.5;
  place("w3", E.w5 + BEAT * 0.75);
  T.online = L.w3;
  T.settled = L.w3 + seconds("w3") * 0.55;
  T.walletOut = scenes.wallet.end - 0.4;

  // bitchat: the handshake, then one line of the list per clause.
  T.pair = L.b1 + seconds("b1") * 0.3;
  T.talk = E.b1 - 0.7;
  T.kept = L.b2;
  T.gains = ["b3", "b4", "b5", "b6", "b7", "b8"].map((id) => L[id]);
  T.bitchatOut = scenes.bitchat.end - 0.36;

  // Cryptography.
  T.notInvented = L.c1;
  T.point = E.c1 - 0.8;
  T.proven = ["c2", "c3", "c4"].map((id) => L[id]);
  T.words = spread(L.c5, L.c5 + seconds("c5") * 0.5, 3);
  T.easy = L.c5 + seconds("c5") * 0.62;
  T.cryptoOut = scenes.crypto.end - 0.36;

  // Nothing to hand over.
  T.nothing = ["x1", "x2", "x3", "x4"].map((id) => L[id]);
  T.rule = E.x4 - 0.35;
  T.nothingOut = scenes.nothing.end - 0.3;

  // Leaving: scroll the real settings list to its end, move to a new phone,
  // then three taps.
  T.youIn = S("leaving", 0.1);
  T.scroll = S("leaving", 0.75);
  T.transferTap = L.x5 + seconds("x5") * 0.22;
  T.newPhone = L.x5 + seconds("x5") * 0.3;
  T.moving = L.x5 + seconds("x5") * 0.5;
  T.moved = E.x5 + BEAT * 0.5;
  T.erased = T.moved + BEAT * 0.5;
  T.toNew = T.moved + BEAT * 1.25;
  T.taps = [0, 1, 2].map((i) => E.x6 - 0.75 + (i * BEAT) / 3);
  T.wipe = T.taps[2];
  T.welcome = T.wipe + BEAT * 2;
  T.leavingOut = scenes.leaving.end - 0.36;

  // Not done.
  T.typed = L.z1;
  T.soon = L.z2;
  T.roadmap = Array.from({ length: 8 }, (_, i) => snap(E.z2 + BEAT * 0.25) + i * BEAT * 0.5);
  T.notdoneOut = scenes.notdone.end - 0.3;

  // End: white, the bird crosses, comes at the lens, and its black is the
  // background the mark sits on.
  const f = (beats) => S("end", beats);
  T.white = f(0);
  T.flyIn = f(0.25);
  T.lunge = [f(3), f(4)];
  T.final = f(4);
  place("f2", f(5.5));
  T.open = L.f2;
  T.url = E.f2 + BEAT * 0.5;
  place("f3", snap(E.f2 + BEAT * 1.5));
  T.lets = L.f3;
  T.fade = duration - 1;

  // -------------------------------------------------------------------------
  // Sound cues. `kind` is a file in assets/sfx/.
  // -------------------------------------------------------------------------

  const cues = [];
  const cue = (kind, time, gain = 1) => cues.push({ kind, time: Number(time.toFixed(4)), gain });
  const taps = (times, gain = 1) => times.forEach((t) => cue("click", t, gain));

  cue("ping", T.seed, 0.5);
  cue("whoosh-cinematic", T.dive - 0.2, 0.7);
  T.tags.forEach((t) => cue("key-press", t, 0.7));
  T.dead.forEach((t, i) => cue("error", t, 0.5 - i * 0.12));
  T.places.forEach((t, i) => cue(i % 2 === 0 ? "impact-bass-1" : "impact-bass-2", t, 0.75));
  cue("ping", T.ring, 0.8);
  cue("ping", T.answer, 0.8);
  cue("pop", T.link, 0.8);
  cue("riser", T.fold - 10.03, 0.55);
  cue("impact-bass-2", T.fold - 0.05, 1);
  cue("whoosh-short", T.meshIn, 0.6);
  T.peers.forEach((t) => cue("pop", t, 0.7));
  cue("ping", T.sonarTap, 0.6);
  cue("pop", T.packet, 0.7);
  T.hops.forEach((t, i) => cue("click-soft", t, 0.9 + i * 0.1));
  cue("whoosh", T.seal - 0.1, 0.6);
  cue("error", T.cantOpen, 0.35);
  cue("whoosh-short", T.courier, 0.5);
  cue("notification", T.handover, 0.5);
  cue("pop", T.ask, 1);
  cue("pop", T.reply, 1);
  cue("whoosh-short", T.idIn, 0.6);
  T.keys.forEach((t) => cue("key-press", t, 0.8));
  cue("pop", T.named, 0.8);
  cue("whoosh", T.globeIn, 0.6);
  cue("impact-bass-1", T.nostrWord, 0.6);
  cue("sparkle", T.relays + 0.3, 0.4);
  cue("notification", T.arrived, 0.5);
  cue("whoosh-short", T.more, 0.6);
  T.cards.forEach((t) => cue("whoosh-short", t - 0.05, 0.5));
  T.switchOn.forEach((t) => cue("click", t, 0.9));
  cue("impact-bass-1", T.money, 0.8);
  cue("whoosh-short", T.phoneA, 0.5);
  taps([T.plus, T.ecashRow, T.sheetSend, T.confirm, T.claim], 0.9);
  T.digits.forEach((t) => cue("key-press", t, 0.9));
  cue("typing", T.memo, 0.5);
  cue("pop", T.tokenOut, 0.8);
  cue("whoosh-short", T.fly, 0.5);
  cue("pop", T.land, 0.8);
  cue("impact-bass-1", T.cashu, 0.5);
  cue("chime", T.settled, 0.7);
  cue("pop", T.talk, 0.7);
  T.gains.forEach((t) => cue("pop", t, 0.6));
  T.proven.forEach((t) => cue("impact-bass-1", t, 0.45));
  T.nothing.forEach((t) => cue("impact-bass-2", t - 0.05, 0.7));
  cue("whoosh-short", T.youIn, 0.5);
  cue("click", T.transferTap, 0.9);
  cue("chime", T.moved, 0.6);
  taps(T.taps, 1);
  cue("glitch-1", T.wipe + 0.05, 0.8);
  cue("typing", T.typed, 0.5);
  T.roadmap.forEach((t) => cue("key-press", t, 0.7));
  cue("whoosh", T.lunge[0], 0.8);
  cue("impact-bass-2", T.final - 0.05, 1);

  const lines = Object.keys(L).map((id) => ({ id, start: Number(L[id].toFixed(4)), seconds: seconds(id) }));
  lines.sort((a, b) => a.start - b.start);
  for (let i = 1; i < lines.length; i++) {
    const before = lines[i - 1];
    if (before.start + before.seconds > lines[i].start + 1e-6) {
      throw new Error(`plan: "${before.id}" runs into "${lines[i].id}"`);
    }
  }

  return { BPM, BEAT, BAR, duration, scenes, L, E, T, lines, cues };
}
