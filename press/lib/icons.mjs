// Icons and the brand mark, as inline SVG.

import { FEATHER } from "./feather.mjs";

// Glyphs the app takes from another family. `check-all` is Material's
// delivered tick, redrawn in Feather's stroke so it sits beside `check`.
const OTHER = {
  "check-all": '<path d="M1.5 12.5l4.5 4.5 9.5-9.5M11 16l1 1 9.5-9.5"/>',
};

export function icon(name, size = 20, color = "currentColor", stroke = 2) {
  const body = OTHER[name] ?? FEATHER[name];
  if (body === undefined) throw new Error(`icon: unknown name "${name}"`);
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

// The brand mark, drawn from the same pixel grid the landing hero uses.
const BIRD = [
  [1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1],
  [0, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0],
  [0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0],
  [0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0],
  [0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
];

export function pixelBird(width, fill = "var(--textPrimary)") {
  const cols = BIRD[0].length;
  const rows = BIRD.length;
  const cells = BIRD.flatMap((row, y) =>
    row.map((cell, x) => (cell ? `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${fill}"/>` : "")),
  ).join("");
  return `<svg width="${width}" height="${(width * rows) / cols}" viewBox="0 0 ${cols} ${rows}" shape-rendering="crispEdges">${cells}</svg>`;
}
