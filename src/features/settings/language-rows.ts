// What each row of the language picker shows: its tick, its "on next open"
// note, and the name a screen reader says. Pure, so the rules are testable
// without the Profile tree.

import type { LanguageCode, LanguagePreference, Translator } from "@i18n";

export interface LanguageRowState {
  selected: boolean;
  pending: boolean;
}

// `row` is a language, or "system" for the Phone language row. `waiting` is
// `needsRelaunch(preference)`.
export function languageRowState(
  row: LanguagePreference,
  preference: LanguagePreference,
  onScreen: LanguageCode,
  waiting: boolean,
): LanguageRowState {
  const pending = row === preference && waiting;
  if (row === "system") {
    return { selected: preference === "system" && !waiting, pending };
  }
  // Ticked against what is on screen, not against the preference, so a
  // right-to-left choice waiting for a relaunch does not claim to be active
  // while the app is still in the old language. Never while following the
  // phone, where the Phone language row holds the tick.
  return { selected: preference !== "system" && row === onScreen, pending };
}

// The row's name with its endonym, so someone who cannot read the UI language
// still hears their own. Once only when the two agree, as French does in French.
export function languageA11yName(
  T: Translator,
  name: string,
  endonym: string,
): string {
  const same =
    name.normalize("NFC").toLowerCase() ===
    endonym.normalize("NFC").toLowerCase();
  return same
    ? name
    : T("settings.language.name_endonym_a11y", { name, endonym });
}
