// The cut. One paused GSAP timeline holds every tween, placed at the moments
// plan.mjs names. HyperFrames seeks it frame by frame to render, and the same
// page plays live in its preview.
//
// Three rules keep a frame a pure function of its time:
//   1. Every start state is set once at load, then tweened with to(). Nothing
//      depends on the order frames are asked for.
//   2. Anything that is text or a loop (typing, counters, spinners, sonar) is a
//      function of t in `frame`, run from the timeline's onUpdate.
//   3. No clocks, no unseeded randomness, no infinite repeats.
//
// Motion follows one grammar: arrivals decelerate on power3 or expo, exits
// accelerate and are shorter, nothing bounces, and a thing appears when the
// narration names it.

function init() {
  const { BEAT, T, L, E, scenes, duration } = PLAN;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) =>
    Array.from(root.querySelectorAll(selector));
  const key = (root, name) => $('[data-key="' + name + '"]', root);
  const clamp = (v) => Math.max(0, Math.min(1, v));

  const tl = gsap.timeline({
    paused: true,
    defaults: { ease: "power3.out", duration: 0.5 },
  });
  const frame = [];

  // -------------------------------------------------------------------------
  // Measure, before anything is moved: where a finger has to land, how tall a
  // bubble is once it has arrived, how far a list scrolls.
  // -------------------------------------------------------------------------

  const centre = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  const scrollOf = (screen) => {
    const list = key(screen, "scroll");
    return Math.max(0, list.scrollHeight - list.parentElement.clientHeight);
  };
  const you = $("#sc-you");
  const you2 = $("#sc-you2");
  const scrollEnd = scrollOf(you);

  const targets = new Map();
  const heights = new Map();
  // The rows at the end of the settings list are measured where the scroll
  // leaves them, which is where they get tapped.
  for (const screen of [you, you2])
    key(screen, "scroll").style.transform = `translateY(${-scrollEnd}px)`;
  $$("[data-key]").forEach((el) => {
    targets.set(el, centre(el));
    heights.set(el, el.offsetHeight);
  });
  key(you, "scroll").style.transform = "";
  const selfDot = $("#sc-radar .self-dot");
  targets.set(selfDot, centre(selfDot));
  const radarCentre = centre($("#sc-radar .radar-canvas"));

  // -------------------------------------------------------------------------
  // Vocabulary
  // -------------------------------------------------------------------------

  const hidden = (el, vars = {}) => gsap.set(el, { autoAlpha: 0, ...vars });

  function enter(
    el,
    t,
    { x = 0, y = 24, duration = 0.55, stagger = 0, ease = "power3.out" } = {},
  ) {
    hidden(el, { x, y });
    tl.to(el, { autoAlpha: 1, x: 0, y: 0, duration, stagger, ease }, t);
  }

  function leave(el, t, { duration = 0.26, x = 0, y = 0 } = {}) {
    tl.to(el, { autoAlpha: 0, x, y, duration, ease: "power2.in" }, t);
  }

  // A hit: large and soft to sharp, fast. For a word that lands on its beat.
  function slam(el, t, { from = 1.28, blur = 14, duration = 0.5 } = {}) {
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

  // Leaving toward the lens, so the next thing can arrive from behind it.
  function through(el, t) {
    tl.to(
      el,
      { scale: 1.22, filter: "blur(10px)", duration: 0.2, ease: "power3.in" },
      t,
    );
    tl.to(el, { autoAlpha: 0, duration: 0.2, ease: "none" }, t);
  }

  // Each line of a stack arrives its own way. Reusing one entrance for every
  // line is what makes type read as a slide.
  const ENTRANCES = [
    (el, t) => slam(el, t),
    (el, t) => enter(el, t, { x: -220, y: 0, duration: 0.5, ease: "expo.out" }),
    (el, t) => enter(el, t, { y: 90, duration: 0.55, ease: "circ.out" }),
    (el, t) => enter(el, t, { x: 180, y: 0, duration: 0.5, ease: "expo.out" }),
  ];
  function lines(id, times, offset = 0) {
    const els = $$(`#${id} .stack-line`);
    els.forEach((el, i) =>
      ENTRANCES[(i + offset) % ENTRANCES.length](el, times[i]),
    );
    return els;
  }

  function say(id, tIn, tOut) {
    const el = $(`#${id}`);
    const parts = $$(".w", el);
    hidden(parts, { y: 22 });
    tl.to(parts, { autoAlpha: 1, y: 0, duration: 0.5, stagger: 0.06 }, tIn);
    tl.to(el, { autoAlpha: 0, duration: 0.25, ease: "power2.in" }, tOut);
  }

  function phoneIn(id, t) {
    const el = $(`#${id}`);
    hidden(el, { y: 170, scale: 0.94 });
    tl.to(
      el,
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.9, ease: "expo.out" },
      t,
    );
    return el;
  }

  function phoneOut(el, t) {
    tl.to(
      el,
      { autoAlpha: 0, y: -40, scale: 0.97, duration: 0.3, ease: "power2.in" },
      t,
    );
  }

  // The camera on a phone or a diagram: an outer wrapper that scales about a
  // fixed origin and an inner one that slides, so stage point `p` comes to
  // rest at `d`. Both move on one ease or the subject wanders mid-move.
  const cams = new Map();
  function focus(id, p, d, scale, t, duration = 1.1, ease = "power3.inOut") {
    const outer = $(`#cam-${id}`);
    const inner = outer.firstElementChild;
    const [ox, oy] = outer.style.transformOrigin.split(" ").map(parseFloat);
    const x = (d.x - ox) / scale - (p.x - ox);
    const y = (d.y - oy) / scale - (p.y - oy);
    tl.to(outer, { scale, duration, ease }, t);
    tl.to(inner, { x, y, duration, ease }, t);
    if (!cams.has(id)) cams.set(id, []);
    cams.get(id).push({ t: t + duration, ox, oy, scale, x, y });
  }
  const release = (id, t, duration = 0.9) => {
    const outer = $(`#cam-${id}`);
    const [ox, oy] = outer.style.transformOrigin.split(" ").map(parseFloat);
    focus(id, { x: ox, y: oy }, { x: ox, y: oy }, 1, t, duration);
  };
  // Where a measured point sits on stage once its camera has settled.
  function onStage(id, p, t) {
    const state = (cams.get(id) ?? []).filter((s) => s.t <= t + 1e-6).pop();
    if (state === undefined) return p;
    return {
      x: state.ox + state.scale * (p.x + state.x - state.ox),
      y: state.oy + state.scale * (p.y + state.y - state.oy),
    };
  }

  const touch = $("#touch");
  const touchRing = $("#touch-ring");
  hidden(touch, { scale: 1.5 });
  hidden(touchRing);

  // A fingertip: it arrives, presses on the beat, and leaves a ring behind.
  // `quick` is for a run of taps closer together than the arrival takes.
  function tap(el, t, { quick = false, cam = null } = {}) {
    const p = cam === null ? targets.get(el) : onStage(cam, targets.get(el), t);
    const lead = quick ? 0.1 : 0.32;
    tl.set(
      touch,
      { x: p.x, y: p.y, scale: quick ? 1.15 : 1.5 },
      t - lead - 0.01,
    );
    tl.to(
      touch,
      { autoAlpha: 1, scale: 1, duration: lead * 0.6, ease: "power2.out" },
      t - lead,
    );
    tl.to(touch, { scale: 0.78, duration: 0.07, ease: "power2.in" }, t - 0.07);
    tl.to(
      touch,
      {
        scale: 1.1,
        autoAlpha: 0,
        duration: quick ? 0.1 : 0.24,
        ease: "power2.out",
      },
      t + 0.03,
    );
    tl.set(touchRing, { x: p.x, y: p.y, scale: 0.8, autoAlpha: 0.7 }, t);
    tl.to(
      touchRing,
      {
        scale: 1.9,
        autoAlpha: 0,
        duration: quick ? 0.2 : 0.45,
        ease: "power2.out",
      },
      t + 0.001,
    );
    tl.to(el, { opacity: 0.55, duration: 0.06, ease: "none" }, t - 0.03);
    tl.to(el, { opacity: 1, duration: 0.18, ease: "power2.out" }, t + 0.07);
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
      { height: heights.get(row), duration: 0.3, ease: "power3.out" },
      t,
    );
    tl.to(row, { autoAlpha: 1, duration: 0.16, ease: "none" }, t + 0.04);
    tl.to(bubble, { scale: 1, duration: 0.45, ease: "expo.out" }, t + 0.02);
  }

  // Sending, sent, delivered: three glyphs in one slot, one visible at a time.
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

  function type(el, text, t0, perChar) {
    frame.push((t) => {
      const n =
        t < t0 ? 0 : Math.min(text.length, Math.floor((t - t0) / perChar) + 1);
      const value = text.slice(0, n);
      if (el.textContent !== value) el.textContent = value;
    });
    return t0 + text.length * perChar;
  }

  // Swap a label at a moment, in both directions of a scrub.
  function swap(el, steps) {
    frame.push((t) => {
      let value = steps[0][1];
      for (const [time, text] of steps) if (t >= time) value = text;
      if (el.textContent !== value) el.textContent = value;
    });
  }

  // A screen that has been covered is taken off, not left underneath.
  const covered = (el, t) => tl.set(el, { autoAlpha: 0 }, t);

  // The app's sheet: a crisp, barely sprung rise, and 220 ms down.
  const sheetUp = (el, t) =>
    tl.to(el, { yPercent: 0, duration: 0.5, ease: "expo.out" }, t);
  const sheetDown = (el, t) =>
    tl.to(el, { yPercent: 105, duration: 0.22, ease: "power3.out" }, t);

  // The motor going off, seen from outside the phone.
  const buzz = (el, t) =>
    tl.to(
      el,
      { keyframes: { x: [0, 4, -4, 3, -2, 0] }, duration: 0.26, ease: "none" },
      t,
    );

  function hex(n, salt) {
    let h = (salt * 2654435761) >>> 0;
    let out = "";
    for (let i = 0; i < n; i++) {
      h = (h * 1664525 + 1013904223) >>> 0;
      out += (h >>> 28).toString(16);
    }
    return out;
  }

  const globe = W.globe;
  const street = W.street;

  // -------------------------------------------------------------------------
  // Earth. One light, then all of them, then down to one street.
  // -------------------------------------------------------------------------

  const routeLive = $("#route-live");
  const routeGhost = $("#route-ghost");
  const routeLength = routeLive.getTotalLength();
  const pulse = $("#pulse");
  const routeNodes = ["rn-a", "rn-b", "rn-c"].map((id) => $(`#${id}`));
  const people = $$("#who-a, #who-b, #measure, #measure-label");
  {
    tl.to(W.seed, { a: 1, duration: 0.5, ease: "power1.out" }, T.seed);
    gsap.set(globe, { r: 5200, a: 0, lon: 77.64, lat: 12.97, talk: 0 });
    tl.to(globe, { a: 1, duration: 1.4, ease: "power2.out" }, T.pull);
    tl.to(globe, { r: 350, cy: 450, duration: 1.9, ease: "expo.out" }, T.pull);
    tl.to(W.seed, { a: 0, duration: 0.8, ease: "power1.in" }, T.pull + 0.3);
    tl.to(
      globe,
      { lon: 58, lat: 20, duration: T.dive - T.pull, ease: "sine.inOut" },
      T.pull,
    );
    tl.to(globe, { talk: 1, duration: 1 }, T.pull + 1.2);
    WORLD.scheduleTalk(T.pull + 1.2, T.dive + 0.4);
    say("ln-e1", L.e1, T.dive - 0.1);

    // The camera finds its street first, then falls toward it. The globe is
    // gone before the coastline is close enough to show its resolution.
    gsap.set(street, { a: 0, z: 1, others: 0, dim: 1 });
    tl.to(
      globe,
      { lon: 77.64, lat: 12.97, duration: 0.7, ease: "power2.inOut" },
      T.dive,
    );
    tl.to(
      globe,
      { r: 7000, cy: 560, duration: 1.3, ease: "power3.in" },
      T.dive,
    );
    tl.to(globe, { talk: 0, duration: 0.4 }, T.dive + 0.2);
    tl.to(globe, { a: 0, duration: 0.5, ease: "power1.in" }, T.dive + 0.62);
    tl.to(street, { a: 1, duration: 0.5, ease: "power1.out" }, T.dive + 1.05);
    enter(people, T.dive + 1.2, { y: 10, stagger: 0.06 });

    hidden(routeGhost);
    gsap.set(routeLive, {
      strokeDasharray: routeLength,
      strokeDashoffset: routeLength,
    });
    hidden(pulse);
    routeNodes.forEach((node, i) => {
      hidden(node, { scale: 0.7 });
      hidden($(`#${node.id}-dead`));
      hidden($(`#${node.id}-cause`));
      tl.to(
        node,
        { autoAlpha: 1, scale: 1, duration: 0.5, ease: "expo.out" },
        T.route - 0.25 + i * 0.16,
      );
      enter($(`#${node.id}-label`), T.route - 0.1 + i * 0.16, { y: 8 });
    });
    const lapse = BEAT * 2;
    tl.to(routeGhost, { autoAlpha: 1, duration: 0.5 }, T.route - 0.3);
    tl.to(
      routeLive,
      { strokeDashoffset: 0, duration: lapse, ease: "power1.inOut" },
      T.route,
    );
    tl.set(pulse, { autoAlpha: 1 }, T.route);
    frame.push((t) => {
      const lap = ((t - T.route) / lapse) % 1;
      const eased = lap * lap * (3 - 2 * lap);
      const p = routeLive.getPointAtLength(
        routeLength * (t < T.route ? 0 : eased),
      );
      pulse.style.transform = `translate(${p.x.toFixed(2)}px,${p.y.toFixed(2)}px)`;
    });
    $$(".tag").forEach((tag, i) =>
      enter(tag, T.tags[i], { x: -16, y: 0, duration: 0.4 }),
    );
    say("ln-e2", L.e2 + (E.e2 - L.e2) * 0.45, T.dead[0] + 0.5);
  }

  // -------------------------------------------------------------------------
  // Lost. The route dies, then four places it happens, cut on the voice.
  // -------------------------------------------------------------------------

  {
    [0, 2, 1].forEach((index, order) => {
      const node = routeNodes[index];
      const t = T.dead[order];
      tl.to(
        $(`#${node.id}-dead`),
        { autoAlpha: 1, duration: 0.1, ease: "none" },
        t,
      );
      tl.to($(`#${node.id}-label`), { autoAlpha: 0, duration: 0.1 }, t);
      tl.to($(`#${node.id}-cause`), { autoAlpha: 1, duration: 0.2 }, t + 0.05);
    });
    tl.to(pulse, { autoAlpha: 0, duration: 0.12 }, T.dead[0]);
    tl.to(routeLive, { autoAlpha: 0, duration: 0.4 }, T.dead[0]);
    tl.to(
      $$(".tag"),
      { autoAlpha: 0, duration: 0.3, stagger: 0.05 },
      T.dead[0],
    );

    const cut = T.places[0];
    const diagram = [
      routeGhost,
      ...routeNodes,
      ...$$("#longway .rlabel"),
      ...people,
    ];
    tl.to(
      diagram,
      { autoAlpha: 0, duration: 0.18, ease: "power2.in" },
      cut - 0.2,
    );
    tl.to(street, { a: 0, duration: 0.18, ease: "power2.in" }, cut - 0.2);

    const textIn = [
      { scale: 1.3, filter: "blur(16px)" },
      { x: -260 },
      { y: 120 },
      { scale: 0.82, filter: "blur(10px)" },
    ];
    const eases = ["power4.out", "expo.out", "circ.out", "expo.out"];
    T.places.forEach((t, i) => {
      const until = i < 3 ? T.places[i + 1] : T.quiet - 0.1;
      const place = $(`#place-${i}`);
      const text = $(`#place-text-${i}`);
      const art = $(`#place-art-${i}`);
      const bars = $$(`#place-bars-${i} .bar`);
      const label = $(`#place-bars-${i} span`);
      hidden(place);
      gsap.set(text, { autoAlpha: 0, ...textIn[i] });
      hidden(art, { x: 60 });
      hidden(label);
      tl.set(place, { autoAlpha: 1 }, t);
      tl.to(
        text,
        {
          autoAlpha: 1,
          x: 0,
          y: 0,
          scale: 1,
          filter: "blur(0px)",
          duration: 0.5,
          ease: eases[i],
        },
        t,
      );
      tl.to(
        art,
        { autoAlpha: 1, x: 0, duration: 0.6, ease: "power3.out" },
        t + 0.08,
      );
      // The bars go one at a time, tallest first, the way a signal leaves.
      [...bars]
        .reverse()
        .forEach((bar, n) =>
          tl.to(
            bar,
            { opacity: 0.16, duration: 0.12, ease: "none" },
            t + 0.2 + n * 0.11,
          ),
        );
      tl.to(label, { autoAlpha: 1, duration: 0.15, ease: "none" }, t + 0.66);
      tl.set(place, { autoAlpha: 0 }, until);
    });

    tl.set(street, { dim: 0.34 }, T.quiet - 0.05);
    tl.to(street, { a: 1, duration: 0.7, ease: "power1.out" }, T.quiet);
    say("ln-l3", L.l3, scenes.lost.end - 0.3);
  }

  // -------------------------------------------------------------------------
  // The idea. They never needed the network to be this close.
  // -------------------------------------------------------------------------

  const rings = [];
  const hops = [];
  {
    tl.to(
      people,
      { autoAlpha: 1, y: 0, duration: 0.5, stagger: 0.05 },
      scenes.idea.start + 0.1,
    );
    say("ln-i1", L.i1, T.pullback - 0.2);
    rings.push({ node: 0, t0: T.ring, reach: 1, life: 1.5 });
    tl.to(street, { dim: 1, duration: 0.4 }, T.ring);
    rings.push({ node: 1, t0: T.answer, reach: 1, life: 1.5 });
    const direct = WORLD.links.find((l) => l.a === 0 && l.b === 1);
    direct.born = T.link - 0.4;

    // Pull back. Every stranger's phone does what the first two did.
    leave(people, T.pullback - 0.15);
    tl.set(street, { others: 1 }, T.pullback);
    tl.to(
      street,
      { z: 0.42, cy: 540, duration: BEAT * 2.4, ease: "power2.inOut" },
      T.pullback,
    );
    const join = BEAT / 6;
    WORLD.order.forEach((index, n) => {
      if (index < 2) return;
      const t = T.join + (n - 2) * join;
      WORLD.nodes[index].born = t;
      rings.push({ node: index, t0: t, reach: 0.62, life: 1 });
    });
    for (const link of WORLD.links) {
      if (link !== direct)
        link.born =
          Math.max(WORLD.nodes[link.a].born, WORLD.nodes[link.b].born) + 0.12;
    }

    // One message, handed from stranger to stranger.
    const route = WORLD.route;
    const stride = Math.min(
      BEAT / 2,
      (T.fold - 0.8 - T.relay) / (route.length - 1),
    );
    for (let i = 0; i < route.length - 1; i++) {
      hops.push({
        from: route[i],
        to: route[i + 1],
        t0: T.relay + i * stride,
        life: stride,
      });
    }
    say("ln-i2", L.i2, T.fold - 0.7);
  }
  WORLD.setRings(rings);
  WORLD.setHops(hops);

  // -------------------------------------------------------------------------
  // The mark. Every phone in the mesh is a pixel of it.
  // -------------------------------------------------------------------------

  {
    gsap.set(street, { bird: 0, birdCx: 960, birdCy: 470, cell: 46 });
    tl.to(
      street,
      { bird: 1, duration: 0.62, ease: "expo.inOut" },
      T.fold - 0.56,
    );
    tl.to(
      street,
      {
        birdCx: 648,
        birdCy: 480,
        cell: 30,
        duration: 0.7,
        ease: "power3.inOut",
      },
      T.lockup - 0.35,
    );
    const letters = $$("#word span");
    hidden(letters, { x: -20 });
    tl.to(
      letters,
      { autoAlpha: 1, x: 0, duration: 0.4, stagger: 0.06 },
      T.lockup,
    );
    enter($("#intro-tag"), T.tagline, { y: 18 });
    leave($$("#word, #intro-tag"), T.markOut);
    tl.to(street, { a: 0, duration: 0.26, ease: "power2.in" }, T.markOut);
  }

  // -------------------------------------------------------------------------
  // Mesh. The radar finds four people with no network at all.
  // -------------------------------------------------------------------------

  {
    const phone = phoneIn("ph-mesh", T.meshIn);
    const radar = $("#sc-radar");
    const canvas = $(".radar-canvas", radar);

    // The app's sonar: three rings, 2800 ms each, 900 ms apart.
    const template = $(".pulse", radar);
    const sonar = [0, 0.9, 1.8].map((offset) => {
      const el = template.cloneNode();
      canvas.insertBefore(el, template);
      return { el, offset };
    });
    frame.push((t) => {
      if (t < T.meshIn - 0.5 || t > scenes.mesh.end + 0.5) return;
      for (const { el, offset } of sonar) {
        const p = ((((t - offset) % 2.8) + 2.8) % 2.8) / 2.8;
        el.style.transform = `scale(${0.05 + 0.95 * p})`;
        el.style.opacity = String(
          0.28 * Math.sin(Math.PI * Math.min(1, p * 1.15)),
        );
      }
      // Tapping the centre fires one more wave, as it does in the app.
      const q = (t - T.sonarTap) / 1.1;
      const on = q > 0 && q < 1;
      template.style.transform = `scale(${on ? 0.05 + 0.95 * (1 - (1 - q) ** 2) : 0.05})`;
      template.style.opacity = String(on ? 0.34 * (1 - q) : 0);
    });

    enter($("#note-signal"), T.meshIn + 0.7, { x: 20, y: 0 });
    leave($("#note-signal"), T.peers[0] - 0.4);
    focus(
      "ph-mesh",
      radarCentre,
      { x: 1300, y: 560 },
      1.3,
      T.peers[0] - 0.3,
      1.6,
      "power2.inOut",
    );

    const peers = $$(".peer-node", radar);
    peers.forEach((peer, n) => {
      hidden(peer, { scale: 0.4, transformOrigin: "50% 17px" });
      tl.to(
        peer,
        { autoAlpha: 1, scale: 1, duration: 0.55, ease: "expo.out" },
        T.peers[n],
      );
    });
    swap($(".radar-status-main", radar), [
      [0, "Scanning for nearby peers…"],
      [T.peers[0], "1 peer in range"],
      [T.peers[1], "2 peers in range"],
      [T.peers[2], "3 peers in range"],
      [T.peers[3], "4 peers in range"],
    ]);
    swap($(".radar-status-hint", radar), [
      [0, "Rings show BLE signal strength, not distance"],
      [T.peers[0], "Ring position reflects signal strength, not distance"],
    ]);

    const title = lines("k-mesh", [T.peers[1], T.meshWord], 1);
    tap(selfDot, T.sonarTap, { cam: "ph-mesh" });

    phoneOut(phone, T.meshOut);
    leave(title, T.meshOut, { x: -60 });
  }

  // -------------------------------------------------------------------------
  // Hops. What a stranger's phone holds of your message: not the message.
  // -------------------------------------------------------------------------

  {
    const xs = [360, 660, 960, 1260, 1560];
    const packet = $("#packet");
    enter($("#chain-line"), T.chainIn, { y: 0 });
    xs.forEach((x, i) => {
      const node = $(`#cnode-${i}`);
      hidden(node, { scale: 0.8 });
      tl.to(
        node,
        { autoAlpha: 1, scale: 1, duration: 0.5, ease: "expo.out" },
        T.chainIn + 0.1 + i * 0.07,
      );
      enter($(`#clabel-${i}`), T.chainIn + 0.25 + i * 0.07, { y: 10 });
      if (i > 0 && i < 4) hidden($(`#csees-${i}`), { y: 10 });
    });
    const title = lines("k-hop", [T.packet - 0.2], 2);
    enter($("#hopcount"), T.packet - 0.2, { x: 40, y: 0 });

    hidden(packet, { x: xs[0], scale: 0.7 });
    tl.to(
      packet,
      { autoAlpha: 1, scale: 1, duration: 0.4, ease: "expo.out" },
      T.packet,
    );
    T.hops.forEach((t, i) => {
      const travel = Math.min(
        0.46,
        (i === 0 ? t - T.packet : t - T.hops[i - 1]) * 0.8,
      );
      tl.to(
        packet,
        { x: xs[i + 1], duration: travel, ease: "power2.inOut" },
        t - travel,
      );
      const node = $(`#cnode-${i + 1}`);
      const lit = i < 3 ? "#F5F5F5" : "#22C55E";
      tl.to(node, { borderColor: lit, duration: 0.1, ease: "none" }, t - 0.04);
      if (i < 3) {
        tl.to(node, { borderColor: "#3D3D3D", duration: 0.6 }, t + 0.12);
        tl.to(
          $(`#csees-${i + 1}`),
          { autoAlpha: 1, y: 0, duration: 0.35 },
          t + 0.02,
        );
      } else {
        tl.to(node, { color: "#22C55E", duration: 0.2 }, t);
      }
    });
    swap($("#hopnum"), [[0, "0"], ...T.hops.map((t, i) => [t, String(i + 1)])]);
    tl.to(
      packet,
      { scale: 0.7, autoAlpha: 0, duration: 0.25, ease: "power2.in" },
      T.hops[3] + 0.3,
    );

    // A relay never has more than this: who it is for, and bytes it cannot
    // open. The bytes keep changing because every hop re-reads them as noise.
    frame.push((t) => {
      if (t < T.hops[0] - 0.5 || t > T.courier + 0.5) return;
      const tickIndex = Math.floor(t / 0.09);
      for (let i = 1; i <= 3; i++) {
        const raw = hex(16, tickIndex * 7 + i);
        $(`#cipher-${i}`).textContent =
          `${raw.slice(0, 4)} ${raw.slice(4, 8)} ${raw.slice(8, 12)} ${raw.slice(12)}`;
      }
    });

    // Push in on the middle relay for "sealed".
    leave([...title, $("#hopcount")], T.seal - 0.15, { y: -30 });
    const others = [0, 1, 3, 4].map((i) => $(`#cgroup-${i}`));
    tl.to(
      [...others, $("#chain-line")],
      { opacity: 0.05, duration: 0.5 },
      T.seal - 0.1,
    );
    tl.to(
      [...others, $("#chain-line")],
      { opacity: 1, duration: 0.5 },
      T.sealOut,
    );
    focus(
      "chain",
      { x: 960, y: 690 },
      { x: 520, y: 560 },
      2.1,
      T.seal - 0.1,
      0.95,
    );
    const sealed = $("#k-sealed");
    slam(sealed, T.seal + 0.4);
    tl.to(
      $("#csees-2"),
      {
        keyframes: { x: [0, 7, -7, 5, -3, 0] },
        color: "#EF4444",
        duration: 0.34,
        ease: "none",
      },
      T.cantOpen,
    );
    tl.to($("#csees-2"), { color: "#787878", duration: 0.5 }, T.cantOpen + 0.5);
    leave(sealed, T.sealOut, { x: 60 });
    release("chain", T.sealOut, 0.8);

    // The courier: nobody between you and amber, so one phone walks it over.
    const gone = [$("#cgroup-2"), $("#cgroup-3"), $("#chain-line")];
    tl.to(
      gone,
      { autoAlpha: 0, duration: 0.35, ease: "power2.in" },
      T.courier - 0.1,
    );
    tl.to($("#csees-1"), { autoAlpha: 0, duration: 0.2 }, T.courier - 0.1);
    const amber = $("#cgroup-4");
    tl.to(amber, { opacity: 0.22, duration: 0.4 }, T.courier - 0.1);
    tl.to(
      $("#cnode-4"),
      { borderColor: "#3D3D3D", color: "#787878", duration: 0.3 },
      T.courier - 0.1,
    );
    swap($("#clabel-4"), [
      [0, "amber"],
      [T.courier, "out of range"],
      [T.handover - 0.5, "amber"],
    ]);
    swap($("#clabel-1"), [
      [0, "a stranger"],
      [T.carry - 0.2, "carries it"],
    ]);
    const carry = lines("k-carry", [T.courier, T.carry], 1);

    tl.set(packet, { x: xs[0] }, T.courier);
    tl.to(
      packet,
      { autoAlpha: 1, scale: 1, duration: 0.3, ease: "expo.out" },
      T.courier + 0.15,
    );
    tl.to(
      packet,
      { x: xs[1], duration: 0.45, ease: "power2.inOut" },
      T.carry - 0.55,
    );
    const walk = T.handover - 0.35 - T.carry;
    const carrier = $("#cgroup-1");
    tl.to(carrier, { x: 600, duration: walk, ease: "power1.inOut" }, T.carry);
    tl.to(
      packet,
      { x: xs[1] + 600, duration: walk, ease: "power1.inOut" },
      T.carry,
    );
    tl.to(amber, { opacity: 1, duration: 0.4 }, T.handover - 0.6);
    tl.to(
      packet,
      { x: xs[4], duration: 0.3, ease: "power2.inOut" },
      T.handover - 0.3,
    );
    tl.to(
      $("#cnode-4"),
      { borderColor: "#22C55E", color: "#22C55E", duration: 0.2 },
      T.handover,
    );

    leave($$("#cam-chain, #k-carry"), T.hopsOut);
    leave(carry, T.hopsOut);
  }

  // -------------------------------------------------------------------------
  // The turn. The beat drops out so the question can land.
  // -------------------------------------------------------------------------

  {
    const ask = $("#q-ask");
    const typing = $("#q-typing");
    const answer = $("#q-answer");
    hidden(ask, { scale: 0.8, transformOrigin: "0% 100%" });
    hidden(typing, { scale: 0.8, transformOrigin: "100% 100%" });
    hidden(answer, { scale: 0.8, transformOrigin: "100% 100%" });
    tl.to(
      ask,
      { autoAlpha: 1, scale: 1, duration: 0.5, ease: "expo.out" },
      T.ask,
    );
    tl.to(
      typing,
      { autoAlpha: 1, scale: 1, duration: 0.35, ease: "expo.out" },
      T.typing,
    );
    const dots = $$("i", typing);
    frame.push((t) => {
      if (t < T.typing - 0.2 || t > T.reply + 0.2) return;
      dots.forEach((dot, i) => {
        const phase = Math.max(0, Math.sin((t - T.typing) * 9 - i * 0.9));
        dot.style.transform = `translateY(${(-8 * phase).toFixed(2)}px)`;
        dot.style.opacity = String(0.45 + 0.55 * phase);
      });
    });
    tl.set(typing, { autoAlpha: 0 }, T.reply - 0.04);
    tl.to(
      answer,
      { autoAlpha: 1, scale: 1, duration: 0.45, ease: "expo.out" },
      T.reply - 0.04,
    );
    through(ask, T.turnOut);
    through(answer, T.turnOut);
  }

  // -------------------------------------------------------------------------
  // Identity. Four lines of key generation where a sign-up form would be.
  // -------------------------------------------------------------------------

  {
    const phone = phoneIn("ph-id", T.idIn);
    const gen = $("#sc-gen");
    const reveal = $("#sc-reveal");
    const spinner = key(gen, "spinner");
    frame.push((t) => {
      if (t < T.idIn - 0.5 || t > T.reveal + 0.5) return;
      spinner.style.transform = `rotate(${(((t - T.idIn) * 200) % 360).toFixed(1)}deg)`;
    });
    T.keys.forEach((t, i) => {
      const row = key(gen, `line-${i}`);
      hidden(row);
      tl.to(row, { autoAlpha: 1, duration: 0.18, ease: "none" }, t);
    });
    const title = lines("k-id", [L.d1, L.d2, L.d3]);

    hidden(reveal);
    gsap.set($(".f-rv-card", reveal), { scale: 0.96 });
    tl.to(
      reveal,
      { autoAlpha: 1, duration: 0.22, ease: "none" },
      T.reveal - 0.1,
    );
    tl.to(
      $(".f-rv-card", reveal),
      { scale: 1, duration: 0.5 },
      T.reveal - 0.08,
    );
    covered(gen, T.reveal + 0.15);

    // The peer ID resolves left to right out of noise, then names the person:
    // the name is derived from it, so it cannot arrive first.
    const id = "9d3ec41b77a2e058";
    const idEl = key(reveal, "peer-id");
    frame.push((t) => {
      if (t < T.reveal - 0.5 || t > T.named + 0.5) return;
      const fixed = Math.floor(
        clamp((t - T.reveal) / (T.named - T.reveal)) * id.length,
      );
      const raw =
        id.slice(0, fixed) + hex(id.length - fixed, Math.floor(t / 0.05));
      idEl.textContent = `${raw.slice(0, 8)} · ${raw.slice(8)}`;
    });
    const name = key(reveal, "name");
    hidden(name, { y: 6 });
    tl.to(name, { autoAlpha: 1, y: 0, duration: 0.35 }, T.named);

    // Push in on the one row that matters: Account required, None.
    const none = key(reveal, "none");
    focus(
      "ph-id",
      targets.get(none),
      { x: 1520, y: 540 },
      1.4,
      T.none - 0.5,
      1,
    );
    tl.to(
      none,
      { backgroundColor: "rgba(245,245,245,0.1)", duration: 0.3 },
      T.none + 0.35,
    );

    phoneOut(phone, T.idOut);
    leave(title, T.idOut, { x: -60 });
  }

  // -------------------------------------------------------------------------
  // Nostr. Past Bluetooth range, it is somebody else's relay, and sealed.
  // -------------------------------------------------------------------------

  {
    tl.set(
      globe,
      {
        cx: 1370,
        cy: 540,
        r: 330,
        lon: 46,
        lat: 30,
        lights: 0,
        talk: 0,
        relays: 0,
        arcs: 0,
        ends: 0,
        far: 0,
        wire: 0,
        tor: 0,
      },
      T.globeIn - 0.01,
    );
    tl.to(globe, { a: 1, duration: 0.7, ease: "power2.out" }, T.globeIn);
    tl.to(globe, { r: 440, duration: 1.4, ease: "expo.out" }, T.globeIn);
    tl.to(globe, { ends: 1, duration: 0.4 }, T.tooFar);
    tl.to(globe, { far: 1, duration: 1, ease: "power2.out" }, T.tooFar + 0.2);
    enter($("#k-far"), T.tooFar, { x: -20, y: 0 });
    leave($("#k-far"), T.nostrWord - 0.15);

    const nostr = lines("k-nostr", [T.nostrWord]);
    through(nostr[0], T.relays - 0.2);

    const count = $("#relay-count");
    const counter = $("#k-relays");
    hidden(counter, { scale: 0.8, transformOrigin: "0% 50%" });
    tl.to(
      counter,
      { autoAlpha: 1, scale: 1, duration: 0.5, ease: "expo.out" },
      T.relays,
    );
    const counting = Math.min(1.6, T.notOurs - T.relays - 0.2);
    frame.push((t) => {
      const p = clamp((t - T.relays) / counting);
      const eased = 1 - (1 - p) ** 3;
      const value = p >= 1 ? "300+" : String(Math.round(300 * eased));
      if (count.textContent !== value) count.textContent = value;
    });
    tl.to(
      globe,
      { relays: 1, duration: counting + 0.4, ease: "power1.inOut" },
      T.relays,
    );
    tl.to(
      globe,
      { arcs: 1, duration: 1.4, ease: "power1.inOut" },
      T.relays + 0.5,
    );
    leave(counter, T.notOurs - 0.12, { y: -40 });
    const ours = lines("k-ours", [T.notOurs, T.notOurs + 0.3], 2);
    leave(ours, T.wrapped - 0.2, { y: -40 });

    const wrap = lines("k-wrap", [T.wrapped, T.wrapped + 0.12], 1);
    enter($("#k-wrap-sub"), T.wrapped + 0.7, { y: 12 });
    tl.to(globe, { arcs: 0.2, duration: 0.5 }, T.wrapped - 0.1);
    tl.to(
      globe,
      { wire: 1, duration: T.arrived - T.wrapped, ease: "power1.inOut" },
      T.wrapped,
    );
    leave([...wrap, $("#k-wrap-sub")], T.tor - 0.2, { y: -40 });

    const tor = lines("k-tor", [T.tor]);
    enter($("#k-tor-sub"), T.tor + 0.9, { y: 12 });
    tl.to(globe, { tor: 1, duration: 1.5, ease: "power1.inOut" }, T.tor + 0.1);
    leave([...tor, $("#k-tor-sub")], T.anywhere - 0.2, { y: -40 });

    const any = lines(
      "k-any",
      [
        T.anywhere,
        T.anywhere + (E.n5 - L.n5) * 0.34,
        T.anywhere + (E.n5 - L.n5) * 0.34 + 0.1,
      ],
      2,
    );
    tl.to(globe, { a: 0, duration: 0.3, ease: "power2.in" }, T.nostrOut);
    leave(any, T.nostrOut, { x: -60 });
  }

  // -------------------------------------------------------------------------
  // And more. One card per line, cut on the line.
  // -------------------------------------------------------------------------

  {
    const more = lines("k-more", [T.more]);
    through(more[0], T.cards[0] - 0.2);

    const flip = (row, t) => {
      const toggle = key(row, `${row.id}-switch`);
      tl.to(
        toggle,
        { backgroundColor: "#F5F5F5", duration: 0.2, ease: "power2.out" },
        t,
      );
      tl.to(
        $(".knob", toggle),
        {
          x: 18,
          backgroundColor: "#111111",
          duration: 0.22,
          ease: "power3.out",
        },
        t,
      );
    };

    T.cards.forEach((t, n) => {
      const until = n < T.cards.length - 1 ? T.cards[n + 1] : T.cardsEnd - 0.05;
      const card = $(`#card-${n}`);
      const art = $(`#card-art-${n}`);
      hidden(card);
      tl.set(card, { autoAlpha: 1 }, t);
      const titleLines = $$(".stack-line", card);
      lines(
        `card-title-${n}`,
        titleLines.map((_, i) => t + i * 0.1),
        n,
      );
      hidden(art, { x: n % 2 === 0 ? 110 : 0, y: n % 2 === 0 ? 0 : 90 });
      tl.to(
        art,
        { autoAlpha: 1, x: 0, y: 0, duration: 0.6, ease: "expo.out" },
        t + 0.06,
      );
      tl.set(card, { autoAlpha: 0 }, until);
    });
    flip($("#row-gateway"), T.switchOn[0]);
    flip($("#row-bridge"), T.switchOn[1]);

    const waves = $$(".wave i");
    frame.push((t) => {
      if (t < T.cards[1] - 0.2 || t > T.cards[2] + 0.1) return;
      waves.forEach((bar, i) => {
        const level = Math.abs(
          Math.sin(t * 11 + i * 0.63) * Math.sin(t * 3.7 + i * 0.29),
        );
        bar.style.height = `${(20 + 220 * level).toFixed(1)}px`;
      });
    });
    const tongues = $$(".tongues span");
    hidden(tongues, { y: 20 });
    tl.to(
      tongues,
      { autoAlpha: 1, y: 0, duration: 0.3, stagger: 0.06 },
      T.cards[5] + 0.15,
    );
  }

  // -------------------------------------------------------------------------
  // Wallet. The tempo halves. Five hundred sats cross a gap with no network on
  // either side, and the film does not pretend it settles before a mint has
  // seen it.
  // -------------------------------------------------------------------------

  {
    const money = $("#money");
    slam(money, T.money, { from: 1.2, duration: 0.7 });
    through(money, T.moneyOut);

    const a = phoneIn("ph-wa", T.phoneA);
    const sa = $("#sc-wa");
    const scrim = key(sa, "scrim");
    const attach = key(sa, "attach");
    const sendSheet = key(sa, "send-sheet");
    const alert = key(sa, "alert");
    hidden(scrim);
    gsap.set([attach, sendSheet], { yPercent: 105 });
    hidden(alert, { scale: 0.94 });

    // Plus, then Send ecash. The camera sits on the lower half of the phone,
    // where the sheets are.
    const desk = { x: 960, y: 760 };
    tap(key(sa, "plus"), T.plus);
    tl.to(scrim, { autoAlpha: 1, duration: 0.25, ease: "none" }, T.plus + 0.05);
    sheetUp(attach, T.plus + 0.08);
    focus("ph-wa", desk, { x: 960, y: 600 }, 1.42, T.plus + 0.1, 0.85);
    tap(key(sa, "ecash-row"), T.ecashRow, { cam: "ph-wa" });
    sheetDown(attach, T.ecashRow + 0.12);
    sheetUp(sendSheet, T.ecashRow + 0.36);

    // 5, 0, 0 on the beat. No count-up anywhere: the app never animates a sum.
    swap(key(sa, "amount"), [
      [0, ""],
      [T.digits[0], "5"],
      [T.digits[1], "50"],
      [T.digits[2], "500"],
    ]);
    tl.set(key(sa, "amount-hint"), { autoAlpha: 0 }, T.digits[0]);
    tl.set(key(sa, "memo-hint"), { autoAlpha: 0 }, T.memo);
    type(key(sa, "memo"), "for the water", T.memo, (T.memoEnd - T.memo) / 13);
    tap(key(sa, "sheet-send"), T.sheetSend, { cam: "ph-wa" });

    // The one confirmation the app asks for.
    sheetDown(sendSheet, T.sheetSend + 0.1);
    focus(
      "ph-wa",
      { x: 960, y: 540 },
      { x: 960, y: 540 },
      1.3,
      T.sheetSend + 0.1,
      0.7,
    );
    tl.to(
      alert,
      { autoAlpha: 1, scale: 1, duration: 0.3, ease: "expo.out" },
      T.alert,
    );
    tap(key(sa, "alert-send"), T.confirm, { cam: "ph-wa" });
    tl.to(
      alert,
      { autoAlpha: 0, scale: 0.96, duration: 0.18, ease: "power2.in" },
      T.confirm + 0.08,
    );
    tl.to(
      scrim,
      { autoAlpha: 0, duration: 0.22, ease: "none" },
      T.confirm + 0.08,
    );
    const sent = key(sa, "token");
    grow(sent, T.tokenOut);

    // Pull back and make room: the second phone, and the token crossing.
    focus(
      "ph-wa",
      { x: 960, y: 540 },
      { x: 640, y: 540 },
      1,
      T.tokenOut + 0.2,
      0.9,
    );
    const b = phoneIn("ph-wb", T.tokenOut + 0.35);
    const sb = $("#sc-wb");
    const walletScreen = $("#sc-wallet");
    hidden(walletScreen, { x: 40 });

    const token = $("#token");
    hidden(token, { x: 870, y: 800, scale: 0.5 });
    tl.to(
      token,
      { autoAlpha: 1, scale: 1, duration: 0.3, ease: "expo.out" },
      T.fly - 0.2,
    );
    tl.to(
      token,
      { x: 1160, y: 780, duration: T.land - T.fly, ease: "power2.inOut" },
      T.fly,
    );
    tl.to(
      token,
      { autoAlpha: 0, scale: 0.6, duration: 0.16, ease: "power2.in" },
      T.land - 0.1,
    );
    const got = key(sb, "token");
    grow(got, T.land);
    ticks(sent, [T.land + 0.2, T.land + 0.9]);

    // Claim. Offline, the signature checks out and the coins are held as
    // unconfirmed; the wallet says so instead of showing a bigger number.
    const claim = key(sb, "claim");
    const claimed = key(sb, "claimed");
    hidden(claimed);
    leave(a, T.claim - 1, { duration: 0.4 });
    focus("ph-wb", targets.get(got), { x: 960, y: 560 }, 1.6, T.claim - 1, 0.9);
    tap(claim, T.claim, { cam: "ph-wb" });
    swap(key(sb, "claim-label"), [
      [0, "Claim"],
      [T.claim, "Claiming…"],
    ]);
    tl.to(claim, { opacity: 0.5, duration: 0.1 }, T.claim + 0.27);
    tl.set(claim, { autoAlpha: 0 }, T.claimed);
    tl.to(claimed, { autoAlpha: 1, duration: 0.2, ease: "none" }, T.claimed);

    release("ph-wb", T.walletScreen - 0.5, 0.9);
    tl.to(walletScreen, { autoAlpha: 1, x: 0, duration: 0.4 }, T.walletScreen);
    covered(sb, T.walletScreen + 0.42);
    const title = lines(
      "k-wallet",
      [T.walletScreen + 0.3, T.walletScreen + 0.42, T.walletScreen + 0.54],
      1,
    );
    enter($("#k-wallet-sub"), T.walletScreen + 0.5, { y: 12 });

    // How it is possible: the protocol, named when the narration names it.
    leave([...title, $("#k-wallet-sub")], T.cashu - 0.22, { y: -40 });
    const cashu = lines("k-cashu", [T.cashu, T.cashu + 0.14], 2);
    enter($("#k-cashu-sub"), T.banknote, { y: 12 });

    // Signal comes back. Only now does the app confirm, and only now does the
    // phone buzz: the success haptic is wired to the mint's answer.
    tl.to($(".sb-bars", walletScreen), { opacity: 1, duration: 0.3 }, T.online);
    enter($("#note-online"), T.online, { x: 20, y: 0 });
    const note = key(walletScreen, "note");
    swap(key(walletScreen, "balance"), [
      [0, "2,000"],
      [T.settled, "2,500"],
    ]);
    tl.to(note, { height: 0, autoAlpha: 0, duration: 0.3 }, T.settled);
    swap(key(walletScreen, "recv-title"), [
      [0, "Received, unconfirmed"],
      [T.settled, "Received"],
    ]);
    swap(key(walletScreen, "recv-sub"), [
      [0, "now · mint.minibits.cash · pending"],
      [T.settled, "now · mint.minibits.cash"],
    ]);
    buzz(b, T.settled);

    phoneOut(b, T.walletOut);
    leave([...cashu, ...$$("#k-cashu-sub, #note-online")], T.walletOut, {
      x: -60,
    });
  }

  // -------------------------------------------------------------------------
  // bitchat. Same protocol, then further.
  // -------------------------------------------------------------------------

  {
    const start = scenes.bitchat.start;
    enter($("#pair-a"), start + 0.25, { x: -40, y: 0 });
    enter($("#pair-b"), T.pair, { x: -40, y: 0 });
    gsap.set($("#pair-line"), { scaleY: 0 });
    tl.to(
      $("#pair-line"),
      { scaleY: 1, duration: 0.5, ease: "power3.inOut" },
      T.talk - 0.5,
    );
    enter($("#pair-note"), T.talk, { x: -16, y: 0 });
    const kept = lines("k-kept", [T.kept, T.kept + 0.14], 2);
    T.gains.forEach((t, i) =>
      enter($(`#gain-${i}`), t, {
        x: 70,
        y: 0,
        duration: 0.5,
        ease: "expo.out",
      }),
    );
    leave([...kept, ...$$("#pair, .gain")], T.bitchatOut, { y: -30 });
  }

  // -------------------------------------------------------------------------
  // Cryptography. Nothing here is new, which is the claim.
  // -------------------------------------------------------------------------

  {
    const title = lines("k-crypto", [T.notInvented, T.notInvented + 0.35], 1);
    enter($("#k-point"), T.point, { y: 16 });
    T.proven.forEach((t, i) => {
      const row = $(`#proof-${i}`);
      hidden(row);
      tl.set(row, { autoAlpha: 1 }, t - 0.02);
      enter($(".proof-name", row), t, {
        x: -60,
        y: 0,
        duration: 0.5,
        ease: "expo.out",
      });
      gsap.set($("i", row), { scaleX: 0, transformOrigin: "0% 50%" });
      tl.to(
        $("i", row),
        { scaleX: 1, duration: 0.4, ease: "power3.inOut" },
        t + 0.25,
      );
      enter($(".proof-from", row), t + 0.45, { x: 30, y: 0 });
    });
    enter($("#primitives"), T.proven[2] + 0.7, { y: 10 });
    const first = [...title, ...$$("#k-point, #proven, #primitives")];
    tl.to(
      first,
      { autoAlpha: 0, y: -70, duration: 0.24, ease: "power3.in" },
      T.words[0] - 0.26,
    );
    [0, 1, 2].forEach((i) => slam($(`#osp-${i}`), T.words[i], { from: 1.35 }));
    enter($("#k-easy"), T.easy, { y: 26 });
    leave($$("#osp, #k-easy"), T.cryptoOut);
  }

  // -------------------------------------------------------------------------
  // Nothing to hand over.
  // -------------------------------------------------------------------------

  {
    const rows = [0, 1, 2, 3].map((i) => $(`#no-${i}`));
    gsap.set($("#no-rule"), { scaleX: 0 });
    rows.forEach((row, i) => {
      ENTRANCES[i](row, T.nothing[i]);
      if (i > 0)
        tl.to(rows.slice(0, i), { opacity: 0.28, duration: 0.3 }, T.nothing[i]);
    });
    tl.to(
      $("#no-rule"),
      { scaleX: 1, duration: 0.45, ease: "power3.inOut" },
      T.rule,
    );
    leave(rows, T.nothingOut, { y: -30 });
  }

  // -------------------------------------------------------------------------
  // Leaving. The real settings list, scrolled to its end: move to a new phone,
  // or destroy everything in three taps.
  // -------------------------------------------------------------------------

  {
    const old = phoneIn("ph-old", T.youIn);
    const moving = $("#sc-moving");
    const erased = $("#sc-erased");
    hidden(moving);
    hidden(erased);
    tl.to(
      key(you, "scroll"),
      { y: -scrollEnd, duration: 1.5, ease: "power3.inOut" },
      T.scroll,
    );

    const move = lines("k-move", [L.x5, T.moving], 1);
    enter($("#k-move-sub"), T.moving + 0.4, { y: 12 });
    tap(key(you, "transfer"), T.transferTap);

    const fresh = phoneIn("ph-new", T.newPhone);
    const receiving = $("#sc-receiving");
    const wiping = $("#sc-wiping");
    const welcome = $("#sc-welcome");
    hidden([receiving, you2, wiping, welcome]);

    tl.to(
      [moving, receiving],
      { autoAlpha: 1, duration: 0.25, ease: "none" },
      T.moving,
    );
    covered([you, $("#sc-code")], T.moving + 0.27);
    const span = T.moved - T.moving;
    const percent = (verb) =>
      [12, 38, 64, 91].map((p, i) => [
        T.moving + (span * i) / 4,
        `${verb} ${p}%`,
      ]);
    swap(key(moving, "title"), [
      [0, "Transferring 12%"],
      ...percent("Transferring"),
      [T.moved, "Transferred"],
    ]);
    swap(key(moving, "sub"), [
      [0, "Keep both phones open until this finishes."],
      [
        T.moved,
        "Your identity is on your new phone now, and this phone has been erased.",
      ],
    ]);
    swap(key(receiving, "title"), [
      [0, "Receiving 12%"],
      ...percent("Receiving"),
    ]);
    tl.to(you2, { autoAlpha: 1, duration: 0.3, ease: "none" }, T.moved);
    covered(receiving, T.moved + 0.32);
    tl.to(erased, { autoAlpha: 1, duration: 0.3, ease: "none" }, T.erased);
    covered(moving, T.erased + 0.32);
    buzz(fresh, T.moved);

    // The new phone is the phone now. Push in on the last row of its list.
    leave(old, T.toNew, { duration: 0.4 });
    leave([...move, $("#k-move-sub")], T.toNew, { y: -30 });
    const panic = key(you2, "panic");
    focus("ph-new", targets.get(panic), { x: 760, y: 600 }, 1.35, T.toNew, 1);

    // Three taps inside 400 ms of each other skip the confirmation.
    const wipe = lines("k-wipe", [T.taps[0] - 0.5, T.wipe + 0.3], 2);
    T.taps.forEach((t, i) => tap(panic, t, { quick: i > 0, cam: "ph-new" }));
    buzz(fresh, T.wipe);
    const pieces = [
      ...$$(".group, .p-identity, .p-pills, .you-head", you2),
      $(".tabwrap", you2),
    ];
    tl.to(
      pieces,
      {
        autoAlpha: 0,
        scale: 0.97,
        duration: 0.2,
        ease: "power2.in",
        stagger: { each: 0.02, from: "end" },
      },
      T.wipe + 0.05,
    );
    tl.to(wiping, { autoAlpha: 1, duration: 0.2, ease: "none" }, T.wipe + 0.3);
    covered(you2, T.wipe + 0.52);
    release("ph-new", T.wipe + 0.5, 1);
    tl.to(welcome, { autoAlpha: 1, duration: 0.35, ease: "none" }, T.welcome);
    covered(wiping, T.welcome + 0.37);

    phoneOut(fresh, T.leavingOut);
    leave(wipe, T.leavingOut, { x: 60 });
  }

  // -------------------------------------------------------------------------
  // Not done yet. What is coming, with the audits as its last line.
  // -------------------------------------------------------------------------

  {
    const text = "we’re not done yet...";
    const typed = type(
      $("#notdone-text"),
      text,
      T.typed,
      (E.z1 - L.z1) / text.length,
    );
    const caret = $("#notdone-caret");
    frame.push((t) => {
      const blink = t > typed ? Math.floor((t - typed) / 0.33) % 2 === 0 : true;
      caret.style.opacity = blink ? "1" : "0";
    });
    enter($("#soon"), T.soon, { y: 10 });
    $$(".rm").forEach((row, i) =>
      enter(row, T.roadmap[i], { y: 18, duration: 0.35 }),
    );
    hidden($("#notdone"));
    tl.set($("#notdone"), { autoAlpha: 1 }, T.typed - 0.05);
    leave($("#notdone"), T.notdoneOut);
  }

  // -------------------------------------------------------------------------
  // End. White. The bird crosses, comes at the lens, and its black becomes
  // the ground the mark sits on.
  // -------------------------------------------------------------------------

  {
    const white = $("#white");
    const black = $("#black");
    const bird = $("#flybird");
    const wings = [$("#wing-0"), $("#wing-1")];
    hidden([white, black]);
    hidden(bird, { x: -300, y: 660 });
    tl.set(white, { autoAlpha: 1 }, T.white);
    tl.set(bird, { autoAlpha: 1 }, T.flyIn);
    const flight = T.lunge[0] - T.flyIn;
    tl.to(bird, { x: 960, duration: flight, ease: "power2.out" }, T.flyIn);
    tl.to(bird, { y: 400, duration: flight, ease: "sine.inOut" }, T.flyIn);
    // Two frames, as the app flaps it. It glides the last stretch.
    frame.push((t) => {
      const flapping = t >= T.flyIn && t < T.lunge[0] - 0.45;
      const down = flapping && Math.floor((t - T.flyIn) / 0.13) % 2 === 0;
      wings[0].style.opacity = down ? "0" : "1";
      wings[1].style.opacity = down ? "1" : "0";
    });

    const tryIt = $("#k-try");
    slam(tryIt, L.f1, { from: 1.2 });
    leave(tryIt, T.lunge[0] - 0.05, { duration: 0.2 });

    // Toward the lens until one pixel of it is the whole frame.
    tl.to(
      bird,
      { scale: 64, y: 540, duration: T.lunge[1] - T.lunge[0], ease: "expo.in" },
      T.lunge[0],
    );
    tl.set(black, { autoAlpha: 1 }, T.final);
    tl.set([bird, white], { autoAlpha: 0 }, T.final + 0.02);

    const lockup = $("#end-lockup");
    hidden(lockup, { scale: 0.9 });
    tl.to(
      lockup,
      { autoAlpha: 1, scale: 1, duration: 0.9, ease: "expo.out" },
      T.final + 0.05,
    );
    enter($("#end-head"), T.open, { y: 40, duration: 0.6 });
    enter($("#end-url"), T.url, { y: 24 });
    enter($("#end-mail"), T.url + 0.2, { y: 18 });
    enter($("#end-facts"), T.url + 0.35, { y: 16 });

    const lets = "let’s airhop.";
    const done = type(
      $("#end-lets-text"),
      lets,
      T.lets,
      (E.f3 - L.f3) / lets.length,
    );
    const caret = $("#end-caret");
    frame.push((t) => {
      const on =
        t >= T.lets && (t < done || Math.floor((t - done) / 0.33) % 2 === 0);
      caret.style.opacity = on ? "1" : "0";
    });

    hidden($("#fade"));
    tl.to($("#fade"), { autoAlpha: 1, duration: 1, ease: "power1.in" }, T.fade);
  }

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
  window.__timelines["airhop"] = tl;
}

// Bubbles and tap targets are measured at load, so the faces have to be in
// before anything is measured.
document.fonts.ready.then(init);
