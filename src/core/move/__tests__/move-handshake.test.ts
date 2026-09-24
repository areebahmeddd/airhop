/**
 * @jest-environment node
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { MoveHandshake } from "../move-handshake";

function keypair() {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  return { priv, pub: x25519.getPublicKey(priv) };
}

const TOKEN = new Uint8Array(16).fill(3);

// Runs the three messages and returns both sessions, or throws where a side
// refuses.
function run(params: {
  identity: { priv: Uint8Array };
  receiver: { priv: Uint8Array };
  scannedKey: Uint8Array;
  senderToken?: Uint8Array;
}) {
  const { handshake: sender, msg1 } = MoveHandshake.initiate({
    staticPrivKey: params.identity.priv,
    token: params.senderToken ?? TOKEN,
    expectedRemote: params.scannedKey,
  });
  const receiver = MoveHandshake.respond({
    staticPrivKey: params.receiver.priv,
    token: TOKEN,
  });
  const step1 = receiver.receive(msg1);
  const step2 = sender.receive(step1.reply as Uint8Array);
  const step3 = receiver.receive(step2.reply as Uint8Array);
  return { sender: step2.session, receiver: step3.session };
}

describe("move handshake", () => {
  it("opens a session each side can read, bound to both keys", () => {
    const identity = keypair();
    const receiver = keypair();
    const { sender, receiver: rx } = run({
      identity,
      receiver,
      scannedKey: receiver.pub,
    });
    expect(rx?.remoteStaticPubKey).toEqual(identity.pub);
    expect(sender?.remoteStaticPubKey).toEqual(receiver.pub);
    const sealed = sender?.encrypt(Uint8Array.of(1, 2, 3)) as Uint8Array;
    expect(rx?.decrypt(sealed)).toEqual(Uint8Array.of(1, 2, 3));
  });

  it("refuses a phone other than the one that was scanned", () => {
    const impostor = keypair();
    expect(() =>
      run({
        identity: keypair(),
        receiver: impostor,
        scannedKey: keypair().pub,
      }),
    ).toThrow(/not the phone/);
  });

  it("fails for anyone who did not read the code's token", () => {
    const receiver = keypair();
    expect(() =>
      run({
        identity: keypair(),
        receiver,
        scannedKey: receiver.pub,
        senderToken: new Uint8Array(16).fill(4),
      }),
    ).toThrow();
  });

  it("will not restart the pattern on a second message 1", () => {
    const receiver = MoveHandshake.respond({
      staticPrivKey: keypair().priv,
      token: TOKEN,
    });
    const { msg1 } = MoveHandshake.initiate({
      staticPrivKey: keypair().priv,
      token: TOKEN,
      expectedRemote: keypair().pub,
    });
    receiver.receive(msg1);
    expect(() => receiver.receive(msg1)).toThrow();
  });
});
