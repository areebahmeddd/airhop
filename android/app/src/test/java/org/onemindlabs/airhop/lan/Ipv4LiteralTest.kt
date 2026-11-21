package org.onemindlabs.airhop.lan

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class Ipv4LiteralTest {
    // A dotted quad becomes its four bytes, with nothing looked up.
    @Test
    fun dottedQuadsParse() {
        assertArrayEquals(
            byteArrayOf(192.toByte(), 168.toByte(), 1, 23),
            ipv4Literal("192.168.1.23")?.address,
        )
        assertArrayEquals(byteArrayOf(10, 0, 0, 0), ipv4Literal("10.0.0.0")?.address)
    }

    // Anything that would send a name to DNS, or is not four octets, is refused.
    @Test
    fun everythingElseIsRefused() {
        val refused =
            listOf(
                "",
                "example.com",
                "localhost",
                "192.168.1",
                "192.168.1.1.1",
                "192.168.1.256",
                "192.168.1.-1",
                "192.168.1.1a",
                "1234.1.1.1",
                "::1",
                " 10.0.0.1",
            )
        for (host in refused) assertNull(host, ipv4Literal(host))
    }

    // The subnet check that picks the network a dial is bound to.
    @Test
    fun subnetsMatchOnTheirPrefixOnly() {
        val home = byteArrayOf(192.toByte(), 168.toByte(), 1, 10)
        val peer = byteArrayOf(192.toByte(), 168.toByte(), 1, 23)
        val other = byteArrayOf(192.toByte(), 168.toByte(), 2, 23)
        assertTrue(onSubnet(peer, home, 24))
        assertFalse(onSubnet(other, home, 24))
        assertTrue(onSubnet(other, home, 16))
        val venue = byteArrayOf(10, 20, 0, 1)
        assertTrue(onSubnet(byteArrayOf(10, 23, 255.toByte(), 9), venue, 12))
        assertFalse(onSubnet(byteArrayOf(10, 32, 0, 1), venue, 12))
        assertFalse(onSubnet(peer, home, 33))
        assertFalse(onSubnet(peer, ByteArray(16), 24))
    }
}
