// One transcode pass at a time, for AirhopVideoModule: `keepMs` of a video from
// `startMs` as H.264 + AAC in an MP4, at exactly the size, frame rate and bitrates
// TypeScript planned (core/mesh/video/transcode-plan.ts). No decisions here:
// whether to shrink, to what budget, and whether to retry are all TypeScript's.
//
// Media3 Transformer does the work on the GPU: it decodes whatever the phone
// can (HEVC and 10-bit included), applies the track's rotation, tone maps HDR
// to SDR (API 29+), drops frames to the target rate and scales with a centre
// crop. A portrait picture is encoded portrait, so its pixels are upright with
// no rotation flag, as bitchat-ios writes it. Source metadata is stripped at the
// muxer, since Transformer otherwise copies the source's location into the
// output.
//
// Threading: Transformer is driven from its own looper thread, which this owns;
// probes and frame grabs block, so they run on a separate one.
package org.onemindlabs.airhop.video

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaCodecInfo
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.FrameDropEffect
import androidx.media3.effect.Presentation
import androidx.media3.transformer.AudioEncoderSettings
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.InAppMp4Muxer
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import java.io.File
import java.util.concurrent.Executors
import kotlin.math.roundToInt

internal class TranscodePlan(
    val startMs: Long,
    val keepMs: Long,
    val width: Int,
    val height: Int,
    val fps: Int,
    val videoBitrate: Int,
    // Zero drops the sound.
    val audioBitrate: Int,
    val keyframeIntervalSeconds: Int,
)

internal class VideoProbe(
    val durationMs: Long,
    // Upright, rotation applied.
    val width: Int,
    val height: Int,
    val hasAudio: Boolean,
)

internal class TranscodeFailure(val code: String, message: String) : Exception(message)

// The rejection codes and the parts of a pass that need no codec, apart so the
// JVM tests reach them.
@OptIn(markerClass = [UnstableApi::class])
internal object TranscodeMedia {
    const val CODE_NO_VIDEO = "NO_VIDEO"
    const val CODE_UNREADABLE = "UNREADABLE"
    const val CODE_CANCELLED = "CANCELLED"
    const val CODE_FAILED = "TRANSCODE_FAILED"

    fun uprightSize(width: Int, height: Int, rotationDegrees: Int): Pair<Int, Int> =
        if (Math.floorMod(rotationDegrees, 180) == 90) height to width else width to height

    // Everything the source carried (location, device, dates) stays behind.
    // The muxer still writes the orientation of the track it encodes.
    val stripSourceMetadata = InAppMp4Muxer.MetadataProvider { entries -> entries.clear() }
}

@OptIn(markerClass = [UnstableApi::class])
internal class VideoTranscoder(context: Context) {
    private class Pass(
        val key: String,
        val source: String,
        val output: File,
        val plan: TranscodePlan,
        val onProgress: (Double) -> Unit,
        val onDone: (sizeBytes: Long, durationMs: Long) -> Unit,
        val onFail: (TranscodeFailure) -> Unit,
    ) {
        var transformer: Transformer? = null
    }

    private val context = context.applicationContext
    private val thread = HandlerThread("AirhopVideoTranscode").apply { start() }
    private val handler = Handler(thread.looper)
    private val probes = Executors.newSingleThreadExecutor()
    private val progress = ProgressHolder()
    // Looper-thread state.
    private val waiting = ArrayDeque<Pass>()
    private var current: Pass? = null

    fun probe(uri: String, onProbe: (VideoProbe) -> Unit, onFail: (TranscodeFailure) -> Unit) {
        probes.execute {
            try {
                onProbe(readProbe(Uri.parse(uri)))
            } catch (failure: TranscodeFailure) {
                onFail(failure)
            } catch (error: Exception) {
                onFail(TranscodeFailure(TranscodeMedia.CODE_UNREADABLE, error.message ?: "probe"))
            }
        }
    }

    // Nearest keyframe to each time: a filmstrip needs a picture near it, not
    // the exact frame, and a keyframe decodes without its neighbours.
    fun frames(
        source: String,
        timesMs: List<Long>,
        maxEdge: Int,
        outputs: List<File>,
        onDone: () -> Unit,
    ) {
        probes.execute {
            val retriever = MediaMetadataRetriever()
            try {
                retriever.setDataSource(context, Uri.parse(source))
                timesMs.zip(outputs).forEach { (timeMs, output) ->
                    runCatching { writeFrame(retriever, timeMs, maxEdge, output) }
                }
            } catch (error: Exception) {
                Log.w(TAG, "Frames unavailable: ${error.message}")
            } finally {
                retriever.release()
                onDone()
            }
        }
    }

    fun enqueue(
        key: String,
        source: String,
        output: File,
        plan: TranscodePlan,
        onProgress: (Double) -> Unit,
        onDone: (sizeBytes: Long, durationMs: Long) -> Unit,
        onFail: (TranscodeFailure) -> Unit,
    ) {
        handler.post {
            waiting.addLast(Pass(key, source, output, plan, onProgress, onDone, onFail))
            startNext()
        }
    }

    fun cancel(key: String) {
        handler.post {
            val running = current
            if (running?.key == key) {
                running.transformer?.cancel()
                fail(running, cancelled())
                return@post
            }
            val queued = waiting.firstOrNull { it.key == key } ?: return@post
            waiting.remove(queued)
            queued.onFail(cancelled())
        }
    }

    fun release() {
        handler.post {
            waiting.forEach { it.onFail(cancelled()) }
            waiting.clear()
            current?.let { running ->
                running.transformer?.cancel()
                fail(running, cancelled())
            }
            thread.quitSafely()
        }
        probes.shutdown()
    }

    private fun startNext() {
        if (current != null) return
        val pass = waiting.removeFirstOrNull() ?: return
        current = pass
        pass.output.delete()
        pass.output.parentFile?.mkdirs()
        try {
            val transformer = buildTransformer(pass)
            pass.transformer = transformer
            transformer.start(composition(pass), pass.output.absolutePath)
            pollProgress(pass)
        } catch (error: Exception) {
            Log.w(TAG, "Transcode did not start: ${error.message}")
            fail(pass, TranscodeFailure(TranscodeMedia.CODE_FAILED, error.message ?: "start"))
        }
    }

    private fun buildTransformer(pass: Pass): Transformer {
        val plan = pass.plan
        val encoders =
            DefaultEncoderFactory.Builder(context)
                .setRequestedVideoEncoderSettings(
                    VideoEncoderSettings.Builder()
                        .setBitrate(plan.videoBitrate)
                        .setiFrameIntervalSeconds(plan.keyframeIntervalSeconds.toFloat())
                        // No reordering, as bitchat-ios encodes: every frame
                        // decodes as it arrives.
                        .setMaxBFrames(0)
                        .build()
                )
                .apply {
                    if (plan.audioBitrate > 0) {
                        setRequestedAudioEncoderSettings(
                            AudioEncoderSettings.Builder()
                                .setBitrate(plan.audioBitrate)
                                .setProfile(MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                                .build()
                        )
                    }
                }
                .build()
        return Transformer.Builder(context)
            .setLooper(thread.looper)
            .setVideoMimeType(MimeTypes.VIDEO_H264)
            .setAudioMimeType(MimeTypes.AUDIO_AAC)
            .setPortraitEncodingEnabled(true)
            .setEncoderFactory(encoders)
            .setMuxerFactory(InAppMp4Muxer.Factory(TranscodeMedia.stripSourceMetadata))
            .addListener(
                object : Transformer.Listener {
                    override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                        finish(pass) {
                            it.onDone(
                                pass.output.length(),
                                exportResult.approximateDurationMs.coerceAtLeast(0),
                            )
                        }
                    }

                    override fun onError(
                        composition: Composition,
                        exportResult: ExportResult,
                        exportException: ExportException,
                    ) {
                        Log.w(TAG, "Transcode failed: ${exportException.errorCodeName}")
                        fail(
                            pass,
                            TranscodeFailure(
                                TranscodeMedia.CODE_FAILED,
                                exportException.errorCodeName,
                            ),
                        )
                    }
                }
            )
            .build()
    }

    private fun composition(pass: Pass): Composition {
        val plan = pass.plan
        // An end past the source's own is clamped to it, and the clip starts at
        // zero whatever its start.
        val item =
            MediaItem.Builder()
                .setUri(pass.source)
                .setClippingConfiguration(
                    MediaItem.ClippingConfiguration.Builder()
                        .setStartPositionMs(plan.startMs)
                        .setEndPositionMs(plan.startMs + plan.keepMs)
                        .build()
                )
                .build()
        val withAudio = plan.audioBitrate > 0
        val audioProcessors: List<AudioProcessor> =
            if (withAudio) {
                listOf(
                    downmixToMono(),
                    SonicAudioProcessor().apply { setOutputSampleRateHz(AUDIO_SAMPLE_RATE) },
                )
            } else {
                emptyList()
            }
        val videoEffects =
            listOf(
                FrameDropEffect.createDefaultFrameDropEffect(plan.fps.toFloat()),
                Presentation.createForWidthAndHeight(
                    plan.width,
                    plan.height,
                    Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP,
                ),
            )
        val edited =
            EditedMediaItem.Builder(item).setEffects(Effects(audioProcessors, videoEffects)).build()
        // The sequence's tracks are the output's: no audio track when the plan
        // drops the sound.
        val sequence =
            if (withAudio) EditedMediaItemSequence.withAudioAndVideoFrom(listOf(edited))
            else EditedMediaItemSequence.withVideoFrom(listOf(edited))
        return Composition.Builder(sequence)
            // Explicit: the default keeps HDR, and an encoder without HDR H.264
            // would then switch the output to HEVC rather than tone map.
            .setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL)
            .build()
    }

    private fun pollProgress(pass: Pass) {
        handler.postDelayed(
            {
                val transformer = pass.transformer
                if (current !== pass || transformer == null) return@postDelayed
                if (transformer.getProgress(progress) == Transformer.PROGRESS_STATE_AVAILABLE) {
                    pass.onProgress(progress.progress / 100.0)
                }
                pollProgress(pass)
            },
            PROGRESS_INTERVAL_MS,
        )
    }

    // Transformer leaves a cancelled or failed export's file where it was.
    private fun fail(pass: Pass, failure: TranscodeFailure) {
        if (current !== pass) return
        pass.output.delete()
        finish(pass) { it.onFail(failure) }
    }

    // The pass leaves the slot before its caller hears, so the next one starts
    // whatever the callback does.
    private fun finish(pass: Pass, report: (Pass) -> Unit) {
        if (current !== pass) return
        current = null
        pass.transformer = null
        try {
            report(pass)
        } finally {
            startNext()
        }
    }

    private fun cancelled() = TranscodeFailure(TranscodeMedia.CODE_CANCELLED, "transcode cancelled")

    private fun downmixToMono(): ChannelMixingAudioProcessor =
        ChannelMixingAudioProcessor().apply {
            for (channels in 1..MAX_DOWNMIX_CHANNELS) {
                putChannelMixingMatrix(ChannelMixingMatrix.createForConstantPower(channels, 1))
            }
        }

    // Frames come back upright. API 27 can scale while it decodes, which spares
    // a full-size 4K bitmap per frame; API 26 scales after.
    private fun writeFrame(
        retriever: MediaMetadataRetriever,
        timeMs: Long,
        maxEdge: Int,
        output: File,
    ) {
        val timeUs = timeMs * 1_000
        val option = MediaMetadataRetriever.OPTION_CLOSEST_SYNC
        val frame =
            if (Build.VERSION.SDK_INT >= 27) {
                retriever.getScaledFrameAtTime(timeUs, option, maxEdge, maxEdge)
            } else {
                retriever.getFrameAtTime(timeUs, option)?.let { scaledTo(it, maxEdge) }
            } ?: return
        output.outputStream().use { frame.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, it) }
        frame.recycle()
    }

    private fun scaledTo(frame: Bitmap, maxEdge: Int): Bitmap {
        val scale = maxEdge.toFloat() / maxOf(frame.width, frame.height)
        if (scale >= 1f) return frame
        val scaled =
            Bitmap.createScaledBitmap(
                frame,
                (frame.width * scale).roundToInt().coerceAtLeast(1),
                (frame.height * scale).roundToInt().coerceAtLeast(1),
                true,
            )
        frame.recycle()
        return scaled
    }

    private fun readProbe(uri: Uri): VideoProbe {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(context, uri)
            fun key(key: Int): String? = retriever.extractMetadata(key)
            if (key(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) != "yes") {
                throw TranscodeFailure(TranscodeMedia.CODE_NO_VIDEO, "no video track")
            }
            val (width, height) =
                TranscodeMedia.uprightSize(
                    key(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0,
                    key(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0,
                    key(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0,
                )
            return VideoProbe(
                durationMs = key(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0,
                width = width,
                height = height,
                hasAudio = key(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes",
            )
        } finally {
            retriever.release()
        }
    }

    private companion object {
        const val PROGRESS_INTERVAL_MS = 200L
        const val JPEG_QUALITY = 70
        // AAC-LC mono at 16 kHz, the format bitchat's clips and voice share.
        const val AUDIO_SAMPLE_RATE = 16_000
        // The widest layout ChannelMixingMatrix knows how to fold into mono.
        const val MAX_DOWNMIX_CHANNELS = 6
    }
}
