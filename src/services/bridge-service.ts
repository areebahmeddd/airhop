// Mesh bridge: stitch separate BLE mesh islands together over the internet.
//
// While bridging, this device republishes its public #bluetooth mesh messages
// to a geohash-cell rendezvous on Nostr (a signed, unlinkable per-cell identity;
// see bridge-event.ts). A separate island subscribed to the same cell renders
// those into its own #bluetooth timeline, so two crowds out of Bluetooth range
// share one public chat. Mesh-only peers (no internet) reach the rendezvous
// through a nearby bridge peer via toBridge/fromBridge carriers.
//
// This mirrors bitchat-ios BridgeService's design (rendezvous events, the loop
// caches, per-role rate limits, a jittered downlink) but keeps the dedup
// simple: both the radio copy and the bridged copy key the timeline row on the
// same content-derived stable ID, so duplicates collapse in either arrival
// order without bitchat's alias-removal bookkeeping. The radio copy still wins
// the row, as in bitchat: the chat store replaces a bridged row when the signed
// radio copy arrives, since the hint the bridged row is keyed on is unsigned.
//
// Two halves, with different consent:
//   - Receiving fromBridge carriers over the radio is passive and leaks
//     nothing, so it runs whatever the toggle and the internet switch say, as
//     in bitchat-ios: two phones side by side should not disagree about what
//     the room said.
//   - Everything that touches the network (subscribing, which tells relays the
//     cell; publishing; accepting deposits; carrying remote messages onto the
//     radio) needs the toggle AND a Nostr client, which exists only while the
//     internet switch is on.
//
// One instance lives as long as its MeshService, and the Nostr client under it
// is swapped on every transport rebuild (a network handoff, a Tor toggle). The
// loop caches and the participants outlive the swap: fresh ones after each
// rebuild would let the new subscription's backfill re-inject, re-downlink and
// re-publish what the previous one already handled.
//
// The subscription covers the own precision-6 cell and its eight neighbours,
// so two islands either side of a cell edge still meet. Publishes go to the
// own cell only, which is symmetric: each side's ring includes the other's
// cell.

import { SlidingWindowLimiter } from "@core/mesh/routing/sliding-window-limiter";
import {
  CarrierDirection,
  encodeNostrCarrier,
  isValidCarrierGeohash,
  type NostrCarrierPacket,
} from "@core/mesh/wire/nostr-carrier";
import {
  bridgeStableID,
  createBridgeMeshEvent,
  createBridgePresenceEvent,
  parseBridgeEvent,
  type ParsedBridgeEvent,
} from "@core/nostr/bridge-event";
import {
  GEO_RELAY_COUNT,
  GeoRelayDirectory,
  mergeGeoRelays,
} from "@core/nostr/geo-relay";
import { loadGeoRelays } from "@core/nostr/geo-relay-source";
import {
  deriveGeohashIdentity,
  deriveGeohashSeed,
  geohashDisplayName,
  type GeohashIdentity,
} from "@core/nostr/geohash-identity";
import { decodeGeohash, encodeGeohash } from "@core/nostr/geohash-presence";
import type { NostrClient } from "@core/nostr/nostr-client";
import { useSettingsStore } from "@store/settings-store";
import { BoundedIdSet } from "@utils/bounded-id-set";
import { geohashNeighbours } from "@utils/geohash-grid";
import { verifyEvent, type Event as NostrEvent } from "nostr-tools";
import { getCoarseLocation } from "./location-service";

// Geohash precision of the rendezvous cell (~1.2 km neighborhood), matching
// bitchat BridgeService.Limits.cellPrecision.
export const CELL_PRECISION = 6;
// Relays to publish/subscribe per cell. Shared with the geohash channels so
// both converge on the same rendezvous set.
const RELAY_COUNT = GEO_RELAY_COUNT;
// Reject rendezvous events outside this clock skew (matches the gateway path).
export const MAX_EVENT_AGE_SECONDS = 15 * 60;
// A rendezvous participant counts toward "across the bridge" for this long.
export const PARTICIPANT_TTL_MS = 10 * 60 * 1000;
// People the "across the bridge" count can hold. Relay ingress is adversarial,
// and a valid signature proves control of one key, not of a person: without a
// cap, rotating keys would grow the count (and the map) without limit.
export const MAX_PARTICIPANTS = 128;
// Airtime budget for downlink rebroadcasts (per rolling minute).
export const DOWNLINK_EVENTS_PER_MINUTE = 20;
// Downlinks waiting for their holdoff or for budget. Drop-oldest past this:
// fresher chat is worth more, and an event dropped here is not yet marked
// rebroadcast, so a relay redelivery can still carry it.
export const MAX_PENDING_DOWNLINKS = 30;
// Holdoff before a downlink goes out. Every online bridger on an island hears
// the same relay event at about the same moment, so sending at once means each
// of them puts it on the radio. The spread lets the first carrier's broadcast
// reach the others, which then stand down (bitchat-ios uses 0.2 to 1.5 s).
export const DOWNLINK_HOLDOFF_MIN_MS = 200;
export const DOWNLINK_HOLDOFF_MAX_MS = 1_500;
// Uplink deposits accepted per depositor per rolling minute.
export const UPLINK_EVENTS_PER_MINUTE_PER_DEPOSITOR = 10;
// Deposits held while no relay is live, bounded in total and per depositor so
// one peer cannot fill the bag (bitchat-ios BridgeService.Limits).
export const MAX_QUEUED_UPLINKS = 20;
export const MAX_QUEUED_UPLINKS_PER_DEPOSITOR = 5;
// Accepted rendezvous events per rolling minute, in total and per signer.
// Bounds the work and state relay or carrier ingress can cost, independently
// of the downlink airtime budget.
export const INBOUND_EVENTS_PER_MINUTE = 600;
export const INBOUND_EVENTS_PER_MINUTE_PER_SIGNER = 120;
// Schnorr checks per rolling minute, valid or not. Spent before the signer is
// known, so invalid events (which never reach the accepted-event limits above)
// cannot force unbounded verification either.
export const SIGNATURE_CHECKS_PER_MINUTE = 720;
// Minimum spacing between our own presence heartbeats.
const PRESENCE_MIN_INTERVAL_MS = 30_000;
// Maintenance tick while bridging: presence, participant pruning, and a cell
// re-resolve that recovers a launch which raced the location permission.
const PRESENCE_INTERVAL_MS = 4 * 60 * 1000;
// Event and radio-copy IDs each loop-prevention set remembers, as bitchat-ios
// (BridgeService.Limits.maxTrackedEventIDs).
export const ID_SET_CAP = 512;
// Prefix that separates the rendezvous identity from the location-channel
// identity for the same cell. Without it the bridge would sign with the user's
// #neighborhood key, and its events, which carry the durable mesh peer ID in
// the `m` tag, would tie that pseudonym to the peer ID. Same label as
// bitchat-ios deriveIdentity(forBridgeRendezvous:).
const RENDEZVOUS_IDENTITY_PREFIX = "bridge|";

// The key every accepted-event count is held under. One limiter instance is the
// total; the per-signer one keys by pubkey.
const ALL = "all";

// A remote-island message to render into the local #bluetooth timeline.
export interface BridgeInboundMessage {
  id: string; // stable timeline id (collapses radio + bridge copies)
  senderKey: string; // `nostr_<pubkey>` of the rendezvous author
  nickname: string;
  text: string;
  timestampMs: number;
}

export interface BridgeStatus {
  active: boolean; // bridging with a known cell
  cell?: string;
  peopleAcross: number;
}

// Wiring supplied by MeshService.
export interface BridgeHooks {
  // Render a remote-island message into the #bluetooth timeline.
  injectMessage(msg: BridgeInboundMessage): void;
  // A reachable peer advertising the bridge capability, or undefined.
  firstReachableBridge(): { peerID: string } | undefined;
  // A rendezvous cell advertised by a reachable bridge peer (ANNOUNCE TLV 0x06),
  // used when we have no location of our own.
  advertisedBridgeCell(): string | undefined;
  // Send a directed, signed toBridge carrier to a bridge peer.
  sendCarrierToBridge(payload: Uint8Array, peerID: string): void;
  // Broadcast a fromBridge carrier onto the mesh (unsigned; receivers verify the
  // carried event's own signature).
  broadcastCarrierFromBridge(payload: Uint8Array): void;
  // Whether any Nostr relay is currently live.
  relaysConnected(): boolean;
  // Our nickname, for outgoing rendezvous events.
  nickname(): string;
  // Report status changes so the banner/header can react.
  onStatus(status: BridgeStatus): void;
  // The rendezvous cell changed, including to or from none. The cell rides in
  // every ANNOUNCE (TLV 0x06), so a mesh-only neighbour learns it only from the
  // next one, and waiting a full cycle leaves it composing for the wrong cell.
  onActiveCellChanged(): void;
}

interface QueuedUplink {
  depositor: string;
  cell: string;
  event: NostrEvent;
}

interface PendingDownlink {
  event: NostrEvent;
  cell: string;
  radioHint: string | undefined;
}

export class BridgeService {
  private readonly relayDirectory = new GeoRelayDirectory();
  private readonly seed: Uint8Array;
  // The relay pool for the current transport, or null while the internet is
  // off or the transport is being rebuilt. Every network action checks it.
  private client: NostrClient | null = null;
  private enabled = false;
  private activeCell: string | null = null;
  // The own cell plus its neighbour ring: what the subscription asks for, and
  // the only cells an inbound event may be signed for.
  private subscribedCells: ReadonlySet<string> = new Set();
  private subscription: { close: () => void } | null = null;
  private readonly identityCache = new Map<string, GeohashIdentity>();

  // Loop prevention, as bitchat-ios BridgeService's caches.
  private readonly publishedEventIDs = new BoundedIdSet(ID_SET_CAP); // our own published events
  private readonly receivedEventIDs = new BoundedIdSet(ID_SET_CAP); // acted-on once
  private readonly rebroadcastEventIDs = new BoundedIdSet(ID_SET_CAP); // ferried to mesh once
  private readonly seenRadioStableIDs = new BoundedIdSet(ID_SET_CAP); // radio copies present
  // Events heard as a fromBridge broadcast. Never published or rebroadcast: the
  // island already has them, and a second bridge echoing them doubles airtime.
  private readonly meshBroadcastEventIDs = new BoundedIdSet(ID_SET_CAP);

  // Rate limiting.
  private readonly uplinkDeposits = new SlidingWindowLimiter(
    UPLINK_EVENTS_PER_MINUTE_PER_DEPOSITOR,
    60_000,
  );
  private readonly inboundTotal = new SlidingWindowLimiter(
    INBOUND_EVENTS_PER_MINUTE,
    60_000,
  );
  private readonly inboundPerSigner = new SlidingWindowLimiter(
    INBOUND_EVENTS_PER_MINUTE_PER_SIGNER,
    60_000,
  );
  private readonly signatureChecks = new SlidingWindowLimiter(
    SIGNATURE_CHECKS_PER_MINUTE,
    60_000,
  );
  private downlinkSendTimes: number[] = [];
  private pendingDownlinks: PendingDownlink[] = [];
  private downlinkTimer: ReturnType<typeof setTimeout> | null = null;
  private queuedUplinks: QueuedUplink[] = [];

  // "People across the bridge" accounting.
  private readonly participants = new Map<string, number>(); // pubkey -> lastSeenMs
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPresenceAtMs = 0;
  // The heartbeat names a precision-6 cell, finer than location presence ever
  // goes, so it is sent only while on screen, as geohash presence is and as
  // bitchat-ios is by being suspended. Carrying deposits and downlinks needs
  // no heartbeat and goes on in the background.
  private foreground = true;

  constructor(
    signingPrivKey: Uint8Array,
    private readonly hooks: BridgeHooks,
  ) {
    this.seed = deriveGeohashSeed(signingPrivKey);
    this.relayDirectory.loadEntries(loadGeoRelays());
  }

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.startNetwork();
      return;
    }
    // Consent withdrawn: other people's parked deposits and the downlinks we
    // owed the island go with it, as does everyone counted across.
    this.closeNetwork();
    this.setActiveCell(null);
    this.queuedUplinks = [];
    this.participants.clear();
    this.uplinkDeposits.reset();
    this.inboundTotal.reset();
    this.inboundPerSigner.reset();
    this.emitStatus();
  }

  // Swap the relay pool under the bridge. Null closes the subscription and
  // stops every timer but keeps the cell, the caches, the participants and
  // any parked deposits, so a rebuild picks up where the last pool left off.
  attachClient(client: NostrClient | null): void {
    if (client === this.client) return;
    this.closeNetwork();
    this.client = client;
    if (client === null) {
      this.emitStatus();
      return;
    }
    if (this.enabled) {
      // The cell is unchanged, so refresh() would not resubscribe it.
      if (this.activeCell !== null) this.openSubscription();
      this.startNetwork();
    }
  }

  // Resolve the rendezvous cell and (re)open its subscription. Safe to call
  // repeatedly; only re-subscribes when the cell changes.
  async refresh(): Promise<void> {
    if (!this.networkAllowed()) return;
    const cell = await this.resolveCell();
    // Re-check after the await: resolveCell() can take seconds on a cold GPS
    // fix, and the user (or a Tor rebuild) may have disabled the bridge in that
    // window. Without this, teardown would run and then this stale call would
    // re-open a relay subscription while disabled, leaking it for the session.
    if (!this.networkAllowed()) return;
    if (cell !== this.activeCell) {
      this.resubscribe(cell);
      this.setActiveCell(cell);
    }
    this.emitStatus();
    this.publishPresence();
  }

  // Reopen the rendezvous subscription against the current relay set. See the
  // matching method on GeohashChannelService for why.
  //
  // Not resubscribe(), which is for a cell change and clears the participants
  // and presence rate limit with it. The cell here is the same, so clearing them
  // would blink the "across the bridge" count to zero for nothing.
  applyRelayChange(): void {
    if (!this.networkAllowed() || this.activeCell === null) return;
    this.openSubscription();
  }

  // Mesh stopped (Away, a panic wipe). Everything transient goes; the loop
  // caches stay, since a return to Online replays the same relay backlog.
  stop(): void {
    this.closeNetwork();
    this.client = null;
    this.setActiveCell(null);
    this.queuedUplinks = [];
    this.participants.clear();
    this.emitStatus();
  }

  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    if (foreground) this.publishPresence();
  }

  // Internet switched off: deposits were accepted on the promise of putting
  // them on the internet, and must not be published if it comes back later.
  dropQueuedUplinks(): void {
    this.queuedUplinks = [];
  }

  private networkAllowed(): boolean {
    return this.enabled && this.client !== null;
  }

  private startNetwork(): void {
    if (!this.networkAllowed()) return;
    void this.refresh();
    this.armPresenceTimer();
    this.flushQueuedUplinks();
  }

  // Close the subscription and cancel every timer that would act on the
  // network. State is left for the caller to decide about.
  private closeNetwork(): void {
    this.subscription?.close();
    this.subscription = null;
    if (this.presenceTimer !== null) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
    if (this.downlinkTimer !== null) {
      clearTimeout(this.downlinkTimer);
      this.downlinkTimer = null;
    }
    this.pendingDownlinks = [];
  }

  private setActiveCell(cell: string | null): void {
    if (cell === this.activeCell) return;
    this.activeCell = cell;
    this.subscribedCells =
      cell === null
        ? new Set()
        : new Set([cell, ...geohashNeighbours(cell).map((n) => n.geohash)]);
    this.hooks.onActiveCellChanged();
  }

  private async resolveCell(): Promise<string | null> {
    const coords = await getCoarseLocation();
    if (coords !== null) {
      return encodeGeohash(coords.lat, coords.lng, CELL_PRECISION);
    }
    // No location of our own: fall back to a cell a nearby bridge advertises,
    // so a mesh-only peer can still deposit into the right rendezvous.
    const advertised = this.hooks.advertisedBridgeCell();
    return advertised !== undefined && isValidCarrierGeohash(advertised)
      ? advertised.slice(0, CELL_PRECISION)
      : null;
  }

  private resubscribe(cell: string | null): void {
    this.subscription?.close();
    this.subscription = null;
    // Everyone counted "across" was across the OLD cell. Carrying them into the
    // new one would inflate the banner with people the user has just walked
    // away from, for as long as their ten-minute presence TTL has left to run.
    this.participants.clear();
    // And let the first heartbeat into the new cell go out immediately rather
    // than waiting out the rate limit from the previous one, which leaves the
    // device in a cell nobody there can see it in for up to half a minute.
    this.lastPresenceAtMs = 0;
    // Downlinks held for the old ring are no longer this island's business.
    this.pendingDownlinks = [];
    if (cell === null) return;
    this.openSubscription(cell);
  }

  // Shared by the cell-change, relay-change and client-swap paths. The relay
  // set is read as the socket opens, for the own cell: the neighbours are a
  // kilometre away, so their nearest relays are the same ones.
  private openSubscription(cell = this.activeCell): void {
    this.subscription?.close();
    this.subscription = null;
    const client = this.client;
    if (client === null || cell === null) return;
    const cells = [cell, ...geohashNeighbours(cell).map((n) => n.geohash)];
    this.subscription = client.subscribe(
      [
        {
          kinds: [20000, 20001],
          "#r": cells,
          since: Math.floor(Date.now() / 1000) - MAX_EVENT_AGE_SECONDS,
        },
      ],
      (event) => this.handleRendezvousEvent(event),
      undefined,
      this.relaysForCell(cell),
    );
  }

  // The cell we advertise to mesh-only peers (ANNOUNCE TLV 0x06). Only when we
  // can actually serve: bridging, online, and with a known cell.
  advertisedBridgeGeohash(): string | undefined {
    if (
      this.networkAllowed() &&
      this.hooks.relaysConnected() &&
      this.activeCell !== null
    ) {
      return this.activeCell;
    }
    return undefined;
  }

  // Whether a toBridge deposit could be acted on at all, so the caller can skip
  // authenticating one we would drop anyway.
  acceptsDeposits(): boolean {
    return this.networkAllowed();
  }

  // ---- Outgoing (sender role) ----

  // Compose and ship the bridged copy of an outgoing public #bluetooth message.
  // Call AFTER the radio send. `timestampMs` must equal the radio packet's
  // timestamp so the bridged copy and the radio copy derive the same stable ID.
  //
  // When it went to live relays, returns whether one accepted it. Otherwise
  // undefined: bridging off, internet off, nearby-only, no cell, or offline,
  // where the only carrier is a bridge peer, a radio neighbour the caller
  // already counts.
  bridgeOutgoing(
    content: string,
    senderPeerID: string,
    timestampMs: number,
    nearbyOnly: boolean,
  ): Promise<boolean> | undefined {
    const client = this.client;
    if (!this.enabled || client === null || nearbyOnly) return undefined;
    const cell = this.activeCell;
    if (cell === null || content.length === 0) return undefined;
    const identity = this.identityFor(cell);
    const event = createBridgeMeshEvent({
      content,
      cell,
      privKey: identity.privKey,
      nickname: this.hooks.nickname(),
      meshSenderID: senderPeerID,
      meshTimestampMs: timestampMs,
    });
    this.publishedEventIDs.add(event.id);
    // Our own radio copy is already on our timeline; note its stable ID so the
    // event coming back from our own subscription is recognised as a local copy.
    this.seenRadioStableIDs.add(
      bridgeStableID(senderPeerID, timestampMs, content),
    );
    if (this.hooks.relaysConnected()) {
      return client.publish(event, this.relaysForCell(cell)).then(
        () => true,
        () => false,
      );
    }
    this.uplinkViaBridgePeer(event, cell);
    return undefined;
  }

  private uplinkViaBridgePeer(event: NostrEvent, cell: string): void {
    const peer = this.hooks.firstReachableBridge();
    if (peer === undefined) return;
    const payload = this.encodeCarrier(CarrierDirection.TO_BRIDGE, cell, event);
    if (payload !== null) this.hooks.sendCarrierToBridge(payload, peer.peerID);
  }

  // ---- Radio-copy accounting ----

  // Record a public #bluetooth radio message so a bridged copy of the same
  // message (same origin sender/timestamp/content) is not rendered twice.
  // Unconditional, because receiving bridged copies is.
  noteRadioMessage(
    senderIDHex: string,
    timestampMs: number,
    content: string,
  ): void {
    this.seenRadioStableIDs.add(
      bridgeStableID(senderIDHex, timestampMs, content),
    );
  }

  // ---- Subscription ingress (internet role) ----

  private handleRendezvousEvent(event: NostrEvent): void {
    if (!this.networkAllowed()) return;
    if (typeof event.id !== "string") return;
    // Only events for our ring, trusting the event's own signed r tag. Read
    // before anything else, since it costs nothing.
    const cell = rendezvousCell(event);
    if (cell === undefined || !this.subscribedCells.has(cell)) return;
    // Skip our own events (both this-session cache and deterministic pubkey
    // self-recognition, so a relay backfill after a restart is still ours).
    if (this.publishedEventIDs.has(event.id)) return;
    if (this.isOwnEvent(event, cell)) {
      this.publishedEventIDs.add(event.id);
      return;
    }
    if (!this.isFresh(event)) return;
    if (this.receivedEventIDs.has(event.id)) return;
    const parsed = parseBridgeEvent(event);
    if (parsed === null || parsed.cell !== cell) return;
    if (!this.verify(event)) return;
    if (!this.allowInbound(event.pubkey)) return;
    this.receivedEventIDs.add(event.id);

    if (parsed.kind === "presence") {
      this.recordParticipant(event.pubkey);
      return;
    }
    if (this.isLocalRadioCopy(parsed.radioMessageIDHint)) return;
    this.injectRemote(event, parsed);
    this.queueDownlink(event, cell, parsed.radioMessageIDHint);
  }

  // Serving duty: carry a remote island's message onto the radio for mesh-only
  // peers, after a holdoff and within the airtime budget. Local-origin events
  // are never rebroadcast (they are already on this island's radio).
  private queueDownlink(
    event: NostrEvent,
    cell: string,
    radioHint: string | undefined,
  ): void {
    if (
      this.meshBroadcastEventIDs.has(event.id) ||
      this.rebroadcastEventIDs.has(event.id) ||
      this.publishedEventIDs.has(event.id) ||
      this.pendingDownlinks.some((p) => p.event.id === event.id)
    ) {
      return;
    }
    this.pendingDownlinks.push({ event, cell, radioHint });
    if (this.pendingDownlinks.length > MAX_PENDING_DOWNLINKS) {
      this.pendingDownlinks.splice(
        0,
        this.pendingDownlinks.length - MAX_PENDING_DOWNLINKS,
      );
    }
    this.scheduleDownlinkDrain(true);
  }

  private scheduleDownlinkDrain(holdoff: boolean): void {
    if (this.pendingDownlinks.length === 0 || this.downlinkTimer !== null) {
      return;
    }
    let delay: number;
    if (holdoff) {
      // Jitter, not a secret: Math.random is enough to spread carriers apart.
      delay =
        DOWNLINK_HOLDOFF_MIN_MS +
        Math.random() * (DOWNLINK_HOLDOFF_MAX_MS - DOWNLINK_HOLDOFF_MIN_MS);
    } else {
      // Budget spent: wait until the oldest send in the window ages out.
      const oldest = Math.min(...this.downlinkSendTimes, Date.now());
      delay = Math.max(50, 60_000 - (Date.now() - oldest));
    }
    this.downlinkTimer = setTimeout(() => {
      this.downlinkTimer = null;
      this.drainDownlinks();
    }, delay);
  }

  private drainDownlinks(): void {
    if (!this.networkAllowed()) {
      this.pendingDownlinks = [];
      return;
    }
    const now = Date.now();
    this.downlinkSendTimes = this.downlinkSendTimes.filter(
      (t) => now - t < 60_000,
    );
    while (
      this.pendingDownlinks.length > 0 &&
      this.downlinkSendTimes.length < DOWNLINK_EVENTS_PER_MINUTE
    ) {
      const item = this.pendingDownlinks.shift();
      if (item === undefined) break;
      const { event, cell, radioHint } = item;
      if (!this.isFresh(event)) continue;
      // Rechecked at send time: during the holdoff another bridge may have put
      // it on the radio, or the signed radio copy may have arrived.
      if (
        this.meshBroadcastEventIDs.has(event.id) ||
        this.rebroadcastEventIDs.has(event.id) ||
        this.isLocalRadioCopy(radioHint)
      ) {
        continue;
      }
      const payload = this.encodeCarrier(
        CarrierDirection.FROM_BRIDGE,
        cell,
        event,
      );
      if (payload === null) continue;
      this.hooks.broadcastCarrierFromBridge(payload);
      // Marked after the send, so an event dropped from a full queue stays
      // retryable on a relay redelivery.
      this.rebroadcastEventIDs.add(event.id);
      this.downlinkSendTimes.push(now);
    }
    this.scheduleDownlinkDrain(false);
  }

  // ---- Mesh carrier ingress (both roles) ----

  handleMeshCarrier(
    carrier: NostrCarrierPacket,
    fromPeerID: string,
    directedToUs: boolean,
  ): void {
    // Cheap structural gate first, on both directions, before the event JSON
    // is even parsed.
    if (!isValidCarrierGeohash(carrier.geohash)) return;
    if (carrier.direction === CarrierDirection.TO_BRIDGE) {
      // A broadcast toBridge is malformed, and a deposit is a request to use
      // our connection, which needs the toggle and the internet.
      if (!directedToUs || !this.networkAllowed()) return;
    } else if (carrier.direction === CarrierDirection.FROM_BRIDGE) {
      if (directedToUs) return; // a directed fromBridge is malformed
    } else {
      return;
    }
    let event: NostrEvent;
    try {
      event = JSON.parse(
        new TextDecoder().decode(carrier.eventJSON),
      ) as NostrEvent;
    } catch {
      return;
    }
    if (typeof event.id !== "string") return;

    // The Schnorr check is the expensive part, so each direction runs its
    // cheap gates first, in bitchat-ios's order (BridgeService
    // handleUplinkDeposit, handleDownlinkBroadcast).
    if (carrier.direction === CarrierDirection.TO_BRIDGE) {
      this.handleUplinkDeposit(carrier, event, fromPeerID);
    } else {
      this.handleDownlink(carrier, event);
    }
  }

  // Gateway role: publish a mesh-only peer's deposit to the rendezvous relays,
  // or hold it until one is live.
  private handleUplinkDeposit(
    carrier: NostrCarrierPacket,
    event: NostrEvent,
    depositor: string,
  ): void {
    const parsed = parseBridgeEvent(event);
    if (parsed === null || parsed.kind !== "message") return;
    if (parsed.cell !== carrier.geohash) return; // r tag must match the carrier
    if (!this.isFresh(event)) return;
    if (
      this.meshBroadcastEventIDs.has(event.id) ||
      this.publishedEventIDs.has(event.id) ||
      this.queuedUplinks.some((q) => q.event.id === event.id)
    ) {
      return;
    }
    if (!this.allowUplinkDeposit(depositor)) return;
    if (!this.verify(event)) return;
    if (this.hooks.relaysConnected()) {
      this.publish(event, carrier.geohash);
    } else {
      // Directed at us, so nobody else holds a copy to carry.
      this.enqueueUplink({ depositor, cell: carrier.geohash, event });
    }
  }

  private enqueueUplink(item: QueuedUplink): void {
    const fromDepositor = this.queuedUplinks.filter(
      (q) => q.depositor === item.depositor,
    ).length;
    if (fromDepositor >= MAX_QUEUED_UPLINKS_PER_DEPOSITOR) return;
    if (this.queuedUplinks.length >= MAX_QUEUED_UPLINKS) {
      this.queuedUplinks.shift();
    }
    this.queuedUplinks.push(item);
  }

  // Publish everything held while no relay was live. Stale entries are
  // dropped: every receiver would refuse them, and relays may too.
  flushQueuedUplinks(): void {
    if (!this.networkAllowed() || !this.hooks.relaysConnected()) return;
    if (this.queuedUplinks.length === 0) return;
    const queued = this.queuedUplinks;
    this.queuedUplinks = [];
    for (const item of queued) {
      if (this.publishedEventIDs.has(item.event.id)) continue;
      if (!this.isFresh(item.event)) continue;
      this.publish(item.event, item.cell);
    }
  }

  private publish(event: NostrEvent, cell: string): void {
    const client = this.client;
    if (client === null) return;
    this.publishedEventIDs.add(event.id);
    void client.publish(event, this.relaysForCell(cell)).catch(() => {});
  }

  // Receiver role: a bridge on this island carried a remote message onto the
  // radio. Not gated on the toggle or the internet (see the header).
  private handleDownlink(carrier: NostrCarrierPacket, event: NostrEvent): void {
    if (this.meshBroadcastEventIDs.has(event.id)) return;
    const parsed = parseBridgeEvent(event);
    if (parsed === null || parsed.kind !== "message") return;
    if (parsed.cell !== carrier.geohash) return;
    if (!this.isFresh(event)) return;
    if (this.publishedEventIDs.has(event.id)) return;
    if (!this.verify(event)) return;
    // Our own message, carried back by a bridge that heard it from a relay:
    // after a restart the published-ID cache is empty, but the derived key is
    // still ours. Checked after the signature, because deriving the key for a
    // cell the carrier names costs a scalar multiplication too, and the
    // signature check is the one that is budgeted.
    if (this.isOwnEvent(event, carrier.geohash)) return;
    // Marked once verified, so a forged copy cannot poison the cache, and even
    // when the relay copy won the race: a downlink of our own still waiting
    // out its holdoff reads this and stands down.
    this.meshBroadcastEventIDs.add(event.id);
    if (this.receivedEventIDs.has(event.id)) return;
    if (!this.allowInbound(event.pubkey)) return;
    this.receivedEventIDs.add(event.id);
    if (this.isLocalRadioCopy(parsed.radioMessageIDHint)) return;
    this.injectRemote(event, parsed);
  }

  // ---- Presence + participants ----

  private publishPresence(): void {
    const client = this.client;
    if (!this.enabled || client === null || this.activeCell === null) return;
    if (!this.foreground || !this.hooks.relaysConnected()) return;
    const now = Date.now();
    if (now - this.lastPresenceAtMs < PRESENCE_MIN_INTERVAL_MS) return;
    this.lastPresenceAtMs = now;
    const identity = this.identityFor(this.activeCell);
    const event = createBridgePresenceEvent(this.activeCell, identity.privKey);
    this.publishedEventIDs.add(event.id);
    void client
      .publish(event, this.relaysForCell(this.activeCell))
      .catch(() => {});
  }

  private armPresenceTimer(): void {
    if (this.presenceTimer !== null) return;
    const tick = (): void => {
      this.presenceTimer = null;
      if (!this.networkAllowed()) return;
      this.pruneParticipants();
      this.publishPresence();
      // Recover a launch that raced the location permission, and migrate cells
      // on a moving device.
      void this.refresh();
      this.armPresenceTimer();
    };
    this.presenceTimer = setTimeout(tick, PRESENCE_INTERVAL_MS);
  }

  private recordParticipant(pubkey: string): void {
    this.pruneParticipants();
    if (
      !this.participants.has(pubkey) &&
      this.participants.size >= MAX_PARTICIPANTS
    ) {
      // The least recently seen goes. A Map iterates in insertion order and
      // every sighting re-inserts below, so the first key is that one.
      const oldest = this.participants.keys().next().value;
      if (oldest !== undefined) this.participants.delete(oldest);
    }
    this.participants.delete(pubkey);
    this.participants.set(pubkey, Date.now());
    this.emitStatus();
  }

  private pruneParticipants(): void {
    const cutoff = Date.now() - PARTICIPANT_TTL_MS;
    for (const [pubkey, seen] of this.participants) {
      if (seen < cutoff) this.participants.delete(pubkey);
    }
  }

  private peopleAcross(): number {
    this.pruneParticipants();
    return this.participants.size;
  }

  // ---- Helpers ----

  private injectRemote(event: NostrEvent, parsed: ParsedBridgeEvent): void {
    if (parsed.content.length === 0) return;
    const parsedTs = Math.min(event.created_at, Math.floor(Date.now() / 1000));
    this.hooks.injectMessage({
      // Key on the content-stable radio ID when present so a later radio copy
      // (or a copy from another gateway) collapses onto the same row; else fall
      // back to the event id.
      id:
        parsed.radioMessageIDHint !== undefined
          ? `mesh-${parsed.radioMessageIDHint}`
          : `bridge-${event.id}`,
      senderKey: `nostr_${event.pubkey}`,
      nickname: geohashDisplayName(event.pubkey, parsed.nickname),
      text: parsed.content,
      timestampMs: parsedTs * 1000,
    });
    this.recordParticipant(event.pubkey);
  }

  private isLocalRadioCopy(hint: string | undefined): boolean {
    return hint !== undefined && this.seenRadioStableIDs.has(hint);
  }

  private isOwnEvent(event: NostrEvent, cell: string): boolean {
    return event.pubkey === this.identityFor(cell).pubKeyHex;
  }

  // The rendezvous identity for a cell: deterministic, so our own events are
  // still recognised after a restart, and never the location-channel key.
  //
  // Only the ring's identities are cached. A fromBridge carrier names any cell
  // it likes, so caching those would be memory anyone in radio range could
  // spend.
  private identityFor(cell: string): GeohashIdentity {
    const cached = this.identityCache.get(cell);
    if (cached !== undefined) return cached;
    const identity = deriveGeohashIdentity(
      this.seed,
      RENDEZVOUS_IDENTITY_PREFIX + cell,
    );
    if (this.subscribedCells.has(cell)) this.identityCache.set(cell, identity);
    return identity;
  }

  private relaysForCell(cell: string): string[] {
    const nearest = this.relayDirectory.closestRelaysToGeohash(
      cell,
      decodeGeohash,
      RELAY_COUNT,
    );
    const { geoRelayDiscovery, customRelays } = useSettingsStore.getState();
    return mergeGeoRelays(
      nearest,
      customRelays,
      geoRelayDiscovery,
      RELAY_COUNT,
    );
  }

  private encodeCarrier(
    direction: CarrierDirection,
    cell: string,
    event: NostrEvent,
  ): Uint8Array | null {
    return encodeNostrCarrier({
      direction,
      geohash: cell,
      eventJSON: new TextEncoder().encode(JSON.stringify(event)),
    });
  }

  private isFresh(event: NostrEvent): boolean {
    return (
      Math.abs(Date.now() / 1000 - event.created_at) <= MAX_EVENT_AGE_SECONDS
    );
  }

  private verify(event: NostrEvent): boolean {
    if (!this.signatureChecks.tryAcquire(ALL, Date.now())) return false;
    return verifyEvent(event);
  }

  // Counted only once the event is verified, so a forger cannot spend a
  // genuine signer's budget.
  private allowInbound(signer: string): boolean {
    const now = Date.now();
    if (
      !this.inboundTotal.allows(ALL, now) ||
      !this.inboundPerSigner.allows(signer, now)
    ) {
      return false;
    }
    this.inboundTotal.record(ALL, now);
    this.inboundPerSigner.record(signer, now);
    return true;
  }

  private allowUplinkDeposit(depositor: string): boolean {
    return this.uplinkDeposits.tryAcquire(depositor, Date.now());
  }

  // Relay connectivity moved under us. Re-publish the status, because `active`
  // depends on it and nothing else recomputes on that edge.
  //
  // Refresh, teardown and an inbound participant event also emit it, but all
  // three need working relays, so without this the banner would claim to be
  // bridging islands for as long as an outage lasts, bounded only by the
  // four-minute presence tick.
  onRelayConnectivityChanged(): void {
    this.emitStatus();
  }

  private emitStatus(): void {
    this.hooks.onStatus({
      // The same predicate the advertised capability uses, relays included,
      // so a phone with the toggle on and every relay down never tells its
      // owner it is bridging islands. A status indicator that over-claims is
      // the failure the banner layer exists to prevent.
      active: this.advertisedBridgeGeohash() !== undefined,
      cell: this.activeCell ?? undefined,
      peopleAcross: this.peopleAcross(),
    });
  }
}

// The cell an event names in its signed `r` tag, read without the rest of the
// parse (which hashes the content).
function rendezvousCell(event: NostrEvent): string | undefined {
  if (!Array.isArray(event.tags)) return undefined;
  const tag = event.tags.find(
    (t) => Array.isArray(t) && t.length >= 2 && t[0] === "r",
  );
  const cell = tag?.[1];
  return typeof cell === "string" && cell.length > 0 ? cell : undefined;
}
