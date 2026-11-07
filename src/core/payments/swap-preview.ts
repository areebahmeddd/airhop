// A prepared Cashu swap, persisted before the request goes out. A swap is the
// one mint operation with no quote to ask about afterwards: lose the response
// (socket drop, OS kill) and the inputs are spent while the outputs exist
// nowhere, since their blinding factors lived only in memory. cashu-ts splits
// prepare from `completeSwap`, which builds its request purely from the
// preview, so a stored preview can be replayed. NUT-19 makes a replay of the
// same request return the same signatures rather than "already spent"; NUT-09
// restore of the stored blinded messages is the backstop.
//
// Stored with cashu-ts's own `serializeSwapPreview`, inside a version of ours:
// the library's form carries none, and a record read with the wrong meaning
// would send a request the mint has never seen, a fresh spend rather than a
// recovery. A P2PK witness is a BIP-340 signature over random aux data, so
// signing twice gives two different requests: inputs are signed once, before
// storage, and the replay never re-signs.

import {
  deserializeSwapPreview,
  serializeSwapPreview,
  type OutputDataLike,
  type SerializedSwapPreview,
  type SwapPreview,
} from "@cashu/cashu-ts";

// Bump if the stored shape changes meaning. A mismatched record is discarded,
// not half-read.
const SWAP_PREVIEW_VERSION = 2;

// A swap is a handful of proofs and outputs; anything this large is corruption.
const MAX_PREVIEW_ENTRIES = 512;

export interface StoredSwapPreview {
  v: number;
  preview: SerializedSwapPreview;
}

// Call BEFORE the request goes out and after any P2PK signing, or the replay
// will not reproduce the same request. `unselectedProofs` is not stored:
// cashu-ts only echoes it back, and those proofs never left our store.
export function storeSwapPreview(preview: SwapPreview): StoredSwapPreview {
  return { v: SWAP_PREVIEW_VERSION, preview: serializeSwapPreview(preview) };
}

// Null when the record cannot be trusted. Not a log-and-move-on path: the
// value that swap carried must be recovered another way, and the caller
// decides how.
export function rebuildSwapPreview(stored: unknown): SwapPreview | null {
  if (!isStoredSwapPreview(stored)) return null;
  try {
    const preview = deserializeSwapPreview(stored.preview);
    if (preview.inputs.length === 0) return null;
    if (swapPreviewOutputs(preview).length === 0) return null;
    return preview;
  } catch {
    // A non-canonical blinding factor, a malformed secret or an amount that
    // does not parse.
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
  const preview = record.preview as Partial<SerializedSwapPreview> | undefined;
  if (typeof preview !== "object" || preview === null) return false;
  if (!isBoundedArray(preview.inputs)) return false;
  for (const outputs of [preview.keepOutputs, preview.sendOutputs]) {
    if (outputs !== undefined && !isBoundedArray(outputs)) return false;
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
