// Camera pictures into the encoder: a YUV 4:2:0 frame held as plain arrays,
// and the scaler that rotates it upright, centre-crops it to the stream's 3:4
// and downsamples it into the encoder's input image.
//
// Ported from bitchat-android's YuvFrames, which is public domain. Index maps
// are cached per source geometry, so the steady state is one gather per pixel.
package org.onemindlabs.airhop.video

import android.media.Image
import androidx.camera.core.ImageProxy

internal class YuvSource(
    val width: Int,
    val height: Int,
    val y: ByteArray,
    val yRowStride: Int,
    val u: ByteArray,
    val v: ByteArray,
    val uvRowStride: Int,
    val uvPixelStride: Int,
    // Clockwise rotation that makes the picture upright.
    val rotationDegrees: Int,
) {
    companion object {
        fun fromImageProxy(image: ImageProxy): YuvSource {
            val planes = image.planes
            fun read(plane: ImageProxy.PlaneProxy): ByteArray {
                val buffer = plane.buffer.duplicate()
                buffer.rewind()
                return ByteArray(buffer.remaining()).also(buffer::get)
            }
            return YuvSource(
                image.width,
                image.height,
                read(planes[0]),
                planes[0].rowStride,
                read(planes[1]),
                read(planes[2]),
                planes[1].rowStride,
                planes[1].pixelStride,
                image.imageInfo.rotationDegrees,
            )
        }
    }
}

internal class YuvScaler(private val targetWidth: Int, private val targetHeight: Int) {
    private enum class ChromaLayout {
        PLANAR,
        NV12,
        NV21,
        UNKNOWN,
    }

    private var key: List<Int>? = null
    private var lumaMap = IntArray(0)
    private var chromaMap = IntArray(0)
    private var rowY = ByteArray(0)
    private var rowU = ByteArray(0)
    private var rowV = ByteArray(0)
    private var rowUV = ByteArray(0)
    private var layout: ChromaLayout? = null

    // Codec input buffers are often uncached hardware memory, where a byte
    // write costs about a microsecond, so rows are gathered locally and copied
    // in bulk.
    fun writeInto(source: YuvSource, image: Image) {
        prepare(source)
        val planes = image.planes
        val yPlane = planes[0]
        if (rowY.size != targetWidth) {
            rowY = ByteArray(targetWidth)
            rowU = ByteArray(targetWidth / 2)
            rowV = ByteArray(targetWidth / 2)
            rowUV = ByteArray(targetWidth)
        }
        val yBuffer = yPlane.buffer.duplicate()
        val sourceY = source.y
        val sourceU = source.u
        val sourceV = source.v
        val luma = lumaMap
        val chromaOffsets = chromaMap
        var index = 0
        for (row in 0 until targetHeight) {
            for (column in 0 until targetWidth) rowY[column] = sourceY[luma[index++]]
            if (yPlane.pixelStride == 1) {
                yBuffer.position(row * yPlane.rowStride)
                yBuffer.put(rowY, 0, minOf(targetWidth, yBuffer.remaining()))
            } else {
                for (column in 0 until targetWidth) {
                    yBuffer.put(row * yPlane.rowStride + column * yPlane.pixelStride, rowY[column])
                }
            }
        }

        val uPlane = planes[1]
        val vPlane = planes[2]
        val chroma = layout ?: detectLayout(uPlane, vPlane).also { layout = it }
        val uBuffer = uPlane.buffer.duplicate()
        val vBuffer = vPlane.buffer.duplicate()
        val half = targetWidth / 2
        index = 0
        for (row in 0 until targetHeight / 2) {
            for (column in 0 until half) {
                val offset = chromaOffsets[index++]
                rowU[column] = if (offset < sourceU.size) sourceU[offset] else NEUTRAL
                rowV[column] = if (offset < sourceV.size) sourceV[offset] else NEUTRAL
            }
            when (chroma) {
                ChromaLayout.PLANAR -> {
                    uBuffer.position(row * uPlane.rowStride)
                    uBuffer.put(rowU, 0, minOf(half, uBuffer.remaining()))
                    vBuffer.position(row * vPlane.rowStride)
                    vBuffer.put(rowV, 0, minOf(half, vBuffer.remaining()))
                }
                ChromaLayout.NV12,
                ChromaLayout.NV21 -> {
                    val first = if (chroma == ChromaLayout.NV12) rowU else rowV
                    val second = if (chroma == ChromaLayout.NV12) rowV else rowU
                    for (column in 0 until half) {
                        rowUV[column * 2] = first[column]
                        rowUV[column * 2 + 1] = second[column]
                    }
                    val target = if (chroma == ChromaLayout.NV12) uBuffer else vBuffer
                    val other = if (chroma == ChromaLayout.NV12) vBuffer else uBuffer
                    val rowStride =
                        if (chroma == ChromaLayout.NV12) uPlane.rowStride else vPlane.rowStride
                    target.position(row * rowStride)
                    val length = minOf(targetWidth, target.remaining())
                    target.put(rowUV, 0, length)
                    // The leading plane's buffer can end a byte short of the
                    // last interleaved sample.
                    if (length < targetWidth)
                        other.put(row * rowStride + targetWidth - 2, rowUV[targetWidth - 1])
                }
                ChromaLayout.UNKNOWN ->
                    for (column in 0 until half) {
                        uBuffer.put(
                            row * uPlane.rowStride + column * uPlane.pixelStride,
                            rowU[column],
                        )
                        vBuffer.put(
                            row * vPlane.rowStride + column * vPlane.pixelStride,
                            rowV[column],
                        )
                    }
            }
        }
    }

    // Whether U and V interleave in one buffer, and in which order, by probing
    // whether a write to one shows through the other.
    private fun detectLayout(uPlane: Image.Plane, vPlane: Image.Plane): ChromaLayout {
        if (uPlane.pixelStride == 1 && vPlane.pixelStride == 1) return ChromaLayout.PLANAR
        if (
            uPlane.pixelStride != 2 ||
                vPlane.pixelStride != 2 ||
                uPlane.rowStride != vPlane.rowStride
        ) {
            return ChromaLayout.UNKNOWN
        }
        val u = uPlane.buffer
        val v = vPlane.buffer
        if (u.capacity() < 2 || v.capacity() < 2) return ChromaLayout.UNKNOWN
        fun aliases(writer: java.nio.ByteBuffer, reader: java.nio.ByteBuffer): Boolean {
            val saved = writer.get(1)
            val probe = (reader.get(0).toInt() xor 0x5A).toByte()
            writer.put(1, probe)
            val hit = reader.get(0) == probe
            writer.put(1, saved)
            return hit
        }
        return when {
            aliases(u, v) -> ChromaLayout.NV12
            aliases(v, u) -> ChromaLayout.NV21
            else -> ChromaLayout.UNKNOWN
        }
    }

    private fun prepare(source: YuvSource) {
        val newKey =
            listOf(
                source.width,
                source.height,
                source.yRowStride,
                source.uvRowStride,
                source.uvPixelStride,
                source.rotationDegrees,
            )
        if (newKey == key) return
        key = newKey
        val rotation = ((source.rotationDegrees % 360) + 360) % 360
        val uprightWidth = if (rotation == 90 || rotation == 270) source.height else source.width
        val uprightHeight = if (rotation == 90 || rotation == 270) source.width else source.height
        // Centre-crop the upright picture to the target's aspect, then sample.
        val scale =
            minOf(uprightWidth.toDouble() / targetWidth, uprightHeight.toDouble() / targetHeight)
        val offsetX = (uprightWidth - targetWidth * scale) / 2.0
        val offsetY = (uprightHeight - targetHeight * scale) / 2.0

        fun sourcePoint(ux: Int, uy: Int): Pair<Int, Int> =
            when (rotation) {
                90 -> uy to (source.height - 1 - ux)
                180 -> (source.width - 1 - ux) to (source.height - 1 - uy)
                270 -> (source.width - 1 - uy) to ux
                else -> ux to uy
            }

        lumaMap = IntArray(targetWidth * targetHeight)
        var index = 0
        for (row in 0 until targetHeight) {
            val uy = (offsetY + (row + 0.5) * scale).toInt().coerceIn(0, uprightHeight - 1)
            for (column in 0 until targetWidth) {
                val ux = (offsetX + (column + 0.5) * scale).toInt().coerceIn(0, uprightWidth - 1)
                val (sx, sy) = sourcePoint(ux, uy)
                lumaMap[index++] = sy * source.yRowStride + sx
            }
        }
        chromaMap = IntArray((targetWidth / 2) * (targetHeight / 2))
        index = 0
        for (row in 0 until targetHeight / 2) {
            val uy = (offsetY + (row * 2 + 1) * scale).toInt().coerceIn(0, uprightHeight - 1)
            for (column in 0 until targetWidth / 2) {
                val ux = (offsetX + (column * 2 + 1) * scale).toInt().coerceIn(0, uprightWidth - 1)
                val (sx, sy) = sourcePoint(ux, uy)
                chromaMap[index++] = (sy / 2) * source.uvRowStride + (sx / 2) * source.uvPixelStride
            }
        }
    }

    private companion object {
        const val NEUTRAL: Byte = 0x80.toByte()
    }
}
