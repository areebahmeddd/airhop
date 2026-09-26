/**
 * @jest-environment node
 */
// A private room is its key, never its name. Two rooms that share a label, one
// left and one joined later, must never share a Nostr author.

import { bytesToBase64 } from "@core/encoding/base64";
import {
  deriveChannelNostrIdentity,
  generateChannelKey,
  sealChannelMessage,
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

  // Every member signs Nostr events with the room's shared key, so the author
  // inside is only a claim. A copy naming a different author under the same
  // message ID must land as its own row, never in place of the genuine one.
  it("keeps a copy claiming another author apart from the genuine message", () => {
    let deliver: ((event: Event) => void) | null = null;
    const client = {
      publish: () => Promise.resolve(),
      subscribe: (_filters: unknown, onEvent: (event: Event) => void) => {
        deliver = onEvent;
        return { close: () => undefined };
      },
    } as unknown as NostrClient;
    const service = new PrivateChannelService(client, "aabbccdd00112233");
    const key = generateChannelKey();
    useChatStore.getState().joinPrivateChannel("#crew", key, true);
    service.refresh();

    const event = (senderID: string, text: string): Event =>
      ({
        content: bytesToBase64(
          sealChannelMessage(key, {
            msgId: "m-1",
            senderID,
            senderNickname: "someone",
            text,
          }),
        ),
        created_at: Math.floor(Date.now() / 1000),
      }) as unknown as Event;
    deliver!(event("1111111111111111", "the claim"));
    deliver!(event("2222222222222222", "the real words"));

    const rows = useChatStore
      .getState()
      .messages["#crew"].map((m) => [m.senderID, m.text]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ["1111111111111111", "the claim"],
        ["2222222222222222", "the real words"],
      ]),
    );
    service.stop();
  });
});
