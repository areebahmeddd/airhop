// The trailer's edit: thirty seconds, fifteen bars, no narration. Picture
// (trailer/timeline.js) and sound (scripts/score-trailer.mjs) both read the plan
// this file builds, so every cut lands on a beat the music plays.
//
// 120 BPM puts a beat on exactly 30 frames at 60 fps and a bar on two seconds,
// so fifteen bars are thirty seconds to the frame.

export const BPM = 120;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;

// In running order, `bars` long each. `music` names the arrangement in
// scripts/score-trailer.mjs.
const SHOTS = [
  { id: "open", bars: 2, music: "intro" },
  { id: "mesh", bars: 1, music: "drop" },
  { id: "mark", bars: 1, music: "groove" },
  { id: "radar", bars: 1, music: "groove" },
  { id: "thread", bars: 1, music: "groove" },
  { id: "relay", bars: 1, music: "groove" },
  { id: "key", bars: 1, music: "stabs" },
  { id: "globe", bars: 1, music: "groove" },
  { id: "more", bars: 1, music: "stabs" },
  { id: "pay", bars: 2, music: "groove" },
  { id: "proof", bars: 1, music: "groove" },
  { id: "free", bars: 1, music: "stop" },
  { id: "end", bars: 1, music: "end" },
];

export function buildPlan() {
  const shots = {};
  const music = [];
  let bar = 0;
  for (const shot of SHOTS) {
    shots[shot.id] = { start: bar * BAR, end: (bar + shot.bars) * BAR };
    for (let n = 0; n < shot.bars; n++) music.push(shot.music);
    bar += shot.bars;
  }
  const duration = bar * BAR;

  // A moment is a beat inside a shot: `at("pay", 1, 2)` is beat three of the
  // shot's second bar.
  const at = (id, bars, beats = 0) => shots[id].start + (bars * 4 + beats) * BEAT;

  const T = {};

  // The signal bars go one a beat, then there is nothing to connect to.
  T.drops = [at("open", 0, 1), at("open", 0, 2), at("open", 0, 3), at("open", 1, 0)];
  T.noSignal = at("open", 1, 0);
  T.noWifi = at("open", 1, 2);
  T.roll = at("open", 1, 3);

  // Two phones find each other, then every stranger's phone joins.
  T.drop = at("mesh", 0);
  T.answer = at("mesh", 0, 0.5);
  T.pullback = at("mesh", 0, 1);
  T.fold = at("mark", 0);
  T.lockup = at("mark", 0, 1);
  T.tagline = at("mark", 0, 2);

  T.radar = at("radar", 0);
  T.peers = [1, 1.5, 2, 2.5].map((beat) => at("radar", 0, beat));

  T.thread = at("thread", 0);
  T.bubbles = [1, 2, 3].map((beat) => at("thread", 0, beat));

  T.chain = at("relay", 0);
  T.hops = [1, 1.5, 2, 2.5].map((beat) => at("relay", 0, beat));
  T.unreadable = at("relay", 0, 3);

  T.key = [0, 1, 2].map((beat) => at("key", 0, beat));
  T.peerId = at("key", 0, 2.5);

  T.globe = at("globe", 0);
  T.nostr = at("globe", 0, 2);
  T.tor = at("globe", 0, 3);

  T.more = [0, 1, 2, 3].map((beat) => at("more", 0, beat));

  // Five hundred sats leave one phone and land on the other on the downbeat.
  T.pay = at("pay", 0);
  T.sent = at("pay", 0, 1);
  T.fly = at("pay", 0, 2);
  T.land = at("pay", 1, 0);
  T.claim = at("pay", 1, 1);
  T.claimed = at("pay", 1, 1.5);
  T.cashu = at("pay", 1, 2);

  T.proofs = [0, 1, 2].map((beat) => at("proof", 0, beat));
  T.primitives = at("proof", 0, 3);

  // Three words on three hits, then a beat of nothing before the mark.
  T.free = [0, 1, 2].map((beat) => at("free", 0, beat));
  T.hush = at("free", 0, 3);

  T.end = at("end", 0);
  T.url = at("end", 0, 1);

  const cues = [];
  const cue = (kind, time, gain) => cues.push({ kind, time, gain });
  // The riser is ten seconds long and peaks at its end, so it starts before
  // the trailer does and is heard from partway in.
  cue("riser", T.drop - 10.03, 0.5);
  cue("impact-bass-2", T.fold - 0.05, 0.8);
  T.peers.forEach((t) => cue("pop", t, 0.5));
  T.bubbles.forEach((t) => cue("pop", t, 0.55));
  cue("whoosh-short", T.fly, 0.6);
  cue("pop", T.land, 0.8);
  cue("click", T.claim, 0.9);
  cue("impact-bass-2", T.end - 0.05, 1);

  return { BPM, BEAT, BAR, duration, shots, music, T, cues };
}
