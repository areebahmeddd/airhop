/**
 * @jest-environment node
 */
// Group states owed to a member not reachable yet, and which of them are kept.

import {
  encodeGroupState,
  type GroupStatePayload,
} from "@core/mesh/rooms/group-protocol";
import { NoisePayloadType } from "@core/mesh/wire/noise-payload";
import {
  clearOwedGroupStates,
  queueOwedGroupState,
  takeOwedGroupStates,
} from "../group-invite-outbox-store";

const KEY_UPDATE = NoisePayloadType.GROUP_KEY_UPDATE;

function state(groupByte: number, epoch: number): Uint8Array {
  const payload: GroupStatePayload = {
    groupID: new Uint8Array(16).fill(groupByte),
    name: "trip",
    epoch,
    members: [
      {
        fingerprint: "ab".repeat(32),
        signingKey: new Uint8Array(32).fill(1),
        nickname: "ana",
      },
    ],
    creatorFingerprint: "cd".repeat(32),
    key: new Uint8Array(32).fill(epoch),
    signature: new Uint8Array(64),
  };
  return encodeGroupState(payload)!;
}

beforeEach(() => clearOwedGroupStates());

describe("queueOwedGroupState", () => {
  // Sent together over several hops, an older state can land after the newer
  // one that replaced it: a removal overtaken by the key update it followed.
  it("keeps only the newest epoch of a group", () => {
    queueOwedGroupState("peer", KEY_UPDATE, state(1, 2));
    queueOwedGroupState("peer", KEY_UPDATE, state(1, 3));
    queueOwedGroupState("peer", KEY_UPDATE, state(1, 2));
    const owed = takeOwedGroupStates("peer");
    expect(owed).toHaveLength(1);
    expect(owed[0].stateBytes).toEqual(state(1, 3));
  });

  it("leaves other groups alone", () => {
    queueOwedGroupState("peer", KEY_UPDATE, state(1, 5));
    queueOwedGroupState("peer", KEY_UPDATE, state(2, 1));
    expect(takeOwedGroupStates("peer")).toHaveLength(2);
  });
});
