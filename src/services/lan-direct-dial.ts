// Direct dial on the local network: a second way onto a LAN link, for peers
// already in a Noise session, on networks that filter mDNS (ships, hotels,
// conferences) while still letting devices reach each other.
//
// Each phone hands its LAN endpoint to Airhop peers inside the session
// (LAN_ENDPOINT, 0x56), and again when its network changes. Of the two, the
// phone whose peer ID sorts lower dials, as the mDNS ring has one side dial, so
// a pair opens one link. The link is the one mDNS opens: same frames, the same
// cap, and identity proven by the announce on it.
//
// The address comes from a peer, so it is held to:
// - a private address on one of this phone's own subnets, one per peer, never
//   a sweep (lan-dial-policy.ts directDialHost);
// - the peer that sent it. The link stays out of the link registry, the only
//   place bytes are written to a link, until the announce on it names that
//   peer, so an address that is no Airhop phone (a printer's port, say) is
//   never sent a byte; one that does not prove itself within PROVE_WITHIN_MS,
//   or names anyone else, is closed;
// - one dial per peer every DIAL_RETRY_MS, kept through a session drop, and
//   no more than MAX_LAN_LINKS connects in that time across peers, inside
//   MAX_LAN_LINKS with the mDNS links and the dials still open. Peers dialed
//   longest ago go first, so addresses that never answer cannot starve one
//   that would;
// - MAX_FAILED_DIALS dials that came to nothing, after which the address is
//   dropped until its peer sends one again. That also retires an address
//   carried over from a network this phone has since left, whose private
//   range the new one may reuse.
//
// A new address is first dialed MDNS_FIRST_MS after it arrives: endpoints are
// traded the moment the listener comes up, when mDNS has not yet found
// anyone, and on a network that lets mDNS through its link would land beside
// this one and take a second of the eight slots for the same pair. An mDNS
// link that lands anyway, after a slow resolve, replaces the dialed one: the
// dialer closes its own, so only one side acts.

import type { LanEndpoint } from "@core/mesh/wire/lan-endpoint-payload";
import type { LocalSubnet } from "@core/move/local-subnet";
import { directDialHost, MAX_LAN_LINKS } from "./lan-dial-policy";

// Long enough that an address nobody answers on (a peer that left, a network
// that isolates clients) costs one connect timeout now and then, short enough
// that a dropped link comes back within a minute.
const DIAL_RETRY_MS = 30_000;
// A connect times out at 5 s and the far end announces the moment it accepts.
const PROVE_WITHIN_MS = 10_000;
// Matches DIAL_REVIEW_MS in lan-controller.ts.
const REVIEW_MS = 15_000;
// Peers whose endpoint is held. A session each, so more than this would be a
// room larger than the link cap could ever serve. The dial times outlast them,
// twice over, so a peer cannot reset its own rate by leaving and coming back.
const MAX_KNOWN_ENDPOINTS = 32;
const MAX_DIAL_TIMES = 64;
// Dials that found no usable host, failed to connect, or were not proven.
const MAX_FAILED_DIALS = 3;
// Past mDNS's first review (DIAL_REVIEW_MS) with time for a resolve.
const MDNS_FIRST_MS = 20_000;
const DIRECT_LINK_PREFIX = "lan-direct-";

export interface LanDirectDialDeps {
  selfPeerID: () => string;
  // Whether this peer already has a LAN link, however it opened.
  isLinked: (peerID: string) => boolean;
  // LAN links open now, mDNS ones included.
  linkCount: () => number;
  localSubnets: () => Promise<LocalSubnet[]>;
  connect: (host: string, port: number, linkID: string) => Promise<void>;
  close: (linkID: string) => void;
  now?: () => number;
  // MDNS_FIRST_MS unless given.
  mdnsFirstMs?: number;
}

// What the announce on a link means for it: not a link dialed here, a dialed
// link its peer just proved, or a dialed link that named someone else and is
// being closed.
export type DirectLinkVerdict = "other" | "proven" | "refused";

// What to do with a LAN link that just connected: an ordinary one opens, one
// dialed here waits for its peer's announce, and one whose dial was abandoned
// is closed unwritten.
export type ConnectedLink = "open" | "hold" | "close";

interface HeldEndpoint {
  endpoint: LanEndpoint;
  failures: number;
  heldSince: number;
}

export class LanDirectDial {
  private listening = false;
  // Bumped whenever listening starts or stops, so a dial that awaited across
  // either gives up.
  private generation = 0;
  // Insertion order is age, so the first key is the one to drop.
  private readonly endpoints = new Map<string, HeldEndpoint>();
  // Every connect in the last DIAL_RETRY_MS, for the limit across peers.
  private recentDials: number[] = [];
  private readonly lastDialAt = new Map<string, number>();
  // Peers whose dial is still finding its host; once it has one, the dial
  // moves to `unproven`.
  private readonly dialing = new Set<string>();
  // Links dialed here and not yet proven, with the peer each must be.
  private readonly unproven = new Map<
    string,
    { peerID: string; timer: ReturnType<typeof setTimeout> }
  >();
  // Links dialed here and proven, by peer.
  private readonly proven = new Map<string, string>();
  private review: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  constructor(private readonly deps: LanDirectDialDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // Whether the LAN transport is up with a listener: dials and endpoints both
  // wait for it, and a stop forgets the links it closed.
  setListening(listening: boolean): void {
    if (this.listening === listening) return;
    this.listening = listening;
    this.generation += 1;
    if (!listening) {
      if (this.review !== null) clearInterval(this.review);
      this.review = null;
      for (const [linkID, { timer }] of this.unproven) {
        clearTimeout(timer);
        this.deps.close(linkID);
      }
      this.unproven.clear();
      this.proven.clear();
      return;
    }
    this.review = setInterval(() => this.dialAll(), REVIEW_MS);
    this.dialAll();
  }

  // Holds a peer's endpoint and tries it. Returns whether it differs from the
  // one held, which is a peer on a new listener.
  offer(peerID: string, endpoint: LanEndpoint): boolean {
    if (peerID === this.deps.selfPeerID()) return false;
    const held = this.endpoints.get(peerID)?.endpoint;
    const changed =
      held === undefined ||
      held.port !== endpoint.port ||
      held.hosts.join() !== endpoint.hosts.join();
    const heldSince = changed
      ? this.now()
      : (this.endpoints.get(peerID)?.heldSince ?? this.now());
    this.endpoints.delete(peerID);
    this.endpoints.set(peerID, { endpoint, failures: 0, heldSince });
    while (this.endpoints.size > MAX_KNOWN_ENDPOINTS) {
      this.forget(this.endpoints.keys().next().value as string);
    }
    // A new address waits out the rate like any dial, so a peer handing over
    // one address after another cannot turn this into a sweep, and mDNS gets
    // its turn first (MDNS_FIRST_MS), so the review dials it.
    void this.dial(peerID);
    return changed;
  }

  // The session with this peer is gone, and with it the reason to dial. Its
  // dial time stays, so coming back does not buy it an early dial.
  forget(peerID: string): void {
    this.endpoints.delete(peerID);
  }

  onConnected(linkID: string): ConnectedLink {
    if (this.unproven.has(linkID)) return "hold";
    return linkID.startsWith(DIRECT_LINK_PREFIX) ? "close" : "open";
  }

  // A direct announce arrived on this link from `peerID`.
  judge(linkID: string, peerID: string): DirectLinkVerdict {
    const pending = this.unproven.get(linkID);
    if (pending === undefined) return "other";
    clearTimeout(pending.timer);
    this.unproven.delete(linkID);
    if (pending.peerID !== peerID) {
      this.failed(pending.peerID);
    } else if (
      // mDNS may have linked the pair, or filled the cap, meanwhile.
      !this.deps.isLinked(peerID) &&
      this.deps.linkCount() < MAX_LAN_LINKS
    ) {
      const held = this.endpoints.get(peerID);
      if (held !== undefined) held.failures = 0;
      this.proven.set(peerID, linkID);
      return "proven";
    }
    this.deps.close(linkID);
    return "refused";
  }

  // Another LAN link (an mDNS one) just bound to `peerID`: a link dialed here
  // to the same peer gives way to it.
  onLanLinkBound(peerID: string, linkID: string): void {
    const dialed = this.proven.get(peerID);
    if (dialed === undefined || dialed === linkID) return;
    this.proven.delete(peerID);
    this.deps.close(dialed);
  }

  linkGone(linkID: string): void {
    for (const [peerID, dialed] of this.proven) {
      if (dialed === linkID) this.proven.delete(peerID);
    }
    const pending = this.unproven.get(linkID);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.unproven.delete(linkID);
    this.failed(pending.peerID);
  }

  dispose(): void {
    this.setListening(false);
    this.endpoints.clear();
    this.lastDialAt.clear();
  }

  // A dial to this peer came to nothing; enough of them drop its address.
  private failed(peerID: string): void {
    const held = this.endpoints.get(peerID);
    if (held === undefined) return;
    held.failures += 1;
    if (held.failures >= MAX_FAILED_DIALS) this.endpoints.delete(peerID);
  }

  private hasOpenDial(peerID: string): boolean {
    if (this.dialing.has(peerID)) return true;
    for (const pending of this.unproven.values()) {
      if (pending.peerID === peerID) return true;
    }
    return false;
  }

  private connectBudgetLeft(now: number): boolean {
    this.recentDials = this.recentDials.filter(
      (at) => now - at < DIAL_RETRY_MS,
    );
    return this.recentDials.length < MAX_LAN_LINKS;
  }

  // Oldest dial first, peers never dialed before any.
  private dialAll(): void {
    const order = [...this.endpoints.keys()].sort(
      (a, b) => (this.lastDialAt.get(a) ?? 0) - (this.lastDialAt.get(b) ?? 0),
    );
    for (const peerID of order) void this.dial(peerID);
  }

  private async dial(peerID: string): Promise<void> {
    const held = this.endpoints.get(peerID);
    if (
      held === undefined ||
      !this.listening ||
      this.hasOpenDial(peerID) ||
      // The lower peer ID dials, so a pair opens one link between them.
      this.deps.selfPeerID() > peerID ||
      this.deps.isLinked(peerID) ||
      this.deps.linkCount() + this.unproven.size + this.dialing.size >=
        MAX_LAN_LINKS
    ) {
      return;
    }
    const now = this.now();
    if (now - held.heldSince < (this.deps.mdnsFirstMs ?? MDNS_FIRST_MS)) {
      return;
    }
    const last = this.lastDialAt.get(peerID);
    if (last !== undefined && now - last < DIAL_RETRY_MS) return;
    if (!this.connectBudgetLeft(now)) return;
    this.lastDialAt.delete(peerID);
    this.lastDialAt.set(peerID, now);
    while (this.lastDialAt.size > MAX_DIAL_TIMES) {
      this.lastDialAt.delete(this.lastDialAt.keys().next().value as string);
    }
    const { endpoint } = held;
    const generation = this.generation;
    this.dialing.add(peerID);
    let host: string | null;
    try {
      const subnets = await this.deps.localSubnets().catch(() => []);
      host = directDialHost(endpoint.hosts, subnets);
    } finally {
      this.dialing.delete(peerID);
    }
    if (!this.listening || this.generation !== generation) return;
    if (host === null) {
      this.failed(peerID);
      return;
    }
    // Charged only for a connect that goes out, so an address with no usable
    // host spends nobody else's turn.
    if (!this.connectBudgetLeft(this.now())) return;
    this.recentDials.push(this.now());
    this.seq += 1;
    const linkID = `${DIRECT_LINK_PREFIX}${String(this.seq)}`;
    // In place before the dial, since the link's connect event can land
    // before the dial resolves.
    const timer = setTimeout(() => {
      if (!this.unproven.delete(linkID)) return;
      this.deps.close(linkID);
      this.failed(peerID);
    }, PROVE_WITHIN_MS);
    this.unproven.set(linkID, { peerID, timer });
    await this.deps.connect(host, endpoint.port, linkID).catch(() => {
      this.linkGone(linkID);
    });
  }
}
