// The canvas under every scene: the globe, the street of phones and the mark
// they assemble into. It holds no clock of its own. timeline.js tweens the numbers
// in `W` and calls draw(t), so a frame is a pure function of its time.
//
// d3-geo does the projection, from the same land outline and relay list as the
// store globe in press/lib/world.mjs.

(function () {
  const canvas = document.getElementById("world");
  const ctx = canvas.getContext("2d");
  const WIDTH = 1920;
  const HEIGHT = 1080;
  const INK = "245,245,245";

  // Bengaluru, where the store screenshots are set. The film opens on one light
  // here and comes back down to the same street.
  const HOME = [77.64, 12.97];

  const W = {
    seed: { a: 0, r: 5 },
    globe: {
      a: 0,
      r: 380,
      lon: HOME[0],
      lat: HOME[1],
      cx: 960,
      cy: 540,
      lights: 1,
      talk: 0,
      relays: 0,
      arcs: 0,
      far: 0,
      wire: 0,
      tor: 0,
      ends: 0,
    },
    street: {
      a: 0,
      z: 1,
      cx: 960,
      cy: 560,
      dim: 1,
      links: 1,
      others: 1,
      bird: 0,
      birdCx: 960,
      birdCy: 480,
      cell: 44,
    },
  };

  let seed = 20260930;
  function random() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  // -------------------------------------------------------------------------
  // Globe
  // -------------------------------------------------------------------------

  const projection = d3.geoOrthographic().clipAngle(90).precision(0.4);
  const path = d3.geoPath(projection, ctx);
  const graticule = d3.geoGraticule10();
  const land = DATA.land;

  // City lights: points scattered over land between the polar circles. The
  // home light is always first, so the opening dot is one of them.
  const lights = [HOME];
  while (lights.length < 460) {
    const lon = random() * 360 - 180;
    const lat = (Math.asin(random() * 1.72 - 0.78) * 180) / Math.PI;
    if (lat < -52 || lat > 68) continue;
    if (d3.geoContains(land, [lon, lat])) lights.push([lon, lat]);
  }

  // Conversations crossing the planet, each a short-lived great-circle arc.
  let talk = [];
  function scheduleTalk(from, until) {
    talk = [];
    const near = lights.filter((p) => d3.geoDistance(p, [62, 22]) < 1.25);
    for (let i = 0; i < 64; i++) {
      const a = near[Math.floor(random() * near.length)];
      const b = near[Math.floor(random() * near.length)];
      const d = d3.geoDistance(a, b);
      if (d < 0.12 || d > 1.5) continue;
      talk.push({
        at: d3.geoInterpolate(a, b),
        t0: from + random() * (until - from),
        life: 1.1 + d,
      });
    }
  }

  function visible(point) {
    const rotate = projection.rotate();
    return d3.geoDistance(point, [-rotate[0], -rotate[1]]) < Math.PI / 2 - 0.02;
  }

  function drawGlobe(t) {
    const g = W.globe;
    if (g.a <= 0.002) return;
    projection.translate([g.cx, g.cy]).scale(g.r).rotate([-g.lon, -g.lat]);
    ctx.save();
    ctx.globalAlpha = g.a;

    ctx.beginPath();
    path({ type: "Sphere" });
    ctx.fillStyle = "#141414";
    ctx.fill();
    ctx.strokeStyle = "rgba(120,120,120,0.5)";
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.beginPath();
    path(graticule);
    ctx.strokeStyle = `rgba(${INK},0.07)`;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    path(land);
    ctx.fillStyle = `rgba(${INK},0.12)`;
    ctx.fill();
    ctx.strokeStyle = `rgba(${INK},0.2)`;
    ctx.lineWidth = 0.9;
    ctx.stroke();

    if (g.lights > 0.002) {
      const size = Math.max(1.5, Math.min(3.2, g.r / 190));
      ctx.fillStyle = `rgba(${INK},${0.8 * g.lights})`;
      for (let i = 0; i < lights.length; i++) {
        if (!visible(lights[i])) continue;
        const p = projection(lights[i]);
        ctx.beginPath();
        ctx.arc(p[0], p[1], size * (0.7 + (i % 5) * 0.12), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (g.talk > 0.002) {
      ctx.lineCap = "round";
      for (const arc of talk) {
        const p = (t - arc.t0) / arc.life;
        if (p <= 0 || p >= 1) continue;
        const head = Math.min(1, p * 1.6);
        const tail = Math.max(0, p * 1.6 - 0.6);
        ctx.beginPath();
        let started = false;
        for (let s = 0; s <= 20; s++) {
          const point = arc.at(tail + ((head - tail) * s) / 20);
          if (!visible(point)) {
            started = false;
            continue;
          }
          const q = projection(point);
          if (started) ctx.lineTo(q[0], q[1]);
          else ctx.moveTo(q[0], q[1]);
          started = true;
        }
        ctx.strokeStyle = `rgba(${INK},${0.6 * g.talk * Math.sin(Math.PI * p)})`;
        ctx.lineWidth = 1.3;
        ctx.stroke();
      }
    }

    if (g.relays > 0.002) {
      const sites = DATA.sites;
      if (g.arcs > 0.002) {
        ctx.setLineDash([3, 6]);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = `rgba(${INK},0.32)`;
        const count = Math.floor(DATA.edges.length * g.arcs);
        for (let i = 0; i < count; i++) {
          const [a, b] = DATA.edges[i];
          ctx.beginPath();
          path({
            type: "LineString",
            coordinates: [sites[a].slice(0, 2), sites[b].slice(0, 2)],
          });
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      // Sites light west to east, so the reveal reads as a wave, not a flicker.
      sites.forEach((site, i) => {
        const reveal = Math.max(
          0,
          Math.min(1, (g.relays * (sites.length + 12) - i) / 12),
        );
        if (reveal <= 0 || !visible(site)) return;
        const p = projection(site);
        const radius = Math.min(6, 2 + Math.sqrt(site[2]) * 0.5) * (g.r / 400);
        ctx.beginPath();
        ctx.arc(p[0], p[1], radius * (1.6 - 0.6 * reveal), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${INK},${0.92 * reveal})`;
        ctx.fill();
      });
    }
    drawWire(g);
    ctx.restore();
  }

  // One message leaving Bluetooth range: out through two relays somebody else
  // runs, and optionally through three Tor hops first.
  const FAR = [13.4, 52.5];
  const nearest = (point) =>
    DATA.sites.reduce((best, site) =>
      d3.geoDistance(site, point) < d3.geoDistance(best, point) ? site : best,
    );
  const RELAY_A = nearest([51.4, 35.7]).slice(0, 2);
  const RELAY_B = nearest([8.7, 50.1]).slice(0, 2);
  const WIRE = [HOME, RELAY_A, RELAY_B, FAR];
  const TOR = [HOME, [96, 42], [68, 54], [40, 47], RELAY_A];

  function trace(points, progress, colour, width, dash) {
    const legs = points
      .slice(1)
      .map((to, i) => d3.geoInterpolate(points[i], to));
    const reach = Math.max(0, Math.min(1, progress)) * legs.length;
    let head = null;
    ctx.beginPath();
    ctx.setLineDash(dash);
    ctx.lineWidth = width;
    ctx.strokeStyle = colour;
    legs.forEach((leg, i) => {
      const upto = Math.max(0, Math.min(1, reach - i));
      if (upto <= 0) return;
      for (let step = 0; step <= 24; step++) {
        const q = projection(leg((upto * step) / 24));
        if (step === 0) ctx.moveTo(q[0], q[1]);
        else ctx.lineTo(q[0], q[1]);
        head = q;
      }
    });
    ctx.stroke();
    ctx.setLineDash([]);
    return head;
  }

  function drawWire(g) {
    if (g.ends <= 0.002) return;
    const a = projection(HOME);
    const b = projection(FAR);
    if (g.far > 0.002 && g.far < 1) {
      ctx.beginPath();
      ctx.arc(a[0], a[1], 12 + g.far * 70, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${INK},${0.7 * (1 - g.far)})`;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    if (g.wire > 0.002) {
      const head = trace(
        WIRE,
        g.wire,
        `rgba(${INK},${0.75 * (1 - g.tor * 0.75)})`,
        2.5,
        [],
      );
      if (head !== null && g.wire < 1) {
        ctx.beginPath();
        ctx.arc(head[0], head[1], 9, 0, Math.PI * 2);
        ctx.fillStyle = "#22C55E";
        ctx.fill();
      }
    }
    if (g.tor > 0.002) {
      trace(TOR, g.tor, "rgba(139,92,246,0.95)", 3, [2, 9]);
      TOR.slice(1, 4).forEach((point, i) => {
        const shown = Math.max(0, Math.min(1, g.tor * 4 - i));
        if (shown <= 0) return;
        const q = projection(point);
        ctx.beginPath();
        ctx.arc(q[0], q[1], 9 * shown, 0, Math.PI * 2);
        ctx.fillStyle = "#8B5CF6";
        ctx.fill();
      });
    }
    ctx.font = '500 24px "JetBrains Mono"';
    ctx.textAlign = "center";
    [
      [a, "you", 44],
      [b, "amber", -24],
    ].forEach(([q, label, dy]) => {
      ctx.beginPath();
      ctx.arc(q[0], q[1], 11, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${INK},${g.ends})`;
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(11,11,11,0.9)";
      ctx.stroke();
      ctx.fillStyle = `rgba(${INK},${0.85 * g.ends})`;
      ctx.fillText(label, q[0], q[1] + dy);
    });
  }

  // -------------------------------------------------------------------------
  // Street
  // -------------------------------------------------------------------------

  // Same grid as the app's mark: eleven by six, twenty-two lit cells.
  const BIRD = [
    [1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1],
    [0, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0],
    [0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0],
    [0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0],
    [0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
  ];
  const cells = [];
  BIRD.forEach((row, y) =>
    row.forEach((on, x) => on && cells.push({ x: x - 5, y: y - 2.5 })),
  );

  // Two phones ten metres apart, then as many strangers as the mark has
  // pixels. Range is what a ring can reach; a link exists inside it.
  const RANGE = 600;
  const nodes = [
    { x: -200, y: 60, born: -1 },
    { x: 200, y: 60, born: -1 },
  ];
  let guard = 0;
  while (nodes.length < cells.length && guard++ < 20000) {
    const x = (random() * 2 - 1) * 2100;
    const y = random() * 1790 - 1150;
    let nearest = Infinity;
    for (const n of nodes)
      nearest = Math.min(nearest, Math.hypot(n.x - x, n.y - y));
    if (nearest < 400 || nearest > RANGE - 60) continue;
    nodes.push({ x, y, born: Infinity });
  }

  // Each phone takes the cell whose place in the mark matches its place on the
  // street, so the mesh folds into the bird without paths crossing.
  const byStreet = nodes
    .map((n, i) => i)
    .sort((a, b) => nodes[a].x - nodes[b].x);
  const byCell = cells.map((c, i) => i).sort((a, b) => cells[a].x - cells[b].x);
  for (let column = 0; column < byStreet.length; column += 4) {
    const group = byStreet
      .slice(column, column + 4)
      .sort((a, b) => nodes[a].y - nodes[b].y);
    const slots = byCell
      .slice(column, column + 4)
      .sort((a, b) => cells[a].y - cells[b].y);
    group.forEach((index, n) => (nodes[index].cell = cells[slots[n]]));
  }

  const links = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) < RANGE)
        links.push({ a: i, b: j, born: Infinity });
    }
  }

  // Breadth-first from the first phone: the order strangers join in, and the
  // route a message takes to the farthest one inside seven hops.
  const parent = new Array(nodes.length).fill(-1);
  const depth = new Array(nodes.length).fill(Infinity);
  const order = [0];
  depth[0] = 0;
  for (let head = 0; head < order.length; head++) {
    const current = order[head];
    for (const link of links) {
      const other =
        link.a === current ? link.b : link.b === current ? link.a : -1;
      if (other < 0 || depth[other] !== Infinity) continue;
      depth[other] = depth[current] + 1;
      parent[other] = current;
      order.push(other);
    }
  }
  let far = 0;
  nodes.forEach((n, i) => {
    if (
      depth[i] <= 7 &&
      (depth[i] > depth[far] || (depth[i] === depth[far] && n.x > nodes[far].x))
    )
      far = i;
  });
  const route = [];
  for (let i = far; i !== -1; i = parent[i]) route.unshift(i);

  let rings = [];
  let hops = [];

  function sx(x) {
    return W.street.cx + W.street.z * x;
  }
  function sy(y) {
    return W.street.cy + W.street.z * y;
  }

  function roundRect(x, y, half, radius) {
    ctx.beginPath();
    ctx.roundRect(x - half, y - half, half * 2, half * 2, radius);
  }

  function drawStreet(t) {
    const s = W.street;
    if (s.a <= 0.002) return;
    ctx.save();
    ctx.globalAlpha = s.a;
    const fold = s.bird;

    const place = nodes.map((n) => {
      const x = sx(n.x);
      const y = sy(n.y);
      if (fold <= 0) return [x, y];
      const bx = s.birdCx + n.cell.x * s.cell;
      const by = s.birdCy + n.cell.y * s.cell;
      return [x + (bx - x) * fold, y + (by - y) * fold];
    });
    const shown = (n, i) =>
      i < 2 ? 1 : Math.max(0, Math.min(1, (t - n.born) / 0.3)) * s.others;

    if (s.links > 0.002 && fold < 1) {
      ctx.lineWidth = 1.5;
      for (const link of links) {
        const p = Math.max(0, Math.min(1, (t - link.born) / 0.4));
        if (p <= 0) continue;
        const a = place[link.a];
        const b = place[link.b];
        const solo = link.a < 2 && link.b < 2 ? 1 : s.others;
        ctx.strokeStyle = `rgba(${INK},${0.3 * s.links * (1 - fold) * solo})`;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p);
        ctx.stroke();
      }
    }

    for (const ring of rings) {
      const p = (t - ring.t0) / ring.life;
      if (p <= 0 || p >= 1) continue;
      const eased = 1 - (1 - p) ** 2.2;
      const at = place[ring.node];
      ctx.beginPath();
      ctx.arc(at[0], at[1], eased * RANGE * s.z * ring.reach, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${INK},${0.5 * (1 - p) ** 1.4 * (1 - fold)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    const flash = new Array(nodes.length).fill(0);
    for (const hop of hops) {
      const p = (t - hop.t0) / hop.life;
      const since = t - (hop.t0 + hop.life);
      if (since >= 0 && since < 0.5)
        flash[hop.to] = Math.max(flash[hop.to], 1 - since / 0.5);
      if (p <= 0 || p >= 1) continue;
      const a = place[hop.from];
      const b = place[hop.to];
      const e = p * p * (3 - 2 * p);
      const x = a[0] + (b[0] - a[0]) * e;
      const y = a[1] + (b[1] - a[1]) * e;
      const tail = Math.max(0, e - 0.22);
      ctx.strokeStyle = `rgba(${INK},0.9)`;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(a[0] + (b[0] - a[0]) * tail, a[1] + (b[1] - a[1]) * tail);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${INK})`;
      ctx.fill();
    }

    // A circle on the street, a square in the mark. The half-size grows with
    // the fold until neighbouring cells meet edge to edge.
    nodes.forEach((n, i) => {
      const alpha = shown(n, i);
      if (alpha <= 0) return;
      const rest =
        (i < 2 ? 10 : 7.5) * (0.55 + 0.45 * Math.min(1, s.z * 1.6)) +
        flash[i] * 5;
      const half = rest + (s.cell * 0.51 - rest) * fold;
      const level = (i < 2 ? 1 : 0.8) * s.dim;
      ctx.fillStyle = `rgba(${INK},${alpha * (level + (1 - level) * Math.max(fold, flash[i]))})`;
      roundRect(place[i][0], place[i][1], half, half * (1 - fold));
      ctx.fill();
    });
    ctx.restore();
  }

  function drawSeed() {
    if (W.seed.a <= 0.002) return;
    ctx.beginPath();
    ctx.arc(W.globe.cx, W.globe.cy, W.seed.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${INK},${W.seed.a})`;
    ctx.fill();
  }

  window.W = W;
  window.WORLD = {
    nodes,
    links,
    order,
    route,
    range: RANGE,
    scheduleTalk,
    setRings(list) {
      rings = list;
    },
    setHops(list) {
      hops = list;
    },
    draw(t) {
      // The backing store is twice the stage, so a 4K render is drawn at full
      // resolution and 1080p is supersampled.
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      drawGlobe(t);
      drawStreet(t);
      drawSeed();
    },
  };
})();
