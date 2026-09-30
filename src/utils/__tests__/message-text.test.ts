/** @jest-environment node */
// The rule: a row Airhop wrote is re-rendered in the language the reader has
// chosen, and a row a person wrote is never touched.
//
// The bug this guards is invisible in a screenshot. `t()` at write time produces
// the right string on the day it runs and stores it; it only goes wrong later,
// for a user who switches language and finds their history did not.

import { stripIsolates } from "@i18n";
import { en } from "@i18n/locales/en";
import type { ActivityEntry } from "@store/activity-store";
import type { ChatMessage } from "@store/chat-store";
import {
  activityPreview,
  messageText,
  systemPreview,
  systemRow,
  txErrorText,
  txFailure,
  txFailureVerbatim,
} from "../message-text";

function message(fields: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    channel: "#bluetooth",
    senderID: "0".repeat(16),
    senderNickname: "swift-otter",
    text: "",
    timestampMs: 0,
    isMine: false,
    ...fields,
  };
}

function entry(fields: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: "a1",
    channel: "#bluetooth",
    isDM: false,
    senderID: "0".repeat(16),
    senderNickname: "swift-otter",
    preview: "",
    timestampMs: 0,
    seen: false,
    ...fields,
  };
}

describe("messageText", () => {
  it("returns user content untouched", () => {
    // The common case, and the one that must never change.
    expect(messageText(message({ text: "meet me at the north gate" }))).toBe(
      "meet me at the north gate",
    );
  });

  it("falls back to the stored text for a system row with no key", () => {
    expect(
      messageText(message({ text: "Shared a place", isSystem: true })),
    ).toBe("Shared a place");
  });

  it("re-renders a system row from its key, ignoring the stored text", () => {
    // The stored text is deliberately wrong here. If the resolver ever reads it
    // in preference to the key, this is the assertion that notices.
    const row = message({
      text: "STALE, WRITTEN IN A LANGUAGE YOU NO LONGER READ",
      isSystem: true,
      systemKey: "chat.location.sent_summary",
    });
    // Against the catalog rather than a copy of the English, so rewording the
    // string does not fail a test about resolution.
    expect(messageText(row)).toBe(en.strings["chat.location.sent_summary"]);
    expect(messageText(row)).not.toBe(row.text);
  });

  it("interpolates the stored variables", () => {
    const row = message({
      text: "stale",
      isSystem: true,
      systemKey: "chat.group.you_were_added",
      systemVars: { name: "north gate crew" },
    });
    expect(messageText(row)).toContain("north gate crew");
  });

  it("re-renders a counted row through its plural", () => {
    // The count is stored as a variable and chooses the form on every render,
    // so the row agrees with its number in whichever language reads it.
    const row = message({
      text: "stale",
      isSystem: true,
      systemKey: "chat.board.urgent_many",
      systemVars: { count: 1200 },
    });
    expect(stripIsolates(messageText(row))).toBe(
      "1,200 new urgent notices · open Notices",
    );
  });
});

describe("activityPreview", () => {
  it("returns a stored preview when there is no key", () => {
    expect(activityPreview(entry({ preview: "see you there" }))).toBe(
      "see you there",
    );
  });

  it("re-renders from the key when there is one", () => {
    // Airhop's sentence is wrapped around a person's words (a group name, a
    // board notice's text). The wrapper may be re-rendered; the words inside
    // it may not.
    const row = entry({
      preview: "stale",
      previewKey: "chat.group.removed_you",
      previewVars: { name: "north gate crew" },
    });
    expect(activityPreview(row)).not.toBe("stale");
    expect(activityPreview(row)).toContain("north gate crew");
  });
});

// What gets stored, as opposed to what gets shown. `text` is the fallback for a
// row without the key fields, and the field the wire reads: `forwardMessage`
// puts it on the air. So the stored rendering is plain and the shown one carries
// the isolates.
describe("systemRow and systemPreview keep storage plain", () => {
  const ISOLATES = new RegExp(
    `[${String.fromCodePoint(0x2068)}${String.fromCodePoint(0x2069)}]`,
  );

  it("stores the key and its variables for a later render", () => {
    const row = systemRow("chat.group.you_were_added", { name: "north gate" });
    expect(row.systemKey).toBe("chat.group.you_were_added");
    expect(row.systemVars).toEqual({ name: "north gate" });
  });

  it("stores a rendering with no isolates in it", () => {
    const row = systemRow("chat.group.you_were_added", { name: "north gate" });
    expect(row.text).toContain("north gate");
    expect(ISOLATES.test(row.text)).toBe(false);
  });

  it("still renders WITH isolates, which is the point of stripping the stored copy", () => {
    const row = systemRow("chat.group.you_were_added", { name: "north gate" });
    expect(ISOLATES.test(messageText(message(row)))).toBe(true);
  });

  it("does the same for a bell entry", () => {
    const line = systemPreview("chat.group.removed_you", {
      name: "north gate",
    });
    expect(line.previewKey).toBe("chat.group.removed_you");
    expect(line.preview).toContain("north gate");
    expect(ISOLATES.test(line.preview)).toBe(false);
    expect(ISOLATES.test(activityPreview(entry(line)))).toBe(true);
  });

  it("takes a key with no variables", () => {
    const row = systemRow("chat.location.sent_summary");
    expect(row.systemVars).toBeUndefined();
    expect(row.text.length).toBeGreaterThan(0);
    expect(ISOLATES.test(row.text)).toBe(false);
  });
});

// A wallet row's reason, which outlives the language it was written in the same
// way a chat row does. A mint writes its own and that is never touched.
describe("txErrorText", () => {
  it("re-renders Airhop's reason from its key, ignoring the stored text", () => {
    const tx = {
      ...txFailure("wallet.svc.mint_lost"),
      error: "STALE, WRITTEN IN A LANGUAGE YOU NO LONGER READ",
    };
    expect(txErrorText(tx)).toBe(en.strings["wallet.svc.mint_lost"]);
  });

  it("shows a mint's text, and a row with no key, as written", () => {
    expect(txErrorText(txFailureVerbatim("Token already spent."))).toBe(
      "Token already spent.",
    );
    expect(txErrorText({ error: "an old row's reason" })).toBe(
      "an old row's reason",
    );
  });

  it("drops a mint's text over an earlier key", () => {
    const tx = {
      ...txFailure("wallet.svc.mint_lost"),
      ...txFailureVerbatim("quote expired"),
    };
    expect(txErrorText(tx)).toBe("quote expired");
  });

  it("reads a cleared reason as none, whatever key is left beside it", () => {
    expect(
      txErrorText({ ...txFailure("wallet.svc.mint_lost"), error: undefined }),
    ).toBeNull();
    expect(txErrorText({})).toBeNull();
  });
});
