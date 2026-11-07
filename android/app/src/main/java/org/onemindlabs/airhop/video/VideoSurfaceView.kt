// A live stream's picture: a TextureView with its own MediaCodec decoder
// rendering straight onto it.
//
// Units arrive already paced by TypeScript and are shown the moment they
// decode. A surface that has just appeared, has lost a unit, or whose decoder
// failed waits for the next keyframe rather than painting deltas with nothing
// under them. Each surface decodes on a thread of its own, so a slow codec
// holds up only its own picture.
package org.onemindlabs.airhop.video

import android.content.Context
import android.graphics.Color
import android.graphics.PorterDuff
import android.graphics.SurfaceTexture
import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import android.view.TextureView
import java.nio.ByteBuffer

internal object VideoSurfaces : SurfaceRegistry<VideoSurfaceView>()

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
        // The largest unit the stream assembler accepts
        // (core/mesh/video/video-stream-assembler.ts). Left unset, each codec
        // sizes its input buffers for a 480x640 picture by its own rule, and a
        // big keyframe can outgrow them.
        const val MAX_INPUT_BYTES = 256 * 1024
    }

    private val thread = HandlerThread("airhop-video-decode").apply { start() }
    private val handler = Handler(thread.looper)

    // Decoder-thread state.
    private var texture: SurfaceTexture? = null
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

    // Nothing may escape this thread: an uncaught throw on it ends the process,
    // and the bytes come from any signed sender in range. A CodecException or a
    // buffer overflow holds the picture until the next keyframe.
    fun submit(annexB: ByteArray, keyframe: Boolean) {
        handler.post {
            try {
                decode(annexB, keyframe)
            } catch (error: RuntimeException) {
                Log.w(TAG, "Decoder error, waiting for a keyframe: ${error.message}")
                releaseCodec()
                awaitingKeyframe = true
            }
        }
    }

    // The stream ended: its last picture goes with the decoder rather than
    // staying up as if the stream had frozen.
    fun releaseDecoder() {
        handler.post {
            releaseCodec()
            awaitingKeyframe = true
            blank()
        }
    }

    fun dispose() {
        if (surfaceKey.isNotEmpty()) VideoSurfaces.detach(surfaceKey, this)
        handler.post {
            releaseCodec()
            surface?.release()
            surface = null
            texture = null
            thread.quitSafely()
        }
    }

    override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
        val next = Surface(texture)
        handler.post {
            this.texture = texture
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
            this.texture = null
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
        val index = dequeueInput(decoder)
        if (index < 0) {
            // This unit is lost, and the deltas after it would paint over the
            // hole: hold the picture until the next keyframe instead.
            awaitingKeyframe = true
            return
        }
        inputPtsUs += 1_000
        val buffer = decoder.getInputBuffer(index)?.apply { clear() }
        if (buffer == null || annexB.size > buffer.remaining()) {
            // Too big for the codec to take. The buffer goes back empty, since a
            // dequeued one is held until it is queued, and the unit is lost like
            // any other.
            decoder.queueInputBuffer(index, 0, 0, inputPtsUs, 0)
            awaitingKeyframe = true
            return
        }
        buffer.put(annexB)
        decoder.queueInputBuffer(index, 0, annexB.size, inputPtsUs, 0)
        render(decoder, OUTPUT_WAIT_US)
    }

    private fun configure(target: Surface, sets: Pair<ByteArray, ByteArray>): Boolean =
        try {
            val format =
                MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, MAX_WIDTH, MAX_HEIGHT)
                    .apply {
                        setByteBuffer("csd-0", ByteBuffer.wrap(VideoNal.withStartCode(sets.first)))
                        setByteBuffer("csd-1", ByteBuffer.wrap(VideoNal.withStartCode(sets.second)))
                        setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, MAX_INPUT_BYTES)
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

    // Clears the picture once the codec has let go of the surface. Drawing
    // connects the surface to the CPU for good, and a codec cannot connect to it
    // after that, so the drawn surface is swapped for a fresh one on the same
    // texture for the next stream.
    private fun blank() {
        val current = surface ?: return
        val owner = texture ?: return
        try {
            val canvas = current.lockCanvas(null)
            canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
            current.unlockCanvasAndPost(canvas)
        } catch (error: Exception) {
            Log.w(TAG, "Could not clear the picture: ${error.message}")
        }
        current.release()
        surface = Surface(owner)
    }

    private fun releaseCodec() {
        val current = codec ?: return
        codec = null
        parameters = null
        runCatching { current.stop() }
        runCatching { current.release() }
    }
}
