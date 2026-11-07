// One BLE link's outbound writes, in order, with at most one at the radio.
//
// Android allows one outstanding GATT operation per link and refuses a write
// made while another is in flight, so the module hands over the head and waits
// for its completion callback (onCharacteristicWrite as central,
// onNotificationSent as peripheral) before the next. The bounds and the retry
// rules match bitchat-android's per-link send queue.
//
// Ownership: whoever is told SEND (by offer, completed, retryDue or
// releaseStalled) is the one caller that may hand the head to the radio,
// through claimHead, until it reports back with completed or refused.
// Everything else only appends.
//
// Pure and synchronized, with no Android dependency: the module calls it from
// the native-modules thread, the main handler and GATT binder threads alike.
// It never reads the bytes; an entry expires only by the time-to-live its
// caller gave it, and the time it was handed over is the only clock on a
// write the radio holds.
package org.onemindlabs.airhop.ble

internal class LinkWriteQueue(
    private val maxEntries: Int = MAX_ENTRIES,
    private val maxBytes: Long = MAX_BYTES,
) {
    enum class Offer {
        // Queued and idle: the caller now owns the hand-off.
        SEND,
        // Queued behind a write the radio holds or a retry already scheduled.
        QUEUED,
        // Over the count or byte bound; nothing was queued.
        FULL,
        // The link went away; nothing was queued.
        CLOSED,
    }

    enum class Next {
        // Nothing for the caller to do.
        IDLE,
        // The caller owns the hand-off and should claim the head now.
        SEND,
        // The caller should call retryDue after RETRY_DELAY_MS.
        RETRY,
        // A head with no deadline was refused past MAX_REFUSALS. The queue has
        // closed itself, and the caller should drop the link: a write that
        // must arrive is never skipped, so its sender hears the link go
        // rather than a stream with a hole in it.
        WEDGED,
    }

    private class Entry(val data: ByteArray, val enqueuedAtMs: Long, val ttlMs: Long) {
        // Times the radio refused to take it, and times it took it and then
        // reported failure. Bounded separately: the first is a busy stack, the
        // second a write that went out and did not land.
        var refusals = 0
        var failures = 0

        fun expired(nowMs: Long) = ttlMs > 0 && nowMs - enqueuedAtMs > ttlMs
    }

    private val pending = ArrayDeque<Entry>()
    private var pendingBytes = 0L
    // The head is with the radio, or its owner is about to hand it over.
    private var inFlight = false
    // When claimHead last gave the head out, or null while the radio holds
    // nothing of this link's.
    private var handedAtMs: Long? = null
    private var retryScheduled = false
    private var closed = false

    // `ttlMs` of zero or less never expires. The bounds count the head the
    // radio holds, as bitchat-android's do, but not an entry past its deadline:
    // it will never be sent, so it is dropped here wherever it waits rather
    // than holding a slot until it reaches the head.
    @Synchronized
    fun offer(data: ByteArray, ttlMs: Long, nowMs: Long): Offer {
        if (closed) return Offer.CLOSED
        dropExpired(nowMs)
        if (pending.size >= maxEntries || pendingBytes + data.size > maxBytes) return Offer.FULL
        pending.addLast(Entry(data, nowMs, ttlMs))
        pendingBytes += data.size
        if (inFlight || retryScheduled) return Offer.QUEUED
        inFlight = true
        return Offer.SEND
    }

    // Owner only. The bytes to hand to the radio, after dropping every expired
    // entry at the head; null, releasing ownership, when none is left.
    @Synchronized
    fun claimHead(nowMs: Long): ByteArray? {
        while (true) {
            val head = pending.firstOrNull()
            if (closed || head == null) {
                inFlight = false
                handedAtMs = null
                return null
            }
            if (head.expired(nowMs)) {
                removeHead()
                continue
            }
            handedAtMs = nowMs
            return head.data
        }
    }

    // A head the radio has held past STALL_TIMEOUT_MS is taken as done, without
    // a resend, since its completion callback is not coming; what follows is
    // as for completed. Null when nothing has stalled. Without this a lost
    // callback holds the link's writes forever while the link itself looks
    // healthy. The caller checks on each write and on a periodic tick, so a
    // stall needs no timer of its own.
    @Synchronized
    fun releaseStalled(nowMs: Long): Next? {
        val handedAt = handedAtMs ?: return null
        if (!inFlight || nowMs - handedAt <= STALL_TIMEOUT_MS) return null
        return completed(true)
    }

    // Owner only: the radio would not take the head. It stays at the head for a
    // retry, unless it has been refused so often that the link is stuck. Then
    // a live entry goes and the next gets its own tries, but one with no
    // deadline closes the queue instead (WEDGED).
    @Synchronized
    fun refused(): Next {
        inFlight = false
        handedAtMs = null
        val head = pending.firstOrNull() ?: return Next.IDLE
        head.refusals++
        if (head.refusals > MAX_REFUSALS) {
            if (head.ttlMs <= 0) {
                close()
                return Next.WEDGED
            }
            removeHead()
        }
        return scheduleRetry()
    }

    // The radio finished with the head. A failure is sent again a few times; a
    // success, or a failure past its tries, moves on. A callback while the radio
    // holds nothing of this link's is stale and ignored: its queue was discarded
    // and rebuilt, or its head was released as stalled and the next is owned but
    // not yet claimed, which it must not complete unsent.
    @Synchronized
    fun completed(success: Boolean): Next {
        if (!inFlight || handedAtMs == null) return Next.IDLE
        handedAtMs = null
        val head = pending.firstOrNull()
        if (head == null) {
            inFlight = false
            return Next.IDLE
        }
        if (!success && head.failures < MAX_FAILURES) {
            head.failures++
            inFlight = false
            return scheduleRetry()
        }
        removeHead()
        if (pending.isEmpty()) {
            inFlight = false
            return Next.IDLE
        }
        return Next.SEND
    }

    // A scheduled retry has come due.
    @Synchronized
    fun retryDue(): Next {
        retryScheduled = false
        if (closed || inFlight || pending.isEmpty()) return Next.IDLE
        inFlight = true
        return Next.SEND
    }

    // Writes not yet handed to the radio.
    @Synchronized
    fun waiting(): Int = pending.size - (if (inFlight && pending.isNotEmpty()) 1 else 0)

    // The link is gone. Anyone still holding this queue finds it empty and
    // closed, so a late callback or retry does nothing.
    @Synchronized
    fun close() {
        closed = true
        pending.clear()
        pendingBytes = 0
        inFlight = false
        handedAtMs = null
        retryScheduled = false
    }

    // Every expired entry but a head that is in flight: completed releases
    // that one, and dropping it first would release the entry behind it.
    private fun dropExpired(nowMs: Long) {
        val held = if (inFlight) pending.firstOrNull() else null
        pending.removeAll { entry ->
            val drop = entry !== held && entry.expired(nowMs)
            if (drop) pendingBytes -= entry.data.size
            drop
        }
    }

    private fun scheduleRetry(): Next {
        if (closed || retryScheduled || pending.isEmpty()) return Next.IDLE
        retryScheduled = true
        return Next.RETRY
    }

    private fun removeHead() {
        val head = pending.removeFirst()
        pendingBytes -= head.data.size
    }

    companion object {
        // Per link, as bitchat-android bounds it.
        const val MAX_ENTRIES = 256
        const val MAX_BYTES = 1L shl 20

        // bitchat-android waits this long before offering a refused write
        // again: a busy stack frees up within a connection interval or two.
        const val RETRY_DELAY_MS = 15L

        // About two seconds of refusals at RETRY_DELAY_MS. A stack refusing
        // that long is wedged: a live entry is dropped so it cannot pin the
        // queue, and one with no deadline takes the link down (Next.WEDGED).
        const val MAX_REFUSALS = 128

        // bitchat-android's MAX_CALLBACK_RETRIES.
        const val MAX_FAILURES = 3

        // The same two seconds MAX_REFUSALS allows. A write the stack took
        // reports back within a few connection intervals, so one silent this
        // long has lost its callback. Misjudging a slow one costs little: the
        // stack refuses the next write while it still holds one, and the
        // refusal retry covers that.
        const val STALL_TIMEOUT_MS = 2_000L
    }
}
