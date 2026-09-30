/**
 * @jest-environment node
 */
// Runtime behaviour: catalog resolution, interpolation, plural selection, and
// the rule that decides which language is actually on screen.
//
// The hooks are not exercised here: they are thin wrappers over the same `getT`
// the functions below use, so calling them outside a renderer tests React.

import { useSettingsStore } from "@store/settings-store";
import { getLocales } from "expo-localization";
import { I18nManager } from "react-native";
import {
  getLanguage,
  initI18n,
  isShipped,
  languageForTag,
  languageForTags,
  needsRelaunch,
  pluralTranslatorFor,
  refreshDeviceLanguage,
  resolvePreference,
  SHIPPED_LANGUAGES,
  stripIsolates,
  t,
  tPlural,
  translatorFor,
} from "../index";
import {
  DEFAULT_LANGUAGE,
  isRTL,
  LANGUAGE_ORDER,
  LANGUAGES,
  type LanguageCode,
} from "../languages";
import { PSEUDO_LANGUAGE } from "../pseudo";

afterEach(() => {
  useSettingsStore.setState({ language: "system" });
});

describe("language table", () => {
  it("knows every language regardless of what has been translated", () => {
    // Facts about languages, not a record of translation progress, so the table
    // does not grow as catalogs land. The literal is the tripwire: adding a
    // language is meant to fail here once.
    expect(LANGUAGE_ORDER).toHaveLength(35);
    expect(new Set(LANGUAGE_ORDER).size).toBe(35);
  });

  it("keeps the pseudolocale out of the language list", () => {
    // It is a debugging instrument, so it has a spec like a language but never
    // sorts in among them. PICKER_LANGUAGES is where it is appended, in debug
    // builds only.
    expect(LANGUAGES[PSEUDO_LANGUAGE]).toBeDefined();
    expect(LANGUAGE_ORDER).not.toContain(PSEUDO_LANGUAGE);
    expect(Object.keys(LANGUAGES)).toHaveLength(LANGUAGE_ORDER.length + 1);
  });

  it("puts the source language first and the rest in a stable order", () => {
    // Sorted by English name, not the translated one, so the list
    // does not reshuffle under the user's finger when they change language.
    expect(LANGUAGE_ORDER[0]).toBe("en");
    const rest = LANGUAGE_ORDER.slice(1).map((c) => LANGUAGES[c].englishName);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, "en")));
  });

  it("marks exactly the right-to-left languages", () => {
    const rtl = LANGUAGE_ORDER.filter(isRTL);
    expect(rtl.sort()).toEqual(["ar", "fa", "ur"]);
  });

  it("gives every language a distinct short code and endonym", () => {
    // Both are what a user scans the picker for; a duplicate makes two rows
    // indistinguishable.
    const shorts = LANGUAGE_ORDER.map((c) => LANGUAGES[c].shortCode);
    const endonyms = LANGUAGE_ORDER.map((c) => LANGUAGES[c].endonym);
    expect(new Set(shorts).size).toBe(shorts.length);
    expect(new Set(endonyms).size).toBe(endonyms.length);
  });
});

describe("what ships", () => {
  it("falls back to English for a language with no catalog", () => {
    // Reachable two ways: a device set to a language Airhop has not translated,
    // and a preference written by a later build that shipped more. Every
    // declared language has a catalog, so the code is one this build never
    // heard of.
    const unknown = "he" as LanguageCode;
    expect(isShipped(unknown)).toBe(false);
    expect(resolvePreference(unknown)).toBe(DEFAULT_LANGUAGE);
  });
});

describe("which language is on screen", () => {
  it("follows an explicit preference, unless it crosses the direction boundary", () => {
    // The exception is the right-to-left policy: direction is fixed at process
    // start, so choosing Arabic from a left-to-right boot keeps rendering the
    // boot language until the next launch rather than putting Arabic prose in a
    // left-to-right frame. Everything sharing the boot direction switches now.
    for (const code of SHIPPED_LANGUAGES) {
      useSettingsStore.setState({ language: code });
      expect(getLanguage()).toBe(needsRelaunch(code) ? DEFAULT_LANGUAGE : code);
    }
  });

  it("defers exactly the right-to-left languages and no others", () => {
    const deferred = SHIPPED_LANGUAGES.filter(needsRelaunch);
    expect(deferred).toEqual(SHIPPED_LANGUAGES.filter(isRTL));
  });

  it("resolves 'system' to something shipped", () => {
    useSettingsStore.setState({ language: "system" });
    expect(SHIPPED_LANGUAGES).toContain(getLanguage());
  });

  it("reports a deferred language rather than rendering it in the wrong frame", () => {
    // The runner boots left to right, which is the first-launch frame on an
    // Arabic phone: `forceRTL(true)` has not taken effect yet. Taking the wanted
    // language's direction on trust there renders right-to-left prose into a
    // left-to-right frame and reports `needsRelaunch` as false, which is the one
    // combination with no way out and nothing on screen saying so.
    for (const code of SHIPPED_LANGUAGES.filter(isRTL)) {
      useSettingsStore.setState({ language: code });
      expect(needsRelaunch(code)).toBe(true);
      // Rendering a language whose direction matches the frame in force.
      expect(isRTL(getLanguage())).toBe(false);
    }
  });
});

describe("a mirrored frame with nothing to fill it", () => {
  // A first launch on a phone set to Hebrew or Pashto: React Native mirrors
  // the frame from the device locale, and no shipped language reads right to
  // left in its place, so English is rendered. Mirrored, it needs the restart
  // that `applyLayoutDirection` has already queued.
  const frame = I18nManager as { isRTL: boolean };

  afterEach(() => {
    frame.isRTL = false;
    initI18n();
  });

  it("asks for the restart that straightens English out", () => {
    frame.isRTL = true;
    useSettingsStore.setState({ language: "en", frameLanguage: null });
    initI18n();
    expect(getLanguage()).toBe("en");
    expect(needsRelaunch("en")).toBe(true);
  });

  it("does not ask when a right-to-left language fills it", () => {
    frame.isRTL = true;
    useSettingsStore.setState({ language: "ar", frameLanguage: null });
    initI18n();
    expect(getLanguage()).toBe("ar");
    expect(needsRelaunch("ar")).toBe(false);
  });
});

describe("layout direction", () => {
  it("pins the next launch's direction whoever changes the language", () => {
    // Reset settings and a panic wipe move the preference without the picker.
    // Pinned only by the picker, the first reopen after either boots in the old
    // direction, raises the notice again and needs a second one.
    const forceRTL = jest.spyOn(I18nManager, "forceRTL");
    initI18n();

    useSettingsStore.getState().setLanguage("ar");
    expect(forceRTL).toHaveBeenLastCalledWith(true);
    expect(useSettingsStore.getState().frameLanguage).toBe("ar");

    useSettingsStore.getState().reset();
    expect(forceRTL).toHaveBeenLastCalledWith(false);
    expect(useSettingsStore.getState().frameLanguage).toBe(
      resolvePreference("system"),
    );
  });

  it("pins it when the phone's language changes under the system setting", () => {
    // Otherwise the next launch still boots in the old direction and a second
    // one is needed, with nothing on screen explaining either.
    const forceRTL = jest.spyOn(I18nManager, "forceRTL");
    const locales = jest.mocked(getLocales);
    initI18n();
    useSettingsStore.getState().setLanguage("system");

    locales.mockReturnValueOnce([{ languageTag: "ar-EG" }] as never);
    refreshDeviceLanguage();
    expect(forceRTL).toHaveBeenLastCalledWith(true);
    expect(useSettingsStore.getState().frameLanguage).toBe("ar");

    refreshDeviceLanguage();
    expect(forceRTL).toHaveBeenLastCalledWith(false);
  });
});

describe("device language", () => {
  // What real phones report, not what a spec says they ought to. Every tag
  // resolving to English is somebody reading English beside a finished catalog.
  it.each([
    ["en-US", "en"],
    ["en-GB", "en"],
    ["pt-BR", "pt-BR"],
    // Brazil is what a bare tag means; every other region follows the
    // European orthography.
    ["pt-PT", "pt-PT"],
    ["pt", "pt-BR"],
    ["pt-AO", "pt-PT"],
    ["pt-MZ", "pt-PT"],
    // Script decides Chinese, never region alone.
    ["zh-Hans-CN", "zh-Hans"],
    ["zh-Hant-TW", "zh-Hant"],
    ["zh-TW", "zh-Hant"],
    ["zh-HK", "zh-Hant"],
    // A named script outranks the region iOS appends to every tag.
    ["zh-Hans-HK", "zh-Hans"],
    ["zh-Hant-HK", "zh-Hant"],
    ["zh-MO", "zh-Hant"],
    ["zh-CN", "zh-Hans"],
    ["zh-SG", "zh-Hans"],
    ["zh", "zh-Hans"],
    // Retired and legacy codes some devices still report.
    ["fil-PH", "fil"],
    ["tl-PH", "fil"],
    ["tl", "fil"],
    ["id-ID", "id"],
    ["in-ID", "id"],
    // A region the catalog does not name still reaches its language.
    ["ur-PK", "ur"],
    ["ta-LK", "ta"],
    ["ms-BN", "ms"],
    ["bn-BD", "bn"],
    ["ka-GE", "ka"],
    ["mg-MG", "mg"],
    ["pa-IN", "pa"],
    // Not shipped, so falling back is the right answer.
    ["nb-NO", "en"],
    ["he-IL", "en"],
    // Gurmukhi is the catalog; Pakistan reads Shahmukhi and cannot use it.
    ["pa-PK", "en"],
    ["pa-Arab-PK", "en"],
    ["", "en"],
  ])("resolves %s to %s", (tag, expected) => {
    expect(languageForTag(tag)).toBe(expected);
  });

  it.each([
    // The first shipped language wins, the way both OSes pick a resource.
    [["ca-ES", "es-ES"], "es"],
    [["gsw-CH", "de-CH"], "de"],
    [["be-BY", "ru-RU"], "ru"],
    // A declined Punjabi tag moves on rather than stopping at English.
    [["pa-PK", "ur-PK"], "ur"],
    // English named in the list is a match like any other.
    [["he-IL", "en-US", "ar-EG"], "en"],
    [["xx-YY"], "en"],
    [[], "en"],
  ])("resolves the list %j to %s", (tags, expected) => {
    expect(languageForTags(tags)).toBe(expected);
  });

  it("never infers the pseudolocale, which is chosen and never detected", () => {
    expect(languageForTag(PSEUDO_LANGUAGE)).toBe(DEFAULT_LANGUAGE);
  });

  it("only ever resolves to a language the app knows", () => {
    for (const tag of ["pt-PT", "tl", "in", "zh-MO", "xx-YY", "qps-ploc"]) {
      expect(LANGUAGE_ORDER).toContain(languageForTag(tag));
    }
  });
});

describe("interpolation", () => {
  it("substitutes named placeholders", () => {
    expect(
      stripIsolates(t("settings.opens_externally", { label: "About" })),
    ).toBe("About, opens outside the app");
  });

  it("leaves an unfilled placeholder visible rather than blanking it", () => {
    // A hole you can see in a screenshot beats a sentence that silently lost a
    // word.
    expect(t("settings.opens_externally")).toContain("{label}");
  });

  it("ignores extra variables", () => {
    expect(t("common.cancel", { unused: 1 })).toBe("Cancel");
  });

  // A name with a direction of its own, so the isolates have work to do.
  const ARABIC_NAME = "أحمد";

  it("isolates every substituted value", () => {
    // Unisolated, the bidirectional algorithm resolves the punctuation around a
    // substituted name against whichever way that name reads. See
    // `interpolate`.
    const rendered = t("settings.opens_externally", { label: ARABIC_NAME });
    expect(rendered).toBe(`\u2068${ARABIC_NAME}\u2069, opens outside the app`);
  });

  it("leaves a string with no placeholders untouched", () => {
    // Added per substitution, never around the sentence, so a string with no
    // placeholders is byte-identical to its catalog entry.
    expect(t("common.cancel")).toBe("Cancel");
  });

  // A value's own pop would close the isolate early, and an override after it
  // would then reorder the rest of the sentence.
  it("keeps a value's own bidi controls from escaping its isolate", () => {
    const hostile = "x\u2069\u202Eevil";
    const rendered = t("settings.opens_externally", { label: hostile });
    expect(rendered).toBe("\u2068xevil\u2069, opens outside the app");
  });
});

describe("plurals", () => {
  it("selects the English categories", () => {
    const rendered = (n: number): string =>
      stripIsolates(tPlural("mesh.peers_in_range", n));
    expect(rendered(1)).toBe("1 peer in range");
    expect(rendered(0)).toBe("0 peers in range");
    expect(rendered(7)).toBe("7 peers in range");
  });

  it("says exactly one in words only where the catalog has an exact form", () => {
    // `=1` is for wording that carries no number. CLDR `one` is not that: it
    // covers 21 in Ukrainian and 5 in Filipino.
    useSettingsStore.setState({ language: "en" });
    expect(tPlural("notif.nearby.title", 1)).toBe("Someone nearby");
    expect(stripIsolates(tPlural("notif.nearby.title", 2))).toBe(
      "2 people nearby",
    );
    expect(stripIsolates(tPlural("mesh.peers_in_range", 1))).toBe(
      "1 peer in range",
    );
  });

  it("provides {count} without the caller passing it", () => {
    expect(tPlural("chat.group_members", 3)).toContain("3");
  });

  it("still takes other variables alongside the count", () => {
    expect(
      stripIsolates(
        tPlural("wallet.backup.recovered", 2, { mints: "2 mints" }),
      ),
    ).toBe("Recovered 2 unspent coins from 2 mints.");
  });

  it("groups the count in the reading language, not the device's", () => {
    // Grouping follows the language (English by thousand, Hindi by lakh); the
    // digits do not, so the app never renders two numbering systems at once.
    useSettingsStore.setState({ language: "en" });
    expect(tPlural("mesh.peers_in_range", 12_000)).toContain("12,000");
    useSettingsStore.setState({ language: "hi" });
    expect(tPlural("mesh.peers_in_range", 1_234_567)).toContain("12,34,567");
    useSettingsStore.setState({ language: "bn" });
    // Bengali resolves to `beng` digits without the pin.
    expect(tPlural("mesh.peers_in_range", 5)).toContain("5");
    useSettingsStore.setState({ language: "en" });
  });
});

describe("translator identity", () => {
  it("is stable per language, so components memoized on it do not re-render", () => {
    // Components pass `T` in dependency arrays and memo comparators. A fresh
    // function per render would defeat every one of them.
    expect(translatorFor("en")).toBe(translatorFor("en"));
    expect(pluralTranslatorFor("en")).toBe(pluralTranslatorFor("en"));
    expect(translatorFor("fr")).not.toBe(translatorFor("en"));
  });
});
