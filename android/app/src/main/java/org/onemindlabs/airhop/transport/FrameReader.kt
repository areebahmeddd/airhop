package org.onemindlabs.airhop.transport

import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.net.SocketTimeoutException

// The read side of Framing on a blocking socket, shared by the Wi-Fi Aware and
// LAN links so their liveness rules cannot drift apart.
//
// The socket's read timeout is the clock tick. Between frames, IDLE_LIMIT
// timeouts in a row end the link; the far side's 8 s heartbeat resets the count.
// Inside a frame, a timeout ends it at once, since the partial bytes cannot be
// set aside and the next read resumed as a prefix. A frame must also finish
// within FRAME_DEADLINE_MS of its first byte: a peer that drips one byte just
// inside every read timeout never trips the per-read check, and would hold a
// thread for as long as it cared to.
internal class FrameReader(
    private val input: InputStream,
    private val now: () -> Long,
) {
    // The link should end, for a reason that is the reader's rather than the
    // socket's. Anything else the stream throws passes through unchanged.
    class Closed(reason: String) : IOException(reason)

    private val prefix = ByteArray(Framing.PREFIX_BYTES)
    private var idleTimeouts = 0

    // The next frame's body, empty for a heartbeat.
    fun next(): ByteArray {
        val startedAtMs = fill(prefix, null)
        val len = Framing.length(prefix) ?: throw Closed("invalid frame length")
        idleTimeouts = 0
        if (len == 0) return EMPTY
        val body = ByteArray(len)
        fill(body, startedAtMs)
        return body
    }

    // Reads `buf` full. `startedAtMs` is the frame's first byte when `buf`
    // continues a frame, null when it starts one. Returns when the frame started.
    private fun fill(buf: ByteArray, startedAtMs: Long?): Long {
        var start = startedAtMs
        var got = 0
        while (got < buf.size) {
            val n =
                try {
                    input.read(buf, got, buf.size - got)
                } catch (e: SocketTimeoutException) {
                    if (start != null) throw Closed("stalled mid-frame")
                    idleTimeouts += 1
                    if (idleTimeouts >= IDLE_LIMIT) throw Closed("idle past the deadline")
                    continue
                }
            if (n < 0) throw EOFException(if (start == null) "EOF" else "EOF mid-frame")
            val t = now()
            if (start == null) start = t
            got += n
            if (got < buf.size && t - start > FRAME_DEADLINE_MS) {
                throw Closed("frame past the deadline")
            }
        }
        return start ?: now()
    }

    companion object {
        // A heartbeat every 8 s (the modules' HEARTBEAT_MS) against a 10 s read
        // deadline, three misses allowed: a peer that walked off without a FIN is
        // closed in about thirty seconds.
        const val READ_TIMEOUT_MS = 10_000
        const val IDLE_LIMIT = 3

        // The same thirty seconds, for a whole frame. A full 64 KiB frame then
        // needs about 2.2 KiB/s, well under Bluetooth.
        const val FRAME_DEADLINE_MS = READ_TIMEOUT_MS.toLong() * IDLE_LIMIT

        private val EMPTY = ByteArray(0)
    }
}
