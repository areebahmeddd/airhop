package org.onemindlabs.airhop.voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackBurstsTest {
    private fun frame(b: Int) = byteArrayOf(b.toByte())

    // ---- Floor handoff ----

    @Test
    fun aSupersededBurstStopsBeingCurrent() {
        val bursts = PlaybackBursts(32)
        val a = bursts.start()
        val b = bursts.start()

        assertFalse(bursts.isCurrent(a))
        assertTrue(bursts.isCurrent(b))
        assertNotSame(a.frames, b.frames)
    }

    @Test
    fun theNewBurstsFramesNeverReachTheOldThread() {
        // The old thread is still inside a write when the handoff lands. Once
        // it returns it takes from its own queue, which holds only the wake-up,
        // so it cannot split the new talker's frames with the new thread.
        val bursts = PlaybackBursts(32)
        val a = bursts.start()
        bursts.enqueue(frame(1))
        a.frames.take()
        val b = bursts.start()
        bursts.enqueue(frame(2))
        bursts.enqueue(frame(3))

        assertSame(PlaybackBurst.WAKE, a.frames.poll())
        assertEquals(null, a.frames.poll())
        assertEquals(2, b.frames.size)
    }

    @Test
    fun theOldThreadsCleanupLeavesTheNewBurstAlone() {
        // An old thread tearing down after its successor started must not clear
        // the new burst's state, or that burst plays nothing at all.
        val bursts = PlaybackBursts(32)
        val a = bursts.start()
        val b = bursts.start()
        bursts.enqueue(frame(1))

        bursts.ended(a)
        a.frames.clear()

        assertTrue(bursts.isCurrent(b))
        assertTrue(bursts.enqueue(frame(2)))
        assertEquals(2, b.frames.size)
    }

    @Test
    fun stopWakesTheThreadAndRefusesLaterFrames() {
        val bursts = PlaybackBursts(32)
        val a = bursts.start()
        bursts.stop()

        assertFalse(bursts.isCurrent(a))
        assertSame(PlaybackBurst.WAKE, a.frames.take())
        assertFalse(bursts.enqueue(frame(1)))
    }

    // ---- Queue cap ----

    @Test
    fun aFullQueueDropsItsOldestFrame() {
        val bursts = PlaybackBursts(2)
        val a = bursts.start()
        bursts.enqueue(frame(1))
        bursts.enqueue(frame(2))
        bursts.enqueue(frame(3))

        assertEquals(2, a.frames.size)
        assertEquals(2, a.frames.take()[0].toInt())
    }
}
