// Geohash DM: a message sent from one per-cell identity is gift-wrapped so only
// the recipient's per-cell identity can open it, wrapped in a bitchat1 envelope.
import { base64UrlToBytes } from "@core/encoding/base64";
import { NoisePayloadType } from "@core/mesh/wire/noise-payload";
import { decodePacket } from "@core/mesh/wire/packet-codec";
import {
  decodeBitchatEnvelope,
  encodeBitchatAckEnvelope,
} from "@core/nostr/bitchat-envelope";
import {
  deriveGeohashIdentity,
  deriveGeohashSeed,
} from "@core/nostr/geohash-identity";
import { unwrapDm } from "@core/nostr/gift-wrap";
import type { NostrClient } from "@core/nostr/nostr-client";
import { ed25519 } from "@noble/curves/ed25519.js";
import { useChatStore } from "@store/chat-store";
import { useMeshStateStore } from "@store/mesh-state-store";
import { useOutboxStore } from "@store/outbox-store";
import { resolveDisplayName } from "@utils/peer-display-name";
import { GeohashChannelService } from "../geohash-channel-service";

// The position the service resolves cells from. Driven per test so "we have no
// idea where we are" and "we are definitely somewhere else" stay
// distinguishable, which is the whole point of the signal under test.
let mockCoords: { lat: number; lng: number } | null = null;

jest.mock("../location-service", () => ({
  getCoarseLocation: () => Promise.resolve(mockCoords),
}));

function mockClient(
  published: { content: string; pubkey: string }[],
): NostrClient {
  return {
    isConnected: true,
    subscribe: () => ({ close: () => undefined }),
    publish: async (event: { content: string; pubkey: string }) => {
      published.push(event);
      return { relay: "", ok: true };
    },
  } as unknown as NostrClient;
}

describe("geohash DM", () => {
  const GEOHASH = "u4pruy";

  it("sends an E2E DM only the recipient's per-cell identity can open", () => {
    const published: { content: string; pubkey: string }[] = [];
    const senderSigning = ed25519.utils.randomSecretKey();
    const service = new GeohashChannelService(
      mockClient(published),
      senderSigning,
      "alice",
    );

    // The recipient's per-cell identity (a different device/seed).
    const recipIdentity = deriveGeohashIdentity(
      deriveGeohashSeed(ed25519.utils.randomSecretKey()),
      GEOHASH,
    );

    const ok = service.sendGeoDm(
      GEOHASH,
      recipIdentity.pubKeyHex,
      "gm-1",
      "meet at the plaza",
    );
    expect(ok).toBe(true);
    // Registered so a reply routes back through this cell.
    expect(service.geohashForGeoDmPeer(recipIdentity.pubKeyHex)).toBe(GEOHASH);

    // The recipient unwraps with their per-cell key and decodes the envelope.
    expect(published).toHaveLength(1);
    const dm = unwrapDm(
      published[0] as never,
      recipIdentity.privKey,
      Number.POSITIVE_INFINITY,
    );
    const env = decodeBitchatEnvelope(dm.content)!;
    expect(env.messageID).toBe("gm-1");
    expect(env.content).toBe("meet at the plaza");
    // Sealed by our own per-cell identity, so the reply comes back to it.
    expect(dm.senderPubkey).toBe(
      deriveGeohashIdentity(deriveGeohashSeed(senderSigning), GEOHASH)
        .pubKeyHex,
    );
  });

  it("returns false for content over the PrivateMessagePacket cap", () => {
    const service = new GeohashChannelService(
      mockClient([]),
      ed25519.utils.randomSecretKey(),
      "bob",
    );
    expect(
      service.sendGeoDm(GEOHASH, "aa".repeat(32), "m", "x".repeat(256)),
    ).toBe(false);
  });

  // The envelope's sender field would otherwise tie this per-cell identity to
  // our durable mesh ID.
  it("fills the envelope's sender with fresh random bytes each time", () => {
    const published: { content: string; pubkey: string }[] = [];
    const service = new GeohashChannelService(
      mockClient(published),
      ed25519.utils.randomSecretKey(),
      "alice",
    );
    const recip = deriveGeohashIdentity(
      deriveGeohashSeed(ed25519.utils.randomSecretKey()),
      GEOHASH,
    );
    service.sendGeoDm(GEOHASH, recip.pubKeyHex, "m1", "one");
    service.sendGeoDm(GEOHASH, recip.pubKeyHex, "m2", "two");

    const [a, b] = published.map((event) => {
      const { content } = unwrapDm(
        event as never,
        recip.privKey,
        Number.POSITIVE_INFINITY,
      );
      return decodePacket(base64UrlToBytes(content.slice("bitchat1:".length)))!
        .senderID;
    });
    expect(a).not.toEqual(b);
  });

  // Relays replay the lookback on every resubscribe.
  it("acknowledges a replayed wrap only once", () => {
    useChatStore.getState().clearAll();
    const sent: { content: string; pubkey: string }[] = [];
    const bobPublished: { content: string; pubkey: string }[] = [];
    const bobSigning = ed25519.utils.randomSecretKey();
    const alice = new GeohashChannelService(
      mockClient(sent),
      ed25519.utils.randomSecretKey(),
      "alice",
    );
    const bob = new GeohashChannelService(
      mockClient(bobPublished),
      bobSigning,
      "bob",
    );
    const bobCell = deriveGeohashIdentity(
      deriveGeohashSeed(bobSigning),
      GEOHASH,
    );
    alice.sendGeoDm(GEOHASH, bobCell.pubKeyHex, "m1", "hi");

    const receive = (
      bob as unknown as { handleGeoDm: (e: unknown, g: string) => void }
    ).handleGeoDm.bind(bob);
    receive(sent[0], GEOHASH);
    receive(sent[0], GEOHASH);

    expect(bobPublished).toHaveLength(1);
  });
});

// Which identity a reply is written from, and whether that survives a relaunch.
//
// The binding from a location-channel peer to the cell we met them in has to
// outlive the process. Without it, opening such a thread from the Direct list
// and sending falls through to the caller's MAIN Nostr identity: the recipient
// sees a message from a key they have never seen (a second thread, not a
// reply), and a person we have only ever met pseudonymously in a location
// channel is handed our permanent identity.
//
// It lives in chat-store, which is persisted, so these pin both halves: the
// binding outlives the service, and its absence still means "not a geohash DM".
describe("the geo-DM cell binding", () => {
  const GEOHASH = "u4pruy";
  const PEER = "bb".repeat(32);

  beforeEach(() => {
    useChatStore.getState().clearAll();
  });

  it("survives the service being rebuilt, as a relaunch rebuilds it", () => {
    const signing = ed25519.utils.randomSecretKey();
    const first = new GeohashChannelService(mockClient([]), signing, "alice");
    first.registerGeoDmPeer(PEER, GEOHASH);

    // A new process: same stores, a brand-new service instance.
    const relaunched = new GeohashChannelService(
      mockClient([]),
      signing,
      "alice",
    );
    expect(relaunched.geohashForGeoDmPeer(PEER)).toBe(GEOHASH);
  });

  // The absence of a binding is meaningful, not merely unknown: it says this
  // person reached our durable identity, and replying from it is correct.
  it("stays undefined for a peer we never met in a cell", () => {
    const service = new GeohashChannelService(
      mockClient([]),
      ed25519.utils.randomSecretKey(),
      "alice",
    );
    expect(service.geohashForGeoDmPeer("cc".repeat(32))).toBeUndefined();
  });

  // A binding is a record of where we were when we spoke to someone. Deleting
  // the conversation has to take it with it.
  it("is dropped when the conversation is deleted", () => {
    const service = new GeohashChannelService(
      mockClient([]),
      ed25519.utils.randomSecretKey(),
      "alice",
    );
    service.registerGeoDmPeer(PEER, GEOHASH);
    useChatStore.getState().removeChannel(`dm:nostr_${PEER}`);
    expect(service.geohashForGeoDmPeer(PEER)).toBeUndefined();
  });

  it("is destroyed with everything else on a wipe", () => {
    const service = new GeohashChannelService(
      mockClient([]),
      ed25519.utils.randomSecretKey(),
      "alice",
    );
    service.registerGeoDmPeer(PEER, GEOHASH);
    useChatStore.getState().clearAll();
    expect(service.geohashForGeoDmPeer(PEER)).toBeUndefined();
  });
});

// Which cells we are still listening in, which is what lets a conversation say
// it has been left behind rather than just going quiet.
//
// The per-cell DM inbox exists per SUBSCRIBED channel. Sending survives moving
// away (the key is derived from the cell, not from where you stand); receiving
// does not. A thread compares its own cell against this list to say so.
describe("the live-cell signal", () => {
  beforeEach(() => {
    useChatStore.getState().clearAll();
    useMeshStateStore.setState({ liveGeoCells: null });
    mockCoords = null;
  });

  // Null, not the empty list. With no fix, "not listening there" and "no idea
  // where we are" are the same observation, and only one of them is worth
  // telling someone their conversation has moved on from.
  it("says nothing at all when there is no position fix", async () => {
    const service = new GeohashChannelService(
      mockClient([]),
      ed25519.utils.randomSecretKey(),
      "alice",
    );
    await service.refresh();
    expect(useMeshStateStore.getState().liveGeoCells).toBeNull();
  });

  it("lists the cell whose inbox is open once a position resolves", async () => {
    mockCoords = { lat: 48.8584, lng: 2.2945 };
    useChatStore.setState({ channels: ["#city"] });
    const service = new GeohashChannelService(
      mockClient([]),
      ed25519.utils.randomSecretKey(),
      "alice",
    );
    await service.refresh();

    const live = useMeshStateStore.getState().liveGeoCells;
    expect(live).toEqual([service.geohashFor("#city")]);

    // A resolved cell starts the presence heartbeat, which reschedules itself
    // forever. Left running it keeps the whole suite's event loop alive.
    service.stop();
  });

  // A stopped mesh is not listening anywhere, but it also cannot say where it
  // would be. An empty list would tell every location thread it had been left.
  it("goes back to saying nothing when the mesh stops", async () => {
    mockCoords = { lat: 48.8584, lng: 2.2945 };
    useChatStore.setState({ channels: ["#city"] });
    const service = new GeohashChannelService(
      mockClient([]),
      ed25519.utils.randomSecretKey(),
      "alice",
    );
    await service.refresh();
    expect(useMeshStateStore.getState().liveGeoCells).not.toBeNull();

    service.stop();
    expect(useMeshStateStore.getState().liveGeoCells).toBeNull();
  });
});

// Keeping someone met under a location pseudonym.
//
// Their cell key and our peer ID are unlinkable by design (that is what stops
// relays following anyone between neighbourhoods), so nothing but the person
// choosing to say "this is also me" can ever join the two. These pin the wire
// half of that choice: the card goes out gift-wrapped from our PER-CELL key, so
// a relay learns nothing new, and it arrives as a card rather than a message.
describe("handing over a contact card in a location channel", () => {
  const GEOHASH = "u4pruy";

  beforeEach(() => {
    useChatStore.getState().clearAll();
  });

  it("reaches only the recipient's per-cell identity, and reads back as a card", () => {
    const published: { content: string; pubkey: string }[] = [];
    const service = new GeohashChannelService(
      mockClient(published),
      ed25519.utils.randomSecretKey(),
      "alice",
    );
    const recipient = deriveGeohashIdentity(
      deriveGeohashSeed(ed25519.utils.randomSecretKey()),
      GEOHASH,
    );
    const card = new Uint8Array(120).fill(7);

    service.sendContactCard(GEOHASH, recipient.pubKeyHex, card);

    expect(published).toHaveLength(1);
    const dm = unwrapDm(
      published[0] as never,
      recipient.privKey,
      Number.POSITIVE_INFINITY,
    );
    const env = decodeBitchatEnvelope(dm.content)!;
    expect(env.type).toBe(NoisePayloadType.CONTACT_CARD);
    expect(Array.from(env.body!)).toEqual(Array.from(card));
    // Not a message: no id, so it gets no bubble and no receipt.
    expect(env.messageID).toBe("");
    expect(env.content).toBe("");
  });

  // The envelope stays pseudonymous. What discloses us is the card INSIDE it,
  // which is the thing the user actually chose to hand over.
  it("is written from our per-cell key, not our durable identity", () => {
    const published: { content: string; pubkey: string }[] = [];
    const signing = ed25519.utils.randomSecretKey();
    const service = new GeohashChannelService(
      mockClient(published),
      signing,
      "alice",
    );
    const recipient = deriveGeohashIdentity(
      deriveGeohashSeed(ed25519.utils.randomSecretKey()),
      GEOHASH,
    );
    service.sendContactCard(GEOHASH, recipient.pubKeyHex, new Uint8Array(80));

    const ourCellKey = deriveGeohashIdentity(
      deriveGeohashSeed(signing),
      GEOHASH,
    ).pubKeyHex;
    // The seal inside is ours, from the cell key and nothing more durable.
    const dm = unwrapDm(
      published[0] as never,
      recipient.privKey,
      Number.POSITIVE_INFINITY,
    );
    expect(dm.senderPubkey).toBe(ourCellKey);
    // The wrap outside is signed by a throwaway key, so a relay sees not even
    // the cell key.
    expect(published[0].pubkey).not.toBe(ourCellKey);
    expect(JSON.stringify(published[0])).not.toContain(ourCellKey);
  });

  // Sending one binds the cell, exactly as sending a message does, so a reply
  // routes back through the same pseudonymous channel.
  it("binds the cell so the conversation keeps working", () => {
    const service = new GeohashChannelService(
      mockClient([]),
      ed25519.utils.randomSecretKey(),
      "alice",
    );
    const recipient = deriveGeohashIdentity(
      deriveGeohashSeed(ed25519.utils.randomSecretKey()),
      GEOHASH,
    );
    service.sendContactCard(GEOHASH, recipient.pubKeyHex, new Uint8Array(80));
    expect(service.geohashForGeoDmPeer(recipient.pubKeyHex)).toBe(GEOHASH);
  });
});

// The window between one side merging and the other finding out.
//
// Our card takes a relay round trip to reach them, so for a few seconds after we
// fold the threads together they are still writing on the pseudonymous rail. A
// message arriving then is addressed to a name that has become an alias, and
// filing it there would put it in a thread the user can no longer open: a
// message that is received, stored, and invisible.
describe("messages arriving after a merge", () => {
  const GEOHASH = "u4pruy";
  const THEIR_PEER_ID = "99887766554433aa";

  beforeEach(() => {
    useChatStore.getState().clearAll();
  });

  it("follows the merge instead of landing in the folded-away thread", () => {
    const sent: { content: string; pubkey: string }[] = [];
    const aliceSigning = ed25519.utils.randomSecretKey();
    const bobSigning = ed25519.utils.randomSecretKey();
    const alice = new GeohashChannelService(
      mockClient(sent),
      aliceSigning,
      "alice",
    );
    const bob = new GeohashChannelService(mockClient([]), bobSigning, "bob");
    const aliceCell = deriveGeohashIdentity(
      deriveGeohashSeed(aliceSigning),
      GEOHASH,
    );
    const bobCell = deriveGeohashIdentity(
      deriveGeohashSeed(bobSigning),
      GEOHASH,
    );
    alice.sendGeoDm(
      GEOHASH,
      bobCell.pubKeyHex,
      "late-1",
      "still on the old rail",
    );

    // Bob has already folded the pseudonymous thread into the durable one.
    useChatStore.getState().clearAll();
    const from = `dm:nostr_${aliceCell.pubKeyHex}`;
    const to = `dm:${THEIR_PEER_ID}`;
    const chat = useChatStore.getState();
    chat.addChannel(from);
    chat.addChannel(to);
    chat.mergeChannel(from, to);

    const receive = (
      bob as unknown as { handleGeoDm: (e: unknown, g: string) => void }
    ).handleGeoDm.bind(bob);
    receive(sent[0], GEOHASH);

    const after = useChatStore.getState();
    expect(after.messages[to]?.map((m) => m.id)).toContain("late-1");
    // And nothing was stranded where the user cannot reach it.
    expect(after.messages[from] ?? []).toHaveLength(0);
  });
});

// One person, one name, wherever their conversation appears.
//
// A geohash nickname rides the `n` tag on CHANNEL messages and nothing else (a
// geo DM carries none), so the pubkey alone can only ever produce "anon#last4".
// Unless the name the channel rendered travels with the conversation, the
// channel shows "NeverDie#0c08" while every other surface shows "anon#0c08":
// same person, two names.
describe("carrying a location peer's name out of the channel", () => {
  const GEOHASH = "u4pruy";
  const PUBKEY = `${"ab".repeat(31)}0c08`;

  beforeEach(() => {
    useChatStore.getState().clearAll();
  });

  it("uses the name the channel rendered once a conversation opens", () => {
    const service = new GeohashChannelService(
      mockClient([]),
      ed25519.utils.randomSecretKey(),
      "alice",
    );
    service.registerGeoDmPeer(PUBKEY, GEOHASH, "NeverDie#0c08");

    expect(resolveDisplayName(`nostr_${PUBKEY}`)).toBe("NeverDie#0c08");
  });

  // The inbound path has no name to offer, so it must not erase one we already
  // carried in from the channel.
  it("keeps the name when a later binding arrives without one", () => {
    const service = new GeohashChannelService(
      mockClient([]),
      ed25519.utils.randomSecretKey(),
      "alice",
    );
    service.registerGeoDmPeer(PUBKEY, GEOHASH, "NeverDie#0c08");
    service.registerGeoDmPeer(PUBKEY, GEOHASH);

    expect(resolveDisplayName(`nostr_${PUBKEY}`)).toBe("NeverDie#0c08");
  });

  it("forgets the name with the conversation it belonged to", () => {
    const service = new GeohashChannelService(
      mockClient([]),
      ed25519.utils.randomSecretKey(),
      "alice",
    );
    service.registerGeoDmPeer(PUBKEY, GEOHASH, "NeverDie#0c08");
    useChatStore.getState().removeChannel(`dm:nostr_${PUBKEY}`);

    expect(resolveDisplayName(`nostr_${PUBKEY}`)).toBe("anon#0c08");
  });
});

// A geo DM no relay would take must not leave a confident "sent" behind it.
describe("a geo DM the relays cannot take", () => {
  const GEOHASH = "u4pruy";
  const pubkey = (): string =>
    deriveGeohashIdentity(
      deriveGeohashSeed(ed25519.utils.randomSecretKey()),
      GEOHASH,
    ).pubKeyHex;

  // As the main identity's DM path refuses: the caller keeps it queued rather
  // than ticking a message that is still on this phone.
  it("is refused while no relay is live", () => {
    const published: { content: string; pubkey: string }[] = [];
    const client = {
      ...mockClient(published),
      isConnected: false,
    } as unknown as NostrClient;
    const service = new GeohashChannelService(
      client,
      ed25519.utils.randomSecretKey(),
      "alice",
    );
    expect(service.sendGeoDm(GEOHASH, pubkey(), "gm-8", "hello")).toBe(false);
    expect(published).toHaveLength(0);
  });

  it("tells the caller every relay refused it", async () => {
    const client = {
      isConnected: true,
      subscribe: () => ({ close: () => undefined }),
      publish: () => Promise.reject(new Error("no relay accepted")),
    } as unknown as NostrClient;
    const service = new GeohashChannelService(
      client,
      ed25519.utils.randomSecretKey(),
      "alice",
    );
    const answers: boolean[] = [];
    expect(
      service.sendGeoDm(GEOHASH, pubkey(), "gm-9", "hello", (accepted) =>
        answers.push(accepted),
      ),
    ).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(answers).toEqual([false]);
  });
});

// The outbox keeps a geo DM until its recipient answers, as for any DM.
describe("a receipt for a geo DM", () => {
  const GEOHASH = "u4pruy";

  it.each([
    ["delivered", NoisePayloadType.DELIVERED],
    ["read", NoisePayloadType.READ_RECEIPT],
  ] as const)("resolves its outbox entry when %s", (_label, type) => {
    useOutboxStore.getState().clearAll();
    const aliceSigning = ed25519.utils.randomSecretKey();
    const bobPublished: { content: string; pubkey: string }[] = [];
    const alice = new GeohashChannelService(
      mockClient([]),
      aliceSigning,
      "alice",
    );
    const bob = new GeohashChannelService(
      mockClient(bobPublished),
      ed25519.utils.randomSecretKey(),
      "bob",
    );
    const aliceCell = deriveGeohashIdentity(
      deriveGeohashSeed(aliceSigning),
      GEOHASH,
    );
    const bobCell = bob.cellPubkeyFor(GEOHASH);
    useOutboxStore.getState().enqueue({
      id: "gm-r",
      recipientPeerID: `nostr_${bobCell}`,
      channel: `dm:nostr_${bobCell}`,
      text: "hi",
      createdAtMs: Date.now(),
    });

    (
      bob as unknown as {
        publishGeoWrap: (g: string, p: string, e: string) => void;
      }
    ).publishGeoWrap(
      GEOHASH,
      aliceCell.pubKeyHex,
      encodeBitchatAckEnvelope(null, null, type, "gm-r"),
    );
    (
      alice as unknown as { handleGeoDm: (e: unknown, g: string) => void }
    ).handleGeoDm(bobPublished[0], GEOHASH);

    expect(useOutboxStore.getState().pending).toHaveLength(0);
  });
});
