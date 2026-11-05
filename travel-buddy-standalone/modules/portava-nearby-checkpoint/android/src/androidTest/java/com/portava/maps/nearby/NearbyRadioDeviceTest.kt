package com.portava.maps.nearby

import android.bluetooth.le.ScanCallback
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test

/** Real Android manager/handler lifecycle checks. An emulator cannot attest a
 * physical BLE exchange, so these prove only expiry/denial/retired callbacks. */
class NearbyRadioDeviceTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private fun lease(ttl: Long = 2000): NearbyLease = NearbyLease.parse(
    "683a539f-e2e2-4397-8bb4-6ab8b8c1f411", NearbyLease.CHARACTERISTIC, "a".repeat(64),
    (System.currentTimeMillis() + ttl).toDouble(), System.currentTimeMillis(), SystemClock.elapsedRealtime())

  @Test fun stopIsIdempotentAndRetiredScanCallbacksCannotEmit() {
    val states = mutableListOf<String>(); val checkpoints = mutableListOf<String>()
    instrumentation.runOnMainSync {
      val radio = NearbyRadio(instrumentation.targetContext, lease(), { token, _, _ -> checkpoints.add(token) }, { state, _ -> states.add(state) })
      val callback = NearbyRadio::class.java.getDeclaredField("scanCallback").apply { isAccessible = true }.get(radio) as ScanCallback
      radio.stop(); radio.stop(); callback.onScanFailed(ScanCallback.SCAN_FAILED_INTERNAL_ERROR)
    }
    instrumentation.waitForIdleSync()
    assertEquals(listOf("stopped"), states); assertTrue(checkpoints.isEmpty())
  }

  @Test fun expiredLeaseNeverStartsRadioOrEmits() {
    val expired = lease(30); Thread.sleep(60)
    val states = mutableListOf<Pair<String,String?>>()
    instrumentation.runOnMainSync {
      NearbyRadio(instrumentation.targetContext, expired, { _, _, _ -> fail("expired checkpoint") }, { state, reason -> states.add(state to reason) }).start()
    }
    assertEquals(listOf("stopped" to "expired"), states)
  }

  @Test fun unavailableRadioFailsClosedWithoutGrantedRuntimePermission() {
    val states = mutableListOf<Pair<String,String?>>()
    instrumentation.runOnMainSync {
      NearbyRadio(instrumentation.targetContext, lease(), { _, _, _ -> fail("unavailable checkpoint") }, { state, reason -> states.add(state to reason) }).start()
    }
    instrumentation.waitForIdleSync()
    assertEquals(listOf("unavailable" to "radio_unavailable"), states)
  }
}
