// NIP-61 nutzaps: Cashu proofs P2PK-locked (NUT-11) to the recipient and
// published in a public event. A nutzap is the payment itself, not a request:
// anyone can read it, only the key holder can swap it, so the relay never holds
// spendable value and the recipient need not be online to be paid.
//
//   kind 10019  "how to pay me", replaceable, published by the receiver
//               ["relay", <url>]            where to send nutzaps
//               ["mint", <url>, <unit>...]  mints they accept
//               ["pubkey", <33-byte hex>]   the P2PK key to lock to
//   kind 9321   the nutzap, published by the sender; content is the comment
//               ["proof", <proof JSON>]     one tag per locked proof
//               ["u", <mint url>]           the issuing mint
//               ["p", <recipient pubkey>]   who it is for
//               ["e", <event id>, <relay>]  optional, what is being zapped
//
// Two rules lose money if broken: proofs must come from a mint the recipient
// listed (others are worthless to them), and the lock key is the 33-byte
// compressed `pubkey` tag, never the 32-byte x-only Nostr key (that lock is
// unspendable by anyone, sender included). Kind numbers: PROTOCOLS.md section 8.

import type { Proof, ProofLike } from "@cashu/cashu-ts";
import { finalizeEvent, type Event } from "nostr-tools";
import type { NostrClient } from "../nostr/nostr-client";

// Event kinds per PROTOCOLS.md section 8.
export const KIND_NUTZAP = 9321;
export const KIND_NUTZAP_INFO = 10019;

// A nutzap event is public and unauthenticated apart from its signature, so
// every relay-supplied field is hostile until parsed.
const MAX_PROOFS_PER_NUTZAP = 64;
const MAX_PROOF_TAG_LENGTH = 4096;
const MAX_COMMENT_LENGTH = 280;
const MAX_MINTS = 16;
const MAX_RELAYS = 16;

// How far back to look for nutzaps we might have missed while offline.
const LOOKBACK_S = 60 * 60 * 24 * 30;

export interface NutzapInfo {
  // Nostr pubkey of the person being paid (hex, x-only).
  pubkey: string;
  // In their stated order of preference.
  mintUrls: string[];
  // 33-byte compressed secp256k1 key to lock proofs to (hex).
  p2pkPubkey: string;
  // Relays they watch for nutzaps.
  relays: string[];
}

export interface ReceivedNutzap {
  eventId: string;
  senderPubkey: string;
  createdAt: number;
  mintUrl: string;
  unit: string;
  proofs: ProofLike[];
  amount: number;
  comment?: string;
  targetEventId?: string;
}

// Without this nobody can nutzap us: a sender cannot know our mints or lock
// key, and NIP-61 says not to guess. Replaceable, so a republish supersedes.
// The P2PK key must stay stable across republishes, or proofs locked to an
// older announcement become unspendable.
export async function publishNutzapInfo(params: {
  mintUrls: string[];
  p2pkPubkey: string;
  relays: string[];
  privKey: Uint8Array;
  client: NostrClient;
}): Promise<Event> {
  const mints = params.mintUrls.slice(0, MAX_MINTS);
  if (mints.length === 0) {
    throw new Error("nutzap info needs at least one mint");
  }
  if (!/^0[23][0-9a-f]{64}$/i.test(params.p2pkPubkey)) {
    // The classic NIP-61 mistake: an x-only key locks proofs nobody can unlock.
    throw new Error(
      "p2pk pubkey must be a 33-byte compressed secp256k1 key (02/03 prefix)",
    );
  }

  const event = finalizeEvent(
    {
      kind: KIND_NUTZAP_INFO,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ...params.relays.slice(0, MAX_RELAYS).map((url) => ["relay", url]),
        // Trailing entries are accepted units. Airhop holds only sat, listed
        // explicitly so a sender need not guess.
        ...mints.map((url) => ["mint", url, "sat"]),
        ["pubkey", params.p2pkPubkey.toLowerCase()],
      ],
      content: "",
    },
    params.privKey,
  );

  await params.client.publish(event);
  return event;
}

// Null (no kind 10019, the common case) means fall back to a token in a DM.
export async function fetchNutzapInfo(
  recipientPubkey: string,
  client: NostrClient,
): Promise<NutzapInfo | null> {
  const events = await client.queryEvents({
    kinds: [KIND_NUTZAP_INFO],
    authors: [recipientPubkey],
    limit: 1,
  });
  const event = events[0];
  if (!event) return null;
  return parseNutzapInfo(event);
}

export function parseNutzapInfo(event: Event): NutzapInfo | null {
  if (event.kind !== KIND_NUTZAP_INFO) return null;

  const mintUrls: string[] = [];
  const relays: string[] = [];
  let p2pkPubkey: string | undefined;

  for (const tag of event.tags) {
    const [name, value] = tag;
    if (typeof value !== "string" || value.length === 0) continue;
    if (name === "mint" && mintUrls.length < MAX_MINTS) {
      if (isHttpUrl(value)) mintUrls.push(value);
    } else if (name === "relay" && relays.length < MAX_RELAYS) {
      if (/^wss?:\/\//i.test(value)) relays.push(value);
    } else if (name === "pubkey" && p2pkPubkey === undefined) {
      if (/^0[23][0-9a-f]{64}$/i.test(value)) p2pkPubkey = value.toLowerCase();
    }
  }

  // Both are load-bearing: without a mint we do not know what they accept,
  // without a P2PK key we cannot lock. Never fall back to `event.pubkey` as
  // the lock key: it is x-only, and no mint can unlock proofs locked to it.
  if (mintUrls.length === 0 || p2pkPubkey === undefined) return null;

  return { pubkey: event.pubkey, mintUrls, p2pkPubkey, relays };
}

// `proofs` must already be locked to the recipient's `p2pkPubkey` (see
// `lockProofsForNutzap` in wallet-service) and come from a mint they listed.
// Unlocked proofs here are bearer tokens on a public relay for anyone to grab.
export async function publishNutzap(params: {
  proofs: Proof[];
  mintUrl: string;
  recipientPubkey: string;
  senderPrivKey: Uint8Array;
  client: NostrClient;
  comment?: string;
  targetEventId?: string;
  // The recipient's kind 10019 relays, as NIP-61 requires: they subscribe to
  // their own set, so publishing to ours puts the payment where they never
  // look. Invisible between two Airhop users (one default pool), broken against
  // any other NIP-61 wallet. Empty (no relay tags) falls back to our pool.
  relays?: string[];
}): Promise<Event> {
  if (params.proofs.length === 0) throw new Error("nutzap needs proofs");
  if (params.proofs.length > MAX_PROOFS_PER_NUTZAP) {
    throw new Error("too many proofs for one nutzap");
  }

  const event = finalizeEvent(
    {
      kind: KIND_NUTZAP,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        // One tag per proof is the NIP-61 wire format. An array in `content`
        // is an event no other Nostr wallet can read.
        ...params.proofs.map((proof) => [
          "proof",
          JSON.stringify({
            id: proof.id,
            amount: proof.amount.toNumber(),
            secret: proof.secret,
            C: proof.C,
            ...(proof.witness !== undefined ? { witness: proof.witness } : {}),
          }),
        ]),
        // Exactly one "u", the mint URL: readers take a second "u" (say, a
        // unit) as a second mint.
        ["u", params.mintUrl],
        ["p", params.recipientPubkey],
        ...(params.targetEventId ? [["e", params.targetEventId]] : []),
      ],
      content: (params.comment ?? "").slice(0, MAX_COMMENT_LENGTH),
    },
    params.senderPrivKey,
  );

  await params.client.publish(event, params.relays);
  return event;
}

// Fires once per event. Relays replay, so the caller dedupes (wallet-store
// tracks redeemed ids).
export function subscribeNutzaps(
  myPubkey: string,
  client: NostrClient,
  onNutzap: (zap: ReceivedNutzap) => void,
): () => void {
  const closer = client.subscribe(
    [
      {
        kinds: [KIND_NUTZAP],
        "#p": [myPubkey],
        since: Math.floor(Date.now() / 1000) - LOOKBACK_S,
      },
    ],
    (event: Event) => {
      const parsed = parseNutzap(event);
      if (parsed) onNutzap(parsed);
    },
  );
  return () => closer.close();
}

export function parseNutzap(event: Event): ReceivedNutzap | null {
  if (event.kind !== KIND_NUTZAP) return null;

  const proofs: ProofLike[] = [];
  let mintUrl: string | undefined;
  let targetEventId: string | undefined;

  for (const tag of event.tags) {
    const [name, value] = tag;
    if (typeof value !== "string") continue;
    if (name === "proof") {
      if (proofs.length >= MAX_PROOFS_PER_NUTZAP) continue;
      if (value.length > MAX_PROOF_TAG_LENGTH) continue;
      const proof = parseProofTag(value);
      if (proof) proofs.push(proof);
    } else if (name === "u" && mintUrl === undefined) {
      if (isHttpUrl(value)) mintUrl = value;
    } else if (name === "e" && targetEventId === undefined) {
      if (/^[0-9a-f]{64}$/i.test(value)) targetEventId = value.toLowerCase();
    }
  }

  if (proofs.length === 0 || mintUrl === undefined) return null;

  const amount = proofs.reduce((total, p) => total + Number(p.amount), 0);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;

  const comment = event.content.trim().slice(0, MAX_COMMENT_LENGTH);

  return {
    eventId: event.id,
    senderPubkey: event.pubkey,
    createdAt: event.created_at,
    mintUrl,
    // NIP-61 carries no unit tag; sat is the NUT-00 default and the only unit
    // our kind 10019 advertises.
    unit: "sat",
    proofs,
    amount,
    ...(comment.length > 0 ? { comment } : {}),
    ...(targetEventId !== undefined ? { targetEventId } : {}),
  };
}

// Rejects anything not structurally complete, which would show as incoming
// money and then fail at the mint.
function parseProofTag(raw: string): ProofLike | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;

  const amount = typeof p.amount === "number" ? p.amount : Number(p.amount);
  if (
    typeof p.id !== "string" ||
    typeof p.secret !== "string" ||
    typeof p.C !== "string" ||
    !Number.isSafeInteger(amount) ||
    amount <= 0
  ) {
    return null;
  }
  if (!/^[0-9a-f]{2,66}$/i.test(p.id)) return null;
  if (!/^0[23][0-9a-f]{64}$/i.test(p.C)) return null;

  return {
    id: p.id,
    amount,
    secret: p.secret,
    C: p.C,
    ...(p.witness !== undefined
      ? { witness: p.witness as ProofLike["witness"] }
      : {}),
    ...(p.dleq !== undefined ? { dleq: p.dleq as ProofLike["dleq"] } : {}),
  } as ProofLike;
}

function isHttpUrl(value: string): boolean {
  if (value.length > 512) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
