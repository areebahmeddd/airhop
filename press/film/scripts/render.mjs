// Renders the film or the trailer to one file.
//
//   node scripts/render.mjs             the film, renders/airhop-launch.mp4
//   node scripts/render.mjs --trailer   the trailer, renders/airhop-trailer.mp4
//
// Both are 3840x2160 at 60 fps; add --1080 for 1920x1080 under the same name.
//
// HyperFrames renders the picture and mixes the sound. The mix is then brought
// up to delivery level, which is the only thing this script adds.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ffmpeg, hyperframes, ROOT } from "./tools.mjs";

const trailer = process.argv.includes("--trailer");
const OUT = join(ROOT, "renders");
const raw = join(OUT, ".render.mp4");
const target = join(OUT, trailer ? "airhop-trailer.mp4" : "airhop-launch.mp4");

// HyperFrames mixes with headroom: the film lands near -19 LUFS, and the
// trailer, with no voice to leave room for, near -16. A fixed gain under a
// limiter lifts the film to about -15 and the trailer to about -14 without the
// pumping a loudness normalizer adds to a voice over music. The ceiling is low
// because AAC overshoots on the way back out.
const GAIN = trailer ? "2.5dB" : "4.5dB";
const LOUDER = `volume=${GAIN},alimiter=limit=0.7:attack=5:release=80:level=false`;

const size = process.argv.includes("--1080") ? [] : ["--resolution", "4k"];

mkdirSync(OUT, { recursive: true });
await import("./build.mjs");
const project = trailer ? ["trailer"] : [];
hyperframes(["render", ...project, "--fps", "60", "--quality", "high", ...size, "--output", raw], {
  stdio: "inherit",
});
ffmpeg([
  "-i",
  raw,
  "-c:v",
  "copy",
  "-af",
  LOUDER,
  "-c:a",
  "aac",
  "-b:a",
  "256k",
  "-movflags",
  "+faststart",
  target,
]);
rmSync(raw);
console.log(target);
