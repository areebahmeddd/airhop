package org.onemindlabs.airhop.ble

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LinkWriteQueueTest {
    private fun bytes(b: Int, size: Int = 1) = ByteArray(size) { b.toByte() }

    // ---- Order and hand-off ----

    @Test
    fun theFirstWriteIsHandedOverAtOnce() {
        val queue = LinkWriteQueue()

        assertEquals(LinkWriteQueue.Offer.SEND, queue.offer(bytes(1), 0, 0))
        assertArrayEquals(bytes(1), queue.claimHead(0))
        assertEquals(0, queue.waiting())
    }

    @Test
    fun aWriteMadeWhileOneIsInFlightWaitsForItsCompletion() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 0, 0)
        queue.claimHead(0)

        assertEquals(LinkWriteQueue.Offer.QUEUED, queue.offer(bytes(2), 0, 0))
        assertEquals(LinkWriteQueue.Offer.QUEUED, queue.offer(bytes(3), 0, 0))
        assertEquals(2, queue.waiting())

        assertEquals(LinkWriteQueue.Next.SEND, queue.completed(true))
        assertArrayEquals(bytes(2), queue.claimHead(0))
        assertEquals(1, queue.waiting())

        assertEquals(LinkWriteQueue.Next.SEND, queue.completed(true))
        assertArrayEquals(bytes(3), queue.claimHead(0))
        assertEquals(LinkWriteQueue.Next.IDLE, queue.completed(true))
        assertEquals(0, queue.waiting())

        // Idle again: the next write is handed over at once.
        assertEquals(LinkWriteQueue.Offer.SEND, queue.offer(bytes(4), 0, 0))
    }

    @Test
    fun aRefusedHeadStaysAtTheHeadForARetry() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 0, 0)
        queue.claimHead(0)

        assertEquals(LinkWriteQueue.Next.RETRY, queue.refused())
        // Not handed over, so it counts as waiting, and a new write queues
        // behind the retry rather than jumping it.
        assertEquals(1, queue.waiting())
        assertEquals(LinkWriteQueue.Offer.QUEUED, queue.offer(bytes(2), 0, 0))

        assertEquals(LinkWriteQueue.Next.SEND, queue.retryDue())
        assertArrayEquals(bytes(1), queue.claimHead(0))
    }

    @Test
    fun aLiveHeadRefusedPastTheBoundIsDroppedAndTheNextGetsItsTurn() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 60_000, 0)
        queue.offer(bytes(2), 0, 0)
        queue.claimHead(0)
        repeat(LinkWriteQueue.MAX_REFUSALS) {
            assertEquals(LinkWriteQueue.Next.RETRY, queue.refused())
            assertEquals(LinkWriteQueue.Next.SEND, queue.retryDue())
            assertArrayEquals(bytes(1), queue.claimHead(0))
        }

        assertEquals(LinkWriteQueue.Next.RETRY, queue.refused())
        assertEquals(LinkWriteQueue.Next.SEND, queue.retryDue())
        assertArrayEquals(bytes(2), queue.claimHead(0))
    }

    @Test
    fun aHeadWithNoDeadlineRefusedPastTheBoundClosesTheQueue() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 0, 0)
        queue.offer(bytes(2), 0, 0)
        queue.claimHead(0)
        repeat(LinkWriteQueue.MAX_REFUSALS) {
            assertEquals(LinkWriteQueue.Next.RETRY, queue.refused())
            assertEquals(LinkWriteQueue.Next.SEND, queue.retryDue())
            assertArrayEquals(bytes(1), queue.claimHead(0))
        }

        // Never skipped: the whole queue goes, and the link with it.
        assertEquals(LinkWriteQueue.Next.WEDGED, queue.refused())
        assertEquals(0, queue.waiting())
        assertNull(queue.claimHead(0))
        assertEquals(LinkWriteQueue.Next.IDLE, queue.retryDue())
        assertEquals(LinkWriteQueue.Offer.CLOSED, queue.offer(bytes(3), 0, 0))
    }

    @Test
    fun aFailedCompletionIsSentAgainAFewTimesThenDropped() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 0, 0)
        queue.offer(bytes(2), 0, 0)
        queue.claimHead(0)
        repeat(LinkWriteQueue.MAX_FAILURES) {
            assertEquals(LinkWriteQueue.Next.RETRY, queue.completed(false))
            assertEquals(LinkWriteQueue.Next.SEND, queue.retryDue())
            assertArrayEquals(bytes(1), queue.claimHead(0))
        }

        assertEquals(LinkWriteQueue.Next.SEND, queue.completed(false))
        assertArrayEquals(bytes(2), queue.claimHead(0))
    }

    @Test
    fun aCompletionWithNothingInFlightIsIgnored() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 0, 0)
        queue.claimHead(0)
        queue.refused()

        assertEquals(LinkWriteQueue.Next.IDLE, queue.completed(true))
        assertEquals(1, queue.waiting())
    }

    @Test
    fun aCompletionBeforeTheOwnerClaimsTheHeadIsIgnored() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 0, 0)
        queue.offer(bytes(2), 0, 0)
        queue.claimHead(0)
        val later = LinkWriteQueue.STALL_TIMEOUT_MS + 1
        // Entry 1 is let go as stalled, so entry 2 is owned but not handed over.
        assertEquals(LinkWriteQueue.Next.SEND, queue.releaseStalled(later))

        // Entry 1's lost callback turns up late. It must not complete entry 2.
        assertEquals(LinkWriteQueue.Next.IDLE, queue.completed(true))
        assertArrayEquals(bytes(2), queue.claimHead(later))
    }

    // ---- Expiry ----

    @Test
    fun anExpiredEntryIsDroppedAtTheHeadWithoutANewWrite() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 0, 0)
        queue.claimHead(0)
        queue.offer(bytes(2), 100, 0)
        queue.offer(bytes(3), 0, 0)

        queue.completed(true)
        assertArrayEquals(bytes(3), queue.claimHead(500))
    }

    @Test
    fun anExpiredEntryBehindALiveHeadFreesItsSlot() {
        val queue = LinkWriteQueue(maxEntries = 3, maxBytes = 1_000)
        queue.offer(bytes(1), 0, 0)
        queue.claimHead(0)
        queue.offer(bytes(2), 100, 0)
        queue.offer(bytes(3), 0, 0)
        assertEquals(LinkWriteQueue.Offer.FULL, queue.offer(bytes(4), 0, 50))

        // Entry 2 will never be sent, so it gives its slot to a write that will.
        assertEquals(LinkWriteQueue.Offer.QUEUED, queue.offer(bytes(4), 0, 500))
        assertEquals(2, queue.waiting())

        queue.completed(true)
        assertArrayEquals(bytes(3), queue.claimHead(500))
        queue.completed(true)
        assertArrayEquals(bytes(4), queue.claimHead(500))
    }

    @Test
    fun anExpiredEntryBehindALiveHeadGivesItsBytesBack() {
        val queue = LinkWriteQueue(maxEntries = 100, maxBytes = 1_000)
        queue.offer(bytes(1, 100), 0, 0)
        queue.claimHead(0)
        queue.offer(bytes(2, 800), 100, 0)

        assertEquals(LinkWriteQueue.Offer.QUEUED, queue.offer(bytes(3, 800), 0, 500))
    }

    @Test
    fun theHeadInFlightIsNeverDroppedForItsAge() {
        val queue = LinkWriteQueue(maxEntries = 2, maxBytes = 1_000)
        queue.offer(bytes(1), 10, 0)
        queue.claimHead(0)

        // The radio holds it, so it keeps its slot until the radio reports.
        assertEquals(LinkWriteQueue.Offer.QUEUED, queue.offer(bytes(2), 0, 50))
        assertEquals(LinkWriteQueue.Offer.FULL, queue.offer(bytes(3), 0, 50))

        // Its completion releases it, not the entry behind it.
        assertEquals(LinkWriteQueue.Next.SEND, queue.completed(true))
        assertArrayEquals(bytes(2), queue.claimHead(50))
    }

    @Test
    fun anEntryAtExactlyItsTimeToLiveIsStillSent() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 0, 0)
        queue.claimHead(0)
        queue.offer(bytes(2), 100, 0)

        queue.completed(true)

        assertArrayEquals(bytes(2), queue.claimHead(100))
    }

    @Test
    fun noTimeToLiveNeverExpires() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 0, 0)

        assertArrayEquals(bytes(1), queue.claimHead(Long.MAX_VALUE / 2))
    }

    @Test
    fun aRefusedHeadThatExpiresIsDroppedOnItsRetry() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 50, 0)
        queue.claimHead(0)
        queue.refused()

        assertEquals(LinkWriteQueue.Next.SEND, queue.retryDue())
        assertNull(queue.claimHead(51))
        assertEquals(0, queue.waiting())
        assertEquals(LinkWriteQueue.Offer.SEND, queue.offer(bytes(2), 0, 51))
    }

    // ---- Bounds ----

    @Test
    fun theQueueIsBoundedByCount() {
        val queue = LinkWriteQueue(maxEntries = 3, maxBytes = 1_000)
        repeat(3) {
            assertEquals(
                if (it == 0) LinkWriteQueue.Offer.SEND else LinkWriteQueue.Offer.QUEUED,
                queue.offer(bytes(it), 0, 0),
            )
        }

        assertEquals(LinkWriteQueue.Offer.FULL, queue.offer(bytes(9), 0, 0))
        // The head is the caller's to hand over, so two are waiting.
        assertEquals(2, queue.waiting())
    }

    @Test
    fun theQueueIsBoundedByBytes() {
        val queue = LinkWriteQueue(maxEntries = 100, maxBytes = 1_000)
        queue.offer(bytes(1, 600), 0, 0)
        queue.claimHead(0)

        assertEquals(LinkWriteQueue.Offer.FULL, queue.offer(bytes(2, 401), 0, 0))
        assertEquals(LinkWriteQueue.Offer.QUEUED, queue.offer(bytes(3, 400), 0, 0))

        // The head's bytes come back once the radio is done with it.
        queue.completed(true)
        assertEquals(LinkWriteQueue.Offer.QUEUED, queue.offer(bytes(4, 600), 0, 0))
    }

    @Test
    fun expiredEntriesGiveTheirRoomBack() {
        val queue = LinkWriteQueue(maxEntries = 2, maxBytes = 1_000)
        queue.offer(bytes(1), 0, 0)
        queue.claimHead(0)
        queue.offer(bytes(2), 10, 0)
        assertEquals(LinkWriteQueue.Offer.FULL, queue.offer(bytes(3), 0, 0))

        queue.completed(true)
        assertNull(queue.claimHead(20))

        assertEquals(LinkWriteQueue.Offer.SEND, queue.offer(bytes(3), 0, 20))
    }

    // ---- Lost callbacks ----

    @Test
    fun aHeadWithNoCompletionIsLetGoAfterTheStallTimeout() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 0, 0)
        queue.claimHead(100)
        queue.offer(bytes(2), 0, 100)

        assertNull(queue.releaseStalled(100 + LinkWriteQueue.STALL_TIMEOUT_MS))
        assertEquals(
            LinkWriteQueue.Next.SEND,
            queue.releaseStalled(101 + LinkWriteQueue.STALL_TIMEOUT_MS),
        )
        // Taken as done, not sent again.
        assertArrayEquals(bytes(2), queue.claimHead(101 + LinkWriteQueue.STALL_TIMEOUT_MS))
        assertEquals(0, queue.waiting())
    }

    @Test
    fun aStalledHeadWithNothingBehindItLeavesTheLinkIdle() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 0, 0)
        queue.claimHead(0)
        val later = LinkWriteQueue.STALL_TIMEOUT_MS + 1

        assertEquals(LinkWriteQueue.Next.IDLE, queue.releaseStalled(later))
        assertEquals(LinkWriteQueue.Offer.SEND, queue.offer(bytes(2), 0, later))
    }

    @Test
    fun theStallClockStartsWhenTheHeadIsHandedOver() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 0, 0)
        queue.offer(bytes(2), 0, 0)
        queue.claimHead(0)
        val later = LinkWriteQueue.STALL_TIMEOUT_MS * 5

        // Released but not yet claimed: nothing is with the radio to stall.
        queue.completed(true)
        assertNull(queue.releaseStalled(later))

        queue.claimHead(later)
        assertNull(queue.releaseStalled(later + LinkWriteQueue.STALL_TIMEOUT_MS))
    }

    @Test
    fun aRefusedHeadWaitingForItsRetryIsNotStalled() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 0, 0)
        queue.claimHead(0)
        queue.refused()

        assertNull(queue.releaseStalled(LinkWriteQueue.STALL_TIMEOUT_MS * 5))
        assertEquals(LinkWriteQueue.Next.SEND, queue.retryDue())
        assertArrayEquals(bytes(1), queue.claimHead(LinkWriteQueue.STALL_TIMEOUT_MS * 5))
    }

    @Test
    fun aCompletedHeadIsNotStalled() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 0, 0)
        queue.claimHead(0)
        queue.completed(true)

        assertNull(queue.releaseStalled(LinkWriteQueue.STALL_TIMEOUT_MS * 5))
    }

    // ---- Disconnect ----

    @Test
    fun closingDiscardsEverythingAndRefusesMore() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 0, 0)
        queue.claimHead(0)
        queue.offer(bytes(2), 0, 0)

        queue.close()

        assertEquals(0, queue.waiting())
        assertNull(queue.claimHead(0))
        assertEquals(LinkWriteQueue.Offer.CLOSED, queue.offer(bytes(3), 0, 0))
    }

    @Test
    fun aLateCallbackOrRetryAfterCloseDoesNothing() {
        val queue = LinkWriteQueue()
        queue.offer(bytes(1), 0, 0)
        queue.claimHead(0)
        queue.refused()

        queue.close()

        assertEquals(LinkWriteQueue.Next.IDLE, queue.retryDue())
        assertEquals(LinkWriteQueue.Next.IDLE, queue.completed(true))
        assertEquals(LinkWriteQueue.Next.IDLE, queue.refused())
    }
}
