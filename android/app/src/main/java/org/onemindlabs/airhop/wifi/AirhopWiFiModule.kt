// AirhopWiFiModule: WiFi Aware high-bandwidth transport for Airhop.
//
// Uses Android's WiFi Aware (NAN) API to create peer-to-peer data channels
// without a router or internet connection. Range: ~30 m, ~250 Mbps.
//
// Architecture contract: no protocol or routing logic here. This module
// exposes raw bytes to TypeScript exactly as AirhopBLEModule does.
//
// Three operations:
//   1. Publish: advertise this device as an Airhop WiFi Aware peer.
//   2. Subscribe: discover peers advertising the same service.
//   3. Connect: open a socket once WifiAwareNetworkSpecifier is available.
//
// Events emitted to TypeScript (same names as BLE module for symmetry):
//   AirhopWiFi.packetReceived   { linkID, dataBase64 }
//   AirhopWiFi.linkConnected    { linkID }
//   AirhopWiFi.linkDisconnected { linkID }
//
// ---------------------------------------------------------------------------
// Establishing a data path
//
// An Aware data path is not Wi-Fi Direct: there is no group owner and no
// 192.168.49.x subnet, only a private link-local IPv6 interface. The peer
// address is not derivable from the PeerHandle. It arrives once, in
// NetworkCallback.onCapabilitiesChanged as WifiAwareNetworkInfo, so a callback
// implementing only onAvailable never sees it.
//
// The roles are asymmetric although both devices run both halves:
//
//   Responder (publisher): opens a ServerSocket on an ephemeral port and passes
//   it to the specifier via setPort(), then waits. setPort is server-side only;
//   on the initiator it builds a specifier the framework cannot match.
//
//   Initiator (subscriber): no port on the specifier, and connects to
//   getPeerIpv6Addr()/getPort() through that Network's own SocketFactory. The
//   default factory would route over the default network, not the Aware one.
//
// Both sides publish and subscribe, so without a tiebreak each pair opens two
// sockets. Each device carries a random per-attach token in the publish config
// serviceSpecificInfo and dials only when its own token sorts lower. Same shape
// as the crossed Noise handshake tiebreak on the BLE side.
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
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

private const val TAG = "AirhopWiFiModule"

// Airhop WiFi Aware service name. Not a UUID, and not free-form either.
//
// NAN derives the on-air service ID by hashing this exact string, so a
// difference of one character means two devices never match. It therefore has to
// be identical here, in AirhopWiFiModule.swift, and in the `WiFiAwareServices`
// key of ios/Airhop/Info.plist.
//
// The DNS-SD wrapper is Apple's requirement rather than Android's: iOS accepts
// only `_name._tcp` or `_name._udp`, with a name component of at most 15
// characters from [A-Za-z0-9-]. Android accepts any ASCII string under 255
// bytes, so it is the side that follows. bitchat publishes "bitchat" and never
// matches this service.
private const val SERVICE_NAME = "_airhop-mesh-v1._tcp"

// Events emitted to TypeScript.
private const val EVT_PACKET_RECEIVED   = "AirhopWiFi.packetReceived"
private const val EVT_LINK_CONNECTED    = "AirhopWiFi.linkConnected"
private const val EVT_LINK_DISCONNECTED = "AirhopWiFi.linkDisconnected"
// WiFi Aware became usable, or stopped being usable. The counterpart of the BLE
// module's adapterStateChanged, and the event the fast path recovers on.
private const val EVT_AVAILABILITY_CHANGED = "AirhopWiFi.availabilityChanged"

// Sent by a subscriber that has decided to dial, so the publisher knows to
// stand up its side of the data path. The byte is the version, followed by
// the subscriber's instance id.
private const val MSG_CONNECT_REQUEST: Byte = 0x01

// Sent back by the publisher once its own requestNetwork() is outstanding, and
// the subscriber's cue to make its own. The responder's request has to be in
// flight before the initiator asks for the NDP, so discovery is not the cue and
// this reply is. Android's documented data-path sequence, and bitchat's.
private const val MSG_CONNECT_READY: Byte = 0x02

// How long to wait for a data path before giving up on it. The two-argument
// requestNetwork() leaves a failed request pending for the life of the process,
// so onUnavailable() never fires and its callback is never handed back.
private const val NETWORK_REQUEST_TIMEOUT_MS = 30_000

// Maximum raw frame size for a single write. Matches the chunked file transfer
// chunk size in file-transfer.ts (64 KiB) plus the 4-byte length prefix, with
// room to spare.
private const val MAX_FRAME = 65544

// Bytes of tiebreak token carried in serviceSpecificInfo, and of the instance
// id carried beside it.
private const val TOKEN_BYTES = 8

// Which device a discovery belongs to, across the framework handing out a new
// PeerHandle for it. A peer that restarts its session (a WiFi toggle, a
// re-attach) is rediscovered under a fresh handle, and dialling it again
// requests a second data path to a device already holding one: the framework
// replaces the first, the live socket dies, and the new connect aborts on the
// interface that just flipped. Eight random bytes per process, so a peer is
// recognised for as long as its app runs and unlinkable once it restarts.
// Carried after the token in serviceSpecificInfo, and again after the
// MSG_CONNECT_REQUEST byte so the responder learns it too.
private const val INSTANCE_BYTES = 8

// How long a link may be silent before its read is abandoned and the link torn
// down. Generous: the mesh is bursty and a quiet conversation is normal, so this
// is a liveness backstop, not a heartbeat. Matches bitchat's SyncedSocket.
private const val READ_TIMEOUT_MS = 90_000

// Consecutive silent deadlines before a link is treated as half-open. Three at
// 90s is four and a half minutes of a link that has delivered nothing, which is
// well past any normal quiet period including a backgrounded pair under Doze.
private const val MAX_IDLE_TIMEOUTS = 3

// How long an attached session may go without discovering anyone, holding no
// link, before it is restarted. A publish/subscribe pair can go quiet under the
// framework without any callback saying so, and the only cure is the one a
// WiFi toggle applies: close the session and attach again. bitchat/android
// refreshes on the same rule at five minutes. Checked once a minute, and the
// clock restarts on every attach, so an empty room costs one re-attach per
// five minutes and a room with a link costs nothing.
private const val DISCOVERY_IDLE_REFRESH_MS = 5 * 60_000L
private const val DISCOVERY_IDLE_CHECK_MS = 60_000L

// WifiAwareNetworkInfo, and therefore any way to learn the peer's address, is
// API 29. Below that the discovery half of WiFi Aware works and the data path
// does not, so the whole transport reports itself unavailable rather than
// attaching and never connecting. BLE carries everything either way.
private const val AWARE_DATA_PATH_MIN_API = Build.VERSION_CODES.Q

@RequiresApi(Build.VERSION_CODES.O)
class AirhopWiFiModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "AirhopWiFi"

    // Whether this device advertises the Aware feature at all.
    //
    // Asked of the package manager rather than inferred from the service,
    // matching bitchat's WifiAwareSupport. The two answer different questions
    // and only this one is a fact about the hardware: a device can advertise
    // the feature while the service object is momentarily unavailable, and
    // collapsing both into "unsupported" tells the user their phone cannot do
    // something it can.
    private val hasAwareFeature: Boolean =
        try {
            reactContext.packageManager.hasSystemFeature(
                PackageManager.FEATURE_WIFI_AWARE,
            )
        } catch (_: Exception) {
            false
        }

    // Resolved per call, never cached: the module is constructed early in
    // startup, and a service not yet ready at that moment would read as absent
    // for the life of the process. bitchat calls getSystemService at check time
    // for the same reason.
    //
    // The typed overload rather than the string constant plus a cast: a failed
    // `as?` is indistinguishable from an absent service, and one of those is
    // recoverable.
    private fun awareManager(): WifiAwareManager? =
        try {
            reactContext.applicationContext.getSystemService(
                WifiAwareManager::class.java,
            )
        } catch (_: Exception) {
            null
        }

    private var awareSession: WifiAwareSession? = null
    private var publishSession: PublishDiscoverySession? = null
    private var subscribeSession: SubscribeDiscoverySession? = null
    private val connectivityManager: ConnectivityManager =
        reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    // Active bidirectional socket links. Key = linkID (generated on connect).
    private val links = ConcurrentHashMap<String, LinkState>()
    private val linkCounter = AtomicInteger(0)

    // Which set of sessions is current. Bumped by teardown, so one we closed
    // ourselves is told apart from one dropped under us: both arrive as the same
    // callback, and only the second is a reason to re-attach.
    private val sessionGeneration = AtomicInteger(0)
    private val ioExecutor = Executors.newCachedThreadPool()

    // The idle watch. One thread, one scheduled task per attach, cancelled by
    // teardown.
    private val watchExecutor = Executors.newSingleThreadScheduledExecutor()
    @Volatile
    private var idleWatch: ScheduledFuture<*>? = null
    // Last time discovery showed any sign of life: a peer found, a connect
    // message, a link. Seeded by the attach so a fresh session is never judged
    // idle on its first tick. Monotonic, so a clock change cannot fire it.
    private val lastDiscoveryAtMs = AtomicLong(0)

    // Every registered network callback, so stopWiFi and invalidate can hand
    // them back. ConnectivityManager caps an app at roughly a hundred
    // outstanding requests and then throws TooManyRequestsException.
    private val networkCallbacks = ConcurrentHashMap.newKeySet<ConnectivityManager.NetworkCallback>()

    // Peers whose data path is in flight or up, keyed by PeerHandle, so a
    // repeated onServiceDiscovered for the same peer does not open a second
    // socket. Mirrors the advertised-peerID dedup on the BLE side.
    // Lifted by forgetAttempt once the path is gone, so a peer that drops is
    // dialled again on its next rediscovery.
    private val dialledPeers = ConcurrentHashMap.newKeySet<PeerHandle>()

    // The same guard for the other direction. A connect request arrives as a
    // message from the peer, so how often it arrives is not ours to decide.
    private val respondedPeers = ConcurrentHashMap.newKeySet<PeerHandle>()

    // The same guard again for the initiator's request, which hangs off an
    // inbound MSG_CONNECT_READY: how many of those arrive is the publisher's
    // business, and each would be another requestNetwork and another socket.
    private val initiatedPeers = ConcurrentHashMap.newKeySet<PeerHandle>()

    // Responder side: one server socket for the whole session, on an ephemeral
    // port chosen by the OS and told to each peer through setPort().
    private var serverSocket: ServerSocket? = null
    @Volatile
    private var serverPort: Int = 0

    // Our half of the dial tiebreak. Regenerated per attach so it cannot become
    // a stable identifier for this device across sessions.
    @Volatile
    private var localToken: ByteArray = ByteArray(0)

    private val instanceId: ByteArray =
        ByteArray(INSTANCE_BYTES).also { SecureRandom().nextBytes(it) }
    // Instance id of the device on each link, so a rediscovery of a linked peer
    // is not a second dial, and a connect request from a linked peer replaces
    // the link it must have lost.
    private val linkedInstances = ConcurrentHashMap<String, String>()
    // Peer address of a responder-side data path, recorded when it comes up,
    // so the socket the accept loop hands over can be tied to its instance.
    private val instanceByPeerAddress = ConcurrentHashMap<String, String>()
    // Initiator side: the instance behind a handle being dialled, carried
    // through to the link once the socket connects.
    private val pendingInstances = ConcurrentHashMap<PeerHandle, String>()

    private var listenerCount = 0

    private data class LinkState(
        val id: String,
        val socket: Socket,
        val output: OutputStream,
        // Writes arrive on a pooled thread per call, and two interleaved frames
        // corrupt the length prefix and desynchronise the link permanently.
        val writeLock: Any = Any(),
        // The peer and data path a dialled link belongs to, so closing it can
        // free both. Absent on an accepted link: the accept loop cannot tell
        // which peer a socket came from, and the responder's path is released
        // when the initiator's is.
        val peer: PeerHandle? = null,
        val network: ConnectivityManager.NetworkCallback? = null,
        val instance: String? = null,
    )

    // ---- Start / Stop --------------------------------------------------------

    @ReactMethod
    fun startWiFi(promise: Promise) {
        // UNSUPPORTED, not UNAVAILABLE, and the distinction is the whole reason
        // the JS reconciler can exist. No Aware hardware and an OS below the
        // data-path floor are permanent facts about this device; WiFi being off
        // is a fact about this minute. One code for both would leave a caller
        // choosing between retrying a device that will never answer and never
        // retrying one that would have.
        //
        // Order matters: the permanent facts are asked first, so a device that
        // genuinely cannot do this is never told to try again later.
        if (Build.VERSION.SDK_INT < AWARE_DATA_PATH_MIN_API) {
            promise.reject(
                "WIFI_AWARE_UNSUPPORTED",
                "WiFi Aware data paths need Android 10 or later",
            )
            return
        }
        if (!hasAwareFeature) {
            promise.reject("WIFI_AWARE_UNSUPPORTED", "WiFi Aware not supported on this device")
            return
        }
        // The feature is there but the service is not, which is a state rather
        // than a verdict: UNAVAILABLE, so the reconciler keeps retrying instead
        // of latching this device off for the session.
        val manager = awareManager()
        if (manager == null) {
            promise.reject("WIFI_AWARE_UNAVAILABLE", "WiFi Aware is not available right now")
            return
        }
        if (!manager.isAvailable) {
            // WiFi off, or Aware disabled by the OS (it goes away under battery
            // saver and during some tethering states). Transient: the state
            // receiver below reports it coming back, and the JS controller
            // retries on a slow ladder in the meantime.
            promise.reject("WIFI_AWARE_UNAVAILABLE", "WiFi Aware is not available right now")
            return
        }
        if (awareSession != null) {
            promise.resolve(null)
            return
        }

        localToken = ByteArray(TOKEN_BYTES).also { SecureRandom().nextBytes(it) }

        val generation = sessionGeneration.get()
        try {
            manager.attach(object : AttachCallback() {
                override fun onAttached(session: WifiAwareSession) {
                    // Stopped while the attach was in flight. Adopting it now
                    // leaves a live Aware session publishing behind a module
                    // that believes it holds none.
                    if (generation != sessionGeneration.get()) {
                        session.close()
                        promise.reject(
                            "WIFI_AWARE_UNAVAILABLE",
                            "Stopped while attaching",
                        )
                        return
                    }
                    Log.i(TAG, "WiFi Aware attached")
                    // Re-checked rather than relied on from the guard above:
                    // lint cannot follow an API level check across a callback
                    // boundary, and everything below this line is API 29+.
                    if (Build.VERSION.SDK_INT < AWARE_DATA_PATH_MIN_API) {
                        session.close()
                        promise.reject(
                            "WIFI_AWARE_UNSUPPORTED",
                            "WiFi Aware data paths need Android 10 or later",
                        )
                        return
                    }
                    // The server socket has to exist before publishing: its port
                    // is what setPort() advertises to every peer that dials in.
                    //
                    // The session is adopted only once everything below it has
                    // succeeded. A handle set before a failed step would make
                    // the early return at the top of this method resolve every
                    // later startWiFi() instantly, over a transport with nothing
                    // published, subscribed or listening.
                    if (!ensureServerSocket()) {
                        session.close()
                        promise.reject("WIFI_AWARE_ATTACH_FAILED", "Could not open the data-path socket")
                        return
                    }
                    awareSession = session
                    // Both must actually start, or the attach did not give us a
                    // usable transport. attach() can be permitted while publish
                    // and subscribe are refused (NEARBY_WIFI_DEVICES granted a
                    // moment late), and a resolved promise there would latch the
                    // controller on a transport with nothing published.
                    if (!startPublish(session) || !startSubscribe(session)) {
                        teardown()
                        promise.reject(
                            "PERMISSION_DENIED",
                            "WiFi Aware discovery refused"
                        )
                        return
                    }
                    startIdleWatch(generation)
                    promise.resolve(null)
                }

                override fun onAttachFailed() {
                    promise.reject("WIFI_AWARE_ATTACH_FAILED", "Failed to attach to WiFi Aware")
                }
            }, null)
        } catch (e: SecurityException) {
            // NEARBY_WIFI_DEVICES (API 33+) or the location permissions below it.
            // Optional transport, so this is a rejection, never a crash.
            promise.reject("PERMISSION_DENIED", "WiFi Aware permission missing", e)
        } catch (e: Exception) {
            promise.reject("WIFI_AWARE_ATTACH_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun stopWiFi(promise: Promise) {
        teardown()
        promise.resolve(null)
    }

    // Shared by stopWiFi and invalidate. Ordered so nothing is left holding a
    // resource that outlives the thing that would have released it.
    private fun teardown() {
        sessionGeneration.incrementAndGet()
        idleWatch?.cancel(false)
        idleWatch = null
        for (callback in networkCallbacks) {
            runCatching { connectivityManager.unregisterNetworkCallback(callback) }
        }
        networkCallbacks.clear()
        dialledPeers.clear()
        respondedPeers.clear()
        initiatedPeers.clear()
        linkedInstances.clear()
        instanceByPeerAddress.clear()

        runCatching { publishSession?.close() }
        runCatching { subscribeSession?.close() }
        runCatching { awareSession?.close() }
        publishSession = null
        subscribeSession = null
        awareSession = null

        runCatching { serverSocket?.close() }
        serverSocket = null
        serverPort = 0

        // Announced disconnected before the map is cleared, matching
        // releaseRadioState() on the BLE side, so JS stops addressing a dead
        // link immediately. A no-op when there is no runtime (emitEvent guards),
        // which is the invalidate() case.
        for ((linkID, link) in links) {
            runCatching { link.socket.close() }
            emitEvent(EVT_LINK_DISCONNECTED, WritableNativeMap().apply {
                putString("linkID", linkID)
            })
        }
        links.clear()
    }

    // ---- Idle discovery ------------------------------------------------------

    private fun noteDiscoveryActivity() {
        lastDiscoveryAtMs.set(SystemClock.elapsedRealtime())
    }

    // Restart a session that has found nobody for DISCOVERY_IDLE_REFRESH_MS
    // while holding no link. Goes out through reportUnavailable, so the JS
    // reconciler sees exactly what a framework teardown looks like and
    // re-attaches on its ladder; a run this long counts as stable there, so the
    // re-attach is immediate.
    private fun startIdleWatch(generation: Int) {
        noteDiscoveryActivity()
        idleWatch?.cancel(false)
        idleWatch = watchExecutor.scheduleWithFixedDelay({
            if (generation != sessionGeneration.get()) return@scheduleWithFixedDelay
            if (links.isNotEmpty()) return@scheduleWithFixedDelay
            val idleFor = SystemClock.elapsedRealtime() - lastDiscoveryAtMs.get()
            if (idleFor < DISCOVERY_IDLE_REFRESH_MS) return@scheduleWithFixedDelay
            Log.i(TAG, "WiFi Aware discovery idle for ${idleFor / 1000}s, restarting session")
            reportUnavailable()
        }, DISCOVERY_IDLE_CHECK_MS, DISCOVERY_IDLE_CHECK_MS, TimeUnit.MILLISECONDS)
    }

    // ---- Availability --------------------------------------------------------

    // WiFi Aware appearing or disappearing under us.
    //
    // The BLE module has had an ACTION_STATE_CHANGED receiver since the radios
    // were first written, and everything the mesh does about a toggled adapter
    // hangs off it. This side had nothing: `isAvailable` was read once, inside
    // startWiFi, and never again. So WiFi switched off at launch meant a refused
    // attach that nobody retried, and WiFi switched off mid-session left the
    // framework tearing down the discovery sessions while this module kept its
    // attach handle and went on believing it was running.
    //
    // ACTION_WIFI_AWARE_STATE_CHANGED carries no extras by design - the docs are
    // explicit that the state must be read back from the manager - so this asks
    // rather than trusts what it was handed.
    private val awareStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != WifiAwareManager.ACTION_WIFI_AWARE_STATE_CHANGED) return
            val available = awareManager()?.isAvailable == true
            if (available == lastReportedAvailable) return
            lastReportedAvailable = available
            // Losing the radio invalidates everything built on it. Tear our own
            // state down before telling JS, so a reconcile prompted by the event
            // cannot race a half-released session: teardown is idempotent and
            // clearing `awareSession` is what makes the next attach real work
            // rather than the early return at the top of startWiFi.
            if (!available) teardown()
            emitEvent(EVT_AVAILABILITY_CHANGED, WritableNativeMap().apply {
                putBoolean("available", available)
            })
        }
    }

    // Discovery was refused asynchronously. Reported as "unavailable" so the
    // reconciler forgets it is started and retries on its ladder, rather than
    // latching over a transport with nothing published or subscribed.
    //
    // This is the refusal that actually fires when NEARBY_WIFI_DEVICES lands a
    // moment late: publish() and subscribe() accept the call and reject the
    // CONFIG later, through onSessionConfigFailed. The synchronous
    // SecurityException the attach path checks is the rarer case.
    private fun reportDiscoveryRefused(which: String) {
        Log.e(TAG, "WiFi Aware $which config refused")
        reportUnavailable()
    }

    // The framework tore a discovery session down under us, which it does not
    // report as the radio becoming unavailable. Nothing else notices: the attach
    // handle stays healthy with nothing published or subscribed behind it, so
    // every later start resolves at once having done nothing. Samsungs reach it
    // by toggling Bluetooth, which shares a chip with Aware.
    //
    // Ignored once the generation has moved, since teardown closes these
    // sessions itself and gets the same callback for it.
    private fun reportSessionTerminated(which: String, generation: Int) {
        if (generation != sessionGeneration.get()) return
        Log.w(TAG, "WiFi Aware $which session terminated by the framework")
        reportUnavailable()
    }

    private fun reportUnavailable() {
        teardown()
        lastReportedAvailable = false
        emitEvent(EVT_AVAILABILITY_CHANGED, WritableNativeMap().apply {
            putBoolean("available", false)
        })
    }

    // What we last told JS, so a broadcast that does not change the answer costs
    // nothing. The framework re-broadcasts on transitions either side of the
    // state we care about, and an unchanged report would restart the transport.
    private var lastReportedAvailable: Boolean? = null
    private var awareReceiverRegistered = false

    override fun initialize() {
        super.initialize()
        registerAwareReceiver()
    }

    private fun registerAwareReceiver() {
        if (awareReceiverRegistered) return
        // Nothing to listen to on a device with no Aware service.
        val manager = awareManager() ?: return
        try {
            // NOT_EXPORTED for the same reason the BLE module says so: this only
            // ever listens to a protected system broadcast, it is required to be
            // explicit from API 34, and ContextCompat makes it a no-op below.
            ContextCompat.registerReceiver(
                reactContext,
                awareStateReceiver,
                IntentFilter(WifiAwareManager.ACTION_WIFI_AWARE_STATE_CHANGED),
                ContextCompat.RECEIVER_NOT_EXPORTED,
            )
            awareReceiverRegistered = true
            // Seeded from the current state so the first broadcast is compared
            // against reality rather than against "unknown", which would report a
            // change that never happened.
            lastReportedAvailable = manager.isAvailable
        } catch (e: Exception) {
            Log.e(TAG, "Could not register WiFi Aware state receiver", e)
        }
    }

    // The JS runtime is going away. Same reasoning as the BLE module's
    // invalidate(): every link exists to hand bytes to a runtime that is gone.
    override fun invalidate() {
        if (awareReceiverRegistered) {
            runCatching { reactContext.unregisterReceiver(awareStateReceiver) }
            awareReceiverRegistered = false
        }
        teardown()
        runCatching { ioExecutor.shutdownNow() }
        runCatching { watchExecutor.shutdownNow() }
        super.invalidate()
    }

    // ---- Write to a connected peer -------------------------------------------

    @ReactMethod
    fun writeToWiFiLink(linkID: String, dataBase64: String, promise: Promise) {
        val link = links[linkID]
        if (link == null) {
            // UNKNOWN_LINK, matching the BLE module: the same condition on the
            // other transport, so a caller that ever branches on it does not have
            // to know which radio it was talking to.
            promise.reject("UNKNOWN_LINK", "No active WiFi link: $linkID")
            return
        }
        val data = try {
            Base64.decode(dataBase64, Base64.NO_WRAP)
        } catch (e: Exception) {
            promise.reject("INVALID_DATA", "Invalid base64 payload", e)
            return
        }
        if (data.size > MAX_FRAME - 4) {
            promise.reject("FRAME_TOO_LARGE", "Frame of ${data.size} exceeds the peer's read limit")
            return
        }
        // Handing work to the pool is refused once invalidate() has shut it
        // down. Unguarded that throws out of the bridge method with the promise
        // never settled, leaving an await that can never resolve.
        try {
            ioExecutor.execute {
                try {
                    // Length-prefixed frame: [4-byte BE length][data]
                    val frame = ByteArray(4 + data.size)
                    val len = data.size
                    frame[0] = (len shr 24).toByte()
                    frame[1] = (len shr 16).toByte()
                    frame[2] = (len shr 8).toByte()
                    frame[3] = len.toByte()
                    data.copyInto(frame, 4)
                    synchronized(link.writeLock) {
                        link.output.write(frame)
                        link.output.flush()
                    }
                    promise.resolve(null)
                } catch (e: Exception) {
                    Log.w(TAG, "Write failed on $linkID: ${e.message}")
                    handleLinkClose(linkID)
                    promise.reject("WRITE_FAILED", e.message, e)
                }
            }
        } catch (e: Exception) {
            // RejectedExecutionException: the module is being torn down.
            promise.reject("LINK_CLOSED", "WiFi transport is shutting down", e)
        }
    }

    // ---- Required NativeEventEmitter contract --------------------------------

    @ReactMethod
    fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {
        listenerCount++
    }

    // Double, not Int: React Native marshals every JS number as a double, and an
    // Int overload is not matched by the interop layer - the method is simply
    // never found, which surfaces as an unhandled rejection on teardown rather
    // than anything that points here.
    @ReactMethod
    fun removeListeners(count: Double) {
        listenerCount = maxOf(0, listenerCount - count.toInt())
    }

    // ---- Publish (responder role) --------------------------------------------

    @RequiresApi(AWARE_DATA_PATH_MIN_API)
    private fun startPublish(session: WifiAwareSession): Boolean {
        val config = PublishConfig.Builder()
            .setServiceName(SERVICE_NAME)
            // The tiebreak token, so exactly one side of a pair dials, then the
            // instance id, so a rediscovered peer is not dialled twice.
            .setServiceSpecificInfo(localToken + instanceId)
            .build()

        val generation = sessionGeneration.get()
        try {
            session.publish(config, object : DiscoverySessionCallback() {
                override fun onSessionConfigFailed() {
                    reportDiscoveryRefused("publish")
                }

                override fun onPublishStarted(started: PublishDiscoverySession) {
                    publishSession = started
                    Log.i(TAG, "WiFi Aware publish started on port $serverPort")
                }

                override fun onSessionTerminated() {
                    publishSession = null
                    reportSessionTerminated("publish", generation)
                }

                override fun onMessageReceived(peerHandle: PeerHandle, message: ByteArray) {
                    noteDiscoveryActivity()
                    if (message.isEmpty() || message[0] != MSG_CONNECT_REQUEST) return
                    val active = publishSession ?: return
                    // A request from a device we already hold a link with means
                    // its side of that link is gone. Drop ours so the pair does
                    // not sit on a dead socket until the read deadline.
                    val instance = instanceFrom(message, 1)
                    if (instance != null) {
                        linkedInstances[instance]?.let { stale ->
                            Log.i(TAG, "Peer reconnecting, closing stale link $stale")
                            handleLinkClose(stale)
                        }
                    }
                    // Stand up our half. The subscriber connects to the port we
                    // advertise here; we accept it in the accept loop.
                    openResponderNetwork(active, peerHandle, instance)
                    // Our request is outstanding now, so the subscriber may make
                    // its own. Unconditional: a repeated MSG_CONNECT_REQUEST is a
                    // peer still waiting, openResponderNetwork is idempotent, and
                    // initiatedPeers on the far side absorbs a duplicate reply.
                    runCatching {
                        active.sendMessage(peerHandle, 0, byteArrayOf(MSG_CONNECT_READY))
                    }.onFailure {
                        Log.w(TAG, "Could not send connect-ready: ${it.message}")
                    }
                }
            }, null)
            return true
        } catch (e: SecurityException) {
            Log.e(TAG, "Publish refused, permission missing: ${e.message}")
            return false
        }
    }

    // ---- Subscribe (initiator role) ------------------------------------------

    @RequiresApi(AWARE_DATA_PATH_MIN_API)
    private fun startSubscribe(session: WifiAwareSession): Boolean {
        val config = SubscribeConfig.Builder()
            .setServiceName(SERVICE_NAME)
            .build()

        val generation = sessionGeneration.get()
        try {
            session.subscribe(config, object : DiscoverySessionCallback() {
                override fun onSessionConfigFailed() {
                    reportDiscoveryRefused("subscribe")
                }

                override fun onSubscribeStarted(started: SubscribeDiscoverySession) {
                    subscribeSession = started
                    Log.i(TAG, "WiFi Aware subscribe started")
                }

                override fun onServiceDiscovered(
                    peerHandle: PeerHandle,
                    serviceSpecificInfo: ByteArray?,
                    matchFilter: List<ByteArray>?,
                ) {
                    noteDiscoveryActivity()
                    val active = subscribeSession ?: return
                    // Both devices publish and subscribe, so both discover each
                    // other. Only the lower token dials; the other side sits in
                    // its accept loop and is connected to.
                    if (!shouldDial(serviceSpecificInfo)) return
                    // The same device under a new handle is not a new peer.
                    val instance = serviceSpecificInfo?.let { instanceFrom(it, TOKEN_BYTES) }
                    if (instance != null && linkedInstances.containsKey(instance)) return
                    // A match is re-reported while the peer stays in range, and
                    // every report would otherwise be another socket.
                    if (!dialledPeers.add(peerHandle)) return
                    // Carried to the link once its socket connects.
                    if (instance != null) pendingInstances[peerHandle] = instance

                    Log.i(TAG, "Dialling WiFi Aware peer $peerHandle")
                    try {
                        // Ask the responder to stand up its side, and stop there.
                        // Requesting here would fire before the responder had
                        // even read this, against a peer with nothing
                        // outstanding. Its MSG_CONNECT_READY is the cue.
                        active.sendMessage(peerHandle, 0, byteArrayOf(MSG_CONNECT_REQUEST) + instanceId)
                    } catch (e: SecurityException) {
                        dialledPeers.remove(peerHandle)
                        Log.e(TAG, "sendMessage refused: ${e.message}")
                        return
                    }
                }

                // The responder saying its request is in flight. Sent from the
                // publish session that received ours, so it lands here.
                override fun onMessageReceived(peerHandle: PeerHandle, message: ByteArray) {
                    noteDiscoveryActivity()
                    if (message.isEmpty() || message[0] != MSG_CONNECT_READY) return
                    val active = subscribeSession ?: return
                    if (!initiatedPeers.add(peerHandle)) return
                    Log.i(TAG, "Peer $peerHandle is ready, requesting data path")
                    openInitiatorNetwork(active, peerHandle)
                }

                override fun onSessionTerminated() {
                    subscribeSession = null
                    // Both hold handles from the session that just ended, and a
                    // fresh one issues fresh handles for the same peers.
                    dialledPeers.clear()
                    initiatedPeers.clear()
                    pendingInstances.clear()
                    reportSessionTerminated("subscribe", generation)
                }
            }, null)
            return true
        } catch (e: SecurityException) {
            Log.e(TAG, "Subscribe refused, permission missing: ${e.message}")
            return false
        }
    }

    // Lower token dials. A peer that advertises no token is dialled anyway and
    // the duplicate accepted, rather than leaving the pair unconnected.
    private fun shouldDial(peerToken: ByteArray?): Boolean {
        if (peerToken == null || peerToken.size < TOKEN_BYTES) return true
        val mine = localToken
        if (mine.size != TOKEN_BYTES) return true
        for (i in 0 until TOKEN_BYTES) {
            val a = mine[i].toInt() and 0xff
            val b = peerToken[i].toInt() and 0xff
            if (a != b) return a < b
        }
        // Identical tokens are a 1-in-2^64 coincidence, and dialling on a tie
        // is better than both sides waiting for the other.
        return true
    }

    // ---- Network / socket helpers --------------------------------------------

    // Responder side. Open one server socket for the whole session on a port the
    // OS picks, and remember it: setPort() has to name a port something is
    // already listening on.
    private fun ensureServerSocket(): Boolean {
        if (serverSocket != null) return true
        return try {
            val socket = ServerSocket(0)
            serverSocket = socket
            serverPort = socket.localPort
            ioExecutor.execute { acceptLoop(socket) }
            true
        } catch (e: Exception) {
            Log.e(TAG, "Could not open the WiFi Aware server socket: ${e.message}")
            false
        }
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (!socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (e: Exception) {
                // Closed by teardown, or the interface went away.
                Log.i(TAG, "Accept loop ended: ${e.message}")
                return
            }
            val instance = client.inetAddress?.let { instanceByPeerAddress.remove(addressKey(it)) }
            registerLink("wifi-in-${linkCounter.incrementAndGet()}", client, instance = instance)
        }
    }

    // Responder side: a data path whose specifier names the port we are already
    // listening on. Nothing else to do here - the initiator connects to us.
    @RequiresApi(AWARE_DATA_PATH_MIN_API)
    private fun openResponderNetwork(
        session: PublishDiscoverySession,
        peerHandle: PeerHandle,
        instance: String?,
    ) {
        // One data path per peer, however many connect requests arrive. The
        // rate is set by the other device, and each request would register a
        // NetworkCallback; ConnectivityManager caps an app at roughly a hundred
        // outstanding requests and then throws, ending the transport for the
        // life of the process.
        if (!respondedPeers.add(peerHandle)) return
        val specifier = WifiAwareNetworkSpecifier.Builder(session, peerHandle)
            .setPskPassphrase(DATA_PATH_PASSPHRASE)
            .setPort(serverPort)
            .build()
        // The accept loop only ever sees a socket, so the peer's address on
        // the path is what ties that socket back to the device that dialled.
        requestAwareNetwork(specifier, peerHandle) { _, info, _ ->
            val address = info.peerIpv6Addr?.let { addressKey(it) }
            if (instance != null && address != null) {
                instanceByPeerAddress[address] = instance
            }
        }
    }

    // Initiator side: no port on the specifier (that is the responder's to set),
    // and the peer's address arrives with the capabilities rather than with the
    // network.
    @RequiresApi(AWARE_DATA_PATH_MIN_API)
    private fun openInitiatorNetwork(session: SubscribeDiscoverySession, peerHandle: PeerHandle) {
        val specifier = WifiAwareNetworkSpecifier.Builder(session, peerHandle)
            .setPskPassphrase(DATA_PATH_PASSPHRASE)
            .build()
        requestAwareNetwork(specifier, peerHandle) { network, info, callback ->
            val peerAddress = info.peerIpv6Addr
            val peerPort = info.port
            // A path that came up but cannot carry a socket is released rather
            // than kept: onLost never fires for a path that is still up, so
            // nothing else would free the peer, and the next rediscovery could
            // not dial it again.
            if (peerAddress == null || peerPort <= 0) {
                Log.w(TAG, "Aware network came up with no peer address or port")
                release(callback)
                forgetAttempt(peerHandle)
                return@requestAwareNetwork
            }
            ioExecutor.execute {
                try {
                    // Through the Network's own factory: the default one would
                    // route this over whatever the default network is, which is
                    // never the Aware interface.
                    val socket = network.socketFactory.createSocket(peerAddress, peerPort)
                    registerLink(
                        "wifi-out-${linkCounter.incrementAndGet()}",
                        socket,
                        peerHandle,
                        callback,
                        pendingInstances.remove(peerHandle),
                    )
                } catch (e: Exception) {
                    Log.w(TAG, "Subscriber connect failed: ${e.message}")
                    release(callback)
                    forgetAttempt(peerHandle)
                }
            }
        }
    }

    @RequiresApi(AWARE_DATA_PATH_MIN_API)
    private fun requestAwareNetwork(
        specifier: WifiAwareNetworkSpecifier,
        peer: PeerHandle,
        onPeerReady: ((Network, WifiAwareNetworkInfo, ConnectivityManager.NetworkCallback) -> Unit)?,
    ) {
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI_AWARE)
            .setNetworkSpecifier(specifier)
            .build()

        val callback = object : ConnectivityManager.NetworkCallback() {
            // Fires at most once per network here, but the framework is free to
            // re-deliver capabilities, and connecting twice would be a second
            // socket to the same peer.
            @Volatile
            private var handled = false

            override fun onCapabilitiesChanged(
                network: Network,
                capabilities: NetworkCapabilities,
            ) {
                if (onPeerReady == null || handled) return
                // The peer's address lives here and nowhere else; a callback
                // that only overrides onAvailable never learns it.
                val info = capabilities.transportInfo as? WifiAwareNetworkInfo ?: return
                handled = true
                onPeerReady(network, info, this)
            }

            override fun onLost(network: Network) {
                Log.i(TAG, "WiFi Aware network lost")
                release(this)
                forgetAttempt(peer)
            }

            override fun onUnavailable() {
                Log.w(TAG, "WiFi Aware network request unavailable")
                release(this)
                forgetAttempt(peer)
            }
        }

        try {
            // The timeout overload, so a path that never negotiates ends in
            // onUnavailable() and releases its callback rather than pending
            // forever and walking us toward the request ceiling.
            connectivityManager.requestNetwork(request, callback, NETWORK_REQUEST_TIMEOUT_MS)
            networkCallbacks.add(callback)
        } catch (e: Exception) {
            // TooManyRequestsException, or the transport went away mid-request.
            Log.e(TAG, "requestNetwork failed: ${e.message}")
        }
    }

    private fun release(callback: ConnectivityManager.NetworkCallback) {
        if (!networkCallbacks.remove(callback)) return
        runCatching { connectivityManager.unregisterNetworkCallback(callback) }
    }

    // Let this peer be dialled again, whichever role we took with it.
    //
    // Only from onLost and onUnavailable, which is what makes it safe: a live
    // path raises neither, so a healthy link is never dialled twice, and one
    // that will not negotiate waits out its request timeout before coming
    // round.
    private fun forgetAttempt(peer: PeerHandle) {
        dialledPeers.remove(peer)
        initiatedPeers.remove(peer)
        respondedPeers.remove(peer)
        pendingInstances.remove(peer)
    }

    // Register a connected socket as a named link and start its read loop.
    private fun registerLink(
        id: String,
        socket: Socket,
        peer: PeerHandle? = null,
        network: ConnectivityManager.NetworkCallback? = null,
        instance: String? = null,
    ) {
        noteDiscoveryActivity()
        // The initiator only dials an unlinked instance, so a second link to one
        // means the first is dead on their side; keep the newer.
        if (instance != null) {
            linkedInstances.put(instance, id)?.let { stale ->
                Log.i(TAG, "Replacing stale link $stale for a reconnected peer")
                handleLinkClose(stale)
            }
        }
        try {
            // Frames are small and latency matters more than packing here: the
            // mesh writes one packet per call and waits for nothing.
            socket.tcpNoDelay = true
            // A read deadline is what turns a half-open link into a closed one.
            //
            // Without it a socket whose far side vanished without a FIN sits in
            // `links` and in the JS side's connected set until a write happens to
            // fail. That is not just a stale entry: the courier decides whether
            // it has anyone to hand mail to by counting connected links, so a
            // zombie link makes the composer say "carried by a friend" for an
            // envelope no friend received. bitchat sets the same deadline for
            // the same stated reason (SyncedSocket).
            socket.soTimeout = READ_TIMEOUT_MS
            val output = socket.getOutputStream()
            val link = LinkState(id, socket, output, peer = peer, network = network, instance = instance)
            links[id] = link
            emitEvent(EVT_LINK_CONNECTED, WritableNativeMap().apply { putString("linkID", id) })
            Log.i(TAG, "WiFi Aware link connected: $id")
            startReadLoop(id, socket.getInputStream())
        } catch (e: Exception) {
            Log.e(TAG, "Could not register link $id: ${e.message}")
            if (instance != null) linkedInstances.remove(instance, id)
            runCatching { socket.close() }
        }
    }

    // The instance id at `offset` in a discovery payload, as hex, or null when
    // the payload is too short to carry one.
    private fun instanceFrom(bytes: ByteArray, offset: Int): String? {
        if (bytes.size < offset + INSTANCE_BYTES) return null
        return bytes.copyOfRange(offset, offset + INSTANCE_BYTES).joinToString("") { "%02x".format(it) }
    }

    // A link-local address without its scope suffix, since the two sides of a
    // path report the same address with different interface names.
    private fun addressKey(address: java.net.InetAddress): String =
        address.hostAddress?.substringBefore('%') ?: address.toString()

    // Read length-prefixed frames from the socket and emit them as events.
    private fun startReadLoop(linkID: String, input: InputStream) {
        ioExecutor.execute {
            val lenBuf = ByteArray(4)
            var idleTimeouts = 0
            while (true) {
                try {
                    // Read 4-byte BE length prefix.
                    var read = 0
                    while (read < 4) {
                        val n = input.read(lenBuf, read, 4 - read)
                        if (n < 0) throw java.io.EOFException("EOF in length prefix")
                        read += n
                    }
                    val len = ((lenBuf[0].toInt() and 0xff) shl 24) or
                              ((lenBuf[1].toInt() and 0xff) shl 16) or
                              ((lenBuf[2].toInt() and 0xff) shl 8) or
                              (lenBuf[3].toInt() and 0xff)

                    if (len <= 0 || len > MAX_FRAME) {
                        throw Exception("WiFi link $linkID: invalid frame length $len")
                    }

                    val data = ByteArray(len)
                    var received = 0
                    while (received < len) {
                        val n = input.read(data, received, len - received)
                        if (n < 0) throw java.io.EOFException("EOF in frame body")
                        received += n
                    }

                    // Something arrived, so the link is demonstrably alive.
                    idleTimeouts = 0
                    val dataBase64 = Base64.encodeToString(data, Base64.NO_WRAP)
                    emitEvent(EVT_PACKET_RECEIVED, WritableNativeMap().apply {
                        putString("linkID", linkID)
                        putString("dataBase64", dataBase64)
                    })
                } catch (e: java.net.SocketTimeoutException) {
                    // A quiet link is not a dead one.
                    //
                    // There is no keepalive here, so silence is normal: liveness
                    // comes from ANNOUNCE, and JS timers are throttled under
                    // Doze, so a backgrounded pair can easily miss one deadline.
                    // Several consecutive timeouts with nothing arriving is the
                    // half-open case the deadline is for.
                    idleTimeouts += 1
                    if (idleTimeouts < MAX_IDLE_TIMEOUTS) continue
                    Log.i(TAG, "WiFi link $linkID idle past deadline, closing")
                    handleLinkClose(linkID)
                    return@execute
                } catch (e: Exception) {
                    Log.i(TAG, "Read loop ended for $linkID: ${e.message}")
                    handleLinkClose(linkID)
                    return@execute
                }
            }
        }
    }

    private fun handleLinkClose(linkID: String) {
        val link = links.remove(linkID) ?: return
        link.instance?.let { linkedInstances.remove(it, linkID) }
        runCatching { link.socket.close() }
        // A dead socket on a live path would otherwise leave the peer marked
        // for good, since onLost only fires when the path itself goes. Releasing
        // the request ends the path for both ends, so the responder sees onLost
        // and frees its own mark too.
        link.network?.let { release(it) }
        link.peer?.let { forgetAttempt(it) }
        emitEvent(EVT_LINK_DISCONNECTED, WritableNativeMap().apply { putString("linkID", linkID) })
    }

    // Same guard, and for the same reason, as AirhopBLEModule.emitEvent: every
    // caller is on a pooled IO thread or a framework callback with no handler
    // above it, and under bridgeless React Native getJSModule throws whenever no
    // runtime is attached. Both a check and a catch, because
    // hasActiveReactInstance() can stop being true between the two.
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
        // The data path is encrypted by the framework under this passphrase, and
        // it is in published source, so it authenticates nothing. It does not
        // need to: everything crossing this socket is already a signed Airhop
        // packet, and DMs inside it are sealed in a Noise session. The
        // passphrase is here because WifiAwareNetworkSpecifier requires the two
        // sides to agree on one, not because it is a secret.
        private const val DATA_PATH_PASSPHRASE = "airhop-aware-psk"
    }
}
