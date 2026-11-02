package org.onemindlabs.airhop.video

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SurfaceRegistryTest {
    private class Surface

    @Test
    fun everySurfaceUnderAKeyGetsItsUnits() {
        val registry = SurfaceRegistry<Surface>()
        val bubble = Surface()
        val viewer = Surface()
        registry.attach("peer:stream", bubble)
        registry.attach("peer:stream", viewer)

        assertEquals(listOf(bubble, viewer), registry.all("peer:stream"))
    }

    @Test
    fun attachingTwiceKeepsOneEntry() {
        // A view attaches from its key and again once its texture is ready.
        val registry = SurfaceRegistry<Surface>()
        val bubble = Surface()
        registry.attach("peer:stream", bubble)
        registry.attach("peer:stream", bubble)

        assertEquals(listOf(bubble), registry.all("peer:stream"))
    }

    @Test
    fun theViewerLeavingLeavesTheBubblePlaying() {
        val registry = SurfaceRegistry<Surface>()
        val bubble = Surface()
        val viewer = Surface()
        registry.attach("peer:stream", bubble)
        registry.attach("peer:stream", viewer)
        registry.detach("peer:stream", viewer)

        assertEquals(listOf(bubble), registry.all("peer:stream"))
    }

    @Test
    fun theBubbleLeavingFirstLeavesTheViewerPlaying() {
        // A list can recycle the bubble while the viewer is still open.
        val registry = SurfaceRegistry<Surface>()
        val bubble = Surface()
        val viewer = Surface()
        registry.attach("peer:stream", bubble)
        registry.attach("peer:stream", viewer)
        registry.detach("peer:stream", bubble)

        assertEquals(listOf(viewer), registry.all("peer:stream"))
    }

    @Test
    fun aSurfaceThatComesBackIsAttachedAgain() {
        val registry = SurfaceRegistry<Surface>()
        val bubble = Surface()
        registry.attach("peer:stream", bubble)
        registry.detach("peer:stream", bubble)
        registry.attach("peer:stream", bubble)

        assertEquals(listOf(bubble), registry.all("peer:stream"))
    }

    @Test
    fun detachingASurfaceNeverAttachedChangesNothing() {
        val registry = SurfaceRegistry<Surface>()
        val bubble = Surface()
        registry.attach("peer:stream", bubble)
        registry.detach("peer:stream", Surface())
        registry.detach("peer:other", bubble)

        assertEquals(listOf(bubble), registry.all("peer:stream"))
    }

    @Test
    fun keysAreIndependent() {
        val registry = SurfaceRegistry<Surface>()
        val first = Surface()
        val second = Surface()
        registry.attach("peer:one", first)
        registry.attach("peer:two", second)
        registry.detach("peer:one", first)

        assertTrue(registry.all("peer:one").isEmpty())
        assertEquals(listOf(second), registry.all("peer:two"))
    }
}
