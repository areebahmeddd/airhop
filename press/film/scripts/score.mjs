// The score and the interface sounds.
//
//   node scripts/score.mjs
//
// Writes two stems into assets/, which HyperFrames mixes with the narration:
//
//   music.wav  A 100 BPM swung funk groove in E dorian, played on the
//              instruments in synth.mjs and arranged scene by scene from the
//              plan.
//   sfx.wav    Every tap, tick and arrival the plan cues, cut from the recorded
//              effects in assets/sfx/ (Pixabay licence, see CREDITS.md there).
//
// The narration is not mixed in here. It sits over the music as separate clips
// in index.html, and the voiceover carve makes room for it.

import { join } from "node:path";

import { BAR, BEAT, buildPlan } from "../plan.mjs";
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
  pad,
  renderSfx,
  reverb,
  rim,
  sidechain,
  silence,
  snare,
  SR,
  sum,
  tapeStop,
  writeWav,
} from "./synth.mjs";
import { narrationLengths, ROOT } from "./tools.mjs";

const PLAN = buildPlan(narrationLengths());
const at = (bar, beat = 0) => (bar * 4 + beat) * BEAT;

const LENGTH = Math.ceil(PLAN.duration * SR);

// Offbeat sixteenths land late. 0.5 is straight, 0.667 is a full triplet; 0.57
// is the lazy middle that makes a programmed hat stop sounding programmed.
const SWING = 0.57;
const STEP = BEAT / 4;

// Step index within a bar to seconds, swung.
function stepTime(bar, step) {
  const pair = Math.floor(step / 2);
  const late = step % 2 === 1 ? SWING * 2 * STEP : 0;
  return at(bar) + pair * 2 * STEP + late;
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
  const drums = bus(LENGTH);
  const low = bus(LENGTH);
  const music = bus(LENGTH);
  const send = bus(LENGTH);
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

// Effects sit under the voice: about a third of full scale before each cue's
// own gain.
const SFX_LEVEL = 0.34;

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

const sfx = renderSfx(PLAN.cues, LENGTH, SFX_LEVEL);
master(sfx, 0.8, 1);
writeWav(join(ROOT, "assets", "sfx.wav"), sfx);

console.log(`music.wav and sfx.wav, ${PLAN.duration.toFixed(1)}s, ${PLAN.cues.length} cues`);
