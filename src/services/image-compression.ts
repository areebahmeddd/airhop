// Fit a photo inside the 256 KiB send budget (MAX_SENT_IMAGE_BYTES) before it
// is sent.
//
// A phone camera produces several megabytes, and at Bluetooth's ~18 KiB/s even
// a file at the 512 KiB photo cap takes most of bitchat's 30-second assembly
// window (see MAX_SENT_IMAGE_BYTES). Every messenger resizes before sending for
// the same reason.
//
// It changes nothing on the wire. The result is an ordinary JPEG in an ordinary
// FILE_TRANSFER packet, so a bitchat peer sees a photo it already knew how to
// read. The only difference is that it now arrives.
//
// It is also what strips a photo's metadata. A JPEG or WebP is always
// re-encoded, however small: the Android picker copies the camera's EXIF, GPS
// included, into its output, and the encoder here writes pixels only
// (Bitmap.compress on Android, UIImage.jpegData on iOS). GIF and PNG that fit
// go as they are, since re-encoding would flatten an animation or blur a
// screenshot, and neither carries camera location in practice.
//
// Never throws. A GIF or PNG that cannot be resized still goes at its original
// size, where the size check in FileTransferService gives the sender a reason
// about their photo. Anything else that cannot be re-encoded is refused (null)
// rather than sent with the metadata the encode exists to strip.

import {
  MAX_SENT_IMAGE_BYTES,
  mimeMatchesMagic,
  resolveMimeType,
} from "@core/mesh/wire/file-packet";
import * as FileSystem from "expo-file-system";
import {
  ImageManipulator,
  SaveFormat,
  type SaveOptions,
} from "expo-image-manipulator";
import {
  adoptIntoAttachmentCache,
  discardPickerCopy,
} from "./file-transfer-service";

// Longest edge of a sent photo. 1600 is still worth looking at full screen on a
// phone, and is where WhatsApp and Signal settle; past it the extra pixels cost
// transfer minutes nobody sees.
const MAX_EDGE = 1600;

// Below this, JPEG artefacts are visible on a phone screen, so no rung goes
// under it however low the starting quality is. The edge shrinks instead.
const MIN_QUALITY = 0.3;

// Quality ladder, starting from the user's Upload quality setting. The first
// pass under budget wins, so an ordinary photo pays for one encode and only a
// stubborn one walks down the list. The lower rungs shrink the edge as well:
// past a point it is resolution costing the bytes, not the quality.
//
// Starting from the setting is what makes it mean something. Applied only to the
// picker, which this step then re-encodes over the top of, "High" and "Medium"
// produce the same file for exactly the photos big enough to care. Low starts
// lower and lands in one pass; High starts high, keeps more detail, and may take
// a pass or two to fit.
function attemptsFor(quality: number): { maxEdge: number; compress: number }[] {
  const step = (factor: number): number =>
    Math.max(MIN_QUALITY, Math.round(quality * factor * 100) / 100);
  return [
    { maxEdge: MAX_EDGE, compress: step(1) },
    { maxEdge: MAX_EDGE, compress: step(0.7) },
    { maxEdge: 1200, compress: step(0.6) },
    { maxEdge: 800, compress: step(0.6) },
  ];
}

export interface PreparedImage {
  uri: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
}

function fileSize(uri: string): number {
  try {
    const file = new FileSystem.File(uri);
    return file.exists ? file.size : 0;
  } catch {
    return 0;
  }
}

// Whether the file's own bytes agree with the type about to be declared for
// it. An unreadable file answers no, which only costs a re-encode attempt.
async function bytesMatchMime(uri: string, mimeType: string): Promise<boolean> {
  try {
    const bytes = await new FileSystem.File(uri).bytes();
    return mimeMatchesMagic(mimeType, bytes);
  } catch {
    return false;
  }
}

// Replace the extension, so a resized photo is not still called "IMG_1234.heic"
// once it is a JPEG. The receiver reads the type off the MIME, but the name is
// what a person sees in a document row and in a share sheet.
function jpegName(name: string | undefined): string {
  const base = (name ?? "photo").replace(/\.[^.]+$/, "");
  return `${base || "photo"}.jpg`;
}

// The formats sent untouched when they fit. Everything else is re-encoded.
const SENT_AS_IS = new Set(["image/gif", "image/png"]);

// Resize and re-encode until the file fits the image budget. Returns the
// original when it is a GIF or PNG that fits, or one that cannot be read, and
// null for any other image that cannot be re-encoded. Whatever is returned is
// moved under the attachment prefix and nothing else outlives the call, so
// retention and Clear account for what is sent.
export async function prepareImageForSend(
  uri: string,
  name?: string,
  mimeType?: string,
  // The user's Upload quality setting, 0-1. Sets where the ladder starts.
  quality = 0.7,
): Promise<PreparedImage | null> {
  const ready = await fitToBudget(uri, name, mimeType, quality);
  if (ready?.uri !== uri) discardPickerCopy(uri);
  if (ready === null) return null;
  return {
    ...ready,
    uri: await adoptIntoAttachmentCache(ready.uri, ready.name),
  };
}

async function fitToBudget(
  uri: string,
  name: string | undefined,
  mimeType: string | undefined,
  quality: number,
): Promise<PreparedImage | null> {
  const original: PreparedImage = {
    uri,
    // Resolved, never assumed. Defaulting an unlabelled file to image/jpeg
    // would put that on the wire for a PNG, and the receiver checks the
    // declared type against the file's magic bytes: it would have thrown the
    // photo away for lying about itself.
    mimeType: resolveMimeType(mimeType, name),
    name: name ?? "photo.jpg",
    sizeBytes: fileSize(uri),
  };
  // A GIF or PNG small enough goes as it is. HEIC, which an iPhone camera
  // produces and neither Airhop nor bitchat carries, resolves to octet-stream,
  // so it goes through the JPEG pass below and arrives as a photo.
  //
  // The type is also checked against the bytes. A caller may have renamed the
  // file (`.png` on a JPEG) and passed no usable type, so the type came from
  // the name; the receiver compares the declared type with the magic bytes and
  // drops a mismatch, so a mislabelled file is re-encoded into a JPEG that is
  // what it says.
  if (
    SENT_AS_IS.has(original.mimeType) &&
    original.sizeBytes > 0 &&
    original.sizeBytes <= MAX_SENT_IMAGE_BYTES &&
    (await bytesMatchMime(uri, original.mimeType))
  ) {
    return original;
  }
  // What goes out when no encode succeeds. Only the formats that may go as
  // they are: a JPEG or WebP carries the camera's EXIF, GPS included.
  const unencoded = SENT_AS_IS.has(original.mimeType) ? original : null;

  // Source dimensions, read once, so each attempt below is a single render.
  let sourceWidth: number;
  let sourceHeight: number;
  try {
    const probe = await ImageManipulator.manipulate(uri).renderAsync();
    sourceWidth = probe.width;
    sourceHeight = probe.height;
  } catch {
    return unencoded;
  }
  const longestEdge = Math.max(sourceWidth, sourceHeight);
  if (longestEdge <= 0) return unencoded;

  let best: PreparedImage | null = null;
  for (const attempt of attemptsFor(quality)) {
    try {
      const context = ImageManipulator.manipulate(uri);
      // Only ever scale down. Enlarging a small photo to the cap would add
      // bytes to something that was already fine. Width alone: the library
      // keeps the ratio, which avoids rounding the two edges apart.
      if (longestEdge > attempt.maxEdge) {
        const scale = attempt.maxEdge / longestEdge;
        context.resize({ width: Math.round(sourceWidth * scale) });
      }
      const options: SaveOptions = {
        compress: attempt.compress,
        format: SaveFormat.JPEG,
      };
      const rendered = await context.renderAsync();
      const saved = await rendered.saveAsync(options);
      const sizeBytes = fileSize(saved.uri);
      // Only the smallest render is kept, so if a harsher rung fails outright
      // there is still something better than the original. Every other one is
      // deleted, or it would count toward Storage with nothing pointing at it.
      if (sizeBytes <= 0 || (best !== null && sizeBytes >= best.sizeBytes)) {
        discardPickerCopy(saved.uri);
        continue;
      }
      if (best !== null) discardPickerCopy(best.uri);
      best = {
        uri: saved.uri,
        mimeType: "image/jpeg",
        name: jpegName(name),
        sizeBytes,
      };
      if (sizeBytes <= MAX_SENT_IMAGE_BYTES) return best;
    } catch {
      // Unreadable, unsupported, or out of memory. A harsher rung would fail
      // the same way, so stop here.
      break;
    }
  }

  // Nothing fit. Send the smallest version we managed and let the size check in
  // FileTransferService be the one to refuse it.
  return best ?? unencoded;
}
