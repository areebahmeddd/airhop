// A file name a peer or a picker chose, made safe to put on disk.
//
// The name ends up as the last segment of a cache path and as the name a share
// sheet or a player shows, so it has to be a single segment and nothing more,
// while still reading in the script it was written in: `報告書.pdf` must not
// arrive as `___.pdf`. Letters, marks and digits of every script survive, NFC
// first so a decomposed accent is one letter rather than a letter and a stray
// mark. Everything else becomes `_`: separators, controls, bidi and zero-width
// characters (none is a letter), so the name cannot climb out of its directory
// or read differently from what it is. A dot run is folded to one, so `..`
// never appears.

import { truncateToUtf8Bytes } from "./utf8-budget";

// A name lives inside `<prefix><ms>_`, which uses about 30 of the 255 bytes a
// file name may have on ext4 and APFS; 128 leaves room for the extension the
// receiver may append and still holds some 40 characters of CJK.
const MAX_FILE_NAME_BYTES = 128;

const UNSAFE = /[^\p{L}\p{M}\p{N}._-]/gu;

export function safeFileName(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(UNSAFE, "_")
    .replace(/\.{2,}/g, ".");
  return truncateToUtf8Bytes(cleaned, MAX_FILE_NAME_BYTES);
}
