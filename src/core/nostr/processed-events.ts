// Inbound deliveries already acted on, kept across launches. Relays replay an
// inbox's whole lookback on every subscribe, so without a record that outlives
// the process each launch opens, files and acknowledges the week again: a
// burst of DELIVERED acks that tells every sender we are online, and a thread
// the user deleted reappearing. bitchat-ios keeps the same record
// (NostrProcessedEventStore) for the same reason.
//
// Keyed by whatever names one delivery: a gift wrap's event ID, so a sender's
// retry (a new wrap) is still acknowledged, or for courier mail the sender's
// message ID, since spray-and-wait sends one message in many envelopes.
//
// One MMKV key per ID holding when it was recorded, so recording costs one
// small write rather than rewriting the set. The IDs are public, but which
// ones this phone opened says who writes to it, so the partition is in
// MMKV_STORE_IDS and a panic wipe clears it.
//
// An ID reaches disk a little after the row it filed. The chat store holds a
// new message back for its own persist throttle, and an ID on disk before the
// row would, after a kill in between, have the next launch skip a message it
// never kept. Late the other way costs only opening the delivery again after
// such a kill, and acknowledging it a second time.

import { getStorage } from "@store/mmkv";

export const PROCESSED_EVENTS_STORAGE_ID = "nostr-processed-events";

// Each kind of inbox keeps at most this many. Well past any honest lookback's
// volume; evicting the oldest costs at most one reopen of an old delivery.
const MAX_IDS = 5_000;

// Past the lookback, a wrap's created_at may sit 15 minutes either side of
// when it was recorded, so a relay can still replay it that much longer.
const RETAIN_MARGIN_MS = 60 * 60 * 1000;

// Longer than chat-store's 400 ms PERSIST_THROTTLE_MS, so the row lands first.
const PERSIST_DELAY_MS = 1_000;

// Recorded IDs not yet written, storage key to the recording time, shared by
// every inbox so one timer covers them all.
const unwritten = new Map<string, string>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;
// Moved by a panic wipe. An instance built before it never writes again: the
// partition it would write to has just been erased.
let wipeGeneration = 0;

// Write every recorded ID now. For the app leaving the foreground and the mesh
// stopping, after which the timer may never run.
export function flushProcessedEvents(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (unwritten.size === 0) return;
  const storage = getStorage(PROCESSED_EVENTS_STORAGE_ID);
  for (const [key, at] of unwritten) storage.set(key, at);
  unwritten.clear();
}

// For the panic wipe, before the partition is cleared: nothing recorded
// before it reaches disk, now or later.
export function dropPendingProcessedEvents(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  unwritten.clear();
  wipeGeneration++;
}

export class ProcessedEvents {
  private readonly storage = getStorage(PROCESSED_EVENTS_STORAGE_ID);
  private readonly prefix: string;
  private readonly retainMs: number;
  private readonly generation = wipeGeneration;
  // ID to when it was recorded, oldest first.
  private readonly ids = new Map<string, number>();

  // `kind` keeps one inbox's IDs apart from another's in the shared partition;
  // `lookbackSeconds` is how far back that inbox's relays replay.
  constructor(kind: string, lookbackSeconds: number) {
    this.prefix = `${kind}:`;
    this.retainMs = lookbackSeconds * 1000 + RETAIN_MARGIN_MS;
    this.load();
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    if (this.ids.has(id)) return;
    const now = Date.now();
    this.ids.set(id, now);
    if (this.generation === wipeGeneration) {
      unwritten.set(this.prefix + id, String(now));
      writeTimer ??= setTimeout(flushProcessedEvents, PERSIST_DELAY_MS);
    }
    this.trim();
  }

  private load(): void {
    const cutoff = Date.now() - this.retainMs;
    const kept: [string, number][] = [];
    for (const key of this.storage.getAllKeys()) {
      if (!key.startsWith(this.prefix)) continue;
      const at = Number(this.storage.getString(key));
      if (!Number.isFinite(at) || at < cutoff) {
        this.storage.remove(key);
        continue;
      }
      kept.push([key.slice(this.prefix.length), at]);
    }
    // Recorded by an instance this one replaces and not yet written.
    for (const [key, at] of unwritten) {
      if (key.startsWith(this.prefix)) {
        kept.push([key.slice(this.prefix.length), Number(at)]);
      }
    }
    kept.sort((a, b) => a[1] - b[1]);
    for (const [id, at] of kept) this.ids.set(id, at);
    this.trim();
  }

  private trim(): void {
    for (const oldest of this.ids.keys()) {
      if (this.ids.size <= MAX_IDS) break;
      this.forget(oldest);
    }
  }

  private forget(id: string): void {
    this.ids.delete(id);
    if (this.generation !== wipeGeneration) return;
    unwritten.delete(this.prefix + id);
    this.storage.remove(this.prefix + id);
  }
}
