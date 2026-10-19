// End-to-end round-trip for a Nostr DM the way the app sends it: a bitchat1
// envelope, gift-wrapped with bitchat's nip44-v2 crypto, unwrapped and decoded
// on the other side. Plus one gift wrap bitchat-ios itself produced.
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent, type Event } from "nostr-tools";
import vectors from "../../../../docs/spec/nostr-dm-vectors-bitchat.json";
import { NoisePayloadType } from "../../mesh/wire/noise-payload";
import {
  decodeBitchatEnvelope,
  encodeBitchatAckEnvelope,
  encodeBitchatDmEnvelope,
} from "../bitchat-envelope";
import { bitchatNip44Encrypt } from "../bitchat-nip44";
import { unwrapDm, wrapDm } from "../gift-wrap";

const SENDER_PEER = "aabbccdd00112233";

describe("Nostr DM interop round-trip", () => {
  it("delivers a private message through the full gift-wrap path", () => {
    const senderPriv = secp256k1.utils.randomSecretKey();
    const recipPriv = secp256k1.utils.randomSecretKey();
    const recipPubHex = bytesToHex(schnorr.getPublicKey(recipPriv));

    const envelope = encodeBitchatDmEnvelope(
      SENDER_PEER,
      null,
      "msg-42",
      "hello over nostr",
    )!;
    const { event } = wrapDm(envelope, senderPriv, recipPubHex);

    // Recipient side.
    const dm = unwrapDm(event, recipPriv, Number.POSITIVE_INFINITY);
    const decoded = decodeBitchatEnvelope(dm.content)!;
    expect(decoded.type).toBe(NoisePayloadType.PRIVATE_MESSAGE);
    expect(decoded.messageID).toBe("msg-42");
    expect(decoded.content).toBe("hello over nostr");
    // The seal authenticates the sender's real pubkey.
    expect(dm.senderPubkey).toBe(bytesToHex(schnorr.getPublicKey(senderPriv)));
  });

  it("delivers a read receipt through the full path", () => {
    const senderPriv = secp256k1.utils.randomSecretKey();
    const recipPriv = secp256k1.utils.randomSecretKey();
    const recipPubHex = bytesToHex(schnorr.getPublicKey(recipPriv));

    const ack = encodeBitchatAckEnvelope(
      SENDER_PEER,
      null,
      NoisePayloadType.READ_RECEIPT,
      "msg-42",
    );
    const { event } = wrapDm(ack, senderPriv, recipPubHex);
    const decoded = decodeBitchatEnvelope(
      unwrapDm(event, recipPriv, Number.POSITIVE_INFINITY).content,
    )!;
    expect(decoded.type).toBe(NoisePayloadType.READ_RECEIPT);
    expect(decoded.messageID).toBe("msg-42");
  });

  it("accepts a rumor exactly as bitchat-ios builds it", () => {
    // bitchat-ios encodes its NostrEvent struct with JSONEncoder: an empty
    // `id` (set only on signing), no `sig` (nil is omitted), empty tags, and
    // fields in declaration order (NostrProtocol.swift, createPrivateMessage).
    const senderPriv = secp256k1.utils.randomSecretKey();
    const recipPriv = secp256k1.utils.randomSecretKey();
    const senderPubHex = bytesToHex(schnorr.getPublicKey(senderPriv));
    const recipX = schnorr.getPublicKey(recipPriv);
    const env = encodeBitchatDmEnvelope(SENDER_PEER, null, "m-ios", "hi")!;
    const now = Math.floor(Date.now() / 1000);
    const rumorJson =
      `{"id":"","pubkey":"${senderPubHex}","created_at":${now},` +
      `"kind":14,"tags":[],"content":${JSON.stringify(env)}}`;

    const seal = finalizeEvent(
      {
        kind: 13,
        created_at: now,
        tags: [],
        content: bitchatNip44Encrypt(rumorJson, recipX, senderPriv),
      },
      senderPriv,
    );
    const ephemeral = secp256k1.utils.randomSecretKey();
    const wrap = finalizeEvent(
      {
        kind: 1059,
        created_at: now,
        tags: [["p", bytesToHex(recipX)]],
        content: bitchatNip44Encrypt(JSON.stringify(seal), recipX, ephemeral),
      },
      ephemeral,
    );

    const dm = unwrapDm(wrap, recipPriv, Number.POSITIVE_INFINITY);
    expect(decodeBitchatEnvelope(dm.content)?.content).toBe("hi");
    expect(dm.timestamp).toBe(now);
  });
});

// A gift wrap made by bitchat-ios release 733098bb and frozen with its recipient
// key, copied from bitchat-ios's test fixtures
// (bitchatTests/Nostr/Fixtures/LegacyPrivateEnvelope733098bb.json and its
// RecipientKey file) into docs/spec/nostr-dm-vectors-bitchat.json. bitchat-ios
// still decrypts it, so Airhop must too. Its rumor is plain text, not a
// bitchat1 envelope, so there is no envelope to decode here.
describe("a gift wrap bitchat-ios produced", () => {
  const { event, recipientPrivateKey } = vectors.legacyPrivateEnvelope733098bb;

  afterEach(() => {
    jest.useRealTimers();
  });

  it("opens to the message and sender bitchat-ios asserts", () => {
    // The rumor's own send time, so both timestamp windows hold as they did
    // when it was received.
    jest.useFakeTimers();
    jest.setSystemTime(1_783_711_013_000);

    const dm = unwrapDm(event as Event, hexToBytes(recipientPrivateKey), 3600);

    expect(dm.content).toBe("legacy fixture from 733098bb");
    expect(dm.senderPubkey).toBe(
      "2e3d79df7047204f02b726c574e256f8de1dd80510f7dcb8b0d12df13acb87e6",
    );
    expect(dm.timestamp).toBe(1_783_711_013);
  });
});
