// The translation runtime.
//
// Catalogs are TypeScript modules compiled into the bundle: a translation fetch
// would be a network call, a fingerprint, and a failure in exactly the
// conditions this app exists for.
//
// No i18n library. i18next and react-intl bring namespaces, lazy network
// backends and untyped runtime keys, none of which an offline-first app with a
// bundled catalog can use. Completeness comes from `tsc`; see
// `locales/types.ts`.

import { useSettingsStore } from "@store/settings-store";
import { stripInvisibles } from "@utils/strip-invisibles";
import { getLocales } from "expo-localization";
import { useSyncExternalStore } from "react";
import { I18nManager } from "react-native";
import {
  DEFAULT_LANGUAGE,
  isLanguageCode,
  isRTL,
  LANGUAGE_ORDER,
  LANGUAGES,
  type LanguageCode,
} from "./languages";
import { am } from "./locales/am";
import { ar } from "./locales/ar";
import { bn } from "./locales/bn";
import { de } from "./locales/de";
import { en } from "./locales/en";
import { es } from "./locales/es";
import { fa } from "./locales/fa";
import { fil } from "./locales/fil";
import { fr } from "./locales/fr";
import { hi } from "./locales/hi";
import { id } from "./locales/id";
import { it } from "./locales/it";
import { ja } from "./locales/ja";
import { ka } from "./locales/ka";
import { ko } from "./locales/ko";
import { mg } from "./locales/mg";
import { ms } from "./locales/ms";
import { my } from "./locales/my";
import { ne } from "./locales/ne";
import { nl } from "./locales/nl";
import { pa } from "./locales/pa";
import { pl } from "./locales/pl";
import { ptBR } from "./locales/pt-BR";
import { ptPT } from "./locales/pt-PT";
import { ru } from "./locales/ru";
import { sv } from "./locales/sv";
import { sw } from "./locales/sw";
import { ta } from "./locales/ta";
import { th } from "./locales/th";
import { tr } from "./locales/tr";
import type { Locale, PluralKey, TranslationKey } from "./locales/types";
import { uk } from "./locales/uk";
import { ur } from "./locales/ur";
import { vi } from "./locales/vi";
import { zhHans } from "./locales/zh-Hans";
import { zhHant } from "./locales/zh-Hant";
import { selectPlural } from "./plurals";
import { PSEUDO_LANGUAGE, pseudoLocale } from "./pseudo";

export type { LanguageCode } from "./languages";
export type { CatalogKey, PluralKey, TranslationKey } from "./locales/types";
export { upperCase } from "./upper-case";

// ---- The catalogs ----
//
// Adding a language is one line here plus its file. The value is a `Locale`,
// derived from `en.ts`, so a catalog missing a key does not compile: no coverage
// threshold, no partial state, no runtime fallback.
const REAL: Partial<Record<LanguageCode, Locale>> = {
  en,
  am,
  ar,
  bn,
  de,
  es,
  fa,
  fil,
  fr,
  hi,
  id,
  it,
  ja,
  ka,
  ko,
  mg,
  ms,
  my,
  ne,
  nl,
  pa,
  pl,
  "pt-BR": ptBR,
  "pt-PT": ptPT,
  ru,
  sv,
  sw,
  ta,
  th,
  tr,
  uk,
  ur,
  vi,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
};

export const CATALOGS: Partial<Record<LanguageCode, Locale>> = {
  ...REAL,
  ...(__DEV__
    ? { [PSEUDO_LANGUAGE]: pseudoLocale(en, Object.values(REAL)) }
    : {}),
};

// The languages a user can choose, in display order.
export const SHIPPED_LANGUAGES: LanguageCode[] = (
  Object.keys(CATALOGS) as LanguageCode[]
).sort((a, b) =>
  a === DEFAULT_LANGUAGE
    ? -1
    : b === DEFAULT_LANGUAGE
      ? 1
      : LANGUAGES[a].englishName.localeCompare(LANGUAGES[b].englishName, "en"),
);

export const PICKER_LANGUAGES: LanguageCode[] = __DEV__
  ? [...LANGUAGE_ORDER, PSEUDO_LANGUAGE]
  : LANGUAGE_ORDER;

export function isShipped(code: LanguageCode): boolean {
  return CATALOGS[code] !== undefined;
}

function catalogFor(code: LanguageCode): Locale {
  return CATALOGS[code] ?? en;
}

// ---- The device language ----
//
// What "system" means: the first of the phone's preferred languages that has a
// catalog, sampled once and re-sampled on the foreground edge.

// Retired codes a device still reports: `tl` for Filipino on Android, `in` the
// legacy Java Indonesian. Chinese and Portuguese stay out of it, since
// both have two variants and resolve below rather than through one alias.
const LANGUAGE_ALIASES: Record<string, LanguageCode> = {
  tl: "fil",
  in: "id",
};

// Which language an OS tag means. Pure and exported so the branches are testable
// against real device tags, not the runner's locale. The answer is a
// language Airhop knows, not necessarily one it has translated:
// `resolvePreference` applies the shipping gate afterwards.
export function languageForTag(tag: string): LanguageCode {
  return matchTag(tag) ?? DEFAULT_LANGUAGE;
}

// The first of the phone's preferred languages that ships, the way both OSes
// pick a resource. A Catalan reader with Spanish second gets Spanish, not
// English, and so does the foreground-service notice Android picks by itself.
export function languageForTags(tags: readonly string[]): LanguageCode {
  for (const tag of tags) {
    const code = matchTag(tag);
    if (code !== null && isShipped(code)) return code;
  }
  return DEFAULT_LANGUAGE;
}

// Null when the tag names nothing Airhop knows, so a preference list can move
// on to its next entry rather than stopping at English.
function matchTag(tag: string): LanguageCode | null {
  // A device can be set to the pseudolocale tag on a debug build; it is a
  // debugging instrument, so it is never inferred, only chosen.
  if (tag !== PSEUDO_LANGUAGE && isLanguageCode(tag)) return tag;

  // The Punjabi catalog is Gurmukhi. Pakistan writes Shahmukhi, an Arabic
  // script with no letters in common, so it is no match. Android's resource
  // layer already declines it on script; this is the same rule in JavaScript.
  if (/^pa[-_](PK|Arab)/i.test(tag)) return null;

  const base = tag.split("-")[0];
  // Neither two-variant language may match on its base alone: guessing
  // Simplified for a Traditional reader, or Brazilian for a Lisbon one, is the
  // kind of wrong that reads as carelessness rather than as a missing language.
  if (base !== undefined && base !== "zh" && base !== "pt") {
    if (isLanguageCode(base)) return base;
  }
  if (tag.startsWith("zh")) {
    // A named script decides; the region only when there is none, since iOS
    // adds one to every tag and Hong Kong has Simplified readers too.
    if (/Hans/i.test(tag)) return "zh-Hans";
    return /Hant|TW|HK|MO/i.test(tag) ? "zh-Hant" : "zh-Hans";
  }
  if (tag.startsWith("pt")) {
    // Brazil is what a bare "pt" means to CLDR and to most speakers. Every
    // other region follows the European orthography, Angola and Mozambique
    // included.
    return /^pt(-BR)?$/i.test(tag) ? "pt-BR" : "pt-PT";
  }
  // Checked last, so an exact code always wins over an alias.
  if (base !== undefined && base in LANGUAGE_ALIASES) {
    return LANGUAGE_ALIASES[base] as LanguageCode;
  }
  return null;
}

// The phone's preferred languages, in order, a per-app language first where
// one is set. Hermes' default `Intl` locale is only the head of this list.
function deviceTags(): string[] {
  return getLocales().map((locale) => locale.languageTag);
}

// Re-sampled on the foreground edge, not once per process: both Android
// pickers recreate the Activity while the JS context survives.
let deviceLanguage: LanguageCode | null = null;

function getDeviceLanguage(): LanguageCode {
  if (deviceLanguage === null) {
    try {
      deviceLanguage = languageForTags(deviceTags());
    } catch {
      deviceLanguage = DEFAULT_LANGUAGE;
    }
  }
  return deviceLanguage;
}

// Bumped when the sampled device language changes. The hooks subscribe to it
// because the store holds the preference, and "system" does not move when the
// OS language does.
let deviceEpoch = 0;
const deviceListeners = new Set<() => void>();

function subscribeDeviceLanguage(onChange: () => void): () => void {
  deviceListeners.add(onChange);
  return () => {
    deviceListeners.delete(onChange);
  };
}

function readDeviceEpoch(): number {
  return deviceEpoch;
}

// Called on the foreground edge, the only moment the device language can change
// without the process being replaced.
export function refreshDeviceLanguage(): void {
  const before = deviceLanguage;
  deviceLanguage = null;
  if (getDeviceLanguage() === before) return;
  // Pinned now, as a picker change is, or the next launch boots in the old
  // direction and a second one is needed.
  applyLayoutDirection(resolvePreference(useSettingsStore.getState().language));
  deviceEpoch++;
  for (const notify of deviceListeners) notify();
}

// ---- Layout direction ----
//
// Yoga reads the direction flag once at process start, so a change lands on the
// next launch. Forcing a relaunch is not an option: it destroys every Noise
// session, empties the peer table and cuts live voice, and iOS has no sanctioned
// self-restart anyway. A language disagreeing with the frame therefore waits as
// a preference, and the UI keeps the boot language until then.
//
// Both facts below are read, never assumed: `I18nManager.isRTL` for the
// direction in force, `frameLanguage` for the language it belongs to. Assuming
// puts right-to-left prose in a left-to-right frame on a first launch, with
// `needsRelaunch` reporting false.

let bootLanguage: LanguageCode = DEFAULT_LANGUAGE;
let bootDirection: "ltr" | "rtl" = "ltr";
let unwatchLanguage: (() => void) | null = null;

// A stored preference, which is either a language or "follow the device".
export type LanguagePreference = LanguageCode | "system";

// What a preference means right now, before the direction rule is applied.
export function resolvePreference(pref: LanguagePreference): LanguageCode {
  const code = pref === "system" ? getDeviceLanguage() : pref;
  // A device language, or a preference written by a build that shipped more
  // languages than this one, may name a code with no catalog.
  return isShipped(code) ? code : DEFAULT_LANGUAGE;
}

// The language actually being rendered. Differs from the preference only while
// a direction change is waiting for the next launch.
export function activeLanguage(pref: LanguagePreference): LanguageCode {
  const wanted = resolvePreference(pref);
  return LANGUAGES[wanted].direction === bootDirection ? wanted : bootLanguage;
}

// Whether the chosen language is waiting for a relaunch to take effect, so the
// picker can say so instead of looking broken.
//
// The second clause is a first launch on a right-to-left phone set to a
// language Airhop does not ship (Hebrew, Pashto): React Native mirrors the
// frame from the device locale, the fallback is English, and no shipped
// language fits the frame. English is rendered, but mirrored until a restart
// lets `applyLayoutDirection` take hold.
export function needsRelaunch(pref: LanguagePreference): boolean {
  const active = activeLanguage(pref);
  return (
    active !== resolvePreference(pref) ||
    LANGUAGES[active].direction !== bootDirection
  );
}

// Pinning direction to the app's language matters even for a left-to-right one:
// React Native otherwise mirrors the whole layout on a device set to Arabic or
// Hebrew, putting English text in a right-to-left frame. Pinned, the app looks
// the same everywhere, the guarantee the bundled catalog gives the text.
//
// Takes effect on the next launch, so the language is recorded for `initI18n`
// to read back. Called at boot and again whenever the wanted language moves,
// which is what makes a single restart enough.
export function applyLayoutDirection(code: LanguageCode): void {
  const shouldBeRTL = isRTL(code);
  I18nManager.allowRTL(shouldBeRTL);
  // Unconditional: `I18nManager.isRTL` is a constant read at module load, so it
  // answers with the direction this process booted in and never moves. Guarded
  // on it, only the first change per session takes effect. Setting the same
  // value twice is free; the write below is what needs a guard.
  I18nManager.forceRTL(shouldBeRTL);
  // Only on a change: a zustand `set` persists the whole store, and this runs at
  // every launch and on every preference change.
  const store = useSettingsStore.getState();
  if (store.frameLanguage !== code) store.setFrameLanguage(code);
}

// Called once from the root before the first render, so the first frame is
// already laid out correctly and the direction is fixed for the process.
export function initI18n(): void {
  const store = useSettingsStore.getState();
  const wanted = resolvePreference(store.language);

  bootDirection = I18nManager.isRTL ? "rtl" : "ltr";

  // The recorded language when it still agrees with the direction in force,
  // otherwise one that does: `bootLanguage` is the UI's fallback, and prose in
  // the wrong frame is what this mechanism prevents. `wanted` is tried before
  // the default because a panic wipe clears the record while the native flag
  // survives, and on a right-to-left phone the device language is right.
  const recorded = store.frameLanguage;
  bootLanguage =
    recorded !== null &&
    isShipped(recorded) &&
    LANGUAGES[recorded].direction === bootDirection
      ? recorded
      : LANGUAGES[wanted].direction === bootDirection
        ? wanted
        : DEFAULT_LANGUAGE;

  applyLayoutDirection(wanted);

  // Re-pinned whenever the preference moves, whoever moves it: the picker,
  // Reset settings, a panic wipe or a transfer. Pinned by the picker alone, the
  // first reopen after any other writer boots in the old direction and asks for
  // a second one.
  unwatchLanguage?.();
  unwatchLanguage = useSettingsStore.subscribe((state, prev) => {
    if (state.language !== prev.language) {
      applyLayoutDirection(resolvePreference(state.language));
    }
  });
}

// ---- Interpolation ----

export type TranslationVars = Record<string, string | number>;

// Named, never positional: reordering a sentence is what most languages
// require, and it cannot break a named placeholder. An unknown one is left
// verbatim instead of blanked, so the gap shows up in a screenshot.
const PLACEHOLDER = /\{(\w+)\}/g;

// A placeholder holds text Airhop does not author and cannot predict the
// direction of. Unisolated, the bidirectional algorithm resolves the neutrals
// around it against whichever way that text reads, so an Arabic nickname in an
// English sentence drags the punctuation after it to the wrong side. No catalog
// can fix that.
//
// The first-strong isolate and its pop stop the run leaking outward, and are
// inert in a same-direction context, so English renders byte-identically.
// Numbers are wrapped too: a digit run reorders the same way.
//
// Escapes, because `scripts/check-invisibles.js` forbids the literal characters
// in source.
export const ISOLATE_FIRST = "\u2068";
export const ISOLATE_POP = "\u2069";

// Strips the isolates back out, for callers that compare rendered text rather
// than showing it. See `@utils/chat-search`.
export function stripIsolates(text: string): string {
  return text.replace(/[\u2068\u2069]/g, "");
}

// A value's own bidi controls are stripped first: an isolate or override inside
// it can only fight the isolate around it, and a pop would close it early and
// let an override reorder the rest of the sentence.
function interpolate(template: string, vars?: TranslationVars): string {
  if (vars === undefined) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) return match;
    return `${ISOLATE_FIRST}${stripInvisibles(String(value))}${ISOLATE_POP}`;
  });
}

// ---- Translators ----

export interface Translator {
  // The language this translator is bound to, for callers that need to format
  // a date or a number in the same locale as the surrounding text.
  readonly language: LanguageCode;
  (key: TranslationKey, vars?: TranslationVars): string;
}

export interface PluralTranslator {
  (key: PluralKey, count: number, vars?: TranslationVars): string;
}

// For a key that came off disk, where a stored row may name either map.
export function isPluralKey(key: string): key is PluralKey {
  return Object.prototype.hasOwnProperty.call(en.plurals, key);
}

// Grouped by the locale's own rule, pinned to Latin digits like every other
// number the app renders.
//
// The grouping is the useful half: Hindi, Punjabi and Tamil group by lakh,
// Georgian by thin space. The digits are not, because `utils/format.ts` pins
// machine data to Latin and `catalog.test.ts` forbids a catalog its own
// numerals; a locale-native digit here would be the one source of a second digit
// system in one sentence. Bengali, Burmese and Persian are the three affected.
//
// Requested through the BCP-47 extension rather than the `numberingSystem`
// option, for the reason `latinLocale()` gives: Hermes ships a partial Intl, and
// an unimplemented extension is ignored where an unimplemented option throws.
const COUNT_FORMATS = new Map<LanguageCode, Intl.NumberFormat>();

function formatCount(language: LanguageCode, count: number): string {
  let format = COUNT_FORMATS.get(language);
  if (format === undefined) {
    try {
      format = new Intl.NumberFormat(`${language}-u-nu-latn`);
    } catch {
      // Hermes carries a partial Intl and an OEM may carry less. A plain
      // decimal is a worse number than a grouped one, and far better than a
      // screen that throws while rendering a list.
      format = { format: (n: number) => String(n) } as Intl.NumberFormat;
    }
    COUNT_FORMATS.set(language, format);
  }
  return format.format(count);
}

// Translators are cached per language so their identity is stable. Components
// pass `T` in dependency arrays and memo comparators; a fresh function each
// render would defeat every one of them.
const TRANSLATORS = new Map<LanguageCode, Translator>();

function getT(language: LanguageCode): Translator {
  let translator = TRANSLATORS.get(language);
  if (translator === undefined) {
    translator = Object.assign(
      (key: TranslationKey, vars?: TranslationVars): string =>
        interpolate(catalogFor(language).strings[key], vars),
      { language },
    );
    TRANSLATORS.set(language, translator);
  }
  return translator;
}

const PLURAL_TRANSLATORS = new Map<LanguageCode, PluralTranslator>();

function getTPlural(language: LanguageCode): PluralTranslator {
  let translator = PLURAL_TRANSLATORS.get(language);
  if (translator === undefined) {
    translator = (key, count, vars) => {
      const forms = catalogFor(language).plurals[key];
      // The exact match first, as ICU orders it. The `?? forms.other` is
      // unreachable while `catalog.test.ts` holds every catalog to
      // `PLURAL_CATEGORIES`, and kept because the type cannot prove it: every
      // category but `other` is optional, and `other` is the one CLDR
      // guarantees everywhere.
      const template =
        (count === 1 ? forms["=1"] : undefined) ??
        forms[selectPlural(language, count)] ??
        forms.other;
      return interpolate(template, {
        count: formatCount(language, count),
        ...vars,
      });
    };
    PLURAL_TRANSLATORS.set(language, translator);
  }
  return translator;
}

// ---- Hooks ----
//
// These subscribe to the language preference, so changing it re-renders the
// tree. Everything below the root reads through them, so adding a language
// touches no screen.

// Two sources: the picker writes the preference, the OS writes the device
// language underneath a preference of "system".
function usePreference(): LanguagePreference {
  const preference = useSettingsStore((s) => s.language);
  useSyncExternalStore(
    subscribeDeviceLanguage,
    readDeviceEpoch,
    readDeviceEpoch,
  );
  return preference;
}

// The language the preference asks for, before the direction rule defers it.
// What the restart notice watches.
export function useWantedLanguage(): LanguageCode {
  return resolvePreference(usePreference());
}

export function useLanguage(): LanguageCode {
  return activeLanguage(usePreference());
}

export function useT(): Translator {
  return getT(useLanguage());
}

export function useTPlural(): PluralTranslator {
  return getTPlural(useLanguage());
}

// ---- Outside the component tree ----
//
// Services, stores and notification builders cannot use a hook, and read the
// same store so they are never out of step with the screen.
//
// Translate at display, never at storage. A notification body is translated when
// posted; anything persisted to MMKV stores the key and translates on render.
// See `systemKey` in `@store/chat-store` and `@utils/message-text`.

export function getLanguage(): LanguageCode {
  return activeLanguage(useSettingsStore.getState().language);
}

export const t: Translator = Object.assign(
  (key: TranslationKey, vars?: TranslationVars): string =>
    getT(getLanguage())(key, vars),
  {
    get language(): LanguageCode {
      return getLanguage();
    },
  },
) as Translator;

export const tPlural: PluralTranslator = (key, count, vars) =>
  getTPlural(getLanguage())(key, count, vars);

// A translator bound to a language other than the one on screen. One caller:
// the restart notice, whose reader is by definition somebody who cannot read the
// current UI language. Everything else uses `t` / `useT`.
export function translatorFor(code: LanguageCode): Translator {
  return getT(code);
}

/**
 * @public `catalog.test.ts` renders every catalog's plural forms in its own
 * language, the only way to check the digits a count comes out in.
 */
export function pluralTranslatorFor(code: LanguageCode): PluralTranslator {
  return getTPlural(code);
}

// The picker's data, re-exported so a screen imports it alongside `useT`.
export { LANGUAGE_ORDER, LANGUAGES } from "./languages";
