// Every link this device holds, across every transport, and the only place
// bytes are written to one.
//
// A transport here is one that carries links, so BLE and the WiFi fast path.
// Nostr and courier are transports in MessageRouter's sense but hold no
// sockets, so they are not this file's concern.
//
// It holds links and answers questions about them. What it decides is which
// of a peer's links a broadcast goes down, a link-table question, and which
// Bluetooth links are too backed up to take live media (CROWDED_BLE_QUEUE).
// Which packet goes where, what makes a peer count as direct, and what a
// refused write means all stay in services/mesh-service.ts.
//
// Two things a change here must keep. One question gets one answer covering
// every transport, never an answer per transport for the caller to combine.
// And enumeration order is observable, since couriers are the first few
// `directPeers()`, so `TRANSPORT_KINDS` order is load-bearing.
//
// Adding a transport is a member of `TRANSPORT_KINDS` and a writer for it. The
// writers are injected and nothing here imports native code, so this runs in CI
// without a radio.

import { BLE_PACKET_BUDGET } from "../video/live-video-quality";
import { LIVE_WRITE_TTL_MS } from "./write-deadline";

// The order every observable list is enumerated in. Distinct from
// `SEND_PREFERENCE`: this is "what order do we list things in", that is "which
// link do we use".
//
// Bluetooth first, and LAN last: couriers are the first few `directPeers()`,
// and a phone on a busy network holds more LAN peers than Bluetooth ones. A
// Bluetooth neighbor walks away with the mail; a LAN peer is only reachable
// while the network is.
export const TRANSPORT_KINDS = ["ble", "wifi", "lan"] as const;

export type TransportKind = (typeof TRANSPORT_KINDS)[number];

// Which link to take when a peer is reachable on more than one transport,
// fastest first.
//
// WiFi Aware leads: it is a direct radio link with no access point in the path.
// LAN goes phone to router to phone, still far past Bluetooth's ~18 KiB/s.
// Bluetooth is the floor and the fallback.
const SEND_PREFERENCE: readonly TransportKind[] = ["wifi", "lan", "ble"];

// A Bluetooth link whose queue last stood this deep takes no live media, so
// what is queued there already, chat, announces and handshakes included, can
// drain. A second of a stream at Bluetooth's live pace: a stream relayed off
// Wi-Fi Aware or LAN arrives many times faster than one Bluetooth link takes
// it, and would fill the queue to the cap where the radio refuses everything
// else sent to that neighbor.
export const CROWDED_BLE_QUEUE = BLE_PACKET_BUDGET;

export interface Link {
  readonly id: string;
  readonly kind: TransportKind;
}

// Hands bytes to a radio, rejecting when the write did not go. The rejection is
// never interpreted here: a refused BLE write usually means a full queue on a
// healthy link, a refused WiFi unicast is treated as a dead socket, and that
// difference is the caller's to make.
//
// `ttlMs` is how long the write may wait in the link's queue before the radio
// drops it unsent, 0 for never (write-deadline.ts). Resolves to how many writes
// on that link are still waiting for the radio, this one included: Bluetooth's
// queue depth, which a live stream paces itself by. Wi-Fi Aware and LAN stream
// over a socket with no such queue, and resolve 0.
export type LinkWriteFn = (
  linkID: string,
  dataBase64: string,
  ttlMs: number,
) => Promise<number>;

// What one live write down `fastestLinks()` came to: links that took the
// bytes, links that refused them, crowded Bluetooth links passed by unwritten
// (CROWDED_BLE_QUEUE), and how deep the queues typically are (the lower
// median, a skipped link counted at its last reading). The median rather than
// the deepest: a neighbor that walked away stops draining its queue long
// before its link closes, and as the deepest it would drop video for the whole
// room. A radio that is really saturated backs every queue up, which the
// median sees.
export interface FastestResult {
  readonly sent: number;
  readonly refused: number;
  readonly skipped: number;
  readonly queued: number;
}

// Not exported: callers pass an object literal.
interface FastestOptions {
  readonly ttlMs: number;
  // The link the bytes arrived on, for a relay, excluded as `fanout` excludes
  // it: that link, and every link of the peer bound to it.
  readonly exclude?: string;
}

// Not exported: callers pass an object literal.
interface BroadcastOptions {
  // Restrict to one transport.
  readonly kind?: TransportKind;
  // The link the bytes arrived on, for a relay. Nothing goes back down it, nor
  // to the peer bound to it on any other link: that peer already holds them.
  readonly exclude?: string;
  // Every link rather than one per bound peer, for our own direct announce
  // alone. The announce is what binds a link to its peer, so a peer's second
  // link that never hears one stays unbound and takes a copy of everything.
  readonly everyLink?: boolean;
}

export class LinkRegistry {
  // linkID to the transport that opened it, in the order links came up.
  //
  // One table rather than one per transport because the native modules namespace
  // link IDs and they cannot collide: BLE issues `c:<id>` and `p:<id>` on both
  // platforms, WiFi issues `wifi-<n>` / `wifi-in-<n>` / `wifi-out-<n>`, and LAN
  // issues `lan-in-<n>` / `lan-out-<n>`.
  private readonly kindByLink = new Map<string, TransportKind>();

  // linkID to the peer bound to it. Not every open link has one: a link is a
  // socket, and it says nothing about who is on the far end until they announce.
  private readonly peerByLink = new Map<string, string>();

  // peerID to every link bound to it, most recently bound first.
  //
  // A list, not one entry per transport: Bluetooth is dual-role, so two phones
  // that meet each dial the other and hold two BLE links to the same peer. One
  // slot per transport cannot represent that, and closing either link would
  // unbind the other.
  private readonly linksByPeer = new Map<string, string[]>();

  // linkID to the peer a Noise handshake completed with over it while bound to
  // that peer: an announce can be replayed onto any link, a completed
  // handshake cannot. Gone with the binding.
  private readonly provenByLink = new Map<string, string>();

  // linkID to the queue depth its last accepted write reported, and when. A
  // refused write leaves it alone: the refusal says the queue is full without
  // saying how full.
  private readonly depthByLink = new Map<
    string,
    { depth: number; atMs: number }
  >();

  private sent = 0;

  constructor(
    private readonly writers: Readonly<Record<TransportKind, LinkWriteFn>>,
    private readonly now: () => number = Date.now,
  ) {}

  // ---- Lifecycle ----

  // Idempotent, so a repeated event for a link we hold leaves its binding alone.
  open(kind: TransportKind, linkID: string): void {
    if (this.kindByLink.has(linkID)) return;
    this.kindByLink.set(linkID, kind);
  }

  // Returns the peer only when this was its last link, so the caller can run
  // whatever else its departure owes. Sessions, presence and sync budgets are
  // not this file's business.
  //
  // Nothing is returned while the peer still holds another link. It has not
  // gone anywhere, and reporting a departure would retire a live neighbor's
  // session state and drop it off the radar until its next announce.
  close(linkID: string): string | undefined {
    this.kindByLink.delete(linkID);
    this.depthByLink.delete(linkID);
    const peerID = this.peerByLink.get(linkID);
    this.peerByLink.delete(linkID);
    if (peerID === undefined) return undefined;
    return this.dropBinding(peerID, linkID) ? peerID : undefined;
  }

  // Every link on one transport at once, for when the OS withdraws it or the mesh
  // stops. Not equivalent to closing them from outside: in both cases the
  // disconnect events that would have done so are no longer being delivered, so
  // nothing else clears them and a later send goes down a dead socket.
  closeAll(kind: TransportKind): void {
    for (const linkID of this.linkIDs(kind)) this.close(linkID);
  }

  // On the announce, not at link-up, because a link says nothing about who is on
  // the far end. What counts as a direct announce is the caller's decision.
  //
  // Binding adds a link rather than replacing the peer's others, so a peer
  // reached over two transports, or over both Bluetooth roles, keeps all of them.
  // Most recently bound goes first, which is the one a send prefers within a
  // transport.
  bind(linkID: string, peerID: string): void {
    if (!this.kindByLink.has(linkID)) return;
    // A link claimed by a different peer keeps one owner: drop the old claim
    // first, or the two indexes stop agreeing and every query below inherits
    // the disagreement. The announce handler will not do this today, since it
    // refuses a direct announce from a peer other than the bound one.
    const previous = this.peerByLink.get(linkID);
    if (previous !== undefined && previous !== peerID) {
      this.dropBinding(previous, linkID);
    }
    this.peerByLink.set(linkID, peerID);
    const linkIDs = this.linksByPeer.get(peerID) ?? [];
    const existing = linkIDs.indexOf(linkID);
    if (existing !== -1) linkIDs.splice(existing, 1);
    linkIDs.unshift(linkID);
    this.linksByPeer.set(peerID, linkIDs);
  }

  // Forget a peer's binding while leaving the link open, since it may still be
  // relaying for others. `kind` narrows to one transport, which only the LEAVE
  // handler needs.
  unbind(peerID: string, kind?: TransportKind): void {
    const linkIDs = this.linksByPeer.get(peerID);
    if (linkIDs === undefined) return;
    for (const linkID of [...linkIDs]) {
      if (kind !== undefined && this.kindByLink.get(linkID) !== kind) continue;
      this.peerByLink.delete(linkID);
      this.dropBinding(peerID, linkID);
    }
  }

  // Drops one link from a peer's list. Reports whether that was its last, which
  // is what separates a link closing from a peer leaving.
  private dropBinding(peerID: string, linkID: string): boolean {
    this.provenByLink.delete(linkID);
    const linkIDs = this.linksByPeer.get(peerID);
    if (linkIDs === undefined) return false;
    const at = linkIDs.indexOf(linkID);
    if (at !== -1) linkIDs.splice(at, 1);
    if (linkIDs.length > 0) return false;
    this.linksByPeer.delete(peerID);
    return true;
  }

  // A handshake with `peerID` completed over this link. Taken only while the
  // link is bound to that peer: one completed over a relay's link proves only
  // that the peer is somewhere beyond it.
  prove(linkID: string, peerID: string): void {
    if (this.peerByLink.get(linkID) === peerID) {
      this.provenByLink.set(linkID, peerID);
    }
  }

  // ---- Queries ----

  // The trustworthy way to attribute an incoming packet: a `senderID` header is
  // plaintext and forgeable, the far end of a socket we hold is not.
  peerOf(linkID: string): string | undefined {
    return this.peerByLink.get(linkID);
  }

  // The transport a link rides, or undefined for one we do not hold. How a
  // packet has to be cut depends on it: only Bluetooth has a frame ceiling.
  kindOf(linkID: string): TransportKind | undefined {
    return this.kindByLink.get(linkID);
  }

  // The strict test. A peer reachable only by flooding through a neighbor is
  // not here: a flood is a hope, a link is a route.
  hasPeer(peerID: string): boolean {
    return this.linksByPeer.has(peerID);
  }

  // Preference-ordered, so a peer held on both transports comes back on the
  // faster one. `kind` pins it to one transport.
  linkFor(peerID: string, kind?: TransportKind): Link | undefined {
    const links = this.linksFor(peerID);
    return kind === undefined
      ? links[0]
      : links.find((link) => link.kind === kind);
  }

  // Every link to a peer, for callers that cannot use the first one: the relay
  // must not send a packet back down the link it arrived on, and should try the
  // peer's other links before falling back to flooding.
  //
  // Ordered by `SEND_PREFERENCE`, then most recently bound first within a
  // transport, which is the link the peer most recently proved it was on.
  linksFor(peerID: string): readonly Link[] {
    const linkIDs = this.linksByPeer.get(peerID);
    if (linkIDs === undefined) return [];
    const links: Link[] = [];
    for (const kind of SEND_PREFERENCE) {
      for (const id of linkIDs) {
        if (this.kindByLink.get(id) === kind) links.push({ id, kind });
      }
    }
    return links;
  }

  // The peer's preferred link among those a handshake proved, for a write that
  // cannot be taken back, such as handing over carried mail.
  provenLinkFor(peerID: string): Link | undefined {
    return this.linksFor(peerID).find(
      (link) => this.provenByLink.get(link.id) === peerID,
    );
  }

  // One link per announced peer, its fastest, plus every link no peer has
  // announced on yet, since that could be anyone. What live media goes down,
  // from its origin and at every relay: a peer held on Bluetooth and LAN takes
  // the LAN copy alone, and the Bluetooth airtime goes to neighbors with
  // nothing faster. `exclude` is a relay's ingress link, as in `fanout`.
  fastestLinks(exclude?: string): readonly Link[] {
    const ingressPeer =
      exclude === undefined ? undefined : this.peerByLink.get(exclude);
    const links: Link[] = [];
    const seen = new Set<string>();
    for (const linkID of this.linkIDs()) {
      if (linkID === exclude) continue;
      const kind = this.kindByLink.get(linkID);
      if (kind === undefined) continue;
      const peerID = this.peerByLink.get(linkID);
      if (peerID !== undefined && peerID === ingressPeer) continue;
      const fastest = peerID === undefined ? undefined : this.linkFor(peerID);
      const link = fastest ?? { id: linkID, kind };
      if (seen.has(link.id)) continue;
      seen.add(link.id);
      links.push(link);
    }
    return links;
  }

  // In `TRANSPORT_KINDS` order, each transport's in the order its links came up.
  linkIDs(kind?: TransportKind): readonly string[] {
    const ids: string[] = [];
    for (const candidate of TRANSPORT_KINDS) {
      if (kind !== undefined && candidate !== kind) continue;
      for (const [linkID, linkKind] of this.kindByLink) {
        if (linkKind === candidate) ids.push(linkID);
      }
    }
    return ids;
  }

  // Peers we hold a link to, deduplicated, since one peer reached over two
  // transports, or over both Bluetooth roles, is still one peer. `kind` narrows
  // to peers reachable on that transport.
  //
  // Order matters to both callers: a sync request is link-local, so asking a
  // peer three hops away wastes a write, and couriers are the first few of
  // these.
  directPeers(kind?: TransportKind): readonly string[] {
    const peers: string[] = [];
    const seen = new Set<string>();
    for (const linkID of this.linkIDs(kind)) {
      const peerID = this.peerByLink.get(linkID);
      if (peerID === undefined || seen.has(peerID)) continue;
      seen.add(peerID);
      peers.push(peerID);
    }
    return peers;
  }

  // How crowded the mesh looks. The flood router scales relay jitter and the
  // time-critical TTL cap by it.
  //
  // Peers, not links, and Bluetooth only. Both halves matter and both match
  // bitchat, whose degree is `peerRegistry.connectedCount`:
  //
  //   * Peers, because Bluetooth is dual-role. Two phones that meet each dial
  //     the other, so one neighbor is two links, and counting links reads a
  //     room as twice as crowded as it is.
  //   * Bluetooth, because the delay exists for radio contention. Every phone
  //     in earshot hears a packet at the same instant and rebroadcasting
  //     together drowns the room out. A socket on another transport does not
  //     compete for that airtime, so counting it slows the radio down for no
  //     reason.
  degree(): number {
    return this.directPeers("ble").length;
  }

  // Open links. Distinct from `degree`: this counts sockets we hold, which is
  // what the announce reports and what the diagnostics screen shows.
  size(kind?: TransportKind): number {
    if (kind === undefined) return this.kindByLink.size;
    let count = 0;
    for (const linkKind of this.kindByLink.values()) {
      if (linkKind === kind) count++;
    }
    return count;
  }

  // The queue depth this link's last accepted write reported, 0 for a link not
  // written within the live write deadline or not held. An older reading is
  // past use: every live write in that queue has since been dropped unsent.
  queueDepth(linkID: string): number {
    const reading = this.depthByLink.get(linkID);
    if (reading === undefined) return 0;
    if (this.now() - reading.atMs >= LIVE_WRITE_TTL_MS) return 0;
    return reading.depth;
  }

  // Whether live media passes this link by (CROWDED_BLE_QUEUE). Lapsing with
  // the reading means the next live write goes and takes a fresh one, so a
  // neighbor nobody else writes to is not shut out for good.
  private crowded(link: Link): boolean {
    return link.kind === "ble" && this.queueDepth(link.id) >= CROWDED_BLE_QUEUE;
  }

  // ---- Writes ----

  // Accurate by construction, since every write goes through `send`.
  get bytesSent(): number {
    return this.sent;
  }

  // Rejects exactly as the radio did, so callers keep their own failure
  // handling, and resolves to the link's queue depth (LinkWriteFn). A link we
  // do not hold resolves 0 instead: it is the outcome the radio would have
  // produced for a socket that closed a moment ago.
  send(linkID: string, dataBase64: string, ttlMs = 0): Promise<number> {
    const kind = this.kindByLink.get(linkID);
    if (kind === undefined) return Promise.resolve(0);
    this.sent += Math.ceil((dataBase64.length * 3) / 4);
    return this.writers[kind](linkID, dataBase64, ttlMs).then((depth) => {
      // A link closed while the write was in flight stays forgotten.
      if (this.kindByLink.has(linkID)) {
        this.depthByLink.set(linkID, { depth, atMs: this.now() });
      }
      return depth;
    });
  }

  // The writes one broadcast makes, each a list of links tried in turn until
  // one takes the bytes: per transport, one per bound peer, on its most
  // recently bound link with its others behind it, and one per link nobody has
  // announced on, since that could be anyone.
  //
  // One per peer because Bluetooth is dual-role: two phones that meet each dial
  // the other, and writing both links doubles the airtime of everything the
  // mesh floods for a copy the far deduplicator throws away. As bitchat-ios
  // (BLEFanoutSelector). Per transport, so a peer also held on LAN keeps
  // getting its Bluetooth copy.
  private fanout(options: BroadcastOptions): string[][] {
    const ingressPeer =
      options.exclude === undefined
        ? undefined
        : this.peerByLink.get(options.exclude);
    const writes: string[][] = [];
    for (const kind of TRANSPORT_KINDS) {
      if (options.kind !== undefined && kind !== options.kind) continue;
      const covered = new Set<string>();
      for (const linkID of this.linkIDs(kind)) {
        if (linkID === options.exclude) continue;
        const peerID = this.peerByLink.get(linkID);
        if (peerID === undefined) {
          writes.push([linkID]);
          continue;
        }
        if (peerID === ingressPeer) continue;
        if (options.everyLink === true) {
          writes.push([linkID]);
          continue;
        }
        if (covered.has(peerID)) continue;
        covered.add(peerID);
        const peerLinks = this.linksByPeer.get(peerID) ?? [linkID];
        writes.push(peerLinks.filter((id) => this.kindByLink.get(id) === kind));
      }
    }
    return writes;
  }

  // The first link of every write a broadcast with these options would make,
  // so a caller pacing a long stream can tell beforehand that nobody is left
  // to take it.
  fanoutLinks(options: BroadcastOptions = {}): readonly string[] {
    return this.fanout(options).map((links) => links[0]);
  }

  // Resolves to whether at least one link took the bytes. Most callers ignore
  // that; the fragment pacer cannot, because a refused write it does not retry
  // is a file the far side can never finish.
  //
  // A refused write never closes a link: a radio says the same thing when its
  // queue is merely full, and nothing re-adds a link except a fresh connect
  // event that never comes for one that stayed up. Teardown belongs to the
  // disconnect event.
  async broadcast(
    dataBase64: string,
    options: BroadcastOptions = {},
  ): Promise<boolean> {
    const results = await Promise.all(
      this.fanout(options).map((linkIDs) =>
        this.writeFirst(linkIDs, dataBase64, 0),
      ),
    );
    return results.some((queued) => queued !== null);
  }

  // Down `fastestLinks()`, reporting what the writes came to (FastestResult),
  // whose queue depth is the congestion signal a live stream steers by. A
  // crowded link joins the median at its last reading rather than counting as
  // refused, so one neighbor who walked away cannot cut the stream for the rest.
  async broadcastFastest(
    dataBase64: string,
    options: FastestOptions,
  ): Promise<FastestResult> {
    const links = this.fastestLinks(options.exclude);
    const open = links.filter((link) => !this.crowded(link));
    const skippedDepths = links
      .filter((link) => this.crowded(link))
      .map((link) => this.queueDepth(link.id));
    const results = await Promise.all(
      open.map((link) => this.writeFirst([link.id], dataBase64, options.ttlMs)),
    );
    const taken = results.filter((queued): queued is number => queued !== null);
    const depths = [...taken, ...skippedDepths].sort((a, b) => a - b);
    return {
      sent: taken.length,
      refused: results.length - taken.length,
      skipped: skippedDepths.length,
      queued:
        depths.length === 0 ? 0 : depths[Math.floor((depths.length - 1) / 2)],
    };
  }

  // Down the first of a peer's links that takes the bytes, resolving to that
  // link's queue depth, or null when every one refused. A refused Bluetooth
  // write is usually one full queue, and the peer's other link has its own.
  // The first attempt starts synchronously, so a broadcast's writes still all
  // leave in the same tick.
  private async writeFirst(
    linkIDs: readonly string[],
    dataBase64: string,
    ttlMs: number,
  ): Promise<number | null> {
    for (const linkID of linkIDs) {
      const queued = await this.send(linkID, dataBase64, ttlMs).catch(
        () => null,
      );
      if (queued !== null) return queued;
    }
    return null;
  }

  // Onward to everyone but the peer the bytes arrived from. A packet does not
  // need to go back to the peer it just came from, and doing so is how a
  // two-node mesh spins.
  relay(dataBase64: string, ingressLinkID: string): void {
    void this.broadcast(dataBase64, { exclude: ingressLinkID });
  }
}
