// Orchestrates routing internet traffic through Tor.
//
// Airhop embeds Arti on both platforms (native/arti), so this is one code path
// rather than two. Turning Tor on starts the embedded client and points the
// app's sockets at its SOCKS5 proxy; turning it off stops the client and puts
// them back.
//
// Bluetooth is untouched throughout. Tor is an internet-only concern, so the
// mesh keeps working whatever happens here, and every failure message says so.
//
// The platforms differ in one place, and it is coverage. Android installs the
// proxy under every Java HTTP client (React Native's factory and the default
// ProxySelector), so every web request is covered, `fetch` and downloads
// included. React Native's WebSocket cannot speak SOCKS5 on iOS, so
// nostr-tools gets TorWebSocket instead and nothing else is covered, which is
// why wallet-service refuses a mint call there.
//
// Both fail closed at the socket: arti_client has no clearnet path, so a request
// made before a circuit exists fails instead of falling back. Protection starts
// when the user consents, not when the circuit finishes forming.
//
// This is the single choke point for the Tor decision, so the socket factory,
// the native client and the persisted preference cannot drift apart.

import NativeAirhopTor, {
  subscribeTorStatus,
  type Spec as TorModule,
} from "@bridge/NativeAirhopTor";
import { isTorSocketNativeAvailable } from "@bridge/NativeAirhopTorSocket";
import { setTorTeardown } from "@core/nostr/tor-teardown-handle";
import { OBFS4_BRIDGE_LINES, SNOWFLAKE_BRIDGE_LINES } from "@data/bridges";
import {
  useMeshStateStore,
  type TorBootstrapPhase,
} from "@store/mesh-state-store";
import { useSettingsStore, type TorBridgeMode } from "@store/settings-store";
import { useWebSocketImplementation } from "nostr-tools/pool";
import { Platform } from "react-native";
import { getMeshService } from "./mesh-service";
import { TorWebSocket } from "./tor-websocket";

// The real React Native WebSocket, captured before any swap so it can be
// restored when Tor is turned off.
const DirectWebSocket = WebSocket;

let torActive = false;

export interface TorRoutingResult {
  ok: boolean;
  // Why enabling failed, for the UI to explain:
  //   unavailable  the native Tor client is missing from this build
  //   timeout      Arti did not bootstrap in time
  //   no-bridges   the chosen mode needs bridge lines and has none
  //   error        Arti failed to start
  reason?: "unavailable" | "timeout" | "no-bridges" | "error";
}

export function isTorRoutingActive(): boolean {
  return torActive;
}

// Single writer for the active flag, mirrored into the mesh store so the Mesh
// banner reacts the instant Tor is toggled, or primed at startup.
function setTorActive(active: boolean): void {
  torActive = active;
  useMeshStateStore.getState().setTorActive(active);
}

function setTorBootstrap(phase: TorBootstrapPhase): void {
  useMeshStateStore.getState().setTorBootstrap(phase);
}

// The gate holds the relay pool until a circuit can carry it. Why it exists is
// on `nostrBlockedByTor` in mesh-state-store.
//
// Returns whether it moved. Callers that rebuild anyway use this, so one
// teardown covers both; a second would drop the sockets the first just
// opened.
function writeNostrBlocked(blocked: boolean): boolean {
  const store = useMeshStateStore.getState();
  if (store.nostrBlockedByTor === blocked) return false;
  store.setNostrBlockedByTor(blocked);
  return true;
}

// Skipped when nothing moves: restartNostr destroys and re-opens every relay
// socket, geohash subscription and the DM inbox, and the status feed reports the
// same phase more than once.
function setNostrBlocked(blocked: boolean): void {
  if (!writeNostrBlocked(blocked)) return;
  getMeshService()?.restartNostr();
}

// iOS only: Android needs no shim, because its proxy is installed one layer
// lower in the HTTP client every socket is built from.
function needsTorWebSocketShim(): boolean {
  return Platform.OS === "ios" && isTorSocketNativeAvailable();
}

// Safe to call repeatedly. useWebSocketImplementation is a nostr-tools setter,
// not a React hook.
function installTorSocket(): void {
  if (!needsTorWebSocketShim()) return;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useWebSocketImplementation(TorWebSocket);
}

function installDirectSocket(): void {
  if (!needsTorWebSocketShim()) return;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useWebSocketImplementation(DirectWebSocket);
}

// How long a bootstrap may run before it is called blocked, per mode.
//
// A bridge is slower than a direct connection by construction, and Snowflake
// slowest of all: it finds a volunteer proxy through a broker before any Tor
// traffic moves. Holding every mode to the direct deadline would report a
// working Snowflake connection as blocked.
const TOR_READY_TIMEOUT_S: Record<TorBridgeMode, number> = {
  off: 60,
  obfs4: 120,
  snowflake: 180,
  custom: 120,
};

// The bridge configuration a start should use, from the persisted mode.
//
// One reader, so a startup and a toggle cannot disagree about how the client
// came up. Custom lines are passed through unvalidated: Arti owns the grammar
// and refuses a bad line at start rather than here.
function bridgeLinesForStart(): string {
  const { torBridgeMode, torBridgeLines } = useSettingsStore.getState();
  switch (torBridgeMode) {
    case "obfs4":
      return OBFS4_BRIDGE_LINES;
    case "snowflake":
      return SNOWFLAKE_BRIDGE_LINES;
    case "custom":
      return torBridgeLines.trim();
    case "off":
      return "";
  }
}

function needsBridgeLines(): boolean {
  return useSettingsStore.getState().torBridgeMode !== "off";
}

// Every start goes through here, so the window between asking the native client
// to start and it answering is always marked. See `torStartPending` in
// settings-store for what that buys.
//
// `finally`, not a success path: a rejected start is a failure the app handled
// and survived, which is not what the marker records.
async function startNativeTor(native: TorModule): Promise<void> {
  const { setTorStartPending } = useSettingsStore.getState();
  setTorStartPending(true);
  try {
    await native.startTor(bridgeLinesForStart());
  } finally {
    setTorStartPending(false);
  }
}

// Arti reports its own progress and whether it has stopped making any. Without
// a subscriber a bootstrap that never lands is silent: every relay socket fails
// closed behind a circuit that does not exist, and the internet half quietly
// does nothing. `blocked` is what a network filtering Tor produces, and is the
// difference between "Airhop is broken" and "this network blocks Tor".

let statusSubscription: { remove: () => void } | null = null;

function watchTorBootstrap(): void {
  if (statusSubscription !== null) return;
  // Registered, not called, for the reason tor-teardown-handle exists:
  // panic-wipe stays loadable without a native host, and this module reaches the
  // mesh service at import time.
  setTorTeardown(() => {
    stopWatchingTorBootstrap();
    setTorActive(false);
    // A wipe stops Arti and deletes its state, so a factory left pointing at a
    // Tor socket would dial a proxy that no longer exists for the rest of the
    // process. The wipe also clears torEnabled, so this restores the socket the
    // preference now asks for.
    installDirectSocket();
    setTorTeardown(null);
  });
  statusSubscription = subscribeTorStatus((status) => {
    if (status.isReady) {
      setTorBootstrap("idle");
      // A circuit that comes up after startup handed over, or after a stall that
      // resolved itself, is the moment the privacy claim becomes true. Only
      // claim it while the user still wants Tor.
      if (useSettingsStore.getState().torEnabled) setTorActive(true);
      // Opened AFTER the claim, so the banner never shows relays coming up under
      // a Tor indicator that is still down.
      setNostrBlocked(false);
      return;
    }
    if (status.isStarting) {
      setTorBootstrap("starting");
      return;
    }
    // Neither ready nor starting, with the preference on: Arti is blocked or
    // gone. Stand the claim down and say why. Blocked is not final, and a later
    // ready status reopens everything above. The socket path stays on Tor,
    // because falling back to a direct one would put traffic on the clear net
    // that the user never agreed to.
    if (useSettingsStore.getState().torEnabled) {
      // Closed BEFORE the claim is lowered, so there is no instant in which the
      // UI says Tor is off while the sockets it was covering are still open.
      setNostrBlocked(true);
      setTorActive(false);
      setTorBootstrap("blocked");
    } else {
      setTorBootstrap("idle");
      setNostrBlocked(false);
    }
  });
}

function stopWatchingTorBootstrap(): void {
  statusSubscription?.remove();
  statusSubscription = null;
  setTorBootstrap("idle");
  // Nothing left to tear down, so nothing should hold a teardown for it.
  setTorTeardown(null);
}

// Turn Tor routing on or off at runtime, from the settings toggle. Starts or
// stops Arti, swaps the socket path where one is needed, persists the
// preference, and rebuilds the Nostr transport so connections re-open on the
// selected route.
export async function setTorRouting(
  enabled: boolean,
): Promise<TorRoutingResult> {
  if (enabled) {
    return enableTorRouting();
  }
  await disableTorRouting();
  return { ok: true };
}

// Change which bridges Tor uses, restarting the client when one is running.
//
// Bridges are fixed when the client is built, so there is no way to apply this
// to a live client. The restart is the existing disable and enable in sequence
// rather than a third path, so the socket swap, the blocked gate and the relay
// rebuild all behave as they already do.
//
// Persisting before the restart matters: enableTorRouting reads the mode back
// through bridgeLinesForStart, so the new client comes up on the new choice.
export async function setTorBridgeMode(
  mode: TorBridgeMode,
  customLines?: string,
): Promise<TorRoutingResult> {
  const settings = useSettingsStore.getState();
  settings.setTorBridgeMode(mode);
  if (customLines !== undefined) settings.setTorBridgeLines(customLines);

  if (!settings.torEnabled) return { ok: true };
  if (needsBridgeLines() && bridgeLinesForStart() === "") return { ok: true };

  await disableTorRouting(true);
  return enableTorRouting();
}

async function enableTorRouting(): Promise<TorRoutingResult> {
  if (NativeAirhopTor == null) {
    return { ok: false, reason: "unavailable" };
  }

  // A mode that needs lines but has none would start a direct connection while
  // the screen says bridges are on. Refuse instead: this is the failure the
  // whole path exists to prevent, and it is the answer Arti gives to an empty
  // bridge list too.
  if (needsBridgeLines() && bridgeLinesForStart() === "") {
    return { ok: false, reason: "no-bridges" };
  }

  try {
    watchTorBootstrap();
    setTorBootstrap("starting");
    installTorSocket();
    // Persist first, so a relaunch during the bootstrap comes back on Tor rather
    // than on the clear net.
    useSettingsStore.getState().setTorEnabled(true);
    // The clear-net pool goes now, not after the bootstrap: waiting would leave
    // up to a minute of subscriptions and DMs going out unprotected after the
    // user asked for Tor. With the gate up the restart only tears down, and the
    // watcher rebuilds on the Tor socket once the circuit is ready.
    setNostrBlocked(true);
    // Native holds its own HTTP client inside startTor, before the client is
    // even built, and routes it to the proxy once the port is bound, so there
    // is no window on either platform.
    await startNativeTor(NativeAirhopTor);

    const ready = await NativeAirhopTor.awaitTorReady(
      TOR_READY_TIMEOUT_S[useSettingsStore.getState().torBridgeMode],
    );
    if (!ready) {
      // Deliberately not undone: a bootstrap can still land after this deadline,
      // and the status watcher reports it terminally if it does not. Reverting
      // the socket would put the user back on the clear net they just left.
      return { ok: false, reason: "timeout" };
    }
    // Re-check consent before claiming it. Sixty seconds is long enough for the
    // user to toggle Tor back off, or for a panic wipe to tear the whole thing
    // down, and an enable that resolves afterwards would assert onion routing
    // over a socket that is back on the clear net.
    if (!useSettingsStore.getState().torEnabled) {
      return { ok: false, reason: "error" };
    }
    setTorActive(true);
    setTorBootstrap("idle");
    // A no-op if the watcher already opened it. Not left to the watcher alone: a
    // client that was ready before the gate went up reports no further change.
    setNostrBlocked(false);
    return { ok: true };
  } catch {
    // A throw is different from a slow bootstrap: the module itself failed, so
    // there is nothing to wait for, and leaving the app with no internet half
    // would be worse than the clear net it started on. Unwind completely.
    await NativeAirhopTor.stopTor().catch(() => {});
    installDirectSocket();
    setTorActive(false);
    useSettingsStore.getState().setTorEnabled(false);
    stopWatchingTorBootstrap();
    writeNostrBlocked(false);
    getMeshService()?.restartNostr();
    return { ok: false, reason: "error" };
  }
}

// `restarting` is a bridge change: Tor comes straight back up, so the pool is
// torn down and held rather than reopened on the direct route in between. It
// goes before the stop, because on Android the stop is what routes new sockets
// around the proxy.
async function disableTorRouting(restarting = false): Promise<void> {
  stopWatchingTorBootstrap();
  installDirectSocket();
  // Nothing is starting, so the marker has nothing left to warn about. It also
  // clears the notice a previous recovery left on the Tor screen.
  useSettingsStore.getState().setTorStartPending(false);
  if (restarting) {
    setNostrBlocked(true);
  } else {
    // Nobody is asking for Tor, so nothing may be held down in its name. This
    // is also the way out of the blocked state: turning Tor off brings the
    // internet half back. Written rather than applied, so the restart at the
    // end covers both.
    writeNostrBlocked(false);
  }
  // The preference goes down first, so anything still racing sees consent
  // withdrawn and stands down instead of writing over this.
  useSettingsStore.getState().setTorEnabled(false);
  setTorActive(false);
  setTorBootstrap("idle");
  // Native puts its HTTP client back on a direct route inside stopTor, after the
  // client is down, so there is no instant in which the proxy is gone while
  // something still believes it is covered.
  await NativeAirhopTor?.stopTor().catch(() => {});
  if (!restarting) getMeshService()?.restartNostr();
}

// Apply the persisted Tor preference at app startup, BEFORE the mesh service is
// initialized, so the very first relay pool is built on the right socket path.
// There is no mesh rebuild here: the mesh has not started yet.
//
// Gated on the internet switch as well, for the reason applyInternetAvailability
// gives: with no internet half, Arti would bootstrap for nobody. Switching the
// internet on later starts it from there.
export function primeTorRoutingOnStartup(): void {
  if (!useSettingsStore.getState().internetEnabled) return;
  startTorFromPreference();
}

// The start itself, shared with the internet switch. That caller runs before
// the switch's own preference is written, so it cannot go through the gate
// above.
function startTorFromPreference(): void {
  const settings = useSettingsStore.getState();
  if (!settings.torEnabled) return;

  // A start that never answered, from a process that is gone. Starting again is
  // what turns one native crash into an app that cannot be opened, and going
  // direct would put a Tor user on the clear net without asking. So nothing
  // native starts and the internet half is held, exactly as for a network that
  // blocks Tor. The marker stays until the Tor screen's Try again, or Tor off.
  if (settings.torStartPending) {
    holdAfterFailedStart();
    return;
  }

  if (NativeAirhopTor == null) {
    // The preference is on but Tor is unavailable in this build. Leave the
    // direct socket in place rather than breaking the internet half entirely;
    // the toggle surfaces it.
    return;
  }

  // The socket path goes on immediately: traffic must be fail-closed from the
  // first relay attempt, before anything is known about the circuit. The pool
  // waits for the circuit, and the watcher opens the gate when Arti is ready.
  // Applied rather than written, so a pool built on the direct socket before
  // this ran is torn down instead of outliving the switch to Tor.
  installTorSocket();
  setNostrBlocked(true);
  // The claim does not. Asserting it here would assert onion routing before a
  // circuit existed, and on a network that blocks Tor it would sit green for
  // the whole session. The watcher raises it when Arti reports ready.
  watchTorBootstrap();
  setTorBootstrap("starting");
  // A rejection here is terminal and has to be said, or the banner reads
  // "starting" for the whole session with nothing behind it. The native side
  // rejects only when Tor cannot run at all rather than merely not being ready:
  // no library for this ABI, or an unwritable state directory.
  void startNativeTor(NativeAirhopTor).catch(() => {
    setTorActive(false);
    setTorBootstrap("blocked");
  });
}

// The held state after a crashed start. Applied rather than written, like the
// start above, so a pool built before this ran is torn down. On Android the
// HTTP stack is held on a proxy nothing listens on, so `fetch` fails too; iOS
// proxies only the Nostr socket, and its wallet and update check already
// refuse while Tor is on.
function holdAfterFailedStart(): void {
  setNostrBlocked(true);
  setTorActive(false);
  setTorBootstrap("blocked");
  void NativeAirhopTor?.holdRoute().catch(() => {});
}

// Whether the held state above is what the user is looking at: Tor wanted, the
// marker of a start that never answered, and nothing running. A marker alone
// is also set for the moment a start is in flight, which is not blocked.
export function isTorStartRecovered(
  torEnabled: boolean,
  torStartPending: boolean,
  torBootstrap: TorBootstrapPhase,
): boolean {
  return torEnabled && torStartPending && torBootstrap === "blocked";
}

// Tor runs only when the user wants it and there is an internet half to carry.
// Otherwise Arti holds guards and refreshes a consensus for nobody, and the
// master switch's confirm sheet says it disables Tor.
//
// The preference is untouched: the user turned the internet off, not Tor, so
// turning it back on restores what they chose.
export function applyInternetAvailability(enabled: boolean): void {
  if (!useSettingsStore.getState().torEnabled) return;
  if (enabled) {
    // Safe to call again: the status subscription, the socket swap and the
    // native start are each idempotent.
    startTorFromPreference();
    return;
  }
  stopWatchingTorBootstrap();
  installDirectSocket();
  // Nothing may be held down in the name of a Tor that is no longer running.
  writeNostrBlocked(false);
  setTorActive(false);
  setTorBootstrap("idle");
  // Not a preference: it describes a start that is about to be stopped, and
  // leaving it set would disable Tor on the next launch for no reason.
  useSettingsStore.getState().setTorStartPending(false);
  void NativeAirhopTor?.stopTor().catch(() => {});
}

// Tell Arti which side of the screen the app is on, so it can sleep in the
// background and wake on return.
//
// Ungated on the preference: with nothing running it is a no-op on both
// platforms.
export function notifyTorAppForeground(foreground: boolean): void {
  void NativeAirhopTor?.setAppForeground?.(foreground).catch(() => {
    // An older native binary without the method. The foreground re-check below
    // still corrects the claim; what is lost is the dormancy behind it.
  });
}

// Re-check Tor on app foreground and stand the claim down if it has gone away.
//
// A status snapshot, not the event feed that watchTorBootstrap already
// subscribes to. The feed reports transitions; this answers "what is true right
// now", which is the question a resume asks after a gap the feed could not
// report during.
//
// `isStarting` is treated as still-fine: a bootstrap in progress is normal for
// the first seconds after launch, and standing the claim down there would
// flicker the banner on every cold start.
export async function revalidateTorRouting(): Promise<void> {
  // Guarded on the PREFERENCE, not the claim. `torActive` is false throughout a
  // blocked state, so an early return on it would make foreground the one
  // trigger that can never recover a session. With the internet off, Arti is
  // stopped on purpose, and reading that as blocked would say so on the Tor
  // screen.
  const { torEnabled, internetEnabled } = useSettingsStore.getState();
  if (!torEnabled || !internetEnabled) return;
  if (NativeAirhopTor == null) return;

  try {
    const status = await NativeAirhopTor.getTorStatus();
    if (status.isReady) {
      setTorActive(true);
      setTorBootstrap("idle");
      setNostrBlocked(false);
      return;
    }
    if (status.isStarting) {
      setTorBootstrap("starting");
      return;
    }
  } catch {
    // The module answered with an error rather than a status. Treat that the
    // same as "not routing": the point of this path is to stop overstating.
  }
  // The socket path and the preference are both left alone. Swapping back to a
  // direct socket would put traffic on the clear net the user opted out of, and
  // a transport that has gone is usually transient, so the next launch retries.
  setNostrBlocked(true);
  setTorActive(false);
  setTorBootstrap("blocked");
}
