// Assembles index.html, the HyperFrames composition: the stage markup, its
// styles and fonts, the canvas and timeline scripts, and the audio clips
// HyperFrames mixes. The timeline is inline because the linter has to see it
// register. Beside the page go
// vendor/ (GSAP and d3-geo, copied from node_modules) and data.js (the plan
// and the world data). The page needs nothing from the network.
//
//   node scripts/build.mjs
//
// Then `npm run preview` to watch it, or `npm run render`.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { SCREEN_CSS } from "../../lib/screens.mjs";
import { cssVars, DARK } from "../../lib/theme.mjs";
import { buildPlan } from "../plan.mjs";
import { stageHtml } from "../src/stage.mjs";
import { narrationLengths, node, ROOT } from "./tools.mjs";

const REPO = join(ROOT, "..", "..");
const LANDING = join(REPO, "landing");

const SANS = `'Segoe UI Variable Display','Segoe UI',-apple-system,'Helvetica Neue',Arial,sans-serif`;

const read = (path) => readFileSync(path, "utf8");
const mod = (rel) => import(pathToFileURL(join(LANDING, rel)).href);

// Land outline and relay sites, from the same sources as the store globe
// (press/tools/generate-world.mjs), but unprojected: this globe turns.
async function worldData() {
  const { geoDistance } = await mod("node_modules/d3-geo/src/index.js");
  const { feature } = await mod("node_modules/topojson-client/src/index.js");
  const topology = JSON.parse(read(join(LANDING, "node_modules/world-atlas/land-110m.json")));
  const land = feature(topology, topology.objects.land);

  const source = read(join(LANDING, "src/data/relays.ts"));
  const sites = [];
  const pattern = /\{\s*lat:\s*(-?[\d.]+),\s*lng:\s*(-?[\d.]+),\s*relays:\s*(\d+)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    sites.push([Number(match[2]), Number(match[1]), Number(match[3])]);
  }
  sites.sort((a, b) => a[0] - b[0]);

  // Minimum spanning tree over great-circle distance, in the order Prim's
  // algorithm reaches each site, so the arcs grow outward from the first.
  const reached = new Array(sites.length).fill(false);
  const cost = new Array(sites.length).fill(Infinity);
  const from = new Array(sites.length).fill(0);
  const edges = [];
  cost[0] = 0;
  for (let step = 0; step < sites.length; step++) {
    let next = -1;
    for (let i = 0; i < sites.length; i++) {
      if (!reached[i] && (next < 0 || cost[i] < cost[next])) next = i;
    }
    reached[next] = true;
    if (step > 0) edges.push([from[next], next]);
    for (let i = 0; i < sites.length; i++) {
      if (reached[i]) continue;
      const d = geoDistance(sites[next], sites[i]);
      if (d < cost[i]) {
        cost[i] = d;
        from[i] = next;
      }
    }
  }
  return { land, sites, edges };
}

const plan = buildPlan(narrationLengths());
const data = await worldData();

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=1920, height=1080">
<title>Airhop</title>
<style>${read(join(ROOT, "..", "lib", "fonts.css"))}
/* The platform's own sans, as the brand asks. It is declared, not shipped:
   the file stays with the operating system that licenses it. */
@font-face{font-family:'Segoe UI Variable Display';font-weight:300 700;src:local('Segoe UI Variable Display'),local('Segoe UI Variable'),local('Segoe UI')}</style>
<style>
:root{${cssVars(DARK)}--sans:${SANS};--mono:'JetBrains Mono',ui-monospace,monospace}
${SCREEN_CSS}
${read(join(ROOT, "src", "stage.css"))}
</style>
</head>
<body>
${stageHtml(plan)}
<script src="vendor/gsap.min.js"></script>
<script src="vendor/d3-array.min.js"></script>
<script src="vendor/d3-geo.min.js"></script>
<script src="data.js"></script>
<script>${read(join(ROOT, "src", "world.js"))}</script>
<script>${read(join(ROOT, "src", "timeline.js"))}</script>
</body>
</html>
`;

mkdirSync(join(ROOT, "vendor"), { recursive: true });
copyFileSync(join(ROOT, "node_modules/gsap/dist/gsap.min.js"), join(ROOT, "vendor/gsap.min.js"));
copyFileSync(
  join(LANDING, "node_modules/d3-array/dist/d3-array.min.js"),
  join(ROOT, "vendor/d3-array.min.js"),
);
copyFileSync(join(LANDING, "node_modules/d3-geo/dist/d3-geo.min.js"), join(ROOT, "vendor/d3-geo.min.js"));
writeFileSync(
  join(ROOT, "data.js"),
  `const PLAN=${JSON.stringify(plan)};
const DATA=${JSON.stringify(data)};
`,
);
writeFileSync(join(ROOT, "index.html"), html);
console.log(`index.html, ${plan.duration.toFixed(1)}s, ${plan.lines.length} narration clips`);

// The voiceover carve: HyperFrames measures the narration and writes onto the
// music clip the filters and the envelope that make room for it. It is a step
// of the build because index.html is rewritten every time.
const carve = join(ROOT, ".claude/skills/hyperframes-audio/scripts/carve.mjs");
if (existsSync(carve)) {
  const report = node([carve, "--comp", join(ROOT, "index.html"), "--bed", "music"]);
  console.log(
    report
      .split("\n")
      .filter((l) => /^(carve|bands|level)/.test(l))
      .join("\n"),
  );
} else {
  console.warn(
    "carve skipped: install the HyperFrames skills (see README.md) or the music will sit on the voice",
  );
}
