package com.portava.media.compression

import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.system.Os
import java.io.File
import java.io.FileInputStream
import java.io.RandomAccessFile
import kotlin.math.abs

internal data class CompressionMedia(
  val width: Int, val height: Int, val durationUs: Long, val videoMime: String,
  val audioMime: String?, val audioChannels: Int?, val audioRate: Int?
)

internal data class SourceStamp(val device: Long, val inode: Long, val size: Long, val modified: Long) {
  companion object {
    fun read(file: File): SourceStamp {
      val stat = Os.stat(file.path)
      return SourceStamp(stat.st_dev, stat.st_ino, stat.st_size, file.lastModified())
    }
  }
}

/** Platform extraction is file-descriptor-only; remote/content URIs are never opened. */
internal fun probeCompressionMedia(file: File, output: Boolean = false): CompressionMedia {
  RandomAccessFile(file, "r").use {
    require(it.length() > 8) { "invalid media container" }
    it.seek(4)
    val type = ByteArray(4); it.readFully(type)
    require(String(type, Charsets.US_ASCII) == "ftyp") { "MP4 or MOV source required" }
  }
  val extractor = MediaExtractor()
  try {
    FileInputStream(file).use { extractor.setDataSource(it.fd) }
    val video = mutableListOf<MediaFormat>()
    val audio = mutableListOf<MediaFormat>()
    for (index in 0 until extractor.trackCount) {
      val format = extractor.getTrackFormat(index)
      require(!format.containsKey("crypto-key")) { "encrypted source unsupported" }
      when {
        format.getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true -> video.add(format)
        format.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true -> audio.add(format)
        output -> error("unexpected output track")
      }
    }
    require(video.size == 1 && audio.size <= 1) { "one video and at most one audio track required" }
    val v = video.single()
    val transfer = if (v.containsKey(MediaFormat.KEY_COLOR_TRANSFER)) v.getInteger(MediaFormat.KEY_COLOR_TRANSFER) else 0
    require(transfer != MediaFormat.COLOR_TRANSFER_ST2084 && transfer != MediaFormat.COLOR_TRANSFER_HLG) { "HDR requires a separate tone-mapping policy" }
    val width = v.getInteger(MediaFormat.KEY_WIDTH)
    val height = v.getInteger(MediaFormat.KEY_HEIGHT)
    require(width in 2..8192 && height in 2..8192) { "unsupported dimensions" }
    val audioFormat = audio.singleOrNull()
    val channels = audioFormat?.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
    val rate = audioFormat?.getInteger(MediaFormat.KEY_SAMPLE_RATE)
    require(channels == null || channels in 1..2) { "unsupported audio layout" }
    require(rate == null || rate in 8000..96000) { "unsupported audio rate" }
    val duration = v.getLong(MediaFormat.KEY_DURATION)
    require(duration in 1..900_000_000) { "unsupported duration" }
    val retriever = MediaMetadataRetriever()
    try {
      FileInputStream(file).use { retriever.setDataSource(it.fd) }
      val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
      require(rotation in listOf(0, 90, 180, 270)) { "unsupported rotation" }
      if (output) require(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_LOCATION).isNullOrEmpty()) { "output retained location" }
      return CompressionMedia(if (rotation % 180 == 0) width else height, if (rotation % 180 == 0) height else width,
        duration, v.getString(MediaFormat.KEY_MIME)!!, audioFormat?.getString(MediaFormat.KEY_MIME), channels, rate)
    } finally { retriever.release() }
  } finally { extractor.release() }
}

internal fun verifyCompressedCopy(source: CompressionMedia, result: CompressionMedia, file: File, sourceSize: Long,
  options: CompressionOptions, expected: Pair<Int, Int>) {
  require(file.length() in 1 until sourceSize) { "compressed copy is not smaller" }
  require(result.videoMime == "video/avc" && (result.audioMime == null || result.audioMime == "audio/mp4a-latm")) { "unexpected output codec" }
  require((source.audioMime == null) == (result.audioMime == null)) { "audio track changed" }
  require(source.audioChannels == result.audioChannels && source.audioRate == result.audioRate) { "audio layout changed" }
  require(abs(result.durationUs - source.durationUs) <= 80_000) { "duration changed" }
  require(result.width == expected.first && result.height == expected.second) { "display dimensions changed" }
  val measuredBitrate = file.length().toDouble() * 8_000_000 / result.durationUs
  require(measuredBitrate <= options.maxBitrateBps) { "output bitrate ${measuredBitrate.toLong()} exceeds ceiling ${options.maxBitrateBps}" }
}
