// The new phone's side of a transfer: show a code, take the first connection
// that completes the handshake, collect the bundle whole, install it, commit.
//
// Reached only from onboarding, on a phone with no identity, so the answer to
// a failed install is simply the panic wipe: there is nothing here to keep.

import { loadIdentity } from "@core/crypto/identity";
import { sweepOrphanedSecrets } from "@core/crypto/keychain";
import type { NoiseSession } from "@core/crypto/noise-xx";
import { BundleAssembler } from "@core/move/move-bundle";
import { MoveHandshake } from "@core/move/move-handshake";
import { encodeMoveInvite, MOVE_TOKEN_BYTES } from "@core/move/move-invite";
import {
  canReadVersion,
  decodeMoveMessage,
  encodeAbort,
  encodeCommit,
  MoveAbortReason,
  type MoveAbortReasonValue,
  type MoveMessage,
  type MoveOffer,
} from "@core/move/move-wire";
import { APP_VERSION } from "@data/app-info";
import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { settleOr } from "@utils/with-timeout";
import {
  closeMove,
  isMoveLinkAvailable,
  startMoveListener,
  stopMoveLink,
  subscribeMoveLink,
  writeMove,
  type MoveLinkEvent,
} from "./move-link";
import { clearMoveMarker } from "./move-marker";
import { applyMove, isKnownSection, MoveApplyError } from "./move-snapshot";
import { panicWipe } from "./panic-wipe";

export type ReceiverFailure =
  | "incompatible"
  | "cancelled"
  // The connection dropped, or what arrived did not check out.
  | "interrupted"
  | "storage"
  // No transfer socket on this build.
  | "unavailable";

export type ReceiverState =
  | { phase: "preparing" }
  // Not on Wi-Fi and not serving a hotspot.
  | { phase: "offline" }
  | { phase: "waiting"; code: string }
  | { phase: "receiving"; peerID: string; progress: number }
  | { phase: "saving"; peerID: string }
  // Committed; waiting for the old phone to say it is erased.
  | { phase: "releasing"; peerID: string }
  // Not released: the old phone never answered, so the person is asked.
  | { phase: "done"; peerID: string; released: boolean }
  | { phase: "failed"; reason: ReceiverFailure };

// Re-reads the addresses, so joining Wi-Fi updates the code without a tap.
const HOSTS_POLL_MS = 3_000;
// Covers the old phone's wipe, cache sweep included; past it, the person is asked.
const RELEASE_TIMEOUT_MS = 60_000;
const ABORT_SEND_MS = 1_000;
// Chunks can arrive every few milliseconds; repaints need not.
const PROGRESS_INTERVAL_MS = 100;

function peerIDOf(noisePub: Uint8Array): string {
  return bytesToHex(sha256(noisePub)).slice(0, 16);
}

interface Active {
  connectionID: string;
  session: NoiseSession;
  peerID: string;
  offer: MoveOffer | null;
  offerRaw: Uint8Array | null;
  assembler: BundleAssembler | null;
}

export class MoveReceiver {
  private state: ReceiverState = { phase: "preparing" };
  private readonly staticPriv = crypto.getRandomValues(new Uint8Array(32));
  private readonly token = crypto.getRandomValues(
    new Uint8Array(MOVE_TOKEN_BYTES),
  );
  private readonly handshakes = new Map<string, MoveHandshake>();
  private active: Active | null = null;
  private unsubscribe: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressAt = 0;
  private disposed = false;
  private cancelling = false;

  constructor(private readonly onChange: (state: ReceiverState) => void) {}

  async start(): Promise<void> {
    this.set({ phase: "preparing" });
    if (!isMoveLinkAvailable()) {
      this.set({ phase: "failed", reason: "unavailable" });
      return;
    }
    // Awaited here: the welcome screen's own sweep is not, and landing after
    // the wallet secrets arrive would delete them.
    await sweepOrphanedSecrets().catch(() => false);
    if ((await loadIdentity().catch(() => null)) !== null) {
      this.set({ phase: "failed", reason: "storage" });
      return;
    }
    if (this.disposed) return;
    this.unsubscribe = subscribeMoveLink((event) => this.onLinkEvent(event));
    await this.refreshCode();
    this.pollTimer = setInterval(() => void this.refreshCode(), HOSTS_POLL_MS);
  }

  // Tells the old phone, briefly, so it can say "cancelled" not "dropped".
  cancel(): void {
    if (this.disposed || this.cancelling) return;
    // Once the stream is in, the install runs to its end.
    const phase = this.state.phase;
    if (phase === "saving" || phase === "releasing" || phase === "done") return;
    this.cancelling = true;
    const told =
      this.active !== null
        ? settleOr(
            this.send(encodeAbort(MoveAbortReason.CANCELLED)),
            ABORT_SEND_MS,
            undefined,
          )
        : Promise.resolve();
    void told.then(() => this.close());
  }

  // Unmounting mid-cancel waits for the cancel to finish closing.
  dispose(): void {
    if (this.cancelling) return;
    this.close();
  }

  private close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTimers();
    this.unsubscribe?.();
    this.unsubscribe = null;
    void stopMoveLink();
  }

  private set(state: ReceiverState): void {
    if (this.disposed || this.cancelling) return;
    this.state = state;
    this.onChange(state);
  }

  private stopTimers(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }

  private async refreshCode(): Promise<void> {
    if (this.active !== null) return;
    let listener: { port: number; hosts: string[] };
    try {
      listener = await startMoveListener();
    } catch {
      this.stopTimers();
      this.set({ phase: "failed", reason: "unavailable" });
      return;
    }
    if (this.active !== null || this.disposed) return;
    if (listener.hosts.length === 0) {
      if (this.state.phase !== "offline") this.set({ phase: "offline" });
      return;
    }
    const code = encodeMoveInvite({
      publicKey: x25519.getPublicKey(this.staticPriv),
      token: this.token,
      port: listener.port,
      hosts: listener.hosts,
    });
    if (this.state.phase === "waiting" && this.state.code === code) return;
    this.set({ phase: "waiting", code });
  }

  private onLinkEvent(event: MoveLinkEvent): void {
    const { connectionID } = event;
    if (event.kind === "connected") {
      // One transfer at a time: a second phone that read the code is refused.
      if (this.active !== null) {
        closeMove(connectionID);
        return;
      }
      this.handshakes.set(
        connectionID,
        MoveHandshake.respond({
          staticPrivKey: this.staticPriv,
          token: this.token,
        }),
      );
      return;
    }
    if (event.kind === "closed") {
      this.handshakes.delete(connectionID);
      if (this.active?.connectionID === connectionID) this.onActiveClosed();
      return;
    }
    if (this.active?.connectionID === connectionID) {
      void this.onMessage(event.bytes);
      return;
    }
    const handshake = this.handshakes.get(connectionID);
    if (handshake === undefined) return;
    try {
      const step = handshake.receive(event.bytes);
      if (step.reply !== null) {
        void writeMove(connectionID, step.reply).catch(() =>
          closeMove(connectionID),
        );
      }
      if (step.session !== null) this.adopt(connectionID, step.session);
    } catch {
      this.handshakes.delete(connectionID);
      closeMove(connectionID);
    }
  }

  private adopt(connectionID: string, session: NoiseSession): void {
    this.handshakes.delete(connectionID);
    if (this.active !== null) {
      closeMove(connectionID);
      return;
    }
    for (const other of this.handshakes.keys()) closeMove(other);
    this.handshakes.clear();
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    const peerID = peerIDOf(session.remoteStaticPubKey);
    this.active = {
      connectionID,
      session,
      peerID,
      offer: null,
      offerRaw: null,
      assembler: null,
    };
    this.set({ phase: "receiving", peerID, progress: 0 });
  }

  private async send(plaintext: Uint8Array): Promise<void> {
    const active = this.active;
    if (active === null) return;
    await writeMove(active.connectionID, active.session.encrypt(plaintext));
  }

  // Mid-stream nothing was written, so nothing happened. After the commit only
  // the release is missing.
  private onActiveClosed(): void {
    const phase = this.state.phase;
    if (phase === "receiving") {
      this.fail("interrupted");
    } else if (phase === "releasing") {
      this.finish(false);
    }
  }

  private fail(reason: ReceiverFailure): void {
    this.stopTimers();
    const active = this.active;
    this.active = null;
    if (active !== null) closeMove(active.connectionID);
    this.set({ phase: "failed", reason });
    void stopMoveLink();
  }

  private finish(released: boolean): void {
    const active = this.active;
    if (active === null) return;
    this.stopTimers();
    if (released) clearMoveMarker();
    this.set({ phase: "done", peerID: active.peerID, released });
    this.active = null;
    closeMove(active.connectionID);
    void stopMoveLink();
  }

  private async abortWith(
    reason: MoveAbortReasonValue,
    failure: ReceiverFailure,
  ): Promise<void> {
    await this.send(encodeAbort(reason)).catch(() => undefined);
    this.fail(failure);
  }

  private async onMessage(ciphertext: Uint8Array): Promise<void> {
    const active = this.active;
    if (active === null) return;
    let message: MoveMessage | null;
    try {
      message = decodeMoveMessage(active.session.decrypt(ciphertext));
    } catch {
      message = null;
    }
    if (message === null) {
      if (this.state.phase === "receiving") {
        await this.abortWith(MoveAbortReason.INVALID, "interrupted");
      }
      return;
    }

    switch (message.type) {
      case "offer": {
        if (active.offer !== null || this.state.phase !== "receiving") return;
        if (!canReadVersion(APP_VERSION, message.offer.appVersion)) {
          await this.abortWith(MoveAbortReason.INCOMPATIBLE, "incompatible");
          return;
        }
        if (!message.offer.sections.every((s) => isKnownSection(s.name))) {
          await this.abortWith(MoveAbortReason.INVALID, "interrupted");
          return;
        }
        active.offer = message.offer;
        active.offerRaw = message.raw;
        active.assembler = new BundleAssembler(message.offer);
        return;
      }
      case "chunk": {
        const assembler = active.assembler;
        if (assembler === null || this.state.phase !== "receiving") return;
        try {
          assembler.push(message.data);
        } catch {
          await this.abortWith(MoveAbortReason.INVALID, "interrupted");
          return;
        }
        const now = Date.now();
        if (now - this.lastProgressAt >= PROGRESS_INTERVAL_MS) {
          this.lastProgressAt = now;
          this.set({
            phase: "receiving",
            peerID: active.peerID,
            progress:
              assembler.total === 0
                ? 1
                : assembler.receivedBytes / assembler.total,
          });
        }
        return;
      }
      case "end":
        await this.install(active);
        return;
      case "released":
        if (this.state.phase === "releasing") this.finish(true);
        return;
      case "abort":
        if (this.state.phase === "receiving") {
          this.fail(
            message.reason === MoveAbortReason.CANCELLED
              ? "cancelled"
              : "interrupted",
          );
        }
        return;
      default:
        await this.abortWith(MoveAbortReason.INVALID, "interrupted");
    }
  }

  private async install(active: Active): Promise<void> {
    const { assembler, offerRaw } = active;
    if (
      assembler === null ||
      offerRaw === null ||
      this.state.phase !== "receiving"
    ) {
      await this.abortWith(MoveAbortReason.INVALID, "interrupted");
      return;
    }
    this.set({ phase: "saving", peerID: active.peerID });
    let sections: Map<string, Uint8Array>;
    try {
      sections = assembler.complete();
    } catch {
      await this.abortWith(MoveAbortReason.INVALID, "interrupted");
      return;
    }
    try {
      await applyMove(sections, active.session.remoteStaticPubKey);
    } catch (error) {
      const invalid =
        error instanceof MoveApplyError && error.failure === "invalid";
      await this.send(
        encodeAbort(
          invalid ? MoveAbortReason.INVALID : MoveAbortReason.STORAGE,
        ),
      ).catch(() => undefined);
      // Wipes anything half-written, the marker with it.
      await panicWipe().catch(() => undefined);
      this.fail(invalid ? "interrupted" : "storage");
      return;
    }
    this.set({ phase: "releasing", peerID: active.peerID });
    this.releaseTimer = setTimeout(
      () => this.finish(false),
      RELEASE_TIMEOUT_MS,
    );
    try {
      await this.send(encodeCommit(sha256(offerRaw)));
    } catch {
      // The old phone never hears it, so it stays frozen and asks the person.
      // This phone has everything, so it asks too.
      this.finish(false);
    }
  }
}
