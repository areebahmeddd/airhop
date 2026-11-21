// Forward-secret internet DMs: the batch a phone hands one contact, the seal a
// DM goes under, and the stores behind both.

import * as keychain from "@core/crypto/keychain";
import { DM_PREKEY_ITEMS, writeSecretSync } from "@core/crypto/keychain";
import { peerIDFromNoiseKey } from "@core/crypto/peer-id";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import {
  LocalDmPrekeyStore,
  PeerDmPrekeyStore,
  SEAL_LAST_RESORT_MAX_AGE_MS,
  SEAL_ONE_TIME_MAX_AGE_MS,
} from "../dm-prekey-store";
import {
  decodeDmPrekeyBatch,
  DM_PREKEY_LAST_RESORT,
  DM_PREKEY_ONE_TIME,
  encodeDmPrekeyBatch,
  openSealedDm,
  parseSealedDm,
  sealDmToPrekey,
  type DmPrekeyBatch,
  type DmPrekeyKind,
} from "../dm-prekeys";

const DAY = 24 * 60 * 60 * 1000;
const ALICE = "aaaaaaaaaaaaaaaa";
const BOB = "bbbbbbbbbbbbbbbb";
const ENVELOPE = "bitchat1:" + "A".repeat(120);

let clock = 1_800_000_000_000;
const now = (): number => clock;

beforeEach(() => {
  clock = 1_800_000_000_000;
  for (const item of DM_PREKEY_ITEMS) writeSecretSync(item, "");
});

afterEach(() => {
  jest.restoreAllMocks();
});

function issued(keys: LocalDmPrekeyStore, peerID: string): DmPrekeyBatch {
  const batch = keys.issue(peerID);
  if (batch === null) throw new Error("no batch");
  return batch;
}

// Opening a seal is find, then spend once it named its sender.
function open(
  keys: LocalDmPrekeyStore,
  kind: DmPrekeyKind,
  id: number,
  from = BOB,
): Uint8Array | null {
  const priv = keys.find(kind, id);
  return priv !== null && keys.spend(kind, id, from) ? priv : null;
}

const contact = (i: number): string => i.toString(16).padStart(16, "c");
// Contacts a full pool hands a batch of one-time keys each.
const POOL_CONTACTS = 24;

describe("a batch", () => {
  const signing = ed25519.utils.randomSecretKey();
  const signingPub = ed25519.getPublicKey(signing);

  test("is signed for one recipient, and refused for anyone else or altered", () => {
    const batch = issued(new LocalDmPrekeyStore(now), BOB);
    const bytes = encodeDmPrekeyBatch(batch, BOB, signing);
    const back = decodeDmPrekeyBatch(bytes, BOB, signingPub);
    expect(back?.oneTime.map((k) => k.id)).toEqual(
      batch.oneTime.map((k) => k.id),
    );
    expect(back?.lastResort.createdAt).toBe(clock);
    expect(back?.issuedAt).toBe(batch.issuedAt);
    expect(back?.resend).toBe(false);
    expect(decodeDmPrekeyBatch(bytes, ALICE, signingPub)).toBeNull();
    const other = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
    expect(decodeDmPrekeyBatch(bytes, BOB, other)).toBeNull();
    const tampered = bytes.slice();
    tampered[10] ^= 1;
    expect(decodeDmPrekeyBatch(tampered, BOB, signingPub)).toBeNull();
    expect(decodeDmPrekeyBatch(bytes.slice(0, -1), BOB, signingPub)).toBeNull();
  });

  test("carries a signed request to send queued mail again", () => {
    const batch = new LocalDmPrekeyStore(now).issue(BOB, true);
    const bytes = encodeDmPrekeyBatch(batch!, BOB, signing);
    expect(decodeDmPrekeyBatch(bytes, BOB, signingPub)?.resend).toBe(true);
    const flipped = bytes.slice();
    flipped[1] = 0;
    expect(decodeDmPrekeyBatch(flipped, BOB, signingPub)).toBeNull();
  });
});

describe("the seal", () => {
  const sender = x25519.utils.randomSecretKey();

  test("opens with the key it names, proves its sender, and nothing else opens it", () => {
    const priv = x25519.utils.randomSecretKey();
    const key = { id: 7, pub: x25519.getPublicKey(priv) };
    const content = sealDmToPrekey(ENVELOPE, DM_PREKEY_ONE_TIME, key, sender)!;
    const parsed = parseSealedDm(content)!;
    expect([parsed.kind, parsed.id]).toEqual([DM_PREKEY_ONE_TIME, 7]);
    const opened = openSealedDm(parsed.sealed, priv)!;
    expect(opened.envelope).toBe(ENVELOPE);
    expect(peerIDFromNoiseKey(opened.senderNoisePubKey)).toBe(
      peerIDFromNoiseKey(x25519.getPublicKey(sender)),
    );
    expect(openSealedDm(parsed.sealed, x25519.utils.randomSecretKey())).toBe(
      null,
    );
    expect(parseSealedDm(ENVELOPE)).toBeNull();
  });

  test("pads to bitchat's buckets, so length shows no more than it does", () => {
    const priv = x25519.utils.randomSecretKey();
    const key = { id: 1, pub: x25519.getPublicKey(priv) };
    const size = (text: string): number =>
      parseSealedDm(sealDmToPrekey(text, DM_PREKEY_LAST_RESORT, key, sender)!)!
        .sealed.length;
    expect(size("x")).toBe(size("x".repeat(200)));
    expect(size("x".repeat(300))).toBe(size("x".repeat(500)));
    expect(size("x".repeat(300))).toBeGreaterThan(size("x"));
    expect(sealDmToPrekey("x".repeat(2_047), 0, key, sender)).toBeNull();
  });
});

describe("our keys", () => {
  test("a one-time key opens once and is deleted as it opens", () => {
    const keys = new LocalDmPrekeyStore(now);
    const [first] = issued(keys, BOB).oneTime;
    expect(open(keys, DM_PREKEY_ONE_TIME, first.id)).not.toBeNull();
    expect(open(keys, DM_PREKEY_ONE_TIME, first.id)).toBeNull();
    expect(
      new LocalDmPrekeyStore(now).find(DM_PREKEY_ONE_TIME, first.id),
    ).toBeNull();
  });

  test("naming a key spends nothing, and only its peer can spend it", () => {
    const keys = new LocalDmPrekeyStore(now);
    const [first] = issued(keys, BOB).oneTime;
    expect(keys.find(DM_PREKEY_ONE_TIME, first.id)).not.toBeNull();
    expect(keys.spend(DM_PREKEY_ONE_TIME, first.id, ALICE)).toBe(false);
    clock += 3 * DAY;
    expect(open(keys, DM_PREKEY_ONE_TIME, first.id)).not.toBeNull();
  });

  test("a new batch retires the keys handed to that peer before", () => {
    const keys = new LocalDmPrekeyStore(now);
    const [old] = issued(keys, BOB).oneTime;
    issued(keys, BOB);
    expect(keys.needsTopUp(BOB)).toBe(false);
    // Mail already sealed to the old batch still opens, for the grace.
    clock += 2 * DAY - 1;
    expect(open(keys, DM_PREKEY_ONE_TIME, old.id)).not.toBeNull();
    clock += 1;
    expect(open(keys, DM_PREKEY_ONE_TIME, old.id)).toBeNull();
  });

  test("a key a contact may seal to is never evicted for another's", () => {
    const keys = new LocalDmPrekeyStore(now);
    const live = Array.from({ length: POOL_CONTACTS }, (_, i) =>
      issued(keys, contact(i)).oneTime.map((key) => ({ key, from: i })),
    ).flat();
    expect(keys.hasRoom()).toBe(false);
    // The next contact gets the last-resort key alone.
    expect(issued(keys, contact(POOL_CONTACTS)).oneTime).toEqual([]);
    expect(
      live.every(
        ({ key, from }) =>
          open(keys, DM_PREKEY_ONE_TIME, key.id, contact(from)) !== null,
      ),
    ).toBe(true);
    // Opened keys are gone, which makes room again.
    expect(keys.hasRoom()).toBe(true);
    expect(issued(keys, contact(POOL_CONTACTS)).oneTime).toHaveLength(3);
  });

  // The pool full of others' unused keys: Bob's top-up must not cost the key
  // retired a moment ago, which may still have mail sealed to it.
  test("a key retired by a newer batch is not evicted for room", () => {
    const keys = new LocalDmPrekeyStore(now);
    const [k1, k2, k3] = issued(keys, BOB).oneTime;
    for (let i = 0; i < POOL_CONTACTS - 1; i++) issued(keys, contact(i));
    open(keys, DM_PREKEY_ONE_TIME, k1.id);
    open(keys, DM_PREKEY_ONE_TIME, k2.id);
    expect(issued(keys, BOB).oneTime).toHaveLength(2);
    expect(open(keys, DM_PREKEY_ONE_TIME, k3.id)).not.toBeNull();
  });

  // A contact that sends under the long-term key again and again is handed a
  // batch each time: its retired keys must not crowd everyone else out.
  test("a contact holds one batch unused and one retired, never more", () => {
    const keys = new LocalDmPrekeyStore(now);
    const batches = Array.from({ length: 10 }, () => issued(keys, BOB));
    const held = batches
      .flatMap((b) => b.oneTime)
      .filter((key) => keys.find(DM_PREKEY_ONE_TIME, key.id) !== null);
    expect(held.map((key) => key.id)).toEqual(
      [...batches[8].oneTime, ...batches[9].oneTime].map((key) => key.id),
    );
    expect(issued(keys, ALICE).oneTime).toHaveLength(3);
  });

  test("retired keys go after their grace with no further use, across a relaunch too", () => {
    const keys = new LocalDmPrekeyStore(now);
    const [old] = issued(keys, BOB).oneTime;
    issued(keys, BOB);
    clock += 2 * DAY;
    keys.sweep();
    expect(
      new LocalDmPrekeyStore(now).find(DM_PREKEY_ONE_TIME, old.id),
    ).toBeNull();
    const [unused] = issued(keys, ALICE).oneTime;
    clock += 30 * DAY;
    // The relaunch deletes what has outlived its use before any other.
    new LocalDmPrekeyStore(now);
    expect(
      new LocalDmPrekeyStore(now).find(DM_PREKEY_ONE_TIME, unused.id),
    ).toBeNull();
  });

  // Four keychain values of under 2 KiB each, whichever way the keys fall.
  test("a full pool fits the keychain's value limit in every item", () => {
    const keys = new LocalDmPrekeyStore(now);
    for (let i = 0; i <= POOL_CONTACTS; i++) {
      issued(keys, contact(i));
      clock += 8 * DAY;
    }
    for (const item of DM_PREKEY_ITEMS) {
      expect(keychain.readSecretSync(item)?.length ?? 0).toBeLessThanOrEqual(
        2048,
      );
    }
  });

  test("a contact is topped up once fewer than two keys they would use are left", () => {
    const keys = new LocalDmPrekeyStore(now);
    expect(keys.needsTopUp(BOB)).toBe(true);
    const batch = issued(keys, BOB);
    expect(keys.needsTopUp(BOB)).toBe(false);
    expect(keys.needsTopUp(ALICE)).toBe(true);
    open(keys, DM_PREKEY_ONE_TIME, batch.oneTime[0].id);
    open(keys, DM_PREKEY_ONE_TIME, batch.oneTime[1].id);
    expect(keys.needsTopUp(BOB)).toBe(true);
    // A week on, unused keys no longer count: a sender has stopped using them.
    issued(keys, BOB);
    clock += SEAL_ONE_TIME_MAX_AGE_MS;
    expect(keys.needsTopUp(BOB)).toBe(true);
  });

  test("the last-resort key is replaced weekly and kept for 15 days", () => {
    const keys = new LocalDmPrekeyStore(now);
    const firstLR = issued(keys, BOB).lastResort;
    clock += 6 * DAY;
    expect(issued(keys, BOB).lastResort.id).toBe(firstLR.id);
    clock += DAY;
    const secondLR = issued(keys, BOB).lastResort;
    expect(secondLR.id).not.toBe(firstLR.id);
    clock += 8 * DAY - 1;
    expect(open(keys, DM_PREKEY_LAST_RESORT, firstLR.id)).not.toBeNull();
    clock += 1;
    expect(open(keys, DM_PREKEY_LAST_RESORT, firstLR.id)).toBeNull();
    expect(open(keys, DM_PREKEY_LAST_RESORT, secondLR.id)).not.toBeNull();
  });

  test("a key survives a relaunch, and one opened stays gone", () => {
    const keys = new LocalDmPrekeyStore(now);
    const [a, b] = issued(keys, BOB).oneTime;
    open(keys, DM_PREKEY_ONE_TIME, a.id);
    const reloaded = new LocalDmPrekeyStore(now);
    expect(open(reloaded, DM_PREKEY_ONE_TIME, a.id)).toBeNull();
    expect(open(reloaded, DM_PREKEY_ONE_TIME, b.id)).not.toBeNull();
  });

  test("a keychain it cannot read issues nothing and overwrites nothing", () => {
    const [kept] = issued(new LocalDmPrekeyStore(now), BOB).oneTime;
    const read = jest
      .spyOn(keychain, "readSecretSync")
      .mockImplementation(() => {
        throw new Error("locked");
      });
    const locked = new LocalDmPrekeyStore(now);
    expect(locked.issue(ALICE)).toBeNull();
    expect(locked.needsTopUp(ALICE)).toBe(false);
    read.mockRestore();
    // Readable again: the keys are still there.
    expect(open(locked, DM_PREKEY_ONE_TIME, kept.id)).not.toBeNull();
  });

  test("a batch is not handed out on keys that could not be saved", () => {
    const keys = new LocalDmPrekeyStore(now);
    jest.spyOn(keychain, "writeSecretSync").mockImplementation(() => {
      throw new Error("full");
    });
    expect(keys.issue(BOB)).toBeNull();
  });
});

describe("a contact's keys", () => {
  const signing = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  const batch: DmPrekeyBatch = {
    issuedAt: 1,
    lastResort: { id: 9, pub: new Uint8Array(32).fill(9), createdAt: 0 },
    oneTime: [1, 2].map((id) => ({ id, pub: new Uint8Array(32).fill(id) })),
    resend: false,
  };
  const fresh = (): DmPrekeyBatch => ({
    ...batch,
    issuedAt: clock,
    lastResort: { ...batch.lastResort, createdAt: clock },
  });

  // The partition outlives a test; each starts holding nothing for Bob.
  beforeEach(() => new PeerDmPrekeyStore(now).forget(BOB));

  test("one-time keys first, each once, then the last-resort key while fresh", () => {
    const peers = new PeerDmPrekeyStore(now);
    peers.store(BOB, fresh(), signing);
    expect(peers.take(BOB)).toMatchObject({
      kind: DM_PREKEY_ONE_TIME,
      key: { id: 1 },
    });
    expect(peers.take(BOB)).toMatchObject({
      kind: DM_PREKEY_ONE_TIME,
      key: { id: 2 },
    });
    expect(peers.take(BOB)).toMatchObject({ kind: DM_PREKEY_LAST_RESORT });
    clock += SEAL_LAST_RESORT_MAX_AGE_MS;
    expect(peers.take(BOB)).toBeNull();
  });

  test("an old one-time key is not sealed to", () => {
    const peers = new PeerDmPrekeyStore(now);
    peers.store(BOB, batch, signing);
    clock += SEAL_ONE_TIME_MAX_AGE_MS;
    expect(peers.take(BOB)).toBeNull();
  });

  test("an older batch cannot roll them back", () => {
    const peers = new PeerDmPrekeyStore(now);
    expect(peers.store(BOB, fresh(), signing)).toBe(true);
    expect(peers.store(BOB, batch, signing)).toBe(false);
    expect(peers.take(BOB)?.key.id).toBe(1);
  });

  // Two batches in one week share a last-resort key: only the issue time
  // tells the copy that waited on a relay from the one handed over since.
  test("a batch delayed past a newer one in the same week is refused", () => {
    const keys = new LocalDmPrekeyStore(now);
    const first = issued(keys, BOB);
    clock += 60_000;
    const second = issued(keys, BOB);
    expect(second.lastResort.id).toBe(first.lastResort.id);
    expect(second.issuedAt).toBeGreaterThan(first.issuedAt);
    const peers = new PeerDmPrekeyStore(now);
    expect(peers.store(BOB, second, signing)).toBe(true);
    expect(peers.store(BOB, first, signing)).toBe(false);
    expect(peers.store(BOB, second, signing)).toBe(false);
    expect(peers.take(BOB)?.key.id).toBe(second.oneTime[0].id);
  });

  test("batches issued in one millisecond still rise", () => {
    const keys = new LocalDmPrekeyStore(now);
    expect(issued(keys, BOB).issuedAt).toBeLessThan(issued(keys, BOB).issuedAt);
  });

  test("an issuer whose clock ran ahead once is not shut out", () => {
    const peers = new PeerDmPrekeyStore(now);
    expect(
      peers.store(BOB, { ...fresh(), issuedAt: clock + 365 * DAY }, signing),
    ).toBe(true);
    expect(peers.store(BOB, fresh(), signing)).toBe(true);
  });

  test("keeps the key their batches were checked against, across a relaunch", () => {
    new PeerDmPrekeyStore(now).store(BOB, batch, signing);
    expect(new PeerDmPrekeyStore(now).signingKey(BOB)).toEqual(signing);
  });

  test("an identity change forgets them, and the proof they run Airhop", () => {
    const peers = new PeerDmPrekeyStore(now);
    expect(peers.has(BOB)).toBe(false);
    peers.store(BOB, batch, signing);
    expect(peers.has(BOB)).toBe(true);
    peers.forget(BOB);
    expect(peers.take(BOB)).toBeNull();
    expect(peers.has(BOB)).toBe(false);
  });
});
