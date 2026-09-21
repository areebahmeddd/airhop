// AirhopAppModule: process-level operations that belong to no radio.
//
// Four of them, each here because only this process can do it. Restart, since
// layout direction moves only on a fresh process and a warm start recreates
// the Activity under a surviving JS context. Recent log, since Android lets a
// process read its own logcat lines and nobody else's. APK copy, since sharing
// the app to a phone without it means handing over the install file itself.
// Ring alert, since a notification sounds once and from Android 15 repeated
// ones from the same app get quieter, while the foreground service already
// holds the process up for a ringtone and vibration loop the way the telecom
// stack rings a call.
//
// Policy stays in TypeScript: this file decides nothing about when to ring or
// for how long, only honours ringer mode and Do Not Disturb, and stops when
// JS says so or the duration runs out. Mirrors AirhopAppModule.swift, which
// rejects everything but the log.
package org.onemindlabs.airhop.app

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader

private const val TAG = "AirhopAppModule"

// Mirrors settings-store's autoStartOnBoot. AirhopBootReceiver reads this
// with no JS runtime up, so SharedPreferences instead of MMKV.
private const val BOOT_PREFS_NAME = "airhop_boot_prefs"
private const val KEY_AUTO_START = "auto_start_on_boot"

// Only the tags this app writes, plus the crash reporter. An allowlist rather
// than the whole process log, which React Native fills freely; none of these
// tags ever print message content, nicknames or keys.
private val LOG_TAGS =
    listOf(
        "AirhopBLEModule",
        "AirhopWiFiModule",
        "AirhopLANModule",
        "AirhopTorModule",
        "AirhopIPtProxy",
        "AirhopVoiceModule",
        "AirhopForegroundService",
        "AirhopAppModule",
        "AndroidRuntime",
    )

// Lines, not time. A busy mesh writes a lot and a quiet one very little, and a
// cap by count bounds the bundle either way.
private const val LOG_MAX_LINES = 3000

// Cache subdirectory the OS may reclaim, same as the update download.
private const val APK_SHARE_DIR = "apk-share"
private const val APK_SHARE_FILE = "Airhop.apk"

// Buzz, pause, buzz, pause, buzz, rest; repeated from index 0. The same
// triple the ring notification channel uses, so the two read as one signal.
private val RING_VIBRATION = longArrayOf(0, 400, 200, 400, 200, 400, 1200)

// Never loop for longer than this whatever JS asked, so a lost stop (a JS
// reload mid-ring) cannot leave a phone ringing.
private const val RING_MAX_MS = 60_000L

class AirhopAppModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "AirhopApp"

    // Ring state lives on the main thread, where MediaPlayer callbacks and the
    // stop timer both land, so no lock is needed.
    private val main = Handler(Looper.getMainLooper())
    private var ringPlayer: MediaPlayer? = null
    private var ringVibrator: Vibrator? = null
    private val ringStop = Runnable { stopRingOnMain() }

    override fun invalidate() {
        main.post { stopRingOnMain() }
        super.invalidate()
    }

    // Relaunch into a fresh process. `makeRestartActivityTask` is the platform's
    // own answer: the launcher activity as the base of a cleared task, flags
    // included. The exit is what makes the next start cold rather than warm.
    //
    // Foreground only, a platform rule from API 29. Nothing is flushed first:
    // every store writes to MMKV as it is set.
    @ReactMethod
    fun restart(promise: Promise) {
        val context = reactContext.applicationContext
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val component = launch?.component
        if (component == null) {
            // Nothing to relaunch. The caller falls back to asking the user.
            Log.e(TAG, "No launch component for ${context.packageName}")
            promise.reject("NO_LAUNCH_INTENT", "This build has no launcher activity")
            return
        }
        try {
            context.startActivity(Intent.makeRestartActivityTask(component))
        } catch (e: Exception) {
            Log.e(TAG, "Restart refused: ${e.message}")
            promise.reject("RESTART_FAILED", e.message, e)
            return
        }
        // Settled before the exit, so an awaiting caller is never left hanging.
        promise.resolve(null)
        Runtime.getRuntime().exit(0)
    }

    // Fire-and-forget: `.apply()` writes async, so a write that loses a
    // race with a reboot just leaves the old value in effect, not a bad one.
    @ReactMethod
    fun setAutoStartOnBoot(enabled: Boolean, promise: Promise) {
        reactContext.applicationContext
            .getSharedPreferences(BOOT_PREFS_NAME, android.content.Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_AUTO_START, enabled)
            .apply()
        promise.resolve(null)
    }

    // Copies this build's own APK into the cache and hands back a file:// URI
    // for Sharing.shareAsync. Off the calling thread: base.apk runs tens of MiB.
    //
    // publicSourceDir, not sourceDir: the one guaranteed readable outside this
    // process. Refuses on splitSourceDirs (a Play bundle install, one APK per
    // ABI/density/language) rather than share a base.apk missing real chunks
    // of the app.
    @ReactMethod
    fun copyApkToCache(promise: Promise) {
        Thread {
            try {
                val appInfo = reactContext.applicationContext.applicationInfo
                if (!appInfo.splitSourceDirs.isNullOrEmpty()) {
                    promise.reject(
                        "SPLIT_INSTALL",
                        "This install has more than one package part",
                    )
                    return@Thread
                }
                val shareDir = File(reactContext.cacheDir, APK_SHARE_DIR).apply { mkdirs() }
                val dest = File(shareDir, APK_SHARE_FILE)
                File(appInfo.publicSourceDir).copyTo(dest, overwrite = true)
                promise.resolve(Uri.fromFile(dest).toString())
            } catch (e: Exception) {
                Log.e(TAG, "APK copy failed: ${e.message}")
                promise.reject("COPY_FAILED", e.message, e)
            }
        }
            .start()
    }

    // Resolves true when anything audible or tactile started, false when the
    // phone is set to stay quiet, so JS can fall back to haptics. Starting
    // again while ringing restarts the clock rather than stacking a player.
    @ReactMethod
    fun startRingAlert(durationMs: Double, promise: Promise) {
        main.post {
            stopRingOnMain()
            val context = reactContext.applicationContext
            val notifications = context.getSystemService(NotificationManager::class.java)
            val filter =
                notifications?.currentInterruptionFilter
                    ?: NotificationManager.INTERRUPTION_FILTER_ALL
            // Anything narrower than "all" is a Do Not Disturb of some shape;
            // the ring channel declares bypassDnd false, and so does this.
            if (
                filter != NotificationManager.INTERRUPTION_FILTER_ALL &&
                    filter != NotificationManager.INTERRUPTION_FILTER_UNKNOWN
            ) {
                promise.resolve(false)
                return@post
            }
            val audio = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            val ringerMode = audio?.ringerMode ?: AudioManager.RINGER_MODE_NORMAL
            var started = false
            if (ringerMode == AudioManager.RINGER_MODE_NORMAL) {
                started = startRingtone(context)
            }
            if (ringerMode != AudioManager.RINGER_MODE_SILENT) {
                started = startVibration(context) || started
            }
            if (started) {
                val ms = durationMs.toLong().coerceIn(1L, RING_MAX_MS)
                main.postDelayed(ringStop, ms)
            }
            promise.resolve(started)
        }
    }

    @ReactMethod
    fun stopRingAlert(promise: Promise) {
        main.post {
            stopRingOnMain()
            promise.resolve(null)
        }
    }

    // The default ringtone, looping. A device with no ringtone set (a tablet)
    // gets the notification sound; one with neither reports false.
    private fun startRingtone(context: Context): Boolean {
        val uri =
            RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getActualDefaultRingtoneUri(
                    context,
                    RingtoneManager.TYPE_NOTIFICATION,
                )
                ?: return false
        return try {
            val player =
                MediaPlayer().apply {
                    setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build()
                    )
                    setDataSource(context, uri)
                    isLooping = true
                    prepare()
                    start()
                }
            ringPlayer = player
            true
        } catch (e: Exception) {
            Log.w(TAG, "Ringtone unavailable: ${e.message}")
            false
        }
    }

    private fun startVibration(context: Context): Boolean {
        val vibrator =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)
                    ?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }
        if (vibrator == null || !vibrator.hasVibrator()) return false
        return try {
            vibrator.vibrate(VibrationEffect.createWaveform(RING_VIBRATION, 0))
            ringVibrator = vibrator
            true
        } catch (e: Exception) {
            Log.w(TAG, "Vibration unavailable: ${e.message}")
            false
        }
    }

    private fun stopRingOnMain() {
        main.removeCallbacks(ringStop)
        ringPlayer?.let {
            try {
                if (it.isPlaying) it.stop()
            } catch (_: Exception) {
                // Already stopped or never prepared; release regardless.
            }
            it.release()
        }
        ringPlayer = null
        ringVibrator?.cancel()
        ringVibrator = null
    }

    // The process's recent logcat, filtered to LOG_TAGS, oldest first.
    //
    // `-d` dumps and exits rather than following, and `-t` bounds it. The
    // `*:S` at the end silences every tag not listed, which is what makes the
    // allowlist an allowlist rather than a highlight.
    @ReactMethod
    fun recentLog(promise: Promise) {
        Thread {
            try {
                val args =
                    mutableListOf("logcat", "-d", "-v", "time", "-t", LOG_MAX_LINES.toString())
                for (tag in LOG_TAGS) args.add("$tag:*")
                args.add("*:S")
                val process = ProcessBuilder(args).redirectErrorStream(true).start()
                val text =
                    BufferedReader(InputStreamReader(process.inputStream)).use { it.readText() }
                process.waitFor()
                promise.resolve(text)
            } catch (e: Exception) {
                // A device that refuses logcat is a report with no log section,
                // not a report that failed.
                Log.w(TAG, "Could not read logcat: ${e.message}")
                promise.resolve("")
            }
        }
            .start()
    }
}
