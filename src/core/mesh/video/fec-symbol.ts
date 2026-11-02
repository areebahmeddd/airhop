// How a live video block's DATA regions become equal-length Reed-Solomon
// symbols, `[regionLength u16][region][zero pad]`, and back. Sender and
// receiver frame them identically or a rebuilt shard decodes as garbage.

export function fecSymbol(region: Uint8Array, length: number): Uint8Array {
  const symbol = new Uint8Array(Math.max(length, region.length + 2));
  symbol[0] = (region.length >> 8) & 0xff;
  symbol[1] = region.length & 0xff;
  symbol.set(region, 2);
  return symbol;
}

// Null for a symbol whose length prefix overruns it or whose padding is not
// zero, which is what a wrong reconstruction looks like.
export function fecRegion(symbol: Uint8Array): Uint8Array | null {
  if (symbol.length < 2) return null;
  const length = (symbol[0] << 8) | symbol[1];
  if (length === 0 || length > symbol.length - 2) return null;
  for (let i = 2 + length; i < symbol.length; i++) {
    if (symbol[i] !== 0) return null;
  }
  return symbol.slice(2, 2 + length);
}
