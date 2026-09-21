// Registers AirhopWiFiModule with the React Native bridge.
// Referenced from MainApplication.kt's getPackages() list alongside AirhopBLEPackage.
package org.onemindlabs.airhop.wifi

import android.os.Build
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class AirhopWiFiPackage : ReactPackage {

    // ReactPackage.createNativeModules is deprecated in New Architecture (use codegen
    // TurboModules),
    // but legacy interop still requires it until AirhopWiFiModule is fully migrated.
    @Suppress("OVERRIDE_DEPRECATION")
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        // The data path needs API 29: the peer's address is a link-local IPv6
        // delivered in WifiAwareNetworkInfo, which does not exist below it.
        // Discovery alone is no use, so on older devices the module is simply
        // absent and TypeScript reads a missing module as unsupported.
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            listOf(AirhopWiFiModule(reactContext))
        } else {
            emptyList()
        }
    }

    @Suppress("OVERRIDE_DEPRECATION")
    override fun createViewManagers(
        reactContext: ReactApplicationContext
    ): List<ViewManager<*, *>> = emptyList()
}
