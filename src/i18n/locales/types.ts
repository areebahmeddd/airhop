// The shape every locale file must have.
//
// `en.ts` is the source of truth: it declares the keys, and the types below
// are derived from it. Any locale added later is annotated `Strings` /
// `Plurals`, so a missing key, a stray key, or a typo is a compile error under
// the `npm run typecheck` that CI already runs. A partial locale is
// unrepresentable here, which is why Airhop needs neither a runtime fallback nor
// a localization coverage test: the .xcstrings format bitchat uses permits
// partial locales, this one does not.
//
// So a locale ships once it is complete, and adding an English key breaks every
// incomplete locale at compile time instead of degrading it at runtime in
// front of a user.

import type { plurals, strings } from "./en";

export type TranslationKey = keyof typeof strings;
export type PluralKey = keyof typeof plurals;
// Either map, for a key stored on a row and translated when it is read.
export type CatalogKey = TranslationKey | PluralKey;

export type Strings = Record<TranslationKey, string>;

// Plural categories are per-language, not universal: English needs one/other,
// Russian needs one/few/many/other, Arabic needs all six. A flat `Strings` map
// cannot express that (every locale would be forced to English's exact key
// set), so plurals live in their own map where each locale supplies only the
// categories its language actually uses.
//
// `other` is required everywhere because it is the category `Intl.PluralRules`
// falls back to and the only one guaranteed to exist in every language.
//
// `=1` is ICU's exact match, for wording that means exactly one and carries no
// number ("Someone nearby"). A CLDR category cannot hold that: Filipino `one`
// covers 5 and Ukrainian `one` covers 21. A locale carries it exactly where
// `en.ts` does, and `catalog.test.ts` holds every `one` to showing the count.
export interface PluralForms {
  "=1"?: string;
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

export type Plurals = Record<PluralKey, PluralForms>;

export interface Locale {
  strings: Strings;
  plurals: Plurals;
}
