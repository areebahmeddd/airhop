package org.onemindlabs.airhop.transport

import java.net.Inet6Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.Socket

// Which interface an accepted socket arrived on, so a listener bound to the
// wildcard address can refuse the interfaces it was never meant to serve.
internal object LocalInterface {
    // The interface name, or null when the platform will not say.
    //
    // An address read off a socket carries only a scope id on Android, not the
    // interface (libcore builds it from sockaddr_in6 with getByAddress(null,
    // bytes, scope_id)), so the id is looked up by index. The scope is what
    // tells two link-local addresses apart: wlan0 has an fe80 address as well
    // as aware_data0. An address without one, IPv4 or routable IPv6, is matched
    // against the interfaces' own addresses instead.
    fun nameOf(socket: Socket): String? {
        val local = socket.localAddress ?: return null
        return try {
            scopedName(local) ?: NetworkInterface.getByInetAddress(local)?.name
        } catch (_: Exception) {
            null
        }
    }

    private fun scopedName(address: InetAddress): String? {
        val v6 = address as? Inet6Address ?: return null
        v6.scopedInterface?.let {
            return it.name
        }
        return if (v6.scopeId > 0) NetworkInterface.getByIndex(v6.scopeId)?.name else null
    }
}
