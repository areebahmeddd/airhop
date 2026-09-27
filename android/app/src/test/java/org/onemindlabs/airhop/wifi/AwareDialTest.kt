package org.onemindlabs.airhop.wifi

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AwareDialTest {
    private val instance =
        byteArrayOf(
            0x01,
            0x23,
            0x45,
            0x67,
            0x89.toByte(),
            0xab.toByte(),
            0xcd.toByte(),
            0xef.toByte(),
        )
    private val instanceHex = "0123456789abcdef"

    // ---- Follow-up messages ----

    @Test
    fun followUpIsTypeInstanceEpoch() {
        val msg = AwareDial.followUp(AwareDial.MSG_CONNECT_REQUEST, instance, 7)
        assertEquals(AwareDial.MSG_BYTES, msg.size)
        assertEquals(AwareDial.MSG_CONNECT_REQUEST, msg[0])
        assertArrayEquals(instance, msg.copyOfRange(1, 9))
        assertEquals(7, AwareDial.epochOf(msg))
        assertEquals(instanceHex, AwareDial.instanceFrom(msg, 1))
    }

    @Test
    fun followUpTypeIsChecked() {
        val msg = AwareDial.followUp(AwareDial.MSG_CONNECT_READY, instance, 1)
        assertTrue(AwareDial.isFollowUp(msg, AwareDial.MSG_CONNECT_READY))
        assertFalse(AwareDial.isFollowUp(msg, AwareDial.MSG_CONNECT_REQUEST))
        assertFalse(AwareDial.isFollowUp(msg.copyOfRange(0, 9), AwareDial.MSG_CONNECT_READY))
        assertFalse(AwareDial.isFollowUp(msg + byteArrayOf(0), AwareDial.MSG_CONNECT_READY))
    }

    // The epoch is one byte on the wire; the sender wraps it and the reader
    // must not sign-extend it.
    @Test
    fun epochIsUnsignedByte() {
        val msg = AwareDial.followUp(AwareDial.MSG_CONNECT_REQUEST, instance, 255)
        assertEquals(255, AwareDial.epochOf(msg))
        val wrapped = AwareDial.followUp(AwareDial.MSG_CONNECT_REQUEST, instance, 256 and 0xff)
        assertEquals(0, AwareDial.epochOf(wrapped))
    }

    @Test
    fun instanceNeedsEightBytesPastOffset() {
        assertNull(AwareDial.instanceFrom(ByteArray(8), 1))
        assertEquals("0000000000000000", AwareDial.instanceFrom(ByteArray(9), 1))
        // Service info: token first, instance after it.
        val ssi = ByteArray(AwareDial.TOKEN_BYTES) + instance
        assertEquals(instanceHex, AwareDial.instanceFrom(ssi, AwareDial.TOKEN_BYTES))
    }

    // ---- Hello frame ----

    @Test
    fun helloRoundTrips() {
        val frame = AwareDial.hello(instance)
        assertEquals(AwareDial.HELLO_BYTES, frame.size)
        assertEquals("AHWA", String(frame.copyOfRange(0, 4), Charsets.US_ASCII))
        assertEquals(AwareDial.HELLO_VERSION, frame[4])
        assertEquals(instanceHex, AwareDial.helloInstance(frame))
    }

    @Test
    fun helloRejectsWrongMagicVersionOrLength() {
        val frame = AwareDial.hello(instance)
        assertNull(AwareDial.helloInstance(frame.copyOf().also { it[0] = 'B'.code.toByte() }))
        assertNull(AwareDial.helloInstance(frame.copyOf().also { it[4] = 0x02 }))
        assertNull(AwareDial.helloInstance(frame.copyOfRange(0, frame.size - 1)))
        assertNull(AwareDial.helloInstance(frame + byteArrayOf(0)))
    }

    // An Airhop packet starts with its version byte (2), never 'A', so a
    // 13-byte packet can never be taken for a hello.
    @Test
    fun packetIsNeverAHello() {
        val packet = ByteArray(AwareDial.HELLO_BYTES).also { it[0] = 2 }
        assertNull(AwareDial.helloInstance(packet))
    }

    // ---- Tiebreak ----

    @Test
    fun lowerTokenDials() {
        val low = byteArrayOf(0, 0, 0, 0, 0, 0, 0, 1)
        val high = byteArrayOf(0, 0, 0, 0, 0, 0, 0, 2)
        assertTrue(AwareDial.prefersInitiator(low, high))
        assertFalse(AwareDial.prefersInitiator(high, low))
    }

    // Bytes compare unsigned: 0x80 is above 0x7f, not below it.
    @Test
    fun tokensCompareUnsigned() {
        val a = byteArrayOf(0x7f, 0, 0, 0, 0, 0, 0, 0)
        val b = byteArrayOf(0x80.toByte(), 0, 0, 0, 0, 0, 0, 0)
        assertTrue(AwareDial.prefersInitiator(a, b))
        assertFalse(AwareDial.prefersInitiator(b, a))
    }

    // Exactly one side dials for any pair of distinct tokens.
    @Test
    fun tiebreakIsAntisymmetric() {
        val mine = byteArrayOf(9, 8, 7, 6, 5, 4, 3, 2)
        val theirs = byteArrayOf(9, 8, 7, 6, 5, 4, 3, 1)
        assertTrue(
            AwareDial.prefersInitiator(mine, theirs) != AwareDial.prefersInitiator(theirs, mine)
        )
    }

    @Test
    fun unknownOrMalformedTokenMeansDial() {
        val mine = ByteArray(AwareDial.TOKEN_BYTES)
        assertTrue(AwareDial.prefersInitiator(mine, null))
        assertTrue(AwareDial.prefersInitiator(mine, ByteArray(7)))
        assertTrue(AwareDial.prefersInitiator(mine, mine.copyOf()))
    }

    // ---- Inbound gates ----

    @Test
    fun onlyAwareDataInterfacesAreAware() {
        assertTrue(AwareDial.isAwareInterface("aware_data0"))
        assertTrue(AwareDial.isAwareInterface("aware_data12"))
        assertFalse(AwareDial.isAwareInterface("wlan0"))
        assertFalse(AwareDial.isAwareInterface("lo"))
        assertFalse(AwareDial.isAwareInterface("rmnet_data0"))
        assertFalse(AwareDial.isAwareInterface("p2p-wlan0-0"))
        assertFalse(AwareDial.isAwareInterface(""))
        assertFalse(AwareDial.isAwareInterface(null))
    }

    // Only a responder with a path pending or up has asked for an inbound socket.
    @Test
    fun inboundHelloNeedsAResponderWithAPath() {
        for (state in DialState.values()) {
            val expected = state == DialState.PATH_PENDING || state == DialState.CONNECTED
            assertEquals(state.name, expected, AwareDial.acceptsInboundHello(Role.RESPONDER, state))
            assertFalse(state.name, AwareDial.acceptsInboundHello(Role.INITIATOR, state))
            assertFalse(state.name, AwareDial.acceptsInboundHello(null, state))
        }
    }

    // ---- Backoff ----

    @Test
    fun backoffDoublesFromThreeSecondsToAMinute() {
        assertEquals(3_000L, AwareDial.backoffMs(1))
        assertEquals(6_000L, AwareDial.backoffMs(2))
        assertEquals(12_000L, AwareDial.backoffMs(3))
        assertEquals(24_000L, AwareDial.backoffMs(4))
        assertEquals(48_000L, AwareDial.backoffMs(5))
        assertEquals(60_000L, AwareDial.backoffMs(6))
    }

    @Test
    fun backoffIsBoundedAtBothEnds() {
        assertEquals(3_000L, AwareDial.backoffMs(0))
        assertEquals(60_000L, AwareDial.backoffMs(1_000))
        assertEquals(60_000L, AwareDial.backoffMs(Int.MAX_VALUE))
    }
}
