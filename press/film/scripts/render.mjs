// Renders the film to one file.
//
//   node scripts/render.mjs          3840x2160 at 60 fps, renders/airhop-launch.mp4
//   node scripts/render.mjs --1080   1920x1080 at 60 fps, the same name
//
// HyperFrames renders the picture and mixes the sound. The mix is then brought
// up to delivery level, which is the only thing this script adds.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ffmpeg, hyperframes, ROOT } from "./tools.mjs";

const OUT = join(ROOT, "renders");
const raw = join(OUT, ".render.mp4");
const target = join(OUT, "airhop-launch.mp4");

// HyperFrames mixes with headroom, which lands near -19 LUFS. A fixed gain
// under a limiter lifts it to about -15 without the pumping a loudness
// normalizer adds to a voice over music. The ceiling is low because AAC
// overshoots on the way back out.
const LOUDER = "volume=4.5dB,alimiter=limit=0.7:attack=5:release=80:level=false";

const size = process.argv.includes("--1080") ? [] : ["--resolution", "4k"];

mkdirSync(OUT, { recursive: true });
await import("./build.mjs");
hyperframes(["render", "--fps", "60", "--quality", "high", ...size, "--output", raw], { stdio: "inherit" });
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
