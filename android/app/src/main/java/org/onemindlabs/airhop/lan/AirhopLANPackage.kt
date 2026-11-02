// Registers AirhopLANModule with the React Native bridge.
package org.onemindlabs.airhop.lan

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class AirhopLANPackage : ReactPackage {

    // No API gate, unlike the WiFi package: NsdManager has been available since
    // API 16, well below this app's floor. The module reports its own
    // unavailability instead, since a device with mDNS can still be on no
    // network at all.
    @Suppress("OVERRIDE_DEPRECATION")
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(AirhopLANModule(reactContext))

    @Suppress("OVERRIDE_DEPRECATION")
    override fun createViewManagers(
        reactContext: ReactApplicationContext
    ): List<ViewManager<*, *>> = emptyList()
}
