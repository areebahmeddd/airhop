// Which surfaces a stream key draws on.
//
// Every surface attached under a key gets that key's units, so one stream can
// show in its chat bubble and in the full-screen viewer at once, each with its
// own decoder; one leaving never takes the picture from another. Held weakly,
// since a view React drops without a detach must not be kept alive by its key.
package org.onemindlabs.airhop.video

import java.lang.ref.WeakReference

internal open class SurfaceRegistry<T : Any> {
    private val surfaces = HashMap<String, MutableList<WeakReference<T>>>()

    // Attaching twice, as a view does from its key and from its texture, keeps
    // one entry.
    @Synchronized
    fun attach(key: String, surface: T) {
        val list = surfaces.getOrPut(key) { ArrayList() }
        list.removeAll { it.get() == null }
        if (list.none { it.get() === surface }) list.add(WeakReference(surface))
    }

    @Synchronized
    fun detach(key: String, surface: T) {
        val list = surfaces[key] ?: return
        list.removeAll { it.get().let { held -> held == null || held === surface } }
        if (list.isEmpty()) surfaces.remove(key)
    }

    // A copy, so a caller can hand each one a unit outside the lock.
    @Synchronized fun all(key: String): List<T> = surfaces[key]?.mapNotNull { it.get() }.orEmpty()
}
