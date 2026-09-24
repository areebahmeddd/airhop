// The QR code a new phone shows so the old phone can find and authenticate it.
//
// Nothing secret: a one-time X25519 key the old phone pins the handshake to, a
// token that becomes the Noise prologue, and the port and IPv4 addresses the
// new phone listens on. Addresses rather than mDNS, so a transfer is never
// advertised and a hotspot host that answers no multicast still works.
//
// Layout:
//
//   [0]      u8     version (1)
//   [1-2]    u16 BE port
//   [3-34]   bytes  X25519 public key (32)
//   [35-50]  bytes  token (16)
//   [51]     u8     address count (1-4)
//   [52..]   bytes  IPv4 addresses, 4 bytes each
//
// Its own scheme rather than `airhop:`, so the system camera opens nothing.

import { base64UrlToBytes, bytesToBase64Url } from "../encoding/base64";

export interface MoveInvite {
  publicKey: Uint8Array;
  token: Uint8Array;
  port: number;
  hosts: string[];
}

const SCHEME = "airhop-move:v1/";
const VERSION = 1;
const KEY_BYTES = 32;
export const MOVE_TOKEN_BYTES = 16;
// Wi-Fi, a hotspot and a tethered cable, with room to spare.
export const MAX_MOVE_HOSTS = 4;
const HEADER_BYTES = 1 + 2 + KEY_BYTES + MOVE_TOKEN_BYTES + 1;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Bytes(host: string): number[] | null {
  const match = IPV4.exec(host);
  if (match === null) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

export function isMoveInvite(text: string): boolean {
  return text.startsWith(SCHEME);
}

export function encodeMoveInvite(invite: MoveInvite): string {
  if (invite.publicKey.length !== KEY_BYTES) {
    throw new Error("move-invite: public key must be 32 bytes");
  }
  if (invite.token.length !== MOVE_TOKEN_BYTES) {
    throw new Error("move-invite: token must be 16 bytes");
  }
  if (
    !Number.isInteger(invite.port) ||
    invite.port < 1 ||
    invite.port > 0xffff
  ) {
    throw new Error("move-invite: port out of range");
  }
  const hosts = invite.hosts
    .map(ipv4Bytes)
    .filter((h): h is number[] => h !== null)
    .slice(0, MAX_MOVE_HOSTS);
  if (hosts.length === 0) {
    throw new Error("move-invite: no IPv4 address to reach");
  }
  const out = new Uint8Array(HEADER_BYTES + hosts.length * 4);
  out[0] = VERSION;
  out[1] = invite.port >> 8;
  out[2] = invite.port & 0xff;
  out.set(invite.publicKey, 3);
  out.set(invite.token, 3 + KEY_BYTES);
  out[HEADER_BYTES - 1] = hosts.length;
  hosts.forEach((octets, i) => out.set(octets, HEADER_BYTES + i * 4));
  return SCHEME + bytesToBase64Url(out);
}

// Null for anything else, so a scanner keeps looking.
export function decodeMoveInvite(text: string): MoveInvite | null {
  if (!isMoveInvite(text)) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(text.slice(SCHEME.length));
  } catch {
    return null;
  }
  if (bytes.length < HEADER_BYTES || bytes[0] !== VERSION) return null;
  const count = bytes[HEADER_BYTES - 1];
  if (count < 1 || count > MAX_MOVE_HOSTS) return null;
  if (bytes.length !== HEADER_BYTES + count * 4) return null;
  const port = (bytes[1] << 8) | bytes[2];
  if (port === 0) return null;
  const hosts: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = HEADER_BYTES + i * 4;
    hosts.push(Array.from(bytes.slice(at, at + 4)).join("."));
  }
  return {
    port,
    publicKey: bytes.slice(3, 3 + KEY_BYTES),
    token: bytes.slice(3 + KEY_BYTES, 3 + KEY_BYTES + MOVE_TOKEN_BYTES),
    hosts,
  };
}
