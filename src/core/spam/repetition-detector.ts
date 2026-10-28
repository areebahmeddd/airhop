// Character autocorrelation for repeated-content spam, ported from bitchat's
// RepetitionDetector so every client draws the same line.
//
// Text is compared as code points after `normalizeForComparison`, so case,
// spacing, look-alike letters, accents and invisible characters do not hide a
// repeat. Hashes and arrays here are internal; only the verdicts must agree.

const MARK = /\p{M}/u;
const FORMAT = /\p{Cf}/u;
const CONTROL = /\p{Cc}/u;
const WHITESPACE = /\p{White_Space}/u;
const SPACE = 0x20;

// A message folded to what a reader sees, for comparison only: NFKD turns
// fullwidth and math-styled letters into plain ones and splits off accents,
// marks and invisible characters are dropped, whitespace runs become one
// space, and letters are lowercased where that maps one code point to one.
export function normalizeForComparison(
  text: string,
  maxLength: number,
): number[] {
  // Disguises add a few code points per visible character; bound the work.
  const scalars = Array.from(text);
  const head =
    scalars.length > maxLength * 4
      ? scalars.slice(0, maxLength * 4).join("")
      : text;
  const out: number[] = [];
  let pendingSpace = false;
  for (const ch of head.normalize("NFKD")) {
    if (out.length >= maxLength) break;
    if (MARK.test(ch) || FORMAT.test(ch)) continue;
    if (WHITESPACE.test(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (CONTROL.test(ch)) continue;
    if (pendingSpace && out.length < maxLength - 1) out.push(SPACE);
    pendingSpace = false;
    const lower = ch.toLowerCase();
    out.push(
      (Array.from(lower).length === 1 ? lower : ch).codePointAt(0) as number,
    );
  }
  return out;
}

// Whether some shift of `text` matches itself at `threshold` of the overlapping
// positions, giving up on a shift once its mismatches rule it out. "aaaa" and
// "buy now buy now" reach 1.0; prose stays far below.
export function selfSimilarityReaches(
  text: readonly number[],
  threshold: number,
): boolean {
  const n = text.length;
  if (n < 2) return threshold <= 0;
  for (let lag = 1; lag <= n >> 1; lag++) {
    const overlap = n - lag;
    let mismatches = 0;
    let possible = true;
    for (let i = 0; i < overlap; i++) {
      if (text[i] !== text[i + lag]) {
        mismatches++;
        if ((overlap - mismatches) / overlap < threshold) {
          possible = false;
          break;
        }
      }
    }
    if (possible) return true;
  }
  return false;
}

// Cross-correlation that tolerates small edits. The first peak is the shift
// where the most characters match; an insertion or deletion moves the rest of
// the text to a neighbouring shift, so up to `maxPeaks - 1` further peaks add
// matches, counting only runs of at least `minRun` and never reusing a
// character. The score is matches over the longer length.
export function crossSimilarity(
  a: readonly number[],
  b: readonly number[],
  maxPeaks: number,
  minRun: number,
): number {
  if (a.length === 0 || b.length === 0) return 0;
  const usedA = new Array<boolean>(a.length).fill(false);
  const usedB = new Array<boolean>(b.length).fill(false);
  let peaks = 0;
  let total = 0;
  while (peaks < maxPeaks) {
    const run = peaks === 0 ? 1 : minRun;
    let bestGain = 0;
    let bestShift = 0;
    for (let shift = -(b.length - 1); shift < a.length; shift++) {
      const from = Math.max(0, -shift);
      const to = Math.min(b.length, a.length - shift);
      if (to - from <= bestGain) continue;
      const gain = runMatches(a, b, shift, from, to, usedA, usedB, run, false);
      if (gain > bestGain) {
        bestGain = gain;
        bestShift = shift;
      }
    }
    if (bestGain < run) break;
    const from = Math.max(0, -bestShift);
    const to = Math.min(b.length, a.length - bestShift);
    runMatches(a, b, bestShift, from, to, usedA, usedB, run, true);
    peaks++;
    total += bestGain;
  }
  return total / Math.max(a.length, b.length);
}

function runMatches(
  a: readonly number[],
  b: readonly number[],
  shift: number,
  from: number,
  to: number,
  usedA: boolean[],
  usedB: boolean[],
  minRun: number,
  mark: boolean,
): number {
  let gain = 0;
  let runStart = -1;
  for (let j = from; j <= to; j++) {
    const hit =
      j < to && !usedB[j] && !usedA[j + shift] && a[j + shift] === b[j];
    if (hit) {
      if (runStart < 0) runStart = j;
    } else if (runStart >= 0) {
      const length = j - runStart;
      if (length >= minRun) {
        gain += length;
        if (mark) {
          for (let k = runStart; k < j; k++) {
            usedB[k] = true;
            usedA[k + shift] = true;
          }
        }
      }
      runStart = -1;
    }
  }
  return gain;
}

// Where each code point occurs, for `alignmentUpperBound`.
export function positionsOf(text: readonly number[]): Map<number, number[]> {
  const positions = new Map<number, number[]>();
  text.forEach((point, index) => {
    const list = positions.get(point);
    if (list === undefined) positions.set(point, [index]);
    else list.push(index);
  });
  return positions;
}

// An upper bound on the matches `crossSimilarity` can find, at a fraction of
// its cost: each peak sits on its own diagonal and gains at most that
// diagonal's matches, so the `maxPeaks` fullest diagonals bound the total.
export function alignmentUpperBound(
  a: readonly number[],
  b: readonly number[],
  positionsInB: ReadonlyMap<number, readonly number[]>,
  maxPeaks: number,
): number {
  if (a.length === 0 || b.length === 0) return 0;
  const offset = b.length - 1;
  const diagonals = new Int32Array(a.length + b.length - 1);
  a.forEach((point, i) => {
    for (const j of positionsInB.get(point) ?? []) diagonals[i - j + offset]++;
  });
  const top = new Array<number>(Math.max(1, maxPeaks)).fill(0);
  for (const count of diagonals) {
    if (count <= top[top.length - 1]) continue;
    let k = top.length - 1;
    while (k > 0 && top[k - 1] < count) {
      top[k] = top[k - 1];
      k--;
    }
    top[k] = count;
  }
  return Math.min(
    top.reduce((sum, n) => sum + n, 0),
    Math.min(a.length, b.length),
  );
}

// Distinct trigrams as sorted hashes, the cheap pre-check before an alignment.
// bitchat's polynomial hash; with code points below 2^21 it stays an exact
// integer in a double, where Swift's wraps.
export function trigramsOf(text: readonly number[]): number[] {
  if (text.length < 3) return [];
  const hashes: number[] = [];
  for (let i = 0; i + 2 < text.length; i++) {
    hashes.push((text[i] * 31 + text[i + 1]) * 31 + text[i + 2]);
  }
  hashes.sort((x, y) => x - y);
  return hashes.filter((h, i) => i === 0 || hashes[i - 1] !== h);
}

// Shared trigrams over the larger set. Texts too short to have any pass.
export function trigramOverlap(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length === 0 || b.length === 0) return 1;
  let i = 0;
  let j = 0;
  let shared = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      shared++;
      i++;
      j++;
    } else if (a[i] < b[j]) {
      i++;
    } else {
      j++;
    }
  }
  return shared / Math.max(a.length, b.length);
}
