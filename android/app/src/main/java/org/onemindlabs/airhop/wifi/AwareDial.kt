package org.onemindlabs.airhop.wifi

// Which side of a data path this device is for a peer.
internal enum class Role {
    INITIATOR,
    RESPONDER,
}

//   IDLE          known, nothing in flight; the tick decides when to dial
//   REQUESTED     REQUEST sent, waiting for READY
//   PATH_PENDING  a requestNetwork() is outstanding, in either role
//   CONNECTED     a socket is open and registered
internal enum class DialState {
    IDLE,
    REQUESTED,
    PATH_PENDING,
    CONNECTED,
}

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

    // Aware data interfaces are aware_data0..N-1: the prefix is
    // AWARE_INTERFACE_PREFIX in AOSP's WifiAwareDataPathStateManager, and
    // Samsung's builds use it too (the #37 logs show %aware_data0). The server
    // socket listens on every interface, so this is what keeps it to data paths.
    fun isAwareInterface(name: String?): Boolean = name?.startsWith("aware_data") == true

    // Whether a hello on an accepted socket may claim a link for its peer. Only
    // a responder receives inbound sockets, and its state is set when the
    // connect request arrives, before the data path exists, so a genuine hello
    // always finds it. This ties an inbound socket to a path we opened; it does
    // not tell a real peer's socket from another one naming that peer while it
    // is ours, which the interface check and radio range bound instead.
    fun acceptsInboundHello(role: Role?, state: DialState): Boolean =
        role == Role.RESPONDER && (state == DialState.PATH_PENDING || state == DialState.CONNECTED)

    // The wait after the given number of failed attempts, before jitter.
    fun backoffMs(attempts: Int): Long =
        minOf(BACKOFF_MAX_MS, BACKOFF_BASE_MS shl minOf(maxOf(attempts, 1) - 1, 5))

    fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
}
