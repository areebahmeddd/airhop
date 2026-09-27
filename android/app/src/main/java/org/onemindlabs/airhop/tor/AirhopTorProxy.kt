// Points the app's outbound web traffic at Arti's SOCKS5 proxy, or direct.
//
// Two hooks, because not every HTTP client is built from React Native's
// provider. The factory installed into OkHttpClientProvider covers `fetch`
// and WebSocket; the process-wide default ProxySelector covers every other
// OkHttp client built without a selector of its own (expo-file-system's
// downloads among them) and every HttpURLConnection. iOS has no equivalent
// hook and wraps the Nostr WebSocket by hand, which is why a Cashu mint call is
// refused there and needs no refusal here.
//
// Only http, https, ws and wss are ever routed. A plain java.net.Socket asks
// the default selector too, with a socket:// URI, and the LAN, Wi-Fi Aware and
// transfer sockets are exactly that: sent to Arti, which refuses local
// addresses, all three would break whenever Tor is on.
//
// System services (the geocoder) do their networking in another process and
// are outside any of this.
package org.onemindlabs.airhop.tor

import android.content.Context
import com.facebook.react.modules.network.OkHttpClientProvider
import com.facebook.react.modules.systeminfo.AndroidInfoHelpers
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import okhttp3.ConnectionPool
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import org.onemindlabs.airhop.BuildConfig

object AirhopTorProxy {

    private val DIRECT = listOf(Proxy.NO_PROXY)

    // Where traffic goes while Tor is wanted but not yet listening. Nothing can
    // listen on port 0, so every connection fails at once; an empty answer
    // would not do, since OkHttp reads it as DIRECT.
    private val HELD =
        Proxy(Proxy.Type.SOCKS, InetSocketAddress(InetAddress.getLoopbackAddress(), 0))

    // Written from the module's worker, read on whichever thread opens a
    // connection.
    @Volatile private var proxy: Proxy? = null

    // "host:port" of the Metro dev server on a debug build, null on release.
    //
    // React Native's dev support builds its HTTP and inspector clients from the
    // same provider this factory is installed into, so with Tor on the bundle
    // loader, hot reload and the debugger would all dial the developer's machine
    // through a circuit that cannot reach it. BuildConfig.DEBUG is a compile-time
    // constant, so no shipped build can carry the exemption.
    @Volatile private var devServerAuthority: String? = null

    // The default selector before ours replaced it. Everything that is not web
    // traffic, and web traffic while Tor is off, is answered by it, so a proxy
    // the user configured for their Wi-Fi is still honoured.
    @Volatile private var system: ProxySelector? = null

    // One pool for every factory-built client, so one eviction covers them
    // all when the route changes. OkHttp pools by address, the selector is part
    // of that address and does not change identity when its answer does, so a
    // connection opened on the clear net would otherwise stay eligible for
    // reuse after Tor comes on.
    private val pool = ConnectionPool()

    internal val selector =
        object : ProxySelector() {
            override fun select(uri: URI?): List<Proxy> {
                if (uri == null) return DIRECT
                val routed = proxy
                if (routed == null || !isWeb(uri.scheme)) return fallback(uri)
                if (authorityOf(uri) == devServerAuthority) return DIRECT
                return listOf(routed)
            }

            // There is one route and no fallback. While Tor is on, a failure has to
            // stay a failure.
            override fun connectFailed(uri: URI?, sa: SocketAddress?, ioe: IOException?) = Unit
        }

    // Eviction closes only idle connections. One busy at the moment the route
    // changed goes back to the pool afterwards, so a request that would ride a
    // connection opened on another route is refused, and the connection closed
    // so it is not picked again. The dev server is exempt for the reason above.
    internal val routeGuard = Interceptor { chain ->
        val wanted = proxy
        val connection = chain.connection()
        if (
            wanted != null &&
                connection != null &&
                connection.route().proxy != wanted &&
                !isDevServer(chain.request().url)
        ) {
            runCatching { connection.socket().close() }
            throw IOException("Connection opened before the route changed")
        }
        chain.proceed(chain.request())
    }

    private fun isWeb(scheme: String?): Boolean =
        when (scheme?.lowercase()) {
            "http",
            "https",
            "ws",
            "wss" -> true
            else -> false
        }

    private fun fallback(uri: URI): List<Proxy> =
        runCatching { system?.select(uri) }.getOrNull()?.takeIf { it.isNotEmpty() } ?: DIRECT

    private fun isDevServer(url: HttpUrl): Boolean = "${url.host}:${url.port}" == devServerAuthority

    // "host:port" with the scheme's default port filled in, so a URI compares
    // against what AndroidInfoHelpers reports. Null rather than a partial match.
    private fun authorityOf(uri: URI): String? {
        val host = uri.host ?: return null
        val port =
            if (uri.port != -1) {
                uri.port
            } else {
                when (uri.scheme?.lowercase()) {
                    "https",
                    "wss" -> 443
                    "http",
                    "ws" -> 80
                    else -> return null
                }
            }
        return "$host:$port"
    }

    // Call once from Application.onCreate, before React Native builds its first
    // client: OkHttpClientProvider caches that client and offers no way to
    // replace it, so a factory installed later applies to nothing. Every other
    // client is built lazily, after this.
    fun install(context: Context) {
        installSelector(if (BuildConfig.DEBUG) AndroidInfoHelpers.getServerHost(context) else null)
        OkHttpClientProvider.setOkHttpClientFactory {
            configure(OkHttpClientProvider.createClientBuilder())
        }
    }

    // The part of install that needs no Context.
    internal fun installSelector(devServer: String?) {
        devServerAuthority = devServer
        val current = ProxySelector.getDefault()
        if (current !== selector) {
            system = current
            ProxySelector.setDefault(selector)
        }
    }

    internal fun configure(builder: OkHttpClient.Builder): OkHttpClient =
        builder
            .proxySelector(selector)
            .connectionPool(pool)
            .addNetworkInterceptor(routeGuard)
            .build()

    // Tor is wanted but its port is not yet ours, or no longer is: traffic
    // fails rather than going anywhere.
    fun hold() {
        proxy = HELD
        pool.evictAll()
    }

    // Called once Arti listens on the port, and with null once Tor is off.
    fun route(socksPort: Int?) {
        proxy = socksPort?.let {
            // The proxy address is resolved; the destination deliberately is not.
            // OkHttp hands an unresolved host to a SOCKS proxy, so the lookup
            // happens at the exit rather than leaking a DNS query for the host
            // the user is trying to reach privately.
            Proxy(Proxy.Type.SOCKS, InetSocketAddress(InetAddress.getLoopbackAddress(), it))
        }
        pool.evictAll()
    }
}
