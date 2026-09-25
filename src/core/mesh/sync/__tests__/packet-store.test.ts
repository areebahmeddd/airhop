/**
 * @jest-environment node
 */
import { Flags, PacketType, type Packet } from "../../wire/packet-codec";
import { PacketStore } from "../packet-store";

function packet(bytes: number, tag = 0): Packet {
  return {
    type: PacketType.CHANNEL_MSG,
    ttl: 7,
    flags: Flags.SIGNED,
    senderID: new Uint8Array(8),
    recipientID: new Uint8Array(8),
    timestamp: tag,
    signature: new Uint8Array(64),
    payload: new Uint8Array(bytes),
  };
}

const tags = (store: PacketStore): number[] =>
  [...store.values()].map((p) => p.timestamp);

describe("PacketStore", () => {
  test("evicts the oldest past its count", () => {
    const store = new PacketStore(3);
    for (let i = 0; i < 5; i++) store.insert(`k${i}`, packet(1, i));
    expect(tags(store)).toEqual([2, 3, 4]);
    expect(store.size).toBe(3);
  });

  test("evicts the oldest past its byte budget, whatever the count", () => {
    const store = new PacketStore(100, 10);
    store.insert("a", packet(4, 1));
    store.insert("b", packet(4, 2));
    store.insert("c", packet(4, 3));
    expect(tags(store)).toEqual([2, 3]);
    expect(store.payloadBytes).toBe(8);
  });

  test("refuses a packet no budget could hold, keeping what it has", () => {
    const store = new PacketStore(100, 10);
    store.insert("a", packet(4, 1));
    store.insert("huge", packet(11, 2));
    expect(tags(store)).toEqual([1]);
  });

  test("re-inserting a key makes it the newest and counts its bytes once", () => {
    const store = new PacketStore(2);
    store.insert("a", packet(3, 1));
    store.insert("b", packet(3, 2));
    store.insert("a", packet(5, 3));
    store.insert("c", packet(1, 4));
    expect(tags(store)).toEqual([3, 4]);
    expect(store.payloadBytes).toBe(6);
  });

  test("removeWhere and clear keep the byte count honest", () => {
    const store = new PacketStore(10);
    for (let i = 0; i < 4; i++) store.insert(`k${i}`, packet(2, i));
    store.removeWhere((p) => p.timestamp % 2 === 0);
    expect(tags(store)).toEqual([1, 3]);
    expect(store.payloadBytes).toBe(4);
    expect(store.get("k1")?.timestamp).toBe(1);
    store.clear();
    expect(store.size).toBe(0);
    expect(store.payloadBytes).toBe(0);
  });
});
