// A prepared Cashu swap, persisted before the request goes out. A swap is the
// one mint operation with no quote to ask about afterwards: lose the response
// (socket drop, OS kill) and the inputs are spent while the outputs exist
// nowhere, since their blinding factors lived only in memory. cashu-ts splits
// prepare from `completeSwap`, which builds its request purely from the
// preview, so a stored preview can be replayed. NUT-19 makes an identical
// replay return the same signatures rather than "already spent"; NUT-09
// restore of the stored blinded messages is the backstop.
//
// Two subtleties:
//   1. The replay must be BYTE-IDENTICAL, since the mint keys its NUT-19 cache
//      on the payload and `JSON.stringify` keeps insertion order. Inputs are an
//      opaque JSON round trip of what cashu-ts built, never re-shaped field by
//      field: `{id, amount, secret, C}` for `{id, amount, C, secret}` misses.
//   2. A P2PK witness is a BIP-340 signature over random aux data, so signing
//      twice gives two witnesses. Inputs are signed once, before storage, and
//      the replay never re-signs.
// `amount` and `fees` are for the UI only: `completeSwap` never reads them.

import {
  Amount,
  normalizeProofAmounts,
  OutputData,
  type OutputDataLike,
  type ProofLike,
  type SerializedOutputData,
  type SwapPreview,
} from "@cashu/cashu-ts";

// Bump if the stored shape changes meaning. A mismatched record is discarded,
// not half-read: a misread replay sends a request the mint has never seen,
// which is a fresh spend, not a recovery.
const SWAP_PREVIEW_VERSION = 1;

// A swap is a handful of proofs and outputs; anything this large is corruption.
const MAX_PREVIEW_ENTRIES = 512;

export interface StoredSwapPreview {
  v: number;
  keysetId: string;
  amount: number;
  fees: number;
  // Opaque: field order is load-bearing (see the header).
  inputs: ProofLike[];
  keepOutputs: SerializedOutputData[];
  sendOutputs?: SerializedOutputData[];
}

// Call BEFORE the request goes out and after any P2PK signing, or the replay
// will not reproduce the same body.
export function serializeSwapPreview(preview: SwapPreview): StoredSwapPreview {
  return {
    v: SWAP_PREVIEW_VERSION,
    keysetId: preview.keysetId,
    amount: preview.amount.toNumber(),
    fees: preview.fees.toNumber(),
    // Turns each `Amount` into a number while keeping key order.
    inputs: JSON.parse(JSON.stringify(preview.inputs)) as ProofLike[],
    keepOutputs: (preview.keepOutputs ?? []).map((output) =>
      OutputData.serialize(output),
    ),
    ...(preview.sendOutputs !== undefined && preview.sendOutputs.length > 0
      ? {
          sendOutputs: preview.sendOutputs.map((output) =>
            OutputData.serialize(output),
          ),
        }
      : {}),
  };
}

// Null when the record cannot be trusted. Not a log-and-move-on path: the
// value that swap carried must be recovered another way, and the caller
// decides how. `unselectedProofs` is not stored: cashu-ts only echoes it back,
// those proofs never left our store, and storing it would duplicate them.
export function rebuildSwapPreview(stored: unknown): SwapPreview | null {
  if (!isStoredSwapPreview(stored)) return null;
  try {
    const preview: SwapPreview = {
      amount: Amount.from(stored.amount),
      fees: Amount.from(stored.fees),
      keysetId: stored.keysetId,
      inputs: normalizeProofAmounts(stored.inputs),
      keepOutputs: stored.keepOutputs.map((output) =>
        OutputData.deserialize(output),
      ),
      ...(stored.sendOutputs !== undefined
        ? {
            sendOutputs: stored.sendOutputs.map((output) =>
              OutputData.deserialize(output),
            ),
          }
        : {}),
    };
    if (preview.inputs.length === 0) return null;
    if (
      (preview.keepOutputs?.length ?? 0) +
        (preview.sendOutputs?.length ?? 0) ===
      0
    ) {
      return null;
    }
    return preview;
  } catch {
    // `OutputData.deserialize` throws on a non-canonical blinding factor or a
    // malformed secret, and `Amount.from` on a value it cannot parse.
    return null;
  }
}

// Every blinded message, in request order: what NUT-09 restore asks about when
// a replay is refused. Works without NUT-19 and with random secrets.
export function swapPreviewOutputs(preview: SwapPreview): OutputDataLike[] {
  return [...(preview.keepOutputs ?? []), ...(preview.sendOutputs ?? [])];
}

// Outputs past this count belong to someone else (for example P2PK-locked);
// recovery must not credit them to our balance.
export function swapPreviewKeepCount(preview: SwapPreview): number {
  return preview.keepOutputs?.length ?? 0;
}

function isStoredSwapPreview(value: unknown): value is StoredSwapPreview {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<StoredSwapPreview>;
  if (record.v !== SWAP_PREVIEW_VERSION) return false;
  if (typeof record.keysetId !== "string" || record.keysetId.length === 0) {
    return false;
  }
  if (!Number.isFinite(record.amount) || !Number.isFinite(record.fees)) {
    return false;
  }
  if (!isBoundedArray(record.inputs)) return false;
  if (!isBoundedArray(record.keepOutputs)) return false;
  if (record.sendOutputs !== undefined && !isBoundedArray(record.sendOutputs)) {
    return false;
  }
  return true;
}

function isBoundedArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_PREVIEW_ENTRIES &&
    value.every((entry) => typeof entry === "object" && entry !== null)
  );
}
