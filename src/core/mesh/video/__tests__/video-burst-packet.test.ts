// bitchat's live video packet against the golden vectors in its
// LIVE_VIDEO_V1 spec, which both bitchat clients test byte for byte.

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  decodeEntries,
  decodeVideoBurstPacket,
  encodeEntries,
  encodeVideoBurstPacket,
  MAX_VIDEO_PACKET_BYTES,
  type VideoBurstPacket,
} from "../video-burst-packet";

const streamID = hexToBytes("0102030405060708");
const hex = (s: string): Uint8Array => hexToBytes(s.replace(/ /g, ""));

const GOLDEN: [string, VideoBurstPacket][] = [
  [
    "01 02 03 04 05 06 07 08 00 00 01 01 01 00 90 00 C0 08 00 18 01",
    {
      streamID,
      sequence: 0,
      kind: "start",
      config: {
        width: 144,
        height: 192,
        fps: 8,
        bitrateKbps: 24,
        hasAudio: true,
      },
    },
  ],
  [
    "01 02 03 04 05 06 07 08 00 05 00 00 02 00 04 00 01 00 00 00 40 00 01 00 03 DE AD BE",
    {
      streamID,
      sequence: 5,
      kind: "data",
      block: 2,
      index: 0,
      region: encodeEntries([
        {
          track: "video",
          keyframe: true,
          unitSequence: 1,
          ptsMs: 64,
          fragmentIndex: 0,
          fragmentCount: 1,
          bytes: hex("DEADBE"),
        },
      ]),
    },
  ],
  [
    "01 02 03 04 05 06 07 08 00 06 03 00 02 00 01 01 00 03 AA BB CC",
    {
      streamID,
      sequence: 6,
      kind: "parity",
      block: 2,
      parityIndex: 0,
      sourceCount: 1,
      parityCount: 1,
      symbol: hex("AABBCC"),
    },
  ],
  [
    "01 02 03 04 05 06 07 08 00 2A 02 00 00 0A 80 00 10 00 29 00 2A",
    {
      streamID,
      sequence: 42,
      kind: "end",
      durationMs: 2688,
      videoUnits: 16,
      audioUnits: 41,
      packets: 42,
    },
  ],
  [
    "01 02 03 04 05 06 07 08 00 03 04",
    { streamID, sequence: 3, kind: "canceled" },
  ],
];

describe("VideoBurstPacket", () => {
  test.each(GOLDEN)("encodes and decodes %s", (wire, packet) => {
    const bytes = hex(wire);
    expect(bytesToHex(encodeVideoBurstPacket(packet)!)).toBe(bytesToHex(bytes));
    expect(decodeVideoBurstPacket(bytes)).toEqual(packet);
  });

  test("the DATA vector carries one keyframe entry", () => {
    const decoded = decodeVideoBurstPacket(hex(GOLDEN[1][0]));
    expect(decoded?.kind).toBe("data");
    if (decoded?.kind !== "data") return;
    expect(decodeEntries(decoded.region)).toEqual([
      {
        track: "video",
        keyframe: true,
        unitSequence: 1,
        ptsMs: 64,
        fragmentIndex: 0,
        fragmentCount: 1,
        bytes: hex("DEADBE"),
      },
    ]);
  });

  test("refuses what bitchat refuses", () => {
    const start = hex(GOLDEN[0][0]);
    const withByte = (i: number, v: number): Uint8Array => {
      const copy = start.slice();
      copy[i] = v;
      return copy;
    };
    for (const bad of [
      start.slice(0, 10), // shorter than a header
      new Uint8Array(MAX_VIDEO_PACKET_BYTES + 1), // past the ceiling
      withByte(10, 0x05), // unknown kind
      withByte(11, 0x02), // unknown version
      withByte(12, 0x02), // unknown codec
      withByte(20, 0x02), // unknown audio codec
      withByte(14, 0x91), // odd width
      withByte(17, 0), // zero fps
      hex("0102030405060708 0003 04 00"), // CANCELED with a body
      hex(
        "0102030405060708 0005 00 0002 00 08 0001 00000040 00 01 0003 DEADBE",
      ), // reserved flag bit
      hex(
        "0102030405060708 0005 00 0002 00 00 0001 00000040 01 01 0003 DEADBE",
      ), // fragment index past count
      hex("0102030405060708 0006 03 0002 00 01 01 0004 AABBCC"), // parity length mismatch
    ]) {
      expect(decodeVideoBurstPacket(bad)).toBeNull();
    }
  });
});
