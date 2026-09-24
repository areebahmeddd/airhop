// The old phone's side of a transfer: dial the scanned code, prove it is that
// phone, stop the mesh, send everything, and erase only on the new phone's
// commit.
//
// The mesh stops before the snapshot so nothing lands in a store already
// copied, and its goodbye retires remotes' sessions with this identity. Once
// the stream has ended with no commit, neither answer is safe to guess, so the
// phone stays frozen and asks.

import { loadIdentity } from "@core/crypto/identity";
import type { NoiseSession } from "@core/crypto/noise-xx";
import { buildOffer, chunksOf } from "@core/move/move-bundle";
import { MoveHandshake, type HandshakeStep } from "@core/move/move-handshake";
import type { MoveInvite } from "@core/move/move-invite";
import {
  decodeMoveMessage,
  encodeAbort,
  encodeChunk,
  encodeEnd,
  encodeOffer,
  encodeOfferBody,
  encodeReleased,
  MoveAbortReason,
  type MoveMessage,
} from "@core/move/move-wire";
import { APP_VERSION } from "@data/app-info";
import { sha256 } from "@noble/hashes/sha2.js";
import { settleOr } from "@utils/with-timeout";
import { destroyMeshService } from "./mesh-service";
import {
  closeMove,
  dialMove,
  MoveDialError,
  stopMoveLink,
  subscribeMoveLink,
  writeMove,
  type MoveLinkEvent,
} from "./move-link";
import { clearMoveMarker, setMoveMarker } from "./move-marker";
import { snapshotForMove } from "./move-snapshot";
import { stopNutzapWatcher } from "./nutzap-watcher-handle";
import { panicWipe } from "./panic-wipe";
import { resetWalletService } from "./wallet-service";

export type SenderFailure =
  // Another network, or one that isolates clients.
  | "unreachable"
  // iOS refused local network access.
  | "permission"
  | "wrong-phone"
  | "incompatible"
  | "cancelled"
  | "storage"
  | "interrupted";

export type SenderState =
  | { phase: "connecting" }
  | { phase: "sending"; progress: number }
  // Everything sent; the new phone is installing it.
  | { phase: "finishing" }
  | { phase: "erasing" }
  | { phase: "done"; keysDestroyed: boolean }
  | { phase: "unconfirmed" }
  // Nothing moved, and the mesh is running again.
  | { phase: "failed"; reason: SenderFailure };

// Outlasts iOS's local network prompt: the first dial raises it and fails, and
// the retry after Allow connects.
const DIAL_WINDOW_MS = 30_000;
const DIAL_RETRY_MS = 1_500;
const HANDSHAKE_TIMEOUT_MS = 15_000;
// The new phone reads everything back before it commits. Past this, ask.
const COMMIT_TIMEOUT_MS = 90_000;
const RELEASE_SEND_MS = 3_000;
const ABORT_SEND_MS = 1_000;
// Lets the new phone close first: closing with bytes still arriving can reset
// the socket and discard the release just sent.
const RELEASE_LINGER_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SenderHooks {
  onChange: (state: SenderState) => void;
  // The mesh was stopped and nothing moved. The shell owns starting it.
  onResume: () => void;
}

export class MoveSender {
  private connectionID: string | null = null;
  private session: NoiseSession | null = null;
  private digest: Uint8Array | null = null;
  private frozen = false;
  private ended = false;
  private settled = false;
  private cancelled = false;
  private unsubscribe: (() => void) | null = null;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  // Message 2 can arrive before the write of message 1 resolves.
  private readonly earlyFrames: Uint8Array[] = [];
  private pendingFrame: ((frame: Uint8Array | null) => void) | null = null;
  private onClosed: (() => void) | null = null;

  constructor(
    private readonly invite: MoveInvite,
    private readonly history: boolean,
    private readonly hooks: SenderHooks,
  ) {}

  async start(): Promise<void> {
    this.set({ phase: "connecting" });
    const identity = await loadIdentity().catch(() => null);
    if (identity === null) {
      this.fail("interrupted");
      return;
    }
    this.unsubscribe = subscribeMoveLink((event) => this.onLinkEvent(event));

    const connectionID = await this.dial();
    if (connectionID === null) return;
    if (this.cancelled) {
      closeMove(connectionID);
      return;
    }
    this.connectionID = connectionID;

    try {
      const { handshake, msg1 } = MoveHandshake.initiate({
        staticPrivKey: identity.noiseStaticPrivKey,
        token: this.invite.token,
        expectedRemote: this.invite.publicKey,
      });
      await writeMove(connectionID, msg1);
      const msg2 = await this.nextFrame(HANDSHAKE_TIMEOUT_MS);
      if (msg2 === null) {
        this.fail("unreachable");
        return;
      }
      let step: HandshakeStep;
      try {
        step = handshake.receive(msg2);
      } catch {
        this.fail("wrong-phone");
        return;
      }
      if (step.reply !== null) await writeMove(connectionID, step.reply);
      this.session = step.session;
    } catch {
      this.fail("unreachable");
      return;
    }
    if (this.cancelled) return;

    this.freeze();
    try {
      const sections = await snapshotForMove(this.history);
      const { offer, stream } = buildOffer(sections, {
        appVersion: APP_VERSION,
        history: this.history,
      });
      const body = encodeOfferBody(offer);
      this.digest = sha256(body);
      await this.send(encodeOffer(body));
      this.set({ phase: "sending", progress: 0 });
      let sent = 0;
      for (const chunk of chunksOf(stream)) {
        if (this.settled) return;
        await this.send(encodeChunk(chunk));
        sent += chunk.length;
        this.set({ phase: "sending", progress: sent / stream.length });
      }
      if (this.settled) return;
      // Before the write: once END may be on the wire, the new phone may commit.
      this.ended = true;
      setMoveMarker("sent");
      await this.send(encodeEnd());
    } catch {
      if (this.settled) return;
      if (this.ended) {
        this.unconfirmed();
        return;
      }
      // No END, so no commit: nothing moved.
      await settleOr(
        this.send(encodeAbort(MoveAbortReason.CANCELLED)),
        ABORT_SEND_MS,
        undefined,
      );
      this.fail("interrupted");
      return;
    }
    // The commit can land while END's write is still resolving.
    if (this.settled) return;
    this.set({ phase: "finishing" });
    this.commitTimer = setTimeout(() => this.unconfirmed(), COMMIT_TIMEOUT_MS);
  }

  // Only until the stream ends; after that the new phone may have committed.
  cancel(): void {
    if (this.ended || this.settled) return;
    this.cancelled = true;
    if (this.session === null) {
      this.fail("cancelled", false);
      return;
    }
    // Settled first so the stream stops; torn down once the abort has left.
    this.settled = true;
    void settleOr(
      this.send(encodeAbort(MoveAbortReason.CANCELLED)),
      ABORT_SEND_MS,
      undefined,
    ).then(() => {
      this.teardown();
      this.unfreeze();
    });
  }

  private set(state: SenderState): void {
    this.hooks.onChange(state);
  }

  private async dial(): Promise<string | null> {
    const deadline = Date.now() + DIAL_WINDOW_MS;
    let failure: SenderFailure = "unreachable";
    while (!this.cancelled && Date.now() < deadline) {
      for (const host of this.invite.hosts) {
        try {
          return await dialMove(host, this.invite.port);
        } catch (error) {
          if (
            error instanceof MoveDialError &&
            error.failure === "permission"
          ) {
            failure = "permission";
          }
        }
        if (this.cancelled) return null;
      }
      await delay(DIAL_RETRY_MS);
    }
    if (!this.cancelled) this.fail(failure);
    return null;
  }

  private nextFrame(timeoutMs: number): Promise<Uint8Array | null> {
    const early = this.earlyFrames.shift();
    if (early !== undefined) return Promise.resolve(early);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingFrame = null;
        resolve(null);
      }, timeoutMs);
      this.pendingFrame = (frame) => {
        clearTimeout(timer);
        this.pendingFrame = null;
        resolve(frame);
      };
    });
  }

  private async send(plaintext: Uint8Array): Promise<void> {
    if (this.connectionID === null || this.session === null) {
      throw new Error("move-sender-no-session");
    }
    await writeMove(this.connectionID, this.session.encrypt(plaintext));
  }

  // Stops every writer to the stores about to be read. A mint call in flight
  // drops its answer on the new wallet epoch; it recorded its outputs first, so
  // the new phone's reconcile recovers them.
  private freeze(): void {
    setMoveMarker("sending");
    this.frozen = true;
    destroyMeshService();
    stopNutzapWatcher();
    resetWalletService();
  }

  private unfreeze(): void {
    if (!this.frozen) return;
    this.frozen = false;
    clearMoveMarker();
    this.hooks.onResume();
  }

  private teardown(): void {
    if (this.commitTimer !== null) clearTimeout(this.commitTimer);
    this.commitTimer = null;
    this.pendingFrame?.(null);
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.connectionID !== null) closeMove(this.connectionID);
    void stopMoveLink();
  }

  private fail(reason: SenderFailure, report = true): void {
    if (this.settled) return;
    this.settled = true;
    this.teardown();
    this.unfreeze();
    if (report) this.set({ phase: "failed", reason });
  }

  private unconfirmed(): void {
    if (this.settled) return;
    this.settled = true;
    this.teardown();
    this.set({ phase: "unconfirmed" });
  }

  private onLinkEvent(event: MoveLinkEvent): void {
    if (event.connectionID !== this.connectionID) return;
    if (event.kind === "closed") {
      this.onClosed?.();
      this.pendingFrame?.(null);
      if (this.ended) {
        this.unconfirmed();
      } else {
        this.fail(this.frozen ? "interrupted" : "unreachable");
      }
      return;
    }
    if (event.kind !== "data") return;
    if (this.session === null) {
      if (this.pendingFrame !== null) this.pendingFrame(event.bytes);
      else this.earlyFrames.push(event.bytes);
      return;
    }
    void this.onMessage(event.bytes);
  }

  private async onMessage(ciphertext: Uint8Array): Promise<void> {
    const session = this.session;
    if (session === null || this.settled) return;
    let message: MoveMessage | null;
    try {
      message = decodeMoveMessage(session.decrypt(ciphertext));
    } catch {
      return;
    }
    if (message === null) return;

    if (message.type === "abort") {
      // An abort means no commit, so running again is safe.
      this.fail(
        message.reason === MoveAbortReason.INCOMPATIBLE
          ? "incompatible"
          : message.reason === MoveAbortReason.STORAGE
            ? "storage"
            : message.reason === MoveAbortReason.CANCELLED
              ? "cancelled"
              : "interrupted",
      );
      return;
    }
    if (message.type !== "commit" || !this.ended) return;
    const digest = this.digest;
    const received = message.digest;
    if (digest === null || !digest.every((byte, i) => byte === received[i])) {
      this.unconfirmed();
      return;
    }
    await this.erase();
  }

  private async erase(): Promise<void> {
    this.settled = true;
    if (this.commitTimer !== null) clearTimeout(this.commitTimer);
    this.commitTimer = null;
    this.set({ phase: "erasing" });
    let keysDestroyed = false;
    try {
      ({ keysDestroyed } = await panicWipe());
    } catch {
      // The wipe marker is still set, so the next launch finishes it.
    }
    const closed = new Promise<void>((resolve) => {
      this.onClosed = resolve;
    });
    await settleOr(
      this.send(encodeReleased(keysDestroyed)),
      RELEASE_SEND_MS,
      undefined,
    );
    await settleOr(closed, RELEASE_LINGER_MS, undefined);
    this.onClosed = null;
    this.frozen = false;
    this.teardown();
    this.set({ phase: "done", keysDestroyed });
  }
}
