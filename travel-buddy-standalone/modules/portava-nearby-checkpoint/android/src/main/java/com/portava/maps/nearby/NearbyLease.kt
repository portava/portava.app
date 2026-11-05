package com.portava.maps.nearby

import java.util.UUID

/** Pure limits shared by every radio callback; wall-clock rollback cannot extend a lease. */
internal data class NearbyLease(val service: UUID, val characteristic: UUID, val token: String, val expiresAt: Long, val monotonicEnd: Long) {
  fun live(wall: Long, monotonic: Long): Boolean = wall < expiresAt && monotonic < monotonicEnd
  fun peer(bytes: ByteArray?, rssi: Int): String? {
    if (bytes == null || bytes.size != 64 || rssi !in -127..-1) return null
    val text = bytes.toString(Charsets.US_ASCII)
    return text.takeIf { TOKEN.matches(it) && it != token }
  }
  fun read(offset: Int): ByteArray? = if (offset in 0..64) token.toByteArray(Charsets.US_ASCII).copyOfRange(offset, 64) else null
  companion object {
    const val CHARACTERISTIC = "8c541bd6-c12b-4f73-8f4f-568b374daf25"
    const val MAX_LEASE_MS = 60_000L
    const val MAX_CONNECTIONS = 2
    const val MAX_PEERS = 64
    private val TOKEN = Regex("^[0-9a-f]{64}$")
    private val V4 = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    fun parse(service: String, characteristic: String, token: String, expiresAt: Double, now: Long, elapsed: Long): NearbyLease {
      require(V4.matches(service) && characteristic == CHARACTERISTIC && TOKEN.matches(token)) { "Invalid nearby lease" }
      require(expiresAt.isFinite() && expiresAt % 1.0 == 0.0 && expiresAt > now && expiresAt - now <= MAX_LEASE_MS) { "Nearby lease expired or too long" }
      val end = expiresAt.toLong()
      return NearbyLease(UUID.fromString(service), UUID.fromString(characteristic), token, end, elapsed + end - now)
    }
  }
}
