// What the home screen widget shows, decided from the app's last snapshot.
//
// Pure on purpose: the provider can run with the process freshly started and no
// JS behind it, so the one decision native makes on its own, whether a reading
// is still worth showing, lives here where the JVM tests reach it. Everything
// else (what to count, when to push) is background-notice.ts.
package org.onemindlabs.airhop.widget

// The whole of what the app writes: a count, whether the mesh is meant to be
// running, whether Bluetooth is switched off, and when it was counted. No names,
// IDs or unread counts, because the widget sits on a home screen anyone holding
// the phone can read.
internal data class MeshSnapshot(
    val count: Int,
    val meshOn: Boolean,
    val bluetoothOff: Boolean,
    val atMs: Long,
) {
    companion object {
        // Null for anything the app cannot have written, so a bad value reads
        // as no snapshot rather than as a number.
        fun of(count: Int, meshOn: Boolean, bluetoothOff: Boolean, atMs: Long): MeshSnapshot? =
            if (count < 0 || atMs <= 0) null else MeshSnapshot(count, meshOn, bluetoothOff, atMs)
    }
}

// JS re-sends an unchanged reading every minute while the process lives, so a
// reading this old means nothing is counting any more, most often because the
// OS killed the process.
internal const val STALE_AFTER_MS = 15 * 60_000L

internal sealed interface MeshWidgetState {
    // Never written, or wiped.
    data object Unset : MeshWidgetState

    data object Paused : MeshWidgetState

    data object Stale : MeshWidgetState

    // Nobody reachable because the phone cannot listen, which "nobody in range"
    // would misreport as an empty room.
    data object BluetoothOff : MeshWidgetState

    // Zero included: "nobody in range" is a reading too, and carries its time.
    data class Counted(val count: Int, val atMs: Long) : MeshWidgetState
}

// `bootMs` is when this boot began on the wall clock. A count from before it
// came from a mesh that cannot still be running, whatever its age.
//
// Paused outranks age: a paused mesh stays paused across a kill or a reboot,
// so that line stays true. A reading from the future means the clock moved
// back, and its time cannot be trusted either. Bluetooth off ages like a count,
// since it is a reading too, and gives way to one: peers still reachable over
// Wi-Fi or LAN are a true count worth showing.
internal fun meshWidgetState(snapshot: MeshSnapshot?, nowMs: Long, bootMs: Long): MeshWidgetState {
    if (snapshot == null) return MeshWidgetState.Unset
    if (!snapshot.meshOn) return MeshWidgetState.Paused
    val age = nowMs - snapshot.atMs
    if (age < 0 || age > STALE_AFTER_MS || snapshot.atMs < bootMs) return MeshWidgetState.Stale
    if (snapshot.bluetoothOff && snapshot.count == 0) return MeshWidgetState.BluetoothOff
    return MeshWidgetState.Counted(snapshot.count, snapshot.atMs)
}

// The widget's resources, behind an interface so the tests need no Android.
internal interface MeshWidgetCopy {
    // "as of 14:05", for the reading taken at atMs.
    fun asOf(atMs: Long): String

    fun inRange(count: Int): String

    fun nobody(): String

    fun paused(): String

    fun unset(): String

    fun stale(): String

    fun bluetoothOff(): String
}

// `count` and `asOf` are both set or both null, so no layout can show a count
// without its time. The time has a line of its own rather than a place in the
// caption, where a long translation would ellipsize it away.
internal data class MeshWidgetLines(val count: String?, val caption: String, val asOf: String?)

internal fun meshWidgetLines(state: MeshWidgetState, copy: MeshWidgetCopy): MeshWidgetLines =
    when (state) {
        MeshWidgetState.Unset -> MeshWidgetLines(null, copy.unset(), null)
        MeshWidgetState.Paused -> MeshWidgetLines(null, copy.paused(), null)
        MeshWidgetState.Stale -> MeshWidgetLines(null, copy.stale(), null)
        MeshWidgetState.BluetoothOff -> MeshWidgetLines(null, copy.bluetoothOff(), null)
        is MeshWidgetState.Counted ->
            MeshWidgetLines(
                // toString, not a locale format: the app writes Latin digits in
                // every language, and the notice beside this does the same.
                state.count.toString(),
                if (state.count == 0) copy.nobody() else copy.inRange(state.count),
                copy.asOf(state.atMs),
            )
    }
