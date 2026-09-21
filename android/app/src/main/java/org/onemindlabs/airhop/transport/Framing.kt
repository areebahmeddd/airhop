package org.onemindlabs.airhop.transport

// The stream framing every TCP link uses, Wi-Fi Aware and LAN alike: a 4-byte
// big-endian length, then the bytes. An empty frame is the heartbeat. Pure, so
// the read loops and the tests share one definition of a valid prefix.
internal object Framing {
    // One 64 KiB file chunk plus the length prefix.
    const val MAX_FRAME = 65544
    const val PREFIX_BYTES = 4

    fun encode(data: ByteArray): ByteArray {
        val frame = ByteArray(PREFIX_BYTES + data.size)
        val len = data.size
        frame[0] = (len shr 24).toByte()
        frame[1] = (len shr 16).toByte()
        frame[2] = (len shr 8).toByte()
        frame[3] = len.toByte()
        data.copyInto(frame, PREFIX_BYTES)
        return frame
    }

    // The body length a prefix announces, or null when the prefix cannot be
    // trusted: a high bit set (negative as an Int) or a claim past MAX_FRAME,
    // either of which means the stream is not ours or has lost sync.
    fun length(prefix: ByteArray): Int? {
        if (prefix.size < PREFIX_BYTES) return null
        val len =
            ((prefix[0].toInt() and 0xff) shl 24) or
                ((prefix[1].toInt() and 0xff) shl 16) or
                ((prefix[2].toInt() and 0xff) shl 8) or
                (prefix[3].toInt() and 0xff)
        if (len < 0 || len > MAX_FRAME) return null
        return len
    }
}
