// The language picker's ticks: the Phone language row holds the tick while
// following the phone, a pinned language holds it otherwise, and a choice
// waiting for a relaunch says so instead of claiming to be active.

import { translatorFor } from "@i18n";
import { languageA11yName, languageRowState } from "../language-rows";

describe("languageRowState", () => {
  it("ticks Phone language, and no language, while following the phone", () => {
    expect(languageRowState("system", "system", "fr", false)).toEqual({
      selected: true,
      pending: false,
    });
    // French is what the phone resolves to, but it was not chosen.
    expect(languageRowState("fr", "system", "fr", false)).toEqual({
      selected: false,
      pending: false,
    });
  });

  it("ticks the pinned language, and not Phone language", () => {
    expect(languageRowState("de", "de", "de", false).selected).toBe(true);
    expect(languageRowState("system", "de", "de", false).selected).toBe(false);
  });

  it("keeps the tick on screen while a direction change waits", () => {
    // Arabic chosen from English: English is still what is drawn.
    expect(languageRowState("ar", "ar", "en", true)).toEqual({
      selected: false,
      pending: true,
    });
    expect(languageRowState("en", "ar", "en", true)).toEqual({
      selected: true,
      pending: false,
    });
  });

  it("marks Phone language pending when the phone's language must wait", () => {
    expect(languageRowState("system", "system", "en", true)).toEqual({
      selected: false,
      pending: true,
    });
    expect(languageRowState("en", "system", "en", true).selected).toBe(false);
  });
});

describe("languageA11yName", () => {
  const T = translatorFor("en");

  it("keeps the endonym beside the translated name", () => {
    const name = languageA11yName(T, "Arabic", "العربية");
    expect(name).toContain("Arabic");
    expect(name).toContain("العربية");
  });

  it("says a name once when it is its own endonym", () => {
    expect(languageA11yName(T, "Français", "français")).toBe("Français");
  });
});
