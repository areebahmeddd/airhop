// The attachment cache: every file written for a message, sent or received, and
// each way one leaves again (the received-media quota, a row that no longer
// points at it, the age sweep, Storage's Clear and the panic wipe).
//
// Kept apart from file-transfer-service, which runs the retention schedule on
// each receive: the schedule sweeps this cache, so in one file the two would
// import each other.

import { subscribeRemovedMessages, useChatStore } from "@store/chat-store";
import { safeFileName } from "@utils/safe-file-name";
import * as FileSystem from "expo-file-system";
import { Platform } from "react-native";

// Only the attachment cache files Airhop writes carry this prefix, so a
// directory sweep never touches anything else in the shared cache dir. Exported
// because anything else that generates an attachment file (see
// image-compression) has to land under the same prefix, or the Storage screen
// would report a size that its Clear button cannot free.
//
// The prefix bounds the ROUTINE sweeps (sweepExpiredAttachments,
// getAttachmentCacheBytes and clearAttachmentCache) and deliberately not the
// panic wipe, which empties the directory outright. Everything sent is adopted
// under it before it goes (see adoptIntoAttachmentCache), so what sits outside
// is a picker copy of something never sent, left by a crash, and the saved QR
// card. That is the right trade for a "free up space" button, which must not
// reach into directories the OS manages, and the wrong one for a wipe, which
// must. See wipeCacheDirectory.
export const CACHE_FILE_PREFIX = "airhop_";

// Received files, apart from sent ones, so the quota below counts only what
// others put on this phone. Under CACHE_FILE_PREFIX, so the sweeps, Storage and
// Clear treat them like any other attachment.
export const INCOMING_FILE_PREFIX = `${CACHE_FILE_PREFIX}in_`;

// The most received media kept on disk, bitchat-ios's defaultQuotaBytes
// (BLEIncomingFileStore). Retention is the age bound and this the size bound;
// whichever is reached first wins. Without it anyone who announces once could
// fill the phone's storage, a 1 MiB file at a time.
export const INCOMING_QUOTA_BYTES = 100 * 1024 * 1024;

// Make room for a received file of `reservingBytes` by deleting the oldest
// received files first, as bitchat-ios does before every save. Sent files are
// never touched: the person chose to keep those. A file that is evicted shows
// as no longer on this device, the same as one retention removed.
export function enforceIncomingQuota(reservingBytes: number): void {
  const dir = new FileSystem.Directory(FileSystem.Paths.cache);
  if (!dir.exists) return;
  const received = dir
    .list()
    .filter(
      (entry): entry is FileSystem.File =>
        entry instanceof FileSystem.File &&
        entry.name.startsWith(INCOMING_FILE_PREFIX),
    );
  let used = received.reduce((sum, file) => sum + file.size, 0);
  if (used + reservingBytes <= INCOMING_QUOTA_BYTES) return;
  // An unreadable age sorts first: it can only be older than one we can read.
  const writtenAt = (file: FileSystem.File): number =>
    file.lastModified ?? file.creationTime ?? 0;
  received.sort((a, b) => writtenAt(a) - writtenAt(b));
  for (const file of received) {
    if (used + reservingBytes <= INCOMING_QUOTA_BYTES) return;
    const size = file.size;
    try {
      file.delete();
      used -= size;
    } catch {
      // Open elsewhere, or already gone. The next one goes instead.
    }
  }
}

// Distinguishes two files adopted inside the same millisecond.
let adoptSeq = 0;

// Move a locally produced file into the attachment cache under the prefix, and
// return where it landed. Used for everything sent: the image resizer, the voice
// recorder, and the pickers' copies of a document, a video or a photo sent as
// it is, all of which land elsewhere by default.
//
// The prefix is what `sweepExpiredAttachments`, `getAttachmentCacheBytes` and
// `clearAttachmentCache` match on, so a file outside it outlives the retention
// window, is missing from the Storage total, and cannot be cleared.
//
// Best-effort: on failure the original path is returned and stays usable.
export async function adoptIntoAttachmentCache(
  uri: string,
  name: string,
): Promise<string> {
  try {
    adoptSeq += 1;
    const safeName = safeFileName(name);
    const destination = new FileSystem.File(
      FileSystem.Paths.cache,
      `${CACHE_FILE_PREFIX}${String(Date.now())}_${String(adoptSeq)}_${safeName}`,
    );
    await new FileSystem.File(uri).move(destination);
    return destination.uri;
  } catch {
    return uri;
  }
}

// Delete a file that will not be sent: the picker's, the resizer's or the
// recorder's, adopted or not. Only a file under the cache directory: a URI
// anywhere else is not ours to remove.
export function discardPickerCopy(uri: string): void {
  try {
    if (!uri.startsWith(FileSystem.Paths.cache.uri)) return;
    const file = new FileSystem.File(uri);
    if (file.exists) file.delete();
  } catch {
    // Already gone. The wipe takes whatever a failure leaves.
  }
}

// ---- Files no message points at ----
//
// Leaving, clearing or trimming a conversation removes rows, and a row's
// attachment would otherwise stay on disk until the retention sweep, days
// later, behind a confirmation that said its history was removed.

// Attachment files still in use outside any row, by URI, with a count of
// holds. A send reads its file after the row is added, a forward transcodes
// another row's file, and a receive writes its file before the row exists; a
// row that goes meanwhile must not take the file from under any of them.
const heldFiles = new Map<string, number>();
// Held files whose last row went while they were held, checked again on
// release.
const recheckOnRelease = new Set<string>();

// Keep `uri` from deleteUnreferencedAttachments until the returned function
// runs. Running it again does nothing.
export function holdAttachmentFile(uri: string): () => void {
  heldFiles.set(uri, (heldFiles.get(uri) ?? 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const count = (heldFiles.get(uri) ?? 1) - 1;
    if (count > 0) {
      heldFiles.set(uri, count);
      return;
    }
    heldFiles.delete(uri);
    if (recheckOnRelease.delete(uri)) deleteUnreferencedAttachments([uri]);
  };
}

// A file this app wrote into the attachment cache: directly in the cache
// directory and under CACHE_FILE_PREFIX. A row may point anywhere else (a
// document a failed adopt left where the picker put it), and nothing else is
// ours to delete.
function isAttachmentCacheUri(uri: string): boolean {
  const root = FileSystem.Paths.cache.uri;
  if (!uri.startsWith(root)) return false;
  const name = uri.slice(root.length).replace(/^\/+/, "");
  return !name.includes("/") && name.startsWith(CACHE_FILE_PREFIX);
}

// Delete the attachment files among `uris` that no remaining message in any
// channel references, and return how many went.
//
// Counted across every channel, since rows share files: a forward keeps its
// source's URI, and a finished live stream's row takes over the sender's file.
// A held file is skipped and checked again when released.
export function deleteUnreferencedAttachments(uris: Iterable<string>): number {
  const candidates = new Set<string>();
  for (const uri of uris) {
    if (isAttachmentCacheUri(uri)) candidates.add(uri);
  }
  if (candidates.size === 0) return 0;
  for (const list of Object.values(useChatStore.getState().messages)) {
    for (const m of list) {
      if (m.attachment !== undefined) candidates.delete(m.attachment.uri);
    }
  }
  let deleted = 0;
  for (const uri of candidates) {
    if (heldFiles.has(uri)) {
      recheckOnRelease.add(uri);
      continue;
    }
    try {
      const file = new FileSystem.File(uri);
      if (file.exists) {
        file.delete();
        deleted++;
      }
    } catch {
      // Open elsewhere, or already gone. The retention sweep takes it.
    }
  }
  return deleted;
}

let cleanupStarted = false;

// Delete a row's files once the row is gone and nothing else points at them,
// for every way a row leaves the chat store: a removed message, a cleared or
// left conversation, the 200-message trim and disappearing messages. Started
// with the app and with the boot start; a second call does nothing.
export function startAttachmentCleanup(): void {
  if (cleanupStarted) return;
  cleanupStarted = true;
  subscribeRemovedMessages((removed) => {
    const uris: string[] = [];
    for (const m of removed) {
      if (m.attachment !== undefined) uris.push(m.attachment.uri);
    }
    if (uris.length > 0) deleteUnreferencedAttachments(uris);
  });
}

// iOS keeps two copies the cache never sees, both under tmp: the system hands
// a picked document over as a copy in `tmp/<bundle id>-Inbox` before the picker
// copies it again, and a recorded video stays in tmp after the picker copies it
// out. Android has neither.
function temporaryDirectory(): FileSystem.Directory | null {
  if (Platform.OS !== "ios") return null;
  try {
    const tmp = new FileSystem.Directory(
      FileSystem.Paths.document.parentDirectory,
      "tmp",
    );
    return tmp.exists ? tmp : null;
  } catch {
    return null;
  }
}

// Those two copies: tmp's top-level files and the system's document Inbox,
// nothing deeper, since other libraries keep work in flight in tmp's other
// directories. Empty on Android.
function temporaryLeftovers(): FileSystem.File[] {
  const tmp = temporaryDirectory();
  if (tmp === null) return [];
  const files: FileSystem.File[] = [];
  for (const entry of tmp.list()) {
    if (entry instanceof FileSystem.File) {
      files.push(entry);
    } else if (entry.name.endsWith("-Inbox")) {
      for (const inner of entry.list()) {
        if (inner instanceof FileSystem.File) files.push(inner);
      }
    }
  }
  return files;
}

// What the Storage screen reports and Clear removes: every attachment under
// the prefix, and on iOS the copies above.
function attachmentFiles(): FileSystem.File[] {
  const dir = new FileSystem.Directory(FileSystem.Paths.cache);
  const cached = dir.exists
    ? dir
        .list()
        .filter(
          (entry): entry is FileSystem.File =>
            entry instanceof FileSystem.File &&
            entry.name.startsWith(CACHE_FILE_PREFIX),
        )
    : [];
  return [...cached, ...temporaryLeftovers()];
}

export function getAttachmentCacheBytes(): number {
  return attachmentFiles().reduce((sum, file) => sum + file.size, 0);
}

// How long a received or sent attachment stays on disk by default: seven days,
// matching bitchat's media retention sweep. The person can choose 14 or 30 in
// General (settings-store's mediaRetentionDays), and the received-media quota
// above can remove a file sooner. Files sit in the OS cache directory, which
// the system may reclaim under storage pressure, but that is not a retention
// guarantee anyone should rely on.
//
// Seven days is long enough that a thread stays browsable across a week away
// from signal, and short enough that a seized phone is not an archive.
export const MEDIA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Most files removed in one pass.
//
// Each delete is a synchronous native call, and this runs at launch, so an
// unbounded sweep over a very large cache would show up as a slow start. The
// bound is safe rather than a silent truncation: the sweep is idempotent and
// runs every launch, so a backlog drains over the next few starts and the
// oldest files still go first in wall-clock terms because nothing older is
// being created behind them.
const MAX_SWEEP_DELETIONS = 200;

// The time a sent file was put under the prefix, which adoptIntoAttachmentCache
// (and a live burst's note) writes into its name.
const ADOPTED_AT = new RegExp(`^${CACHE_FILE_PREFIX}(\\d+)_`);

// When a file reached this device. An adopted file is moved, and a move keeps
// the source's modification time, so a document picked on iOS would otherwise
// carry the date it was written and expire the moment it was sent.
function writtenAtMs(entry: FileSystem.File): number | null {
  const adopted = ADOPTED_AT.exec(entry.name);
  if (adopted !== null) return Number(adopted[1]);
  return entry.lastModified ?? entry.creationTime ?? null;
}

// Bytes freed by deleting `entry` if it is older than the window, or null when
// it stays.
function deleteIfExpired(
  entry: FileSystem.File,
  now: number,
  maxAgeMs: number,
): number | null {
  const writtenAt = writtenAtMs(entry);
  if (writtenAt === null) return null;
  // A timestamp in the future is a clock that moved, not a fresh file. Left
  // alone: deleting on a bad clock is the worse failure of the two.
  if (now - writtenAt <= maxAgeMs) return null;
  const size = entry.size;
  try {
    entry.delete();
    return size;
  } catch {
    // Mid-write, locked, or already gone. It will be caught next launch.
    return null;
  }
}

// Delete attachments older than the window. Returns the bytes freed.
//
// Covers outgoing as well as incoming: both are written under the same prefix,
// and a photo you sent is exactly as sensitive as one you received. Scheduled by
// services/media-retention: at launch, and throttled on each return to the app
// and each received file, since a foreground service can keep the process alive
// for weeks.
//
// A file whose age cannot be read is kept. The alternative is deleting user
// content on the strength of a missing timestamp.
export function sweepExpiredAttachments(
  now: number = Date.now(),
  maxAgeMs: number = MEDIA_MAX_AGE_MS,
): number {
  let freed = 0;
  let deleted = 0;
  for (const file of attachmentFiles()) {
    if (deleted >= MAX_SWEEP_DELETIONS) break;
    const size = deleteIfExpired(file, now, maxAgeMs);
    if (size === null) continue;
    freed += size;
    deleted++;
  }
  return freed;
}

export function clearAttachmentCache(): number {
  let freed = 0;
  for (const file of attachmentFiles()) {
    const size = file.size;
    try {
      file.delete();
      freed += size;
    } catch {
      // Best-effort: skip files that are mid-write or already gone.
    }
  }
  return freed;
}

// Empty the whole cache directory, for the panic wipe alone.
//
// clearAttachmentCache above deletes only files carrying our own prefix (and
// the iOS tmp copies), which is right for a "free up space" button and wrong
// for a wipe, because files the user would expect to be destroyed do not
// match it:
//
//   * the pickers' copies of anything picked and never sent, which sit in
//     their own subdirectories under the user's own filenames.
//   * the saved QR card, `airhop-qr-<peerID>.png`: a hyphen, not the prefix's
//     underscore, and a PNG of the identity's full contact card named after
//     its peer ID.
//
// Everything under the cache directory belongs to this app and is by definition
// regenerable, so a wipe should take all of it rather than chase prefixes that
// will drift again the next time an attachment path is added. Recursive, and
// best-effort per entry: one locked file must not abort the rest.
//
// Async on purpose, not incidentally. See WIPE_YIELD_EVERY.
export async function wipeCacheDirectory(): Promise<void> {
  const dir = new FileSystem.Directory(FileSystem.Paths.cache);
  if (!dir.exists) return;
  // The root is emptied, not removed. It is where the next attachment lands,
  // and a wipe that deletes it outright leaves the first write after
  // re-onboarding to fail on a directory nothing recreated.
  const progress = { deleted: 0 };
  await emptyDirectory(dir, progress, 0);
  // iOS tmp holds the pickers' other copies (see temporaryDirectory). A wipe
  // takes all of it; nothing of the app's own is mid-write while one runs.
  const tmp = temporaryDirectory();
  if (tmp !== null) await emptyDirectory(tmp, progress, 0);
}

// How many entries to remove before handing the thread back.
//
// Every File and Directory call in expo-file-system is synchronous, so an
// unbroken walk owns the JS thread: no frame drawn, no touch handled, no timer
// fired until it returns. Over a whole cache directory that is long enough to
// read as a hung app. sweepExpiredAttachments bounds itself for the same reason.
//
// Roughly one frame of synchronous deletes. Bounds how long the thread is held,
// not how much is destroyed: no entry is skipped.
const WIPE_YIELD_EVERY = 32;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// How deep the walk goes before handing a subtree to a single delete.
//
// Far past a real cache tree, which is flat. An unbounded recursive walk is one
// directory cycle away from a stack overflow, and a throw out of here leaves the
// wipe marker set, replaying the wipe on every launch thereafter.
//
// Falls back rather than skips: past this depth one `delete()` takes the
// subtree, so only the yielding stops.
const WIPE_MAX_DEPTH = 8;

// Depth-first, rather than handing a subdirectory to one `delete()`: the
// expensive case is a directory of thousands of files, and deleting it as one
// call is one synchronous operation with nowhere to yield inside. Costs one
// extra listing per directory.
async function emptyDirectory(
  dir: FileSystem.Directory,
  progress: { deleted: number },
  depth: number,
): Promise<void> {
  let entries: (FileSystem.Directory | FileSystem.File)[];
  try {
    entries = dir.list();
  } catch {
    // Unreadable, or reclaimed by the OS mid-walk.
    return;
  }
  for (const entry of entries) {
    // Emptied first, so its own delete below is the cheap case. Past
    // WIPE_MAX_DEPTH that delete does the recursion instead.
    if (entry instanceof FileSystem.Directory && depth < WIPE_MAX_DEPTH) {
      await emptyDirectory(entry, progress, depth + 1);
    }
    try {
      entry.delete();
    } catch {
      // Mid-write, already gone, or not ours to remove.
    }
    progress.deleted++;
    if (progress.deleted % WIPE_YIELD_EVERY === 0) await yieldToEventLoop();
  }
}
