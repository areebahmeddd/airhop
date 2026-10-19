package org.onemindlabs.airhop.tor

import org.junit.Assert.assertEquals
import org.junit.Test

// The words are the layout packed_status writes in native/arti/src/lib.rs,
// written out rather than rebuilt from the constants, so a bit moved on either
// side of the FFI fails here or in the Rust test that pins the same words.
class ArtiStatusTest {
    @Test
    fun aBootstrappedClientDecodesAsReady() {
        assertEquals(
            ArtiStatus(
                running = true,
                ready = true,
                blocked = false,
                progress = 100,
                bridged = false,
            ),
            ArtiStatus.decode(0x6403),
        )
    }

    @Test
    fun aBlockedBridgedStartKeepsItsProgress() {
        assertEquals(
            ArtiStatus(
                running = true,
                ready = false,
                blocked = true,
                progress = 30,
                bridged = true,
            ),
            ArtiStatus.decode(0x1E0D),
        )
    }
}
