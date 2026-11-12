package com.portava.media.compression

import java.io.File
import java.net.URI
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

internal data class CompressionOptions(val maxBitrateBps: Int = 4_000_000, val maxLongEdgePx: Int = 1920) {
  fun validate() {
    require(maxBitrateBps in 256_000..4_000_000 && maxLongEdgePx in 2..1920) { "invalid compression options" }
  }

  fun dimensions(width: Int, height: Int): Pair<Int, Int> {
    validate()
    require(width in 2..8192 && height in 2..8192 && width.toLong() * height <= 33_554_432) { "unsupported dimensions" }
    val scale = min(1.0, maxLongEdgePx.toDouble() / max(width, height))
    val outWidth = floor(width * scale / 2).toInt() * 2
    val outHeight = floor(height * scale / 2).toInt() * 2
    require(outWidth >= 2 && outHeight >= 2) { "unsupported aspect ratio" }
    return outWidth to outHeight
  }

  // Leave room for AAC and MP4 overhead. The measured output is checked too.
  fun videoBitrate(hasAudio: Boolean): Int = ((maxBitrateBps - if (hasAudio) 96_000 else 0) * 0.85).toInt()
}

internal fun compressionSource(uri: String): File {
  val parsed = URI(uri)
  require(parsed.scheme == "file" && parsed.rawAuthority == null && parsed.rawQuery == null && parsed.rawFragment == null
    && parsed.path.startsWith('/')) { "absolute local file required" }
  val source = File(parsed).canonicalFile
  require(source.isFile && source.canRead() && source.length() in 9..104_857_600) { "source unavailable or too large" }
  return source
}

/** A foreground token is never renewed for already-admitted work. */
internal class CompressionLifetime {
  private var generation = 0L
  private var foreground = true
  private var closed = false
  @Synchronized fun capture(): Long? = if (foreground && !closed) generation else null
  @Synchronized fun isCurrent(token: Long): Boolean = !closed && foreground && token == generation
  @Synchronized fun suspend() { foreground = false; generation++ }
  @Synchronized fun resume() { if (!closed) foreground = true }
  @Synchronized fun close() { closed = true; foreground = false; generation++ }
}
