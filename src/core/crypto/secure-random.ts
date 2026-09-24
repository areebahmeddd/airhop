// A uniform number in [0, 1) from the platform CSPRNG.
//
// For randomness that protects privacy: a timestamp blur, a TTL that hides
// the origin, a heartbeat cadence that would otherwise fingerprint a device.
// Math.random is recoverable from its own outputs. Each call reaches the
// platform generator, so it is not for per-packet hot paths.
export function secureRandom(): number {
  const [value] = crypto.getRandomValues(new Uint32Array(1));
  // Exact over a 2^32 grid, so a caller rounding to n buckets sees a bias of
  // at most n / 2^32: far below anything these values protect. Not for keys.
  return value / 0x1_0000_0000;
}
