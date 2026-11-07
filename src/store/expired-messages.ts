// The IDs of direct messages the disappearing-messages setting removed, so a
// resend cannot bring one back.
//
// Receive dedup is "is this ID still in the thread", and a sender whose
// DELIVERED went missing resends the same ID from its outbox for up to
// OUTBOX_TTL_MS. Without this record, an expired message would return as new,
// with a fresh arrival time and a notification. chat-store writes it as a sweep
// removes rows and reads it in addMessage, which refuses the resend; the
// receive path still acknowledges it, so the sender stops.
//
// Kept like the Nostr inbox records (core/nostr/processed-events): one MMKV key
// per ID, bounded in count and age, in a partition the panic wipe clears. A week
// past the removal covers the longest a sender's outbox keeps trying, plus that
// record's margin.

import { ProcessedEvents } from "@core/nostr/processed-events";
import { OUTBOX_TTL_MS } from "./outbox-store";

// Opened on first use, since loading reads the partition's keys.
let record: ProcessedEvents | null = null;

function expired(): ProcessedEvents {
  record ??= new ProcessedEvents("expired-dm", OUTBOX_TTL_MS / 1000);
  return record;
}

export function rememberExpiredMessages(ids: Iterable<string>): void {
  for (const id of ids) expired().add(id);
}

export function wasExpiredMessage(id: string): boolean {
  return expired().has(id);
}

// With chat-store's clearAll, the panic wipe: the partition is cleared there,
// and the copy in memory goes here, so the next identity starts with none.
export function forgetExpiredMessages(): void {
  record = null;
}
