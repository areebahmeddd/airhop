package org.onemindlabs.airhop.transport

import java.io.EOFException
import java.io.InputStream
import java.net.SocketTimeoutException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class FrameReaderTest {
    // A socket stream played from a script: each step is some bytes, or a read
    // timeout, and every step advances the clock by its own delay.
    private sealed class Step(val afterMs: Long) {
        class Bytes(val bytes: ByteArray, afterMs: Long = 0) : Step(afterMs)

        class Timeout(afterMs: Long = FrameReader.READ_TIMEOUT_MS.toLong()) : Step(afterMs)
    }

    private class ScriptedStream(steps: List<Step>) : InputStream() {
        var clockMs = 0L
        private val pending = ArrayDeque(steps)
        private var current: ByteArray? = null
        private var offset = 0

        override fun read(): Int = throw UnsupportedOperationException()

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            val bytes =
                current
                    ?: when (val step = pending.removeFirstOrNull() ?: return -1) {
                        is Step.Timeout -> {
                            clockMs += step.afterMs
                            throw SocketTimeoutException()
                        }
                        is Step.Bytes -> {
                            clockMs += step.afterMs
                            current = step.bytes
                            offset = 0
                            step.bytes
                        }
                    }
            val n = minOf(len, bytes.size - offset)
            bytes.copyInto(b, off, offset, offset + n)
            offset += n
            if (offset == bytes.size) current = null
            return n
        }
    }

    private fun reader(vararg steps: Step): FrameReader {
        val stream = ScriptedStream(steps.toList())
        return FrameReader(stream) { stream.clockMs }
    }

    private fun closedWith(reader: FrameReader): String {
        try {
            reader.next()
        } catch (e: FrameReader.Closed) {
            return e.message ?: ""
        }
        fail("expected the reader to close the link")
        return ""
    }

    @Test
    fun readsFramesAndHeartbeats() {
        val body = byteArrayOf(1, 2, 3)
        val r =
            reader(
                Step.Bytes(Framing.encode(ByteArray(0))),
                Step.Bytes(Framing.encode(body)),
            )
        assertEquals(0, r.next().size)
        assertArrayEquals(body, r.next())
    }

    // Split across reads the way TCP delivers it.
    @Test
    fun reassemblesAFrameFromPieces() {
        val frame = Framing.encode(ByteArray(100) { it.toByte() })
        val r =
            reader(
                Step.Bytes(frame.copyOfRange(0, 2)),
                Step.Bytes(frame.copyOfRange(2, 50), afterMs = 1_000),
                Step.Bytes(frame.copyOfRange(50, frame.size), afterMs = 1_000),
            )
        assertArrayEquals(frame.copyOfRange(4, frame.size), r.next())
    }

    // One byte just inside every read timeout never trips the per-read check;
    // the whole-frame deadline is what ends it.
    @Test
    fun dripClosesAtTheFrameDeadline() {
        val frame = Framing.encode(ByteArray(64))
        val drip = frame.map { Step.Bytes(byteArrayOf(it), afterMs = 9_000) }
        val stream = ScriptedStream(drip)
        val r = FrameReader(stream) { stream.clockMs }
        assertEquals("frame past the deadline", closedWith(r))
        // Closed on the first byte past the deadline, counted from the first.
        val firstByteAt = 9_000L
        assertTrue(stream.clockMs > firstByteAt + FrameReader.FRAME_DEADLINE_MS)
        assertTrue(stream.clockMs <= firstByteAt + FrameReader.FRAME_DEADLINE_MS + 9_000)
    }

    @Test
    fun heartbeatsResetTheIdleCount() {
        val beat = Framing.encode(ByteArray(0))
        val r =
            reader(
                Step.Timeout(),
                Step.Timeout(),
                Step.Bytes(beat),
                Step.Timeout(),
                Step.Timeout(),
                Step.Bytes(beat),
            )
        assertEquals(0, r.next().size)
        assertEquals(0, r.next().size)
    }

    @Test
    fun idleClosesAfterTheLimit() {
        val r = reader(Step.Timeout(), Step.Timeout(), Step.Timeout())
        assertEquals("idle past the deadline", closedWith(r))
    }

    @Test
    fun timeoutMidFrameCloses() {
        val frame = Framing.encode(ByteArray(10))
        val r = reader(Step.Bytes(frame.copyOfRange(0, 6)), Step.Timeout())
        assertEquals("stalled mid-frame", closedWith(r))
    }

    @Test
    fun timeoutInsideThePrefixCloses() {
        val r = reader(Step.Bytes(byteArrayOf(0, 0)), Step.Timeout())
        assertEquals("stalled mid-frame", closedWith(r))
    }

    @Test
    fun oversizedPrefixIsRefused() {
        val r = reader(Step.Bytes(byteArrayOf(0x7f, 0, 0, 0)))
        assertEquals("invalid frame length", closedWith(r))
    }

    @Test(expected = EOFException::class)
    fun cleanEofEndsTheLoop() {
        reader().next()
    }

    @Test(expected = EOFException::class)
    fun eofMidFrameEndsTheLoop() {
        reader(Step.Bytes(Framing.encode(ByteArray(10)).copyOfRange(0, 7))).next()
    }
}
