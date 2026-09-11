// AirhopAppModule: process-level operations that belong to no radio.
//
// Restart, because layout direction only moves on a fresh process: native views
// read the RTL preference when they are created. Asking the user to relaunch is
// not enough, since a warm start recreates the Activity while the JS context
// survives, so the frame turns around and the strings do not.
//
// Recent log, because a field report without one is a guess. Android lets a
// process read its own logcat lines and nobody else's, so this needs no
// permission and cannot see another app.
package org.onemindlabs.airhop.app

import android.content.Intent
import android.util.Log
import java.io.BufferedReader
import java.io.InputStreamReader
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

private const val TAG = "AirhopAppModule"

// Only the tags this app writes, plus the crash reporter. An allowlist rather
// than the whole process log, which React Native fills freely; none of these
// tags ever print message content, nicknames or keys.
private val LOG_TAGS = listOf(
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

class AirhopAppModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "AirhopApp"

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

    // The process's recent logcat, filtered to LOG_TAGS, oldest first.
    //
    // `-d` dumps and exits rather than following, and `-t` bounds it. The
    // `*:S` at the end silences every tag not listed, which is what makes the
    // allowlist an allowlist rather than a highlight.
    @ReactMethod
    fun recentLog(promise: Promise) {
        Thread {
            try {
                val args = mutableListOf("logcat", "-d", "-v", "time", "-t", LOG_MAX_LINES.toString())
                for (tag in LOG_TAGS) args.add("$tag:*")
                args.add("*:S")
                val process = ProcessBuilder(args).redirectErrorStream(true).start()
                val text = BufferedReader(InputStreamReader(process.inputStream)).use { it.readText() }
                process.waitFor()
                promise.resolve(text)
            } catch (e: Exception) {
                // A device that refuses logcat is a report with no log section,
                // not a report that failed.
                Log.w(TAG, "Could not read logcat: ${e.message}")
                promise.resolve("")
            }
        }.start()
    }
}
