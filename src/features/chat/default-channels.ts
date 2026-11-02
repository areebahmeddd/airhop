// bitchat's default channels: always present and never left, part of the
// protocol rather than anything the user created.

import { type TranslationKey } from "@i18n";
import { DEFAULT_CHANNELS } from "@store/chat-store";

export const DEFAULT_CHANNEL_NAMES = new Set(DEFAULT_CHANNELS);

// Static metadata for each default channel. Keys, not text: the component
// translates them on render.
export const CHANNEL_SCOPE: Record<
  string,
  {
    tagKey: TranslationKey;
    descriptionKey: TranslationKey;
    transportKey: TranslationKey;
  }
> = {
  "#bluetooth": {
    tagKey: "chat.scope.mesh",
    descriptionKey: "chat.scope.mesh_desc",
    transportKey: "chat.transport.bluetooth",
  },
  "#block": {
    tagKey: "chat.scope.block",
    descriptionKey: "chat.scope.block_desc",
    transportKey: "chat.transport.both",
  },
  "#neighborhood": {
    tagKey: "chat.scope.neighborhood",
    descriptionKey: "chat.scope.neighborhood_desc",
    transportKey: "chat.transport.both",
  },
  "#city": {
    tagKey: "chat.scope.city",
    descriptionKey: "chat.scope.city_desc",
    transportKey: "chat.transport.both",
  },
  "#province": {
    tagKey: "chat.scope.province",
    descriptionKey: "chat.scope.province_desc",
    transportKey: "chat.transport.both",
  },
  "#region": {
    tagKey: "chat.scope.country",
    descriptionKey: "chat.scope.country_desc",
    transportKey: "chat.transport.both",
  },
};
