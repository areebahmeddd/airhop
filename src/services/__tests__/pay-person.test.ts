/**
 * @jest-environment node
 */
// Which rail `payPerson` takes, and how many times the money leaves the wallet.
//
// Only the nutzap rail is final, and only the token rails reserve proofs that
// can be pulled back. Two rules cost real money if broken:
//
//   1. One commitment per payment. A relay publish that fails after the lock,
//      including a timeout that is not a WalletError, must not fall through to
//      `prepareSend` and reserve a second set: send 500 and 1000 would leave.
//   2. Once proofs are locked to the recipient, no other rail is tried: they
//      are already theirs, so a fallback would pay twice.

jest.mock("@bridge/NativeAirhopBLE", () => ({
  __esModule: true,
  default: {},
}));
jest.mock("@bridge/NativeAirhopWiFi", () => ({
  __esModule: true,
  default: {},
}));

jest.mock("../wallet-service", () => ({
  __esModule: true,
  WalletError: class WalletError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  quoteSend: jest.fn(),
  prepareSend: jest.fn(),
  findNutzapTarget: jest.fn(),
  lockProofsForNutzap: jest.fn(),
  publishLockedNutzap: jest.fn(),
  settleNutzap: jest.fn(),
  failNutzapDelivery: jest.fn(),
  failSend: jest.fn(),
  reclaimSend: jest.fn(),
}));

jest.mock("../mesh-service", () => ({
  __esModule: true,
  getMeshService: jest.fn(),
}));

import { useAlertStore } from "@store/alert-store";
import { useChatStore } from "@store/chat-store";
import { useContactsStore } from "@store/contacts-store";
import { getMeshService } from "../mesh-service";
import { payPerson } from "../payment-router";
import {
  findNutzapTarget,
  lockProofsForNutzap,
  prepareSend,
  publishLockedNutzap,
  quoteSend,
  settleNutzap,
  WalletError,
} from "../wallet-service";

const MINT = "https://mint.example.com";
const PEER = "aabbccdd00112233";
const PUBKEY = "ab".repeat(32);
const P2PK = "02" + "cd".repeat(32);
const THEIR_RELAY = "wss://relay.theirs.example";

const mockedMesh = getMeshService as jest.MockedFunction<typeof getMeshService>;
const mockedQuote = quoteSend as jest.MockedFunction<typeof quoteSend>;
const mockedPrepare = prepareSend as jest.MockedFunction<typeof prepareSend>;
const mockedFind = findNutzapTarget as jest.MockedFunction<
  typeof findNutzapTarget
>;
const mockedLock = lockProofsForNutzap as jest.MockedFunction<
  typeof lockProofsForNutzap
>;
const mockedPublish = publishLockedNutzap as jest.MockedFunction<
  typeof publishLockedNutzap
>;

// A mesh service that answers just enough for the payment ladder.
function fakeMesh(options: {
  directLink?: boolean;
  online?: boolean;
  route?: "sent" | "sent-nostr" | "needs-courier" | "queued";
  peerNostrPubkey?: string;
}) {
  return {
    hasDirectLink: jest.fn(() => options.directLink ?? false),
    getNostrClient: jest.fn(() => ((options.online ?? true) ? {} : null)),
    getNostrPrivKey: jest.fn(() => new Uint8Array(32)),
    getPeerNostrPubkey: jest.fn(() => options.peerNostrPubkey),
    getPeerID: jest.fn(() => "0011223344556677"),
    sendDm: jest.fn(() => options.route ?? "sent"),
  };
}

function useMesh(options: Parameters<typeof fakeMesh>[0]) {
  const mesh = fakeMesh(options);
  mockedMesh.mockReturnValue(mesh as never);
  return mesh;
}

// The user: agrees unless a test says otherwise, and every question asked is
// kept so a test can read what they were told.
let answer: "confirm" | "cancel" = "confirm";
let asked: { title: string; message?: string }[] = [];
let stopAnswering: (() => void) | null = null;

afterEach(() => {
  stopAnswering?.();
  stopAnswering = null;
  useAlertStore.getState().hide();
});

beforeEach(() => {
  jest.clearAllMocks();
  useChatStore.getState().clearAll();
  useContactsStore.getState().clearAll();

  answer = "confirm";
  asked = [];
  stopAnswering = useAlertStore.subscribe((state, previous) => {
    if (!state.visible || previous.visible) return;
    const button = state.buttons.find((b) =>
      answer === "confirm" ? b.style === "destructive" : b.style === "cancel",
    );
    if (button === undefined) return;
    asked.push({ title: state.title, message: state.message });
    // The modal hides itself and then runs the button, in that order.
    queueMicrotask(() => {
      useAlertStore.getState().hide();
      button.onPress?.();
    });
  });

  mockedQuote.mockResolvedValue({
    mintUrl: MINT,
    unit: "sat",
    amount: 500,
    spend: 500,
    fee: 0,
    exact: true,
    proofs: [],
  });
  mockedPrepare.mockResolvedValue({
    mintUrl: MINT,
    unit: "sat",
    amount: 500,
    spend: 500,
    fee: 0,
    exact: true,
    proofs: [],
    txId: "tx-token-1",
    token: "cashuBtoken",
  });
  mockedLock.mockResolvedValue({ locked: [], txId: "tx-nutzap-1" });
  mockedPublish.mockResolvedValue({ published: true, token: "cashuBlocked" });
  mockedFind.mockResolvedValue({
    ok: true,
    target: { mintUrl: MINT, p2pkPubkey: P2PK, relays: [THEIR_RELAY] },
  });
});

describe("payPerson rail choice", () => {
  it("uses the radio for a peer standing next to you, without asking a relay", async () => {
    useMesh({ directLink: true, peerNostrPubkey: PUBKEY, route: "sent" });

    const result = await payPerson({ peerID: PEER, amount: 500 });

    expect(result?.rail).toBe("mesh");
    expect(result?.final).toBe(false);
    // Someone in front of you should not wait on a mint round trip.
    expect(mockedFind).not.toHaveBeenCalled();
    expect(mockedLock).not.toHaveBeenCalled();
  });

  it("nutzaps a reachable Nostr identity when they have published how", async () => {
    useMesh({ directLink: false, peerNostrPubkey: PUBKEY });

    const result = await payPerson({ peerID: PEER, amount: 500 });

    expect(result?.rail).toBe("nutzap");
    expect(result?.final).toBe(true);
    // Locked proofs are not reserved as well, which would double the cost.
    expect(mockedPrepare).not.toHaveBeenCalled();
  });

  it("publishes the nutzap to THEIR relays, not ours", async () => {
    useMesh({ directLink: false, peerNostrPubkey: PUBKEY });

    await payPerson({ peerID: PEER, amount: 500 });

    // NIP-61: the recipient subscribes to the relays in their kind 10019. Our
    // own pool would work between two Airhop users (a shared default) and lose
    // the payment against any other NIP-61 wallet.
    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({ relays: [THEIR_RELAY] }),
    );
  });

  it("falls back to a token when they have published no nutzap info", async () => {
    useMesh({
      directLink: false,
      peerNostrPubkey: PUBKEY,
      route: "sent-nostr",
    });
    mockedFind.mockResolvedValue({ ok: false, reason: "they have not said" });

    const result = await payPerson({ peerID: PEER, amount: 500 });

    expect(result?.rail).toBe("nostr");
    expect(result?.final).toBe(false);
    expect(result?.fallbackReason).toBe("they have not said");
    expect(mockedPrepare).toHaveBeenCalledTimes(1);
  });

  it("takes the token rail when we know no Nostr key for them", async () => {
    useMesh({ directLink: false, route: "needs-courier" });

    const result = await payPerson({ peerID: PEER, amount: 500 });

    expect(result?.rail).toBe("courier");
    expect(mockedFind).not.toHaveBeenCalled();
  });

  it("hands the token back when nothing could carry it", async () => {
    useMesh({ directLink: false, route: "queued" });

    const result = await payPerson({ peerID: PEER, amount: 500 });

    expect(result?.rail).toBe("queued");
    // Without the string the user has a pending entry and no way to act on it.
    expect(result?.token).toBe("cashuBtoken");
  });

  it("refuses when the mesh service is not running, spending nothing", async () => {
    mockedMesh.mockReturnValue(null);

    const result = await payPerson({ peerID: PEER, amount: 500 });

    expect(result).toBeNull();
    expect(mockedPrepare).not.toHaveBeenCalled();
    expect(mockedLock).not.toHaveBeenCalled();
  });
});

describe("payPerson commits exactly once", () => {
  it("does not reserve a second set of proofs when the relay refuses", async () => {
    useMesh({
      directLink: false,
      peerNostrPubkey: PUBKEY,
      route: "sent-nostr",
    });
    mockedPublish.mockResolvedValue({
      published: false,
      token: "cashuBlocked",
    });

    const result = await payPerson({ peerID: PEER, amount: 500 });

    // Rule 1: the locked proofs are already the recipient's, so only delivery
    // remains.
    expect(mockedLock).toHaveBeenCalledTimes(1);
    expect(mockedPrepare).not.toHaveBeenCalled();
    expect(result?.rail).toBe("nutzap-dm");
    expect(result?.final).toBe(true);
    expect(settleNutzap).toHaveBeenCalledWith("tx-nutzap-1");
  });

  it("keeps a refused nutzap final even when no route carried it either", async () => {
    useMesh({ directLink: false, peerNostrPubkey: PUBKEY, route: "queued" });
    mockedPublish.mockResolvedValue({
      published: false,
      token: "cashuBlocked",
    });

    const result = await payPerson({ peerID: PEER, amount: 500 });

    // Not "nutzap-dm": nothing reached them, so the copy must not say it did.
    expect(result?.rail).toBe("nutzap-undelivered");
    expect(result?.final).toBe(true);
    expect(result?.token).toBe("cashuBlocked");
    expect(settleNutzap).not.toHaveBeenCalled();
    expect(mockedPrepare).not.toHaveBeenCalled();
  });

  it("falls through to a token when the lock itself failed, reserving once", async () => {
    useMesh({
      directLink: false,
      peerNostrPubkey: PUBKEY,
      route: "sent-nostr",
    });
    mockedLock.mockRejectedValue(new Error("mint unreachable"));

    const result = await payPerson({ peerID: PEER, amount: 500 });

    // A failed lock spends nothing (the mint's swap is atomic), so a lesser
    // rail is safe here and only here.
    expect(result?.rail).toBe("nostr");
    expect(result?.final).toBe(false);
    expect(mockedPrepare).toHaveBeenCalledTimes(1);
  });
});

describe("payPerson identity resolution", () => {
  it("pays a known contact under the peer ID their thread is keyed by", async () => {
    const mesh = useMesh({ directLink: false, route: "sent-nostr" });
    mockedFind.mockResolvedValue({ ok: false, reason: "no info" });
    useContactsStore.getState().addContact({
      peerID: PEER,
      nickname: "swift-falcon-aabb",
      noisePubKeyHex: "ff".repeat(32),
      signingPubKeyHex: "ee".repeat(32),
      addedAtMs: 1_700_000_000_000,
      source: "qr",
      nostrPubkeyHex: PUBKEY,
    });

    // The Wallet tab's Zap only ever holds a public key.
    await payPerson({ nostrPubkey: PUBKEY, amount: 500 });

    // Not `nostr_<pubkey>`: the payment lands in the existing conversation
    // rather than a second thread with the same person.
    expect(mesh.sendDm).toHaveBeenCalledWith(
      PEER,
      "cashuBtoken",
      expect.any(String),
    );
    expect(useChatStore.getState().messages[`dm:${PEER}`]).toHaveLength(1);
  });

  it("uses a nostr_ id for a key that belongs to nobody we know", async () => {
    const mesh = useMesh({ directLink: false, route: "sent-nostr" });
    mockedFind.mockResolvedValue({ ok: false, reason: "no info" });

    await payPerson({ nostrPubkey: PUBKEY, amount: 500 });

    expect(mesh.sendDm).toHaveBeenCalledWith(
      `nostr_${PUBKEY}`,
      "cashuBtoken",
      expect.any(String),
    );
  });

  it("reads the key out of a nostr_ peer id, so a DM thread can nutzap", async () => {
    useMesh({ directLink: false });

    const result = await payPerson({
      peerID: `nostr_${PUBKEY}`,
      amount: 500,
    });

    expect(mockedFind).toHaveBeenCalledWith(
      expect.objectContaining({ recipientPubkey: PUBKEY }),
    );
    expect(result?.rail).toBe("nutzap");
  });

  it("notes a nutzap in the thread it was sent from", async () => {
    useMesh({ directLink: false, peerNostrPubkey: PUBKEY });
    const channel = `dm:${PEER}`;
    useChatStore.getState().addChannel(channel);
    useChatStore.getState().addMessage({
      id: "m1",
      channel,
      senderID: PEER,
      senderNickname: "them",
      text: "hi",
      timestampMs: 1_700_000_000_000,
      isMine: false,
    });

    await payPerson({ peerID: PEER, amount: 500 });

    // A nutzap transmits nothing in the thread, so a local notice records it.
    const notes = useChatStore
      .getState()
      .messages[channel].filter((m) => m.isSystem);
    expect(notes).toHaveLength(1);
  });

  it("does not open a thread with a stranger just to record a zap", async () => {
    useMesh({ directLink: false });

    await payPerson({ nostrPubkey: PUBKEY, amount: 500 });

    // A zap from the Wallet tab belongs in wallet history, not a new thread.
    expect(
      useChatStore.getState().messages[`dm:nostr_${PUBKEY}`],
    ).toBeUndefined();
  });

  it("refuses a payment addressed to nobody", async () => {
    useMesh({ directLink: false });

    expect(await payPerson({ amount: 500 })).toBeNull();
    expect(mockedPrepare).not.toHaveBeenCalled();
  });
});

describe("payPerson asks before money moves", () => {
  it("asks once, naming the amount and the person, and says a nutzap is final", async () => {
    useMesh({ directLink: false, peerNostrPubkey: PUBKEY });

    await payPerson({ peerID: PEER, amount: 500, recipientName: "Ana" });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.title).toContain("500");
    expect(asked[0]?.title).toContain("Ana");
    expect(asked[0]?.message).toMatch(/cannot be taken back/);
  });

  it("says a token can be reclaimed, since it can", async () => {
    useMesh({ directLink: true, route: "sent" });

    await payPerson({ peerID: PEER, amount: 500, recipientName: "Ana" });

    expect(asked).toHaveLength(1);
    expect(asked[0]?.message).toMatch(/reclaim/);
  });

  it("spends nothing when the user says no", async () => {
    useMesh({ directLink: false, peerNostrPubkey: PUBKEY });
    answer = "cancel";

    const result = await payPerson({ peerID: PEER, amount: 500 });

    expect(result).toBeNull();
    expect(mockedLock).not.toHaveBeenCalled();
    expect(mockedPrepare).not.toHaveBeenCalled();
  });

  it("does not ask twice when a refused lock falls back to a token", async () => {
    useMesh({ directLink: false, peerNostrPubkey: PUBKEY, route: "sent" });
    mockedLock.mockRejectedValue(new Error("mint unreachable"));

    await payPerson({ peerID: PEER, amount: 500 });

    expect(asked).toHaveLength(1);
    expect(mockedPrepare).toHaveBeenCalledTimes(1);
  });
});

describe("a lock whose answer went missing", () => {
  it("stops the ladder rather than paying again as a token", async () => {
    // The mint may have locked the coins to them. A token now would pay twice;
    // reconcile settles the first.
    useMesh({ directLink: false, peerNostrPubkey: PUBKEY, route: "sent" });
    mockedLock.mockRejectedValue(
      Object.assign(new WalletError("offline", "in doubt"), { inDoubt: true }),
    );

    const result = await payPerson({ peerID: PEER, amount: 500 });

    expect(result).toBeNull();
    expect(mockedPrepare).not.toHaveBeenCalled();
  });
});
