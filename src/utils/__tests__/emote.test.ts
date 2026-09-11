/**
 * @jest-environment node
 */
// The emote row has no sender name, so what qualifies for it is a security
// boundary, not a formatting choice.

import { emoteLine } from "../emote";

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
