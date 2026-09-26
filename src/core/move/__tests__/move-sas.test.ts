/**
 * @jest-environment node
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { MoveHandshake } from "../move-handshake";
import { moveSas } from "../move-sas";

const TOKEN = new Uint8Array(16).fill(3);

function keypair() {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  return { priv, pub: x25519.getPublicKey(priv) };
}

// One full handshake between an old phone and a new phone's code.
function session(identity = keypair(), receiver = keypair()) {
  const { handshake: sender, msg1 } = MoveHandshake.initiate({
    staticPrivKey: identity.priv,
    token: TOKEN,
    expectedRemote: receiver.pub,
  });
  const responder = MoveHandshake.respond({
    staticPrivKey: receiver.priv,
    token: TOKEN,
  });
  const step1 = responder.receive(msg1);
  const step2 = sender.receive(step1.reply as Uint8Array);
  const step3 = responder.receive(step2.reply as Uint8Array);
  if (step2.session === null || step3.session === null) {
    throw new Error("handshake did not complete");
  }
  return { old: step2.session, new: step3.session };
}

describe("move SAS", () => {
  it("is the same on both ends of one session", () => {
    const s = session();
    expect(bytesToHex(moveSas(s.old.handshakeHash))).toBe(
      bytesToHex(moveSas(s.new.handshakeHash)),
    );
  });

  it("differs across two sessions to the same code", () => {
    const receiver = keypair();
    const identity = keypair();
    // The same old phone twice, and a second phone racing it.
    const a = session(identity, receiver);
    const b = session(identity, receiver);
    const c = session(keypair(), receiver);
    const sas = [a, b, c].map((s) => bytesToHex(moveSas(s.new.handshakeHash)));
    expect(new Set(sas).size).toBe(3);
  });

  it("is domain-separated from the handshake hash it binds", () => {
    const s = session();
    expect(bytesToHex(moveSas(s.new.handshakeHash))).not.toBe(
      bytesToHex(s.new.handshakeHash),
    );
    // Pinned, from Python's hashlib: sha256(b"airhop-move-sas-v1" + bytes(32)).
    // Both phones must derive it identically, whatever build each runs.
    expect(bytesToHex(moveSas(new Uint8Array(32)))).toBe(
      "7629fa7ce342a80ba34fc32b9dad1cc88da73fefb075f9a2a2777f250743227f",
    );
  });
});
