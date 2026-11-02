// The erasure code behind a live video block's PARITY packets: systematic
// Reed-Solomon over GF(2^8) with field polynomial 0x11D and a Cauchy
// generator, so any k of a block's k + r symbols rebuild it. bitchat's
// ReedSolomonErasure, coefficient for coefficient, since a parity symbol made
// on one client is solved on another.

const FIELD = 256;

const EXP = new Uint8Array(FIELD * 2);
const LOG = new Uint8Array(FIELD);
{
  let value = 1;
  for (let power = 0; power < FIELD - 1; power++) {
    EXP[power] = value;
    LOG[value] = power;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let power = FIELD - 1; power < EXP.length; power++) {
    EXP[power] = EXP[power - (FIELD - 1)];
  }
}

export function gfMultiply(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

export function gfInverse(a: number): number {
  if (a === 0) throw new RangeError("zero has no inverse");
  return EXP[FIELD - 1 - LOG[a]];
}

// Row j of the Cauchy matrix at source i: 1 / (i XOR (k + j)).
export function coefficient(
  sourceCount: number,
  parityRow: number,
  sourceIndex: number,
): number {
  return gfInverse(sourceIndex ^ (sourceCount + parityRow));
}

function addScaled(
  target: Uint8Array,
  source: Uint8Array,
  factor: number,
): void {
  if (factor === 0) return;
  const logFactor = LOG[factor];
  for (let i = 0; i < target.length; i++) {
    const byte = source[i];
    if (byte !== 0) target[i] ^= EXP[LOG[byte] + logFactor];
  }
}

function scaleInPlace(target: Uint8Array, factor: number): void {
  const logFactor = LOG[factor];
  for (let i = 0; i < target.length; i++) {
    const byte = target[i];
    target[i] = byte === 0 ? 0 : EXP[LOG[byte] + logFactor];
  }
}

// `parityCount` symbols, each as long as the equal-length `sources`.
export function encodeParity(
  sources: readonly Uint8Array[],
  parityCount: number,
): Uint8Array[] {
  const k = sources.length;
  const length = sources[0]?.length ?? 0;
  if (
    k < 1 ||
    parityCount < 1 ||
    k + parityCount > FIELD ||
    sources.some((s) => s.length !== length)
  ) {
    throw new RangeError("invalid Reed-Solomon block");
  }
  return Array.from({ length: parityCount }, (_, row) => {
    const parity = new Uint8Array(length);
    sources.forEach((source, i) =>
      addScaled(parity, source, coefficient(k, row, i)),
    );
    return parity;
  });
}

// The block's k source symbols with the missing (null) ones rebuilt from
// `parities` (parity row to symbol), or null when there are too few symbols or
// their lengths disagree.
export function reconstruct(
  sources: readonly (Uint8Array | null)[],
  parities: ReadonlyMap<number, Uint8Array>,
): Uint8Array[] | null {
  const k = sources.length;
  const missing = sources.flatMap((s, i) => (s === null ? [i] : []));
  if (missing.length === 0) return sources as Uint8Array[];
  const length =
    sources.find((s) => s !== null)?.length ??
    parities.values().next().value?.length;
  if (parities.size < missing.length || length === undefined) return null;
  if (
    sources.some((s) => s !== null && s.length !== length) ||
    [...parities.values()].some((p) => p.length !== length)
  ) {
    return null;
  }

  const rows = [...parities.keys()]
    .sort((a, b) => a - b)
    .slice(0, missing.length);
  // Each parity minus what the symbols already held contribute to it.
  const values = rows.map((row) => {
    const value = Uint8Array.from(parities.get(row) as Uint8Array);
    sources.forEach((source, i) => {
      if (source !== null) addScaled(value, source, coefficient(k, row, i));
    });
    return value;
  });
  const matrix = rows.map((row) => missing.map((i) => coefficient(k, row, i)));

  // Gauss-Jordan elimination over GF(256).
  const n = matrix.length;
  for (let column = 0; column < n; column++) {
    let pivot = column;
    while (pivot < n && matrix[pivot][column] === 0) pivot++;
    if (pivot === n) return null;
    if (pivot !== column) {
      [matrix[pivot], matrix[column]] = [matrix[column], matrix[pivot]];
      [values[pivot], values[column]] = [values[column], values[pivot]];
    }
    const scale = gfInverse(matrix[column][column]);
    matrix[column] = matrix[column].map((c) => gfMultiply(c, scale));
    scaleInPlace(values[column], scale);
    for (let row = 0; row < n; row++) {
      const factor = matrix[row][column];
      if (row === column || factor === 0) continue;
      matrix[row] = matrix[row].map(
        (c, j) => c ^ gfMultiply(factor, matrix[column][j]),
      );
      addScaled(values[row], values[column], factor);
    }
  }

  const output = [...sources];
  missing.forEach((sourceIndex, i) => {
    output[sourceIndex] = values[i];
  });
  return output as Uint8Array[];
}
