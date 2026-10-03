// The trailer's cut. One paused GSAP timeline, placed at the moments
// trailer/plan.mjs names, under the same three rules as the film's:
//   1. Every start state is set once at load, then tweened with to().
//   2. Anything that is text or a loop is a function of t in `frame`, run from
//      the timeline's onUpdate.
//   3. No clocks, no unseeded randomness, no infinite repeats.
//
// The grammar is the film's, faster: a shot opens on its downbeat, words land
// on beats, and a shot ends on a hard cut rather than animating out, so the
// next downbeat is the only transition.

function init() {
  const { BEAT, BAR, T, shots, duration } = PLAN;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) =>
    Array.from(root.querySelectorAll(selector));
  const key = (root, name) => $('[data-key="' + name + '"]', root);

  const tl = gsap.timeline({
    paused: true,
    defaults: { ease: "power3.out", duration: 0.4 },
  });
  const frame = [];

  // Measure before anything moves: where a finger lands, where a token starts
  // and ends, how tall a bubble is once it has arrived.
  const centre = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const targets = new Map();
  const heights = new Map();
  $$("[data-key], .row").forEach((el) => {
    targets.set(el, centre(el));
    heights.set(el, el.offsetHeight);
  });

  // -------------------------------------------------------------------------
  // Vocabulary
  // -------------------------------------------------------------------------

  const hidden = (el, vars = {}) => gsap.set(el, { autoAlpha: 0, ...vars });
  const cut = (el, t) => tl.set(el, { autoAlpha: 0 }, t);

  function enter(
    el,
    t,
    { x = 0, y = 24, duration = 0.4, ease = "expo.out" } = {},
  ) {
    hidden(el, { x, y });
    tl.to(el, { autoAlpha: 1, x: 0, y: 0, duration, ease }, t);
  }

  // Large and soft to sharp, inside a beat.
  function slam(el, t, { from = 1.24, blur = 12, duration = 0.34 } = {}) {
    hidden(el, { scale: from, filter: `blur(${blur}px)` });
    tl.to(
      el,
      {
        autoAlpha: 1,
        scale: 1,
        filter: "blur(0px)",
        duration,
        ease: "power4.out",
      },
      t,
    );
  }

  const ENTRANCES = [
    (el, t) => slam(el, t),
    (el, t) => enter(el, t, { x: -200, y: 0 }),
    (el, t) => enter(el, t, { y: 80, ease: "circ.out" }),
  ];
  function lines(id, times, offset = 0) {
    const els = $$(`#${id} .stack-line`);
    els.forEach((el, i) =>
      ENTRANCES[(i + offset) % ENTRANCES.length](el, times[i]),
    );
    return els;
  }

  function phoneIn(id, t) {
    const el = $(`#${id}`);
    hidden(el, { y: 140, scale: 0.94 });
    tl.to(
      el,
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.5, ease: "expo.out" },
      t,
    );
    return el;
  }

  // The camera on a phone: the outer wrapper scales about the phone's centre
  // and the inner one slides, so stage point `p` comes to rest at `d`. Returns
  // where any measured point sits once the camera has settled.
  function focus(id, p, d, scale, t, duration) {
    const outer = $(`#cam-${id}`);
    const inner = outer.firstElementChild;
    const [ox, oy] = outer.style.transformOrigin.split(" ").map(parseFloat);
    const x = (d.x - ox) / scale - (p.x - ox);
    const y = (d.y - oy) / scale - (p.y - oy);
    const ease = "power3.inOut";
    tl.to(outer, { scale, duration, ease }, t);
    tl.to(inner, { x, y, duration, ease }, t);
    return (q) => ({
      x: ox + scale * (q.x + x - ox),
      y: oy + scale * (q.y + y - oy),
    });
  }

  const touch = $("#touch");
  const touchRing = $("#touch-ring");
  hidden(touch, { scale: 1.5 });
  hidden(touchRing);

  function tap(p, t) {
    tl.set(touch, { x: p.x, y: p.y, scale: 1.4 }, t - 0.2);
    tl.to(
      touch,
      { autoAlpha: 1, scale: 1, duration: 0.14, ease: "power2.out" },
      t - 0.19,
    );
    tl.to(touch, { scale: 0.78, duration: 0.06, ease: "power2.in" }, t - 0.06);
    tl.to(
      touch,
      { scale: 1.1, autoAlpha: 0, duration: 0.18, ease: "power2.out" },
      t + 0.03,
    );
    tl.set(touchRing, { x: p.x, y: p.y, scale: 0.8, autoAlpha: 0.7 }, t);
    tl.to(
      touchRing,
      { scale: 1.9, autoAlpha: 0, duration: 0.35, ease: "power2.out" },
      t + 0.001,
    );
  }

  // A bubble arriving: the thread makes room, then the bubble settles from its
  // own corner.
  function grow(row, t) {
    const bubble = $(".bubble", row);
    const mine = row.classList.contains("row-mine");
    gsap.set(row, { height: 0, autoAlpha: 0 });
    gsap.set(bubble, {
      scale: 0.86,
      transformOrigin: mine ? "100% 100%" : "0% 100%",
    });
    tl.to(
      row,
      { height: heights.get(row), duration: 0.25, ease: "power3.out" },
      t,
    );
    tl.to(row, { autoAlpha: 1, duration: 0.12, ease: "none" }, t + 0.03);
    tl.to(bubble, { scale: 1, duration: 0.35, ease: "expo.out" }, t + 0.02);
  }

  function ticks(row, times) {
    const glyphs = ["sending", "sent", "delivered"].map((s) =>
      $(`.b-tick-${s}`, row),
    );
    hidden(glyphs[1]);
    hidden(glyphs[2]);
    times.forEach((t, i) => {
      tl.set(glyphs[i], { autoAlpha: 0 }, t);
      tl.set(glyphs[i + 1], { autoAlpha: 1 }, t);
    });
  }

  function swap(el, steps) {
    frame.push((t) => {
      let value = steps[0][1];
      for (const [time, text] of steps) if (t >= time) value = text;
      if (el.textContent !== value) el.textContent = value;
    });
  }

  function type(el, text, t0, perChar) {
    frame.push((t) => {
      const n =
        t < t0 ? 0 : Math.min(text.length, Math.floor((t - t0) / perChar) + 1);
      const value = text.slice(0, n);
      if (el.textContent !== value) el.textContent = value;
    });
  }

  function hex(n, salt) {
    let h = (salt * 2654435761) >>> 0;
    let out = "";
    for (let i = 0; i < n; i++) {
      h = (h * 1664525 + 1013904223) >>> 0;
      out += (h >>> 28).toString(16);
    }
    return out;
  }

  const next = (id) => shots[id].end;
  const street = W.street;
  const globe = W.globe;

  // -------------------------------------------------------------------------
  // Open. The bars go one at a time, tallest first, the way a signal leaves.
  // -------------------------------------------------------------------------

  {
    const sig = $("#sig");
    const bars = $$("#sig-bars .bar");
    const wifi = $("#sig-wifi");
    hidden(sig, { y: 250, scale: 0.9 });
    tl.to(
      sig,
      { autoAlpha: 1, scale: 1, duration: 0.45, ease: "expo.out" },
      0.02,
    );
    [...bars]
      .reverse()
      .forEach((bar, n) =>
        tl.to(bar, { opacity: 0.14, duration: 0.08, ease: "none" }, T.drops[n]),
      );
    tl.to(sig, { y: 0, duration: 0.4, ease: "expo.out" }, T.noSignal);
    slam($("#no-signal"), T.noSignal);

    hidden(wifi);
    tl.set($("#sig-bars"), { autoAlpha: 0 }, T.noWifi);
    tl.set(wifi, { autoAlpha: 1 }, T.noWifi);
    cut($("#no-signal"), T.noWifi);
    slam($("#no-wifi"), T.noWifi);
    cut([sig, $("#no-wifi")], T.roll);
  }

  // -------------------------------------------------------------------------
  // Mesh. Two phones find each other, then every stranger's phone joins.
  // -------------------------------------------------------------------------

  const rings = [];
  {
    gsap.set(street, {
      a: 0,
      z: 1,
      cy: 540,
      others: 0,
      dim: 1,
      links: 1,
      bird: 0,
    });
    tl.set(street, { a: 1 }, T.drop);
    rings.push({ node: 0, t0: T.drop, reach: 1, life: 1.2 });
    rings.push({ node: 1, t0: T.answer, reach: 1, life: 1.2 });
    const direct = WORLD.links.find((l) => l.a === 0 && l.b === 1);
    direct.born = T.answer;

    tl.set(street, { others: 1 }, T.pullback);
    tl.to(street, { z: 0.42, duration: 1.2, ease: "power2.inOut" }, T.pullback);
    const join = 0.045;
    WORLD.order.forEach((index, n) => {
      if (index < 2) return;
      const t = T.pullback + 0.1 + (n - 2) * join;
      WORLD.nodes[index].born = t;
      rings.push({ node: index, t0: t, reach: 0.62, life: 0.8 });
    });
    for (const link of WORLD.links) {
      if (link !== direct)
        link.born =
          Math.max(WORLD.nodes[link.a].born, WORLD.nodes[link.b].born) + 0.1;
    }
    slam($("#still"), T.drop, { from: 1.12 });
    cut($("#still"), T.fold - 0.5);
  }
  WORLD.setRings(rings);
  WORLD.setHops([]);

  // -------------------------------------------------------------------------
  // Mark. Every phone in the mesh is a pixel of it, and it lands on the one.
  // -------------------------------------------------------------------------

  {
    gsap.set(street, { birdCx: 960, birdCy: 470, cell: 46 });
    tl.to(
      street,
      { bird: 1, duration: 0.56, ease: "expo.inOut" },
      T.fold - 0.5,
    );
    tl.to(
      street,
      {
        birdCx: 648,
        birdCy: 480,
        cell: 30,
        duration: 0.5,
        ease: "power3.inOut",
      },
      T.lockup - 0.3,
    );
    const letters = $$("#word span");
    hidden(letters, { x: -20 });
    tl.to(
      letters,
      { autoAlpha: 1, x: 0, duration: 0.3, stagger: 0.04 },
      T.lockup,
    );
    enter($("#intro-tag"), T.tagline, { y: 16 });
    cut([...letters, $("#intro-tag")], next("mark"));
    tl.set(street, { a: 0 }, next("mark"));
  }

  // -------------------------------------------------------------------------
  // Radar. Peers with no network at all.
  // -------------------------------------------------------------------------

  {
    const phone = phoneIn("ph-radar", T.radar);
    const radar = $("#sc-radar");
    const canvas = $(".radar-canvas", radar);
    const template = $(".pulse", radar);
    const sonar = [0, 0.9, 1.8].map((offset) => {
      const el = template.cloneNode();
      canvas.insertBefore(el, template);
      return { el, offset };
    });
    template.style.opacity = "0";
    frame.push((t) => {
      if (t < T.radar - 0.1 || t > next("radar") + 0.1) return;
      for (const { el, offset } of sonar) {
        const p = ((((t - offset) % 2.8) + 2.8) % 2.8) / 2.8;
        el.style.transform = `scale(${0.05 + 0.95 * p})`;
        el.style.opacity = String(
          0.28 * Math.sin(Math.PI * Math.min(1, p * 1.15)),
        );
      }
    });
    $$(".peer-node", radar).forEach((peer, n) => {
      hidden(peer, { scale: 0.4, transformOrigin: "50% 17px" });
      tl.to(
        peer,
        { autoAlpha: 1, scale: 1, duration: 0.4, ease: "expo.out" },
        T.peers[n],
      );
    });
    swap($(".radar-status-main", radar), [
      [0, "Scanning for nearby peers…"],
      ...T.peers.map((t, n) => [
        t,
        `${n + 1} ${n === 0 ? "peer" : "peers"} in range`,
      ]),
    ]);
    const title = lines("k-mesh", [T.radar, T.radar + BEAT * 0.5], 1);
    cut([phone, ...title], next("radar"));
  }

  // -------------------------------------------------------------------------
  // Thread. The conversation, end to end encrypted by default.
  // -------------------------------------------------------------------------

  {
    const phone = phoneIn("ph-thread", T.thread);
    // A thread sits at the bottom of its screen, so the camera starts close on
    // it and keeps drifting in.
    const bubbles = { x: 1400, y: 790 };
    focus("ph-thread", bubbles, { x: 1340, y: 560 }, 1.35, T.thread, 0);
    focus(
      "ph-thread",
      bubbles,
      { x: 1340, y: 560 },
      1.5,
      T.thread + 0.05,
      BAR - 0.1,
    );
    const rows = $$("#sc-thread .row");
    rows.slice(-T.bubbles.length).forEach((row, n) => grow(row, T.bubbles[n]));
    const title = lines("k-e2e", [T.thread, T.thread + BEAT], 1);
    cut([phone, ...title], next("thread"));
  }

  // -------------------------------------------------------------------------
  // Relay. What a stranger's phone holds: who it is for, and bytes it cannot
  // open.
  // -------------------------------------------------------------------------

  {
    const xs = [360, 660, 960, 1260, 1560];
    const packet = $("#packet");
    const pieces = $$("#chain-line, #chain .cnode, #chain .clabel");
    hidden(pieces);
    tl.to(
      pieces,
      { autoAlpha: 1, duration: 0.25, stagger: 0.02, ease: "none" },
      T.chain,
    );
    hidden(packet, { x: xs[0], scale: 0.7 });
    tl.to(
      packet,
      { autoAlpha: 1, scale: 1, duration: 0.3, ease: "expo.out" },
      T.chain + 0.15,
    );
    T.hops.forEach((t, i) => {
      tl.to(
        packet,
        { x: xs[i + 1], duration: 0.22, ease: "power2.inOut" },
        t - 0.22,
      );
      const node = $(`#cnode-${i + 1}`);
      if (i < 3) {
        tl.to(
          node,
          { borderColor: "#F5F5F5", duration: 0.08, ease: "none" },
          t - 0.03,
        );
        tl.to(node, { borderColor: "#3D3D3D", duration: 0.4 }, t + 0.1);
        enter($(`#csees-${i + 1}`), t, { y: 10, duration: 0.3 });
      } else {
        tl.to(
          node,
          { borderColor: "#22C55E", color: "#22C55E", duration: 0.15 },
          t,
        );
      }
    });
    frame.push((t) => {
      if (t < T.chain || t > next("relay")) return;
      const tick = Math.floor(t / 0.09);
      for (let i = 1; i <= 3; i++) {
        const raw = hex(16, tick * 7 + i);
        $(`#cipher-${i}`).textContent =
          `${raw.slice(0, 4)} ${raw.slice(4, 8)} ${raw.slice(8, 12)} ${raw.slice(12)}`;
      }
    });
    const title = lines("k-relay", [T.chain, T.unreadable], 1);
    cut([...pieces, packet, ...$$("#chain .csees"), ...title], next("relay"));
  }

  // -------------------------------------------------------------------------
  // Key. No account to make, one key to hold.
  // -------------------------------------------------------------------------

  {
    const words = T.key.map((t, i) => {
      const el = $(`#key-${i}`);
      slam(el, t);
      return el;
    });
    cut(words[0], T.key[1]);
    cut(words[1], T.key[2]);
    const id = $("#peer-id");
    type(id, id.dataset.text, T.peerId, 0.022);
    cut([words[2], id], next("key"));
  }

  // -------------------------------------------------------------------------
  // Globe. Out of Bluetooth range, over independent relays, and through Tor.
  // -------------------------------------------------------------------------

  {
    gsap.set(globe, {
      a: 0,
      r: 420,
      cx: 1300,
      cy: 540,
      lon: 58,
      lat: 30,
      lights: 0,
      talk: 0,
      relays: 0,
      arcs: 0,
      far: 0,
      wire: 0,
      tor: 0,
      ends: 0,
    });
    tl.set(globe, { a: 1 }, T.globe);
    tl.to(
      globe,
      { lon: 40, duration: next("globe") - T.globe, ease: "none" },
      T.globe,
    );
    tl.to(globe, { relays: 1, duration: 1, ease: "power1.out" }, T.globe);
    tl.to(globe, { arcs: 1, duration: 1.2, ease: "power1.out" }, T.globe + 0.1);
    tl.to(globe, { ends: 1, duration: 0.25 }, T.globe + 0.15);
    tl.to(globe, { far: 1, duration: 0.5, ease: "power1.out" }, T.globe + 0.25);
    tl.to(
      globe,
      { wire: 1, duration: T.nostr - T.globe - 0.2, ease: "power1.inOut" },
      T.globe + 0.45,
    );
    tl.to(globe, { tor: 1, duration: 0.45, ease: "power2.out" }, T.tor);
    const far = lines("k-far", [T.globe, T.globe + 0.25], 1);
    cut(far, T.nostr);
    const nostr = lines("k-nostr", [T.nostr, T.tor]);
    cut(nostr, next("globe"));
    tl.set(globe, { a: 0 }, next("globe"));
  }

  // -------------------------------------------------------------------------
  // More. One feature a beat.
  // -------------------------------------------------------------------------

  T.more.forEach((t, i) => {
    const card = $(`#more-${i}`);
    slam(card, t, { from: 1.12 });
    cut(card, T.more[i + 1] ?? next("more"));
  });

  // -------------------------------------------------------------------------
  // Pay. Five hundred sats cross with no network on either phone. Claimed
  // offline, it is held as unconfirmed until a mint sees it, so nothing here
  // settles and nothing buzzes.
  // -------------------------------------------------------------------------

  {
    const title = lines("k-pay", [T.pay, T.pay + BEAT], 1);
    const a = phoneIn("ph-pa", T.pay);
    const b = phoneIn("ph-pb", T.pay + 0.1);
    const sa = $("#sc-pa");
    const sb = $("#sc-pb");
    hidden(
      ["scrim", "attach", "send-sheet", "alert"].map((name) => key(sa, name)),
    );

    const sent = key(sa, "token");
    const got = key(sb, "token");
    grow(sent, T.sent);
    ticks(sent, [T.land + 0.1, T.land + 0.5]);

    const token = $("#token");
    const from = targets.get(sent);
    const to = targets.get(got);
    hidden(token, { x: from.x, y: from.y, scale: 0.5 });
    tl.to(
      token,
      { autoAlpha: 1, scale: 1, duration: 0.2, ease: "expo.out" },
      T.fly,
    );
    tl.to(
      token,
      {
        x: to.x,
        y: to.y,
        duration: T.land - T.fly - 0.05,
        ease: "power2.inOut",
      },
      T.fly,
    );
    tl.to(
      token,
      { autoAlpha: 0, scale: 0.6, duration: 0.12, ease: "power2.in" },
      T.land - 0.08,
    );
    grow(got, T.land);

    // In on the token as it lands; the paying phone has done its part.
    tl.to(a, { autoAlpha: 0, duration: 0.2, ease: "power2.in" }, T.land);
    const onB = focus("ph-pb", to, { x: 1300, y: 600 }, 1.6, T.land, 0.45);
    const claim = key(sb, "claim");
    const claimed = key(sb, "claimed");
    hidden(claimed);
    tap(onB(targets.get(claim)), T.claim);
    swap(key(sb, "claim-label"), [
      [0, "Claim"],
      [T.claim, "Claiming…"],
    ]);
    tl.set(claim, { autoAlpha: 0 }, T.claimed);
    tl.to(claimed, { autoAlpha: 1, duration: 0.15, ease: "none" }, T.claimed);

    cut(title, T.cashu);
    const cashu = lines("k-cashu", [T.cashu, T.cashu + 0.12]);
    enter($("#k-cashu-sub"), T.cashu + 0.3, { y: 12 });
    cut([a, b, ...cashu, $("#k-cashu-sub")], next("pay"));
  }

  // -------------------------------------------------------------------------
  // Proof. None of the cryptography is new.
  // -------------------------------------------------------------------------

  {
    const rows = T.proofs.map((t, i) => {
      const row = $(`#proof-${i}`);
      enter(row, t, { x: -80, y: 0 });
      return row;
    });
    enter($("#primitives"), T.primitives, { y: 10 });
    cut([...rows, $("#primitives")], next("proof"));
  }

  // -------------------------------------------------------------------------
  // Free, then a beat of nothing, then the mark.
  // -------------------------------------------------------------------------

  T.free.forEach((t, i) => {
    const el = $(`#free-${i}`);
    slam(el, t);
    cut(el, T.free[i + 1] ?? T.hush);
  });

  slam($("#end-lockup"), T.end, { from: 1.14, blur: 16, duration: 0.5 });
  enter($("#end-url"), T.url, { y: 18, duration: 0.5 });

  // -------------------------------------------------------------------------

  function render() {
    const time = Math.max(0, Math.min(duration, tl.time()));
    for (const fn of frame) fn(time);
    WORLD.draw(time);
  }
  tl.eventCallback("onUpdate", render);
  render();

  // Registered last: a timeline published before it is built renders blank.
  window.__timelines = window.__timelines || {};
  window.__timelines["airhop-trailer"] = tl;
}

// Bubbles and tap targets are measured at load, so the faces have to be in
// before anything is measured.
document.fonts.ready.then(init);
