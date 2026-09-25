/**
 * @jest-environment node
 */
import { PacketType } from "../../wire/packet-codec";
import { originTtl } from "../origin-ttl";

// The three values at and below what a relay at the same degree would emit
// before its hop: the lower two look relayed, the top one does not.
function draws(
  type: PacketType,
  degree: number,
  isUrgentBoard = false,
): Set<number> {
  const seen = new Set<number>();
  for (let i = 0; i < 300; i++)
    seen.add(originTtl(type, degree, isUrgentBoard));
  return seen;
}

describe("originTtl", () => {
  test.each([
    [0, [5, 6, 7]],
    [2, [5, 6, 7]],
    [3, [4, 5, 6]],
    [5, [4, 5, 6]],
    [6, [3, 4, 5]],
    [12, [3, 4, 5]],
  ])("a public message at degree %i leaves at %j", (degree, range) => {
    expect([...draws(PacketType.CHANNEL_MSG, degree)].sort()).toEqual(range);
  });

  test("an urgent board post keeps the extra hop at mid degree", () => {
    expect([...draws(PacketType.BOARD_POST, 4, true)].sort()).toEqual([
      5, 6, 7,
    ]);
    expect([...draws(PacketType.BOARD_POST, 4)].sort()).toEqual([4, 5, 6]);
  });

  test("live voice and file fragments follow the stream ceiling", () => {
    for (const type of [PacketType.VOICE_FRAME, PacketType.FRAGMENT]) {
      expect([...draws(type, 4)].sort()).toEqual([5, 6, 7]);
      expect([...draws(type, 8)].sort()).toEqual([3, 4, 5]);
    }
  });
});
