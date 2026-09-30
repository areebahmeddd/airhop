// The trailer's score, one stem with its effects mixed in.
//
//   node scripts/score-trailer.mjs
//
// Writes trailer/assets/music.wav: a 120 BPM hip-hop funk groove in E minor,
// played on the instruments in synth.mjs and arranged bar by bar from
// trailer/plan.mjs, so every cut lands on something the band plays.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { BEAT, buildPlan } from "../trailer/plan.mjs";
import {
  bass,
  bus,
  clap,
  clav,
  crash,
  hat,
  keys,
  kick,
  master,
  renderSfx,
  reverb,
  rim,
  sidechain,
  snare,
  SR,
  sum,
  writeWav,
} from "./synth.mjs";
import { ROOT } from "./tools.mjs";

const PLAN = buildPlan();
const LENGTH = Math.ceil(PLAN.duration * SR);
const at = (bar, beat = 0) => (bar * 4 + beat) * BEAT;

// Lighter than the film's 0.57: at this tempo a heavy swing reads as a shuffle.
const SWING = 0.54;
const STEP = BEAT / 4;

function stepTime(bar, step) {
  const pair = Math.floor(step / 2);
  const late = step % 2 === 1 ? SWING * 2 * STEP : 0;
  return at(bar) + pair * 2 * STEP + late;
}

// Em9, Cmaj9, Am9, B7#9. The intro sits on Em9 and hangs on B7#9, so the drop
// resolves home.
const EM9 = { root: 40, notes: [62, 66, 67, 71] };
const B7 = { root: 35, notes: [63, 69, 71, 74] };
const CHORDS = [EM9, { root: 36, notes: [62, 64, 67, 71] }, { root: 45, notes: [60, 64, 67, 71] }, B7];
const chordOf = (bar) => (bar === 0 ? EM9 : bar === 1 ? B7 : CHORDS[(bar - 2) % 4]);

function stab(music, send, time, length, chord, gain) {
  chord.notes.forEach((note, n) => keys(music, send, time + n * 0.006, length, note, gain, (n - 1.5) * 0.3));
}

const KICKS = [
  [0, 6, 10],
  [0, 3, 10, 13],
];

// Octave slap on the root, with the seventh and the fifth as passing notes:
// [step, length in steps, semitones above the root, gain].
const BASS = [
  [0, 1.6, 0, 0.9],
  [3, 0.8, 0, 0.7],
  [4, 0.6, 12, 0.6],
  [6, 1.2, 0, 0.8],
  [10, 1.4, 0, 0.85],
  [11, 0.6, 12, 0.6],
  [14, 0.8, 10, 0.65],
  [15, 0.6, 7, 0.6],
];

// The clavinet on the sixteenths the kick leaves empty, walking the chord's
// lower voices an octave down.
const CLAV = [1, 3, 5, 6, 9, 11, 13, 14];

function clavComp(music, send, bar, gain) {
  const chord = chordOf(bar);
  CLAV.forEach((step, n) => {
    clav(music, send, stepTime(bar, step), chord.notes[n % 3] - 12, gain, n % 2 === 0 ? -0.35 : 0.35);
  });
}

function groove(parts, bar) {
  const { drums, low, music, send, kicks } = parts;
  const chord = chordOf(bar);
  const variant = bar % 2;
  for (const step of KICKS[variant]) {
    const time = stepTime(bar, step);
    kicks.push(time);
    kick(drums, time, step === 0 ? 1 : 0.72);
  }
  for (const step of [4, 12]) {
    snare(drums, send, stepTime(bar, step), 0.5);
    clap(drums, send, stepTime(bar, step), 0.3);
  }
  for (const step of [7, 9, 15]) snare(drums, send, stepTime(bar, step), 0.09);
  for (let step = 0; step < 16; step++) {
    hat(drums, stepTime(bar, step), step % 4 === 2 ? 0.2 : step % 2 === 0 ? 0.14 : 0.08);
  }
  if (variant === 1) hat(drums, stepTime(bar, 14), 0.16, true);
  for (const [step, length, offset, gain] of BASS) {
    bass(low, stepTime(bar, step), STEP * length, chord.root + offset, gain);
  }
  clavComp(music, send, bar, 0.09);
  stab(music, send, stepTime(bar, 0), STEP * 1.5, chord, 0.2);
  stab(music, send, stepTime(bar, 10), STEP * 1.2, chord, 0.16);
}

// Stop-time: the band hits together on the beats it is given, and the hats
// alone keep the pulse between.
function stabs(parts, bar, beats, hats = true) {
  const { drums, low, music, send, kicks } = parts;
  const chord = chordOf(bar);
  for (const beat of beats) {
    const time = at(bar, beat);
    kicks.push(time);
    kick(drums, time, 1);
    clap(drums, send, time, beat % 2 === 1 ? 0.34 : 0.22);
    bass(low, time, STEP * 1.5, chord.root, 0.9);
    stab(music, send, time, STEP * 1.2, chord, 0.22);
    clav(music, send, time, chord.notes[1] - 12, 0.1, 0);
  }
  if (!hats) return;
  for (let step = 0; step < 16; step++) hat(drums, stepTime(bar, step), step % 2 === 0 ? 0.1 : 0.05);
}

function arrange() {
  const parts = {
    drums: bus(LENGTH),
    low: bus(LENGTH),
    music: bus(LENGTH),
    send: bus(LENGTH),
    kicks: [],
  };
  const { drums, low, music, send, kicks } = parts;
  const { T } = PLAN;

  PLAN.music.forEach((mode, bar) => {
    switch (mode) {
      // Clav and hats over the dying signal, a rim for each bar it loses, then
      // two hits for the two words and a snare roll into the drop.
      case "intro": {
        const chord = chordOf(bar);
        clavComp(music, send, bar, 0.08);
        for (let step = 0; step < 16; step += 2) hat(drums, stepTime(bar, step), 0.08);
        if (bar === 0) {
          T.drops.slice(0, 3).forEach((t) => rim(drums, send, t, 0.5));
        } else {
          for (const t of [T.noSignal, T.noWifi]) {
            kicks.push(t);
            kick(drums, t, 1);
            clap(drums, send, t, 0.3);
            bass(low, t, STEP * 3, chord.root, 0.85);
            stab(music, send, t, STEP * 2, chord, 0.2);
          }
          for (let n = 0; n < 8; n++) snare(drums, send, T.roll + (n * BEAT) / 8, 0.12 + n * 0.06);
        }
        break;
      }

      case "drop":
        crash(drums, send, at(bar), 0.26);
        groove(parts, bar);
        break;

      case "groove":
        groove(parts, bar);
        break;

      case "stabs":
        stabs(parts, bar, [0, 1, 2, 3]);
        break;

      // Three hits for three words, then a beat of silence before the mark.
      case "stop":
        stabs(parts, bar, [0, 1, 2], false);
        for (let step = 0; step < 12; step++) hat(drums, stepTime(bar, step), step % 2 === 0 ? 0.1 : 0.05);
        break;

      // The last chord, left to ring under the mark.
      case "end":
        kicks.push(at(bar));
        kick(drums, at(bar), 1);
        crash(drums, send, at(bar), 0.24);
        bass(low, at(bar), 1.4, chordOf(bar).root, 0.9);
        stab(music, send, at(bar), 1.6, chordOf(bar), 0.3);
        keys(music, send, at(bar) + 0.2, 1.6, 78, 0.12, 0.2);
        break;
    }
  });

  // A splash where the picture turns a corner.
  for (const t of [T.fold, T.globe, T.pay, T.land, T.proofs[0]]) crash(drums, send, t, 0.14);

  return parts;
}

const { drums, low, music, send, kicks } = arrange();
sidechain(music, kicks, 0.3);
sidechain(low, kicks, 0.45);
const mix = sum(drums, low, music, reverb(send, 0.5), renderSfx(PLAN.cues, LENGTH, 0.3));

// The mark gets the last two seconds; the chord fades out under it by the end.
const fadeFrom = Math.round((PLAN.T.url + BEAT) * SR);
for (let i = fadeFrom; i < LENGTH; i++) {
  const level = Math.max(0, 1 - (i - fadeFrom) / (LENGTH - fadeFrom));
  mix.l[i] *= level;
  mix.r[i] *= level;
}

master(mix, 0.7, 0.7);
mkdirSync(join(ROOT, "trailer", "assets"), { recursive: true });
writeWav(join(ROOT, "trailer", "assets", "music.wav"), mix);
console.log(`trailer/assets/music.wav, ${PLAN.duration.toFixed(1)}s, ${PLAN.cues.length} cues`);
