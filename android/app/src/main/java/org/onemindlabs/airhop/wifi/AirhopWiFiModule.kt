// AirhopWiFiModule: WiFi Aware (NAN) transport for Airhop on Android.
//
// Peer-to-peer data paths without a router or internet, ~30 m, ~250 Mbps.
// Raw bytes to TypeScript, as AirhopBLEModule does; no protocol or routing
// logic here.
//
// Events emitted to TypeScript:
//   AirhopWiFi.packetReceived      { linkID, dataBase64 }
//   AirhopWiFi.linkConnected       { linkID }
//   AirhopWiFi.linkDisconnected    { linkID }
//   AirhopWiFi.availabilityChanged { available }
//
// Three framework facts shape this file:
//
//   1. A subscriber hears about a peer once. The framework subscribes with
//      MATCH_ONCE and match expiry off, so onServiceDiscovered fires a single
//      time per peer per subscribe session. Nothing may wait for a rediscovery.
//   2. Follow-up messages (sendMessage) may be dropped, reordered or delivered
//      twice, especially while a screen is off and discovery windows are
//      throttled.
//   3. Releasing, replacing or losing a data path destroys every socket on it;
//      the far side sees ECONNABORTED mid-read, mid-write or mid-connect.
//
// So connecting is a per-peer state machine driven by a maintenance tick. A
// peer is keyed by the instance id it advertises, keeps the handles both
// discovery sessions issued for it, and every step has a deadline and a
// backoff. A failure returns the peer to idle and never tears down anything
// outside the failed attempt.
//
// Data path setup, in the order the framework requires:
//
//   initiator  -> MSG_CONNECT_REQUEST (instance, epoch) -> responder
//   responder: requestNetwork() with setPort(), then
//   responder  -> MSG_CONNECT_READY (instance, epoch)   -> initiator
//   initiator: requestNetwork(), connect() to the address the path reports
//
// The responder builds its specifier from the publish session's handle and
// names its port; the initiator builds one from the subscribe session's handle
// with no port and connects through the Network's own socket factory, since
// the default one routes over the default network. The peer address arrives
// only in onCapabilitiesChanged as WifiAwareNetworkInfo.
//
// The epoch is the initiator's attempt counter. A repeated REQUEST is the
// framework delivering it twice and gets another READY; a newer one means the
// initiator started over and the responder drops what it held for the last.
//
// On the socket, frames are [4-byte BE length][data]. Two are the module's own
// and never reach TypeScript: a hello, first on every socket in both directions,
// naming the sender so an accepted socket is attributed to a peer; and a
// zero-length heartbeat, so a socket whose far side vanished without a FIN is
// closed in seconds.
package org.onemindlabs.airhop.wifi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.ScanResult
import android.net.wifi.aware.AttachCallback
import android.net.wifi.aware.DiscoverySessionCallback
import android.net.wifi.aware.PeerHandle
import android.net.wifi.aware.PublishConfig
import android.net.wifi.aware.PublishDiscoverySession
import android.net.wifi.aware.SubscribeConfig
import android.net.wifi.aware.SubscribeDiscoverySession
import android.net.wifi.aware.WifiAwareManager
import android.net.wifi.aware.WifiAwareNetworkInfo
import android.net.wifi.aware.WifiAwareNetworkSpecifier
import android.net.wifi.aware.WifiAwareSession
import android.os.Build
import android.os.SystemClock
import android.system.OsConstants
import android.util.Base64
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet6Address
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import org.onemindlabs.airhop.transport.Framing
import org.onemindlabs.airhop.wifi.AwareDial.toHex
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

private const val TAG = "AirhopWiFiModule"

// NAN hashes this exact string into the on-air service ID, so it must match
// AirhopWiFiModule.swift and the WiFiAwareServices key in Info.plist character
// for character. The DNS-SD form is Apple's requirement; Android accepts it.
private const val SERVICE_NAME = "_airhop-mesh-v1._tcp"

private const val EVT_PACKET_RECEIVED = "AirhopWiFi.packetReceived"
private const val EVT_LINK_CONNECTED = "AirhopWiFi.linkConnected"
private const val EVT_LINK_DISCONNECTED = "AirhopWiFi.linkDisconnected"
// Sent only when the radio is gone or the attach has to be rebuilt. Discovery
// restarts and redials happen below this line and keep their links. A drop
// names which of the two it was: the JS breaker counts a session the framework
// ended under a live radio, never a radio the user switched off.
private const val EVT_AVAILABILITY_CHANGED = "AirhopWiFi.availabilityChanged"
private const val REASON_RADIO = "radio"
private const val REASON_SESSION = "session"

// Message and hello layouts, the tiebreak and the backoff ladder are in
// AwareDial; the stream framing is in Framing.

// The two-argument requestNetwork() leaves a failed request pending for the
// life of the process; only the timeout overload makes failure observable.
private const val NETWORK_REQUEST_TIMEOUT_MS = 30_000

// Follow-ups round-trip in under a second with both screens on and in a few
// seconds with one throttled.
private const val REQUEST_TIMEOUT_MS = 12_000L

// The responder's link-local address is still settling when the path reports
// ready, so the first connect waits and a refusal is retried before the path
// is given up.
private const val CONNECT_SETTLE_MS = 750L
private const val CONNECT_RETRY_MS = 750L
private const val CONNECT_ATTEMPTS = 3
private const val CONNECT_TIMEOUT_MS = 7_000

// How long the side the tiebreak did not pick waits before dialling itself.
// Discovery is often one-directional (fact 1), so the preferred side may never
// have matched us.
private const val RESPONDER_GRACE_MS = 20_000L

// A path the framework refuses outright, well inside its own timeout, is a
// device saying no rather than a peer being slow, and on some chips the
// refusal comes with a Wi-Fi reset; that peer waits the full backoff before
// being asked again.
private const val PATH_REFUSED_FAST_MS = 2_000L

private const val MAINTENANCE_MS = 15_000L

// A heartbeat every 8 s against a 10 s read deadline, three misses allowed:
// a dead link closes in about thirty seconds. A socket that has not sent its
// hello by then is not a link at all.
private const val HEARTBEAT_MS = 8_000L
private const val READ_TIMEOUT_MS = 10_000
private const val IDLE_LIMIT = 3
private const val HELLO_TIMEOUT_MS = 5_000L

// A publish/subscribe pair can go quiet under the framework with no callback
// saying so. Reopening them is what a WiFi toggle does, and a data path
// outlives the discovery session it was negotiated on, so links are kept.
private const val DISCOVERY_IDLE_REFRESH_MS = 3 * 60_000L
private const val STUCK_PEER_MS = 2 * 60_000L
private const val STUCK_PEER_ATTEMPTS = 4
private const val REFRESH_MIN_INTERVAL_MS = 90_000L

// A discovery session the framework ended is reopened after a pause. If it
// keeps happening the attach itself is the problem and the transport is
// rebuilt through the JS reconciler.
private const val SESSION_RESTART_DELAY_MS = 2_000L
private const val SESSION_TERMINATIONS_LIMIT = 3
private const val SESSION_TERMINATIONS_WINDOW_MS = 2 * 60_000L

// After a link closes, the far side is releasing its half of the path at the
// same moment; dialling into that is the connect that aborts.
private const val REDIAL_DELAY_MS = 2_000L

private const val PEER_STALE_MS = 5 * 60_000L

private const val LOG_CAPACITY = 300

// The peer's address is a link-local IPv6 in WifiAwareNetworkInfo, which is
// API 29; below it there is no data path and AirhopWiFiPackage registers
// nothing.
@RequiresApi(Build.VERSION_CODES.Q)
class AirhopWiFiModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "AirhopWiFi"

    // ---- State model ---------------------------------------------------------

    private enum class Role { INITIATOR, RESPONDER }

    //   IDLE          known, nothing in flight; the tick decides when to dial
    //   REQUESTED     REQUEST sent, waiting for READY
    //   PATH_PENDING  a requestNetwork() is outstanding, in either role
    //   CONNECTED     a socket is open and registered
    private enum class DialState { IDLE, REQUESTED, PATH_PENDING, CONNECTED }

    // Handles are session-scoped: cleared on every discovery restart, refilled
    // by the next match or message.
    private class Peer(val instance: String) {
        var subscribeHandle: PeerHandle? = null
        var publishHandle: PeerHandle? = null
        var token: ByteArray? = null
        var state = DialState.IDLE
        var role: Role? = null
        var stateSinceMs = 0L
        // Our attempt counter as initiator.
        var epoch = 0
        // The newest epoch the peer has sent, answered or not.
        var peerEpoch = -1
        var network: ConnectivityManager.NetworkCallback? = null
        var linkID: String? = null
        var attempts = 0
        var nextAttemptAtMs = 0L
        // When this peer last became one to dial: first discovery, or its last
        // link closing. The grace period and the stuck check count from here.
        var idleSinceMs = 0L
        var lastSeenAtMs = 0L
    }

    private class LinkState(
        val id: String,
        val socket: Socket,
        val output: OutputStream,
        // Two interleaved frames corrupt the length prefix for good.
        val writeLock: Any = Any(),
    ) {
        @Volatile var peerInstance: String? = null
        @Volatile var hasHello = false
        @Volatile var lastReadAtMs = SystemClock.elapsedRealtime()
        var heartbeat: ScheduledFuture<*>? = null
    }

    // ---- Executors and framework handles -------------------------------------

    // Every mutation runs on this one thread. Framework callbacks arrive on the
    // main looper or the connectivity thread, bridge calls on the native
    // modules thread and socket work on the IO pool; all hop here first.
    private val state = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "airhop-wifi-state")
    }
    private val ioExecutor = Executors.newCachedThreadPool()

    private val connectivityManager: ConnectivityManager =
        reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    // A fact about the hardware, unlike the service object, which can be
    // momentarily absent on a device that has the feature.
    private val hasAwareFeature: Boolean =
        try {
            reactContext.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE)
        } catch (_: Exception) {
            false
        }

    // Per call: the module is constructed early in startup, and a service not
    // ready then would read as absent for the life of the process.
    private fun awareManager(): WifiAwareManager? =
        try {
            reactContext.applicationContext.getSystemService(WifiAwareManager::class.java)
        } catch (_: Exception) {
            null
        }

    private var awareSession: WifiAwareSession? = null
    private var attaching = false
    private var publishSession: PublishDiscoverySession? = null
    private var subscribeSession: SubscribeDiscoverySession? = null

    // Bumped by teardown and by a discovery restart respectively, so a callback
    // from a session we closed ourselves is told apart from one dropped under us.
    private val sessionGeneration = AtomicInteger(0)
    private val discoveryGeneration = AtomicInteger(0)
    private var maintenance: ScheduledFuture<*>? = null

    private val peers = HashMap<String, Peer>()
    private val subscribeHandles = HashMap<PeerHandle, String>()
    // Follow-up message id to the peer it was sent to, for onMessageSendFailed.
    private val pendingSends = HashMap<Int, String>()
    private val sendCounter = AtomicInteger(1)

    // Read by writeToWiFiLink off the state thread; mutated only on it.
    private val links = ConcurrentHashMap<String, LinkState>()
    private val linkCounter = AtomicInteger(0)

    // ConnectivityManager caps an app at roughly a hundred outstanding requests.
    private val networkCallbacks = HashSet<ConnectivityManager.NetworkCallback>()

    // One server socket per attach; setPort() names a port already listening.
    private var serverSocket: ServerSocket? = null
    @Volatile private var serverPort: Int = 0

    private var localToken: ByteArray = ByteArray(0)
    private val instanceId: ByteArray =
        ByteArray(AwareDial.INSTANCE_BYTES).also { SecureRandom().nextBytes(it) }
    private val instanceHex: String = instanceId.toHex()

    private var lastActivityAtMs = 0L
    private var lastRefreshAtMs = 0L
    private var attachedAtMs = 0L
    private val sessionTerminationsAtMs = ArrayDeque<Long>()

    private var listenerCount = 0

    // ---- Logging -------------------------------------------------------------

    // Kept in the process as well as logcat: Samsung retail builds drop every
    // line below warning at the log daemon, and Diagnostics reads this instead.
    private val recentLog = ArrayDeque<String>()
    private val logClock = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    private fun log(priority: Int, message: String) {
        Log.println(priority, TAG, message)
        val level = when (priority) {
            Log.ERROR -> 'E'
            Log.WARN -> 'W'
            else -> 'I'
        }
        // The formatter is not thread-safe.
        synchronized(recentLog) {
            if (recentLog.size >= LOG_CAPACITY) recentLog.removeFirst()
            recentLog.addLast("${logClock.format(Date())} $level $message")
        }
    }

    private fun logI(message: String) = log(Log.INFO, message)
    private fun logW(message: String) = log(Log.WARN, message)
    private fun logE(message: String) = log(Log.ERROR, message)

    // ---- Thread hopping ------------------------------------------------------

    // False once invalidate() has shut the executor down, for the bridge
    // methods that owe a promise an answer either way.
    private fun onState(block: () -> Unit): Boolean =
        try {
            state.execute {
                try {
                    block()
                } catch (e: Exception) {
                    logE("State task failed: ${e.message}")
                }
            }
            true
        } catch (_: Exception) {
            false
        }

    private fun onIo(block: () -> Unit): Boolean =
        try {
            ioExecutor.execute(block)
            true
        } catch (_: Exception) {
            false
        }

    private fun now(): Long = SystemClock.elapsedRealtime()

    // ---- Start / Stop --------------------------------------------------------

    // UNSUPPORTED is permanent and asked first; UNAVAILABLE is about this
    // minute and retried by the JS reconciler.
    @ReactMethod
    fun startWiFi(promise: Promise) {
        if (!hasAwareFeature) {
            promise.reject("WIFI_AWARE_UNSUPPORTED", "WiFi Aware not supported on this device")
            return
        }
        if (!onState { startOnState(promise) }) {
            promise.reject("WIFI_AWARE_UNAVAILABLE", "WiFi transport is shutting down")
        }
    }

    private fun startOnState(promise: Promise) {
        val manager = awareManager()
        if (manager == null || !manager.isAvailable) {
            promise.reject("WIFI_AWARE_UNAVAILABLE", "WiFi Aware is not available right now")
            return
        }
        if (awareSession != null) {
            promise.resolve(null)
            return
        }
        if (attaching) {
            promise.reject("WIFI_AWARE_ATTACH_FAILED", "An attach is already in flight")
            return
        }

        localToken = ByteArray(AwareDial.TOKEN_BYTES).also { SecureRandom().nextBytes(it) }
        val generation = sessionGeneration.get()
        attaching = true
        try {
            manager.attach(object : AttachCallback() {
                override fun onAttached(session: WifiAwareSession) {
                    onState {
                        attaching = false
                        adoptSession(session, generation, promise)
                    }
                }

                override fun onAttachFailed() {
                    onState { attaching = false }
                    logW("WiFi Aware attach failed")
                    promise.reject("WIFI_AWARE_ATTACH_FAILED", "Failed to attach to WiFi Aware")
                }

                override fun onAwareSessionTerminated() {
                    onState {
                        if (generation != sessionGeneration.get()) return@onState
                        logW("WiFi Aware session terminated by the framework")
                        reportUnavailable()
                    }
                }
            }, null)
        } catch (e: SecurityException) {
            attaching = false
            promise.reject("PERMISSION_DENIED", "WiFi Aware permission missing", e)
        } catch (e: Exception) {
            attaching = false
            promise.reject("WIFI_AWARE_ATTACH_FAILED", e.message, e)
        }
    }

    // The session is adopted only once everything under it is up: a handle set
    // earlier would make every later startWiFi() resolve over a transport with
    // nothing published, subscribed or listening.
    private fun adoptSession(session: WifiAwareSession, generation: Int, promise: Promise) {
        if (generation != sessionGeneration.get()) {
            runCatching { session.close() }
            promise.reject("WIFI_AWARE_UNAVAILABLE", "Stopped while attaching")
            return
        }
        if (!ensureServerSocket()) {
            runCatching { session.close() }
            promise.reject("WIFI_AWARE_ATTACH_FAILED", "Could not open the data-path socket")
            return
        }
        awareSession = session
        attachedAtMs = now()
        lastActivityAtMs = attachedAtMs
        sessionTerminationsAtMs.clear()
        logI("WiFi Aware attached, instance $instanceHex, port $serverPort")
        // attach() can succeed while publish and subscribe are refused, when
        // NEARBY_WIFI_DEVICES lands a moment late.
        if (!startDiscovery()) {
            teardown()
            promise.reject("PERMISSION_DENIED", "WiFi Aware discovery refused")
            return
        }
        maintenance?.cancel(false)
        maintenance = state.scheduleWithFixedDelay(
            { runCatching { maintain() }.onFailure { logE("Maintenance failed: ${it.message}") } },
            MAINTENANCE_MS,
            MAINTENANCE_MS,
            TimeUnit.MILLISECONDS,
        )
        promise.resolve(null)
    }

    @ReactMethod
    fun stopWiFi(promise: Promise) {
        val accepted = onState {
            teardown()
            promise.resolve(null)
        }
        if (!accepted) promise.resolve(null)
    }

    // Idempotent. Links are announced closed before the map is cleared so JS
    // stops addressing them at once.
    private fun teardown() {
        sessionGeneration.incrementAndGet()
        discoveryGeneration.incrementAndGet()
        maintenance?.cancel(false)
        maintenance = null
        for (callback in networkCallbacks) {
            runCatching { connectivityManager.unregisterNetworkCallback(callback) }
        }
        networkCallbacks.clear()
        peers.clear()
        subscribeHandles.clear()
        pendingSends.clear()

        runCatching { publishSession?.close() }
        runCatching { subscribeSession?.close() }
        runCatching { awareSession?.close() }
        publishSession = null
        subscribeSession = null
        awareSession = null

        runCatching { serverSocket?.close() }
        serverSocket = null
        serverPort = 0

        for (id in links.keys.toList()) closeLink(id, "transport stopped")
    }

    // ---- Availability --------------------------------------------------------

    // The broadcast carries no extras by design; the state is read back from
    // the manager.
    private val awareStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != WifiAwareManager.ACTION_WIFI_AWARE_STATE_CHANGED) return
            onState {
                val available = awareManager()?.isAvailable == true
                if (available == lastReportedAvailable) return@onState
                lastReportedAvailable = available
                logI("WiFi Aware ${if (available) "available" else "unavailable"}")
                // Torn down before JS is told, so a reconcile prompted by the
                // event cannot race a half-released session.
                if (!available) teardown()
                emitEvent(EVT_AVAILABILITY_CHANGED, WritableNativeMap().apply {
                    putBoolean("available", available)
                    putString("reason", REASON_RADIO)
                })
            }
        }
    }

    // Reported as unavailable so the reconciler forgets it is started and
    // re-attaches on its ladder.
    private fun reportUnavailable() {
        teardown()
        lastReportedAvailable = false
        emitEvent(EVT_AVAILABILITY_CHANGED, WritableNativeMap().apply {
            putBoolean("available", false)
            putString("reason", REASON_SESSION)
        })
    }

    // The framework re-broadcasts on transitions either side of the state that
    // matters, and an unchanged report would restart the transport.
    private var lastReportedAvailable: Boolean? = null
    private var awareReceiverRegistered = false

    override fun initialize() {
        super.initialize()
        registerAwareReceiver()
    }

    private fun registerAwareReceiver() {
        if (awareReceiverRegistered) return
        val manager = awareManager() ?: return
        try {
            // A protected system broadcast; NOT_EXPORTED is required from API 34.
            ContextCompat.registerReceiver(
                reactContext,
                awareStateReceiver,
                IntentFilter(WifiAwareManager.ACTION_WIFI_AWARE_STATE_CHANGED),
                ContextCompat.RECEIVER_NOT_EXPORTED,
            )
            awareReceiverRegistered = true
            // Seeded so the first broadcast is compared against reality.
            lastReportedAvailable = manager.isAvailable
        } catch (e: Exception) {
            Log.e(TAG, "Could not register WiFi Aware state receiver", e)
        }
    }

    override fun invalidate() {
        if (awareReceiverRegistered) {
            runCatching { reactContext.unregisterReceiver(awareStateReceiver) }
            awareReceiverRegistered = false
        }
        runCatching { state.submit { teardown() }.get(2, TimeUnit.SECONDS) }
        runCatching { state.shutdownNow() }
        runCatching { ioExecutor.shutdownNow() }
        super.invalidate()
    }

    // ---- Write to a connected peer -------------------------------------------

    @ReactMethod
    fun writeToWiFiLink(linkID: String, dataBase64: String, promise: Promise) {
        val link = links[linkID]
        if (link == null) {
            promise.reject("UNKNOWN_LINK", "No active WiFi link: $linkID")
            return
        }
        val data = try {
            Base64.decode(dataBase64, Base64.NO_WRAP)
        } catch (e: Exception) {
            promise.reject("INVALID_DATA", "Invalid base64 payload", e)
            return
        }
        if (data.size > Framing.MAX_FRAME - Framing.PREFIX_BYTES) {
            promise.reject("FRAME_TOO_LARGE", "Frame of ${data.size} exceeds the peer's read limit")
            return
        }
        // The empty frame is the heartbeat.
        if (data.isEmpty()) {
            promise.reject("INVALID_DATA", "Empty frame")
            return
        }
        val accepted = onIo {
            try {
                writeFrame(link, data)
                promise.resolve(null)
            } catch (e: Exception) {
                logW("Write failed on $linkID: ${e.message}")
                onState { closeLink(linkID, "write failed") }
                promise.reject("WRITE_FAILED", e.message, e)
            }
        }
        if (!accepted) promise.reject("LINK_CLOSED", "WiFi transport is shutting down")
    }

    // Blocking. IO thread, except the hello, which is a few bytes into an
    // empty buffer.
    private fun writeFrame(link: LinkState, data: ByteArray) {
        val frame = Framing.encode(data)
        synchronized(link.writeLock) {
            link.output.write(frame)
            link.output.flush()
        }
    }

    // ---- Required NativeEventEmitter contract --------------------------------

    @ReactMethod
    fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {
        listenerCount++
    }

    // Double, not Int: React Native marshals every JS number as a double and an
    // Int overload is never matched.
    @ReactMethod
    fun removeListeners(count: Double) {
        listenerCount = maxOf(0, listenerCount - count.toInt())
    }

    // ---- Diagnostics ---------------------------------------------------------

    // Peers, links and the recent log as text for the support bundle. Read on
    // the state thread so no peer is described mid-transition.
    @ReactMethod
    fun dumpState(promise: Promise) {
        val accepted = onState {
            val out = StringBuilder()
            val attached = awareSession != null
            out.append("attached: ").append(attached)
            if (attached) {
                out.append(" for ").append((now() - attachedAtMs) / 1000).append("s")
                out.append(", publish ").append(if (publishSession != null) "up" else "down")
                out.append(", subscribe ").append(if (subscribeSession != null) "up" else "down")
            }
            out.append('\n')
            appendResources(out)
            out.append("peers: ").append(peers.size).append('\n')
            val t = now()
            for (peer in peers.values) {
                out.append("  ").append(peer.instance.take(8))
                    .append(' ').append(peer.state.name.lowercase())
                    .append(peer.role?.let { " as ${it.name.lowercase()}" } ?: "")
                    .append(", seen ").append((t - peer.lastSeenAtMs) / 1000).append("s ago")
                    .append(", attempts ").append(peer.attempts)
                    .append(", handles ")
                    .append(if (peer.subscribeHandle != null) "s" else "-")
                    .append(if (peer.publishHandle != null) "p" else "-")
                peer.linkID?.let { out.append(", link ").append(it) }
                out.append('\n')
            }
            out.append("links: ").append(links.size).append('\n')
            for (link in links.values) {
                out.append("  ").append(link.id)
                    .append(' ').append(link.peerInstance?.take(8) ?: "no hello yet")
                    .append('\n')
            }
            out.append("log:\n")
            val lines = synchronized(recentLog) { recentLog.toList() }
            if (lines.isEmpty()) out.append("  empty\n")
            for (line in lines) out.append("  ").append(line).append('\n')
            promise.resolve(out.toString())
        }
        if (!accepted) promise.resolve("")
    }

    // Zero free publish, subscribe or data-path slots is the one hardware
    // answer to "attached and nothing ever connects".
    private fun appendResources(out: StringBuilder) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val resources = runCatching { awareManager()?.availableAwareResources }.getOrNull() ?: return
        out.append("resources: ")
            .append(resources.availableDataPathsCount).append(" data paths, ")
            .append(resources.availablePublishSessionsCount).append(" publish, ")
            .append(resources.availableSubscribeSessionsCount).append(" subscribe\n")
    }

    // ---- Discovery -----------------------------------------------------------

    // False when publish or subscribe was refused outright; an asynchronous
    // refusal arrives through onSessionConfigFailed.
    private fun startDiscovery(): Boolean {
        val session = awareSession ?: return false
        val generation = discoveryGeneration.incrementAndGet()
        lastActivityAtMs = now()
        return startPublish(session, generation) && startSubscribe(session, generation)
    }

    // Fresh sessions on the same attach. Every handle is stale from here, so
    // unlinked peers go back to idle until matched again; linked peers keep
    // their links.
    private fun restartDiscovery(reason: String) {
        if (awareSession == null) return
        logI("Restarting WiFi Aware discovery: $reason")
        lastRefreshAtMs = now()
        runCatching { publishSession?.close() }
        runCatching { subscribeSession?.close() }
        publishSession = null
        subscribeSession = null
        subscribeHandles.clear()
        pendingSends.clear()
        for (peer in peers.values) {
            peer.subscribeHandle = null
            peer.publishHandle = null
            if (peer.state == DialState.CONNECTED) continue
            releasePath(peer)
            peer.state = DialState.IDLE
            peer.role = null
            peer.attempts = 0
            peer.nextAttemptAtMs = 0
        }
        if (!startDiscovery()) reportUnavailable()
    }

    // The framework ends discovery sessions under a healthy attach on some
    // devices when Bluetooth is toggled (the radios share a chip), and on every
    // device a moment before the state broadcast that says WiFi went off.
    private fun onDiscoverySessionTerminated(which: String, generation: Int) {
        if (generation != discoveryGeneration.get()) return
        logW("WiFi Aware $which session terminated by the framework")
        val t = now()
        sessionTerminationsAtMs.addLast(t)
        while (sessionTerminationsAtMs.isNotEmpty() &&
            t - sessionTerminationsAtMs.first() > SESSION_TERMINATIONS_WINDOW_MS
        ) {
            sessionTerminationsAtMs.removeFirst()
        }
        if (sessionTerminationsAtMs.size >= SESSION_TERMINATIONS_LIMIT) {
            logW("Discovery keeps ending, rebuilding the transport")
            reportUnavailable()
            return
        }
        val attach = sessionGeneration.get()
        state.schedule({
            if (attach != sessionGeneration.get()) return@schedule
            if (generation != discoveryGeneration.get()) return@schedule
            restartDiscovery("$which session ended")
        }, SESSION_RESTART_DELAY_MS, TimeUnit.MILLISECONDS)
    }

    private fun publishConfig(): PublishConfig {
        val builder = PublishConfig.Builder()
            .setServiceName(SERVICE_NAME)
            .setServiceSpecificInfo(localToken + instanceId)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && instantModeOn()) {
            runCatching { builder.setInstantCommunicationModeEnabled(true, ScanResult.WIFI_BAND_24_GHZ) }
        }
        return builder.build()
    }

    private fun subscribeConfig(): SubscribeConfig {
        val builder = SubscribeConfig.Builder().setServiceName(SERVICE_NAME)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && instantModeOn()) {
            runCatching { builder.setInstantCommunicationModeEnabled(true, ScanResult.WIFI_BAND_24_GHZ) }
        }
        return builder.build()
    }

    // Instant communication mode runs discovery and path setup at full duty for
    // a session's first thirty seconds, which is where every start and restart
    // spends its time. The setter throws where the device has it off, and only
    // some chipsets accept 5 GHz for it.
    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private fun instantModeOn(): Boolean =
        runCatching { awareManager()?.isInstantCommunicationModeEnabled == true }.getOrDefault(false)

    private fun startPublish(session: WifiAwareSession, generation: Int): Boolean {
        try {
            session.publish(publishConfig(), object : DiscoverySessionCallback() {
                override fun onSessionConfigFailed() {
                    onState {
                        if (generation != discoveryGeneration.get()) return@onState
                        logE("WiFi Aware publish config refused")
                        reportUnavailable()
                    }
                }

                override fun onPublishStarted(started: PublishDiscoverySession) {
                    onState {
                        if (generation != discoveryGeneration.get()) {
                            runCatching { started.close() }
                            return@onState
                        }
                        publishSession = started
                        logI("WiFi Aware publish started")
                    }
                }

                override fun onSessionTerminated() {
                    onState {
                        if (generation == discoveryGeneration.get()) publishSession = null
                        onDiscoverySessionTerminated("publish", generation)
                    }
                }

                override fun onMessageReceived(peerHandle: PeerHandle, message: ByteArray) {
                    onState {
                        if (generation != discoveryGeneration.get()) return@onState
                        if (AwareDial.isFollowUp(message, AwareDial.MSG_CONNECT_REQUEST)) {
                            onConnectRequest(peerHandle, message)
                        }
                    }
                }
            }, null)
            return true
        } catch (e: Exception) {
            logE("Publish refused: ${e.message}")
            return false
        }
    }

    private fun startSubscribe(session: WifiAwareSession, generation: Int): Boolean {
        try {
            session.subscribe(subscribeConfig(), object : DiscoverySessionCallback() {
                override fun onSessionConfigFailed() {
                    onState {
                        if (generation != discoveryGeneration.get()) return@onState
                        logE("WiFi Aware subscribe config refused")
                        reportUnavailable()
                    }
                }

                override fun onSubscribeStarted(started: SubscribeDiscoverySession) {
                    onState {
                        if (generation != discoveryGeneration.get()) {
                            runCatching { started.close() }
                            return@onState
                        }
                        subscribeSession = started
                        logI("WiFi Aware subscribe started")
                    }
                }

                override fun onServiceDiscovered(
                    peerHandle: PeerHandle,
                    serviceSpecificInfo: ByteArray?,
                    matchFilter: List<ByteArray>?,
                ) {
                    onState {
                        if (generation != discoveryGeneration.get()) return@onState
                        onPeerDiscovered(peerHandle, serviceSpecificInfo)
                    }
                }

                // API 31; never invoked below it.
                override fun onServiceLost(peerHandle: PeerHandle, reason: Int) {
                    onState {
                        if (generation != discoveryGeneration.get()) return@onState
                        val instance = subscribeHandles.remove(peerHandle) ?: return@onState
                        val peer = peers[instance] ?: return@onState
                        if (peer.subscribeHandle == peerHandle) peer.subscribeHandle = null
                        logI("Peer ${instance.take(8)} lost from discovery (reason $reason)")
                    }
                }

                override fun onMessageReceived(peerHandle: PeerHandle, message: ByteArray) {
                    onState {
                        if (generation != discoveryGeneration.get()) return@onState
                        if (AwareDial.isFollowUp(message, AwareDial.MSG_CONNECT_READY)) {
                            onConnectReady(peerHandle, message)
                        }
                    }
                }

                override fun onMessageSendSucceeded(messageId: Int) {
                    onState { pendingSends.remove(messageId) }
                }

                override fun onMessageSendFailed(messageId: Int) {
                    onState {
                        val instance = pendingSends.remove(messageId) ?: return@onState
                        val peer = peers[instance] ?: return@onState
                        if (peer.state != DialState.REQUESTED) return@onState
                        logW("Connect request to ${instance.take(8)} could not be sent")
                        attemptFailed(peer)
                    }
                }

                override fun onSessionTerminated() {
                    onState {
                        if (generation == discoveryGeneration.get()) subscribeSession = null
                        onDiscoverySessionTerminated("subscribe", generation)
                    }
                }
            }, null)
            return true
        } catch (e: Exception) {
            logE("Subscribe refused: ${e.message}")
            return false
        }
    }

    // ---- Peers ---------------------------------------------------------------

    private fun peerFor(instance: String): Peer {
        val t = now()
        lastActivityAtMs = t
        val peer = peers.getOrPut(instance) {
            Peer(instance).also {
                it.idleSinceMs = t
                logI("New peer ${instance.take(8)}")
            }
        }
        peer.lastSeenAtMs = t
        return peer
    }

    private fun onPeerDiscovered(peerHandle: PeerHandle, ssi: ByteArray?) {
        val instance = ssi?.let { AwareDial.instanceFrom(it, AwareDial.TOKEN_BYTES) } ?: return
        if (instance == instanceHex) return
        val peer = peerFor(instance)
        peer.subscribeHandle = peerHandle
        peer.token = ssi.copyOfRange(0, AwareDial.TOKEN_BYTES)
        subscribeHandles[peerHandle] = instance
        logI("Discovered ${instance.take(8)}, ${if (prefersInitiator(peer)) "dialling" else "waiting for its dial"}")
        if (peer.state == DialState.IDLE && prefersInitiator(peer) && now() >= peer.nextAttemptAtMs) {
            dial(peer)
        }
    }

    private fun prefersInitiator(peer: Peer): Boolean =
        AwareDial.prefersInitiator(localToken, peer.token)

    // ---- Initiator -----------------------------------------------------------

    // Only the REQUEST goes out here. Requesting the path now would fire before
    // the responder had read it, against a peer with nothing outstanding.
    private fun dial(peer: Peer) {
        val session = subscribeSession ?: return
        val handle = peer.subscribeHandle ?: return
        peer.epoch = (peer.epoch + 1) and 0xff
        peer.state = DialState.REQUESTED
        peer.role = Role.INITIATOR
        peer.stateSinceMs = now()
        val messageId = sendCounter.getAndIncrement()
        logI("Dialling ${peer.instance.take(8)}, epoch ${peer.epoch}, attempt ${peer.attempts + 1}")
        try {
            pendingSends[messageId] = peer.instance
            session.sendMessage(handle, messageId, AwareDial.followUp(AwareDial.MSG_CONNECT_REQUEST, instanceId, peer.epoch))
        } catch (e: Exception) {
            pendingSends.remove(messageId)
            logW("Connect request to ${peer.instance.take(8)} refused: ${e.message}")
            attemptFailed(peer)
        }
    }

    private fun onConnectReady(peerHandle: PeerHandle, message: ByteArray) {
        val instance = AwareDial.instanceFrom(message, 1) ?: return
        val peer = peers[instance] ?: return
        peer.lastSeenAtMs = now()
        lastActivityAtMs = peer.lastSeenAtMs
        if (peer.state != DialState.REQUESTED) return
        if (AwareDial.epochOf(message) != peer.epoch) return
        val session = subscribeSession ?: return
        peer.subscribeHandle = peerHandle
        subscribeHandles[peerHandle] = instance
        logI("Peer ${instance.take(8)} is ready, requesting data path")
        peer.state = DialState.PATH_PENDING
        peer.stateSinceMs = now()
        val specifier = WifiAwareNetworkSpecifier.Builder(session, peerHandle)
            .setPskPassphrase(DATA_PATH_PASSPHRASE)
            .build()
        requestPath(peer, specifier) { network, info, callback ->
            val address = info.peerIpv6Addr
            val port = info.port
            // onLost never fires for a path that is still up, so one that
            // cannot carry a socket is released here.
            if (address == null || port <= 0) {
                logW("Aware network to ${instance.take(8)} came up with no peer address or port")
                if (peer.network === callback) attemptFailed(peer)
                return@requestPath
            }
            onIo { connectAndRegister(peer, network, address, port, callback) }
        }
    }

    // IO thread.
    private fun connectAndRegister(
        peer: Peer,
        network: Network,
        address: Inet6Address,
        port: Int,
        callback: ConnectivityManager.NetworkCallback,
    ) {
        var failure: Exception? = null
        for (attempt in 1..CONNECT_ATTEMPTS) {
            try {
                Thread.sleep(if (attempt == 1) CONNECT_SETTLE_MS else CONNECT_RETRY_MS)
            } catch (_: InterruptedException) {
                return
            }
            var socket: Socket? = null
            try {
                val connected = network.socketFactory.createSocket()
                socket = connected
                connected.connect(InetSocketAddress(address, port), CONNECT_TIMEOUT_MS)
                onState {
                    // Released while connecting: a teardown, a restart or a
                    // newer attempt.
                    if (peer.network !== callback || peers[peer.instance] !== peer) {
                        runCatching { connected.close() }
                        return@onState
                    }
                    registerLink("wifi-out-${linkCounter.incrementAndGet()}", connected, peer)
                }
                return
            } catch (e: Exception) {
                failure = e
                runCatching { socket?.close() }
                if (attempt < CONNECT_ATTEMPTS) {
                    logI("Connect to ${peer.instance.take(8)} attempt $attempt failed: ${e.message}")
                }
            }
        }
        logW("Connect to ${peer.instance.take(8)} failed: ${failure?.message}")
        onState { if (peer.network === callback) attemptFailed(peer) }
    }

    // ---- Responder -----------------------------------------------------------

    private fun onConnectRequest(peerHandle: PeerHandle, message: ByteArray) {
        val session = publishSession ?: return
        val instance = AwareDial.instanceFrom(message, 1) ?: return
        if (instance == instanceHex) return
        val epoch = AwareDial.epochOf(message)
        val peer = peerFor(instance)
        peer.publishHandle = peerHandle

        // A request already seen: delivered twice, or a copy of one that lost
        // the tiebreak arriving late. Answered again while our side of it
        // stands, since the READY may be the half that was lost.
        val responding = peer.role == Role.RESPONDER && peer.state != DialState.IDLE
        if (epoch <= peer.peerEpoch) {
            if (responding && epoch == peer.peerEpoch) sendReady(session, peerHandle, epoch)
            return
        }
        peer.peerEpoch = epoch

        when (peer.state) {
            DialState.CONNECTED -> {
                // A link that carried traffic within two heartbeats is not one
                // the peer has lost; this request predates it and arrived late.
                val link = peer.linkID?.let { links[it] }
                if (link != null && now() - link.lastReadAtMs < HEARTBEAT_MS * 2) return
                logI("Peer ${instance.take(8)} reconnecting, dropping our link ${peer.linkID}")
                peer.linkID?.let { closeLink(it, "peer reconnecting") }
            }
            DialState.REQUESTED, DialState.PATH_PENDING -> {
                // Both dialled at once. The tokens settle it the same way on
                // both ends: the lower keeps its attempt, the higher yields.
                if (peer.role == Role.INITIATOR) {
                    if (prefersInitiator(peer)) return
                    logI("Yielding to ${instance.take(8)}'s dial")
                }
                releasePath(peer)
                peer.state = DialState.IDLE
                peer.role = null
            }
            DialState.IDLE -> {}
        }

        logI("Peer ${instance.take(8)} dialling us, epoch $epoch, opening our side")
        peer.state = DialState.PATH_PENDING
        peer.role = Role.RESPONDER
        peer.stateSinceMs = now()
        val specifier = WifiAwareNetworkSpecifier.Builder(session, peerHandle)
            .setPskPassphrase(DATA_PATH_PASSPHRASE)
            .setPort(serverPort)
            .setTransportProtocol(OsConstants.IPPROTO_TCP)
            .build()
        requestPath(peer, specifier, null)
        // Sent once our request is outstanding, which is the framework's order.
        sendReady(session, peerHandle, epoch)
    }

    private fun sendReady(session: PublishDiscoverySession, peerHandle: PeerHandle, epoch: Int) {
        runCatching {
            session.sendMessage(peerHandle, sendCounter.getAndIncrement(), AwareDial.followUp(AwareDial.MSG_CONNECT_READY, instanceId, epoch))
        }.onFailure { logW("Could not send connect-ready: ${it.message}") }
    }

    // ---- Data path -----------------------------------------------------------

    private fun requestPath(
        peer: Peer,
        specifier: WifiAwareNetworkSpecifier,
        onPeerReady: ((Network, WifiAwareNetworkInfo, ConnectivityManager.NetworkCallback) -> Unit)?,
    ) {
        releasePath(peer)
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI_AWARE)
            .setNetworkSpecifier(specifier)
            .build()

        val callback = object : ConnectivityManager.NetworkCallback() {
            // Capabilities may be re-delivered; connecting twice is two sockets.
            private var handled = false

            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                val info = capabilities.transportInfo as? WifiAwareNetworkInfo ?: return
                onState {
                    if (handled || onPeerReady == null || peer.network !== this) return@onState
                    handled = true
                    onPeerReady(network, info, this)
                }
            }

            override fun onLost(network: Network) {
                onState {
                    if (peer.network !== this) return@onState
                    logI("Data path to ${peer.instance.take(8)} lost")
                    pathGone(peer)
                }
            }

            override fun onUnavailable() {
                onState {
                    if (peer.network !== this) return@onState
                    logW("Data path to ${peer.instance.take(8)} could not be set up")
                    val refusedFast = now() - peer.stateSinceMs < PATH_REFUSED_FAST_MS
                    pathGone(peer)
                    if (refusedFast && peer.state == DialState.IDLE) {
                        peer.nextAttemptAtMs = now() + AwareDial.BACKOFF_MAX_MS
                    }
                }
            }
        }

        try {
            connectivityManager.requestNetwork(request, callback, NETWORK_REQUEST_TIMEOUT_MS)
            networkCallbacks.add(callback)
            peer.network = callback
        } catch (e: Exception) {
            logE("requestNetwork failed: ${e.message}")
            attemptFailed(peer)
        }
    }

    private fun pathGone(peer: Peer) {
        releasePath(peer)
        val linkID = peer.linkID
        if (linkID != null) {
            closeLink(linkID, "data path lost")
        } else if (peer.state != DialState.IDLE) {
            attemptFailed(peer)
        }
    }

    private fun releasePath(peer: Peer) {
        peer.network?.let { release(it) }
        peer.network = null
    }

    private fun release(callback: ConnectivityManager.NetworkCallback) {
        if (!networkCallbacks.remove(callback)) return
        runCatching { connectivityManager.unregisterNetworkCallback(callback) }
    }

    private fun attemptFailed(peer: Peer) {
        releasePath(peer)
        peer.state = DialState.IDLE
        peer.role = null
        peer.attempts += 1
        // Jitter, so two phones do not retry in lockstep.
        val backoff = AwareDial.backoffMs(peer.attempts)
        val jitter = (backoff / 4 * (Math.random() * 2 - 1)).toLong()
        peer.nextAttemptAtMs = now() + backoff + jitter
        logI("Attempt with ${peer.instance.take(8)} failed (${peer.attempts}), next in ${(backoff + jitter) / 1000}s")
    }

    // ---- Maintenance ---------------------------------------------------------

    // Every deadline is applied here rather than by a timer per peer, so one
    // place says what the transport does next.
    private fun maintain() {
        if (awareSession == null) return
        val t = now()
        var stuck = false
        val stale = ArrayList<String>()
        for (peer in peers.values) {
            when (peer.state) {
                DialState.CONNECTED -> continue
                DialState.REQUESTED -> {
                    if (t - peer.stateSinceMs >= REQUEST_TIMEOUT_MS) {
                        logW("No ready from ${peer.instance.take(8)}")
                        attemptFailed(peer)
                    }
                    continue
                }
                DialState.PATH_PENDING -> {
                    // The request has its own timeout; this covers a framework
                    // that never answers either way.
                    if (t - peer.stateSinceMs >= NETWORK_REQUEST_TIMEOUT_MS + MAINTENANCE_MS) {
                        logW("Data path with ${peer.instance.take(8)} never settled")
                        attemptFailed(peer)
                    }
                    continue
                }
                DialState.IDLE -> {}
            }
            if (t - peer.lastSeenAtMs >= PEER_STALE_MS) {
                stale.add(peer.instance)
                continue
            }
            if (t - peer.idleSinceMs >= STUCK_PEER_MS && peer.attempts >= STUCK_PEER_ATTEMPTS) {
                stuck = true
            }
            if (peer.subscribeHandle == null || t < peer.nextAttemptAtMs) continue
            val ourTurn = prefersInitiator(peer) || t - peer.idleSinceMs >= RESPONDER_GRACE_MS
            if (ourTurn) dial(peer)
        }
        for (instance in stale) {
            logI("Forgetting ${instance.take(8)}, not seen for ${PEER_STALE_MS / 60_000} minutes")
            forgetPeer(instance)
        }

        if (t - lastRefreshAtMs < REFRESH_MIN_INTERVAL_MS) return
        if (stuck) {
            restartDiscovery("a peer keeps failing to connect")
        } else if (links.isEmpty() && t - lastActivityAtMs >= DISCOVERY_IDLE_REFRESH_MS) {
            restartDiscovery("idle for ${(t - lastActivityAtMs) / 1000}s")
        }
    }

    private fun forgetPeer(instance: String) {
        val peer = peers.remove(instance) ?: return
        releasePath(peer)
        peer.subscribeHandle?.let { subscribeHandles.remove(it) }
    }

    // ---- Sockets -------------------------------------------------------------

    // Dual-stack by default, which an inbound link-local IPv6 connect needs.
    private fun ensureServerSocket(): Boolean {
        if (serverSocket != null) return true
        return try {
            val socket = ServerSocket(0)
            serverSocket = socket
            serverPort = socket.localPort
            onIo { acceptLoop(socket) }
            true
        } catch (e: Exception) {
            logE("Could not open the WiFi Aware server socket: ${e.message}")
            false
        }
    }

    // IO thread. An accepted socket is attributed by the hello it sends.
    private fun acceptLoop(socket: ServerSocket) {
        while (!socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (e: Exception) {
                logI("Accept loop ended: ${e.message}")
                return
            }
            onState {
                if (serverSocket !== socket) {
                    runCatching { client.close() }
                    return@onState
                }
                registerLink("wifi-in-${linkCounter.incrementAndGet()}", client, null)
            }
        }
    }

    // State thread. Sends the hello before JS can write, so it is the first
    // frame on the wire.
    private fun registerLink(id: String, socket: Socket, peer: Peer?) {
        lastActivityAtMs = now()
        val link: LinkState
        try {
            socket.tcpNoDelay = true
            socket.keepAlive = true
            socket.soTimeout = READ_TIMEOUT_MS
            link = LinkState(id, socket, socket.getOutputStream())
            writeFrame(link, AwareDial.hello(instanceId))
        } catch (e: Exception) {
            logE("Could not register link $id: ${e.message}")
            runCatching { socket.close() }
            if (peer != null && peer.state != DialState.CONNECTED) attemptFailed(peer)
            return
        }
        links[id] = link
        if (peer != null) attachLink(link, peer)
        emitEvent(EVT_LINK_CONNECTED, WritableNativeMap().apply { putString("linkID", id) })
        logI("WiFi Aware link connected: $id${peer?.let { " to ${it.instance.take(8)}" } ?: ""}")
        state.schedule({
            if (links[id] === link && !link.hasHello) closeLink(id, "no hello")
        }, HELLO_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        val input = socket.getInputStream()
        onIo { readLoop(link, input) }
    }

    // One link per peer, the newest. The new link is claimed before the old
    // one closes, so closeLink leaves the peer and its path alone.
    private fun attachLink(link: LinkState, peer: Peer) {
        val previous = peer.linkID
        link.peerInstance = peer.instance
        peer.linkID = link.id
        if (previous != null && previous != link.id) {
            logI("Replacing link $previous to ${peer.instance.take(8)} with ${link.id}")
            closeLink(previous, "replaced")
        }
        peer.state = DialState.CONNECTED
        peer.stateSinceMs = now()
        peer.lastSeenAtMs = peer.stateSinceMs
        peer.attempts = 0
        peer.nextAttemptAtMs = 0
    }

    private fun onHello(link: LinkState, instance: String) {
        if (links[link.id] !== link) return
        if (link.peerInstance == null) {
            attachLink(link, peerFor(instance))
        } else if (link.peerInstance != instance) {
            logW("Link ${link.id} hello names ${instance.take(8)}, expected ${link.peerInstance?.take(8)}")
            closeLink(link.id, "hello mismatch")
            return
        }
        if (link.hasHello) return
        link.hasHello = true
        link.heartbeat = state.scheduleWithFixedDelay({
            onIo {
                try {
                    writeFrame(link, ByteArray(0))
                } catch (e: Exception) {
                    onState { closeLink(link.id, "heartbeat failed") }
                }
            }
        }, HEARTBEAT_MS, HEARTBEAT_MS, TimeUnit.MILLISECONDS)
    }

    // IO thread.
    private fun readLoop(link: LinkState, input: InputStream) {
        val lenBuf = ByteArray(4)
        var idleTimeouts = 0
        // A deadline that lands with part of a frame in hand cannot be waited
        // out: the next read would take the rest of it for a length prefix.
        var inFrame = 0
        while (true) {
            try {
                inFrame = 0
                while (inFrame < 4) {
                    val n = input.read(lenBuf, inFrame, 4 - inFrame)
                    if (n < 0) throw EOFException("EOF in length prefix")
                    inFrame += n
                }
                val len = Framing.length(lenBuf) ?: throw Exception("invalid frame length")
                idleTimeouts = 0
                link.lastReadAtMs = now()
                if (len == 0) continue

                val data = ByteArray(len)
                var received = 0
                while (received < len) {
                    val n = input.read(data, received, len - received)
                    if (n < 0) throw EOFException("EOF in frame body")
                    received += n
                    inFrame += n
                }
                val hello = AwareDial.helloInstance(data)
                if (hello != null) {
                    onState { onHello(link, hello) }
                    continue
                }
                if (!link.hasHello) throw Exception("traffic before hello")
                emitEvent(EVT_PACKET_RECEIVED, WritableNativeMap().apply {
                    putString("linkID", link.id)
                    putString("dataBase64", Base64.encodeToString(data, Base64.NO_WRAP))
                })
            } catch (e: SocketTimeoutException) {
                if (inFrame > 0) {
                    onState { closeLink(link.id, "stalled mid-frame") }
                    return
                }
                idleTimeouts += 1
                if (idleTimeouts < IDLE_LIMIT) continue
                onState { closeLink(link.id, "idle past deadline") }
                return
            } catch (e: Exception) {
                val reason = e.message ?: e.javaClass.simpleName
                onState { closeLink(link.id, reason) }
                return
            }
        }
    }

    // State thread.
    private fun closeLink(linkID: String, reason: String) {
        val link = links.remove(linkID) ?: return
        link.heartbeat?.cancel(false)
        runCatching { link.socket.close() }
        logI("WiFi Aware link closed: $linkID ($reason)")
        val peer = link.peerInstance?.let { peers[it] }
        if (peer != null && peer.linkID == linkID) {
            peer.linkID = null
            releasePath(peer)
            peer.state = DialState.IDLE
            peer.role = null
            peer.idleSinceMs = now()
            peer.nextAttemptAtMs = peer.idleSinceMs + REDIAL_DELAY_MS
        }
        emitEvent(EVT_LINK_DISCONNECTED, WritableNativeMap().apply { putString("linkID", linkID) })
    }

    // ---- Helpers -------------------------------------------------------------

    // Every caller is on the state thread or an IO thread with no handler
    // above it, and getJSModule throws whenever no runtime is attached.
    private fun emitEvent(name: String, params: WritableNativeMap) {
        if (!reactContext.hasActiveReactInstance()) return
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(name, params)
        } catch (e: Exception) {
            Log.w(TAG, "Dropped $name: no JS runtime to receive it (${e.message})")
        }
    }

    companion object {
        // In published source, so it authenticates nothing and need not: every
        // packet on the socket is signed and DMs are sealed in Noise. The
        // specifier requires the two sides to agree on one.
        private const val DATA_PATH_PASSPHRASE = "airhop-aware-psk"
    }
}
