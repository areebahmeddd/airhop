// The Noise XX handshake that opens a transfer.
//
// The old phone initiates with its identity's static key and refuses any
// responder whose key is not the one it scanned. The new phone learns the
// identity arriving by possession of that key. The code's token is the
// prologue, so a party that never read the code fails at message 2. Any failure
// throws and the caller drops the connection.

import { concatBytes } from "@noble/hashes/utils.js";
import { NoiseHandshake, type NoiseSession } from "../crypto/noise-xx";

const PROLOGUE_LABEL = new TextEncoder().encode("airhop-move-v1");

function prologueFor(token: Uint8Array): Uint8Array {
  return concatBytes(PROLOGUE_LABEL, token);
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export interface HandshakeStep {
  reply: Uint8Array | null;
  session: NoiseSession | null;
}

export class MoveHandshake {
  private done = false;
  // Responder: a repeated message 1 must not restart the pattern.
  private sentMsg2 = false;

  private constructor(
    private readonly noise: NoiseHandshake,
    private readonly expectedRemote: Uint8Array | null,
  ) {}

  static initiate(params: {
    staticPrivKey: Uint8Array;
    token: Uint8Array;
    expectedRemote: Uint8Array;
  }): { handshake: MoveHandshake; msg1: Uint8Array } {
    const noise = NoiseHandshake.createInitiator(
      params.staticPrivKey,
      prologueFor(params.token),
    );
    const handshake = new MoveHandshake(noise, params.expectedRemote.slice());
    return { handshake, msg1: noise.writeMsg1() };
  }

  static respond(params: {
    staticPrivKey: Uint8Array;
    token: Uint8Array;
  }): MoveHandshake {
    const noise = NoiseHandshake.createResponder(
      params.staticPrivKey,
      prologueFor(params.token),
    );
    return new MoveHandshake(noise, null);
  }

  receive(frame: Uint8Array): HandshakeStep {
    if (this.done) throw new Error("move-handshake: already complete");
    if (this.noise.role === "initiator") {
      this.noise.readMsg2(frame);
      const msg3 = this.noise.writeMsg3();
      const session = this.noise.split();
      this.done = true;
      // Thrown before the caller sends message 3, which carries our static key.
      if (
        this.expectedRemote === null ||
        !sameKey(session.remoteStaticPubKey, this.expectedRemote)
      ) {
        throw new Error("move-handshake: not the phone that was scanned");
      }
      return { reply: msg3, session };
    }
    if (!this.sentMsg2) {
      if (frame.length !== 32) throw new Error("move-handshake: bad message 1");
      this.noise.readMsg1(frame);
      this.sentMsg2 = true;
      return { reply: this.noise.writeMsg2(), session: null };
    }
    this.noise.readMsg3(frame);
    this.done = true;
    return { reply: null, session: this.noise.split() };
  }
}
