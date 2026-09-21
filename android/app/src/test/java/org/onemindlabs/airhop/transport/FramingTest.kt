package org.onemindlabs.airhop.transport

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FramingTest {
    @Test
    fun prefixIsBigEndianLength() {
        val frame = Framing.encode(ByteArray(0x010203))
        assertArrayEquals(byteArrayOf(0x00, 0x01, 0x02, 0x03), frame.copyOfRange(0, 4))
        assertEquals(4 + 0x010203, frame.size)
    }

    @Test
    fun roundTripsBody() {
        val body = byteArrayOf(9, 8, 7, 6, 5)
        val frame = Framing.encode(body)
        assertEquals(body.size, Framing.length(frame))
        assertArrayEquals(body, frame.copyOfRange(4, frame.size))
    }

    @Test
    fun emptyFrameIsTheHeartbeat() {
        val frame = Framing.encode(ByteArray(0))
        assertArrayEquals(byteArrayOf(0, 0, 0, 0), frame)
        assertEquals(0, Framing.length(frame))
    }

    @Test
    fun largestFrameIsAccepted() {
        val prefix = Framing.encode(ByteArray(Framing.MAX_FRAME)).copyOfRange(0, 4)
        assertEquals(Framing.MAX_FRAME, Framing.length(prefix))
    }

    @Test
    fun oversizedClaimIsRefused() {
        val prefix = Framing.encode(ByteArray(Framing.MAX_FRAME + 1)).copyOfRange(0, 4)
        assertNull(Framing.length(prefix))
    }

    // A high bit set would read as a negative Int; it is not a length.
    @Test
    fun highBitIsRefused() {
        assertNull(Framing.length(byteArrayOf(0x80.toByte(), 0, 0, 0)))
        assertNull(
            Framing.length(byteArrayOf(0xff.toByte(), 0xff.toByte(), 0xff.toByte(), 0xff.toByte()))
        )
    }

    @Test
    fun shortPrefixIsRefused() {
        assertNull(Framing.length(byteArrayOf(0, 0, 1)))
    }
}
