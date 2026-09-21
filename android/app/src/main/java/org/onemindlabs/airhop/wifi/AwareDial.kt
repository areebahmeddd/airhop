package org.onemindlabs.airhop.wifi

// The byte layouts and the rules that get a pair of Aware peers onto one
// socket on this platform: the follow-up messages, the hello frame, who dials,
// and how long a failed attempt waits. Pure, and shared with the tests, so the
// module holds only the framework calls around them.
//
// Not the Swift AwareDial: Apple's discovery is symmetric and paired, so its
// tie is settled on the socket, and Android can never be on the other end of
// an Apple data path.
internal object AwareDial {
    // Follow-up messages: type byte, instance id, epoch.
    const val MSG_CONNECT_REQUEST: Byte = 0x01
    const val MSG_CONNECT_READY: Byte = 0x02
    const val MSG_BYTES = 1 + 8 + 1

    // The tiebreak token is regenerated per attach so it never identifies the
    // device across sessions; the instance id is per process so a peer is
    // recognised while its app runs and unlinkable once it restarts. Both
    // travel in serviceSpecificInfo, token first.
    const val TOKEN_BYTES = 8
    const val INSTANCE_BYTES = 8

    // Hello frame: magic, version, instance id. 'A' can never be an Airhop
    // packet's version byte, which is what tells the hello apart from traffic.
    val HELLO_MAGIC: ByteArray = "AHWA".toByteArray(Charsets.US_ASCII)
    const val HELLO_VERSION: Byte = 0x01
    const val HELLO_BYTES = 4 + 1 + INSTANCE_BYTES

    // Per-peer retry backoff: 3 s doubling to a minute. Jitter is the caller's,
    // so the ladder itself stays checkable.
    const val BACKOFF_BASE_MS = 3_000L
    const val BACKOFF_MAX_MS = 60_000L

    fun followUp(type: Byte, instanceId: ByteArray, epoch: Int): ByteArray =
        byteArrayOf(type) + instanceId + byteArrayOf(epoch.toByte())

    fun isFollowUp(message: ByteArray, type: Byte): Boolean =
        message.size == MSG_BYTES && message[0] == type

    fun epochOf(message: ByteArray): Int = message[MSG_BYTES - 1].toInt() and 0xff

    fun instanceFrom(bytes: ByteArray, offset: Int): String? {
        if (bytes.size < offset + INSTANCE_BYTES) return null
        return bytes.copyOfRange(offset, offset + INSTANCE_BYTES).toHex()
    }

    fun hello(instanceId: ByteArray): ByteArray =
        HELLO_MAGIC + byteArrayOf(HELLO_VERSION) + instanceId

    fun helloInstance(frame: ByteArray): String? {
        if (frame.size != HELLO_BYTES) return null
        for (i in HELLO_MAGIC.indices) if (frame[i] != HELLO_MAGIC[i]) return null
        if (frame[HELLO_MAGIC.size] != HELLO_VERSION) return null
        return instanceFrom(frame, HELLO_MAGIC.size + 1)
    }

    // Lower token dials first. A tie is a 1-in-2^64 coincidence, and dialling
    // on it beats both sides waiting; so does a peer whose token is unknown.
    fun prefersInitiator(mine: ByteArray, theirs: ByteArray?): Boolean {
        if (theirs == null) return true
        if (mine.size != TOKEN_BYTES || theirs.size != TOKEN_BYTES) return true
        for (i in 0 until TOKEN_BYTES) {
            val a = mine[i].toInt() and 0xff
            val b = theirs[i].toInt() and 0xff
            if (a != b) return a < b
        }
        return true
    }

    // The wait after the given number of failed attempts, before jitter.
    fun backoffMs(attempts: Int): Long =
        minOf(BACKOFF_MAX_MS, BACKOFF_BASE_MS shl minOf(maxOf(attempts, 1) - 1, 5))

    fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
}
