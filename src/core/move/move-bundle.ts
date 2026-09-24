// A transfer's payload: named sections, sent as one stream in order.
//
// Noise already authenticates every chunk. The per-section SHA-256 catches our
// own bugs, a dropped chunk or a misnamed section, before they reach a store.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import {
  MAX_MOVE_BYTES,
  MOVE_CHUNK_BYTES,
  MOVE_FORMAT,
  type MoveOffer,
} from "./move-wire";

export interface MoveSection {
  name: string;
  data: Uint8Array;
}

export function buildOffer(
  sections: MoveSection[],
  meta: { appVersion: string; history: boolean },
): { offer: MoveOffer; stream: Uint8Array } {
  const offer: MoveOffer = {
    format: MOVE_FORMAT,
    appVersion: meta.appVersion,
    history: meta.history,
    sections: sections.map((s) => ({
      name: s.name,
      size: s.data.length,
      sha256: bytesToHex(sha256(s.data)),
    })),
  };
  const stream = concatBytes(...sections.map((s) => s.data));
  if (stream.length > MAX_MOVE_BYTES) {
    throw new Error("move-bundle: larger than a move can carry");
  }
  return { offer, stream };
}

export function* chunksOf(
  stream: Uint8Array,
  size: number = MOVE_CHUNK_BYTES,
): Generator<Uint8Array> {
  for (let at = 0; at < stream.length; at += size) {
    yield stream.subarray(at, Math.min(at + size, stream.length));
  }
}

// Held in memory, never written through: nothing reaches storage until the
// whole bundle is here and checks out.
export class BundleAssembler {
  private readonly parts: Uint8Array[] = [];
  private received = 0;
  readonly total: number;

  constructor(private readonly offer: MoveOffer) {
    this.total = offer.sections.reduce((sum, s) => sum + s.size, 0);
  }

  get receivedBytes(): number {
    return this.received;
  }

  // Throws on more bytes than the offer named.
  push(chunk: Uint8Array): void {
    if (this.received + chunk.length > this.total) {
      throw new Error("move-bundle: more data than offered");
    }
    this.parts.push(chunk);
    this.received += chunk.length;
  }

  // Throws on a short stream or a hash that does not match.
  complete(): Map<string, Uint8Array> {
    if (this.received !== this.total) {
      throw new Error("move-bundle: stream ended early");
    }
    const stream = concatBytes(...this.parts);
    this.parts.length = 0;
    const out = new Map<string, Uint8Array>();
    let at = 0;
    for (const info of this.offer.sections) {
      const data = stream.slice(at, at + info.size);
      at += info.size;
      if (bytesToHex(sha256(data)) !== info.sha256) {
        throw new Error(`move-bundle: ${info.name} does not match its hash`);
      }
      out.set(info.name, data);
    }
    return out;
  }
}
