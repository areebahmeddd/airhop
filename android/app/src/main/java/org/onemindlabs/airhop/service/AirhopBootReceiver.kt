// Restarts the mesh after a reboot, if the user opted in.
//
// Reads the flag AirhopAppModule.setAutoStartOnBoot writes (Settings >
// Connectivity, off by default). BOOT_COMPLETED fires only after first
// unlock, the same point Keystore makes the identity readable again.
package org.onemindlabs.airhop.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

private const val BOOT_PREFS_NAME = "airhop_boot_prefs"
private const val KEY_AUTO_START = "auto_start_on_boot"

class AirhopBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val prefs = context.getSharedPreferences(BOOT_PREFS_NAME, Context.MODE_PRIVATE)
        if (prefs.getBoolean(KEY_AUTO_START, false)) {
            AirhopBootService.start(context.applicationContext)
        }
    }
}
