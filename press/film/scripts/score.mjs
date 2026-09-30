// The score and the interface sounds.
//
//   node scripts/score.mjs
//
// Writes two stems into assets/, which HyperFrames mixes with the narration:
//
//   music.wav  A 100 BPM swung funk groove in E dorian, synthesized here from
//              oscillators and seeded noise, so it carries no licence and two
//              runs give the same file byte for byte. Arranged scene by scene
//              from the plan.
//   sfx.wav    Every tap, tick and arrival the plan cues, cut from the recorded
//              effects in assets/sfx/ (Pixabay licence, see CREDITS.md there).
//
// The narration is not mixed in here. It sits over the music as separate clips
// in index.html, and the voiceover carve makes room for it.

import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { BAR, BEAT, buildPlan } from "../plan.mjs";
import { ffmpeg, narrationLengths, ROOT } from "./tools.mjs";

const PLAN = buildPlan(narrationLengths());
const at = (bar, beat = 0) => (bar * 4 + beat) * BEAT;

const SR = 48000;
const LENGTH = Math.ceil(PLAN.duration * SR);

// Offbeat sixteenths land late. 0.5 is straight, 0.667 is a full triplet; 0.57
// is the lazy middle that makes a programmed hat stop sounding programmed.
const SWING = 0.57;
const STEP = BEAT / 4;

let seed = 0x41697268;
function noise() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2147483648 - 1;
}

function bus() {
  return { l: new Float32Array(LENGTH), r: new Float32Array(LENGTH) };
}

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

// Step index within a bar to seconds, swung.
function stepTime(bar, step) {
  const pair = Math.floor(step / 2);
  const late = step % 2 === 1 ? SWING * 2 * STEP : 0;
  return at(bar) + pair * 2 * STEP + late;
}

// Writes `length` seconds of a voice into a bus. `fn(t, i)` returns a mono
// sample; pan runs -1 to 1.
function voice(target, start, length, gain, pan, fn) {
  const from = Math.max(0, Math.round(start * SR));
  const count = Math.round(length * SR);
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < count && from + i < LENGTH; i++) {
    const s = fn(i / SR, i);
    target.l[from + i] += s * gl;
    target.r[from + i] += s * gr;
  }
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

function kick(target, time, gain = 1) {
  let phase = 0;
  voice(target, time, 0.5, gain, 0, (t) => {
    const freq = 46 + 120 * Math.exp(-t * 34);
    phase += (2 * Math.PI * freq) / SR;
    const click = t < 0.003 ? noise() * 0.5 : 0;
    return Math.tanh((Math.sin(phase) * Math.exp(-t * 7.5) + click) * 1.6);
  });
}

function snare(target, send, time, gain = 1) {
  let prev = 0;
  const fn = (t) => {
    const n = noise();
    const bright = n - prev;
    prev = n;
    const body = Math.sin(2 * Math.PI * 188 * t) * Math.exp(-t * 28);
    return (bright * 0.75 + n * 0.25) * Math.exp(-t * 19) + body * 0.7;
  };
  voice(target, time, 0.32, gain, 0.05, fn);
  voice(send, time, 0.32, gain * 0.35, 0, fn);
}

function rim(target, send, time, gain = 1) {
  const fn = (t) =>
    (Math.sin(2 * Math.PI * 1720 * t) * 0.7 + Math.sin(2 * Math.PI * 820 * t) * 0.4 + noise() * 0.25) *
    Math.exp(-t * 95);
  voice(target, time, 0.09, gain, -0.15, fn);
  voice(send, time, 0.09, gain * 0.4, 0, fn);
}

function hat(target, time, gain = 1, open = false) {
  let a = 0;
  let b = 0;
  voice(target, time, open ? 0.34 : 0.07, gain, 0.22, (t) => {
    const n = noise();
    const hp1 = n - a;
    a = n;
    const hp2 = hp1 - b;
    b = hp1;
    return hp2 * 0.5 * Math.exp(-t * (open ? 11 : 75));
  });
}

function crash(target, send, time, gain = 1) {
  let a = 0;
  const fn = (t) => {
    const n = noise();
    const hp = n - a;
    a = n;
    return hp * Math.exp(-t * 2.4) * Math.min(1, t * 400);
  };
  voice(target, time, 1.8, gain, -0.2, fn);
  voice(send, time, 1.8, gain * 0.5, 0, fn);
}

function bass(target, time, length, note, gain = 1) {
  const f = midi(note);
  voice(target, time, length + 0.08, gain, 0, (t) => {
    const attack = Math.min(1, t / 0.006);
    const release = t > length ? Math.max(0, 1 - (t - length) / 0.08) : 1;
    const w = 2 * Math.PI * f * t;
    const tone =
      Math.sin(w) +
      0.55 * Math.sin(2 * w) * Math.exp(-t * 7) +
      0.3 * Math.sin(3 * w) * Math.exp(-t * 11) +
      0.12 * Math.sin(4 * w) * Math.exp(-t * 16);
    return Math.tanh(tone * 0.9) * attack * release * (0.55 + 0.45 * Math.exp(-t * 5));
  });
}

// An electric piano by frequency modulation: a soft fundamental, plus a bright
// tine that is gone within a tenth of a second.
function keys(target, send, time, length, note, gain = 1, pan = 0) {
  const f = midi(note);
  const fn = (t) => {
    const attack = Math.min(1, t / 0.004);
    const release = t > length ? Math.exp(-(t - length) * 14) : 1;
    const w = 2 * Math.PI * f * t;
    const body = Math.sin(w + 1.1 * Math.exp(-t * 3.2) * Math.sin(w));
    const tine = Math.sin(w + 0.9 * Math.exp(-t * 22) * Math.sin(14 * w)) * Math.exp(-t * 9) * 0.35;
    const tremolo = 1 + 0.06 * Math.sin(2 * Math.PI * 4.6 * (time + t));
    return (body + tine) * Math.exp(-t * 1.9) * attack * release * tremolo;
  };
  voice(target, time, length + 0.5, gain, pan, fn);
  voice(send, time, length + 0.5, gain * 0.45, 0, fn);
}

// A clavinet, near enough: odd harmonics, a hard attack, gone in a tenth of a
// second. It plays the sixteenths the keys leave empty, which is most of what
// makes a groove read as funk.
function clav(target, send, time, note, gain = 1, pan = 0) {
  const f = midi(note);
  const fn = (t) => {
    const w = 2 * Math.PI * f * t;
    const tone = Math.sin(w) + Math.sin(3 * w) / 3 + Math.sin(5 * w) / 5 + Math.sin(7 * w) / 7;
    return tone * Math.exp(-t * 26) * Math.min(1, t / 0.002);
  };
  voice(target, time, 0.16, gain, pan, fn);
  voice(send, time, 0.16, gain * 0.2, 0, fn);
}

// Three hands, a few milliseconds apart.
function clap(target, send, time, gain = 1) {
  [0, 0.011, 0.023].forEach((offset, n) => {
    let a = 0;
    let b = 0;
    const fn = (t) => {
      const n1 = noise();
      a += (n1 - a) * 0.45;
      const band = a - b;
      b += (a - b) * 0.12;
      return band * Math.exp(-t * (n === 2 ? 16 : 60)) * 1.8;
    };
    voice(target, time + offset, 0.22, gain, 0.1, fn);
    voice(send, time + offset, 0.22, gain * 0.5, 0, fn);
  });
}

function pad(target, send, time, length, notes, gain = 1) {
  notes.forEach((note, n) => {
    const f = midi(note);
    const fn = (t) => {
      const env = Math.min(1, t / 0.9) * Math.min(1, Math.max(0, (length - t) / 0.9));
      const w = 2 * Math.PI * t;
      return (Math.sin(w * f) + Math.sin(w * f * 1.004) + 0.4 * Math.sin(w * f * 2.002)) * env * 0.33;
    };
    voice(target, time, length, gain, n % 2 === 0 ? -0.5 : 0.5, fn);
    voice(send, time, length, gain * 0.6, 0, fn);
  });
}

// ---------------------------------------------------------------------------
// Harmony and patterns
// ---------------------------------------------------------------------------

// Four bars round: Em9, A13, Em9, then Cmaj9 turning through B7#9. The top
// three voices barely move, which is what lets the comping stay out of the way.
const CHORDS = [
  { root: 40, notes: [62, 66, 67, 71] },
  { root: 45, notes: [61, 66, 67, 71] },
  { root: 40, notes: [62, 66, 67, 71] },
  { root: 36, notes: [62, 64, 67, 71], turn: { root: 35, notes: [63, 69, 71, 74] } },
];

function chordAt(bar, step) {
  const chord = CHORDS[bar % 4];
  return chord.turn !== undefined && step >= 8 ? chord.turn : chord;
}

function playChord(music, send, time, length, chord, gain, roll = 0) {
  chord.notes.forEach((note, n) => {
    keys(music, send, time + n * roll, length, note, gain, (n - 1.5) * 0.28);
  });
}

function drumsFull(drums, send, bar, accent) {
  const variant = bar % 2;
  for (const step of variant === 0 ? [0, 7, 10] : [0, 3, 10, 11]) {
    kick(drums, stepTime(bar, step), step === 3 || step === 11 ? 0.62 : 0.95);
  }
  snare(drums, send, stepTime(bar, 4), 0.62);
  snare(drums, send, stepTime(bar, 12), 0.66);
  if (variant === 1) snare(drums, send, stepTime(bar, 15), 0.16);
  snare(drums, send, stepTime(bar, 9), 0.1);
  for (let step = 0; step < 16; step++) {
    if (step % 2 === 0) {
      hat(drums, stepTime(bar, step), step % 4 === 2 ? 0.2 : 0.13);
    } else if (step === 5 || step === 13 || (variant === 1 && step === 7)) {
      hat(drums, stepTime(bar, step), 0.07);
    }
  }
  if (variant === 1) hat(drums, stepTime(bar, 14), 0.16, true);
  if (accent) {
    hat(drums, stepTime(bar, 0), 0.2, true);
    hat(drums, stepTime(bar, 8), 0.2, true);
  }
}

function bassFull(low, bar) {
  const a = chordAt(bar, 0).root;
  const b = chordAt(bar, 8).root;
  bass(low, stepTime(bar, 0), STEP * 2.4, a, 0.9);
  bass(low, stepTime(bar, 3), STEP * 0.8, a, 0.7);
  bass(low, stepTime(bar, 6), STEP * 0.7, a + 12, 0.62);
  bass(low, stepTime(bar, 7), STEP * 0.9, a, 0.8);
  bass(low, stepTime(bar, 10), STEP * 1.6, b, 0.88);
  bass(low, stepTime(bar, 13), STEP * 0.7, b + 10, 0.6);
  bass(low, stepTime(bar, 14), STEP * 0.8, b + 7, 0.66);
  if (bar % 2 === 1) bass(low, stepTime(bar, 15), STEP * 0.6, b + 12, 0.55);
}

// The clavinet's bar: syncopated sixteenths on the chord's inner voices,
// dropping an octave on the pushes.
const CLAV_STEPS = [
  [2, 1, 0.8],
  [3, 2, 0.55],
  [5, 1, 0.7],
  [8, 2, 0.85],
  [9, 1, 0.5],
  [11, 3, 0.75],
  [14, 2, 0.8],
  [15, 1, 0.55],
];

function clavComp(music, send, bar, gain) {
  for (const [step, voiceIndex, level] of CLAV_STEPS) {
    const chord = chordAt(bar, step);
    clav(
      music,
      send,
      stepTime(bar, step),
      chord.notes[voiceIndex % chord.notes.length] - 12,
      gain * level,
      step % 4 < 2 ? -0.35 : 0.35,
    );
  }
}

function keysComp(music, send, bar, gain) {
  playChord(music, send, stepTime(bar, 0), STEP * 3.2, chordAt(bar, 0), gain, 0.012);
  playChord(music, send, stepTime(bar, 6), STEP * 0.9, chordAt(bar, 6), gain * 0.7);
  playChord(music, send, stepTime(bar, 11), STEP * 2.2, chordAt(bar, 11), gain * 0.82, 0.008);
}

// ---------------------------------------------------------------------------
// Arrangement
// ---------------------------------------------------------------------------

// What the band plays under each scene:
//   air     pad and keys, no drums
//   light   keys, bass, hats and rim
//   pulse   a pad that grows, nothing else
//   full    the whole groove
//   break   nothing
//   cuts    the groove with an accent on every half bar
//   half    half-time, keys and sub, for the wallet
//   out     keys and pad
//   end     keys, then the last chord where the mark lands
function modeAt(time) {
  for (const scene of Object.values(PLAN.scenes)) {
    if (time >= scene.start - 1e-6 && time < scene.end - 1e-6) return scene.music;
  }
  return "break";
}

function arrange() {
  const drums = bus();
  const low = bus();
  const music = bus();
  const send = bus();
  const kicks = [];
  const trackedKick = (time, gain) => {
    kicks.push(time);
    kick(drums, time, gain);
  };

  const bars = Math.round(PLAN.duration / BAR);
  let run = 0;
  for (let bar = 0; bar < bars; bar++) {
    const mode = modeAt(at(bar));
    const first = bar === 0 || modeAt(at(bar - 1)) !== mode;
    const last = bar === bars - 1 || modeAt(at(bar + 1)) !== mode;
    run = first ? 0 : run + 1;
    const chord = chordAt(bar, 0);

    switch (mode) {
      case "air":
      case "out":
        pad(music, send, at(bar), BAR + 0.6, [chord.root + 12, ...chord.notes.slice(1)], 0.1);
        playChord(music, send, at(bar), BAR * 0.9, chord, 0.16, 0.09);
        if (run > 0) hat(drums, stepTime(bar, 8), 0.05);
        break;

      case "light":
        keysComp(music, send, bar, 0.19);
        bass(low, stepTime(bar, 0), STEP * 3, chord.root, 0.7);
        bass(low, stepTime(bar, 10), STEP * 1.6, chordAt(bar, 10).root, 0.62);
        trackedKick(stepTime(bar, 0), 0.7);
        if (run > 0) trackedKick(stepTime(bar, 10), 0.55);
        rim(drums, send, stepTime(bar, 4), 0.34);
        rim(drums, send, stepTime(bar, 12), 0.34);
        for (let step = 0; step < 16; step += 2) hat(drums, stepTime(bar, step), 0.09);
        break;

      case "pulse":
        pad(music, send, at(bar), BAR + 0.6, [chord.root, chord.root + 7, chord.notes[2]], 0.05 + run * 0.03);
        break;

      case "full":
      case "cuts": {
        const accent = mode === "cuts";
        drumsFull(drums, send, bar, accent);
        for (const step of bar % 2 === 0 ? [0, 7, 10] : [0, 3, 10, 11]) kicks.push(stepTime(bar, step));
        bassFull(low, bar);
        keysComp(music, send, bar, accent ? 0.24 : 0.2);
        clavComp(music, send, bar, accent ? 0.085 : 0.07);
        clap(drums, send, stepTime(bar, 4), 0.2);
        clap(drums, send, stepTime(bar, 12), 0.22);
        if (first) crash(drums, send, at(bar), 0.2);
        if (accent) playChord(music, send, stepTime(bar, 8), STEP * 1.2, chordAt(bar, 8), 0.2);
        if (last && !accent) {
          snare(drums, send, stepTime(bar, 14), 0.3);
          snare(drums, send, stepTime(bar, 15), 0.42);
        }
        break;
      }

      // Half-time: the backbeat moves to beat three and everything breathes.
      case "half":
        trackedKick(stepTime(bar, 0), 0.8);
        if (bar % 2 === 1) trackedKick(stepTime(bar, 7), 0.5);
        rim(drums, send, stepTime(bar, 8), 0.4);
        for (let step = 0; step < 16; step += 2) hat(drums, stepTime(bar, step), step % 4 === 2 ? 0.1 : 0.06);
        if (bar % 2 === 1) hat(drums, stepTime(bar, 14), 0.08, true);
        bass(low, stepTime(bar, 0), STEP * 9, chord.root, 0.78);
        bass(low, stepTime(bar, 10), STEP * 5, chordAt(bar, 10).root, 0.7);
        playChord(music, send, at(bar), BAR * 0.92, chord, 0.2, 0.06);
        keys(music, send, stepTime(bar, 6), STEP * 2, chord.notes[3] + 12, 0.1, 0.4);
        keys(music, send, stepTime(bar, 11), STEP * 3, chord.notes[1] + 12, 0.09, -0.4);
        if (chord.turn !== undefined)
          playChord(music, send, stepTime(bar, 8), BAR * 0.45, chord.turn, 0.16, 0.05);
        if (first) crash(drums, send, at(bar), 0.1);
        break;

      // One bar of keys over the white frame, then the mark owns the downbeat.
      case "end":
        if (run === 0) playChord(music, send, at(bar), BAR * 0.9, chord, 0.14, 0.1);
        break;

      case "break":
        break;
    }
  }

  // The last thing heard: Em9 over a low E, left to ring under the mark.
  const final = PLAN.T.final;
  playChord(music, send, final, 5, CHORDS[0], 0.3, 0.05);
  keys(music, send, final + 0.2, 5, 78, 0.12, 0.2);
  bass(low, final, 1.3, 40, 0.8);
  kick(drums, final, 0.9);
  kicks.push(final);
  crash(drums, send, final, 0.18);

  return { drums, low, music, send, kicks };
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

// Schroeder reverb: four combs into two allpasses per side, with the two sides
// tuned apart so the tail is wide without a stereo trick.
function reverb(send, gain) {
  const out = bus();
  const tunings = { l: [1557, 1617, 1491, 1422], r: [1580, 1640, 1514, 1445] };
  const allpass = { l: [225, 556], r: [248, 579] };
  for (const side of ["l", "r"]) {
    const input = send[side];
    const mixed = new Float32Array(LENGTH);
    for (const size of tunings[side]) {
      const buffer = new Float32Array(size);
      let index = 0;
      let damp = 0;
      for (let i = 0; i < LENGTH; i++) {
        const delayed = buffer[index];
        damp = delayed * 0.72 + damp * 0.28;
        buffer[index] = input[i] + damp * 0.8;
        index = (index + 1) % size;
        mixed[i] += delayed * 0.25;
      }
    }
    let signal = mixed;
    for (const size of allpass[side]) {
      const buffer = new Float32Array(size);
      const next = new Float32Array(LENGTH);
      let index = 0;
      for (let i = 0; i < LENGTH; i++) {
        const delayed = buffer[index];
        buffer[index] = signal[i] + delayed * 0.5;
        next[i] = delayed - signal[i] * 0.5;
        index = (index + 1) % size;
      }
      signal = next;
    }
    for (let i = 0; i < LENGTH; i++) out[side][i] = signal[i] * gain;
  }
  return out;
}

// The kick ducks the keys and bass for a moment, so the low end has one owner
// at a time.
function sidechain(target, kicks, depth) {
  const env = new Float32Array(LENGTH).fill(1);
  for (const time of kicks) {
    const from = Math.round(time * SR);
    const span = Math.round(0.22 * SR);
    for (let i = 0; i < span && from + i < LENGTH; i++) {
      const duck = 1 - depth * Math.exp(-(i / SR) * 16);
      if (duck < env[from + i]) env[from + i] = duck;
    }
  }
  for (let i = 0; i < LENGTH; i++) {
    target.l[i] *= env[i];
    target.r[i] *= env[i];
  }
}

// A turntable losing power: the top end closes and the level falls together.
function tapeStop(target, from, length) {
  const start = Math.round(from * SR);
  const count = Math.round(length * SR);
  let l = 0;
  let r = 0;
  for (let i = 0; i < count && start + i < LENGTH; i++) {
    const p = i / count;
    const k = 0.9 * (1 - p) ** 3 + 0.0015;
    l += (target.l[start + i] - l) * k;
    r += (target.r[start + i] - r) * k;
    const level = (1 - p) ** 1.5;
    target.l[start + i] = l * level;
    target.r[start + i] = r * level;
  }
}

function sum(...buses) {
  const out = bus();
  for (const b of buses) {
    for (let i = 0; i < LENGTH; i++) {
      out.l[i] += b.l[i];
      out.r[i] += b.r[i];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Interface sounds
// ---------------------------------------------------------------------------

// Decodes one recorded effect to stereo floats at the working rate.
function sample(name) {
  const raw = ffmpeg(
    ["-i", join(ROOT, "assets", "sfx", `${name}.mp3`), "-f", "f32le", "-ac", "2", "-ar", String(SR), "-"],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

// Effects sit under the voice: about a third of full scale before each cue's
// own gain.
const SFX_LEVEL = 0.34;

function renderSfx(cues) {
  const out = bus();
  const cache = new Map();
  for (const cue of cues) {
    if (!cache.has(cue.kind)) cache.set(cue.kind, sample(cue.kind));
    const data = cache.get(cue.kind);
    const start = Math.round(cue.time * SR);
    const gain = SFX_LEVEL * cue.gain;
    // A cue placed before zero, such as a riser timed back from its peak,
    // plays from partway in.
    for (let i = Math.max(0, -start); i < data.length / 2 && start + i < LENGTH; i++) {
      out.l[start + i] += data[i * 2] * gain;
      out.r[start + i] += data[i * 2 + 1] * gain;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

// Soft-clips, then scales to a ceiling. `drive` is set so the loudest bar only
// grazes the knee: the saturation is glue, not distortion.
function master(mix, ceiling, drive) {
  let peak = 0;
  for (let i = 0; i < LENGTH; i++) {
    mix.l[i] = Math.tanh(mix.l[i] * drive);
    mix.r[i] = Math.tanh(mix.r[i] * drive);
    peak = Math.max(peak, Math.abs(mix.l[i]), Math.abs(mix.r[i]));
  }
  const scale = peak > 0 ? Math.min(1, ceiling / peak) : 1;
  for (let i = 0; i < LENGTH; i++) {
    mix.l[i] *= scale;
    mix.r[i] *= scale;
  }
}

function silence(target, from, until, fade = 0.05) {
  const start = Math.round(from * SR);
  const end = Math.min(LENGTH, Math.round(until * SR));
  for (let i = start; i < end; i++) {
    const level = Math.max(0, 1 - (i - start) / (fade * SR));
    target.l[i] *= level;
    target.r[i] *= level;
  }
}

function writeWav(path, mix) {
  const data = Buffer.alloc(LENGTH * 4);
  for (let i = 0; i < LENGTH; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mix.l[i])) * 32767), i * 4);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mix.r[i])) * 32767), i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

const { drums, low, music, send, kicks } = arrange();
sidechain(music, kicks, 0.3);
sidechain(low, kicks, 0.45);
const bed = sum(drums, low, music, reverb(send, 0.55));

// The network goes, and the music goes with it, until the first ring.
tapeStop(bed, PLAN.T.stop, BEAT * 1.5);
silence(bed, PLAN.T.stop + BEAT * 1.5, PLAN.scenes.idea.start, 0.01);
// The panic wipe takes the music too.
silence(bed, PLAN.T.wipe + 0.05, PLAN.scenes.notdone.start);
// The end card fades with the picture.
const fadeFrom = Math.round(PLAN.T.fade * SR);
for (let i = fadeFrom; i < LENGTH; i++) {
  const level = Math.max(0, 1 - (i - fadeFrom) / (LENGTH - fadeFrom));
  bed.l[i] *= level;
  bed.r[i] *= level;
}

master(bed, 0.7, 0.62);
writeWav(join(ROOT, "assets", "music.wav"), bed);

const sfx = renderSfx(PLAN.cues);
master(sfx, 0.8, 1);
writeWav(join(ROOT, "assets", "sfx.wav"), sfx);

console.log(`music.wav and sfx.wav, ${PLAN.duration.toFixed(1)}s, ${PLAN.cues.length} cues`);
