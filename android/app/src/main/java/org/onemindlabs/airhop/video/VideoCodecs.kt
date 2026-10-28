// The MediaCodec and MediaMuxer pieces behind AirhopVideoModule: Annex B
// helpers, an H.264 encoder fed with camera YUV, and an MP4 writer.
//
// Ported from bitchat-android's live video codecs, which are public domain, so
// a stream encoded here decodes in bitchat and its recording is the same MP4.
// The wire carries Annex B with 4-byte start codes and SPS + PPS in-band on
// every IDR.
package org.onemindlabs.airhop.video

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Build
import android.os.Bundle
import android.util.Log
import java.io.File
import java.nio.ByteBuffer

internal object VideoNal {
    const val TYPE_SPS = 7
    const val TYPE_PPS = 8
    const val TYPE_AUD = 9
    const val TYPE_FILLER = 12
    private val START_CODE = byteArrayOf(0, 0, 0, 1)

    // NAL units of an Annex B buffer, without their start codes.
    fun split(data: ByteArray): List<ByteArray> {
        val starts = ArrayList<Pair<Int, Int>>()
        var i = 0
        while (i + 3 <= data.size) {
            if (data[i].toInt() == 0 && data[i + 1].toInt() == 0) {
                if (data[i + 2].toInt() == 1) {
                    starts.add(i + 3 to 3)
                    i += 3
                    continue
                }
                if (i + 4 <= data.size && data[i + 2].toInt() == 0 && data[i + 3].toInt() == 1) {
                    starts.add(i + 4 to 4)
                    i += 4
                    continue
                }
            }
            i++
        }
        return starts.mapIndexedNotNull { position, (offset, _) ->
            val end =
                if (position + 1 < starts.size) {
                    starts[position + 1].first - starts[position + 1].second
                } else {
                    data.size
                }
            if (end > offset) data.copyOfRange(offset, end) else null
        }
    }

    fun type(nal: ByteArray): Int = if (nal.isEmpty()) -1 else nal[0].toInt() and 0x1F

    fun join(nals: List<ByteArray>): ByteArray {
        val out = java.io.ByteArrayOutputStream(nals.sumOf { it.size + 4 })
        for (nal in nals) {
            out.write(START_CODE)
            out.write(nal)
        }
        return out.toByteArray()
    }

    fun parameterSets(data: ByteArray): Pair<ByteArray, ByteArray>? {
        val nals = split(data)
        val sps = nals.firstOrNull { type(it) == TYPE_SPS } ?: return null
        val pps = nals.firstOrNull { type(it) == TYPE_PPS } ?: return null
        return sps to pps
    }

    fun containsType(data: ByteArray, nalType: Int): Boolean =
        split(data).any { type(it) == nalType }

    // Filler NAL units pad a CBR encoder's bitrate: pure airtime cost.
    fun withoutFiller(data: ByteArray): ByteArray {
        val nals = split(data)
        if (nals.none { type(it) == TYPE_FILLER }) return data
        return join(nals.filter { type(it) != TYPE_FILLER })
    }

    // The access unit without SPS, PPS and AUD, for a muxer whose track format
    // already carries them.
    fun withoutParameterSets(data: ByteArray): ByteArray =
        join(
            split(data).filter {
                type(it) != TYPE_SPS && type(it) != TYPE_PPS && type(it) != TYPE_AUD
            }
        )

    fun withStartCode(nal: ByteArray): ByteArray = START_CODE + nal
}

internal class EncodedVideoFrame(val annexB: ByteArray, val ptsUs: Long, val keyframe: Boolean)

/**
 * H.264 Constrained Baseline fed with YUV pictures through `getInputImage`, which works for every
 * flexible-YUV encoder whatever its native layout. [encode] and [drain] may run on different
 * threads, as MediaCodec allows.
 */
internal class H264Encoder(
    val width: Int,
    val height: Int,
    private val fps: Int,
    bitrate: Int,
    keyframeIntervalSeconds: Int,
) {
    private val codec: MediaCodec
    private val scaler = YuvScaler(width, height)
    @Volatile private var parameterSets: ByteArray? = null
    @Volatile private var outputFormat: MediaFormat? = null
    @Volatile private var currentBitrate: Int = bitrate

    init {
        val format = { withProfile: Boolean ->
            MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
                setInteger(
                    MediaFormat.KEY_COLOR_FORMAT,
                    MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible,
                )
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                setInteger(MediaFormat.KEY_FRAME_RATE, fps)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, keyframeIntervalSeconds)
                if (withProfile) {
                    setInteger(
                        MediaFormat.KEY_PROFILE,
                        MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline,
                    )
                    setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel31)
                }
            }
        }
        codec = createConfigured(format)
        codec.start()
    }

    private fun createConfigured(format: (Boolean) -> MediaFormat): MediaCodec {
        val candidates =
            MediaCodecList(MediaCodecList.REGULAR_CODECS)
                .codecInfos
                .filter { info ->
                    info.isEncoder &&
                        info.supportedTypes.any { it.equals(MediaFormat.MIMETYPE_VIDEO_AVC, true) }
                }
                .filter { info ->
                    runCatching {
                            info
                                .getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC)
                                .videoCapabilities
                                ?.isSizeSupported(width, height) == true
                        }
                        .getOrDefault(false)
                }
                .sortedBy { info -> if (info.isHardwareAcceleratedCompat()) 0 else 1 }
        for (info in candidates) {
            val capabilities = info.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC)
            val attempt = format(true)
            // CBR keeps each second's airtime predictable on a link with no
            // spare capacity.
            if (
                capabilities.encoderCapabilities?.isBitrateModeSupported(
                    MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR
                ) == true
            ) {
                attempt.setInteger(
                    MediaFormat.KEY_BITRATE_MODE,
                    MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR,
                )
            }
            val codec =
                runCatching { MediaCodec.createByCodecName(info.name) }.getOrNull() ?: continue
            val configured = runCatching {
                codec.configure(attempt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            }
                .recoverCatching {
                    // Some encoders refuse an explicit profile or bitrate
                    // mode; retry plainly.
                    codec.reset()
                    codec.configure(format(false), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                }
            if (configured.isSuccess) return codec
            codec.release()
        }
        return MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC).also {
            it.configure(format(false), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        }
    }

    // False when the encoder had no free input, and the frame was dropped.
    fun encode(source: YuvSource, ptsUs: Long): Boolean {
        val index = codec.dequeueInputBuffer(0L)
        if (index < 0) return false
        val image = codec.getInputImage(index)
        if (image == null) {
            codec.queueInputBuffer(index, 0, 0, ptsUs, 0)
            return false
        }
        scaler.writeInto(source, image)
        codec.queueInputBuffer(index, 0, width * height * 3 / 2, ptsUs, 0)
        return true
    }

    fun signalEndOfStream() {
        val index = codec.dequeueInputBuffer(100_000L)
        if (index >= 0)
            codec.queueInputBuffer(index, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
    }

    fun requestKeyframe() {
        runCatching {
            codec.setParameters(
                Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }
            )
        }
    }

    fun setBitrate(bitrate: Int) {
        if (bitrate == currentBitrate) return
        currentBitrate = bitrate
        runCatching {
            codec.setParameters(
                Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, bitrate) }
            )
        }
    }

    // Pulls what output there is; true once end of stream was seen. Keyframes
    // reach [onFrame] with SPS and PPS in front, as the wire wants them.
    fun drain(waitUs: Long, onFrame: (EncodedVideoFrame) -> Unit): Boolean {
        val info = MediaCodec.BufferInfo()
        while (true) {
            val index = codec.dequeueOutputBuffer(info, waitUs)
            when {
                index == MediaCodec.INFO_TRY_AGAIN_LATER -> return false
                index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> outputFormat = codec.outputFormat
                index >= 0 -> {
                    val buffer = codec.getOutputBuffer(index)
                    val endOfStream = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                    if (buffer != null && info.size > 0) {
                        buffer.position(info.offset)
                        buffer.limit(info.offset + info.size)
                        val bytes = ByteArray(info.size).also(buffer::get)
                        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                            parameterSets = bytes
                        } else {
                            val keyframe = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
                            onFrame(
                                EncodedVideoFrame(
                                    forWire(bytes, keyframe),
                                    info.presentationTimeUs,
                                    keyframe,
                                )
                            )
                        }
                    }
                    codec.releaseOutputBuffer(index, false)
                    if (endOfStream) return true
                }
            }
        }
    }

    private fun forWire(annexB: ByteArray, keyframe: Boolean): ByteArray {
        if (!keyframe) return VideoNal.withoutFiller(annexB)
        if (VideoNal.containsType(annexB, VideoNal.TYPE_SPS)) return annexB
        val csd =
            parameterSets
                ?: outputFormat?.let { format ->
                    val sps = format.getByteBuffer("csd-0")?.toByteArray() ?: return@let null
                    val pps = format.getByteBuffer("csd-1")?.toByteArray() ?: return@let null
                    sps + pps
                }
                ?: return annexB
        return csd + VideoNal.withoutFiller(annexB)
    }

    fun release() {
        runCatching { codec.stop() }
        runCatching { codec.release() }
    }
}

/**
 * MediaMuxer around already-encoded H.264 and raw AAC. Nothing is written before a keyframe with
 * SPS and PPS, which sets the track format; a sample at or before its track's last pts is dropped.
 * Never throws.
 */
internal class Mp4Writer(
    val file: File,
    private val width: Int,
    private val height: Int,
    private val includeAudio: Boolean,
) {
    private var muxer: MediaMuxer? = null
    private var videoTrack = -1
    private var audioTrack = -1
    private var lastVideoPts = -1L
    private var lastAudioPts = -1L
    private var firstPts = -1L
    private var endPts = 0L
    private var videoSamples = 0
    private var failed = false

    val durationMs: Long
        @Synchronized get() = if (firstPts < 0) 0 else (endPts - firstPts) / 1_000

    @Synchronized
    fun writeVideo(annexB: ByteArray, ptsUs: Long, keyframe: Boolean) {
        if (failed || ptsUs <= lastVideoPts) return
        if (muxer == null) {
            if (!keyframe) return
            val sets = VideoNal.parameterSets(annexB) ?: return
            if (!start(sets.first, sets.second)) return
            firstPts = ptsUs
        }
        val sample = VideoNal.withoutParameterSets(annexB)
        if (sample.isEmpty()) return
        write(videoTrack, sample, ptsUs, keyframe)
        lastVideoPts = ptsUs
        videoSamples++
    }

    @Synchronized
    fun writeAudio(aac: ByteArray, ptsUs: Long) {
        if (failed || !includeAudio || muxer == null || audioTrack < 0) return
        if (ptsUs <= lastAudioPts || ptsUs < firstPts) return
        write(audioTrack, aac, ptsUs, false)
        lastAudioPts = ptsUs
    }

    // False, and no file left, when no picture was written.
    @Synchronized
    fun finish(): Boolean {
        val mediaMuxer = muxer
        muxer = null
        val ok =
            mediaMuxer != null &&
                videoSamples > 0 &&
                !failed &&
                runCatching { mediaMuxer.stop() }.isSuccess
        runCatching { mediaMuxer?.release() }
        if (!ok) file.delete()
        return ok
    }

    @Synchronized
    fun cancel() {
        runCatching { muxer?.release() }
        muxer = null
        file.delete()
    }

    private fun start(sps: ByteArray, pps: ByteArray): Boolean =
        try {
            file.parentFile?.mkdirs()
            file.delete()
            val format =
                MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
                    setByteBuffer("csd-0", ByteBuffer.wrap(VideoNal.withStartCode(sps)))
                    setByteBuffer("csd-1", ByteBuffer.wrap(VideoNal.withStartCode(pps)))
                }
            val mediaMuxer =
                MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            videoTrack = mediaMuxer.addTrack(format)
            if (includeAudio) audioTrack = mediaMuxer.addTrack(aacFormat())
            mediaMuxer.start()
            muxer = mediaMuxer
            true
        } catch (error: Exception) {
            Log.w(TAG, "MP4 muxer unavailable: ${error.message}")
            failed = true
            false
        }

    private fun write(track: Int, data: ByteArray, ptsUs: Long, keyframe: Boolean) {
        val mediaMuxer = muxer ?: return
        val info =
            MediaCodec.BufferInfo().apply {
                set(0, data.size, ptsUs, if (keyframe) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
            }
        try {
            mediaMuxer.writeSampleData(track, ByteBuffer.wrap(data), info)
            endPts = maxOf(endPts, ptsUs)
        } catch (error: Exception) {
            Log.w(TAG, "Dropping a sample: ${error.message}")
        }
    }

    private fun aacFormat(): MediaFormat =
        MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, 16_000, 1).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            // AudioSpecificConfig: AAC-LC, 16 kHz (index 8), mono.
            setByteBuffer("csd-0", ByteBuffer.wrap(byteArrayOf(0x14, 0x08)))
        }
}

internal fun ByteBuffer.toByteArray(): ByteArray {
    val copy = duplicate()
    copy.rewind()
    return ByteArray(copy.remaining()).also(copy::get)
}

private fun MediaCodecInfo.isHardwareAcceleratedCompat(): Boolean =
    if (Build.VERSION.SDK_INT >= 29) {
        isHardwareAccelerated
    } else {
        !name.startsWith("OMX.google.") && !name.startsWith("c2.android.")
    }
