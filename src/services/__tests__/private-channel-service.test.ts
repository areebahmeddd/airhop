/**
 * @jest-environment node
 */
// A private room is its key, never its name. Two rooms that share a label, one
// left and one joined later, must never share a Nostr author.

import {
  deriveChannelNostrIdentity,
  generateChannelKey,
} from "@core/mesh/rooms/channel-crypto";
import type { NostrClient } from "@core/nostr/nostr-client";
import { useChatStore } from "@store/chat-store";
import type { Event } from "nostr-tools";
import { PrivateChannelService } from "../private-channel-service";

function fakeClient() {
  const published: Event[] = [];
  const subscribed: string[][] = [];
  const closed: number[] = [];
  const client = {
    publish: (event: Event) => {
      published.push(event);
      return Promise.resolve();
    },
    subscribe: (filters: { authors: string[] }[]) => {
      const index = subscribed.length;
      subscribed.push(filters[0].authors);
      return { close: () => closed.push(index) };
    },
  } as unknown as NostrClient;
  return { client, published, subscribed, closed };
}

beforeEach(() => useChatStore.getState().clearAll());

describe("PrivateChannelService", () => {
  it("publishes a new room under its own key, not a left room's", () => {
    const { client, published } = fakeClient();
    const service = new PrivateChannelService(client, "aabbccdd00112233");
    const oldKey = generateChannelKey();
    const newKey = generateChannelKey();

    service.publish(oldKey, new Uint8Array([1]), "m1");
    service.publish(newKey, new Uint8Array([2]), "m2");

    expect(published[0].pubkey).toBe(
      deriveChannelNostrIdentity(oldKey)?.pubKeyHex,
    );
    expect(published[1].pubkey).toBe(
      deriveChannelNostrIdentity(newKey)?.pubKeyHex,
    );
  });

  it("resubscribes when a label comes to hold a different key", () => {
    const { client, subscribed, closed } = fakeClient();
    const service = new PrivateChannelService(client, "aabbccdd00112233");
    const oldKey = generateChannelKey();
    const newKey = generateChannelKey();

    useChatStore.getState().joinPrivateChannel("#team", oldKey, true);
    service.refresh();
    // Left and rejoined under the same name before the next refresh.
    useChatStore.getState().removeChannel("#team");
    useChatStore.getState().joinPrivateChannel("#team", newKey, true);
    service.refresh();

    expect(closed).toEqual([0]);
    expect(subscribed[1]).toEqual([
      deriveChannelNostrIdentity(newKey)?.pubKeyHex,
    ]);
    service.stop();
  });
});
