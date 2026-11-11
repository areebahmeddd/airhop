// Attachment file transfer over BLE (or WiFi when available).
//
// Wire model (bitchat-compatible): a whole file is ONE FILE_TRANSFER (0x22)
// packet whose payload is a BitchatFilePacket TLV. The fragment layer splits it
// into BLE fragments that each fit one write and reassembles it on the far side,
// so there is no app-level chunking here. Airhop adds two TLV tags (channel,
// duration) that bitchat skips.
//
//   Send:    file bytes -> BitchatFilePacket TLV -> one FILE_TRANSFER packet
//            -> fragmentPacket -> paced FRAGMENT writes, one BLE frame each
//   Receive: FRAGMENT packets -> FragmentManager reassembles the FILE_TRANSFER
//            packet -> decode TLV -> validate MIME -> cache file -> ChatMessage

import {
  fragmentPacket,
  MAX_BLE_FRAME,
} from "@core/mesh/routing/fragment-manager";
import { originTtl } from "@core/mesh/routing/origin-ttl";
import {
  decodeFilePacket,
  encodeFilePacket,
  isAllowedMime,
  liveVideoStreamOf,
  maxBytesForType,
  mimeMatchesMagic,
  receivedFileName,
  resolveMimeType,
  typeFromMime,
  wireFileName,
} from "@core/mesh/wire/file-packet";
import {
  BROADCAST_ID,
  computePacketId,
  encodePacket,
  Flags,
  isBroadcast,
  isForMe,
  PacketType,
  signPacket,
  type Packet,
} from "@core/mesh/wire/packet-codec";
import { privateMediaStableID } from "@core/mesh/wire/private-media-id";
import { privateVideoStableID } from "@core/mesh/wire/private-video-id";
import { t } from "@i18n";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { useChatStore, type ChatAttachment } from "@store/chat-store";
import { useTransferStore } from "@store/transfer-store";
import {
  attachmentFailureKey,
  AttachmentFailureNotifier,
  type AttachmentFailure,
} from "@utils/attachment-failure";
import { formatBytes } from "@utils/format";
import { BRIDGE_CHANNEL, canSendMedia } from "@utils/media-policy";
import { systemRow } from "@utils/message-text";
import { safeFileName } from "@utils/safe-file-name";
import { stripInvisibles } from "@utils/strip-invisibles";
import * as FileSystem from "expo-file-system";
import {
  deleteUnreferencedAttachments,
  enforceIncomingQuota,
  holdAttachmentFile,
  INCOMING_FILE_PREFIX,
} from "./attachment-cache";
import { sweepMediaIfDue } from "./media-retention";

// ---- Constants and types ----

// Delay between consecutive outbound fragments. Without it the radio drops
// fragments and the transfer never completes on the far side.
//
// Two values, because the cost of a fragment is not the same on both paths: a
// directed one is a single write, a broadcast one is a write per connected link,
// so the same timer costs N times the airtime in a room of N peers. Matches
// bitchat's bleFragmentSpacingDirectedMs / bleFragmentSpacingMs
// (TransportConfig.swift), chosen the same way it chooses them in
// BLEOutboundFragmentPlanner.spacingMs: addressed packets get the shorter one.
//
// Not bitchat's 20ms bleExpectedWritePerFragmentMs, which is not a spacing at
// all: it estimates how long a write takes, and sizes a timeout. bitchat's own
// note on the real constants: "Aggressive pacing causes packet loss; needs
// 25-30ms between fragments for reliable delivery."
const FRAGMENT_SPACING_DIRECTED_MS = 25;
export const FRAGMENT_SPACING_MS = 30;

// Spacing when nothing on the path touches the Bluetooth radio.
//
// The gap above is a Bluetooth requirement, not a protocol one: the stack drops
// fragments handed over faster than it can write them. A socket has flow
// control of its own and needs no help, so the only reason to keep a timer at
// all is to yield between fragments and leave the UI responsive.
//
// Fragment SIZE does not change with it. The receiver reassembles by index, the
// next hop may be Bluetooth, and bitchat refuses an over-size frame as it
// decodes, so 467 bytes is protocol and stays whatever carries it.
const FAST_LINK_SPACING_MS = 0;

// How long to wait after the radio REFUSES a fragment before offering it again.
//
// The spacing above assumes the link can always take the next write, and one-way
// that is roughly true. It stops being true the moment the same link is also
// carrying a transfer in the other direction, which is what two people sending a
// photo at the same time does. The stack's write queue fills, it starts
// refusing, and backing off is the only thing that lets it drain.
const REFUSED_BACKOFF_MS = 60;

// How many consecutive refusals a single transfer tolerates before it is
// declared failed. At the backoff above this is about fifteen seconds of a link
// that will not take a single byte, which is a peer that has gone, not a busy
// radio. Counted per transfer so one dead conversation cannot fail another.
const REFUSAL_LIMIT = 250;

// Progress-store write throttle: refresh the card ~4x/sec rather than on every
// drained fragment.
const PROGRESS_UPDATE_MS = 250;

// Slack past a Bluetooth queue's estimated drain before a file counts as sent:
// once the queue is empty, the last fragment still needs a few connection
// intervals to go out.
const DRAIN_MARGIN_MS = 500;

export interface AttachmentMeta {
  type: ChatAttachment["type"];
  name: string;
  mimeType: string;
  durationMs: number;
  // Optional WhatsApp-style caption. Rides the file packet as an Airhop TLV that
  // bitchat skips, so the media and its caption travel as one message.
  caption?: string;
}

// Both resolve to whether the RADIO ACCEPTED the packet, not whether anyone
// received it (there are no per-fragment acknowledgments on this wire). A
// false is the transport saying "my write queue is full, do not hand me another
// one yet", which is the difference between pacing and losing a file: a refused
// fragment that is not offered again is a stream the far side can never
// complete, and it has no way to ask for it.
//
// On Bluetooth, accepted means queued on the link, not sent: a disconnect can
// still discard it. See BleQueuesFn.
//
// "Paced" is in the names because TypeScript will not defend that boolean.
// message-router's BroadcastFn/UnicastFn are a fire-and-forget `=> void` pair,
// and a `Promise<boolean>` is silently assignable to a `void` return: crossing
// the two type-checks, and the only symptom is dropped fragments on a busy
// radio.
export type PacedBroadcastFn = (packet: Packet) => Promise<boolean>;
export type PacedUnicastFn = (
  recipientPeerID: string,
  packet: Packet,
) => Promise<boolean>;

// Told once per attachment whether it actually left the device, so the bubble
// can settle on "sent" or fall back to the red tap-to-retry mark instead of
// claiming a send the radio refused.
export type SendOutcome = (delivered: boolean) => void;

// Seal a file TLV inside the peer's Noise session as payload 0x20, returning
// the NOISE_ENCRYPTED packet ready to fragment. Returns null when the peer has
// not proven it can read one (no session, or no authenticated bit 8), and the
// DM then does not go: it is never sent in the clear.
//
// Injected rather than reached for, so this service keeps knowing nothing about
// sessions, capabilities or the registry.
export type SealFileFn = (
  recipientPeerID: string,
  fileTlv: Uint8Array,
) => Packet | null;

// Whether a fragment for this recipient will put bytes on the Bluetooth radio,
// which is the only thing fragment spacing exists for. A channel fragment goes
// down every link at once, so it is Bluetooth as soon as one Bluetooth link is
// held.
export type UsesBleRadioFn = (
  recipientPeerID: string,
  isDM: boolean,
) => boolean;

// Whether a DM recipient still holds a link to us. Asked only after a refusal,
// to tell a peer that has gone from a radio that is busy. Absent, every
// refusal is treated as busy. Never asked for a channel file, which any link
// can carry.
export type IsReachableFn = (recipientPeerID: string) => boolean;

// A Bluetooth link a fragment just went down, and its queue depth as the write
// reported it.
export interface BleQueue {
  readonly linkID: string;
  readonly depth: number;
}

// The Bluetooth links an accepted fragment for this recipient went down, asked
// as the write resolves. A Bluetooth write resolves once queued, and a
// disconnect discards the queue, so a file counts as sent only after its last
// writes have had time to drain, and fails if one of these links goes first
// (onLinkGone). Wi-Fi Aware and LAN are left out: a socket write has no queue
// to lose. Absent or empty, a file counts as sent with its last fragment.
export type BleQueuesFn = (
  recipientPeerID: string,
  isDM: boolean,
) => readonly BleQueue[];

// Answer a sealed photo or voice note with a DELIVERED carrying its stable ID,
// which is what the sender's bubble is keyed by (bitchat's private media
// receipt). Injected for the same reason as SealFileFn.
export type AckPrivateFileFn = (
  senderPeerID: string,
  messageID: string,
) => void;

// Naming lives in wireFileName(), which owns the extension and bitchat's
// stable-ID shape together. Nothing here may put localized UI copy on the wire:
// a display word is not a file name, and one without an extension arrives as a
// file the OS cannot open.

// The one send failure worth repeating to the sender verbatim: it names a
// limit they can do something about. Everything else that can go wrong in here
// is a runtime fault, and the UI says so in its own words rather than putting a
// stack-machine message in front of a person.
export class AttachmentTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentTooLargeError";
  }
}

// How an over-size attachment refers to itself in the error the sender reads.
// Exported so the composer can refuse an oversized file at pick time with the
// same wording the transfer layer uses when it catches one late.
export function sizeLabel(type: ChatAttachment["type"]): string {
  switch (type) {
    case "image":
      return t("transfer.this.photo");
    case "video":
      return t("transfer.this.video");
    case "voice":
      return t("transfer.this.voice");
    default:
      return t("transfer.this.file");
  }
}

interface ServiceIdentity {
  peerID: string;
  signingPrivKey: Uint8Array;
}

// ---- FileTransferService ----

export class FileTransferService {
  private readonly identity: ServiceIdentity;
  private readonly broadcast: PacedBroadcastFn;
  private readonly unicast: PacedUnicastFn;
  private readonly resolveNickname: (peerID: string) => string;

  // Send-side progress accounting, keyed by the UI transfer id.
  private readonly outbound = new Map<
    string,
    {
      remaining: number;
      totalBytes: number;
      sentBytes: number;
      lastPushMs: number;
      // Consecutive refusals from the radio for this transfer's fragments.
      // Reset by any accepted write; see REFUSAL_LIMIT.
      refusals: number;
      // Whether its first fragment has reached the radio. See drainOne.
      started: boolean;
      // Bluetooth link to when its last write of ours should have drained.
      drainsBy: Map<string, number>;
      // A DM rides one link; a room file reaches every neighbor.
      isDM: boolean;
      // Set once every fragment is queued, until it counts as sent.
      settleTimer: ReturnType<typeof setTimeout> | null;
      onOutcome?: SendOutcome;
    }
  >();

  // Paced outbound queue (one fragment per tick).
  private readonly outQueue: {
    pkt: Packet;
    isDM: boolean;
    recipientPeerID: string;
    transferId?: string;
    weight?: number;
  }[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  // Whether a fragment is with the transport right now. See drainOne.
  private draining = false;
  // Monotonic, so back-to-back sends cannot collide on a transfer id.
  private transferSeq = 0;

  private readonly sealFile?: SealFileFn;
  private readonly usesBleRadio?: UsesBleRadioFn;
  private readonly isReachable?: IsReachableFn;
  private readonly getDegree: () => number;
  private readonly ackPrivateFile?: AckPrivateFileFn;
  private readonly bleQueuesFor?: BleQueuesFn;
  // Hands a finished live stream's file to the row the stream left; true when
  // it took the row. Set by mesh-service once live video is running.
  absorbLiveVideo?: (
    senderPeerID: string,
    channel: string,
    streamID: string,
    attachment: ChatAttachment,
  ) => boolean;
  // Whether the spam filter hides a public attachment. Set by mesh-service,
  // which owns the filter its public text goes through.
  hidesAsSpam?: (
    senderPeerID: string,
    messageID: string,
    timestampMs: number,
  ) => boolean;

  // Throttles the "that attachment didn't arrive" line, per sender.
  private readonly failureNotifier = new AttachmentFailureNotifier();

  constructor(
    identity: ServiceIdentity,
    broadcast: PacedBroadcastFn,
    unicast: PacedUnicastFn,
    resolveNickname: (peerID: string) => string,
    sealFile?: SealFileFn,
    usesBleRadio?: UsesBleRadioFn,
    isReachable?: IsReachableFn,
    // Our neighbor count, which a public file's TTL follows (see
    // origin-ttl.ts). 0 (sparse) when not given.
    getDegree: () => number = () => 0,
    ackPrivateFile?: AckPrivateFileFn,
    bleQueuesFor?: BleQueuesFn,
  ) {
    this.identity = identity;
    this.broadcast = broadcast;
    this.unicast = unicast;
    this.resolveNickname = resolveNickname;
    this.sealFile = sealFile;
    this.usesBleRadio = usesBleRadio;
    this.isReachable = isReachable;
    this.getDegree = getDegree;
    this.ackPrivateFile = ackPrivateFile;
    this.bleQueuesFor = bleQueuesFor;
  }

  // Receive a fully reassembled FILE_TRANSFER packet from the fragment layer.
  onFileTransfer(packet: Packet): void {
    if (bytesToHex(packet.senderID) === this.identity.peerID) return;
    void this.handleIncoming(packet);
  }

  // Receive a file that arrived sealed inside a Noise session (payload 0x20).
  //
  // Confidentiality and authenticity both come from the session it arrived in:
  // the packet decrypted under a session whose remote static key hashes to this
  // peer ID, which says more about the sender than a signature carried beside
  // the file would. So there is no separate signature to check here, as with a
  // DM voice burst.
  onSealedFile(senderPeerID: string, fileTlv: Uint8Array): void {
    if (senderPeerID === this.identity.peerID) return;
    void this.handleIncoming(
      {
        type: PacketType.FILE_TRANSFER,
        ttl: 0,
        flags: Flags.HAS_RECIPIENT,
        senderID: hexToBytes(senderPeerID),
        recipientID: hexToBytes(this.identity.peerID),
        timestamp: Date.now(),
        signature: new Uint8Array(64),
        payload: fileTlv,
      },
      true,
    );
  }

  // Cancel an outgoing transfer by its UI id (incoming files reassemble in the
  // fragment layer and simply time out if abandoned).
  cancel(transferId: string): void {
    if (transferId.startsWith("tx-")) {
      const tx = this.outbound.get(transferId);
      // Delete the accounting BEFORE clearing the queue: a fragment already
      // awaiting the radio checks for it on the way back, and its absence is
      // what stops a canceled transfer requeueing itself.
      this.outbound.delete(transferId);
      if (tx?.settleTimer != null) clearTimeout(tx.settleTimer);
      for (let i = this.outQueue.length - 1; i >= 0; i--) {
        if (this.outQueue[i].transferId === transferId) {
          this.outQueue.splice(i, 1);
        }
      }
      // The bubble is still showing "sending". Settle it, or it sits on a clock
      // face forever for a transfer that is never coming back.
      tx?.onOutcome?.(false);
    }
    useTransferStore.getState().cancel(transferId);
  }

  // Send a file as one BitchatFilePacket. DMs unicast to the peer (routed by
  // recipient ID, as bitchat does); channel attachments broadcast and carry the
  // channel in an Airhop TLV so they land in the right room.
  sendBytes(
    fileBytes: Uint8Array,
    meta: AttachmentMeta,
    channel: string,
    onOutcome?: SendOutcome,
  ): void {
    // Per-type send budget (see maxBytesForType), checked before anything is
    // queued so the sender gets a reason about their file, not a transfer.
    const cap = maxBytesForType(meta.type);
    if (fileBytes.length > cap) {
      throw new AttachmentTooLargeError(
        t("transfer.too_large", {
          kind: sizeLabel(meta.type),
          size: formatBytes(fileBytes.length, true),
          cap: formatBytes(cap),
        }),
      );
    }

    const isDM = channel.startsWith("dm:");
    const recipientPeerID = isDM ? channel.slice(3) : "";
    // Type first, then name: both sides read the type off the extension once
    // the file is on disk, so the name follows the MIME. Never the picker's raw
    // value, since an empty or unrecognized type is dropped on arrival.
    const mimeType = resolveMimeType(meta.mimeType, meta.name || undefined);
    const fileName = wireFileName(meta.type, meta.name, mimeType);

    const tlv = encodeFilePacket({
      fileName,
      mimeType,
      content: fileBytes,
      // A DM is routed by the packet's recipient ID (bitchat-compatible), so we
      // omit the channel tag; a channel attachment carries it for Airhop routing.
      channel: isDM ? undefined : channel,
      durationMs: meta.durationMs > 0 ? meta.durationMs : undefined,
      caption:
        meta.caption && meta.caption.length > 0 ? meta.caption : undefined,
    });
    // Empty, or past the codec's ceiling: nothing can go out, and the bubble
    // must not sit on "sending" waiting for a transfer that never began.
    if (tlv === null) {
      onOutcome?.(false);
      return;
    }

    // A private file goes only inside the Noise session, sealed as 0x20. The
    // signed cleartext form is not confidential, every node it crosses reads
    // the whole file, and bitchat classes it as a legacy fallback it is
    // removing, so a DM that cannot be sealed does not go.
    let pkt: Packet;
    if (isDM) {
      const sealed = this.sealFile?.(recipientPeerID, tlv) ?? null;
      if (sealed === null) {
        onOutcome?.(false);
        return;
      }
      pkt = sealed;
    } else {
      pkt = {
        type: PacketType.FILE_TRANSFER,
        // A public file crosses Bluetooth as fragments, which inherit this TTL
        // and are relayed as fragments are, so it takes their ceiling.
        ttl: originTtl(PacketType.FRAGMENT, this.getDegree()),
        flags: Flags.SIGNED,
        senderID: hexToBytes(this.identity.peerID),
        recipientID: new Uint8Array(BROADCAST_ID),
        timestamp: Date.now(),
        signature: new Uint8Array(64),
        payload: tlv,
      };
      pkt.signature = signPacket(pkt, this.identity.signingPrivKey);
    }

    // One packet becomes many BLE fragments; a small file may fit in one frame.
    const items: Packet[] =
      encodePacket(pkt).length > MAX_BLE_FRAME
        ? fragmentPacket(pkt, this.identity)
        : [pkt];

    // A counter, not just the clock: two attachments queued in the same
    // millisecond would otherwise share an id, and the second would take over
    // the first's progress accounting and leave its card stuck.
    this.transferSeq += 1;
    const transferId = `tx-${this.identity.peerID}-${String(Date.now())}-${String(this.transferSeq)}`;
    const perItemBytes = fileBytes.length / (items.length || 1);
    this.outbound.set(transferId, {
      remaining: items.length,
      totalBytes: fileBytes.length,
      sentBytes: 0,
      lastPushMs: Date.now(),
      refusals: 0,
      started: false,
      drainsBy: new Map(),
      isDM,
      settleTimer: null,
      onOutcome,
    });
    useTransferStore.getState().begin({
      id: transferId,
      direction: "send",
      channel,
      peerLabel: isDM ? this.resolveNickname(recipientPeerID) : "",
      type: meta.type,
      name: fileName,
      totalBytes: fileBytes.length,
      startedAtMs: Date.now(),
      // Waits its turn in the FIFO; the stall clock starts when it gets one.
      queued: true,
    });

    for (const item of items) {
      this.enqueue(item, isDM, recipientPeerID, transferId, perItemBytes);
    }
  }

  private enqueue(
    pkt: Packet,
    isDM: boolean,
    recipientPeerID: string,
    transferId?: string,
    weight?: number,
  ): void {
    this.outQueue.push({ pkt, isDM, recipientPeerID, transferId, weight });
    // Paced from the first fragment, not just between them. Scheduling this one
    // on the Bluetooth gap and the rest on the real one costs a transfer its
    // whole head start on a link that never needed the gap.
    this.scheduleDrain(this.spacingFor(isDM, recipientPeerID));
  }

  // Spacing owed after handing over a fragment.
  //
  // Bluetooth decides it: if any link on the path is a radio, the whole
  // transfer is paced for the radio, since the queue that overflows is shared.
  // Only when nothing on the path is Bluetooth can the gap go.
  //
  // Absent the caller's answer this stays on the Bluetooth timings. A transfer
  // that is slower than it needed to be is a nuisance; one paced faster than
  // the radio can take drops fragments and never completes.
  private spacingFor(isDM: boolean, recipientPeerID: string): number {
    if (this.usesBleRadio?.(recipientPeerID, isDM) === false) {
      return FAST_LINK_SPACING_MS;
    }
    return isDM ? FRAGMENT_SPACING_DIRECTED_MS : FRAGMENT_SPACING_MS;
  }

  private scheduleDrain(delayMs: number): void {
    if (this.draining || this.drainTimer !== null) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      void this.drainOne();
    }, delayMs);
  }

  // Hand exactly one fragment to the radio and react to what it says.
  //
  // The whole file depends on this being honest. Counting progress the instant a
  // fragment is handed over lets a refused write march the sender to 100% and
  // "sent" while the receiver waits forever on a stream missing its third
  // fragment. A refusal keeps the fragment instead: it goes back to the front of
  // the queue (order matters to nothing on the wire, but retrying out of order
  // would leave gaps behind), the pacing eases off to let the stack drain, and
  // nothing is counted as sent until it is.
  private async drainOne(): Promise<void> {
    const next = this.outQueue.shift();
    if (next === undefined) return;

    // Its turn has come, so its card's stall clock starts now rather than at
    // the moment it joined the queue behind somebody's minute-long transfer.
    if (next.transferId !== undefined) {
      const starting = this.outbound.get(next.transferId);
      if (starting !== undefined && !starting.started) {
        starting.started = true;
        useTransferStore.getState().advance(next.transferId, 0);
      }
    }

    let accepted = false;
    // Held across the await, and only the await.
    //
    // `drainTimer` is cleared before this runs, so without a second flag an
    // enqueue landing while the transport is still answering starts a parallel
    // drain: two loops shifting one queue, handing the radio fragments twice as
    // fast as the spacing allows. That is the packet loss the spacing exists to
    // prevent, and a second transfer beginning during a first is ordinary.
    //
    // Released before the tail re-schedules below, which is safe because
    // everything after the await is synchronous and nothing can interleave with
    // it. Releasing later would swallow that schedule and stall the queue.
    this.draining = true;
    try {
      accepted = next.isDM
        ? await this.unicast(next.recipientPeerID, next.pkt)
        : await this.broadcast(next.pkt);
    } catch {
      // A transport that threw is a transport that did not take it.
      accepted = false;
    } finally {
      this.draining = false;
    }

    const tx =
      next.transferId !== undefined
        ? this.outbound.get(next.transferId)
        : undefined;

    if (accepted) {
      if (tx !== undefined) {
        tx.refusals = 0;
        this.noteBleQueues(tx.drainsBy, next.recipientPeerID, next.isDM);
      }
      if (next.transferId !== undefined) {
        this.reportSendProgress(next.transferId, next.weight ?? 0);
      }
    } else if (next.transferId === undefined) {
      // Not part of a tracked transfer, so there is no card to fail and nobody
      // waiting on it. Drop it rather than retrying forever.
    } else if (tx === undefined) {
      // Canceled while this fragment was in flight. Its accounting is already
      // gone, so requeueing would resurrect a transfer the user stopped.
    } else {
      tx.refusals += 1;
      // A DM whose peer has no link left cannot be taken by any amount of
      // backing off, and retrying it holds the shared queue for everyone
      // else's attachments for the full refusal budget.
      const unreachable =
        next.isDM && this.isReachable?.(next.recipientPeerID) === false;
      if (unreachable || tx.refusals >= REFUSAL_LIMIT) {
        this.failTransfer(next.transferId);
      } else {
        this.outQueue.unshift(next);
      }
    }

    if (this.outQueue.length > 0) {
      this.scheduleDrain(
        accepted
          ? this.spacingFor(next.isDM, next.recipientPeerID)
          : REFUSED_BACKOFF_MS,
      );
    }
  }

  // Give up on a transfer the radio will not carry: drop its queued fragments,
  // fail its card, and tell the caller so the bubble stops claiming it was sent.
  private failTransfer(transferId: string): void {
    const tx = this.outbound.get(transferId);
    this.outbound.delete(transferId);
    if (tx?.settleTimer != null) clearTimeout(tx.settleTimer);
    for (let i = this.outQueue.length - 1; i >= 0; i--) {
      if (this.outQueue[i].transferId === transferId) {
        this.outQueue.splice(i, 1);
      }
    }
    useTransferStore.getState().fail(transferId);
    tx?.onOutcome?.(false);
  }

  private reportSendProgress(transferId: string, weight: number): void {
    const tx = this.outbound.get(transferId);
    if (tx === undefined) return;
    tx.sentBytes += weight;
    tx.remaining -= 1;
    const store = useTransferStore.getState();
    const now = Date.now();
    if (tx.remaining <= 0) {
      const drainsBy = Math.max(now, ...tx.drainsBy.values());
      if (drainsBy <= now) {
        this.settleSent(transferId);
        return;
      }
      // Every fragment is queued, so the card can read 100% while the last
      // of them drain; "sent" waits for them.
      store.advance(transferId, tx.totalBytes);
      tx.settleTimer = setTimeout(() => {
        this.settleSent(transferId);
      }, drainsBy - now);
      return;
    }
    if (now - tx.lastPushMs >= PROGRESS_UPDATE_MS) {
      tx.lastPushMs = now;
      store.advance(transferId, tx.sentBytes);
    }
  }

  private settleSent(transferId: string): void {
    const tx = this.outbound.get(transferId);
    if (tx === undefined) return;
    this.outbound.delete(transferId);
    useTransferStore.getState().finish(transferId);
    // Every fragment has left the radio, as far as this side can tell. Only a
    // sealed photo or voice note hears more, through its stable-ID DELIVERED;
    // nothing else does.
    tx.onOutcome?.(true);
  }

  // When each Bluetooth queue an accepted fragment went into should be empty
  // again: its depth at the pace this file feeds it, since a radio that kept
  // up with the spacing drains at least that fast. Only the latest write per
  // link counts, as everything before it sits ahead of it in the same queue.
  private noteBleQueues(
    drainsBy: Map<string, number>,
    recipientPeerID: string,
    isDM: boolean,
  ): void {
    const queues = this.bleQueuesFor?.(recipientPeerID, isDM) ?? [];
    if (queues.length === 0) return;
    const spacing = isDM ? FRAGMENT_SPACING_DIRECTED_MS : FRAGMENT_SPACING_MS;
    const now = Date.now();
    for (const { linkID, depth } of queues) {
      drainsBy.set(linkID, now + depth * spacing + DRAIN_MARGIN_MS);
    }
  }

  // A link closed. Its native queue went with it, so a DM that still had
  // fragments waiting in it fails, and the bubble offers Retry rather than
  // claiming a file the far side never finished. A room file fails only when
  // no Bluetooth link is left carrying it: one neighbor walking away mid-send
  // must not cost everyone else theirs. A link whose share has drained took
  // everything it was given.
  onLinkGone(linkID: string): void {
    const now = Date.now();
    for (const [transferId, tx] of [...this.outbound]) {
      const drainsBy = tx.drainsBy.get(linkID);
      if (drainsBy === undefined || now >= drainsBy) continue;
      tx.drainsBy.delete(linkID);
      if (tx.isDM || tx.drainsBy.size === 0) this.failTransfer(transferId);
    }
  }

  get pendingCount(): number {
    return this.outQueue.length;
  }

  // Record a refused attachment, and tell the reader when it is theirs to know.
  //
  // Silent everywhere except an existing direct-message thread:
  //
  //   - A broadcast failure is nobody's in particular, and anyone in range can
  //     put a malformed packet on the air.
  //   - The thread must already exist, or a stranger could conjure a
  //     conversation in someone's list out of pure garbage. Same shape as the
  //     channel-tag check above.
  //   - Throttled per sender even then, since a directed packet can be sent
  //     repeatedly by anyone in range.
  private noteRejected(
    senderPeerID: string,
    directedToMe: boolean,
    reason: AttachmentFailure,
  ): void {
    if (!directedToMe) return;
    const channel = `dm:${senderPeerID}`;
    const chat = useChatStore.getState();
    if (!chat.channels.includes(channel)) return;
    if (!this.failureNotifier.shouldNotify(senderPeerID, Date.now())) return;

    chat.addMessage({
      id: `ft-fail-${senderPeerID}-${Date.now()}`,
      channel,
      senderID: senderPeerID,
      senderNickname: this.resolveNickname(senderPeerID),
      // Airhop's words, so the row re-reads them in the language it is opened
      // in later.
      ...systemRow(attachmentFailureKey(reason)),
      timestampMs: Date.now(),
      isMine: false,
      isSystem: true,
    });
  }

  // Decode, validate, cache, and render an incoming file.
  // `sealed` says the bytes arrived inside a Noise session rather than in the
  // open. It is set only by onSealedFile, where the session has already proven
  // the sender and the addressee, so the two wire-level checks below (is this
  // for me, and is the claimed sender real) are already answered.
  private async handleIncoming(packet: Packet, sealed = false): Promise<void> {
    const senderPeerID = bytesToHex(packet.senderID);

    // Resolved from the header alone, before the payload is touched, so a
    // packet that fails to decode can still be told apart from one that was
    // simply passing through on its way to somebody else. Relayed traffic must
    // stay silent: it is not our failure and not our business.
    const directedToMe =
      sealed || isForMe(packet, hexToBytes(this.identity.peerID));

    const fp = decodeFilePacket(packet.payload);
    if (fp === null) {
      this.noteRejected(senderPeerID, directedToMe, "malformed");
      return;
    }
    // Reject a disallowed or mislabeled type before writing anything to disk.
    if (!isAllowedMime(fp.mimeType)) {
      this.noteRejected(senderPeerID, directedToMe, "unsupported-type");
      return;
    }
    if (!mimeMatchesMagic(fp.mimeType, fp.content)) {
      this.noteRejected(senderPeerID, directedToMe, "type-mismatch");
      return;
    }

    // A directed attachment is for its addressee alone. A relay forwards it
    // (handleRaw already has) but must not deliver it: otherwise every node on
    // the path writes a private file to its own cache and renders it in its own
    // thread with the sender. bitchat scopes it the same way in
    // BLEFileTransferPolicy.deliveryPlan ("relay only, do not deliver").
    if (!sealed && !isBroadcast(packet) && !directedToMe) {
      return;
    }

    // The channel tag is attacker-controlled, an arbitrary string read off the
    // wire, so it never decides unchecked where the file lands:
    //
    //   - It may name only where media may travel. An attachment is signed but
    //     not encrypted, so one landing in a private #channel or a group breaks
    //     the promise that room makes.
    //   - It may never name a DM. A DM is addressed by recipient ID and never
    //     tagged (bitchat routes DM attachments the same way), so a tag naming
    //     one is a forgery that would put the file in that contact's thread,
    //     which shows no sender. acceptPublicMessage refuses the same for text.
    //   - It must name a room the user joined, as onChannelMsg requires, or any
    //     peer in range could add rooms to someone's list.
    //
    // The untagged fallbacks below come from the packet's own routing, not from
    // the sender's choice of string.
    if (fp.channel !== undefined) {
      if (fp.channel.startsWith("dm:") || !canSendMedia(fp.channel)) return;
      if (!useChatStore.getState().channels.includes(fp.channel)) return;
    }

    // Route: the Airhop channel tag if present, else a DM to us by sender, else
    // the public mesh room.
    const channel =
      fp.channel ??
      (isBroadcast(packet) ? BRIDGE_CHANNEL : `dm:${senderPeerID}`);
    const isDM = channel.startsWith("dm:");
    // An untagged broadcast lands in the public room, and someone who left it
    // stays out: a stranger's photo must not put it back in their list.
    // Silent, as for text: it is not the sender's failure.
    if (!isDM && !useChatStore.getState().channels.includes(channel)) return;
    // Judged before anything is written, under the packet's own ID so every
    // copy of it gets the one verdict. Silent, as hidden text is.
    if (
      !isDM &&
      this.hidesAsSpam?.(
        senderPeerID,
        `file-${bytesToHex(computePacketId(packet))}`,
        packet.timestamp,
      ) === true
    ) {
      return;
    }
    const type = typeFromMime(fp.mimeType);

    // A sealed photo or voice note is keyed by bitchat's stable ID, and an
    // Airhop video note or clip by Airhop's own: the one the sender's bubble
    // waits to hear back. A second arrival is the sender retrying after a lost
    // receipt, so it is answered again, not stored twice.
    const stableID =
      sealed && isDM
        ? (privateMediaStableID(
            senderPeerID,
            this.identity.peerID,
            fp.fileName,
          ) ??
          privateVideoStableID(senderPeerID, this.identity.peerID, fp.fileName))
        : null;
    if (
      stableID !== null &&
      (useChatStore.getState().messages[channel] ?? []).some(
        (m) => m.id === stableID,
      )
    ) {
      this.ackPrivateFile?.(senderPeerID, stableID);
      return;
    }

    // Validated above, so this is what the share sheet and the player are told.
    const mimeType = fp.mimeType?.trim().toLowerCase();
    // The extension follows the validated MIME before writing: the photo
    // library and the audio player read the type off it and ignore the MIME.
    // Truncate first, so a long name loses its middle rather than its
    // extension.
    const safeName = receivedFileName(
      safeFileName(fp.fileName || "file"),
      mimeType ?? "",
    );
    const file = new FileSystem.File(
      FileSystem.Paths.cache,
      `${INCOMING_FILE_PREFIX}${String(Date.now())}_${safeName}`,
    );
    try {
      // The age bound beside the size bound. A phone left receiving in the
      // background for weeks never comes back to the app, where the sweep
      // otherwise runs; throttled, so nearly every arrival skips it.
      sweepMediaIfDue();
      enforceIncomingQuota(fp.content.length);
      file.create({ overwrite: true, intermediates: true });
      // Sync on purpose: from the duplicate and joined-room checks above to
      // the store below must not yield, or a retry arriving meanwhile is
      // stored twice and concurrent arrivals overrun the quota.
      file.writeSync(fp.content);
    } catch {
      // Half a file would count toward Storage until the age sweep.
      try {
        file.delete();
      } catch {
        // Never created.
      }
      // Decoded and validated, then the disk refused it. Worth saying out loud:
      // unlike the checks above, this one is the receiver's problem to fix
      // (free space, permissions) rather than the sender's to resend around.
      this.noteRejected(senderPeerID, directedToMe, "storage");
      return;
    }

    // Held until a row has it: absorbing a live stream removes that stream's
    // other rows first, and a row trimmed on arrival takes the file with it
    // only once the store has settled.
    const releaseFile = holdAttachmentFile(file.uri);
    try {
      const attachment: ChatAttachment = {
        type,
        uri: file.uri,
        // Shown in the bubble, the notification and the share sheet's title,
        // where an override could disguise the extension.
        name:
          fp.fileName !== undefined
            ? stripInvisibles(fp.fileName, { singleLine: true })
            : undefined,
        mimeType,
        durationMs: fp.durationMs ?? undefined,
        sizeBytes: fp.content.length,
      };

      // A finished live stream takes over the row its stream left, rather than
      // showing the same video twice.
      const streamID = type === "video" ? liveVideoStreamOf(fp.fileName) : null;
      if (
        streamID !== null &&
        this.absorbLiveVideo?.(senderPeerID, channel, streamID, attachment) ===
          true
      ) {
        if (stableID !== null) this.ackPrivateFile?.(senderPeerID, stableID);
        return;
      }

      // A first attachment from someone opens the conversation, as a first DM
      // does. A room is never created here: only joined ones get this far.
      if (isDM) useChatStore.getState().addChannel(channel);
      const stored = useChatStore.getState().addMessage({
        id: stableID ?? `ft-${senderPeerID}-${Date.now()}`,
        channel,
        senderID: senderPeerID,
        senderNickname: this.resolveNickname(senderPeerID),
        // The caption rides with the file, so the received bubble shows the
        // media and its caption together, exactly as the sender composed it.
        text: fp.caption ?? "",
        timestampMs: Date.now(),
        isMine: false,
        attachment,
      });
      // Refused as older than the thread's last clear: no row will ever show
      // the file, so it goes once released below.
      if (!stored) deleteUnreferencedAttachments([file.uri]);
      // After the write, so a file the disk refused is not acknowledged. Also
      // when a cleared thread dropped the row: it did arrive.
      if (stableID !== null) this.ackPrivateFile?.(senderPeerID, stableID);
    } finally {
      releaseFile();
    }
  }
}
