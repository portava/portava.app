package com.portava.media.compression

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.media3.common.util.UnstableApi
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.FileInputStream
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Real MediaExtractor/Transformer/MediaCodec tests: no codec or Android API mocks. */
@UnstableApi
class VideoCompressionDeviceTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context: Context = instrumentation.targetContext
  private fun source(name: String): File {
    val file = File.createTempFile("compression-source-", ".mp4", context.cacheDir)
    instrumentation.context.assets.open(name).use { input -> file.outputStream().use { input.copyTo(it) } }
    return file
  }
  private fun digest(file: File) = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).toList()
  private fun frame(file: File): Bitmap {
    val retriever = MediaMetadataRetriever()
    try {
      FileInputStream(file).use { retriever.setDataSource(it.fd) }
      return requireNotNull(retriever.getScaledFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST, 72, 128))
    } finally { retriever.release() }
  }
  private fun location(file: File): String? {
    val retriever = MediaMetadataRetriever()
    try {
      FileInputStream(file).use { retriever.setDataSource(it.fd) }
      return retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_LOCATION)
    } finally { retriever.release() }
  }
  private fun assertDisplayedPixelsPreserved(source: File, output: File) {
    val before = frame(source); val after = frame(output)
    try {
      assertEquals(72, before.width); assertEquals(128, before.height)
      assertEquals(before.width, after.width); assertEquals(before.height, after.height)
      var difference = 0L
      for (y in 0 until before.height) for (x in 0 until before.width) {
        val a = before.getPixel(x, y); val b = after.getPixel(x, y)
        difference += kotlin.math.abs(Color.red(a) - Color.red(b)) +
          kotlin.math.abs(Color.green(a) - Color.green(b)) + kotlin.math.abs(Color.blue(a) - Color.blue(b))
      }
      assertTrue("decoded display orientation/pixels changed", difference.toDouble() / (before.width * before.height * 3) < 25)
    } finally { before.recycle(); after.recycle() }
  }
  private fun assertDecodedTone(file: File) {
    val extractor = MediaExtractor()
    var codec: MediaCodec? = null
    try {
      FileInputStream(file).use { extractor.setDataSource(it.fd) }
      val index = (0 until extractor.trackCount).first { extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)!!.startsWith("audio/") }
      val format = extractor.getTrackFormat(index)
      extractor.selectTrack(index)
      val decoder = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
      codec = decoder
      decoder.configure(format, null, null, 0); decoder.start()
      var inputEnded = false
      val samples = mutableListOf<Short>()
      val info = MediaCodec.BufferInfo()
      val deadline = android.os.SystemClock.elapsedRealtime() + 10_000
      while (samples.size < 48_000 && android.os.SystemClock.elapsedRealtime() < deadline) {
        if (!inputEnded) {
          val slot = decoder.dequeueInputBuffer(10_000)
          if (slot >= 0) {
            val buffer = requireNotNull(decoder.getInputBuffer(slot)); buffer.clear()
            val bytes = extractor.readSampleData(buffer, 0)
            inputEnded = bytes < 0
            decoder.queueInputBuffer(slot, 0, bytes.coerceAtLeast(0), if (inputEnded) 0 else extractor.sampleTime,
              if (inputEnded) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0)
            if (!inputEnded) extractor.advance()
          }
        }
        val slot = decoder.dequeueOutputBuffer(info, 10_000)
        if (slot >= 0) {
          val buffer = requireNotNull(decoder.getOutputBuffer(slot)).order(ByteOrder.LITTLE_ENDIAN)
          buffer.position(info.offset); buffer.limit(info.offset + info.size)
          while (buffer.remaining() >= 2) samples.add(buffer.short)
          decoder.releaseOutputBuffer(slot, false)
          if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
        } else if (slot == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          assertEquals(1, decoder.outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT))
          assertEquals(48_000, decoder.outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE))
        }
      }
      assertTrue("audio decoder produced too few samples", samples.size >= 24_000)
      val stable = samples.drop(4096).take(24_000)
      val energy = stable.sumOf { it.toDouble() * it } / stable.size
      val crossings = stable.zipWithNext().count { (a, b) -> a <= 0 && b > 0 }
      val frequency = crossings * 48_000.0 / stable.size
      assertTrue("audio became silent", energy > 100_000)
      assertTrue("decoded 440Hz tone changed: $frequency", frequency in 430.0..450.0)
    } finally { codec?.release(); extractor.release() }
  }
  private fun compress(engine: VideoCompressionEngine, file: File, options: CompressionOptions, allowed: Boolean = true): Result<Map<String, Any>> {
    val latch = CountDownLatch(1)
    var result: Result<Map<String, Any>>? = null
    engine.submit(context, Uri.fromFile(file).toString(), options, { allowed }) { result = it; latch.countDown() }
    assertTrue("native compression did not settle", latch.await(120, TimeUnit.SECONDS))
    return requireNotNull(result)
  }
  @Test fun encodesRotatedVideoWithAudioAndDropsLocationWithoutChangingSource() {
    val engine = VideoCompressionEngine()
    val input = source("portrait.mov")
    var output: File? = null
    try {
      val original = digest(input)
      val before = probeCompressionMedia(input)
      assertTrue(before.height > before.width)
      assertFalse("fixture must contain GPS to prove removal", location(input).isNullOrBlank())
      val reply = compress(engine, input, CompressionOptions(2_000_000, 640)).getOrThrow()
      output = File(Uri.parse(reply["uri"] as String).path!!)
      val after = probeCompressionMedia(output, true)
      assertEquals(360, after.width); assertEquals(640, after.height)
      assertEquals("video/avc", after.videoMime); assertEquals("audio/mp4a-latm", after.audioMime)
      assertEquals(before.audioChannels, after.audioChannels); assertEquals(before.audioRate, after.audioRate)
      assertTrue(output.length() < input.length())
      assertTrue(output.length().toDouble() * 8_000_000 / after.durationUs <= 2_000_000)
      assertTrue(location(output).isNullOrBlank())
      assertDisplayedPixelsPreserved(input, output)
      assertDecodedTone(output)
      assertEquals(original, digest(input))
    } finally { engine.close(); input.delete(); output?.parentFile?.deleteRecursively() }
  }
  @Test fun silentVideoStaysSilentAndHonorsTheSmallerCeiling() {
    val engine = VideoCompressionEngine()
    val input = source("silent.mp4")
    var output: File? = null
    try {
      val original = digest(input)
      val reply = compress(engine, input, CompressionOptions(1_000_000, 320)).getOrThrow()
      output = File(Uri.parse(reply["uri"] as String).path!!)
      val after = probeCompressionMedia(output, true)
      assertEquals(320, after.width); assertEquals(180, after.height); assertNull(after.audioMime)
      assertTrue(output.length().toDouble() * 8_000_000 / after.durationUs <= 1_000_000)
      assertEquals(original, digest(input))
    } finally { engine.close(); input.delete(); output?.parentFile?.deleteRecursively() }
  }
  @Test fun permissionFailureAndRetiredQueuedRequestsCannotReturnOrLeaveCopies() {
    val engine = VideoCompressionEngine()
    val input = source("silent.mp4")
    fun directories() = context.cacheDir.listFiles()!!.filter { it.name.startsWith("portava-video-") }.map { it.name }.toSet()
    val initial = directories()
    try {
      assertTrue(compress(engine, input, CompressionOptions(), false).isFailure)
      engine.suspend()
      assertTrue(compress(engine, input, CompressionOptions()).isFailure)
      engine.resume()
      val latch = CountDownLatch(2)
      val results = java.util.Collections.synchronizedList(mutableListOf<Boolean>())
      repeat(2) {
        engine.submit(context, Uri.fromFile(input).toString(), CompressionOptions(), { true }) {
          results.add(it.isFailure); latch.countDown()
        }
      }
      engine.suspend(); engine.resume()
      assertTrue(latch.await(30, TimeUnit.SECONDS))
      assertEquals(listOf(true, true), results)
      assertEquals(initial, directories())
    } finally { engine.close(); input.delete() }
  }
}
