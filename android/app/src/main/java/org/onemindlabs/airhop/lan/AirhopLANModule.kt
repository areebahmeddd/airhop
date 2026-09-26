package org.onemindlabs.airhop.lan

// The LAN transport: mDNS discovery over ordinary TCP.
//
// The only transport that reaches an iPhone from an Android phone over
// something other than Bluetooth. WiFi Aware cannot, because Apple demands a
// paired data path Android has no way to complete. This is plain IP, so it does
// not care which phone anyone owns.
//
// Framing, the accept loop, the read loop and the link registry are the same
// shapes AirhopWiFiModule uses, deliberately: both carry the same length-
// prefixed Airhop packets, so a bug fixed in one is recognisable in the other.
// What differs is above the socket. Aware connects to whatever it finds; this
// connects only where it is told to, because mDNS returns everyone and
// connecting to everyone is a full mesh. That decision lives in TypeScript
// (services/lan-dial-policy.ts).
//
// The instance name comes from TypeScript and is never the peer ID (see
// services/lan-controller.ts for why it rotates). A transfer to a new phone
// needs no name at all: it rides a second socket (services/move-link.ts) with
// the same framing, heartbeat and read loop, its own listener and events, and
// no mDNS. Each link knows which socket it belongs to, so stopLAN never cuts a
// transfer and neither can write to the other's connections.

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.onemindlabs.airhop.transport.FrameReader
import org.onemindlabs.airhop.transport.Framing
import org.onemindlabs.airhop.transport.LocalInterface

private const val TAG = "AirhopLANModule"

// The service type every Airhop device publishes and browses for. Matches the
// `NSBonjourServices` entry in the iOS Info.plist byte for byte; a mismatch is
// two apps that cannot see each other.
//
// Not Wi-Fi Aware's `_airhop-mesh-v1._tcp`. Two services, named apart so neither
// reads as a typo of the other: Aware is a radio protocol needing no network,
// this is mDNS over an ordinary one.
private const val SERVICE_TYPE = "_airhop-lan-v1._tcp"

// Interface names that can carry local peers: WiFi joined or served, ethernet,
// USB tethering (rndis, usb, and ncm from Android 11). Cellular (rmnet, ccmni)
// is absent because nobody else is on it. Android identifies its own access
// point the same way, by name (config_tether_wifi_regexs).
private val LOCAL_IFACE_PREFIXES =
    arrayOf("wlan", "softap", "ap", "swlan", "eth", "rndis", "usb", "ncm")

private const val EVT_PEER_DISCOVERED = "AirhopLAN.peerDiscovered"
private const val EVT_PEER_LOST = "AirhopLAN.peerLost"
private const val EVT_LINK_CONNECTED = "AirhopLAN.linkConnected"
private const val EVT_LINK_DISCONNECTED = "AirhopLAN.linkDisconnected"
private const val EVT_PACKET_RECEIVED = "AirhopLAN.packetReceived"
private const val EVT_AVAILABILITY_CHANGED = "AirhopLAN.availabilityChanged"
private const val EVT_MOVE_CONNECTED = "AirhopLAN.moveConnected"
private const val EVT_MOVE_DATA = "AirhopLAN.moveData"
private const val EVT_MOVE_CLOSED = "AirhopLAN.moveClosed"

// Liveness, the same numbers as the WiFi module: a zero-length heartbeat every
// 8 s against FrameReader's read deadline, so a peer that walked off the network
// without a FIN is closed in about thirty seconds. LAN outranks Bluetooth for a
// peer held on both, so a dead one would take every DM until noticed.
private const val HEARTBEAT_MS = 8_000L

// A write blocked this long means the peer stopped reading. The same thirty
// seconds the read side allows a frame.
private const val WRITE_STALL_MS = FrameReader.FRAME_DEADLINE_MS

// Inbound caps, counted on open links. Over a cap the socket is closed at once
// rather than queued: every accepted socket is a thread.
//
// Mesh: twice MAX_LAN_LINKS in lan-dial-policy.ts. The ring sends a node at
// most eight dials, and the headroom lets a replacement land while its dead
// predecessor waits out the read deadline.
private const val MAX_INBOUND_LAN = 16
// Transfer: MAX_MOVE_HOSTS, the most addresses one code names. A transfer
// needs one.
private const val MAX_INBOUND_MOVE = 4

// mDNS names held or queued for a resolve. Eight times the ring's link count,
// so a room bigger than this still gets full ring coverage from the first 64.
private const val MAX_DISCOVERED = 64

// A failed accept that is not a close (EMFILE, most often) usually persists,
// so the loop waits before asking again rather than spinning.
private const val ACCEPT_RETRY_MS = 1_000L

// How long to wait for a dial before giving up. Client isolation, which most
// guest networks enable, shows up here as a connect that never completes rather
// than as a refusal, so an unbounded connect would hold a thread forever.
private const val CONNECT_TIMEOUT_MS = 5_000

// Whether an interface can carry local peers, by the LOCAL_IFACE_PREFIXES rule.
// An accepted socket on anything else is refused: loopback is another app on
// this phone, cellular is a stranger on the carrier's network.
internal fun isLocalInterface(name: String?): Boolean =
    name != null && LOCAL_IFACE_PREFIXES.any { name.startsWith(it) }

class AirhopLANModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "AirhopLAN"

    // Resolved per call, never cached: a service not yet ready when the module
    // is constructed would otherwise latch null for the life of the process.
    // Same reasoning as AirhopWiFiModule.awareManager().
    private fun nsdManager(): NsdManager? =
        try {
            reactContext.applicationContext.getSystemService(NsdManager::class.java)
        } catch (_: Exception) {
            null
        }

    private fun wifiManager(): WifiManager? =
        try {
            reactContext.applicationContext.getSystemService(WifiManager::class.java)
        } catch (_: Exception) {
            null
        }

    private fun connectivityManager(): ConnectivityManager? =
        try {
            reactContext.applicationContext.getSystemService(ConnectivityManager::class.java)
        } catch (_: Exception) {
            null
        }

    private val ioExecutor = Executors.newCachedThreadPool()
    private val heartbeatExecutor = Executors.newSingleThreadScheduledExecutor()
    private val linkCounter = AtomicInteger(0)

    private class LinkState(
        val id: String,
        val socket: Socket,
        val output: OutputStream,
        // A transfer connection rather than a mesh link.
        val move: Boolean,
        // Accepted rather than dialled, for the inbound caps.
        val inbound: Boolean,
        val writeLock: Any = Any(),
    ) {
        @Volatile var heartbeat: ScheduledFuture<*>? = null
        // When the write in progress began, 0 while none is.
        @Volatile var writingSinceMs = 0L
    }

    private val links = ConcurrentHashMap<String, LinkState>()

    // Peers mDNS has resolved, keyed by the name they publish. Held because a
    // dial arrives from TypeScript naming a peer, not an address.
    private class Resolved(val host: InetAddress, val port: Int)

    private val discovered = ConcurrentHashMap<String, Resolved>()

    // Which peer each open link belongs to, and the reverse.
    //
    // Held so a repeat dial for a peer already linked can resolve without
    // opening a second socket. TypeScript walks its dial plan on a timer, since
    // a link can drop while the peer's mDNS record stays visible, and it does
    // not track which names are linked: that is this module's knowledge.
    private val linkByName = ConcurrentHashMap<String, String>()
    private val nameByLink = ConcurrentHashMap<String, String>()

    private var serverSocket: ServerSocket? = null
    private var serverPort: Int = 0
    private var instanceName: String? = null

    private var moveServer: ServerSocket? = null

    private var registrationListener: NsdManager.RegistrationListener? = null
    private var discoveryListener: NsdManager.DiscoveryListener? = null
    private var networkReceiver: BroadcastReceiver? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    // Multicast is dropped by WiFi power save unless something holds this lock,
    // which is why the app can find peers while the screen is on and silently
    // stops the moment it is off. Held for as long as the transport runs.
    private var multicastLock: WifiManager.MulticastLock? = null

    // Which set of listeners is current. Bumped by teardown, so one we stopped
    // ourselves is told apart from one dropped under us: both arrive as the same
    // callback, and only the second is a reason to restart.
    private val sessionGeneration = AtomicInteger(0)

    // Resolves run one at a time below API 34.
    //
    // NsdManager.resolveService is documented as one outstanding resolve per
    // manager, and issuing a second while the first is in flight fails both with
    // FAILURE_ALREADY_ACTIVE. mDNS answers arrive as a burst, one per device, so
    // this is the ordinary case rather than a race. API 34 added
    // registerServiceInfoCallback, which has no such limit, but the floor here
    // is lower than that.
    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    // The name in flight, so a repeat sighting of it is not queued behind itself.
    private var resolvingName: String? = null
    private val resolveLock = Any()

    // ---- Lifecycle -----------------------------------------------------------

    @ReactMethod
    fun startLAN(instanceName: String, promise: Promise) {
        val nsd = nsdManager()
        if (nsd == null) {
            promise.reject("LAN_UNSUPPORTED", "This device has no mDNS service")
            return
        }
        if (this.instanceName != null) {
            // Already running under some name. Idempotent, as the reconciler
            // expects: it calls start whenever it is unsure.
            promise.resolve(null)
            return
        }
        if (!hasLocalNetwork()) {
            promise.reject("LAN_UNAVAILABLE", "No local network to publish on")
            return
        }
        if (!ensureServerSocket()) {
            promise.reject("LAN_LISTEN_FAILED", "Could not open the LAN server socket")
            return
        }

        this.instanceName = instanceName
        acquireMulticastLock()
        registerNetworkWatchers()

        try {
            registerService(nsd, instanceName)
            startDiscovery(nsd)
        } catch (e: SecurityException) {
            // Android 16 opts in and Android 17 enforces ACCESS_LOCAL_NETWORK.
            // A refusal here is the user's answer, not a fault, and it clears
            // if they grant it later.
            teardown()
            promise.reject("PERMISSION_DENIED", "Local network access refused", e)
            return
        } catch (e: Exception) {
            teardown()
            promise.reject("LAN_LISTEN_FAILED", e.message, e)
            return
        }
        promise.resolve(null)
    }

    @ReactMethod
    fun stopLAN(promise: Promise) {
        teardown()
        promise.resolve(null)
    }

    // Synchronized because reporting a dead publish or browse calls this from an
    // NsdManager callback, which can meet stopLAN arriving on the bridge thread.
    // Reentrant, so the call in startLAN's own failure path is unaffected.
    @Synchronized
    private fun teardown() {
        sessionGeneration.incrementAndGet()
        val nsd = nsdManager()
        registrationListener?.let { runCatching { nsd?.unregisterService(it) } }
        registrationListener = null
        discoveryListener?.let { runCatching { nsd?.stopServiceDiscovery(it) } }
        discoveryListener = null

        networkReceiver?.let { runCatching { reactContext.unregisterReceiver(it) } }
        networkReceiver = null
        networkCallback?.let {
            runCatching { connectivityManager()?.unregisterNetworkCallback(it) }
        }
        networkCallback = null

        multicastLock?.let { runCatching { if (it.isHeld) it.release() } }
        multicastLock = null

        runCatching { serverSocket?.close() }
        serverSocket = null
        serverPort = 0
        instanceName = null

        // Mesh links only: a transfer runs with the mesh stopped.
        for ((id, link) in links.entries.toList()) {
            if (!link.move) handleLinkClose(id)
        }
        discovered.clear()
        linkByName.clear()
        nameByLink.clear()
        synchronized(resolveLock) {
            resolveQueue.clear()
            resolving = false
            resolvingName = null
        }
    }

    // Whether there is anywhere for mDNS to run. Not ConnectivityManager's
    // active network: a phone sharing its connection serves a network rather
    // than joining one, so it has no Network object and, with mobile data off,
    // no active network at all. A link-local 169.254 address does not count.
    //
    // Not gated on whether Android serves mDNS on a tethering interface (13 and
    // up does). That ships through Play system updates, so the OS version does
    // not answer it, and a host nobody answers reads the same as an empty
    // network, which this transport already reports honestly.
    private fun hasLocalNetwork(): Boolean =
        try {
            NetworkInterface.getNetworkInterfaces().asSequence().any { iface ->
                iface.isUp &&
                    !iface.isLoopback &&
                    LOCAL_IFACE_PREFIXES.any { iface.name.startsWith(it) } &&
                    iface.inetAddresses.asSequence().any {
                        it is Inet4Address && !it.isLinkLocalAddress
                    }
            }
        } catch (_: Exception) {
            // Saying no costs one backoff step and the reconciler asks again.
            // Saying yes opens a listener with nowhere to listen.
            false
        }

    // mDNS stopped working under us: the publish was refused, or the system
    // dropped the browse. Torn down here rather than waiting for the
    // controller's stopLAN, which is a bridge hop away: a start landing in that
    // window would find `instanceName` still set and resolve as already running
    // over a dead transport.
    //
    // Ignored once the generation has moved, since teardown stops these
    // listeners itself and gets the same callbacks for it.
    private fun reportUnavailable(reason: String, generation: Int) {
        if (generation != sessionGeneration.get()) return
        Log.w(TAG, "LAN $reason")
        teardown()
        emitEvent(
            EVT_AVAILABILITY_CHANGED,
            WritableNativeMap().apply { putBoolean("available", false) },
        )
    }

    private fun acquireMulticastLock() {
        if (multicastLock != null) return
        multicastLock =
            try {
                wifiManager()?.createMulticastLock("airhop-lan")?.apply {
                    setReferenceCounted(false)
                    acquire()
                }
            } catch (e: Exception) {
                // Not fatal. Discovery still works with the screen on, which is
                // when most of it happens, so a missing lock is a degradation
                // rather than a reason to refuse the transport.
                Log.w(TAG, "No multicast lock: ${e.message}")
                null
            }
    }

    // The interface going away is the case that is otherwise unrecoverable: the
    // listener and the browser are dead while this module still believes it is
    // running, so every later start resolves instantly having done nothing.
    //
    // Two watchers: NetworkCallback for a WiFi or ethernet network joining or
    // leaving, TETHER_STATE_CHANGED for a hotspot. A served network gets no
    // Network object, so the callback alone would miss that case.
    private fun registerNetworkWatchers() {
        if (networkCallback == null) {
            val request =
                NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
                    .build()
            val callback =
                object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) = reportAvailability()

                    override fun onLost(network: Network) = reportAvailability()
                }
            try {
                connectivityManager()?.registerNetworkCallback(request, callback)
                networkCallback = callback
            } catch (e: Exception) {
                Log.w(TAG, "Could not watch WiFi/ethernet state: ${e.message}")
            }
        }

        if (networkReceiver == null) {
            val receiver =
                object : BroadcastReceiver() {
                    override fun onReceive(context: Context?, intent: Intent?) =
                        reportAvailability()
                }
            // Named rather than referenced: the constant is on TetheringManager
            // (API 30) and ConnectivityManager's copy is hidden.
            val filter = IntentFilter("android.net.conn.TETHER_STATE_CHANGED")
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    reactContext.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
                } else {
                    @Suppress("UnspecifiedRegisterReceiverFlag")
                    reactContext.registerReceiver(receiver, filter)
                }
                networkReceiver = receiver
            } catch (e: Exception) {
                Log.w(TAG, "Could not watch tethering state: ${e.message}")
            }
        }
    }

    private fun reportAvailability() {
        emitEvent(
            EVT_AVAILABILITY_CHANGED,
            WritableNativeMap().apply { putBoolean("available", hasLocalNetwork()) },
        )
    }

    // ---- Discovery -----------------------------------------------------------

    private fun registerService(nsd: NsdManager, name: String) {
        val generation = sessionGeneration.get()
        val info =
            NsdServiceInfo().apply {
                serviceName = name
                serviceType = SERVICE_TYPE
                port = serverPort
            }
        val listener =
            object : NsdManager.RegistrationListener {
                override fun onServiceRegistered(info: NsdServiceInfo) {
                    Log.i(TAG, "Published as ${info.serviceName}")
                }

                override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
                    reportUnavailable("publish refused: $errorCode", generation)
                }

                override fun onServiceUnregistered(info: NsdServiceInfo) = Unit

                override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) = Unit
            }
        registrationListener = listener
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
    }

    private fun startDiscovery(nsd: NsdManager) {
        val generation = sessionGeneration.get()
        val listener =
            object : NsdManager.DiscoveryListener {
                override fun onDiscoveryStarted(serviceType: String) = Unit

                override fun onServiceFound(info: NsdServiceInfo) {
                    // Our own record comes back off the network like anyone else's.
                    if (info.serviceName == instanceName) return
                    enqueueResolve(info)
                }

                override fun onServiceLost(info: NsdServiceInfo) {
                    discovered.remove(info.serviceName)
                    emitEvent(
                        EVT_PEER_LOST,
                        WritableNativeMap().apply { putString("serviceName", info.serviceName) },
                    )
                }

                override fun onDiscoveryStopped(serviceType: String) {
                    reportUnavailable("browse stopped", generation)
                }

                override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                    reportUnavailable("browse refused: $errorCode", generation)
                }

                override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            }
        discoveryListener = listener
        nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
    }

    // A name already resolved, queued or in flight is skipped: mDNS repeats
    // itself, and every repeat would otherwise cost a resolve.
    private fun enqueueResolve(info: NsdServiceInfo) {
        val name = info.serviceName
        if (discovered.containsKey(name) || discovered.size >= MAX_DISCOVERED) return
        synchronized(resolveLock) {
            if (name == resolvingName || resolveQueue.any { it.serviceName == name }) return
            if (resolveQueue.size >= MAX_DISCOVERED) return
            resolveQueue.addLast(info)
            if (resolving) return
            resolving = true
        }
        drainResolves()
    }

    private fun drainResolves() {
        val next =
            synchronized(resolveLock) {
                val head = resolveQueue.removeFirstOrNull()
                if (head == null) resolving = false
                resolvingName = head?.serviceName
                head
            } ?: return

        val nsd = nsdManager()
        if (nsd == null) {
            synchronized(resolveLock) {
                resolving = false
                resolvingName = null
            }
            return
        }

        @Suppress("DEPRECATION")
        nsd.resolveService(
            next,
            object : NsdManager.ResolveListener {
                override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                    Log.w(TAG, "Resolve failed for ${info.serviceName}: $errorCode")
                    drainResolves()
                }

                override fun onServiceResolved(info: NsdServiceInfo) {
                    val host = info.host
                    val room =
                        discovered.containsKey(info.serviceName) || discovered.size < MAX_DISCOVERED
                    if (host != null && info.serviceName != instanceName && room) {
                        discovered[info.serviceName] = Resolved(host, info.port)
                        // The name only. The address stays here, in
                        // `discovered`, because it is this module's business to
                        // dial and nobody above needs it.
                        emitEvent(
                            EVT_PEER_DISCOVERED,
                            WritableNativeMap().apply {
                                putString("serviceName", info.serviceName)
                            },
                        )
                    }
                    drainResolves()
                }
            },
        )
    }

    // ---- Links ---------------------------------------------------------------

    @ReactMethod
    fun connectToPeer(serviceName: String, promise: Promise) {
        val peer = discovered[serviceName]
        if (peer == null) {
            promise.reject("UNKNOWN_PEER", "No resolved peer named $serviceName")
            return
        }
        // Idempotent. The caller re-walks its plan on a timer to heal a dropped
        // link, and asking for one that is already up must cost a resolve, not
        // a second socket.
        val existing = linkByName[serviceName]
        if (existing != null && links.containsKey(existing)) {
            promise.resolve(null)
            return
        }
        try {
            ioExecutor.execute {
                try {
                    val socket = Socket()
                    socket.connect(
                        java.net.InetSocketAddress(peer.host, peer.port),
                        CONNECT_TIMEOUT_MS,
                    )
                    registerLink(
                        "lan-out-${linkCounter.incrementAndGet()}",
                        socket,
                        serviceName,
                    )
                    promise.resolve(null)
                } catch (e: Exception) {
                    // Most often client isolation, which every guest network
                    // enables and which cannot be detected before trying.
                    Log.w(TAG, "Dial to $serviceName failed: ${e.message}")
                    promise.reject("CONNECT_FAILED", e.message, e)
                }
            }
        } catch (e: Exception) {
            promise.reject("CONNECT_FAILED", "LAN transport is shutting down", e)
        }
    }

    private fun ensureServerSocket(): Boolean {
        if (serverSocket != null) return true
        return try {
            val socket = ServerSocket(0)
            serverSocket = socket
            serverPort = socket.localPort
            ioExecutor.execute { acceptLoop(socket) }
            true
        } catch (e: Exception) {
            Log.e(TAG, "Could not open the LAN server socket: ${e.message}")
            false
        }
    }

    private fun acceptLoop(socket: ServerSocket) {
        acceptEach(socket, "Accept") { client ->
            if (admitInbound(client, move = false, cap = MAX_INBOUND_LAN)) {
                registerLink("lan-in-${linkCounter.incrementAndGet()}", client, inbound = true)
            }
        }
    }

    // Runs until the server socket is closed. Any other failure, an Error
    // included, is logged and retried after a pause: returning would leave a
    // bound port nobody reads while the module still reports itself running.
    private fun acceptEach(socket: ServerSocket, label: String, handle: (Socket) -> Unit) {
        while (!socket.isClosed) {
            try {
                handle(socket.accept())
            } catch (e: Throwable) {
                if (socket.isClosed) break
                Log.w(TAG, "$label failed, retrying: ${e.message}")
                try {
                    Thread.sleep(ACCEPT_RETRY_MS)
                } catch (_: InterruptedException) {
                    break
                }
            }
        }
        Log.i(TAG, "$label loop ended")
    }

    // Whether an accepted socket may become a link: it arrived on a local
    // interface and its kind is under its cap. Closes it otherwise.
    //
    // An interface the platform will not name is let through with a log line.
    // Refusing it is the one path here that could break LAN on a device that
    // names interfaces differently, and every peer still has to announce.
    private fun admitInbound(client: Socket, move: Boolean, cap: Int): Boolean {
        val iface = LocalInterface.nameOf(client)
        if (iface == null) Log.i(TAG, "Inbound interface unknown, accepting")
        val refusal =
            when {
                iface != null && !isLocalInterface(iface) -> "on $iface"
                links.values.count { it.inbound && it.move == move } >= cap ->
                    "past the cap of $cap"
                else -> null
            }
        if (refusal == null) return true
        Log.w(TAG, "Refused inbound ${if (move) "transfer" else "link"} $refusal")
        runCatching { client.close() }
        return false
    }

    // `serviceName` is known only for a dial we made. An accepted connection is
    // anonymous until its peer announces, and nothing here needs to know: the
    // name is used solely to answer "already connected" for an outbound dial.
    //
    // Catches Throwable: on the accept thread an Error (a thread that could not
    // be created) would otherwise end the process.
    private fun registerLink(
        id: String,
        socket: Socket,
        serviceName: String? = null,
        move: Boolean = false,
        inbound: Boolean = false,
    ): Boolean {
        var reported = false
        try {
            socket.tcpNoDelay = true
            socket.keepAlive = true
            socket.soTimeout = FrameReader.READ_TIMEOUT_MS
            val link = LinkState(id, socket, socket.getOutputStream(), move, inbound)
            links[id] = link
            if (serviceName != null) {
                linkByName[serviceName] = id
                nameByLink[id] = serviceName
            }
            link.heartbeat =
                heartbeatExecutor.scheduleWithFixedDelay(
                    { heartbeat(link) },
                    HEARTBEAT_MS,
                    HEARTBEAT_MS,
                    TimeUnit.MILLISECONDS,
                )
            if (move) {
                emitEvent(
                    EVT_MOVE_CONNECTED,
                    WritableNativeMap().apply { putString("connectionID", id) },
                )
            } else {
                emitEvent(EVT_LINK_CONNECTED, WritableNativeMap().apply { putString("linkID", id) })
            }
            reported = true
            Log.i(TAG, "LAN link connected: $id")
            startReadLoop(id, socket.getInputStream(), move)
            return true
        } catch (e: Throwable) {
            Log.e(TAG, "Could not register link $id: ${e.message}")
            // Once JS has heard of the link it has to hear it go.
            if (reported) {
                handleLinkClose(id)
            } else {
                links.remove(id)?.heartbeat?.cancel(false)
                runCatching { socket.close() }
            }
            return false
        }
    }

    // Heartbeat thread. Skipped while a write is in progress, so a peer that
    // stops reading parks one writer rather than one more every beat. Once that
    // write has been blocked for WRITE_STALL_MS the link is closed, which makes
    // it throw and fails every write queued behind it.
    private fun heartbeat(link: LinkState) {
        val since = link.writingSinceMs
        if (since != 0L) {
            if (SystemClock.elapsedRealtime() - since > WRITE_STALL_MS) {
                Log.i(TAG, "Link ${link.id} stopped reading, closing")
                handleLinkClose(link.id)
            }
            return
        }
        ioExecutor.execute {
            try {
                writeFrame(link, ByteArray(0))
            } catch (e: Exception) {
                handleLinkClose(link.id)
            }
        }
    }

    // Blocking; IO thread.
    private fun writeFrame(link: LinkState, data: ByteArray) {
        val frame = Framing.encode(data)
        synchronized(link.writeLock) {
            link.writingSinceMs = SystemClock.elapsedRealtime()
            try {
                link.output.write(frame)
                link.output.flush()
            } finally {
                link.writingSinceMs = 0L
            }
        }
    }

    @ReactMethod
    fun writeToLANLink(linkID: String, dataBase64: String, promise: Promise) {
        val link = links[linkID]
        if (link == null || link.move) {
            promise.reject("UNKNOWN_LINK", "No active LAN link: $linkID")
            return
        }
        write(link, dataBase64, promise)
    }

    private fun write(link: LinkState, dataBase64: String, promise: Promise) {
        val linkID = link.id
        val data =
            try {
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
        try {
            ioExecutor.execute {
                try {
                    writeFrame(link, data)
                    promise.resolve(null)
                } catch (e: Exception) {
                    Log.w(TAG, "Write failed on $linkID: ${e.message}")
                    handleLinkClose(linkID)
                    promise.reject("WRITE_FAILED", e.message, e)
                }
            }
        } catch (e: Exception) {
            promise.reject("LINK_CLOSED", "LAN transport is shutting down", e)
        }
    }

    private fun startReadLoop(linkID: String, input: InputStream, move: Boolean) {
        val dataEvent = if (move) EVT_MOVE_DATA else EVT_PACKET_RECEIVED
        val idKey = if (move) "connectionID" else "linkID"
        ioExecutor.execute {
            val reader = FrameReader(input, SystemClock::elapsedRealtime)
            while (true) {
                val payload =
                    try {
                        reader.next()
                    } catch (e: Exception) {
                        Log.i(TAG, "Read loop ended for $linkID: ${e.message}")
                        handleLinkClose(linkID)
                        return@execute
                    }
                // A heartbeat carries nothing.
                if (payload.isEmpty()) continue
                emitEvent(
                    dataEvent,
                    WritableNativeMap().apply {
                        putString(idKey, linkID)
                        putString("dataBase64", Base64.encodeToString(payload, Base64.NO_WRAP))
                    },
                )
            }
        }
    }

    private fun handleLinkClose(linkID: String) {
        val link = links.remove(linkID) ?: return
        link.heartbeat?.cancel(false)
        val name = nameByLink.remove(linkID)
        // Only if it still points here: a newer link may have claimed the name,
        // and clearing it would make the live one look absent.
        if (name != null && linkByName[name] == linkID) linkByName.remove(name)
        runCatching { link.socket.close() }
        if (link.move) {
            emitEvent(
                EVT_MOVE_CLOSED,
                WritableNativeMap().apply { putString("connectionID", linkID) },
            )
        } else {
            emitEvent(
                EVT_LINK_DISCONNECTED,
                WritableNativeMap().apply { putString("linkID", linkID) },
            )
        }
    }

    // ---- Transfer ------------------------------------------------------------

    // IPv4 address and prefix length on the interfaces hasLocalNetwork counts:
    // a served hotspot included, cellular not. The prefix is reported, not
    // judged: whether to dial an address is a routing decision, made in
    // TypeScript.
    private fun readLocalSubnets(): List<Pair<String, Int>> =
        try {
            NetworkInterface.getNetworkInterfaces()
                .asSequence()
                .filter { iface ->
                    iface.isUp &&
                        !iface.isLoopback &&
                        LOCAL_IFACE_PREFIXES.any { iface.name.startsWith(it) }
                }
                .flatMap { it.interfaceAddresses.asSequence() }
                .mapNotNull { entry ->
                    val address = entry.address as? Inet4Address ?: return@mapNotNull null
                    if (address.isLinkLocalAddress || address.isLoopbackAddress) {
                        return@mapNotNull null
                    }
                    address.hostAddress?.let { it to entry.networkPrefixLength.toInt() }
                }
                .distinct()
                .toList()
        } catch (_: Exception) {
            emptyList()
        }

    @ReactMethod
    fun localSubnets(promise: Promise) {
        val subnets = Arguments.createArray()
        for ((address, prefixLength) in readLocalSubnets()) {
            subnets.pushMap(
                WritableNativeMap().apply {
                    putString("address", address)
                    putInt("prefixLength", prefixLength)
                }
            )
        }
        promise.resolve(subnets)
    }

    @ReactMethod
    fun startMoveListener(promise: Promise) {
        val port =
            synchronized(this) {
                moveServer?.localPort
                    ?: try {
                        val socket = ServerSocket(0)
                        moveServer = socket
                        ioExecutor.execute { moveAcceptLoop(socket) }
                        socket.localPort
                    } catch (e: Exception) {
                        Log.e(TAG, "Could not open the move socket: ${e.message}")
                        null
                    }
            }
        if (port == null) {
            promise.reject("MOVE_LISTEN_FAILED", "Could not open the move socket")
            return
        }
        val hosts = Arguments.createArray()
        for (host in readLocalSubnets().map { it.first }.distinct()) hosts.pushString(host)
        promise.resolve(
            WritableNativeMap().apply {
                putInt("port", port)
                putArray("hosts", hosts)
            }
        )
    }

    private fun moveAcceptLoop(socket: ServerSocket) {
        acceptEach(socket, "Move accept") { client ->
            if (admitInbound(client, move = true, cap = MAX_INBOUND_MOVE)) {
                registerLink(
                    "move-in-${linkCounter.incrementAndGet()}",
                    client,
                    move = true,
                    inbound = true,
                )
            }
        }
    }

    @ReactMethod
    fun stopMove(promise: Promise) {
        closeMoveSide()
        promise.resolve(null)
    }

    @Synchronized
    private fun closeMoveSide() {
        runCatching { moveServer?.close() }
        moveServer = null
        for ((id, link) in links.entries.toList()) {
            if (link.move) handleLinkClose(id)
        }
    }

    @ReactMethod
    fun dialMove(host: String, port: Double, promise: Promise) {
        try {
            ioExecutor.execute {
                val socket = Socket()
                try {
                    socket.connect(
                        java.net.InetSocketAddress(host, port.toInt()),
                        CONNECT_TIMEOUT_MS,
                    )
                } catch (e: Exception) {
                    runCatching { socket.close() }
                    promise.reject("CONNECT_FAILED", e.message, e)
                    return@execute
                }
                val id = "move-out-${linkCounter.incrementAndGet()}"
                if (registerLink(id, socket, move = true)) {
                    promise.resolve(id)
                } else {
                    promise.reject("CONNECT_FAILED", "Could not open the move connection")
                }
            }
        } catch (e: Exception) {
            promise.reject("CONNECT_FAILED", "LAN transport is shutting down", e)
        }
    }

    @ReactMethod
    fun writeMove(connectionID: String, dataBase64: String, promise: Promise) {
        val link = links[connectionID]
        if (link == null || !link.move) {
            promise.reject("UNKNOWN_LINK", "No move connection: $connectionID")
            return
        }
        write(link, dataBase64, promise)
    }

    @ReactMethod
    fun closeMove(connectionID: String, promise: Promise) {
        if (links[connectionID]?.move == true) handleLinkClose(connectionID)
        promise.resolve(null)
    }

    // ---- Required NativeEventEmitter contract --------------------------------

    @ReactMethod
    fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {
        // Subscriptions are tracked on the JS side.
    }

    @ReactMethod
    fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) {
        // Subscriptions are tracked on the JS side.
    }

    override fun invalidate() {
        teardown()
        closeMoveSide()
        heartbeatExecutor.shutdownNow()
        ioExecutor.shutdownNow()
        super.invalidate()
    }

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
}
