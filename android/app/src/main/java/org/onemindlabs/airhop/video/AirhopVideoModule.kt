// AirhopVideoModule: live video, and the transcode that fits a video to a
// mesh transfer.
//
// The camera becomes a stream of H.264 access units, units become pictures on
// a surface, units plus AAC frames become an MP4, and a file becomes a smaller
// one to the plan it is handed (VideoTranscoder). Nothing else: no protocol,
// no pacing, no packet knowledge, no sizing decisions. Those live in
// core/mesh/video/, live-video-*.ts and video-prepare.ts, exactly as the voice
// module leaves the burst format to TypeScript.
//
// Units cross the bridge as base64 Annex B with SPS and PPS on every keyframe,
// the LIVE_VIDEO_V1 unit format. Audio is not captured here; the microphone
// belongs to AirhopVoiceModule, whose frames TypeScript hands back for the
// recording.
//
// Threading contract: every @ReactMethod returns at once. The camera binds on
// the main thread, the encoder is set up and torn down on an executor of its
// own, encoding runs on CameraX's analysis thread and a drain thread, each
// surface decodes on its own thread, recordings share one worker, and
// transcodes run one at a time on the transcoder's own looper.
//
// Events emitted to TypeScript:
//   AirhopVideo.encoded            { dataBase64, ptsMs, keyframe }
//   AirhopVideo.cameraError        { message }
//   AirhopVideo.transcodeProgress  { jobKey, fraction }
package org.onemindlabs.airhop.video

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import androidx.lifecycle.LifecycleOwner
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

internal const val TAG = "AirhopVideoModule"

private const val EVT_ENCODED = "AirhopVideo.encoded"
private const val EVT_CAMERA_ERROR = "AirhopVideo.cameraError"
private const val EVT_TRANSCODE_PROGRESS = "AirhopVideo.transcodeProgress"

class AirhopVideoModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val main = Handler(Looper.getMainLooper())
    private val recordingExecutor = Executors.newSingleThreadExecutor()
    // Encoder setup and teardown, in call order. Creating and configuring a
    // codec can take hundreds of milliseconds on some devices, which would stall
    // the native-modules thread every other module shares.
    private val encoderExecutor = Executors.newSingleThreadExecutor()
    // Recording-thread state.
    private val recordings = HashMap<String, Mp4Writer>()
    @Volatile private var cameraOptions: ReadableMap? = null
    // Its threads start with the first video shrunk, not with the app.
    private val transcoderSlot = lazy { VideoTranscoder(reactContext) }
    private val transcoder by transcoderSlot
    private var listenerCount = 0

    // False once invalidate has shut the executor down. A late call (a main
    // thread post, a reload's last bridge call) must not throw: on these
    // threads an uncaught throw ends the process.
    private fun ExecutorService.enqueue(task: () -> Unit): Boolean =
        try {
            execute(Runnable { task() })
            true
        } catch (error: RejectedExecutionException) {
            false
        }

    init {
        VideoCamera.onFrame = { frame ->
            emit(
                EVT_ENCODED,
                WritableNativeMap().apply {
                    putString("dataBase64", Base64.encodeToString(frame.annexB, Base64.NO_WRAP))
                    putDouble("ptsMs", (frame.ptsUs / 1_000).toDouble())
                    putBoolean("keyframe", frame.keyframe)
                },
            )
        }
        VideoCamera.onError = { message ->
            emit(EVT_CAMERA_ERROR, WritableNativeMap().apply { putString("message", message) })
        }
    }

    override fun getName(): String = "AirhopVideo"

    // ---- Display ----

    @ReactMethod
    fun decodeVideo(surfaceKey: String, dataBase64: String, keyframe: Boolean) {
        val data = runCatching { Base64.decode(dataBase64, Base64.NO_WRAP) }.getOrNull() ?: return
        VideoSurfaces.all(surfaceKey).forEach { it.submit(data, keyframe) }
    }

    @ReactMethod
    fun releaseDecoder(surfaceKey: String) {
        VideoSurfaces.all(surfaceKey).forEach { it.releaseDecoder() }
    }

    // ---- Recording ----

    @ReactMethod
    fun startRecording(
        recordingKey: String,
        path: String,
        width: Double,
        height: Double,
        hasAudio: Boolean,
        promise: Promise,
    ) {
        val file = fileOf(path)
        if (file == null) {
            promise.reject("BAD_PATH", "not a file URI")
            return
        }
        val queued = recordingExecutor.enqueue {
            recordings.remove(recordingKey)?.cancel()
            recordings[recordingKey] = Mp4Writer(file, width.toInt(), height.toInt(), hasAudio)
            promise.resolve(null)
        }
        if (!queued) promise.reject("RECORDING_FAILED", "video module shut down")
    }

    @ReactMethod
    fun appendVideo(recordingKey: String, dataBase64: String, ptsMs: Double, keyframe: Boolean) {
        val data = runCatching { Base64.decode(dataBase64, Base64.NO_WRAP) }.getOrNull() ?: return
        recordingExecutor.enqueue {
            recordings[recordingKey]?.writeVideo(data, (ptsMs * 1_000).toLong(), keyframe)
        }
    }

    @ReactMethod
    fun appendAudio(recordingKey: String, dataBase64: String, ptsMs: Double) {
        val data = runCatching { Base64.decode(dataBase64, Base64.NO_WRAP) }.getOrNull() ?: return
        recordingExecutor.enqueue {
            recordings[recordingKey]?.writeAudio(data, (ptsMs * 1_000).toLong())
        }
    }

    @ReactMethod
    fun finishRecording(recordingKey: String, promise: Promise) {
        val queued = recordingExecutor.enqueue {
            val writer = recordings.remove(recordingKey)
            val durationMs = writer?.durationMs ?: 0L
            if (writer == null || !writer.finish()) {
                promise.resolve(null)
                return@enqueue
            }
            promise.resolve(
                WritableNativeMap().apply {
                    putDouble("durationMs", durationMs.toDouble())
                    putDouble("sizeBytes", writer.file.length().toDouble())
                }
            )
        }
        // Null is the "no recording" answer the caller already handles.
        if (!queued) promise.resolve(null)
    }

    @ReactMethod
    fun cancelRecording(recordingKey: String) {
        recordingExecutor.enqueue { recordings.remove(recordingKey)?.cancel() }
    }

    // ---- Transcode ----

    @ReactMethod
    fun probeVideo(uri: String, promise: Promise) {
        transcoder.probe(
            uri,
            { probe ->
                promise.resolve(
                    WritableNativeMap().apply {
                        putDouble("durationMs", probe.durationMs.toDouble())
                        putDouble("width", probe.width.toDouble())
                        putDouble("height", probe.height.toDouble())
                        putBoolean("hasAudio", probe.hasAudio)
                    }
                )
            },
            { failure -> promise.reject(failure.code, failure.message) },
        )
    }

    @ReactMethod
    fun transcodeVideo(
        jobKey: String,
        source: String,
        output: String,
        options: ReadableMap,
        promise: Promise,
    ) {
        val file = fileOf(output)
        if (file == null) {
            promise.reject("BAD_PATH", "not a file URI")
            return
        }
        fun number(key: String): Int =
            if (options.hasKey(key)) options.getDouble(key).toInt() else 0
        val plan =
            TranscodePlan(
                startMs = number("startMs").toLong(),
                keepMs = number("keepMs").toLong(),
                width = number("width"),
                height = number("height"),
                fps = number("fps"),
                videoBitrate = number("videoBitrate"),
                audioBitrate = number("audioBitrate"),
                keyframeIntervalSeconds = number("keyframeIntervalSeconds"),
            )
        transcoder.enqueue(
            jobKey,
            source,
            file,
            plan,
            onProgress = { fraction ->
                emit(
                    EVT_TRANSCODE_PROGRESS,
                    WritableNativeMap().apply {
                        putString("jobKey", jobKey)
                        putDouble("fraction", fraction)
                    },
                )
            },
            onDone = { sizeBytes, durationMs ->
                promise.resolve(
                    WritableNativeMap().apply {
                        putDouble("sizeBytes", sizeBytes.toDouble())
                        putDouble("durationMs", durationMs.toDouble())
                    }
                )
            },
            onFail = { failure -> promise.reject(failure.code, failure.message) },
        )
    }

    @ReactMethod
    fun cancelTranscode(jobKey: String) {
        transcoder.cancel(jobKey)
    }

    @ReactMethod
    fun extractFrames(
        source: String,
        timesMs: ReadableArray,
        maxEdge: Double,
        outputs: ReadableArray,
        promise: Promise,
    ) {
        val files = (0 until outputs.size()).mapNotNull { fileOf(outputs.getString(it) ?: "") }
        if (files.size != outputs.size()) {
            promise.reject("BAD_PATH", "not a file URI")
            return
        }
        val times = (0 until timesMs.size()).map { timesMs.getDouble(it).toLong() }
        transcoder.frames(source, times, maxEdge.toInt(), files) { promise.resolve(null) }
    }

    // ---- Capture ----

    @ReactMethod
    fun startCamera(options: ReadableMap, promise: Promise) {
        cameraOptions = options
        val lifecycle = reactContext.currentActivity as? LifecycleOwner
        if (lifecycle == null) {
            promise.reject("CAMERA_UNAVAILABLE", "no activity to bind the camera to")
            return
        }
        val facing =
            if (options.hasKey("facing")) options.getString("facing") ?: "front" else "front"
        val fps = if (options.hasKey("fps")) options.getDouble("fps").toInt() else 8
        main.post {
            VideoCamera.start(reactContext, lifecycle, facing, fps) { error ->
                if (error == null) promise.resolve(null)
                else promise.reject(error, "camera unavailable")
            }
        }
    }

    @ReactMethod
    fun setFacing(facing: String, promise: Promise) {
        main.post {
            if (VideoCamera.setFacing(facing)) promise.resolve(null)
            else promise.reject("CAMERA_FAILED", "could not switch camera")
        }
    }

    @ReactMethod
    fun startEncoding(promise: Promise) {
        val options = cameraOptions
        fun number(key: String, fallback: Int): Int =
            if (options != null && options.hasKey(key)) options.getDouble(key).toInt() else fallback
        val width = number("width", 144)
        val height = number("height", 192)
        val bitrate = number("bitrate", 18_000)
        val keyframeInterval = number("keyframeIntervalSeconds", 2)
        val queued = encoderExecutor.enqueue {
            val started = runCatching {
                VideoCamera.startEncoding(width, height, bitrate, keyframeInterval)
            }
                .getOrDefault(false)
            if (started) promise.resolve(null)
            else promise.reject("ENCODER_FAILED", "H.264 encoder unavailable")
        }
        if (!queued) promise.reject("ENCODER_FAILED", "video module shut down")
    }

    // On the encoder executor too, so a stop never overtakes the start before it
    // and leaves an encoder running that nothing will stop.
    @ReactMethod
    fun stopEncoding(promise: Promise) {
        val queued = encoderExecutor.enqueue { VideoCamera.stopEncoding { promise.resolve(null) } }
        if (!queued) VideoCamera.stopEncoding { promise.resolve(null) }
    }

    @ReactMethod
    fun setBitrate(bitrate: Double) {
        VideoCamera.setBitrate(bitrate.toInt())
    }

    @ReactMethod
    fun requestKeyframe() {
        VideoCamera.requestKeyframe()
    }

    @ReactMethod
    fun stopCamera(promise: Promise) {
        main.post {
            VideoCamera.stop()
            // A start still queued behind the executor would otherwise open an
            // encoder after the camera is gone.
            encoderExecutor.enqueue { VideoCamera.stopEncoding {} }
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {
        listenerCount++
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        listenerCount = maxOf(0, listenerCount - count)
    }

    // Each executor runs what is already queued, its cleanup last, and then lets
    // its thread go.
    override fun invalidate() {
        main.post { VideoCamera.stop() }
        encoderExecutor.enqueue { VideoCamera.stopEncoding {} }
        encoderExecutor.shutdown()
        recordingExecutor.enqueue {
            recordings.values.forEach { it.cancel() }
            recordings.clear()
        }
        recordingExecutor.shutdown()
        if (transcoderSlot.isInitialized()) transcoder.release()
        super.invalidate()
    }

    private fun emit(name: String, params: WritableNativeMap) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            ?.emit(name, params)
    }

    private fun fileOf(path: String): File? {
        val uri = Uri.parse(path)
        return when {
            uri.scheme == "file" -> uri.path?.let(::File)
            path.startsWith("/") -> File(path)
            else -> null
        }
    }
}
