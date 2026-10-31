// AirhopMeshWidget: the home screen widget. How many peers are in range, and
// as of when, so the mesh can be seen to be alive without opening the app.
//
// It counts nothing itself. background-notice.ts pushes a snapshot through
// AirhopAppModule, the same push that feeds the background notice, so the two
// and the Mesh tab cannot disagree. The snapshot lives in SharedPreferences
// because the provider is also woken with no process behind it: when a reading
// turns stale (an alarm each draw sets), every 30 minutes (updatePeriodMillis),
// after a boot, and on a clock, zone or language change.
//
// RemoteViews only, no Glance or Compose: one small layout needs no new
// dependency.
package org.onemindlabs.airhop.widget

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.icu.text.DateFormat
import android.icu.util.ULocale
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import java.util.Date
import org.onemindlabs.airhop.MainActivity
import org.onemindlabs.airhop.R

private const val TAG = "AirhopMeshWidget"

// Excluded from backup and device transfer with every other preference file
// (data_extraction_rules.xml), and cleared by the panic wipe.
private const val PREFS_NAME = "airhop_mesh_widget"
private const val KEY_COUNT = "count"
private const val KEY_MESH_ON = "mesh_on"
private const val KEY_BLUETOOTH_OFF = "bluetooth_off"
private const val KEY_AT_MS = "at_ms"

// app.tsx answers it by switching to the Mesh tab, the screen this summarises.
private const val MESH_LINK = "airhop://mesh"

// Sent only to this provider, by the alarm `scheduleStale` sets.
private const val ACTION_STALE = "org.onemindlabs.airhop.widget.STALE"

class AirhopMeshWidget : AppWidgetProvider() {

    // The broadcast's own IDs are ignored: the receiver is exported, as a
    // widget provider must be, and only the IDs bound to this provider are ours.
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        redrawQuietly(context)
    }

    // All three are system-only broadcasts still delivered to manifest
    // receivers from API 26. A zone or 12/24-hour change makes the shown time
    // wrong, a clock change can make the reading stale, and a language change
    // leaves the lines in the old one.
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED,
            Intent.ACTION_LOCALE_CHANGED,
            ACTION_STALE -> redrawQuietly(context)
            else -> super.onReceive(context, intent)
        }
    }

    companion object {
        // apply(), not commit(): JS re-sends every minute, and a write lost to
        // a kill is replaced by the next.
        internal fun publish(context: Context, snapshot: MeshSnapshot) {
            prefs(context)
                .edit()
                .putInt(KEY_COUNT, snapshot.count)
                .putBoolean(KEY_MESH_ON, snapshot.meshOn)
                .putBoolean(KEY_BLUETOOTH_OFF, snapshot.bluetoothOff)
                .putLong(KEY_AT_MS, snapshot.atMs)
                .apply()
            redraw(context)
        }

        // commit(): a wipe that a kill could undo would put the count back.
        internal fun clear(context: Context) {
            prefs(context).edit().clear().commit()
            redraw(context)
        }

        private fun prefs(context: Context) =
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        // A value of the wrong type (a file from some other build, or damaged)
        // reads as no snapshot, which draws "Open Airhop" and is replaced by the
        // next push.
        private fun read(context: Context): MeshSnapshot? {
            val prefs = prefs(context)
            if (!prefs.contains(KEY_AT_MS)) return null
            return try {
                MeshSnapshot.of(
                    prefs.getInt(KEY_COUNT, -1),
                    prefs.getBoolean(KEY_MESH_ON, false),
                    prefs.getBoolean(KEY_BLUETOOTH_OFF, false),
                    prefs.getLong(KEY_AT_MS, 0),
                )
            } catch (e: ClassCastException) {
                null
            }
        }

        // The broadcasts land with no caller to report to, and a throw there
        // takes the whole process down, mesh included, for a widget.
        private fun redrawQuietly(context: Context) {
            try {
                redraw(context)
            } catch (e: RuntimeException) {
                Log.w(TAG, "Widget not redrawn: ${e.message}")
            }
        }

        private fun redraw(context: Context) {
            // Null on a build of Android without widgets.
            val manager = AppWidgetManager.getInstance(context) ?: return
            val ids = manager.getAppWidgetIds(ComponentName(context, AirhopMeshWidget::class.java))
            if (ids.isEmpty()) return

            val nowMs = System.currentTimeMillis()
            val snapshot = read(context)
            val state = meshWidgetState(snapshot, nowMs, nowMs - SystemClock.elapsedRealtime())
            val lines = meshWidgetLines(state, ResourceCopy(context))
            scheduleStale(context, meshWidgetStaleAtMs(snapshot, state))

            // With no count the caption is the whole message, which the layout
            // draws larger and in ink, in a view of its own.
            val counted = lines.count != null
            val views = RemoteViews(context.packageName, R.layout.mesh_widget)
            views.setLine(R.id.mesh_widget_count, lines.count)
            views.setLine(R.id.mesh_widget_as_of, lines.asOf)
            views.setLine(R.id.mesh_widget_caption, lines.caption.takeIf { counted })
            views.setLine(R.id.mesh_widget_message, lines.caption.takeUnless { counted })
            views.setOnClickPendingIntent(android.R.id.background, openMesh(context))
            manager.updateAppWidget(ids, views)
        }

        // Redraws when the reading on screen turns stale, which a killed
        // process would otherwise leave up until the 30-minute update. Inexact
        // and not a wakeup: it needs no exact-alarm permission, and lands by the
        // time the screen is on to show it. One alarm, replaced by every draw and
        // cancelled once nothing on screen can age.
        private fun scheduleStale(context: Context, atMs: Long?) {
            val alarms = context.getSystemService(AlarmManager::class.java) ?: return
            val pending =
                PendingIntent.getBroadcast(
                    context,
                    0,
                    Intent(context, AirhopMeshWidget::class.java).setAction(ACTION_STALE),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
            if (atMs == null) alarms.cancel(pending)
            else alarms.set(AlarmManager.RTC, atMs, pending)
        }

        private fun RemoteViews.setLine(id: Int, text: String?) {
            if (text == null) {
                setViewVisibility(id, View.GONE)
            } else {
                setTextViewText(id, text)
                setViewVisibility(id, View.VISIBLE)
            }
        }

        // Immutable, as API 31 requires. NEW_TASK because a widget launches from
        // outside any activity; MainActivity is singleTask, so a running app
        // takes the link through onNewIntent.
        private fun openMesh(context: Context): PendingIntent =
            PendingIntent.getActivity(
                context,
                0,
                Intent(Intent.ACTION_VIEW, Uri.parse(MESH_LINK), context, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
    }
}

// Resolved against the process's locale, as the notice is: the system
// language, or the per-app one Android 13 sets, never the in-app picker.
private class ResourceCopy(private val context: Context) : MeshWidgetCopy {
    private val resources = context.resources

    override fun asOf(atMs: Long): String = resources.getString(R.string.widget_as_of, time(atMs))

    // ICU rather than java.text, for two reasons. The numbers keyword keeps
    // the digits Latin, as the app writes them, where Arabic, Persian, Bengali,
    // Burmese and Nepali default to their own. And a locale's best pattern can
    // use a field java.text predates, such as zh-Hant's day period in "Bh:mm".
    private fun time(atMs: Long): String {
        val skeleton = if (android.text.format.DateFormat.is24HourFormat(context)) "Hm" else "hm"
        val locale =
            ULocale.forLocale(resources.configuration.locales[0]).setKeywordValue("numbers", "latn")
        return DateFormat.getInstanceForSkeleton(skeleton, locale).format(Date(atMs))
    }

    // The count picks the form and is drawn on its own line above, so it is
    // not passed as an argument.
    override fun inRange(count: Int): String =
        resources.getQuantityString(R.plurals.widget_in_range, count)

    override fun nobody(): String = resources.getString(R.string.widget_nobody)

    override fun paused(): String = resources.getString(R.string.widget_paused)

    override fun unset(): String = resources.getString(R.string.widget_unset)

    override fun stale(): String = resources.getString(R.string.widget_stale)

    // The notice's line for the same state, so the two read alike.
    override fun bluetoothOff(): String = resources.getString(R.string.mesh_bluetooth_off)
}
