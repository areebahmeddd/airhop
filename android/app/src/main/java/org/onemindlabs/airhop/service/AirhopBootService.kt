// Gets the JS runtime up after a reboot and hands off to the
// "Airhop.BootStartMesh" headless task (src/services/boot-start.ts), which
// loads the identity, checks permissions and starts the mesh.
//
// A HeadlessJsTaskService because Android 8+ refuses a background-started
// service with no foreground promotion, and a fresh process after a reboot
// has neither JS nor AirhopForegroundService running yet to provide one.
package org.onemindlabs.airhop.service

import android.app.ForegroundServiceStartNotAllowedException
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import org.onemindlabs.airhop.MainActivity
import org.onemindlabs.airhop.R

private const val TAG = "AirhopBootService"

// Same channel, title and text as AirhopForegroundService, but a different
// id: NotificationManager keys a posted notification by (package, id) with
// no notion of which service posted it, so sharing 1001 would let this
// service's own stop cancel a notification AirhopForegroundService has
// already taken over.
private const val CHANNEL_ID = "airhop_mesh_bg"
private const val NOTIFICATION_ID = 1002

class AirhopBootService : HeadlessJsTaskService() {

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        promoteToForeground()
    }

    private fun promoteToForeground() {
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                buildNotification(),
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                } else {
                    0
                },
            )
        } catch (e: Exception) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                e is ForegroundServiceStartNotAllowedException
            ) {
                Log.w(TAG, "Not allowed to start in the foreground right now")
            } else {
                Log.w(TAG, "Foreground promotion failed: ${e.message}")
            }
            stopSelf()
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.mesh_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = getString(R.string.mesh_channel_description)
                setShowBadge(false)
            }
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    // No "Stop mesh" action here, unlike AirhopForegroundService's: tapping
    // it before the mesh exists would have nothing to stop.
    private fun buildNotification(): Notification {
        val launchIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.mesh_notification_title))
            .setContentText(getString(R.string.mesh_notification_text))
            .setSmallIcon(R.drawable.notification_icon)
            .setColor(ContextCompat.getColor(this, R.color.notification_icon_color))
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(pendingIntent)
            .build()
    }

    // Timeout guards a JS bundle that never finishes loading.
    // isAllowedInForeground: the user may open the app while this runs.
    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig {
        return HeadlessJsTaskConfig(
            "Airhop.BootStartMesh",
            Arguments.createMap(),
            20_000L,
            true,
        )
    }

    companion object {
        fun start(context: Context) {
            // Qualified: a subclass companion object does not inherit the
            // parent's, even for a @JvmStatic member.
            HeadlessJsTaskService.acquireWakeLockNow(context)
            ContextCompat.startForegroundService(
                context,
                Intent(context, AirhopBootService::class.java),
            )
        }
    }
}
