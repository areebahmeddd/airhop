// Decides whether the WiFi Aware fast path should be running, and makes reality
// match: a desired state, an observed outcome, and one idempotent pass that
// closes the gap and schedules a retry when it cannot. radio-controller.ts's
// counterpart.
//
// Both platforms, one reconciler. What differs is which failures each can
// report, and every one is a `code` rather than a platform check. The one
// structural difference is the pairing gate: Apple's Wi-Fi Aware has no
// unpaired mode, so on iOS this will not attach until a device is paired.
//
// Unlike the BLE controller, no blocker is published. This is an extra link
// between two phones on the same platform and BLE carries everything either
// way, so a user whose WiFi is off has not lost the mesh. `onState` reports
// which situation the transport is in, so the Mesh tab can say the fast path is
// off in the same neutral voice it uses for battery saver.

import NativeAirhopWiFi from "@bridge/NativeAirhopWiFi";
import type { WifiFastPath } from "@store/mesh-state-store";

// Slower than the BLE ladder at every step: nothing the user is looking at
// depends on this transport, and polling a radio in a pocket has a cost.
const BACKOFF_MS = [500, 1500, 4000, 10_000, 30_000] as const;

// A run shorter than this that ends reads as flapping, and the ladder keeps
// climbing rather than resetting.
const STABLE_RUN_MS = 60_000;

// The breaker. Some chips reset when an Aware data path is opened, which drops
// the router connection and Aware with it; Aware comes back seconds later and a
// plain retry resets the chip again, once a minute, for as long as the app
// runs. Three runs ended by the framework within three minutes of attaching,
// inside a quarter of an hour, is that loop. Longer than STABLE_RUN_MS on
// purpose: the first path attempt waits on discovery, which can take over a
// minute on its own.
const UNSTABLE_RUN_MS = 3 * 60_000;
const UNSTABLE_RUNS = 3;
const UNSTABLE_WINDOW_MS = 15 * 60_000;

// Why native reported the transport gone: the radio switched off, or the
// framework ended the session under a live radio. Only the second is the
// device's fault, so only the second counts toward the breaker.
export type WiFiDropReason = "radio" | "session";

// Matched on `code`, never on message text, which is a UI concern.
type WiFiFailure =
  // No Aware hardware, or an OS too old for the data path. Permanent.
  | "unsupported"
  // WiFi off, tethering, the OS reclaiming the radio. Clears on its own.
  | "unavailable"
  // NEARBY_WIFI_DEVICES (or location, below API 33) missing.
  | "permission"
  // iOS only. Not retried: only a pairing changes it, and the pairing module
  // reports when one does.
  | "unpaired"
  | "transient";

function classify(error: unknown): WiFiFailure {
  const code = (error as { code?: string } | undefined)?.code;
  switch (code) {
    case "WIFI_AWARE_UNSUPPORTED":
      return "unsupported";
    case "WIFI_AWARE_UNAVAILABLE":
      return "unavailable";
    case "PERMISSION_DENIED":
      return "permission";
    case "WIFI_AWARE_UNPAIRED":
      return "unpaired";
    default:
      return "transient";
  }
}

export class WiFiController {
  // Told on transitions only; the ladder would otherwise re-report "still off"
  // every few seconds.
  constructor(private readonly onState?: (state: WifiFastPath) => void) {}

  private reported: WifiFastPath = "unknown";

  private report(state: WifiFastPath): void {
    if (state === this.reported) return;
    this.reported = state;
    this.onState?.(state);
  }

  private desiredRunning = false;
  // The user's switch. Flipping it on is what clears `unstable` short of a
  // relaunch, since it is the one signal that carries intent.
  private enabled = true;
  // Paired devices, or null where there is no gate. Null on iOS too until the
  // first report, since attaching earlier would run a radio for devices not
  // yet confirmed to exist.
  private pairedCount: number | null = null;
  // Set only from a call that resolved, so it cannot claim more than the device
  // agreed to.
  private started = false;
  // Never cleared: nothing about a chipset or an OS version changes within a
  // process.
  private unsupported = false;
  private unstable = false;
  private shortRunsAtMs: number[] = [];
  private lastFailure: WiFiFailure | null = null;

  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private startedAtMs = 0;
  // startWiFi is async, and a second reconcile landing mid-attach would issue a
  // second attach.
  private reconciling = false;
  private dirty = false;
  private disposed = false;

  // Bumped whenever intent changes under an in-flight attach, so a resolve that
  // lands late cannot mark the transport started against an intent that has
  // moved on.
  private generation = 0;

  start(): void {
    this.desiredRunning = true;
    this.attempt = 0;
    void this.reconcile();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.generation += 1;
    if (enabled) this.clearUnstable();
    this.attempt = 0;
    void this.reconcile();
  }

  private clearUnstable(): void {
    this.unstable = false;
    this.shortRunsAtMs = [];
  }

  stop(): void {
    this.desiredRunning = false;
    this.generation += 1;
    this.clearTimer();
    void this.reconcile();
  }

  // Both edges matter: the first pairing lets the transport attach, and the
  // last unpairing happens in the Settings app, where a listener would keep
  // running for a device that is gone.
  setPairedCount(count: number): void {
    if (this.pairedCount === count) return;
    this.pairedCount = count;
    this.attempt = 0;
    void this.reconcile();
  }

  // The world may have moved: a resume, a permission grant, a pull to refresh.
  refresh(): void {
    if (this.unsupported) return;
    this.attempt = 0;
    void this.reconcile();
  }

  // A drop means the attach is gone or has to be rebuilt; anything native
  // recovers from on its own never reaches here. Forgetting `started` is what
  // lets the next pass do real work rather than returning at the guard.
  onAvailabilityChanged(available: boolean, reason?: WiFiDropReason): void {
    if (this.unsupported || this.unstable) return;
    if (!available) {
      const now = Date.now();
      const ran = this.started ? now - this.startedAtMs : 0;
      const ranStably = ran >= STABLE_RUN_MS;
      if (ran >= UNSTABLE_RUN_MS) {
        this.shortRunsAtMs = [];
      } else if (this.started && reason === "session") {
        this.shortRunsAtMs = this.shortRunsAtMs.filter(
          (t) => now - t < UNSTABLE_WINDOW_MS,
        );
        this.shortRunsAtMs.push(now);
      }
      this.started = false;
      // Not reported as "WiFi off": the same edge arrives when native rebuilds
      // the attach on a device whose WiFi is on. The retry answers within half
      // a second with a code that says which it was.
      this.generation += 1;
      // Idempotent; native has usually torn it down already.
      void NativeAirhopWiFi?.stopWiFi().catch(() => {});
      // Android says when the radio is back, so the ladder is a backstop there;
      // iOS reports only the falling edge, so the ladder is its recovery. Only a
      // run that lasted resets it: a flapping transport pinned to the first rung
      // is radio churn some WiFi stacks do not survive.
      if (ranStably) this.attempt = 0;
      if (this.shortRunsAtMs.length >= UNSTABLE_RUNS) {
        this.unstable = true;
        this.clearTimer();
        this.report("unstable");
        return;
      }
      this.scheduleRetry();
      return;
    }
    this.attempt = 0;
    void this.reconcile();
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.clearTimer();
    this.desiredRunning = false;
    if (this.started) void this.releaseNative();
  }

  private clearTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private scheduleRetry(): void {
    if (this.disposed || !this.desiredRunning) return;
    if (this.retryTimer !== null) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reconcile();
    }, delay);
  }

  private async reconcile(): Promise<void> {
    if (this.disposed) return;
    if (this.reconciling) {
      this.dirty = true;
      return;
    }
    this.reconciling = true;
    try {
      do {
        this.dirty = false;
        await this.reconcileOnce();
      } while (this.dirty && !this.disposed);
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileOnce(): Promise<void> {
    const generation = this.generation;
    // No module: every iOS build, and Android below API 29 where the package
    // does not register one.
    if (NativeAirhopWiFi === null || NativeAirhopWiFi === undefined) {
      this.unsupported = true;
      this.report("unsupported");
      return;
    }

    if (!this.desiredRunning) {
      if (!this.started) return;
      await this.releaseNative();
      return;
    }

    if (this.unsupported) return;

    if (!this.enabled) {
      if (this.started) await this.releaseNative();
      this.report("off");
      return;
    }

    if (this.unstable) return;

    // Ahead of the `started` guard: this edge has to tear an attached
    // transport down when the last pairing goes.
    if (this.pairedCount === 0) {
      if (this.started) await this.releaseNative();
      this.report("unpaired");
      return;
    }

    if (this.started) return;

    try {
      await NativeAirhopWiFi.startWiFi();
    } catch (error) {
      const failure = classify(error);
      this.lastFailure = failure;
      if (failure === "unsupported") {
        this.unsupported = true;
        this.report("unsupported");
        return;
      }
      if (failure === "unpaired") {
        this.report("unpaired");
        return;
      }
      // "unavailable" is the one the user can act on and the only one the Mesh
      // tab shows. A transient failure is reported as no reading rather than as
      // WiFi being off, which would send someone to a toggle that is already on.
      this.report(
        failure === "unavailable"
          ? "unavailable"
          : failure === "permission"
            ? "permission"
            : "unknown",
      );
      // A permission refusal is retried too: unlike Bluetooth there is no
      // banner asking the user to act, so this transport has only the retry.
      this.scheduleRetry();
      return;
    }

    // Intent moved while the attach was in flight, so this result is stale.
    if (generation !== this.generation) {
      await this.releaseNative();
      return;
    }

    this.started = true;
    this.startedAtMs = Date.now();
    this.lastFailure = null;
    this.report("active");

    // stop() and dispose() are synchronous and can land while the attach is in
    // flight; the loop does not run again once disposed.
    if (!this.desiredRunning || this.disposed) {
      await this.releaseNative();
    }
  }

  private async releaseNative(): Promise<void> {
    this.started = false;
    try {
      await NativeAirhopWiFi?.stopWiFi();
    } catch {
      // The sockets go with the process either way, and a refused stop must
      // not leave `started` claiming a live transport.
    }
  }

  get isStarted(): boolean {
    return this.started;
  }

  get isUnsupported(): boolean {
    return this.unsupported;
  }

  get isUnstable(): boolean {
    return this.unstable;
  }

  get failure(): WiFiFailure | null {
    return this.lastFailure;
  }
}
