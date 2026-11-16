// Nostr client: SimplePool with auto-reconnect and optional Tor proxy.
//
// Publish uses first-ACK-wins: the event is sent to all relays and the promise
// resolves on the first OK.
//
// Relay selection: the default pool is the fixed gift-wrap relay set, for DM
// delivery. A location channel or the mesh bridge passes its own list per call,
// from geo-relay.ts.
//
// Tor proxy: this client never touches the socket directly. Routing Nostr
// through Tor is done one level up, by swapping nostr-tools' WebSocket
// implementation (see tor-routing.ts): on iOS for TorWebSocket, which tunnels
// over Arti's SOCKS5 proxy, and on Android by the proxy installed into the
// shared OkHttp client every socket is built from.
//
// Pings catch a socket that went silent without closing, which reconnect alone
// never notices; on React Native they run as a cheap REQ every 29 s.
//
// Auto-reconnect covers a relay that drops after connecting, and only that.
// nostr-tools never retries a relay whose first connect fails: it is dropped,
// with its subscriptions, for the life of this client. So callers build a
// client only once there is a route for it, and build a new one when the
// network comes back.

import { BoundedIdSet } from "@utils/bounded-id-set";
import type { Event, EventTemplate, VerifiedEvent } from "nostr-tools";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import type { AbstractRelay, Subscription } from "nostr-tools/abstract-relay";
import type { Filter } from "nostr-tools/filter";
import type { SubCloser } from "nostr-tools/pool";
import { SimplePool } from "nostr-tools/pool";
import { normalizeURL } from "nostr-tools/utils";
import {
  DEFAULT_DM_RELAYS,
  GEO_RELAY_COUNT,
  MAX_CUSTOM_RELAYS,
} from "./geo-relay";
import { KIND_GIFT_WRAP } from "./gift-wrap";

// Maximum relays in the default pool (DM / gift-wrap traffic).
const MAX_RELAY_COUNT = 5;

// Ceiling for an explicit per-call relay set, deliberately higher than
// MAX_RELAY_COUNT.
//
// A geohash cell's set is its GEO_RELAY_COUNT routed relays (the interop
// rendezvous, which must stay intact) PLUS the user's custom relays, appended
// last by mergeGeoRelays. Capping that back to MAX_RELAY_COUNT would trim from
// the tail and so drop exactly the custom entries, silently undoing the setting
// for anyone who left geo-relay discovery on: the UI would report the relay
// added and it would never be contacted. Sized to hold both halves.
const MAX_OVERRIDE_RELAY_COUNT = GEO_RELAY_COUNT + MAX_CUSTOM_RELAYS;

// How long to wait for a publish ACK from at least one relay. A post a relay
// refused for sign-in takes three round trips (the refusal, the proof, the
// resend), which a slow Tor circuit can stretch past this: the caller then
// sends again a post that landed, and the recipient drops the copy by its id.
const PUBLISH_TIMEOUT_MS = 8_000;

// A relay that misses its first connect is dropped for good (see the header),
// so this covers the slowest honest connect, not the typical one: TLS across a
// three-hop Tor circuit, or a congested cellular link. nostr-tools allows 3 s.
const CONNECT_TIMEOUT_MS = 10_000;

// Ceiling on a one-shot read (querySync). Without it a query resolves only
// once its relay has sent EOSE, which never happens on a connection that went
// away without closing, as when you walk out of Wi-Fi range mid-request.
// The promise would then never settle, and any UI awaiting it stays in its
// loading state for the rest of the session with no way back. Returning
// whatever arrived inside the window is both bounded and honest: these reads
// are best-effort lookups across a relay set that is never guaranteed complete.
// Counted per relay from its connect, so a relay slow to connect adds up to
// CONNECT_TIMEOUT_MS on top.
const QUERY_MAX_WAIT_MS = 6_000;

// How long the inbound pump may run handlers before handing the thread back.
// Under a 16 ms frame, so a full queue costs at most part of one frame's budget
// rather than every frame until it is empty.
const PUMP_SLICE_MS = 8;

// Queue ceiling for that pump. Sized well above any honest burst (a cold start
// with five cells backfilling is low hundreds), so reaching it means a relay is
// flooding us and the right answer is to stop accepting rather than to grow.
const MAX_PENDING_EVENTS = 4_000;

// Event IDs one subscription remembers as delivered. Evicting the oldest costs
// at most a late copy of a long-gone event reaching its handler again, which
// the handler's own dedup absorbs.
const MAX_DELIVERED_IDS = 4_000;

// How often the client re-reads the relay sockets for onConnectionChange.
// nostr-tools reports a connect it was asked for through the pool's hooks, but
// a live socket dropping, and the relay's own reconnect after it, reach no hook
// at all, so without this the callback never sees either. The library retries a
// dropped relay no sooner than every 10 s; half that keeps each transition
// visible within one retry.
const CONNECTION_POLL_MS = 5_000;

// Placeholder passed to a queued EOSE callback, which takes no event but shares
// the queue so it keeps its place in line.
const EOSE_MARKER = {} as Event;

// Backoff for reopening a subscription a relay dropped, doubling from the first
// to the cap. Slow on purpose: a relay that refuses Tor exits refuses every try.
const RESUBSCRIBE_BASE_MS = 15_000;
const RESUBSCRIBE_MAX_MS = 5 * 60_000;

// The prefix a relay closes a read or refuses a post with when it wants
// sign-in first (NIP-42). Matched without the space NIP-42 puts after it.
const AUTH_REQUIRED = "auth-required:";

// A relay's challenge is signed into the proof and sent back, so an outsized
// one is refused rather than echoed. Real challenges are a few dozen
// characters; this leaves room for any relay's format and none for abuse.
const MAX_CHALLENGE_LENGTH = 4_096;

const THROWAWAY = "throwaway";

// Who a relay that demands sign-in (NIP-42) is shown an operation comes from:
// the secret of the key the operation belongs to, or a key made for that one
// sign-in. An operation passing none never signs in, and stays refused there.
export type RelayAuth = Uint8Array | typeof THROWAWAY;

// The one key proven on a relay's connection, and the challenge it signed.
interface SignIn {
  relay: AbstractRelay;
  // The key's public half, or THROWAWAY.
  identity: string;
  challenge: string;
  // nostr-tools keeps an accepted sign-in for its connection, so being asked
  // to sign again after one means the connection is a new one.
  accepted: boolean;
  // Whether the relay answered the proof. nostr-tools stops waiting after
  // 4.4 s, which a slow Tor circuit outlasts; a proof it gave up on may yet be
  // accepted, so the same key may send it again, and no other key may.
  answered: boolean;
}

export interface NostrClientConfig {
  // Called whenever the set of live relay connections crosses the has-any /
  // has-none boundary, so the UI can reflect whether the internet bridge is up.
  onConnectionChange?: (connected: boolean) => void;
}

export interface PublishResult {
  relay: string;
  ok: boolean;
  message?: string;
}

export type EventHandler = (event: Event) => void;
export type EoseHandler = () => void;

export class NostrClient {
  private readonly pool: SimplePool;
  private readonly relays: string[];
  private readonly dmRelays: Set<string>;
  private readonly onConnectionChange?: (connected: boolean) => void;
  // Last reported connectivity, so we only notify on an actual transition.
  private connected = false;
  private readonly connectionPoll: ReturnType<typeof setInterval>;
  // Inbound handler queue and its drain flag. See the pump below.
  private readonly pending: [EventHandler, Event][] = [];
  private draining = false;
  private closed = false;
  private readonly resubscribeTimers = new Set<ReturnType<typeof setTimeout>>();
  // Pool keys of every relay seen live, which tells one in reconnect backoff
  // from one still on its first connect. Bounded by the relays this client
  // has opened, a handful per cell visited.
  private readonly everLive = new Set<string>();
  // Per pool key, the sign-in on its current connection. Forgotten once the
  // relay is seen down, since a reconnect starts without one.
  private readonly signIns = new Map<string, SignIn>();

  constructor(config: NostrClientConfig = {}) {
    this.onConnectionChange = config.onConnectionChange;
    this.pool = new SimplePool({ enableReconnect: true, enablePing: true });
    this.pool.maxWaitForConnection = CONNECT_TIMEOUT_MS;
    // Set as properties: the SimplePool constructor does not accept these in its
    // options. They report only a connect the pool was asked for; the poll below
    // catches a live socket dropping (see CONNECTION_POLL_MS).
    this.pool.onRelayConnectionSuccess = () => this.reconcileConnected();
    this.pool.onRelayConnectionFailure = () => this.reconcileConnected();
    this.connectionPoll = setInterval(
      () => this.reconcileConnected(),
      CONNECTION_POLL_MS,
    );

    const defaults = DEFAULT_DM_RELAYS.map(normalizeRelayUrl).filter(
      Boolean,
    ) as string[];
    this.relays = [...new Set(defaults)].slice(0, MAX_RELAY_COUNT);
    this.dmRelays = new Set(defaults);
  }

  // Active relay URLs (for diagnostics and UI).
  get activeRelays(): string[] {
    return [...this.relays];
  }

  // Whether any relay in the pool is currently live. Lets callers skip a doomed
  // publish (which would otherwise block a full PUBLISH_TIMEOUT_MS before
  // rejecting) and route straight to a mesh gateway uplink. Mirrors bitchat's
  // synchronous relaysConnected() check.
  //
  // Read from the sockets on every call rather than from `connected`, which
  // trails them by up to CONNECTION_POLL_MS: a gateway deciding whether to
  // publish a deposit or hold it must see a relay that dropped a moment ago.
  get isConnected(): boolean {
    return [...this.pool.listConnectionStatus().values()].some(Boolean);
  }

  // Whether one of the default DM relays is live: the only relays a DM, a
  // location DM or a courier drop is published to. A location or custom relay
  // alone keeps isConnected true while every such publish has nowhere to go,
  // so those sends must ask this instead (bitchat-ios isDMRelayConnected).
  get isDMConnected(): boolean {
    for (const [url, live] of this.pool.listConnectionStatus()) {
      // nostr-tools keys the pool by its own normal form, with a trailing
      // slash on a bare host.
      if (live && this.dmRelays.has(url.replace(/\/$/, ""))) return true;
    }
    return false;
  }

  // Recompute "any relay live" and notify only on a has-any / has-none flip, so
  // the UI's internet-bridge indicator tracks real connectivity without churn.
  private reconcileConnected(): void {
    const status = this.pool.listConnectionStatus();
    this.noteStatus(status);
    const any = [...status.values()].some(Boolean);
    if (any !== this.connected) {
      this.connected = any;
      this.onConnectionChange?.(any);
    }
  }

  // Resolve an optional per-call relay override. Everything reaching here is
  // already a wss:// URL (the geo directory and the custom list both come
  // through validateRelayUrl); normalizeRelayUrl is the backstop for a caller
  // passing a bare hostname, the shape bitchat stores its directory in. An empty
  // or all-invalid override falls back to the default pool, so no caller can
  // accidentally publish to nothing.
  private resolveRelays(relays?: string[]): string[] {
    if (relays === undefined || relays.length === 0) return this.relays;
    const normalized = relays
      .map(normalizeRelayUrl)
      .filter(Boolean) as string[];
    return normalized.length > 0
      ? [...new Set(normalized)].slice(0, MAX_OVERRIDE_RELAY_COUNT)
      : this.relays;
  }

  // Subscribe to events matching the given filter.
  //
  // `relays` targets a specific relay set (e.g. the geohash-closest relays for a
  // location channel) instead of the default DM pool. This is what makes public
  // geohash channels interoperate with bitchat: both clients converge on the
  // same geographically-selected relays for a cell. Omit it for DM / gift-wrap
  // traffic, which uses the default pool.
  // Returns a closer function; call it to cancel the subscription.
  //
  // One pool subscription per relay and filter, never one across relays: the
  // pool reports a close only once every relay in a call has closed, and each
  // relay's subscription must be reopened on its own (see `open`). Dedup across
  // relays is ours instead, in bitchat-ios's order: look up, verify, then
  // record. An ID is recorded only once nostr-tools has verified the event and
  // the pump has taken it.
  //
  // Where a reconnect resumes is set here, as each event lands, through
  // nostr-tools' `lastEmitted` (see resumeCursor); dedup absorbs the replay.
  subscribe(
    filters: Filter[],
    onEvent: EventHandler,
    onEose?: EoseHandler,
    relays?: string[],
    auth?: RelayAuth,
  ): SubCloser {
    const targets = this.resolveRelays(relays);
    const delivered = new BoundedIdSet(MAX_DELIVERED_IDS);
    // Every handler goes through the pump, so no subscription can hold the JS
    // thread for longer than one time slice however much a relay sends. The
    // `has` check repeats the lookup below because nostr-tools skips that
    // lookup for a frame whose prefix it cannot read.
    const deliver = (event: Event): void => {
      if (delivered.has(event.id)) return;
      if (this.enqueue(onEvent, event)) delivered.add(event.id);
    };
    // Lookup only. nostr-tools runs it on the raw frame before parsing, so a
    // copy another relay already delivered costs neither JSON.parse nor Schnorr.
    const alreadyHaveEvent = (id: string): boolean => delivered.has(id);
    // EOSE queues behind the events it terminates rather than jumping them, and
    // fires once every relay has finished its backfill (a relay that fails to
    // connect counts as finished). The location rooms' flood limit spares a
    // replay until EOSE, so it must not arrive ahead of the events it ends.
    let backfilling = targets.length * filters.length;
    const oneose =
      onEose === undefined
        ? undefined
        : (): void => {
            backfilling -= 1;
            if (backfilling === 0) this.enqueue(() => onEose(), EOSE_MARKER);
          };
    // nostr-tools drops a relay whose first connect fails, taking this
    // subscription with it: its reconnect covers only sockets that opened once.
    // A relay can also end a subscription itself. Either way nothing would
    // listen there again while the banner still reads connected, so a closed
    // subscription is reopened after a backoff until the caller closes it.
    // Counted once toward EOSE: a reopening is not a second backfill.
    //
    // A relay that wants sign-in closes with AUTH_REQUIRED. Signing in and
    // reopening happen here rather than through nostr-tools' `onauth`, whose
    // reopened subscription is never handed back to the closer, so it would
    // outlive the call (a location's feed running on after leaving the cell).
    // Reopened at once, once per connection; refused again on the same one, it
    // backs off like any other close. nostr-tools ends a refused read's
    // backfill just before reporting the close, so that end is held for a
    // moment: a refusal that signs in hands it to the reopened read, whose own
    // backfill then ends it, and EOSE does not fire ahead of what that relay
    // serves. A refusal arriving after nostr-tools' own EOSE timeout (4.4 s,
    // a slow Tor circuit) finds the end already given, and the signed-in
    // backfill then arrives after it, as live events do.
    let active = true;
    const closers = new Map<string, SubCloser>();
    const reopenedUnder = new Map<string, SignIn>();
    const open = (
      key: string,
      url: string,
      filter: Filter,
      attempt: number,
      countsEose = attempt === 0,
    ): void => {
      const openedAtMs = Date.now();
      let endHeld = false;
      const endBackfill =
        countsEose && oneose !== undefined
          ? (): void => {
              endHeld = true;
              queueMicrotask(() => {
                if (!endHeld) return;
                endHeld = false;
                oneose();
              });
            }
          : undefined;
      const reopenLater = (failures: number): void => {
        const delay = Math.min(
          RESUBSCRIBE_BASE_MS * 2 ** failures,
          RESUBSCRIBE_MAX_MS,
        );
        const timer = setTimeout(() => {
          this.resubscribeTimers.delete(timer);
          if (active && !this.closed) open(key, url, filter, failures + 1);
        }, delay);
        this.resubscribeTimers.add(timer);
      };
      let newest: number | undefined;
      closers.set(
        key,
        this.pool.subscribeMany([url], filter, {
          // The pool calls this on the relay's subscription.
          onevent: function (this: Subscription, event: Event): void {
            newest = Math.max(newest ?? event.created_at, event.created_at);
            this.lastEmitted = resumeCursor(filter, newest);
            deliver(event);
          },
          oneose: endBackfill,
          alreadyHaveEvent,
          onclose: (reasons) => {
            if (!active || this.closed) return;
            const reason = reasons[0]?.reason ?? "";
            if (auth !== undefined && isAuthRequired(reason)) {
              const owesEnd = endHeld;
              endHeld = false;
              void this.signIn(url, auth).then((signIn) => {
                if (!active || this.closed) return;
                if (signIn === null || reopenedUnder.get(key) === signIn) {
                  if (owesEnd) oneose?.();
                  reopenLater(attempt);
                  return;
                }
                reopenedUnder.set(key, signIn);
                open(key, url, filter, attempt, owesEnd);
              });
              return;
            }
            // One that outlived the longest backoff was healthy, so its close
            // starts over. Not EOSE, which a relay that never connected sends.
            reopenLater(
              Date.now() - openedAtMs >= RESUBSCRIBE_MAX_MS ? 0 : attempt,
            );
          },
        }),
      );
    };
    targets.forEach((url) =>
      filters.forEach((filter, i) => open(`${url}|${i}`, url, filter, 0)),
    );
    return {
      close: (reason?: string) => {
        active = false;
        closers.forEach((c) => c.close(reason));
      },
    };
  }

  // Relay traffic arrives on a WebSocket callback, so without this every
  // subscriber handler runs inline on the JS thread the instant an event lands. A
  // handler is not cheap here: it writes a zustand store (and so re-renders),
  // decrypts gift wraps, and walks the notices list. A burst (a cold start with
  // several cells backfilling at once, a busy cell, or simply a relay that
  // decides to send a lot) would run as one unbroken block of JS with no frame
  // in between. The symptom is not a crash but a freeze: animations that
  // need JS between steps stop mid-loop, and taps queue up unanswered, which is
  // indistinguishable from a hang to the person holding the phone.
  //
  // So handlers are queued and drained in slices instead. Ordering is preserved,
  // nothing is dispatched from inside the socket callback, and the thread gets a
  // turn between slices, so the UI stays live under any inbound rate.
  //
  // What this does NOT cover, deliberately: nostr-tools verifies each event's
  // signature inside its own socket handler, before ours is reached. That cost
  // is bounded by asking for less (see the filters in geohash-channel-service),
  // not from here.
  //
  // Returns whether the event was queued, so a subscription treats as delivered
  // only what its handler will actually see.
  private enqueue(handler: EventHandler, event: Event): boolean {
    // Back-pressure rather than unbounded growth. A queue this deep means we are
    // thousands of events behind, at which point the newest are the ones we can
    // most afford to drop: every subscription in the app backfills, so anything
    // missed comes back on the next one.
    if (this.pending.length >= MAX_PENDING_EVENTS) return false;
    this.pending.push([handler, event]);
    this.scheduleDrain();
    return true;
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    setTimeout(() => this.drain(), 0);
  }

  private drain(): void {
    const deadline = Date.now() + PUMP_SLICE_MS;
    while (this.pending.length > 0 && Date.now() < deadline) {
      const next = this.pending.shift();
      if (next === undefined) break;
      const [handler, event] = next;
      try {
        handler(event);
      } catch {
        // One malformed event must not stop the queue behind it. The handlers
        // parse attacker-supplied content, so a throw here is an expected
        // outcome rather than a bug worth taking the pump down for.
      }
    }
    this.draining = false;
    if (this.pending.length > 0) this.scheduleDrain();
  }

  // Publish an event. Resolves when at least one relay ACKs OK, or rejects after
  // PUBLISH_TIMEOUT_MS with no ACK. `relays` targets a specific relay set (see
  // subscribe); omit it for DM / gift-wrap traffic on the default pool.
  //
  // A relay that was live and has dropped is skipped. nostr-tools would open a
  // connect of its own on it in the middle of its reconnect backoff, and when
  // that fails it drops the relay from the pool while the relay object goes
  // on reconnecting unseen: isConnected and isDMConnected then stay false and
  // onConnectionChange never reports the recovery, so nothing held for it is
  // ever sent. Its own reconnect brings it back. A relay never yet live is
  // still tried, which is how a new cell's relays are first opened.
  //
  // A relay that refuses the post for want of sign-in gets it once more, the
  // same event, after signing in as `auth` allows (see signIn).
  async publish(
    event: Event,
    relays?: string[],
    auth?: RelayAuth,
  ): Promise<PublishResult> {
    const targets = this.withoutReconnecting(this.resolveRelays(relays));
    if (targets.length === 0) {
      throw new Error("Publish skipped: every relay is reconnecting");
    }
    return new Promise<PublishResult>((resolve, reject) => {
      let resolved = false;
      const results: PublishResult[] = [];

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const anyOk = results.find((r) => r.ok);
          if (anyOk) {
            resolve(anyOk);
          } else {
            reject(new Error("Publish timeout: no relay ACK"));
          }
        }
      }, PUBLISH_TIMEOUT_MS);

      const promises = this.pool.publish(targets, event);
      targets.forEach((relay, i) => {
        const answer = promises[i];
        if (answer === undefined) return;
        this.resendSignedIn(answer, relay, event, auth)
          .then(() => {
            results.push({ relay, ok: true });
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              resolve({ relay, ok: true });
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ relay, ok: false, message: msg });
            // Every relay has now answered, and all of them refused. Settle on
            // that rather than holding the timer, the event and this closure for
            // the rest of the timeout: the answer cannot change, and the caller
            // is waiting to queue the message for a later retry.
            if (!resolved && results.length === targets.length) {
              resolved = true;
              clearTimeout(timer);
              reject(new Error("Publish rejected by every relay"));
            }
          });
      });
    });
  }

  private resendSignedIn(
    answer: Promise<string>,
    url: string,
    event: Event,
    auth?: RelayAuth,
  ): Promise<string> {
    if (auth === undefined) return answer;
    return answer.catch(async (err: unknown) => {
      if (!isAuthRequired(err) || !(await this.signIn(url, auth))) throw err;
      return this.pool.publish([url], event)[0];
    });
  }

  // Signs in to a relay that asked, and resolves to the sign-in its connection
  // now holds when `auth`'s operation may go ahead under it, or null.
  //
  // A connection proves one key, ever: a second would link the two (a
  // location's key to the main one, say) on that relay. So a connection that
  // has seen a proof, accepted or refused, is never sent one from another key,
  // and a refused proof is not sent again on it, so that relay stays refused.
  // One the relay never answered may be sent again by the same key. A
  // throwaway key stands for no one, so a post that brought one goes out on a
  // connection signed in as anyone.
  // nostr-tools keeps a sign-in for its connection and drops it on reconnect;
  // the record here is dropped once the relay is seen down (noteStatus), or
  // once nostr-tools asks again after an accepted one. Whichever operation is
  // refused first on a connection signs it in: on a reconnect that is a read
  // still open (nostr-tools resends those the moment it opens), but on a first
  // connect, or with the read waiting out a backoff, a post can claim it, and
  // the read stays refused on that relay until the connection drops.
  // `automaticallyAuth` stays off: it answers every challenge with one key,
  // whatever the operation.
  private async signIn(url: string, auth: RelayAuth): Promise<SignIn | null> {
    const key = poolKey(url);
    if (key === null || this.closed) return null;
    const identity = auth === THROWAWAY ? THROWAWAY : getPublicKey(auth);
    let sent: SignIn | undefined;
    try {
      const relay = await this.pool.ensureRelay(url, {
        connectionTimeout: CONNECT_TIMEOUT_MS,
      });
      // Called only when this connection holds no accepted sign-in.
      const sign = async (template: EventTemplate): Promise<VerifiedEvent> => {
        const challenge = template.tags.find((t) => t[0] === "challenge")?.[1];
        const prior = this.signIns.get(key);
        const refusedHere = prior?.relay === relay && !prior.accepted;
        if (
          this.closed ||
          typeof challenge !== "string" ||
          challenge.length === 0 ||
          challenge.length > MAX_CHALLENGE_LENGTH ||
          (refusedHere &&
            ((prior.answered && prior.challenge === challenge) ||
              prior.identity !== identity))
        ) {
          throw new Error("sign-in declined");
        }
        sent = { relay, identity, challenge, accepted: false, answered: false };
        this.signIns.set(key, sent);
        return finalizeEvent(
          template,
          auth === THROWAWAY ? generateSecretKey() : auth,
        );
      };
      await relay.auth(sign);
      const current = this.signIns.get(key);
      if (this.closed || current?.relay !== relay) return null;
      current.accepted = true;
      current.answered = true;
      return current.identity === identity || identity === THROWAWAY
        ? current
        : null;
    } catch (err: unknown) {
      if (sent !== undefined && !String(err).includes("auth timed out")) {
        sent.answered = true;
      }
      return null;
    }
  }

  // Drops the relays that were live once and are down now. One mid first
  // connect also reads as down, but a publish joins that connect rather than
  // starting its own, so only a relay seen live is in backoff.
  private withoutReconnecting(targets: string[]): string[] {
    const status = this.pool.listConnectionStatus();
    this.noteStatus(status);
    return targets.filter((url) => {
      const key = poolKey(url);
      return (
        key === null || status.get(key) !== false || !this.everLive.has(key)
      );
    });
  }

  private noteStatus(status: Map<string, boolean>): void {
    for (const [url, live] of status) if (live) this.everLive.add(url);
    for (const key of this.signIns.keys()) {
      if (status.get(key) !== true) this.signIns.delete(key);
    }
  }

  // Query relays and collect all matching events up to EOSE: each verified,
  // each ID once, and a forged copy from one relay never hiding another's.
  queryEvents(filter: Filter): Promise<Event[]> {
    return this.pool.querySync(this.relays, filter, {
      maxWait: QUERY_MAX_WAIT_MS,
    });
  }

  // Close all relay connections. ALL of them, not just the default set.
  //
  // Not `pool.close(this.relays)`, which closes only the URLs it is handed.
  // `this.relays` is the merged DM set, capped at five, so that leaves behind
  // every socket opened through a per-call relay override: each geohash cell the
  // user has opened, and every bridge rendezvous cell. Those are exactly the
  // relays that know the most about where somebody is.
  //
  // Left open, they would stay connected after the internet is turned off, on
  // going Away, and after a panic wipe, and enabling Tor would rebuild the DM
  // pool on the Tor socket while they stayed on the clear net, holding the
  // device's real IP open to the relays it had just been bridging through.
  // nostr-tools closes a relay on its own only after 20 s with no subscription
  // or publish open on it, and each of those relays holds a subscription for as
  // long as its cell is in use.
  //
  // `destroy()` closes every relay the pool holds and empties its map. The
  // client is single-use either way: every caller builds a fresh one rather
  // than reopening this.
  close(): void {
    // Stopped first, so a closed client reports no further transition and
    // reopens no subscription.
    this.closed = true;
    clearInterval(this.connectionPoll);
    this.resubscribeTimers.forEach(clearTimeout);
    this.resubscribeTimers.clear();
    this.signIns.clear();
    this.pool.destroy();
    // Anything still queued belongs to subscriptions that have just gone away,
    // and its handlers close over a transport this client no longer owns. A
    // pending drain finds an empty queue and stops.
    this.pending.length = 0;
  }
}

// How far a reconnect resumes behind the newest event seen, so a sender whose
// clock runs slow is not skipped. The 15 minutes allowed elsewhere.
const RECONNECT_SKEW_SECONDS = 15 * 60;

// Where a reconnect resumes a subscription (nostr-tools' `lastEmitted`; it
// caps the value at now itself). Left to nostr-tools it is the newest
// `created_at` seen, so one validly signed event from a fast clock would have
// every reconnect skip what was sent meanwhile; it trails the newest by the
// skew instead, and never asks for more than the caller's `since`. A gift wrap
// gets none: its `created_at` is blurred on purpose (15 minutes either side
// here, up to two days back under NIP-59), so a wrap sent after the newest one
// seen can carry an older stamp, and a reconnect repeats the opening `since`.
function resumeCursor(filter: Filter, newest: number): number | undefined {
  if (filter.kinds?.includes(KIND_GIFT_WRAP) === true) return undefined;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cursor = Math.min(newest, nowSeconds) - RECONNECT_SKEW_SECONDS;
  return filter.since === undefined ? cursor : Math.max(filter.since, cursor);
}

function isAuthRequired(reason: unknown): boolean {
  const text = reason instanceof Error ? reason.message : reason;
  return typeof text === "string" && text.startsWith(AUTH_REQUIRED);
}

// The key nostr-tools files a relay under in its pool, or null for a URL it
// would refuse anyway.
function poolKey(url: string): string | null {
  try {
    return normalizeURL(url);
  } catch {
    return null;
  }
}

// Ensure a relay URL starts with wss:// or ws://, and strip a trailing slash.
// Looser than validateRelayUrl by design, not a second copy of it: this is the
// last step before a socket, where the only question is whether there is a URL
// to open. Whether a host may be pinned at all is answered once, at entry.
function normalizeRelayUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\/$/, "");
  if (trimmed.startsWith("wss://") || trimmed.startsWith("ws://")) {
    return trimmed;
  }
  // Accept bare hostnames by adding wss://
  if (!trimmed.includes("://") && trimmed.length > 0) {
    return `wss://${trimmed}`;
  }
  return null;
}
