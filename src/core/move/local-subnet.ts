// Whether a transfer code's address sits on a network this phone is on.
//
// The promise is "same Wi-Fi or a hotspot, nothing over the internet". A range
// list cannot keep it: campus Wi-Fi hands out public addresses, hotspot ranges
// vary by vendor, and a VPN routes private space off the phone. The subnets of
// the phone's own local interfaces answer it exactly, so a code pointing
// anywhere else is refused before a byte leaves.

export interface LocalSubnet {
  address: string;
  prefixLength: number;
}

// Wider than any LAN; a prefix this short is a route, not a network.
const MIN_PREFIX = 8;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToInt(host: string): number | null {
  const match = IPV4.exec(host);
  if (match === null) return null;
  let value = 0;
  for (const part of match.slice(1)) {
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

export function isOnLocalSubnet(
  host: string,
  subnets: readonly LocalSubnet[],
): boolean {
  const target = ipv4ToInt(host);
  if (target === null) return false;
  return subnets.some(({ address, prefixLength }) => {
    if (
      !Number.isInteger(prefixLength) ||
      prefixLength < MIN_PREFIX ||
      prefixLength > 32
    ) {
      return false;
    }
    const own = ipv4ToInt(address);
    if (own === null) return false;
    // Division, not a shift: JS shifts are 32-bit signed and wrap at /0 and /32.
    const block = 2 ** (32 - prefixLength);
    return Math.floor(own / block) === Math.floor(target / block);
  });
}
