// The one camera live video sends from: CameraX feeding a preview and an
// H.264 encoder at once. The studio's viewfinder runs on the same session
// before and after the stream, and only one stream is ever live.
//
// Frames reach the encoder as YUV from ImageAnalysis, rotated upright and
// cropped to the stream's 3:4 by YuvScaler: a camera writing straight into an
// encoder surface would hand it sideways, landscape pictures, and the stream
// has no field for rotation. The front camera is not mirrored in the stream,
// so text reads the right way round for viewers; only the preview mirrors.
package org.onemindlabs.airhop.video

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import android.util.Size
import android.widget.FrameLayout
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LiveData
import java.lang.ref.WeakReference
import java.util.concurrent.Executors

internal object VideoCamera {
    // Covers the largest preset (480x640 portrait) without paying for a
    // full-resolution analysis stream.
    private val ANALYSIS_SIZE = Size(640, 480)
    private const val DRAIN_WAIT_US = 10_000L
    private const val FLUSH_TIMEOUT_MS = 1_000L

    var onFrame: ((EncodedVideoFrame) -> Unit)? = null
    var onError: ((String) -> Unit)? = null

    private val analysisExecutor = Executors.newSingleThreadExecutor()
    private var provider: ProcessCameraProvider? = null
    private var owner: WeakReference<LifecycleOwner>? = null
    private var preview: Preview? = null
    private var analysis: ImageAnalysis? = null
    private var facing = "front"
    private var previewHost: WeakReference<CameraPreviewHost>? = null
    private var observedState: LiveData<CameraState>? = null

    // Analysis-thread state, read by the drain thread under `encoderLock`.
    private val encoderLock = Object()
    @Volatile private var encoder: H264Encoder? = null
    @Volatile private var fps = 8
    private var originNs = 0L
    private var lastFrameNs = 0L
    // One report per stream: a codec that failed once fails on every frame.
    private var reportedFailure = false
    private var drainThread: Thread? = null

    // Main thread.
    fun start(
        context: Context,
        lifecycle: LifecycleOwner,
        facing: String,
        fps: Int,
        done: (String?) -> Unit,
    ) {
        if (
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) !=
                PackageManager.PERMISSION_GRANTED
        ) {
            done("PERMISSION_DENIED")
            return
        }
        this.fps = maxOf(1, fps)
        this.facing = facing
        owner = WeakReference(lifecycle)
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener(
            {
                try {
                    provider = future.get()
                    bind()
                    done(null)
                } catch (error: Exception) {
                    Log.w(TAG, "Camera unavailable: ${error.message}")
                    done("CAMERA_UNAVAILABLE")
                }
            },
            ContextCompat.getMainExecutor(context),
        )
    }

    // Main thread.
    fun setFacing(facing: String) {
        this.facing = facing
        if (provider != null) bind()
        // A new camera is a new picture: viewers need a keyframe for it.
        encoder?.requestKeyframe()
    }

    // Main thread.
    fun stop() {
        stopEncoding {}
        provider?.unbindAll()
        preview = null
        analysis = null
    }

    fun startEncoding(
        width: Int,
        height: Int,
        bitrate: Int,
        keyframeIntervalSeconds: Int,
    ): Boolean {
        synchronized(encoderLock) {
            encoder?.release()
            encoder = null
            val created =
                runCatching { H264Encoder(width, height, fps, bitrate, keyframeIntervalSeconds) }
                    .onFailure { Log.w(TAG, "H.264 encoder unavailable: ${it.message}") }
                    .getOrNull() ?: return false
            originNs = System.nanoTime()
            lastFrameNs = 0L
            reportedFailure = false
            encoder = created
            created.requestKeyframe()
            drainThread = Thread({ drainLoop(created) }, "airhop-video-encoder").also(Thread::start)
        }
        return true
    }

    // Flushes the encoder; every unit it held reaches onFrame before `done`.
    fun stopEncoding(done: () -> Unit) {
        val current: H264Encoder
        val thread: Thread?
        synchronized(encoderLock) {
            current =
                encoder
                    ?: run {
                        done()
                        return
                    }
            encoder = null
            thread = drainThread
            drainThread = null
            runCatching { current.signalEndOfStream() }
        }
        Thread(
                {
                    thread?.join(FLUSH_TIMEOUT_MS)
                    thread?.interrupt()
                    current.release()
                    done()
                },
                "airhop-video-flush",
            )
            .start()
    }

    fun setBitrate(bitrate: Int) {
        encoder?.setBitrate(bitrate)
    }

    fun requestKeyframe() {
        encoder?.requestKeyframe()
    }

    // Main thread.
    fun attachPreview(host: CameraPreviewHost) {
        previewHost = WeakReference(host)
        preview?.setSurfaceProvider(host.previewView.surfaceProvider)
    }

    // Main thread.
    fun detachPreview(host: CameraPreviewHost) {
        if (previewHost?.get() !== host) return
        previewHost = null
        preview?.setSurfaceProvider(null)
    }

    private fun bind() {
        val provider = provider ?: return
        val lifecycle = owner?.get() ?: return
        val selector =
            ResolutionSelector.Builder()
                .setResolutionStrategy(
                    ResolutionStrategy(
                        ANALYSIS_SIZE,
                        ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                    )
                )
                .build()
        val nextPreview = Preview.Builder().build()
        val nextAnalysis =
            ImageAnalysis.Builder()
                .setResolutionSelector(selector)
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
                .build()
        nextAnalysis.setAnalyzer(analysisExecutor) { image ->
            try {
                offer(image)
            } finally {
                image.close()
            }
        }
        val camera =
            if (facing == "back") CameraSelector.DEFAULT_BACK_CAMERA
            else CameraSelector.DEFAULT_FRONT_CAMERA
        provider.unbindAll()
        val bound = provider.bindToLifecycle(lifecycle, camera, nextPreview, nextAnalysis)
        // Each bind (a new quality, the other camera) would otherwise add an
        // observer beside the last, and one error would be reported over and over.
        observedState?.removeObservers(lifecycle)
        observedState = bound.cameraInfo.cameraState
        bound.cameraInfo.cameraState.observe(lifecycle) { state ->
            if (state.error != null && encoder != null)
                onError?.invoke("camera error ${state.error?.code}")
        }
        preview = nextPreview
        analysis = nextAnalysis
        previewHost?.get()?.let { nextPreview.setSurfaceProvider(it.previewView.surfaceProvider) }
    }

    // Analysis thread. Frames past the preset's rate are dropped here, 15%
    // early allowed so a 30 fps camera reliably yields the target.
    private fun offer(image: androidx.camera.core.ImageProxy) {
        synchronized(encoderLock) {
            val current = encoder ?: return
            val now = System.nanoTime()
            val interval = 1_000_000_000L / fps
            if (lastFrameNs != 0L && now - lastFrameNs < interval * 85 / 100) return
            lastFrameNs = now
            val ptsUs = (now - originNs) / 1_000
            runCatching { current.encode(YuvSource.fromImageProxy(image), ptsUs) }
                .onFailure {
                    Log.w(TAG, "Encode failed: ${it.message}")
                    if (!reportedFailure) {
                        reportedFailure = true
                        onError?.invoke("encoder failed")
                    }
                }
        }
    }

    private fun drainLoop(current: H264Encoder) {
        try {
            while (!Thread.currentThread().isInterrupted) {
                val ended = current.drain(DRAIN_WAIT_US) { frame -> onFrame?.invoke(frame) }
                if (ended) return
            }
        } catch (error: Exception) {
            // The codec was released under us, which is how a stop ends this.
            Log.d(TAG, "Encoder drain ended: ${error.message}")
        }
    }
}

// A frame for CameraX's PreviewView. React Native lays out only the views it
// created, and PreviewView adds its own child once a surface is requested, so
// every layout request is answered here with a pass of its own.
internal class CameraPreviewHost(context: Context) : FrameLayout(context) {
    val previewView =
        PreviewView(context).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }

    private val relayout = Runnable {
        measure(
            MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
        )
        layout(left, top, right, bottom)
    }

    init {
        addView(previewView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    override fun requestLayout() {
        super.requestLayout()
        post(relayout)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        VideoCamera.attachPreview(this)
    }

    override fun onDetachedFromWindow() {
        VideoCamera.detachPreview(this)
        super.onDetachedFromWindow()
    }
}
