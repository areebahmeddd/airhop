package org.onemindlabs.airhop.voice

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicInteger

// One inbound burst's playback: the frames its thread plays.
//
// The queue belongs to this burst alone. A thread still unwinding an earlier
// burst drains its own queue and never the one a newer burst is filling.
internal class PlaybackBurst(val generation: Int) {
    val frames = LinkedBlockingQueue<ByteArray>()

    companion object {
        // Offered to wake a blocked take() so the thread notices it is no
        // longer current. An empty frame is never queued.
        val WAKE = ByteArray(0)
    }
}

// Which burst the speaker belongs to, with the same generation rule as capture.
//
// A playback thread does not die the moment it is superseded: it finishes the
// blocking AudioTrack.write it is in (up to one 64 ms frame) and then releases
// its codec and track. A floor handoff lands inside that window routinely: one
// talker's END frees the speaker and the next talker's audio arrives about a
// packet later. With one shared queue and one flag, the old thread would
// either keep taking the new burst's frames, splitting them between two
// decoders, or its cleanup would clear the flag and the queue under its
// successor, which would then play nothing for the whole burst.
internal class PlaybackBursts(private val maxQueuedFrames: Int) {
    private val generation = AtomicInteger(0)
    private var current: PlaybackBurst? = null

    // Supersedes whatever was playing and opens the next burst.
    @Synchronized
    fun start(): PlaybackBurst {
        supersede()
        return PlaybackBurst(generation.incrementAndGet()).also { current = it }
    }

    // Supersedes whatever was playing, queued audio and all.
    @Synchronized
    fun stop() {
        supersede()
    }

    // Whether `burst` still owns the speaker. Its thread plays only while this
    // holds.
    fun isCurrent(burst: PlaybackBurst): Boolean = generation.get() == burst.generation

    // Queues a frame for the current burst. False when there is none: late
    // audio is worthless, which is why nothing retransmits.
    @Synchronized
    fun enqueue(frame: ByteArray): Boolean {
        val burst = current ?: return false
        if (frame.isEmpty()) return false
        // Drop the oldest rather than block the bridge when the speaker is
        // behind: the queue holding means the audio in it is already stale.
        while (burst.frames.size >= maxQueuedFrames) burst.frames.poll()
        burst.frames.offer(frame)
        return true
    }

    // Called by a burst's thread as it lets go. Clears the slot only if the
    // burst still holds it, so a superseded thread cannot close its successor.
    @Synchronized
    fun ended(burst: PlaybackBurst) {
        if (current === burst) current = null
    }

    private fun supersede() {
        generation.incrementAndGet()
        current?.frames?.offer(PlaybackBurst.WAKE)
        current = null
    }
}
