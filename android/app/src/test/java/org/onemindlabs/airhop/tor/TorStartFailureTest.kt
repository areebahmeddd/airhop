package org.onemindlabs.airhop.tor

import org.junit.Assert.assertEquals
import org.junit.Test

// The return codes are written out as native/arti/src/lib.rs defines them, so a
// renumbering there fails here rather than turning a refused bridge line back
// into a generic failure.
class TorStartFailureTest {
    @Test
    fun aRefusedBridgeLineNamesTheLines() {
        assertEquals(TorStartFailure.BRIDGE_LINES, TorStartFailure.codeFor(-7))
        assertEquals(TorStartFailure.BRIDGE_LINES, TorStartFailure.codeFor(-8))
    }

    @Test
    fun aTakenPortIsItsOwnFailure() {
        assertEquals(TorStartFailure.PORT_BUSY, TorStartFailure.codeFor(-5))
    }

    @Test
    fun everythingElseIsGeneric() {
        for (rc in listOf(-2, -3, -4, -6, -9, -100)) {
            assertEquals(TorStartFailure.OTHER, TorStartFailure.codeFor(rc))
        }
    }
}
