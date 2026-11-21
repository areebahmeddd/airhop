// Sending a text row the user already wrote: the transport its channel takes,
// and the status the row settles on. Shared by the chat thread and a reply typed
// into a notification, which has no screen to report to, so every hint the
// thread shows comes back as a notice for the caller to show or drop.

import { useChatStore, type ChatMessage } from "@store/chat-store";
import { usePeerStore } from "@store/peer-store";
import { resolveDisplayName } from "@utils/peer-display-name";
import { isGeoChannel } from "./geohash-channel-service";
import { keepAsContact } from "./keep-as-contact";
import { getMeshService } from "./mesh-service";

export type SendNotice =
  "queued" | "no-reach" | "gateway" | "no-group-key" | "group-queued";

export interface TransmitCallbacks {
  // A hint about how the send went, given only while it is still news.
  notice?: (notice: SendNotice) => void;
  // The row ended "failed": now, or for a channel post when a relay later
  // refused it. A DM the outbox gives up on later fails in its thread only.
  failed?: () => void;
}

// Reads everything from the message and from live getters, so it is safe to
// call from a stale closure (a fired timer, or the thread's unmount flush).
export function transmitMessage(
  msg: ChatMessage,
  callbacks: TransmitCallbacks = {},
): void {
  const { notice = () => {}, failed = () => {} } = callbacks;
  const setStatus = useChatStore.getState().setMessageStatus;
  const msgChannel = msg.channel;
  const fail = (): void => {
    setStatus(msgChannel, msg.id, "failed");
    failed();
  };
  const service = getMeshService();
  if (!service) {
    fail();
    return;
  }
  if (msgChannel.startsWith("dm:")) {
    const dmPeerID = msgChannel.slice(3);
    // Sending to someone saves them as a contact too, so replying to a DM
    // that started inbound keeps them, not just DMs you initiated.
    keepAsContact(
      dmPeerID,
      usePeerStore.getState().getPeer(dmPeerID)?.nickname ??
        resolveDisplayName(dmPeerID),
    );
    const result = service.sendDm(dmPeerID, msg.text, msg.id);
    // "sent"/"sent-nostr" upgrade to delivered/read via receipts. When no
    // route exists now it is either "carried" (a courier took a sealed copy)
    // or "queued" (held locally for retry); both surface the queued notice.
    setStatus(
      msgChannel,
      msg.id,
      result === "needs-courier"
        ? "carried"
        : result === "queued"
          ? "queued"
          : "sent",
    );
    if (result === "needs-courier" || result === "queued") notice("queued");
  } else if (msgChannel.startsWith("group:")) {
    // Private group: seal under the epoch key and broadcast (0x25).
    //
    // A group is Bluetooth-only, so reach is the same question a channel
    // broadcast faces, and it gets the same three answers. Reporting "sent"
    // whenever the packet is merely sealed gives a message to a group nobody is
    // in range of a tick it has not earned. Groups have no delivery receipts on
    // either client, so this tick is all the user gets and it has to be true.
    const sent = service.sendGroupMessage(
      msgChannel.slice("group:".length),
      msg.text,
      msg.id,
    );
    if (!sent.sealed) {
      // We no longer hold the group's key, so the creator removed us. Terminal:
      // unlike every other failure here, walking around does not fix it.
      fail();
      notice("no-group-key");
    } else if (sent.meshLinks > 0) {
      setStatus(msgChannel, msg.id, "sent");
    } else {
      // Sealed but nobody in range. NOT a failure: the packet stays a gossip
      // candidate for six hours, so the first member to come into range and
      // ask for a sync gets it. That is the common case for a group, whose
      // members are rarely all nearby, so failing it would paint most group
      // messages red for something that is about to work.
      setStatus(msgChannel, msg.id, "queued");
      notice("group-queued");
    }
  } else {
    // Three outcomes: it reached a link or a live relay ("sent"), a gateway
    // peer took it to publish for us ("carried"), or it went nowhere. Read
    // from what happened, not from whether the channel may use the internet,
    // or a location channel on Bluetooth alone shows a sent tick.
    //
    // The row's id is the wire id, so a retry is the same message again and
    // collapses with the first copy wherever both land.
    const sent = service.sendChannelMessage(
      msgChannel,
      msg.text,
      msg.id,
      msg.nearbyOnly === true,
    );
    const settle = (reach: typeof sent, announce: boolean): void => {
      if (reach.meshLinks > 0 || reach.nostr) {
        setStatus(msgChannel, msg.id, "sent");
      } else if (reach.gateway) {
        setStatus(msgChannel, msg.id, "carried");
        if (announce) notice("gateway");
      } else if (
        isGeoChannel(msgChannel) ||
        useChatStore.getState().channelKeys[msgChannel] !== undefined
      ) {
        // A location cell's audience is everyone in it, reached over the
        // internet. A Bluetooth neighbor arriving later will sync the packet,
        // but the cell itself never sees it, so this is as far as it goes.
        //
        // A private channel's sealed packet is never kept for sync and its
        // relay publish is one-shot, so nothing sends it later either. Failed
        // is what offers Retry.
        fail();
        if (announce) notice("no-reach");
      } else {
        // A public mesh room's audience IS whoever is in range, and the packet
        // stays a gossip candidate for six hours, so the next neighbor to
        // turn up gets it: waiting, not broken, as in the group branch above.
        setStatus(msgChannel, msg.id, "queued");
        if (announce) notice("no-reach");
      }
    };
    settle(sent, true);
    // Only a relay carried it, on the strength of an open socket. Every relay
    // may still refuse or never answer, so the answer has the last word. No
    // hint then: it could land on whatever thread is open by the time.
    if (sent.meshLinks === 0 && sent.nostr) {
      void sent.settled?.then((reach) => {
        if (!reach.nostr) settle(reach, false);
      });
    }
  }
}
