// The messages of a transfer, inside its Noise session: `[type: u8][body]`.
//
// Old phone: OFFER naming every section, the sections as one chunked stream,
// END. New phone: COMMIT once everything is stored and read back. Old phone:
// RELEASED once erased. Either side may ABORT before the commit. Airhop-only,
// never on the mesh (PROTOCOLS.md section 11).

export const MoveMessageType = {
  OFFER: 0x01,
  CHUNK: 0x02,
  END: 0x03,
  COMMIT: 0x04,
  RELEASED: 0x05,
  ABORT: 0x06,
} as const;

export const MoveAbortReason = {
  CANCELLED: 0x01,
  // The sender runs a newer Airhop than the receiver.
  INCOMPATIBLE: 0x02,
  STORAGE: 0x03,
  // A hash, a size or the identity did not check out.
  INVALID: 0x04,
} as const;

export type MoveAbortReasonValue =
  (typeof MoveAbortReason)[keyof typeof MoveAbortReason];

export interface MoveSectionInfo {
  name: string;
  size: number;
  sha256: string;
}

export interface MoveOffer {
  format: number;
  // Lets an older receiver refuse data it may not be able to read.
  appVersion: string;
  history: boolean;
  sections: MoveSectionInfo[];
}

export type MoveMessage =
  | { type: "offer"; offer: MoveOffer; raw: Uint8Array }
  | { type: "chunk"; data: Uint8Array }
  | { type: "end" }
  | { type: "commit"; digest: Uint8Array }
  | { type: "released"; keysDestroyed: boolean }
  | { type: "abort"; reason: MoveAbortReasonValue };

export const MOVE_FORMAT = 1;
// Well under the 64 KiB TCP frame once the type byte and Noise overhead are on.
export const MOVE_CHUNK_BYTES = 32 * 1024;
// Far above any real store, and a bound on what a hostile offer can make the
// receiver hold.
export const MAX_MOVE_BYTES = 256 * 1024 * 1024;
const MAX_SECTIONS = 32;
const SECTION_NAME = /^[A-Za-z0-9:-]{1,64}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function withType(type: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + body.length);
  out[0] = type;
  out.set(body, 1);
  return out;
}

// The exact bytes both sides hash for the commit digest, so neither re-serialises.
export function encodeOfferBody(offer: MoveOffer): Uint8Array {
  return utf8.encode(JSON.stringify(offer));
}

export function encodeOffer(body: Uint8Array): Uint8Array {
  return withType(MoveMessageType.OFFER, body);
}

export function encodeChunk(data: Uint8Array): Uint8Array {
  return withType(MoveMessageType.CHUNK, data);
}

export function encodeEnd(): Uint8Array {
  return Uint8Array.of(MoveMessageType.END);
}

export function encodeCommit(digest: Uint8Array): Uint8Array {
  return withType(MoveMessageType.COMMIT, digest);
}

export function encodeReleased(keysDestroyed: boolean): Uint8Array {
  return Uint8Array.of(MoveMessageType.RELEASED, keysDestroyed ? 1 : 0);
}

export function encodeAbort(reason: MoveAbortReasonValue): Uint8Array {
  return Uint8Array.of(MoveMessageType.ABORT, reason);
}

function parseOffer(body: Uint8Array): MoveOffer | null {
  let value: unknown;
  try {
    value = JSON.parse(fromUtf8.decode(body));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  if (o.format !== MOVE_FORMAT) return null;
  if (typeof o.appVersion !== "string" || !VERSION.test(o.appVersion)) {
    return null;
  }
  if (typeof o.history !== "boolean") return null;
  if (!Array.isArray(o.sections) || o.sections.length > MAX_SECTIONS) {
    return null;
  }
  const names = new Set<string>();
  let total = 0;
  const sections: MoveSectionInfo[] = [];
  for (const raw of o.sections as unknown[]) {
    if (typeof raw !== "object" || raw === null) return null;
    const s = raw as Record<string, unknown>;
    if (typeof s.name !== "string" || !SECTION_NAME.test(s.name)) return null;
    if (names.has(s.name)) return null;
    if (
      typeof s.size !== "number" ||
      !Number.isSafeInteger(s.size) ||
      s.size < 0
    ) {
      return null;
    }
    if (typeof s.sha256 !== "string" || !HEX_SHA256.test(s.sha256)) {
      return null;
    }
    names.add(s.name);
    total += s.size;
    sections.push({ name: s.name, size: s.size, sha256: s.sha256 });
  }
  if (total > MAX_MOVE_BYTES) return null;
  return {
    format: MOVE_FORMAT,
    appVersion: o.appVersion,
    history: o.history,
    sections,
  };
}

function isAbortReason(value: number): value is MoveAbortReasonValue {
  return (Object.values(MoveAbortReason) as number[]).includes(value);
}

// Null for anything malformed, which the caller treats as the end of the session.
export function decodeMoveMessage(frame: Uint8Array): MoveMessage | null {
  if (frame.length === 0) return null;
  const body = frame.subarray(1);
  switch (frame[0]) {
    case MoveMessageType.OFFER: {
      const offer = parseOffer(body);
      return offer === null
        ? null
        : { type: "offer", offer, raw: body.slice() };
    }
    case MoveMessageType.CHUNK:
      return body.length === 0 ? null : { type: "chunk", data: body.slice() };
    case MoveMessageType.END:
      return body.length === 0 ? { type: "end" } : null;
    case MoveMessageType.COMMIT:
      return body.length === 32
        ? { type: "commit", digest: body.slice() }
        : null;
    case MoveMessageType.RELEASED:
      return body.length === 1 && body[0] <= 1
        ? { type: "released", keysDestroyed: body[0] === 1 }
        : null;
    case MoveMessageType.ABORT:
      return body.length === 1 && isAbortReason(body[0])
        ? { type: "abort", reason: body[0] }
        : null;
    default:
      return null;
  }
}

// Equal or older only: a newer build may persist a store shape this one cannot
// migrate, and zustand drops what it cannot migrate.
export function canReadVersion(local: string, remote: string): boolean {
  const a = local.split(".").map(Number);
  const b = remote.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}
