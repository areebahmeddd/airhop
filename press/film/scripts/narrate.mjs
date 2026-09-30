// Speaks the narration with Kokoro, through `hyperframes tts`.
//
//   node scripts/narrate.mjs          only the lines whose text changed
//   node scripts/narrate.mjs --all    every line again
//
// Writes assets/vo/<id>.wav and assets/vo/manifest.json, which records each
// clip's measured length. plan.mjs sizes the scenes from those lengths, so the
// picture follows the voice and not the other way round.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LINES, SPEED, VOICE } from "../script.mjs";
import { hyperframes, ROOT, run } from "./tools.mjs";

const DIR = join(ROOT, "assets", "vo");
const MANIFEST = join(DIR, "manifest.json");

function seconds(path) {
  return Number(
    run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).trim(),
  );
}

mkdirSync(DIR, { recursive: true });
const previous = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {};
const all = process.argv.includes("--all");
const manifest = {};

for (const { id, say } of LINES) {
  const path = join(DIR, `${id}.wav`);
  const hash = createHash("sha1").update(`${VOICE}|${SPEED}|${say}`).digest("hex").slice(0, 12);
  const kept = previous[id];
  if (!all && kept !== undefined && kept.hash === hash && existsSync(path)) {
    manifest[id] = kept;
    continue;
  }
  // The text goes through a file: a shell would mangle the apostrophes.
  const textPath = join(DIR, `${id}.txt`);
  writeFileSync(textPath, say);
  hyperframes(["tts", textPath, "-v", VOICE, "-s", String(SPEED), "-o", path]);
  manifest[id] = { hash, seconds: Number(seconds(path).toFixed(3)) };
  console.log(`${id.padEnd(4)} ${manifest[id].seconds.toFixed(2)}s  ${say}`);
}

writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
const total = Object.values(manifest).reduce((sum, clip) => sum + clip.seconds, 0);
console.log(`${LINES.length} lines, ${total.toFixed(1)}s of speech`);
