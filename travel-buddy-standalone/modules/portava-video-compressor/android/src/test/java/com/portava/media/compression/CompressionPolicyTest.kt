package com.portava.media.compression

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer

class CompressionPolicyTest {
  @Test fun preservesPortraitAndNeverUpscales() {
    assertEquals(1080 to 1920, CompressionOptions().dimensions(2160, 3840))
    assertEquals(640 to 360, CompressionOptions().dimensions(640, 360))
    assertEquals(100 to 56, CompressionOptions(maxLongEdgePx = 100).dimensions(1920, 1080))
    assertThrows(IllegalArgumentException::class.java) { CompressionOptions(maxLongEdgePx = 2).dimensions(8192, 2) }
    assertThrows(IllegalArgumentException::class.java) { CompressionOptions(maxBitrateBps = Int.MAX_VALUE).validate() }
  }
  @Test fun backgroundAndDestructionNeverRenewQueuedTokens() {
    val lifetime = CompressionLifetime()
    val first = lifetime.capture()!!
    lifetime.suspend(); assertNull(lifetime.capture()); assertFalse(lifetime.isCurrent(first))
    lifetime.resume(); val second = lifetime.capture()!!
    assertFalse(lifetime.isCurrent(first)); assertTrue(lifetime.isCurrent(second))
    lifetime.close(); lifetime.resume()
    assertNull(lifetime.capture()); assertFalse(lifetime.isCurrent(second))
  }
  private fun box(type: String, payload: ByteArray): ByteArray = ByteBuffer.allocate(payload.size + 8)
    .putInt(payload.size + 8).put(type.toByteArray(Charsets.US_ASCII)).put(payload).array()
  private fun source(payload: ByteArray, block: (File) -> Unit) {
    val file = File.createTempFile("portava-container-", ".mov")
    try { file.writeBytes(payload); block(file) } finally { file.delete() }
  }
  @Test fun allowsOnlyLocalRegularFiles() {
    source(ByteArray(20)) { file ->
      assertEquals(file.canonicalFile, compressionSource(file.toURI().toString()))
      for (uri in listOf("https://example.test/a.mov", "content://media/1", file.toURI().toString() + "?token=x")) {
        assertThrows(Exception::class.java) { compressionSource(uri) }
      }
    }
  }
  @Test fun referenceMoviesCannotReadAnotherFileOrNetworkSource() {
    fun movie(flags: Int, reference: ByteArray = ByteArray(0)): ByteArray {
      val url = box("url ", ByteBuffer.allocate(4).putInt(flags).array() + reference)
      val dref = box("dref", ByteBuffer.allocate(8).putInt(0).putInt(1).array() + url)
      return box("moov", box("trak", box("mdia", box("minf", box("dinf", dref)))))
    }
    source(movie(1)) { validateSelfContainedMovie(it) }
    source(movie(0, "file:///private/source.mov".toByteArray())) {
      assertThrows(IllegalArgumentException::class.java) { validateSelfContainedMovie(it) }
    }
    source(movie(1) + byteArrayOf(0)) {
      assertThrows(IllegalArgumentException::class.java) { validateSelfContainedMovie(it) }
    }
  }
  @Test fun refusesMirroredOrScaledTrackMatrices() {
    fun movie(a: Int): ByteArray {
      val header = ByteBuffer.allocate(84).apply {
        position(40)
        putInt(a).putInt(0).putInt(0).putInt(0).putInt(65536).putInt(0).putInt(0).putInt(0).putInt(1073741824)
      }.array()
      return box("moov", box("trak", box("tkhd", header)))
    }
    source(movie(65536)) { validateSelfContainedMovie(it) }
    for (scale in listOf(-65536, 32768)) source(movie(scale)) {
      assertThrows(IllegalArgumentException::class.java) { validateSelfContainedMovie(it) }
    }
  }
}
