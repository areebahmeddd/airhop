/**
 * @jest-environment node
 */
// Board store: quota, expiry, tombstones, persistence.
import {
  newPostID,
  signBoardPost,
  signBoardTombstone,
  type BoardPost,
  type BoardWire,
} from "@core/mesh/wire/board-packet";
import { ed25519 } from "@noble/curves/ed25519.js";
import { createMMKV } from "react-native-mmkv";
import { isLivePost, useBoardStore } from "../board-store";

function author(): { priv: Uint8Array; pub: Uint8Array } {
  const priv = ed25519.utils.randomSecretKey();
  return { priv, pub: ed25519.getPublicKey(priv) };
}

const DAY = 24 * 60 * 60 * 1000;

function makePost(
  a: { priv: Uint8Array; pub: Uint8Array },
  opts: { createdAt: number; lifetimeMs?: number; geohash?: string } = {
    createdAt: 0,
  },
): BoardPost {
  const createdAt = opts.createdAt;
  return signBoardPost(
    {
      postID: newPostID(),
      geohash: opts.geohash ?? "u4pruy",
      content: `notice @ ${createdAt}`,
      authorSigningKey: a.pub,
      authorNickname: "n",
      createdAt,
      expiresAt: createdAt + (opts.lifetimeMs ?? DAY),
      flags: 0,
    },
    a.priv,
  );
}

function post(p: BoardPost): BoardWire {
  return { kind: "post", post: p };
}

describe("board store", () => {
  // Reads prune against the real wall clock, so anchor the test clock there too.
  const now = Date.now();

  beforeEach(() => {
    useBoardStore.setState({ posts: [], tombstones: [] });
    createMMKV({ id: "board-store" }).clearAll();
  });

  it("accepts a valid post and scopes reads by geohash", () => {
    const a = author();
    const p = makePost(a, { createdAt: now - 1000 });
    expect(useBoardStore.getState().ingest(post(p), now)).toBe("accepted");
    expect(useBoardStore.getState().postsForGeohash("u4pruy")).toHaveLength(1);
    expect(useBoardStore.getState().postsForGeohash("other")).toHaveLength(0);
  });

  it("reports a duplicate on re-ingest", () => {
    const a = author();
    const p = makePost(a, { createdAt: now - 1000 });
    useBoardStore.getState().ingest(post(p), now);
    expect(useBoardStore.getState().ingest(post(p), now)).toBe("duplicate");
    expect(useBoardStore.getState().posts).toHaveLength(1);
  });

  it("rejects an already-expired post", () => {
    const a = author();
    const p = makePost(a, { createdAt: now - 2 * DAY, lifetimeMs: DAY });
    expect(useBoardStore.getState().ingest(post(p), now)).toBe("rejected");
  });

  it("rejects a post created implausibly far in the future", () => {
    const a = author();
    const p = makePost(a, { createdAt: now + 2 * DAY });
    expect(useBoardStore.getState().ingest(post(p), now)).toBe("rejected");
  });

  it("enforces the per-author cap, evicting oldest", () => {
    const a = author();
    // 6 posts, increasing createdAt; the oldest is evicted (cap 5).
    for (let i = 0; i < 6; i++) {
      useBoardStore
        .getState()
        .ingest(post(makePost(a, { createdAt: now - (10 - i) * 1000 })), now);
    }
    const kept = useBoardStore.getState().posts;
    expect(kept).toHaveLength(5);
    // Six posts at now-10s..now-5s; the single oldest (now-10s) is evicted, so
    // the oldest survivor is now-9s.
    const oldestKept = Math.min(...kept.map((p) => p.createdAt));
    expect(oldestKept).toBe(now - 9 * 1000);
  });

  it("removes a post when its author's tombstone arrives", () => {
    const a = author();
    const p = makePost(a, { createdAt: now - 1000 });
    useBoardStore.getState().ingest(post(p), now);
    const tombstone = signBoardTombstone(p.postID, a.pub, now, a.priv);
    expect(
      useBoardStore.getState().ingest({ kind: "tombstone", tombstone }, now),
    ).toBe("accepted");
    expect(useBoardStore.getState().posts).toHaveLength(0);
  });

  it("suppresses a post that arrives after its tombstone (orphan race)", () => {
    const a = author();
    const p = makePost(a, { createdAt: now - 1000 });
    const tombstone = signBoardTombstone(p.postID, a.pub, now, a.priv);
    expect(
      useBoardStore.getState().ingest({ kind: "tombstone", tombstone }, now),
    ).toBe("accepted");
    // The post now shows up late; it must be rejected.
    expect(useBoardStore.getState().ingest(post(p), now)).toBe("rejected");
    expect(useBoardStore.getState().posts).toHaveLength(0);
  });

  it("persists accepted posts to storage and clears them on wipe", () => {
    const a = author();
    useBoardStore
      .getState()
      .ingest(post(makePost(a, { createdAt: now - 1000 })), now);
    expect(
      createMMKV({ id: "board-store" }).getString("entries"),
    ).toBeDefined();
    useBoardStore.getState().clearAll();
    expect(useBoardStore.getState().posts).toHaveLength(0);
    expect(
      createMMKV({ id: "board-store" }).getString("entries"),
    ).toBeUndefined();
  });
});

// The time rules ingest applies, without a store: what a relay consults before
// forwarding a post, so it never carries one every board would refuse.
describe("isLivePost", () => {
  const now = Date.now();
  const a = author();

  it("admits a post inside its lifetime", () => {
    expect(isLivePost(makePost(a, { createdAt: now - 1000 }), now)).toBe(true);
  });

  it("refuses a post at or past its expiry", () => {
    const p = makePost(a, { createdAt: now - 2 * DAY, lifetimeMs: DAY });
    expect(isLivePost(p, now)).toBe(false);
    expect(isLivePost(p, p.expiresAt)).toBe(false);
    expect(isLivePost(p, p.expiresAt - 1)).toBe(true);
  });

  it("refuses a post dated further ahead than clock skew explains", () => {
    const early = makePost(a, { createdAt: now + 2 * 60 * 60 * 1000 });
    const skewed = makePost(a, { createdAt: now + 60_000 });
    expect(isLivePost(early, now)).toBe(false);
    expect(isLivePost(skewed, now)).toBe(true);
  });

  it("agrees with ingest", () => {
    useBoardStore.setState({ posts: [], tombstones: [] });
    const stale = makePost(a, { createdAt: now - 2 * DAY, lifetimeMs: DAY });
    const live = makePost(a, { createdAt: now - 1000 });
    expect(isLivePost(stale, now)).toBe(false);
    expect(useBoardStore.getState().ingest(post(stale), now)).toBe("rejected");
    expect(isLivePost(live, now)).toBe(true);
    expect(useBoardStore.getState().ingest(post(live), now)).toBe("accepted");
  });
});
