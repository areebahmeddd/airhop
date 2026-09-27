/**
 * @jest-environment node
 */
// bitchat's stable private-media ID. The vectors are the contract: a mismatch
// by one byte means no photo or voice note ever shows delivered between the
// two apps, in either direction.

import { privateMediaStableID } from "../private-media-id";

const ALICE = "0011223344556677";
const BOB = "8899aabbccddeeff";
const IOS_NAME = "img_20260725_105708_1CC2760D-76AA-40C3-8013-C7FAA6C2EF99.jpg";

describe("privateMediaStableID", () => {
  it("matches bitchat-ios's version-one golden vector", () => {
    expect(privateMediaStableID(ALICE, BOB, IOS_NAME)).toBe(
      "media-910bd42c65060ab76bb6406f220c4516",
    );
  });

  // Computed independently from the Swift derivation (length-prefixed fields
  // under the domain string, SHA-256, first 32 hex digits).
  it("matches vectors for the other accepted shapes and the other direction", () => {
    expect(privateMediaStableID(ALICE, BOB, "voice_0011223344556677.m4a")).toBe(
      "media-756ddf7537044ecd6c2bd95514a49c08",
    );
    expect(
      privateMediaStableID(
        "aabbccdd00112233",
        "1122334455667788",
        "voice_9f8e7d6c-5b4a-4938-8271-6f5e4d3c2b1a.m4a",
      ),
    ).toBe("media-c37ee48a2e6a099f5f2b83aeda051460");
    expect(privateMediaStableID(BOB, ALICE, IOS_NAME)).toBe(
      "media-727b85111e0d70f1b50a60aec107c51f",
    );
  });

  it("reads peer IDs case-insensitively, as bitchat normalises them", () => {
    expect(privateMediaStableID(ALICE, BOB.toUpperCase(), IOS_NAME)).toBe(
      privateMediaStableID(ALICE, BOB, IOS_NAME),
    );
  });

  it("accepts a JPEG extension in either spelling and case", () => {
    const uuid = "11111111-1111-1111-1111-111111111111";
    expect(privateMediaStableID(ALICE, BOB, `img_${uuid}.jpeg`)).not.toBeNull();
    expect(privateMediaStableID(ALICE, BOB, `img_${uuid}.JPG`)).not.toBeNull();
  });

  it.each([
    ["no name", undefined],
    ["an empty name", ""],
    ["a name without entropy", "photo.jpg"],
    [
      "a photo that is not a JPEG",
      "img_11111111-1111-1111-1111-111111111111.png",
    ],
    [
      "a document under a photo stem",
      "img_11111111-1111-1111-1111-111111111111.pdf",
    ],
    ["a voice note that is not m4a", "voice_0011223344556677.aac"],
    ["a burst ID of the wrong length", "voice_00112233445566.m4a"],
    ["a photo named with a burst ID", "img_0011223344556677.jpg"],
    ["a path", "dir/img_11111111-1111-1111-1111-111111111111.jpg"],
    ["a timestamp-only name", "img_20260725_105708.jpg"],
  ])("gives %s no stable ID", (_label, name) => {
    expect(privateMediaStableID(ALICE, BOB, name)).toBeNull();
  });
});
