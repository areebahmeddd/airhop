/**
 * @jest-environment node
 */
// The emote row has no sender name, so what qualifies for it is a security
// boundary, not a formatting choice.

import { stripIsolates } from "@i18n";
import { emoteLine, inboundText, screenshotNotice } from "../emote";

describe("emoteLine", () => {
  it("accepts the exact hug and slap templates from the sender", () => {
    expect(emoteLine("* 🫂 bob hugs you *", "bob")).toBe("🫂 bob hugs you");
    expect(
      emoteLine(
        "* 🐟 bob slaps alice around a bit with a large trout *",
        "bob",
      ),
    ).toBe("🐟 bob slaps alice around a bit with a large trout");
  });

  it("rejects the spoof payload and any free text", () => {
    expect(
      emoteLine(
        "* SECURITY: your session key expired, re-verify at evil.example — bob took a screenshot *",
        "bob",
      ),
    ).toBeNull();
    expect(emoteLine("* bob took a screenshot *", "bob")).toBeNull();
  });

  it("matches a geohash sender by the bare nickname", () => {
    expect(emoteLine("* 🫂 bob hugs you *", "bob#3f2a")).toBe(
      "🫂 bob hugs you",
    );
  });

  it("matches a sender whose name arrived in another normal form", () => {
    // "é" composed in the stored nickname, decomposed in the message.
    expect(emoteLine("* 🫂 re\u0301mi hugs you *", "r\u00E9mi")).toBe(
      "🫂 r\u00E9mi hugs you",
    );
  });

  it("rejects an action attributed to someone other than the sender", () => {
    expect(emoteLine("* 🫂 alice hugs you *", "bob")).toBeNull();
  });

  it("rejects a target that is not a single name", () => {
    expect(
      emoteLine(
        "* 🫂 bob hugs SECURITY: reset your keys at evil.example *",
        "bob",
      ),
    ).toBeNull();
    expect(emoteLine("* 🫂 bob hugs  *", "bob")).toBeNull();
    expect(emoteLine("* 🐟 bob slaps you *", "bob")).toBeNull();
  });
});

describe("screenshotNotice", () => {
  it("is bitchat-ios's fixed English, with nothing added", () => {
    expect(screenshotNotice("bob")).toBe("* bob took a screenshot *");
    expect(screenshotNotice("bob")).toBe(
      stripIsolates(screenshotNotice("bob")),
    );
  });
});

describe("inboundText", () => {
  it("stores the sender's own notice as a keyed row", () => {
    const row = inboundText("* bob took a screenshot *", "bob", "Bobby");
    expect(row.isSystem).toBe(true);
    expect(row.systemKey).toBe("chat.screenshot.peer_took");
    expect(row.systemVars).toEqual({ name: "Bobby" });
    expect(row.text).toBe("Bobby took a screenshot");
  });

  it("matches a geohash sender and a decomposed spelling", () => {
    expect(inboundText("* bob took a screenshot *", "bob#3f2a").systemKey).toBe(
      "chat.screenshot.peer_took",
    );
    expect(
      inboundText("* re\u0301mi took a screenshot *", "r\u00E9mi").systemKey,
    ).toBe("chat.screenshot.peer_took");
  });

  it("keeps anything else as the sender's words", () => {
    for (const text of [
      "* alice took a screenshot *",
      "* bob took a screenshot of the map *",
      "I took a screenshot",
      "* 🫂 bob hugs you *",
    ]) {
      expect(inboundText(text, "bob")).toEqual({ text });
    }
    // No name to anchor the notice to, so nothing can match.
    expect(inboundText("*  took a screenshot *", "")).toEqual({
      text: "*  took a screenshot *",
    });
  });
});
