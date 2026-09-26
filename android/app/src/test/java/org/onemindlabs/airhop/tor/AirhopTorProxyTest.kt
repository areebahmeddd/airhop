package org.onemindlabs.airhop.tor

import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.Socket
import java.net.SocketAddress
import java.net.URI
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import okhttp3.Address
import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.Connection
import okhttp3.ConnectionSpec
import okhttp3.Dns
import okhttp3.Handshake
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.Route
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class AirhopTorProxyTest {
    private val devServer = "10.0.2.2:8081"
    private val systemProxy =
        Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved("proxy", 3128))

    // Stands in for the platform default: a Wi-Fi proxy for web traffic, and
    // DIRECT for anything else, as Android's DefaultProxySelector answers.
    private val platform =
        object : ProxySelector() {
            override fun select(uri: URI): List<Proxy> =
                if (uri.scheme == "socket") listOf(Proxy.NO_PROXY) else listOf(systemProxy)

            override fun connectFailed(uri: URI?, sa: SocketAddress?, ioe: IOException?) = Unit
        }

    private var original: ProxySelector? = null

    @Before
    fun setUp() {
        original = ProxySelector.getDefault()
        ProxySelector.setDefault(platform)
        AirhopTorProxy.installSelector(devServer)
    }

    @After
    fun tearDown() {
        AirhopTorProxy.route(null)
        ProxySelector.setDefault(original)
    }

    private fun select(uri: String): List<Proxy> = ProxySelector.getDefault().select(URI(uri))

    private fun socks(port: Int) =
        listOf(Proxy(Proxy.Type.SOCKS, InetSocketAddress(InetAddress.getLoopbackAddress(), port)))

    @Test
    fun installsAirhopsSelectorAsTheDefault() {
        assertSame(AirhopTorProxy.selector, ProxySelector.getDefault())
    }

    @Test
    fun webTrafficGoesToSocksWhileRouted() {
        AirhopTorProxy.route(39050)
        assertEquals(socks(39050), select("https://mint.example/v1/info"))
        assertEquals(socks(39050), select("http://example.com/"))
        assertEquals(socks(39050), select("wss://relay.example"))
    }

    // Plain java.net.Socket connects ask the default selector with socket://.
    // The LAN, Wi-Fi Aware and transfer sockets are those, and Arti refuses
    // local addresses, so they must never be routed.
    @Test
    fun plainSocketsStayDirectWhileRouted() {
        AirhopTorProxy.route(39050)
        assertEquals(listOf(Proxy.NO_PROXY), select("socket://192.168.1.20:4000"))
        assertEquals(listOf(Proxy.NO_PROXY), select("socket://[fe80::1]:4000"))
        AirhopTorProxy.hold()
        assertEquals(listOf(Proxy.NO_PROXY), select("socket://192.168.1.20:4000"))
    }

    @Test
    fun webTrafficFallsBackToThePlatformWhenNotRouted() {
        AirhopTorProxy.route(null)
        assertEquals(listOf(systemProxy), select("https://api.github.com/"))
    }

    @Test
    fun devServerStaysDirectWhileRouted() {
        AirhopTorProxy.route(39050)
        assertEquals(listOf(Proxy.NO_PROXY), select("http://10.0.2.2:8081/index.bundle"))
        AirhopTorProxy.hold()
        assertEquals(listOf(Proxy.NO_PROXY), select("ws://10.0.2.2:8081/message"))
    }

    // Held traffic goes to a proxy nothing can listen on, so it fails rather
    // than going direct.
    @Test
    fun holdFailsEveryConnection() {
        AirhopTorProxy.hold()
        val proxies = select("https://mint.example/")
        assertEquals(1, proxies.size)
        val held = proxies[0]
        assertEquals(Proxy.Type.SOCKS, held.type())
        assertEquals(0, (held.address() as InetSocketAddress).port)
        try {
            Socket(held).use {
                it.connect(InetSocketAddress.createUnresolved("mint.example", 443), 2_000)
            }
            fail("a held route must not connect")
        } catch (_: IOException) {}
    }

    @Test
    fun factoryClientsShareOnePool() {
        val a = AirhopTorProxy.configure(OkHttpClient.Builder())
        val b = AirhopTorProxy.configure(OkHttpClient.Builder())
        assertSame(a.connectionPool, b.connectionPool)
        assertSame(AirhopTorProxy.selector, a.proxySelector)
        assertTrue(a.networkInterceptors.contains(AirhopTorProxy.routeGuard))
    }

    // ---- Route guard ----

    private class FakeConnection(private val route: Route) : Connection {
        val socket = Socket()

        override fun route(): Route = route

        override fun socket(): Socket = socket

        override fun handshake(): Handshake? = null

        override fun protocol(): Protocol = Protocol.HTTP_1_1
    }

    private class FakeChain(private val request: Request, private val connection: Connection?) :
        Interceptor.Chain {
        var proceeded = false

        override fun request(): Request = request

        override fun proceed(request: Request): Response {
            proceeded = true
            return Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .build()
        }

        override fun connection(): Connection? = connection

        override fun call(): Call = throw UnsupportedOperationException()

        override fun connectTimeoutMillis(): Int = 0

        override fun withConnectTimeout(timeout: Int, unit: TimeUnit): Interceptor.Chain = this

        override fun readTimeoutMillis(): Int = 0

        override fun withReadTimeout(timeout: Int, unit: TimeUnit): Interceptor.Chain = this

        override fun writeTimeoutMillis(): Int = 0

        override fun withWriteTimeout(timeout: Int, unit: TimeUnit): Interceptor.Chain = this
    }

    private fun connectionVia(proxy: Proxy, host: String = "mint.example", port: Int = 443) =
        FakeConnection(
            Route(
                Address(
                    host,
                    port,
                    Dns.SYSTEM,
                    SocketFactory.getDefault(),
                    null,
                    null,
                    null,
                    Authenticator.NONE,
                    null,
                    listOf(Protocol.HTTP_1_1),
                    listOf(ConnectionSpec.CLEARTEXT),
                    ProxySelector.getDefault(),
                ),
                proxy,
                InetSocketAddress.createUnresolved(host, port),
            )
        )

    private fun request(url: String) = Request.Builder().url(url).build()

    // A connection that was busy when Tor came on returns to the pool on the
    // clear net; the next request on it is refused and the socket closed.
    @Test
    fun guardRefusesAndClosesAConnectionFromAnotherRoute() {
        AirhopTorProxy.route(39050)
        val connection = connectionVia(Proxy.NO_PROXY)
        val chain = FakeChain(request("https://mint.example/v1/info"), connection)
        try {
            AirhopTorProxy.routeGuard.intercept(chain)
            fail("a clear-net connection must not carry a request while routed")
        } catch (_: IOException) {}
        assertFalse(chain.proceeded)
        assertTrue(connection.socket.isClosed)
    }

    @Test
    fun guardPassesTheCurrentRoute() {
        AirhopTorProxy.route(39050)
        val chain = FakeChain(request("https://mint.example/"), connectionVia(socks(39050)[0]))
        AirhopTorProxy.routeGuard.intercept(chain)
        assertTrue(chain.proceeded)
    }

    @Test
    fun guardPassesTheDevServer() {
        AirhopTorProxy.route(39050)
        val dev = connectionVia(Proxy.NO_PROXY, "10.0.2.2", 8081)
        val chain = FakeChain(request("http://10.0.2.2:8081/status"), dev)
        AirhopTorProxy.routeGuard.intercept(chain)
        assertTrue(chain.proceeded)
    }

    @Test
    fun guardIsIdleWhenNotRouted() {
        AirhopTorProxy.route(null)
        val chain = FakeChain(request("https://mint.example/"), connectionVia(Proxy.NO_PROXY))
        AirhopTorProxy.routeGuard.intercept(chain)
        assertTrue(chain.proceeded)
    }
}
