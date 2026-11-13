// Group store: persistence, epoch replacement, and the two-party state->message
// flow (creator signs state, member ingests it and opens a sealed message).
import {
  decodeGroupEnvelope,
  groupFingerprint,
  newGroupID,
  newGroupKey,
  openGroupMessage,
  sealGroupMessage,
  signGroupState,
  type BitchatGroup,
  type GroupMember,
} from "@core/mesh/rooms/group-protocol";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { createMMKV } from "react-native-mmkv";
import { groupChannel, useGroupStore } from "../group-store";

function member(nick: string): { member: GroupMember; signPriv: Uint8Array } {
  const signPriv = ed25519.utils.randomSecretKey();
  const noisePub = x25519.getPublicKey(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  return {
    member: {
      fingerprint: groupFingerprint(noisePub),
      signingKey: ed25519.getPublicKey(signPriv),
      nickname: nick,
    },
    signPriv,
  };
}

describe("group store", () => {
  beforeEach(() => {
    useGroupStore.setState({ groups: [], left: [], invites: [] });
    createMMKV({ id: "group-store" }).clearAll();
  });

  it("stores a local group and returns it in runtime (bytes) form", () => {
    const creator = member("me");
    const group: BitchatGroup = {
      groupID: newGroupID(),
      name: "crew",
      epoch: 0,
      members: [creator.member],
      creatorFingerprint: creator.member.fingerprint,
    };
    const key = newGroupKey();
    useGroupStore.getState().upsertLocal(group, key);

    const rt = useGroupStore.getState().getByID(group.groupID)!;
    expect(rt.name).toBe("crew");
    expect([...rt.key]).toEqual([...key]);
    expect(rt.members[0].signingKey).toBeInstanceOf(Uint8Array);
    const channel = groupChannel(bytesToHexLocal(group.groupID));
    expect(useGroupStore.getState().nameForChannel(channel)).toBe("crew");
  });

  // The fingerprint is a hash of the Noise key; the roster pairs it with a
  // signing key the state itself supplies, so that key is pinned as well.
  it("refuses a creator whose signing key changed", () => {
    const creator = member("me");
    const groupID = newGroupID();
    const base: BitchatGroup = {
      groupID,
      name: "g",
      epoch: 1,
      members: [creator.member],
      creatorFingerprint: creator.member.fingerprint,
    };
    useGroupStore.getState().upsertLocal(base, newGroupKey());
    const forged = { ...creator.member, signingKey: new Uint8Array(32) };
    useGroupStore
      .getState()
      .upsertLocal({ ...base, epoch: 2, members: [forged] }, newGroupKey());
    expect(useGroupStore.getState().get(bytesToHexLocal(groupID))!.epoch).toBe(
      1,
    );
  });

  it("keeps one valid entry per group when loading", () => {
    const creator = member("me");
    const stored = (epoch: number, withCreator: boolean) => ({
      groupID: "ab".repeat(16),
      name: "g",
      epoch,
      members: withCreator
        ? [
            {
              fingerprint: creator.member.fingerprint,
              signingKey: "cd".repeat(32),
              nickname: "me",
            },
          ]
        : [],
      creatorFingerprint: creator.member.fingerprint,
      key: "ef".repeat(32),
    });
    // The storage mock is module state, so it is seeded in the same isolated
    // registry the store loads from.
    jest.isolateModules(() => {
      const mmkv =
        require("react-native-mmkv") as typeof import("react-native-mmkv");
      mmkv
        .createMMKV({ id: "group-store" })
        .set(
          "groups",
          JSON.stringify([stored(1, true), stored(3, true), stored(5, false)]),
        );
      const { useGroupStore: reloaded } =
        require("../group-store") as typeof import("../group-store");
      expect(reloaded.getState().groups.map((g) => g.epoch)).toEqual([3]);
    });
  });

  it("adopts a newer epoch and ignores an older one", () => {
    const creator = member("me");
    const groupID = newGroupID();
    const base: BitchatGroup = {
      groupID,
      name: "g",
      epoch: 1,
      members: [creator.member],
      creatorFingerprint: creator.member.fingerprint,
    };
    useGroupStore.getState().upsertLocal(base, newGroupKey());
    // Older epoch: ignored.
    useGroupStore.getState().upsertLocal({ ...base, epoch: 0 }, newGroupKey());
    expect(useGroupStore.getState().get(bytesToHexLocal(groupID))!.epoch).toBe(
      1,
    );
    // Newer epoch: adopted.
    const newKey = newGroupKey();
    useGroupStore.getState().upsertLocal({ ...base, epoch: 2 }, newKey);
    const rt = useGroupStore.getState().get(bytesToHexLocal(groupID))!;
    expect(rt.epoch).toBe(2);
    expect([...rt.key]).toEqual([...newKey]);
  });

  it("carries a signed state from creator to member, who opens a message", () => {
    const creator = member("creator");
    const me = member("me");
    const groupID = newGroupID();
    const key = newGroupKey();
    const group: BitchatGroup = {
      groupID,
      name: "trip",
      epoch: 0,
      members: [creator.member, me.member],
      creatorFingerprint: creator.member.fingerprint,
    };
    const state = signGroupState(group, key, creator.signPriv)!;

    // Member ingests the verified state.
    useGroupStore.getState().upsertFromState(state);
    const rt = useGroupStore.getState().getByID(groupID)!;

    // Creator seals a message; member opens it with the stored key.
    const payload = sealGroupMessage({
      content: "wheels up",
      messageID: "g1",
      senderNickname: "creator",
      senderSigningKey: creator.member.signingKey,
      senderSigningPrivKey: creator.signPriv,
      timestampMs: 1_700_000_000_000,
      groupID,
      epoch: 0,
      key,
    })!;
    const opened = openGroupMessage(decodeGroupEnvelope(payload)!, rt.key)!;
    expect(opened.content).toBe("wheels up");
  });

  it("refuses to let a non-creator re-key a group at a higher epoch", () => {
    // groupID and epoch ride in cleartext in every group message, so an
    // attacker can read both off the air and mint a state for the same group at
    // epoch+1, naming themselves as creator and signing it with their own key.
    // Every check the ingest path makes passes: it is correctly signed, and it
    // is signed by the creator it claims. Only comparing against the creator
    // this group already has stops it. If it lands, members seal their next
    // message under the attacker's key.
    const creator = member("creator");
    const mallory = member("mallory");
    const me = member("me");
    const groupID = newGroupID();
    const realKey = newGroupKey();

    useGroupStore.getState().upsertFromState(
      signGroupState(
        {
          groupID,
          name: "trip",
          epoch: 3,
          members: [creator.member, me.member],
          creatorFingerprint: creator.member.fingerprint,
        },
        realKey,
        creator.signPriv,
      )!,
    );

    const hijack = signGroupState(
      {
        groupID, // same group
        name: "trip", // same name, so nothing looks different
        epoch: 4, // higher, so the epoch guard alone would accept it
        members: [mallory.member, me.member],
        creatorFingerprint: mallory.member.fingerprint,
      },
      newGroupKey(),
      mallory.signPriv,
    )!;
    useGroupStore.getState().upsertFromState(hijack);

    const rt = useGroupStore.getState().getByID(groupID)!;
    expect(rt.creatorFingerprint).toBe(creator.member.fingerprint);
    expect(rt.epoch).toBe(3);
    expect([...rt.key]).toEqual([...realKey]);
  });

  it("still lets the real creator rotate the key at a higher epoch", () => {
    // The other side of the boundary: pinning the creator must not freeze the
    // group. A rekey from the same creator has to keep working, or removing a
    // member would be impossible.
    const creator = member("creator");
    const me = member("me");
    const groupID = newGroupID();
    const rotated = newGroupKey();

    for (const [epoch, key] of [
      [3, newGroupKey()],
      [4, rotated],
    ] as const) {
      useGroupStore.getState().upsertFromState(
        signGroupState(
          {
            groupID,
            name: "trip",
            epoch,
            members: [creator.member, me.member],
            creatorFingerprint: creator.member.fingerprint,
          },
          key,
          creator.signPriv,
        )!,
      );
    }

    const rt = useGroupStore.getState().getByID(groupID)!;
    expect(rt.epoch).toBe(4);
    expect([...rt.key]).toEqual([...rotated]);
  });

  describe("invites", () => {
    function invite(name = "trip", epoch = 0) {
      const creator = member("creator");
      const me = member("me");
      const group: BitchatGroup = {
        groupID: newGroupID(),
        name,
        epoch,
        members: [creator.member, me.member],
        creatorFingerprint: creator.member.fingerprint,
      };
      const key = newGroupKey();
      return {
        creator,
        me,
        group,
        key,
        id: bytesToHexLocal(group.groupID),
        state: signGroupState(group, key, creator.signPriv)!,
      };
    }

    it("holds an invite without joining, and joins on accept", () => {
      const { state, id, key } = invite();
      const store = useGroupStore.getState();
      expect(store.addInvite(state)).toEqual([]);
      expect(store.get(id)).toBeUndefined();
      expect(store.invite(id)?.name).toBe("trip");
      expect(store.nameForChannel(groupChannel(id))).toBe("trip");

      expect(store.acceptInvite(id)).toBe(true);
      expect([...useGroupStore.getState().get(id)!.key]).toEqual([...key]);
      expect(useGroupStore.getState().invite(id)).toBeUndefined();
      expect(useGroupStore.getState().acceptInvite(id)).toBe(false);
    });

    it("remembers a declined invite as left, so a rotation does not ask again", () => {
      const { state, id } = invite();
      const store = useGroupStore.getState();
      store.addInvite(state);
      store.leave(id);
      expect(useGroupStore.getState().invite(id)).toBeUndefined();
      expect(useGroupStore.getState().hasLeft(id)).toBe(true);
    });

    it("pins an invite to its creator and takes only a newer epoch", () => {
      const { state, group, key, creator } = invite();
      const store = useGroupStore.getState();
      store.addInvite(state);

      const impostor = member("impostor");
      const hijack = signGroupState(
        {
          ...group,
          epoch: 1,
          members: [impostor.member, ...group.members],
          creatorFingerprint: impostor.member.fingerprint,
        },
        key,
        impostor.signPriv,
      )!;
      expect(store.addInvite(hijack)).toBeNull();

      const rotated = signGroupState(
        { ...group, epoch: 2, name: "trip 2" },
        key,
        creator.signPriv,
      )!;
      expect(store.addInvite(rotated)).toEqual([]);
      expect(store.addInvite(state)).toBeNull();
      expect(store.invite(bytesToHexLocal(group.groupID))?.epoch).toBe(2);
    });

    it("keeps the newest twenty however many arrive", () => {
      const store = useGroupStore.getState();
      const dropped: string[] = [];
      const ids: string[] = [];
      for (let i = 0; i < 25; i++) {
        const next = invite(`g${i}`);
        ids.push(next.id);
        dropped.push(...(store.addInvite(next.state) ?? []));
      }
      const names = useGroupStore.getState().invites.map((i) => i.name);
      expect(names).toHaveLength(20);
      expect(names[0]).toBe("g5");
      // The caller removes the rows of the ones pushed out.
      expect(dropped).toEqual(ids.slice(0, 5));
    });

    it("keeps three per creator, so a flood pushes out only its own", () => {
      const store = useGroupStore.getState();
      const friend = invite("friend");
      store.addInvite(friend.state);

      const spammer = member("spammer");
      const me = member("me");
      const dropped: string[] = [];
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const group: BitchatGroup = {
          groupID: newGroupID(),
          name: `spam${i}`,
          epoch: 0,
          members: [spammer.member, me.member],
          creatorFingerprint: spammer.member.fingerprint,
        };
        ids.push(bytesToHexLocal(group.groupID));
        const state = signGroupState(group, newGroupKey(), spammer.signPriv)!;
        dropped.push(...(store.addInvite(state) ?? []));
      }

      const names = useGroupStore.getState().invites.map((i) => i.name);
      expect(names).toEqual(["friend", "spam2", "spam3", "spam4"]);
      expect(dropped).toEqual(ids.slice(0, 2));
    });

    it("holds a contact's invites past the per-creator share", () => {
      const store = useGroupStore.getState();
      const friend = member("friend");
      const me = member("me");
      for (let i = 0; i < 5; i++) {
        const group: BitchatGroup = {
          groupID: newGroupID(),
          name: `plan${i}`,
          epoch: 0,
          members: [friend.member, me.member],
          creatorFingerprint: friend.member.fingerprint,
        };
        const state = signGroupState(group, newGroupKey(), friend.signPriv)!;
        expect(store.addInvite(state, { fromContact: true })).toEqual([]);
      }
      expect(useGroupStore.getState().invites).toHaveLength(5);
    });
  });

  it("clears everything on wipe", () => {
    const creator = member("me");
    useGroupStore.getState().upsertLocal(
      {
        groupID: newGroupID(),
        name: "g",
        epoch: 0,
        members: [creator.member],
        creatorFingerprint: creator.member.fingerprint,
      },
      newGroupKey(),
    );
    useGroupStore.getState().clearAll();
    expect(useGroupStore.getState().groups).toHaveLength(0);
    expect(
      createMMKV({ id: "group-store" }).getString("groups"),
    ).toBeUndefined();
  });
});

function bytesToHexLocal(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
