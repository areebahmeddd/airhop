/**
 * @jest-environment node
 */
// bitchat's favourite notice travels as private-message text, so anything this
// misses lands in a thread as a bubble reading "[FAVORITED]:npub1...".

import { isFavoriteControl } from "../favorite-control";

describe("isFavoriteControl", () => {
  it("matches both notices, with or without the npub", () => {
    expect(isFavoriteControl("[FAVORITED]:npub1qqqqqqqq")).toBe(true);
    expect(isFavoriteControl("[UNFAVORITED]:npub1qqqqqqqq")).toBe(true);
    expect(isFavoriteControl("[FAVORITED]")).toBe(true);
    expect(isFavoriteControl("[UNFAVORITED]:")).toBe(true);
  });

  it("matches after surrounding whitespace, as bitchat-android does", () => {
    expect(isFavoriteControl("  [FAVORITED]:npub1qqqqqqqq\n")).toBe(true);
  });

  it("leaves ordinary messages alone", () => {
    expect(isFavoriteControl("I FAVORITED your post")).toBe(false);
    expect(isFavoriteControl("[favorited]")).toBe(false);
    expect(isFavoriteControl("see [FAVORITED] below")).toBe(false);
    expect(isFavoriteControl("")).toBe(false);
  });
});
