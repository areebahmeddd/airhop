// Private channels bridged over Nostr (the "Bluetooth + Internet" reach).
//
// A private channel is normally BLE-only. When the creator opts into internet
// reach, its encrypted messages are ALSO published to Nostr so members who are
// out of Bluetooth range still receive them. The design mirrors the geohash
// channels, with the channel key standing in for the geohash:
//
//   - Every member derives the SAME Nostr keypair from the channel key
//     (deriveChannelNostrIdentity). Events are published under, and subscribed
//     to by, that single author pubkey. It is unguessable without the key and
//     unlinkable to anyone's real Nostr identity.
//   - The event content is the SAME sealed blob broadcast over BLE, base64'd.
//     A relay stores opaque ciphertext; only key-holders can open it.
//   - The sender-assigned message id is shared with the BLE copy, so a member
//     on both transports collapses the two into one bubble.
//
// Tradeoff (surfaced in the create UI): the author pubkey is a stable tag, so a
// relay can see a private channel's activity pattern, though never its content
// or the members' real identities. BLE-only leaks nothing correlatable.

import { bytesToBase64, tryBase64ToBytes } from "@core/encoding/base64";
import {
  channelRowID,
  deriveChannelNostrIdentity,
  openChannelMessage,
  type ChannelNostrIdentity,
} from "@core/mesh/rooms/channel-crypto";
import { TAG_MESSAGE_ID } from "@core/nostr/geohash-presence";
import type { NostrClient } from "@core/nostr/nostr-client";
import { useBlockedStore } from "@store/blocked-store";
import { useChannelMembersStore } from "@store/channel-members-store";
import { useChatStore } from "@store/chat-store";
import { unverifiedSenderName } from "@utils/peer-display-name";
import type { Event } from "nostr-tools";
import { finalizeEvent } from "nostr-tools";

// Ephemeral Nostr kind for Airhop private-channel messages (20000 = geohash
// chat, 20001 = presence, 20002 = private channel).
const KIND_PRIVATE_CHANNEL = 20002;

// Replay recent history on join so a channel is not empty on arrival; cap the
// burst. Mirrors the geohash channel lookback.
const LOOKBACK_SECONDS = 3600;
const INITIAL_LIMIT = 200;

export class PrivateChannelService {
  private readonly client: NostrClient;
  private readonly localPeerID: string;
  // channel -> the key it was opened with, and its unsubscribe.
  private readonly subscriptions = new Map<
    string,
    { keyB64: string; close: () => void }
  >();
  // Channel key -> derived Nostr identity (cached). Keyed by the key, never the
  // name: a name is a local label, and a new room reusing a left room's name
  // must not publish under, or listen to, the old room's author.
  private readonly identities = new Map<string, ChannelNostrIdentity>();

  constructor(client: NostrClient, localPeerID: string) {
    this.client = client;
    this.localPeerID = localPeerID;
  }

  private identityFor(keyB64: string): ChannelNostrIdentity | null {
    let id = this.identities.get(keyB64);
    if (id === undefined) {
      const derived = deriveChannelNostrIdentity(keyB64);
      if (derived === null) return null;
      id = derived;
      this.identities.set(keyB64, id);
    }
    return id;
  }

  // Subscribe to every joined private channel whose reach is "ble+nostr", and
  // drop subscriptions for channels that were left or switched to BLE-only.
  // Safe to call repeatedly.
  refresh(): void {
    const state = useChatStore.getState();
    const wanted = state.channels.filter(
      (c) =>
        state.channelKeys[c] !== undefined &&
        state.channelReach[c] === "ble+nostr",
    );

    // A label now holding a different key is a different room: the old
    // subscription would decrypt nothing and hide the new room's traffic.
    for (const [channel, sub] of [...this.subscriptions]) {
      if (
        !wanted.includes(channel) ||
        sub.keyB64 !== state.channelKeys[channel]
      )
        this.unsubscribe(channel);
    }
    for (const channel of wanted) {
      if (!this.subscriptions.has(channel)) {
        this.subscribe(channel, state.channelKeys[channel]);
      }
    }
  }

  // Publish an already-sealed private-channel message over Nostr. The author is
  // derived from the key alone.
  publish(keyB64: string, blob: Uint8Array, msgId: string): void {
    const identity = this.identityFor(keyB64);
    if (identity === null) return;
    try {
      const event = finalizeEvent(
        {
          kind: KIND_PRIVATE_CHANNEL,
          created_at: Math.floor(Date.now() / 1000),
          tags: [[TAG_MESSAGE_ID, msgId.slice(0, 32)]],
          content: bytesToBase64(blob),
        },
        identity.privKey,
      );
      void this.client.publish(event).catch(() => undefined);
    } catch {
      // Relay unreachable / signing failure: the BLE broadcast still happened.
    }
  }

  stop(): void {
    for (const channel of [...this.subscriptions.keys()]) {
      this.unsubscribe(channel);
    }
    this.identities.clear();
  }

  private subscribe(channel: string, keyB64: string): void {
    const identity = this.identityFor(keyB64);
    if (identity === null) return;

    const filter = {
      kinds: [KIND_PRIVATE_CHANNEL],
      authors: [identity.pubKeyHex],
      since: Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS,
      limit: INITIAL_LIMIT,
    };

    const closer = this.client.subscribe([filter], (event: Event) => {
      const blob = tryBase64ToBytes(event.content);
      if (blob === null) return;
      const opened = openChannelMessage(keyB64, blob);
      if (opened === null) return;
      // Ignore our own echo (rendered optimistically) and stale membership.
      if (opened.senderID === this.localPeerID) return;
      const chat = useChatStore.getState();
      if (!chat.channels.includes(channel)) return;
      if (chat.channelKeys[channel] !== keyB64) return;
      if (useBlockedStore.getState().isBlocked(opened.senderID)) return;

      const senderNickname = unverifiedSenderName(
        opened.senderID,
        opened.senderNickname,
      );
      // Opening the sealed event proves the sender holds the channel key,
      // which is what membership means here. Same record the BLE path writes
      // (mesh-service onChannelEnc), so both transports feed one roster.
      useChannelMembersStore
        .getState()
        .noteMember(channel, opened.senderID, senderNickname);

      useChatStore.getState().addMessage({
        // Shared with the BLE copy from the same author, so both transports
        // collapse to one bubble and a copy claiming another author cannot.
        id: channelRowID(opened.senderID, opened.msgId),
        channel,
        senderID: opened.senderID,
        senderNickname,
        text: opened.text,
        // Clamped: a future-dated event would pin itself below every message.
        timestampMs:
          Math.min(event.created_at, Math.floor(Date.now() / 1000)) * 1000,
        isMine: false,
      });
    });

    this.subscriptions.set(channel, { keyB64, close: () => closer.close() });
  }

  private unsubscribe(channel: string): void {
    const sub = this.subscriptions.get(channel);
    if (sub !== undefined) {
      sub.close();
      this.subscriptions.delete(channel);
    }
  }
}
