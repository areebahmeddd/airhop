package org.onemindlabs.airhop.widget

import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MeshWidgetStateTest {
    private val now = 1_800_000_000_000L
    private val boot = now - 3_600_000L

    private fun state(snapshot: MeshSnapshot?, bootMs: Long = boot) =
        meshWidgetState(snapshot, now, bootMs)

    private fun snap(
        count: Int,
        atMs: Long,
        meshOn: Boolean = true,
        bluetoothOff: Boolean = false,
    ) = MeshSnapshot(count, meshOn, bluetoothOff, atMs)

    // Each line names its inputs, so a test reads which branch drew it.
    private val copy =
        object : MeshWidgetCopy {
            override fun asOf(atMs: Long) = "asOf $atMs"

            override fun inRange(count: Int) = "inRange($count)"

            override fun nobody() = "nobody"

            override fun paused() = "paused"

            override fun unset() = "unset"

            override fun stale() = "stale"

            override fun bluetoothOff() = "bluetoothOff"
        }

    // ---- The snapshot ----

    @Test
    fun aSnapshotTheAppCannotHaveWrittenIsNone() {
        assertNull(MeshSnapshot.of(-1, true, false, now))
        assertNull(MeshSnapshot.of(3, true, false, 0))
        assertNull(MeshSnapshot.of(3, true, false, -5))
        assertEquals(
            snap(0, now, meshOn = false, bluetoothOff = true),
            MeshSnapshot.of(0, false, true, now),
        )
    }

    // ---- Which state ----

    @Test
    fun nothingWrittenAsksForTheApp() {
        assertEquals(MeshWidgetState.Unset, state(null))
    }

    @Test
    fun aFreshReadingIsShownWithItsTime() {
        assertEquals(MeshWidgetState.Counted(4, now), state(snap(4, now)))
        assertEquals(MeshWidgetState.Counted(0, now), state(snap(0, now)))
    }

    @Test
    fun aReadingAgesOutAtFifteenMinutes() {
        val at = now - STALE_AFTER_MS
        assertEquals(MeshWidgetState.Counted(2, at), state(snap(2, at)))
        assertEquals(MeshWidgetState.Stale, state(snap(2, at - 1)))
    }

    @Test
    fun aReadingFromTheFutureMeansTheClockMovedAndIsNotShown() {
        assertEquals(MeshWidgetState.Stale, state(snap(2, now + 1)))
    }

    @Test
    fun aReadingFromBeforeThisBootIsNotShownHoweverRecent() {
        // Rebooted a minute after the last push: young, but no mesh survived it.
        val at = now - 60_000L
        assertEquals(MeshWidgetState.Stale, state(snap(5, at), bootMs = at + 1))
        assertEquals(MeshWidgetState.Counted(5, at), state(snap(5, at), bootMs = at))
    }

    @Test
    fun pausedOutranksAgeAndBoot() {
        // A paused mesh stays paused across a kill or a reboot, so the line
        // stays true when the reading is old.
        val old = boot - STALE_AFTER_MS * 10
        assertEquals(MeshWidgetState.Paused, state(snap(7, old, meshOn = false)))
        assertEquals(MeshWidgetState.Paused, state(snap(7, now + 1, meshOn = false)))
    }

    @Test
    fun bluetoothOffWithNobodyReachableSaysSoRatherThanAnEmptyRoom() {
        assertEquals(MeshWidgetState.BluetoothOff, state(snap(0, now, bluetoothOff = true)))
    }

    @Test
    fun peersStillReachableWithBluetoothOffAreACount() {
        // Over Wi-Fi or LAN: a true count, so it wins over the radio's state.
        assertEquals(
            MeshWidgetState.Counted(2, now),
            state(snap(2, now, bluetoothOff = true)),
        )
    }

    @Test
    fun bluetoothOffAgesOutAndGivesWayToPaused() {
        // A reading of the radio, as old as any other.
        val old = now - STALE_AFTER_MS - 1
        assertEquals(MeshWidgetState.Stale, state(snap(0, old, bluetoothOff = true)))
        assertEquals(MeshWidgetState.Stale, state(snap(0, boot - 1, bluetoothOff = true)))
        assertEquals(
            MeshWidgetState.Paused,
            state(snap(0, now, meshOn = false, bluetoothOff = true)),
        )
    }

    @Test
    fun aReadingTurnsStaleJustPastItsCutoffAndTheRestHold() {
        val reading = snap(3, now)
        assertEquals(now + STALE_AFTER_MS + 1, meshWidgetStaleAtMs(reading, state(reading)))
        val off = snap(0, now, bluetoothOff = true)
        assertEquals(now + STALE_AFTER_MS + 1, meshWidgetStaleAtMs(off, state(off)))
        // The redraw it schedules really is stale.
        assertEquals(
            MeshWidgetState.Stale,
            meshWidgetState(reading, now + STALE_AFTER_MS + 1, boot),
        )

        val paused = snap(3, now, meshOn = false)
        assertNull(meshWidgetStaleAtMs(paused, state(paused)))
        assertNull(meshWidgetStaleAtMs(null, MeshWidgetState.Unset))
        val stale = snap(3, now - STALE_AFTER_MS - 1)
        assertNull(meshWidgetStaleAtMs(stale, state(stale)))
    }

    // ---- What it draws ----

    @Test
    fun aCountIsNeverDrawnWithoutItsTime() {
        val snapshots =
            listOf(
                null,
                snap(3, now),
                snap(0, now),
                snap(3, now, meshOn = false),
                snap(3, now - STALE_AFTER_MS - 1),
                snap(3, boot - 1),
                snap(3, now + 1),
                snap(0, now, bluetoothOff = true),
                snap(4, now, bluetoothOff = true),
            )
        for (snapshot in snapshots) {
            val lines = meshWidgetLines(state(snapshot), copy)
            assertEquals(snapshot.toString(), lines.count == null, lines.asOf == null)
            if (lines.asOf != null) assertEquals("asOf ${snapshot!!.atMs}", lines.asOf)
        }
    }

    @Test
    fun eachStateDrawsItsOwnLines() {
        assertEquals(
            MeshWidgetLines("3", "inRange(3)", "asOf $now"),
            meshWidgetLines(MeshWidgetState.Counted(3, now), copy),
        )
        assertEquals(
            MeshWidgetLines("0", "nobody", "asOf $now"),
            meshWidgetLines(MeshWidgetState.Counted(0, now), copy),
        )
        assertEquals(
            MeshWidgetLines(null, "paused", null),
            meshWidgetLines(MeshWidgetState.Paused, copy),
        )
        assertEquals(
            MeshWidgetLines(null, "unset", null),
            meshWidgetLines(MeshWidgetState.Unset, copy),
        )
        assertEquals(
            MeshWidgetLines(null, "stale", null),
            meshWidgetLines(MeshWidgetState.Stale, copy),
        )
        assertEquals(
            MeshWidgetLines(null, "bluetoothOff", null),
            meshWidgetLines(MeshWidgetState.BluetoothOff, copy),
        )
    }

    @Test
    fun theCountIsWrittenInLatinDigitsWhateverTheLocale() {
        // The plural line takes the count to pick its form; the number itself is
        // drawn as the app writes it, under a locale with digits of its own too.
        val before = Locale.getDefault()
        try {
            for (tag in listOf("ar-EG", "fa-IR", "my-MM", "ne-NP", "bn-BD")) {
                Locale.setDefault(Locale.forLanguageTag(tag))
                val lines = meshWidgetLines(MeshWidgetState.Counted(123, now), copy)
                assertEquals(tag, "123", lines.count)
                assertEquals(tag, "inRange(123)", lines.caption)
            }
        } finally {
            Locale.setDefault(before)
        }
    }
}
