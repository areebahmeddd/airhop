/**
 * @jest-environment node
 */
// Who spoke in a cell belongs to that cell. Leaving it forgets them, so the
// map holds the cells in use, not every cell visited in a session.

import {
  deriveGeohashIdentity,
  deriveGeohashSeed,
} from "@core/nostr/geohash-identity";
import type { NostrClient } from "@core/nostr/nostr-client";
import { ed25519 } from "@noble/curves/ed25519.js";
import { useChatStore } from "@store/chat-store";
import { finalizeEvent, type Event as NostrEvent } from "nostr-tools";
import { GeohashChannelService } from "../geohash-channel-service";

jest.mock("expo-location", () => ({}));
jest.mock("../location-service", () => ({
  getCoarseLocation: async () => null,
}));

// Teleported, so it subscribes with a fixed geohash and no location fix.
const GEOHASH = "u4pruy";
const CHANNEL = `geohash:${GEOHASH}`;

function speak(text: string): NostrEvent {
  const who = deriveGeohashIdentity(
    deriveGeohashSeed(ed25519.utils.randomSecretKey()),
    GEOHASH,
  );
  return finalizeEvent(
    {
      kind: 20000,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["g", GEOHASH],
        ["n", "someone"],
      ],
      content: text,
    },
    who.privKey,
  );
}

it("forgets a cell's speakers once the cell is left", async () => {
  let onChannelEvent: ((event: NostrEvent) => void) | null = null;
  const client = {
    subscribe: (
      filters: { kinds: number[] }[],
      onEvent: (event: NostrEvent) => void,
    ): { close: () => void } => {
      if (filters[0]?.kinds.includes(20000)) onChannelEvent = onEvent;
      return { close: () => undefined };
    },
    publish: async () => ({ relay: "", ok: true }),
  } as unknown as NostrClient;
  const service = new GeohashChannelService(
    client,
    ed25519.utils.randomSecretKey(),
    "me",
  );

  useChatStore.getState().addChannel(CHANNEL);
  await service.refresh();
  onChannelEvent!(speak("hello"));
  expect(service.participantsFor(CHANNEL)).toHaveLength(1);

  // Left and rejoined well inside the five-minute window: a speaker only
  // filtered by age would still be listed.
  useChatStore.getState().removeChannel(CHANNEL);
  await service.refresh();
  useChatStore.getState().addChannel(CHANNEL);
  await service.refresh();
  expect(service.participantsFor(CHANNEL)).toEqual([]);
});
