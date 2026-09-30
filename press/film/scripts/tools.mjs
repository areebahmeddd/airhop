// What every film script shares: where the project is, and how to reach the
// command-line tools it leans on.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// One version for every HyperFrames call, so preview, check and render cannot
// disagree about what a composition means.
const HYPERFRAMES = "hyperframes@0.8.97";

// FFmpeg and the Kokoro Python packages normally come from PATH. A machine
// without them can keep private copies under .tools/, and those go first.
const LOCAL = [
  join(ROOT, ".tools", "ffmpeg", "bin"),
  join(ROOT, ".tools", "venv", "Scripts"),
  join(ROOT, ".tools", "venv", "bin"),
];
const env = { ...process.env, PATH: [...LOCAL.filter(existsSync), process.env.PATH].join(delimiter) };

// npx is a .cmd shim on Windows, which only a shell can start.
const shell = process.platform === "win32";
const quote = (arg) => (shell && /\s/.test(arg) ? `"${arg}"` : arg);

export function run(command, args, options = {}) {
  return execFileSync(command, args.map(quote), { cwd: ROOT, env, shell, encoding: "utf8", ...options });
}

export function hyperframes(args, options = {}) {
  return run("npx", ["--yes", HYPERFRAMES, ...args], options);
}

// FFmpeg is a real executable everywhere, and its arguments carry filter
// graphs a shell would mangle, so it is started directly.
export function ffmpeg(args, options = {}) {
  return execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { cwd: ROOT, env, ...options });
}

// Another Node script, such as one a HyperFrames skill ships.
export function node(args) {
  return execFileSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8" });
}

// The measured length of every narration clip, which the plan is built from.
export function narrationLengths() {
  const path = join(ROOT, "assets", "vo", "manifest.json");
  if (!existsSync(path)) throw new Error("No narration yet. Run `npm run narrate` first.");
  return JSON.parse(readFileSync(path, "utf8"));
}
