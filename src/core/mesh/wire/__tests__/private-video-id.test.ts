// Airhop's stable ID for a private video note or clip. The vectors pin the
// derivation, since a change breaks receipts between Airhop builds; the guards
// pin which names get one, since a name bitchat also writes must never be
// deduplicated on less entropy than a UUID.

import { videoClipName, videoNoteName } from "../file-packet";
import { privateMediaStableID } from "../private-media-id";
import { privateVideoStableID } from "../private-video-id";

const ALICE = "0011223344556677";
const BOB = "8899aabbccddeeff";
const UUID = "9f8e7d6c-5b4a-4938-8271-6f5e4d3c2b1a";

describe("privateVideoStableID", () => {
  // Computed independently: the same length-prefixed fields as bitchat's media
  // ID, under the domain "airhop-private-video-message-v1".
  it("matches the version-one vectors", () => {
    expect(privateVideoStableID(ALICE, BOB, `note_${UUID}.mp4`)).toBe(
      "media-a90160591606be55d4609ee038c37a10",
    );
    expect(privateVideoStableID(ALICE, BOB, `clip_${UUID}.mp4`)).toBe(
      "media-62a5f84478c03ef9a8597dd9781605d3",
    );
    expect(privateVideoStableID(BOB, ALICE, `note_${UUID}.mp4`)).toBe(
      "media-9f82761b2543e33f16173201fe949450",
    );
  });

  it("gives every name Airhop writes an ID", () => {
    expect(privateVideoStableID(ALICE, BOB, videoNoteName())).not.toBeNull();
    expect(privateVideoStableID(ALICE, BOB, videoClipName())).not.toBeNull();
  });

  it("reads peer IDs case-insensitively", () => {
    const name = `note_${UUID}.mp4`;
    expect(privateVideoStableID(ALICE, BOB.toUpperCase(), name)).toBe(
      privateVideoStableID(ALICE, BOB, name),
    );
  });

  it("never yields a bitchat media ID for the same name", () => {
    const name = `note_${UUID}.mp4`;
    expect(privateMediaStableID(ALICE, BOB, name)).toBeNull();
    // And a photo or voice note stays bitchat's alone.
    expect(privateVideoStableID(ALICE, BOB, `img_${UUID}.jpg`)).toBeNull();
    expect(privateVideoStableID(ALICE, BOB, `voice_${UUID}.m4a`)).toBeNull();
  });

  it.each([
    ["no name", undefined],
    ["an empty name", ""],
    // bitchat's clip names: 32 bits would let two distinct clips collide.
    ["a bitchat clip", "clip_1a2b3c4d.mp4"],
    ["a bitchat clip in upper case", "clip_1A2B3C4D.mp4"],
    ["a receiver's renamed repeat", `note_${UUID} (1).mp4`],
    ["a finished live stream", "video_0011223344556677.mp4"],
    ["another container", `clip_${UUID}.mov`],
    ["an upper-case UUID", `note_${UUID.toUpperCase()}.mp4`],
    ["a path", `dir/note_${UUID}.mp4`],
    ["a stem with more after the UUID", `note_${UUID}_x.mp4`],
    ["a picked video's own name", "IMG_1234.mp4"],
  ])("gives %s no ID", (_label, name) => {
    expect(privateVideoStableID(ALICE, BOB, name)).toBeNull();
  });
});
