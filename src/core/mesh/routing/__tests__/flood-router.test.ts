/**
 * @jest-environment node
 */
// Deciding whether to rebroadcast a packet, and when.
//
// A mesh with no jitter has every phone answer at once and the radio collides
// with itself, so the delay matters as much as the decision. TTL and the
// duplicate check are what bound how far and how long a packet travels.
import { encodeBoardWire, signBoardPost } from "../../wire/board-packet";
import { Flags, PacketType, type Packet } from "../../wire/packet-codec";
import { FloodRouter, relayDecision, relayLimit } from "../flood-router";

const LOCAL = new Uint8Array(8).fill(0xaa);

function makePacket(_nonceByte: number = 0x01, ttl: number = 7): Packet {
  return {
    type: PacketType.ANNOUNCE,
    ttl,
    flags: Flags.SIGNED, // 0x02
    senderID: new Uint8Array(8),
    recipientID: new Uint8Array(8),
    timestamp: Math.floor(Date.now() / 1000),
    signature: new Uint8Array(64),
    payload: new Uint8Array(0),
  };
}

describe("FloodRouter", () => {
  let router: FloodRouter;

  beforeEach(() => {
    jest.useFakeTimers();
    router = new FloodRouter(LOCAL);
  });

  afterEach(() => {
    router.flush();
    jest.useRealTimers();
  });

  describe("receive()", () => {
    it("returns true for a new packet", () => {
      const sent: Packet[] = [];
      expect(router.receive(makePacket(0x01), (p) => sent.push(p))).toBe(true);
    });

    it("returns false for a duplicate packet (same nonce)", () => {
      const sent: Packet[] = [];
      const packet = makePacket(0x01);
      router.receive(packet, (p) => sent.push(p));
      expect(router.receive(packet, (p) => sent.push(p))).toBe(false);
    });

    it("schedules relay after jitter (10-220 ms)", () => {
      const sent: Packet[] = [];
      router.receive(makePacket(0x01, 7), (p) => sent.push(p));

      // Nothing sent immediately
      expect(sent.length).toBe(0);

      // After max jitter + 1ms, relay must have fired
      jest.advanceTimersByTime(221);
      expect(sent.length).toBe(1);
    });

    it("relayed packet has TTL decremented by 1", () => {
      const sent: Packet[] = [];
      router.receive(makePacket(0x01, 7), (p) => sent.push(p));
      jest.advanceTimersByTime(221);
      expect(sent[0].ttl).toBe(6);
    });

    // TTL is unsigned and set by the sender, so a hostile peer can claim 255 to
    // push its flood to every phone. The relay caps it to our own default.
    it("clamps an inflated TTL before relaying", () => {
      const sent: Packet[] = [];
      router.receive(makePacket(0x01, 255), (p) => sent.push(p));
      jest.advanceTimersByTime(221);
      expect(sent[0].ttl).toBe(6);
    });

    it("does not relay when TTL = 1 (would become 0)", () => {
      const sent: Packet[] = [];
      router.receive(makePacket(0x01, 1), (p) => sent.push(p));
      jest.advanceTimersByTime(300);
      expect(sent.length).toBe(0);
    });

    it("does not relay when TTL = 0", () => {
      const sent: Packet[] = [];
      router.receive(makePacket(0x01, 0), (p) => sent.push(p));
      jest.advanceTimersByTime(300);
      expect(sent.length).toBe(0);
    });

    // Relayed, one request would make every node it reached answer with its
    // whole store. It is still handled locally, so receive() reports it new.
    it("never relays a REQUEST_SYNC, whatever TTL it claims", () => {
      const sent: Packet[] = [];
      const request = { ...makePacket(0x01, 7), type: PacketType.REQUEST_SYNC };
      expect(router.receive(request, (p) => sent.push(p))).toBe(true);
      jest.advanceTimersByTime(300);
      expect(sent.length).toBe(0);
    });
  });

  describe("admit()", () => {
    it("dedups without relaying, and shares the table with receive()", () => {
      const sent: Packet[] = [];
      const packet = makePacket(0x01, 7);
      expect(router.admit(packet)).toBe(true);
      expect(router.admit(packet)).toBe(false);
      // A whole copy arriving after the reassembled one is a duplicate.
      expect(router.receive(packet, (p) => sent.push(p))).toBe(false);
      jest.advanceTimersByTime(500);
      expect(sent).toHaveLength(0);
    });
  });

  describe("originate()", () => {
    it("marks originating packet as seen to suppress echo relays", () => {
      const packet = makePacket(0x01);
      router.originate(packet);

      const sent: Packet[] = [];
      expect(router.receive(packet, (p) => sent.push(p))).toBe(false);
      jest.advanceTimersByTime(300);
      expect(sent.length).toBe(0);
    });
  });

  describe("flush()", () => {
    it("cancels all pending relay timers", () => {
      const sent: Packet[] = [];
      router.receive(makePacket(0x01, 7), (p) => sent.push(p));
      router.receive(makePacket(0x02, 7), (p) => sent.push(p));

      router.flush();
      jest.advanceTimersByTime(300);

      // Both relays were cancelled
      expect(sent.length).toBe(0);
    });
  });

  describe("defaultTTL", () => {
    it("equals 7 per PROTOCOLS.md", () => {
      expect(router.defaultTTL).toBe(7);
    });
  });

  describe("jitter range", () => {
    it("relay fires by 220 ms (upper bound of jitter window)", () => {
      const sent: Packet[] = [];
      router.receive(makePacket(0x03, 7), (p) => sent.push(p));

      // Advance to upper bound of jitter window
      jest.advanceTimersByTime(220);
      expect(sent.length).toBe(1);
    });

    it("relay does not fire in < 10 ms (lower bound of jitter window)", () => {
      // Spy on Math.random to force maximum jitter (220 ms)
      const spy = jest
        .spyOn(Math, "random")
        .mockReturnValue(1 - Number.EPSILON);

      const sent: Packet[] = [];
      const r = new FloodRouter(LOCAL);
      r.receive(makePacket(0x04, 7), (p) => sent.push(p));

      jest.advanceTimersByTime(9);
      expect(sent.length).toBe(0);

      jest.advanceTimersByTime(211);
      expect(sent.length).toBe(1);

      spy.mockRestore();
      r.flush();
    });
  });
});

describe("FloodRouter time-critical relay policy", () => {
  // Live voice and media fragments are relayed on a much tighter schedule than
  // ordinary traffic. Voice is the reason: a talker emits ~15 packets a second
  // and the far side plays them out of a 350 ms jitter buffer, so the ordinary
  // window (up to 220 ms per hop) would spend the whole buffer on relaying
  // before three hops were done.
  function voicePacket(ttl = 7): Packet {
    return {
      type: PacketType.VOICE_FRAME,
      ttl,
      flags: Flags.SIGNED,
      senderID: new Uint8Array(8),
      recipientID: new Uint8Array(8),
      timestamp: Date.now(),
      signature: new Uint8Array(64),
      payload: new Uint8Array([1, 2, 3]),
    };
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("relays a voice frame inside the jitter buffer's budget", () => {
    // Dense mesh, where ordinary traffic would wait 100-220 ms.
    const router = new FloodRouter(LOCAL, () => 12);
    const sent: Packet[] = [];
    router.receive(voicePacket(), (p) => sent.push(p));

    jest.advanceTimersByTime(25);
    expect(sent).toHaveLength(1);
    router.flush();
  });

  it("leaves ordinary traffic on the wider window", () => {
    const router = new FloodRouter(LOCAL, () => 12);
    const sent: Packet[] = [];
    router.receive({ ...voicePacket(), type: PacketType.CHANNEL_MSG }, (p) =>
      sent.push(p),
    );

    jest.advanceTimersByTime(25);
    expect(sent).toHaveLength(0); // still waiting; ordinary jitter starts at 100
    jest.advanceTimersByTime(220);
    expect(sent).toHaveLength(1);
    router.flush();
  });

  it("clamps voice TTL in a dense mesh so a stream cannot flood to full depth", () => {
    const router = new FloodRouter(LOCAL, () => 12);
    const sent: Packet[] = [];
    router.receive(voicePacket(7), (p) => sent.push(p));
    jest.advanceTimersByTime(30);
    // Clamped to 5, then decremented for the hop.
    expect(sent[0].ttl).toBe(4);
    router.flush();
  });

  it("keeps full depth in a sparse mesh, so voice reaches as far as text", () => {
    const router = new FloodRouter(LOCAL, () => 2);
    const sent: Packet[] = [];
    router.receive(voicePacket(7), (p) => sent.push(p));
    jest.advanceTimersByTime(30);
    expect(sent[0].ttl).toBe(6);
    router.flush();
  });

  it("still drops a voice frame that has run out of TTL", () => {
    const router = new FloodRouter(LOCAL, () => 2);
    const sent: Packet[] = [];
    expect(router.receive(voicePacket(1), (p) => sent.push(p))).toBe(true);
    jest.advanceTimersByTime(60);
    expect(sent).toHaveLength(0);
    router.flush();
  });
});

// A transcription of bitchat-ios RelayController.decide, fed the inputs
// BLEReceivePipeline.relayDecision derives, with Airhop's DR_ENCRYPTED in the
// directed set. Each row: the packet, the degree, the TTL the relayed copy
// carries (null for no relay) and the delay window.
describe("relayDecision", () => {
  const PEER = new Uint8Array(8).fill(0x11);
  const OTHER = new Uint8Array(8).fill(0x22);

  function pkt(
    type: PacketType,
    opts: { ttl?: number; to?: Uint8Array; from?: Uint8Array } = {},
  ): Packet {
    return {
      type,
      ttl: opts.ttl ?? 7,
      flags: opts.to !== undefined ? Flags.HAS_RECIPIENT : 0,
      senderID: opts.from ?? PEER,
      recipientID: opts.to ?? new Uint8Array(8),
      timestamp: Date.now(),
      signature: new Uint8Array(64),
      payload: new Uint8Array([1, 2, 3]),
    };
  }

  function boardPost(urgent: boolean): Packet {
    const post = signBoardPost(
      {
        postID: new Uint8Array(16),
        geohash: "",
        content: "notice",
        authorSigningKey: new Uint8Array(32),
        authorNickname: "n",
        createdAt: 1,
        expiresAt: 2,
        flags: urgent ? 0x01 : 0,
      },
      new Uint8Array(32).fill(7),
    );
    return {
      ...pkt(PacketType.BOARD_POST),
      payload: encodeBoardWire({ kind: "post", post }),
    };
  }

  const JITTER: Record<string, [number, number]> = {
    sparse: [10, 40],
    mid: [60, 150],
    dense: [80, 180],
    crowded: [100, 220],
  };
  const jitterFor = (degree: number): [number, number] =>
    degree <= 2
      ? JITTER.sparse
      : degree <= 5
        ? JITTER.mid
        : degree <= 9
          ? JITTER.dense
          : JITTER.crowded;
  const HANDSHAKE: [number, number] = [10, 35];
  const DIRECTED: [number, number] = [20, 60];
  const STREAM: [number, number] = [8, 25];

  function expectRelay(
    packet: Packet,
    degree: number,
    ttl: number | null,
    delay?: [number, number],
  ): void {
    for (let i = 0; i < 40; i++) {
      const d = relayDecision(packet, degree, LOCAL);
      if (ttl === null) {
        expect(d).toBeNull();
        return;
      }
      expect(d?.ttl).toBe(ttl);
      expect(d!.delayMs).toBeGreaterThanOrEqual(delay![0]);
      expect(d!.delayMs).toBeLessThanOrEqual(delay![1]);
    }
  }

  const DEGREES = [0, 2, 3, 5, 6, 10];

  test.each(DEGREES)("announce and urgent board post at degree %i", (deg) => {
    const ttl = deg >= 6 ? 4 : 6;
    expectRelay(pkt(PacketType.ANNOUNCE), deg, ttl, jitterFor(deg));
    expectRelay(boardPost(true), deg, ttl, jitterFor(deg));
  });

  test.each(DEGREES)(
    "public message and plain board post at degree %i",
    (deg) => {
      const ttl = deg >= 6 ? 4 : deg <= 2 ? 6 : 5;
      for (const type of [
        PacketType.CHANNEL_MSG,
        PacketType.CHANNEL_MSG_AIRHOP,
        PacketType.GROUP_MESSAGE,
        PacketType.FILE_TRANSFER,
        PacketType.LEAVE,
      ]) {
        expectRelay(pkt(type), deg, ttl, jitterFor(deg));
      }
      expectRelay(boardPost(false), deg, ttl, jitterFor(deg));
    },
  );

  test.each(DEGREES)(
    "directed types relay at full depth at degree %i",
    (deg) => {
      for (const type of [
        PacketType.NOISE_ENCRYPTED,
        PacketType.DR_ENCRYPTED,
        PacketType.COURIER_ENV,
        PacketType.PING,
        PacketType.PONG,
        PacketType.NOSTR_CARRIER,
        PacketType.FRAGMENT,
      ]) {
        expectRelay(pkt(type, { to: OTHER }), deg, 6, DIRECTED);
      }
      expectRelay(
        pkt(PacketType.NOISE_HANDSHAKE, { to: OTHER }),
        deg,
        6,
        HANDSHAKE,
      );
      expectRelay(pkt(PacketType.NOISE_HANDSHAKE), deg, 6, HANDSHAKE);
    },
  );

  test.each(DEGREES)("broadcast fragments and voice at degree %i", (deg) => {
    const ttl = deg >= 6 ? 4 : 6;
    expectRelay(pkt(PacketType.FRAGMENT), deg, ttl, STREAM);
    expectRelay(pkt(PacketType.VOICE_FRAME), deg, ttl, STREAM);
  });

  // A recipient only makes these types directed; broadcast, they are clamped
  // like anything else, and a recipient on another type changes nothing.
  test("direction is by type as well as recipient", () => {
    expectRelay(pkt(PacketType.NOISE_ENCRYPTED), 10, 4, JITTER.crowded);
    expectRelay(pkt(PacketType.NOSTR_CARRIER), 3, 5, JITTER.mid);
    expectRelay(
      pkt(PacketType.CHANNEL_MSG, { to: OTHER }),
      10,
      4,
      JITTER.crowded,
    );
    // bitchat-android's all-0xFF recipient is a broadcast.
    const ff = new Uint8Array(8).fill(0xff);
    expectRelay(pkt(PacketType.FRAGMENT, { to: ff }), 10, 4, STREAM);
  });

  test.each(DEGREES)("never relayed at degree %i", (deg) => {
    expectRelay(pkt(PacketType.REQUEST_SYNC), deg, null);
    expectRelay(pkt(PacketType.REQUEST_SYNC, { to: OTHER }), deg, null);
    // Ours, whoever sent it, and addressed to us.
    expectRelay(pkt(PacketType.ANNOUNCE, { from: LOCAL }), deg, null);
    expectRelay(pkt(PacketType.CHANNEL_MSG, { from: LOCAL }), deg, null);
    for (const type of [
      PacketType.NOISE_ENCRYPTED,
      PacketType.NOISE_HANDSHAKE,
      PacketType.FRAGMENT,
      PacketType.DR_ENCRYPTED,
    ]) {
      expectRelay(pkt(type, { to: LOCAL }), deg, null);
    }
    // Out of hops.
    expectRelay(pkt(PacketType.CHANNEL_MSG, { ttl: 1 }), deg, null);
    expectRelay(
      pkt(PacketType.NOISE_ENCRYPTED, { ttl: 1, to: OTHER }),
      deg,
      null,
    );
  });

  test("an inflated TTL is capped at 7, a low one is kept", () => {
    expectRelay(pkt(PacketType.CHANNEL_MSG, { ttl: 255 }), 0, 6, JITTER.sparse);
    expectRelay(
      pkt(PacketType.NOISE_ENCRYPTED, { ttl: 255, to: OTHER }),
      10,
      6,
      DIRECTED,
    );
    expectRelay(pkt(PacketType.CHANNEL_MSG, { ttl: 3 }), 10, 2, JITTER.crowded);
    expectRelay(pkt(PacketType.CHANNEL_MSG, { ttl: 2 }), 4, 1, JITTER.mid);
  });

  test("relayLimit is the ceiling the clamp applies", () => {
    expect(relayLimit(PacketType.CHANNEL_MSG, false, 0)).toBe(7);
    expect(relayLimit(PacketType.CHANNEL_MSG, false, 4)).toBe(6);
    expect(relayLimit(PacketType.BOARD_POST, true, 4)).toBe(7);
    expect(relayLimit(PacketType.ANNOUNCE, false, 4)).toBe(7);
    expect(relayLimit(PacketType.CHANNEL_MSG, false, 6)).toBe(5);
    expect(relayLimit(PacketType.VOICE_FRAME, false, 4)).toBe(7);
    expect(relayLimit(PacketType.FRAGMENT, false, 6)).toBe(5);
  });
});
