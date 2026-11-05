package com.portava.maps.nearby
import org.junit.Assert.*
import org.junit.Test

class NearbyLeaseTest {
  private val uuid = "683a539f-e2e2-4397-8bb4-6ab8b8c1f411"
  private fun lease(expiry: Double = 61000.0) = NearbyLease.parse(uuid, NearbyLease.CHARACTERISTIC, "a".repeat(64), expiry, 1000, 2000)
  @Test fun exactExpiryAndMonotonicDeadline() {
    val lease = lease()
    assertTrue(lease.live(60999, 61999))
    assertFalse(lease.live(61000, 61999))
    assertFalse(lease.live(0, 62000))
  }
  @Test fun invalidLeaseCannotStart() {
    for (expiry in listOf(61001.0, 1000.0, 999.0, Double.NaN, Double.POSITIVE_INFINITY, 5000.5)) {
      assertThrows(IllegalArgumentException::class.java) { lease(expiry) }
    }
    assertThrows(IllegalArgumentException::class.java) { NearbyLease.parse("short", NearbyLease.CHARACTERISTIC, "a".repeat(64), 5000.0, 1000, 0) }
    assertThrows(IllegalArgumentException::class.java) { NearbyLease.parse(uuid, uuid, "a".repeat(64), 5000.0, 1000, 0) }
    assertThrows(IllegalArgumentException::class.java) { NearbyLease.parse(uuid, NearbyLease.CHARACTERISTIC, "A".repeat(64), 5000.0, 1000, 0) }
  }
  @Test fun rejectsSelfMalformedAndUnknownRssi() {
    val lease = lease()
    assertNull(lease.peer("a".repeat(64).toByteArray(), -60))
    assertNull(lease.peer("b".repeat(65).toByteArray(), -60))
    assertNull(lease.peer("b".repeat(64).toByteArray(), 127))
    assertNull(lease.peer("b".repeat(64).toByteArray(), 0))
    assertNull(lease.peer("z".repeat(64).toByteArray(), -60))
    assertEquals("b".repeat(64), lease.peer("b".repeat(64).toByteArray(), -60))
  }
  @Test fun boundedReadOffsets() {
    val lease = lease()
    assertEquals(64, lease.read(0)!!.size)
    assertEquals(42, lease.read(22)!!.size)
    assertEquals(0, lease.read(64)!!.size)
    assertNull(lease.read(-1)); assertNull(lease.read(65))
  }
}
