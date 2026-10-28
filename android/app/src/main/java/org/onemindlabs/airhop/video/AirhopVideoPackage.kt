// Registers AirhopVideoModule and live video's two views with the React Native
// bridge. Referenced from MainApplication.kt's getPackages() list alongside
// the other Airhop packages.
package org.onemindlabs.airhop.video

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManager
import com.facebook.react.uimanager.annotations.ReactProp

class AirhopVideoPackage : ReactPackage {

    // Deprecated in the New Architecture, and still what the interop layer
    // reads until these modules move to Codegen; same position as the others.
    @Suppress("OVERRIDE_DEPRECATION")
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(AirhopVideoModule(reactContext))

    @Suppress("OVERRIDE_DEPRECATION")
    override fun createViewManagers(
        reactContext: ReactApplicationContext
    ): List<ViewManager<*, *>> = listOf(VideoSurfaceManager(), CameraPreviewManager())
}

internal class VideoSurfaceManager : SimpleViewManager<VideoSurfaceView>() {
    override fun getName(): String = "AirhopVideoSurface"

    override fun createViewInstance(context: ThemedReactContext): VideoSurfaceView =
        VideoSurfaceView(context)

    @ReactProp(name = "surfaceKey")
    fun setSurfaceKey(view: VideoSurfaceView, key: String?) {
        view.surfaceKey = key ?: ""
    }

    // The surface is laid out at the stream's own aspect, so filling it is
    // already a cover; there is nothing to crop.
    @ReactProp(name = "resizeMode")
    fun setResizeMode(@Suppress("UNUSED_PARAMETER") view: VideoSurfaceView, mode: String?) = Unit

    override fun onDropViewInstance(view: VideoSurfaceView) {
        view.dispose()
        super.onDropViewInstance(view)
    }
}

internal class CameraPreviewManager : SimpleViewManager<CameraPreviewHost>() {
    override fun getName(): String = "AirhopCameraPreview"

    override fun createViewInstance(context: ThemedReactContext): CameraPreviewHost =
        CameraPreviewHost(context)
}
