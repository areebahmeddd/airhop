package org.onemindlabs.airhop.voice

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicInteger

// One inbound burst's playback: the frames its thread plays, and who to tell
// once that thread has let go of the speaker.
//
// The queue belongs to this burst alone. A thread still unwinding an earlier
// burst drains its own queue and never the one a newer burst is filling.
internal class PlaybackBurst(val generation: Int) {
    val frames = LinkedBlockingQueue<ByteArray>()

    // Set once the burst has ended and its queue holds all it will ever get.
    @Volatile
    var finishing = false
        private set

    private var released = false
    private val onReleased = ArrayList<() -> Unit>()

    // Marks the queue complete, behind everything already in it.
    fun finish() {
        if (finishing) return
        finishing = true
        frames.offer(END)
    }

    // Runs `callback` once the thread has released the speaker, or now if it
    // already has.
    fun whenReleased(callback: () -> Unit) {
        synchronized(this) {
            if (!released) {
                onReleased.add(callback)
                return
            }
        }
        callback()
    }

    // Called by the playback thread as its very last step.
    fun markReleased() {
        val callbacks =
            synchronized(this) {
                released = true
                onReleased.toList().also { onReleased.clear() }
            }
        callbacks.forEach { it() }
    }

    companion object {
        // Offered to wake a blocked take() so the thread notices it is no
        // longer current. Any empty frame but END reads as this, since
        // enqueue never queues an empty one.
        val WAKE = ByteArray(0)

        // Offered by finish(), behind everything already queued, and told
        // apart from WAKE by identity. The thread plays up to it, then plays
        // out and releases.
        val END = ByteArray(0)
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
    // holds, and a finishing burst holds it until it has played out.
    fun isCurrent(burst: PlaybackBurst): Boolean = generation.get() == burst.generation

    // Queues a frame for the current burst. False when there is none, or it has
    // already ended: late audio is worthless, which is why nothing retransmits.
    @Synchronized
    fun enqueue(frame: ByteArray): Boolean {
        val burst = current ?: return false
        if (burst.finishing || frame.isEmpty()) return false
        // Drop the oldest rather than block the bridge when the speaker is
        // behind: the queue holding means the audio in it is already stale.
        while (burst.frames.size >= maxQueuedFrames) burst.frames.poll()
        burst.frames.offer(frame)
        return true
    }

    // The burst ended: its thread plays what is queued, then releases the
    // speaker and runs `onReleased`. Run at once when nothing is playing.
    @Synchronized
    fun finish(onReleased: () -> Unit) {
        val burst = current
        if (burst == null) {
            onReleased()
            return
        }
        burst.finish()
        burst.whenReleased(onReleased)
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
