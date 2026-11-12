package com.portava.maps.nearby

import android.Manifest
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class NearbyOptions : Record {
  @Field var serviceUuid: String = ""
  @Field var characteristicUuid: String = ""
  @Field var token: String = ""
  @Field var expiresAtMs: Double = 0.0
}

class PortavaNearbyCheckpointModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var foreground = true
  private var generation = 0L
  private var radio: NearbyRadio? = null
  private var pending: Promise? = null
  private fun permissions(): Array<String> = if (Build.VERSION.SDK_INT >= 31) arrayOf(
    Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE,
    Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION)
    else arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION)
  private fun stopInternal(reason: String) {
    generation += 1
    main.removeCallbacksAndMessages(null)
    val old = radio; radio = null; old?.stop(reason)
    pending?.reject("ERR_NEARBY_CANCELLED", "Nearby checkpoint cancelled", null); pending = null
  }
  override fun definition() = ModuleDefinition {
    Name("PortavaNearbyCheckpoint")
    Events("onCheckpoint", "onState")
    AsyncFunction("capabilities") {
      val context = appContext.reactContext
      val supported = context?.packageManager?.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) == true
      val granted = appContext.permissions?.hasGrantedPermissions(*permissions()) == true
      val adapter = context?.let { (it.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter }
      val enabled = try { adapter?.isEnabled == true } catch (_: SecurityException) { false }
      val advertise = try { adapter?.isMultipleAdvertisementSupported == true } catch (_: SecurityException) { false }
      mapOf("supported" to supported, "permissionsGranted" to granted, "bluetoothEnabled" to enabled,
        "bleScan" to (supported && granted && enabled), "bleAdvertise" to (supported && granted && enabled && advertise),
        "localPeer" to (supported && granted && enabled && advertise), "backgroundBle" to false)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("start") { options: NearbyOptions, promise: Promise ->
      stopInternal("replaced")
      val context = appContext.reactContext
      val activity = appContext.currentActivity
      if (!foreground || context == null || activity == null || !activity.hasWindowFocus() || activity.isFinishing || activity.isDestroyed) {
        promise.reject("ERR_NEARBY_FOREGROUND", "Open the trip to use nearby checkpoints", null)
      } else {
        try {
          val lease = NearbyLease.parse(options.serviceUuid, options.characteristicUuid, options.token, options.expiresAtMs, System.currentTimeMillis(), SystemClock.elapsedRealtime())
          if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) throw IllegalStateException()
          val permissionManager = appContext.permissions ?: throw IllegalStateException()
          val version = generation
          pending = promise
          main.postDelayed({ if (generation == version) { stopInternal("expired"); sendEvent("onState", mapOf("state" to "stopped", "reason" to "expired")) } }, (lease.monotonicEnd - SystemClock.elapsedRealtime()).coerceAtLeast(1))
          val launch = {
            if (generation == version && foreground && lease.live(System.currentTimeMillis(), SystemClock.elapsedRealtime())) {
              if (!permissionManager.hasGrantedPermissions(*permissions())) {
                pending?.reject("ERR_NEARBY_PERMISSION", "Nearby device and location permissions are required", null); pending = null
                stopInternal("permission_denied")
                sendEvent("onState", mapOf("state" to "unavailable", "reason" to "permission_denied"))
              } else {
                radio = NearbyRadio(context, lease, { token, rssi, observed ->
                  if (generation == version && foreground) sendEvent("onCheckpoint", mapOf("token" to token, "rssi" to rssi, "observedAtMs" to observed))
                }, { state, reason ->
                  if (generation == version) {
                    if (state == "running") { pending?.resolve(null); pending = null }
                    else { pending?.reject("ERR_NEARBY_UNAVAILABLE", "Nearby checkpoint radio is unavailable", null); pending = null }
                    sendEvent("onState", mapOf("state" to state, "reason" to reason))
                  }
                }).also { it.start() }
              }
            }
          }
          if (permissionManager.hasGrantedPermissions(*permissions())) launch()
          else permissionManager.askForPermissions({ main.post { launch() } }, *permissions())
        } catch (_: Exception) {
          if (pending === promise) pending = null
          stopInternal("unavailable")
          promise.reject("ERR_NEARBY_UNAVAILABLE", "Nearby checkpoints are unavailable on this device", null)
        }
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("stop") { stopInternal("stopped"); sendEvent("onState", mapOf("state" to "stopped", "reason" to "stopped")) }.runOnQueue(Queues.MAIN)
    OnActivityEntersBackground { foreground = false; stopInternal("background"); sendEvent("onState", mapOf("state" to "stopped", "reason" to "background")) }
    OnActivityEntersForeground { foreground = true }
    OnActivityDestroys { foreground = false; stopInternal("destroyed") }
    OnDestroy { main.post { foreground = false; stopInternal("destroyed") } }
  }
}
