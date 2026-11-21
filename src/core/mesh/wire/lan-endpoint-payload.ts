// The LAN_ENDPOINT payload: NoisePayloadType 0x56.
//
//   [port: u16 BE][count: u8][IPv4 address: 4 bytes] x count
//
// Where this phone's LAN transport listens, handed to a peer inside a session
// so the two can meet over Wi-Fi on a network that filters mDNS. Airhop-only,
// sent only to a peer whose 0x21 proved Capability.doubleRatchet. The session
// vouches for who sent it, not for the address: the receiver dials only a
// private address on one of its own subnets, and keeps the link only if the
// announce on it names the sender (lan-direct-dial.ts).
//
// One to four addresses, one per local interface (Wi-Fi joined or served,
// ethernet), and a port from 1024 up: both platforms' listeners take an
// ephemeral one, so a lower port names a system service (a printer's, SSH)
// no Airhop phone listens on. Anything else, or a trailing byte, is refused
// whole.

import { ipv4Octets } from "../../move/local-subnet";

export interface LanEndpoint {
  port: number;
  hosts: string[];
}

export const MAX_LAN_ENDPOINT_HOSTS = 4;
const MIN_PORT = 1024;

export function encodeLanEndpoint(endpoint: LanEndpoint): Uint8Array | null {
  const { port, hosts } = endpoint;
  if (!Number.isInteger(port) || port < MIN_PORT || port > 0xffff) {
    return null;
  }
  const parsed = hosts.map(ipv4Octets);
  if (
    parsed.length === 0 ||
    parsed.length > MAX_LAN_ENDPOINT_HOSTS ||
    parsed.some((p) => p === null)
  ) {
    return null;
  }
  const out = new Uint8Array(3 + parsed.length * 4);
  out[0] = port >> 8;
  out[1] = port & 0xff;
  out[2] = parsed.length;
  parsed.forEach((p, i) => out.set(p as number[], 3 + i * 4));
  return out;
}

export function decodeLanEndpoint(body: Uint8Array): LanEndpoint | null {
  if (body.length < 3) return null;
  const port = (body[0] << 8) | body[1];
  const count = body[2];
  if (
    port < MIN_PORT ||
    count === 0 ||
    count > MAX_LAN_ENDPOINT_HOSTS ||
    body.length !== 3 + count * 4
  ) {
    return null;
  }
  const hosts: string[] = [];
  for (let i = 0; i < count; i++) {
    hosts.push(Array.from(body.subarray(3 + i * 4, 7 + i * 4)).join("."));
  }
  return { port, hosts };
}
