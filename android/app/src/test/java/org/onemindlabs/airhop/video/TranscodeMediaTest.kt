package org.onemindlabs.airhop.video

import androidx.media3.common.Metadata
import androidx.media3.container.Mp4LocationData
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscodeMediaTest {
    @Test
    fun aQuarterTurnSwapsTheUprightSize() {
        assertEquals(1080 to 1920, TranscodeMedia.uprightSize(1920, 1080, 90))
        assertEquals(1080 to 1920, TranscodeMedia.uprightSize(1920, 1080, 270))
        assertEquals(1080 to 1920, TranscodeMedia.uprightSize(1920, 1080, -90))
    }

    @Test
    fun aHalfTurnKeepsIt() {
        assertEquals(1920 to 1080, TranscodeMedia.uprightSize(1920, 1080, 0))
        assertEquals(1920 to 1080, TranscodeMedia.uprightSize(1920, 1080, 180))
    }

    @Test
    fun theSourceLocationNeverReachesTheMuxer() {
        val entries: MutableSet<Metadata.Entry> = linkedSetOf(Mp4LocationData(48.8577f, 2.2950f))

        TranscodeMedia.stripSourceMetadata.updateMetadataEntries(entries)

        assertTrue(entries.isEmpty())
    }
}
