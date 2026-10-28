// A live stream's picture: a TextureView with its own MediaCodec decoder
// rendering straight onto it.
//
// Units arrive already paced by TypeScript and are shown the moment they
// decode. A surface that has just appeared, has lost a unit, or whose decoder
// failed waits for the next keyframe rather than painting deltas with nothing
// under them. Each surface decodes on a thread of its own, so a slow codec
// holds up only its own stream.
package org.onemindlabs.airhop.video

import android.content.Context
import android.graphics.SurfaceTexture
import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import android.view.TextureView
import java.lang.ref.WeakReference
import java.nio.ByteBuffer

internal object VideoSurfaces {
    private val surfaces = HashMap<String, WeakReference<VideoSurfaceView>>()

    @Synchronized
    fun attach(key: String, view: VideoSurfaceView) {
        surfaces[key] = WeakReference(view)
    }

    @Synchronized
    fun detach(key: String, view: VideoSurfaceView) {
        if (surfaces[key]?.get() === view) surfaces.remove(key)
    }

    @Synchronized fun get(key: String): VideoSurfaceView? = surfaces[key]?.get()
}

internal class VideoSurfaceView(context: Context) :
    TextureView(context), TextureView.SurfaceTextureListener {
    private companion object {
        // Larger than any preset; the decoder takes the real size from the SPS.
        const val MAX_WIDTH = 480
        const val MAX_HEIGHT = 640
        const val INPUT_WAIT_US = 10_000L
        // Tries for an input buffer, draining output between them: a codec with
        // every input held is waiting for its output to be taken.
        const val INPUT_ATTEMPTS = 5
        // How long the first output poll after a queued unit waits, so its
        // picture shows now rather than when the next unit arrives.
        const val OUTPUT_WAIT_US = 10_000L
    }

    private val thread = HandlerThread("airhop-video-decode").apply { start() }
    private val handler = Handler(thread.looper)

    // Decoder-thread state.
    private var surface: Surface? = null
    private var codec: MediaCodec? = null
    private var parameters: Pair<ByteArray, ByteArray>? = null
    private var awaitingKeyframe = true
    private var inputPtsUs = 0L

    var surfaceKey: String = ""
        set(value) {
            if (field.isNotEmpty()) VideoSurfaces.detach(field, this)
            field = value
            if (value.isNotEmpty() && isAvailable) VideoSurfaces.attach(value, this)
        }

    init {
        surfaceTextureListener = this
    }

    fun submit(annexB: ByteArray, keyframe: Boolean) {
        handler.post { decode(annexB, keyframe) }
    }

    fun releaseDecoder() {
        handler.post {
            releaseCodec()
            awaitingKeyframe = true
        }
    }

    fun dispose() {
        if (surfaceKey.isNotEmpty()) VideoSurfaces.detach(surfaceKey, this)
        handler.post {
            releaseCodec()
            surface?.release()
            surface = null
            thread.quitSafely()
        }
    }

    override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
        val next = Surface(texture)
        handler.post {
            surface = next
            awaitingKeyframe = true
        }
        if (surfaceKey.isNotEmpty()) VideoSurfaces.attach(surfaceKey, this)
    }

    override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) =
        Unit

    // False, so the texture outlives this call: the codec may still render into
    // it until the decode thread releases both, in that order. Once dispose()
    // has wound the thread down it takes the codec with it, and the view
    // releases the texture itself.
    override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
        if (surfaceKey.isNotEmpty()) VideoSurfaces.detach(surfaceKey, this)
        val posted = handler.post {
            releaseCodec()
            surface?.release()
            surface = null
            awaitingKeyframe = true
            texture.release()
        }
        return !posted
    }

    override fun onSurfaceTextureUpdated(texture: SurfaceTexture) = Unit

    private fun decode(annexB: ByteArray, keyframe: Boolean) {
        val target = surface ?: return
        if (awaitingKeyframe && !keyframe) return
        if (keyframe) {
            val sets = VideoNal.parameterSets(annexB) ?: return
            val known = parameters
            if (
                codec == null ||
                    known == null ||
                    !known.first.contentEquals(sets.first) ||
                    !known.second.contentEquals(sets.second)
            ) {
                releaseCodec()
                if (!configure(target, sets)) return
            }
            awaitingKeyframe = false
        }
        val decoder = codec ?: return
        try {
            val index = dequeueInput(decoder)
            if (index < 0) {
                // This unit is lost, and the deltas after it would paint over
                // the hole: hold the picture until the next keyframe instead.
                awaitingKeyframe = true
                return
            }
            decoder.getInputBuffer(index)?.apply {
                clear()
                put(annexB)
            }
            inputPtsUs += 1_000
            decoder.queueInputBuffer(index, 0, annexB.size, inputPtsUs, 0)
            render(decoder, OUTPUT_WAIT_US)
        } catch (error: IllegalStateException) {
            // CodecException is one: the picture holds until the next keyframe.
            Log.w(TAG, "Decoder error, waiting for a keyframe: ${error.message}")
            releaseCodec()
            awaitingKeyframe = true
        }
    }

    private fun configure(target: Surface, sets: Pair<ByteArray, ByteArray>): Boolean =
        try {
            val format =
                MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, MAX_WIDTH, MAX_HEIGHT)
                    .apply {
                        setByteBuffer("csd-0", ByteBuffer.wrap(VideoNal.withStartCode(sets.first)))
                        setByteBuffer("csd-1", ByteBuffer.wrap(VideoNal.withStartCode(sets.second)))
                    }
            codec =
                MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC).apply {
                    configure(format, target, null, 0)
                    start()
                }
            parameters = sets
            true
        } catch (error: Exception) {
            Log.w(TAG, "H.264 decoder unavailable: ${error.message}")
            releaseCodec()
            false
        }

    private fun dequeueInput(decoder: MediaCodec): Int {
        repeat(INPUT_ATTEMPTS) {
            val index = decoder.dequeueInputBuffer(INPUT_WAIT_US)
            if (index >= 0) return index
            render(decoder)
        }
        return -1
    }

    // Shows every decoded picture. Only the first poll may wait.
    private fun render(decoder: MediaCodec, firstWaitUs: Long = 0L) {
        val info = MediaCodec.BufferInfo()
        var waitUs = firstWaitUs
        while (true) {
            val index = decoder.dequeueOutputBuffer(info, waitUs)
            waitUs = 0L
            if (index >= 0) {
                decoder.releaseOutputBuffer(index, info.size > 0)
            } else if (index == MediaCodec.INFO_TRY_AGAIN_LATER) {
                return
            }
        }
    }

    private fun releaseCodec() {
        val current = codec ?: return
        codec = null
        parameters = null
        runCatching { current.stop() }
        runCatching { current.release() }
    }
}
