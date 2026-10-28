// AirhopForegroundService: keeps the BLE mesh alive when the app is backgrounded.
//
// Android aggressively terminates background processes to save battery. A
// foreground service with a persistent notification is the only reliable way to
// keep BluetoothLeScanner and BluetoothGattServer active while the app is not
// in the foreground.
//
// The service itself is intentionally thin - it only manages the notification
// and the service lifecycle. BLE logic remains in AirhopBLEModule.
package org.onemindlabs.airhop.service

import android.app.ForegroundServiceStartNotAllowedException
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.onemindlabs.airhop.MainActivity
import org.onemindlabs.airhop.R
import org.onemindlabs.airhop.ble.AirhopBLEModule

private const val TAG = "AirhopForegroundService"

private const val CHANNEL_ID = "airhop_mesh_bg"
private const val NOTIFICATION_ID = 1001

// Sent by the notification's "Stop mesh" button.
private const val ACTION_STOP = "org.onemindlabs.airhop.action.STOP_MESH"

class AirhopForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel(this)
        promoteToForeground()
    }

    // Android 14 requires the service type to be passed here, not just declared
    // in the manifest, and it must be one the app currently holds a permission
    // for. ServiceCompat handles the version split.
    //
    // The catch is not defensive padding: startForegroundService() can succeed
    // and this call still throw a moment later, when the app has slipped into
    // the background in between (Android 12+) or lost the Bluetooth permission
    // the connectedDevice type is granted against. That throw would take the
    // whole app down for something that is only ever an optimisation - the mesh
    // runs fine in the foreground either way - so it is caught and the service
    // simply stands down.
    private fun promoteToForeground() {
        try {
            val shown = reading
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                buildNotification(shown),
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                } else {
                    0
                },
            )
            synchronized(lock) {
                running = this
                hiddenAtPost = !NotificationManagerCompat.from(this).areNotificationsEnabled()
                // A count that arrived while this one was being posted. Posted
                // directly: Android lists a foreground notice as active only
                // after a moment, and one this new cannot have been swiped away.
                if (reading != shown) post()
            }
        } catch (e: Exception) {
            if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                    e is ForegroundServiceStartNotAllowedException
            ) {
                Log.w(TAG, "Not allowed to start in the foreground right now")
            } else {
                Log.w(TAG, "Foreground promotion failed: ${e.message}")
            }
            stopSelf()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // Hand the shutdown to JS when there is a JS to hand it to, so the
            // mesh comes down the same way the in-app Status picker brings it
            // down (radios, relays, presence). Its stopAdvertising() call ends
            // up back here and stops this service - but we stop unconditionally
            // anyway: the notification has to disappear the moment it is
            // tapped, whether or not anything answered.
            AirhopBLEModule.requestMeshStop()
            detach()
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        // NOT_STICKY on purpose. This service is only useful as a companion to
        // the running JS runtime: it holds the process up so BLE and the relay
        // socket survive backgrounding. If the OS kills the process, letting
        // Android resurrect the service alone would put a "mesh active"
        // notification on screen with no mesh behind it - which is exactly the
        // state that leaves force-stop as the only way out.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        detach()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        AirhopBLEModule.onBackgroundServiceStopped()
        super.onDestroy()
    }

    // A first launch starts the mesh before asking for notification
    // permission, and Android keeps a notice posted without it hidden even once
    // it is granted. Under lock, as are post() and repost().
    private var hiddenAtPost = false

    private fun post() {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification(reading))
    }

    // A notice the person swiped away (Android 14+) stays away. One hidden only
    // for want of permission is posted again once it is granted.
    private fun repost(changed: Boolean) {
        if (hiddenAtPost) {
            if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return
            hiddenAtPost = false
            post()
            return
        }
        if (!changed) return
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.activeNotifications.none { it.id == NOTIFICATION_ID }) return
        post()
    }

    // A notice posted after stopForeground would outlive the service, ongoing
    // with no mesh behind it, so no count may re-post past this.
    private fun detach() {
        synchronized(lock) { if (running === this) running = null }
    }

    // MARK: - Notification

    private fun buildNotification(shown: Reading): Notification {
        val launchIntent =
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
        val pendingIntent =
            PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )

        // An ongoing notification the user cannot dismiss needs a way out that
        // isn't force-stop. Without this the only exits are Settings or killing
        // the app, and neither is something a person should have to discover.
        val stopIntent =
            PendingIntent.getService(
                this,
                1,
                Intent(this, AirhopForegroundService::class.java).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.mesh_notification_title))
            .setContentText(peerLine(shown))
            // The same drawable the manifest points expo-notifications at, so
            // the notice sitting in the shade all day and a notice about a
            // message are recognisably one app.
            .setSmallIcon(R.drawable.notification_icon)
            .setColor(ContextCompat.getColor(this, R.color.notification_icon_color))
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(pendingIntent)
            .addAction(0, getString(R.string.mesh_notification_stop), stopIntent)
            .build()
    }

    // Zero keeps the default line, which is also what a start shows before the
    // first count, unless Bluetooth is off: then nobody is reachable because the
    // phone cannot listen, and the default "Discovering" would claim it can. A
    // count still wins, since peers over Wi-Fi or LAN are real. The widget draws
    // the same rule (MeshWidgetState.kt).
    private fun peerLine(shown: Reading): String =
        when {
            shown.count > 0 ->
                // A string argument keeps the digits Latin, as the app writes them.
                resources.getQuantityString(
                    R.plurals.mesh_notification_peers,
                    shown.count,
                    shown.count.toString(),
                )
            shown.bluetoothOff -> getString(R.string.mesh_bluetooth_off)
            else -> getString(R.string.mesh_notification_text)
        }

    // What the notice says, as JS last counted it.
    private data class Reading(val count: Int, val bluetoothOff: Boolean)

    companion object {
        private val lock = Any()
        private var running: AirhopForegroundService? = null
        @Volatile private var reading = Reading(0, false)

        // Re-posted under the same ID, which is how Android updates a foreground
        // notice.
        fun setReading(count: Int, bluetoothOff: Boolean) {
            synchronized(lock) {
                val next = Reading(count, bluetoothOff)
                val changed = next != reading
                reading = next
                running?.repost(changed)
            }
        }

        // Also before opening the channel's page, which needs it to exist.
        fun ensureChannel(context: Context) {
            val channel =
                NotificationChannel(
                        CHANNEL_ID,
                        context.getString(R.string.mesh_channel_name),
                        NotificationManager.IMPORTANCE_LOW, // silent but persistent
                    )
                    .apply {
                        description = context.getString(R.string.mesh_channel_description)
                        setShowBadge(false)
                    }
            context
                .getSystemService(NotificationManager::class.java)
                .createNotificationChannel(channel)
        }

        // Message alerts post on their own channels, so this page touches only
        // the notice. Some OEM builds lack it; the app's page stands in.
        fun openChannelSettings(context: Context) {
            ensureChannel(context)
            val channel =
                Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL_ID)
            try {
                context.startActivity(forApp(context, channel))
            } catch (e: ActivityNotFoundException) {
                context.startActivity(
                    forApp(context, Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS))
                )
            }
        }

        private fun forApp(context: Context, intent: Intent): Intent =
            intent
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        fun start(context: Context) {
            context.startForegroundService(Intent(context, AirhopForegroundService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, AirhopForegroundService::class.java))
        }
    }
}
