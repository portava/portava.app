package com.portava.input.speech
import org.junit.Assert.*
import org.junit.Test

class SpeechLeaseTest {
  @Test fun requiresTheExactInstalledLocale() {
    assertTrue(SpeechLease.installed("en-US", listOf("en_US", "fr-FR")))
    assertFalse(SpeechLease.installed("en-GB", listOf("en-US")))
    assertFalse(SpeechLease.installed("fr-FR", emptyList()))
    assertFalse(SpeechLease.installed("", listOf("")))
  }
  @Test fun captureExpiresWithEitherClock() {
    val lease = SpeechLease.parse("speech-1", "fr-FR", 61000.0, 1000, 9000)
    assertTrue(lease.live(60999, 68999))
    assertFalse(lease.live(61000, 10000))
    assertFalse(lease.live(0, 69000))
  }
  @Test fun rejectsInvalidAndUnboundedSessions() {
    for (end in listOf(1000.0, 999.0, 61001.0, Double.NaN, Double.POSITIVE_INFINITY)) {
      assertThrows(IllegalArgumentException::class.java) { SpeechLease.parse("speech-1", "en-US", end, 1000, 0) }
    }
    for (language in listOf("", "en-US\n", "xx-<script>", "en_US")) {
      assertThrows(IllegalArgumentException::class.java) { SpeechLease.parse("speech-1", language, 5000.0, 1000, 0) }
    }
    assertThrows(IllegalArgumentException::class.java) { SpeechLease.parse("x".repeat(65), "en-US", 5000.0, 1000, 0) }
  }
}
