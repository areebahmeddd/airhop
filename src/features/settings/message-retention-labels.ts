// The words for a disappearing-messages choice, shared by the General default
// and each chat's own timer, so the two pickers read alike.

import type { PluralTranslator, TranslationKey, Translator } from "@i18n";
import type { MessageRetentionDays } from "@store/settings-store";

// Keyed on the union, so a value added to the options without its words fails
// to compile rather than rendering a blank row.
export const MESSAGE_RETENTION_DESCRIPTION: Record<
  MessageRetentionDays,
  TranslationKey
> = {
  0: "settings.general.message_retention_off_desc",
  1: "settings.general.message_retention_1_desc",
  7: "settings.general.message_retention_7_desc",
  30: "settings.general.message_retention_30_desc",
};

export function messageRetentionLabel(
  T: Translator,
  TP: PluralTranslator,
  days: MessageRetentionDays,
): string {
  return days === 0
    ? T("common.off")
    : TP("settings.general.retention_days", days);
}
