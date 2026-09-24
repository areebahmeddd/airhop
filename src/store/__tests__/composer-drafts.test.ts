/**
 * @jest-environment node
 */
// Drafts outlive a thread's remount but nothing else: an empty save removes
// one, the cap drops the stalest, and a wipe leaves none.

import { clearDrafts, loadDraft, saveDraft } from "../composer-drafts";

beforeEach(() => {
  clearDrafts();
});

describe("composer drafts", () => {
  it("keeps a draft per conversation", () => {
    saveDraft("#mesh", "half a thought");
    saveDraft("dm:aabbccdd00112233", "see you at");
    expect(loadDraft("#mesh")).toBe("half a thought");
    expect(loadDraft("dm:aabbccdd00112233")).toBe("see you at");
    expect(loadDraft("group:00ff")).toBe("");
  });

  it("forgets a draft once it is sent or emptied", () => {
    saveDraft("#mesh", "sending this");
    saveDraft("#mesh", "");
    expect(loadDraft("#mesh")).toBe("");
  });

  it("caps a pasted wall of text", () => {
    saveDraft("#mesh", "x".repeat(20_000));
    expect(loadDraft("#mesh")).toHaveLength(8_000);
  });

  it("drops the draft left alone longest once 64 are held", () => {
    for (let i = 0; i < 64; i++) saveDraft(`#c${String(i)}`, "draft");
    // Touching the oldest makes it the newest, so #c1 goes instead.
    saveDraft("#c0", "still typing");
    saveDraft("#c64", "one more");
    expect(loadDraft("#c0")).toBe("still typing");
    expect(loadDraft("#c1")).toBe("");
    expect(loadDraft("#c64")).toBe("one more");
  });

  it("leaves nothing after a wipe", () => {
    saveDraft("#mesh", "secret");
    clearDrafts();
    expect(loadDraft("#mesh")).toBe("");
  });
});
