// Where a forward may go. Ecash is a bearer secret, refused into every room;
// a bulk forward past the receivers' burst is refused into public rooms, where
// the rest would be dropped; and a public room is named before anything is
// published there.

import {
  carriesEcash,
  forwardRefusal,
  PUBLIC_FORWARD_BURST,
  publicForwardReach,
} from "../forward-rules";

// A plausible cashuB token: the TOKEN_HINTS test is a substring check.
const TOKEN = `cashuB${"o".repeat(60)}`;

describe("carriesEcash", () => {
  it("finds a token in a text or a caption among others", () => {
    expect(carriesEcash(["hello", `here: ${TOKEN}`])).toBe(true);
    expect(carriesEcash(["cashu:cashuA"])).toBe(true);
  });

  it("passes ordinary text", () => {
    expect(carriesEcash(["cash you later", ""])).toBe(false);
    expect(carriesEcash([])).toBe(false);
  });
});

describe("forwardRefusal", () => {
  it("refuses ecash into every kind of room, a DM included", () => {
    const ecash = { ecash: true, count: 1 };
    expect(forwardRefusal("#bluetooth", false, ecash)).toBe("ecash");
    expect(forwardRefusal("#block", false, ecash)).toBe("ecash");
    expect(forwardRefusal("geohash:u4pruy", false, ecash)).toBe("ecash");
    expect(forwardRefusal("#secret", true, ecash)).toBe("ecash");
    expect(forwardRefusal("group:abcd", false, ecash)).toBe("ecash");
    expect(forwardRefusal("dm:0011223344556677", false, ecash)).toBe("ecash");
  });

  it("refuses a burst past the receivers' allowance into a public room", () => {
    const over = { ecash: false, count: PUBLIC_FORWARD_BURST + 1 };
    expect(forwardRefusal("#bluetooth", false, over)).toBe("burst");
    expect(forwardRefusal("geohash:u4pruy", false, over)).toBe("burst");
  });

  it("allows exactly the allowance into a public room", () => {
    const full = { ecash: false, count: PUBLIC_FORWARD_BURST };
    expect(forwardRefusal("#bluetooth", false, full)).toBeNull();
  });

  it("allows any burst into a sealed room, a group or a DM", () => {
    const many = { ecash: false, count: 40 };
    expect(forwardRefusal("#secret", true, many)).toBeNull();
    expect(forwardRefusal("group:abcd", false, many)).toBeNull();
    expect(forwardRefusal("dm:0011223344556677", false, many)).toBeNull();
  });
});

describe("publicForwardReach", () => {
  it("names a location room's reach as the area's relays", () => {
    expect(publicForwardReach("geohash:u4pruy", false)).toBe("geo");
    expect(publicForwardReach("#block", false)).toBe("geo");
  });

  it("names the Bluetooth room as nearby only", () => {
    expect(publicForwardReach("#bluetooth", false)).toBe("mesh");
  });

  it("asks nothing for a sealed room, a group or a DM", () => {
    expect(publicForwardReach("#secret", true)).toBeNull();
    expect(publicForwardReach("group:abcd", false)).toBeNull();
    expect(publicForwardReach("dm:0011223344556677", false)).toBeNull();
  });
});
