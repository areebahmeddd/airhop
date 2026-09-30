// The instruments and the mix both scores are built from: oscillators and
// seeded noise, so a score carries no licence and two runs give the same file
// byte for byte. Tempo and arrangement belong to each score, not to this file.

import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ffmpeg, ROOT } from "./tools.mjs";

export const SR = 48000;

let seed = 0x41697268;
function noise() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2147483648 - 1;
}

export function bus(length) {
  return { l: new Float32Array(length), r: new Float32Array(length) };
}

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

// Writes `length` seconds of a voice into a bus. `fn(t, i)` returns a mono
// sample; pan runs -1 to 1.
function voice(target, start, length, gain, pan, fn) {
  const end = target.l.length;
  const from = Math.max(0, Math.round(start * SR));
  const count = Math.round(length * SR);
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < count && from + i < end; i++) {
    const s = fn(i / SR, i);
    target.l[from + i] += s * gl;
    target.r[from + i] += s * gr;
  }
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

export function kick(target, time, gain = 1) {
  let phase = 0;
  voice(target, time, 0.5, gain, 0, (t) => {
    const freq = 46 + 120 * Math.exp(-t * 34);
    phase += (2 * Math.PI * freq) / SR;
    const click = t < 0.003 ? noise() * 0.5 : 0;
    return Math.tanh((Math.sin(phase) * Math.exp(-t * 7.5) + click) * 1.6);
  });
}

export function snare(target, send, time, gain = 1) {
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

export function rim(target, send, time, gain = 1) {
  const fn = (t) =>
    (Math.sin(2 * Math.PI * 1720 * t) * 0.7 + Math.sin(2 * Math.PI * 820 * t) * 0.4 + noise() * 0.25) *
    Math.exp(-t * 95);
  voice(target, time, 0.09, gain, -0.15, fn);
  voice(send, time, 0.09, gain * 0.4, 0, fn);
}

export function hat(target, time, gain = 1, open = false) {
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

export function crash(target, send, time, gain = 1) {
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

export function bass(target, time, length, note, gain = 1) {
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
export function keys(target, send, time, length, note, gain = 1, pan = 0) {
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
export function clav(target, send, time, note, gain = 1, pan = 0) {
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
export function clap(target, send, time, gain = 1) {
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

export function pad(target, send, time, length, notes, gain = 1) {
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
// Processing
// ---------------------------------------------------------------------------

// Schroeder reverb: four combs into two allpasses per side, with the two sides
// tuned apart so the tail is wide without a stereo trick.
export function reverb(send, gain) {
  const length = send.l.length;
  const out = bus(length);
  const tunings = { l: [1557, 1617, 1491, 1422], r: [1580, 1640, 1514, 1445] };
  const allpass = { l: [225, 556], r: [248, 579] };
  for (const side of ["l", "r"]) {
    const input = send[side];
    const mixed = new Float32Array(length);
    for (const size of tunings[side]) {
      const buffer = new Float32Array(size);
      let index = 0;
      let damp = 0;
      for (let i = 0; i < length; i++) {
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
      const next = new Float32Array(length);
      let index = 0;
      for (let i = 0; i < length; i++) {
        const delayed = buffer[index];
        buffer[index] = signal[i] + delayed * 0.5;
        next[i] = delayed - signal[i] * 0.5;
        index = (index + 1) % size;
      }
      signal = next;
    }
    for (let i = 0; i < length; i++) out[side][i] = signal[i] * gain;
  }
  return out;
}

// The kick ducks the keys and bass for a moment, so the low end has one owner
// at a time.
export function sidechain(target, kicks, depth) {
  const length = target.l.length;
  const env = new Float32Array(length).fill(1);
  for (const time of kicks) {
    const from = Math.round(time * SR);
    const span = Math.round(0.22 * SR);
    for (let i = 0; i < span && from + i < length; i++) {
      const duck = 1 - depth * Math.exp(-(i / SR) * 16);
      if (duck < env[from + i]) env[from + i] = duck;
    }
  }
  for (let i = 0; i < length; i++) {
    target.l[i] *= env[i];
    target.r[i] *= env[i];
  }
}

// A turntable losing power: the top end closes and the level falls together.
export function tapeStop(target, from, length) {
  const start = Math.round(from * SR);
  const count = Math.round(length * SR);
  let l = 0;
  let r = 0;
  for (let i = 0; i < count && start + i < target.l.length; i++) {
    const p = i / count;
    const k = 0.9 * (1 - p) ** 3 + 0.0015;
    l += (target.l[start + i] - l) * k;
    r += (target.r[start + i] - r) * k;
    const level = (1 - p) ** 1.5;
    target.l[start + i] = l * level;
    target.r[start + i] = r * level;
  }
}

export function sum(...buses) {
  const length = buses[0].l.length;
  const out = bus(length);
  for (const b of buses) {
    for (let i = 0; i < length; i++) {
      out.l[i] += b.l[i];
      out.r[i] += b.r[i];
    }
  }
  return out;
}

export function silence(target, from, until, fade = 0.05) {
  const start = Math.round(from * SR);
  const end = Math.min(target.l.length, Math.round(until * SR));
  for (let i = start; i < end; i++) {
    const level = Math.max(0, 1 - (i - start) / (fade * SR));
    target.l[i] *= level;
    target.r[i] *= level;
  }
}

// ---------------------------------------------------------------------------
// Recorded effects
// ---------------------------------------------------------------------------

// Decodes one effect from assets/sfx/ to stereo floats at the working rate.
function sample(name) {
  const raw = ffmpeg(
    ["-i", join(ROOT, "assets", "sfx", `${name}.mp3`), "-f", "f32le", "-ac", "2", "-ar", String(SR), "-"],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

// Every cue is `{ kind, time, gain }`, where kind names a file in assets/sfx/.
export function renderSfx(cues, length, level) {
  const out = bus(length);
  const cache = new Map();
  for (const cue of cues) {
    if (!cache.has(cue.kind)) cache.set(cue.kind, sample(cue.kind));
    const data = cache.get(cue.kind);
    const start = Math.round(cue.time * SR);
    const gain = level * cue.gain;
    // A cue placed before zero, such as a riser timed back from its peak,
    // plays from partway in.
    for (let i = Math.max(0, -start); i < data.length / 2 && start + i < length; i++) {
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
export function master(mix, ceiling, drive) {
  const length = mix.l.length;
  let peak = 0;
  for (let i = 0; i < length; i++) {
    mix.l[i] = Math.tanh(mix.l[i] * drive);
    mix.r[i] = Math.tanh(mix.r[i] * drive);
    peak = Math.max(peak, Math.abs(mix.l[i]), Math.abs(mix.r[i]));
  }
  const scale = peak > 0 ? Math.min(1, ceiling / peak) : 1;
  for (let i = 0; i < length; i++) {
    mix.l[i] *= scale;
    mix.r[i] *= scale;
  }
}

export function writeWav(path, mix) {
  const length = mix.l.length;
  const data = Buffer.alloc(length * 4);
  for (let i = 0; i < length; i++) {
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
