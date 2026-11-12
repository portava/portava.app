package com.portava.maps.nearby

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock

/** Main-thread confined radio. No background service, bonding, persistence, names,
 * device addresses in events, or unfiltered scan. Each instance is ONE lease. */
@SuppressLint("MissingPermission")
internal class NearbyRadio(private val context: Context, private val lease: NearbyLease,
  private val checkpoint: (String, Int, Long) -> Unit,
  private val state: (String, String?) -> Unit) {
  private val main = Handler(Looper.getMainLooper())
  private val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
  private var server: BluetoothGattServer? = null
  private var active = true
  private var scanning = false
  private var advertising = false
  private val attempted = mutableSetOf<String>()
  private val emitted = mutableSetOf<String>()
  private val clients = mutableMapOf<BluetoothGatt, Int>()
  private val incoming = mutableSetOf<BluetoothDevice>()
  private val readers = mutableMapOf<String, Int>()
  private val timeouts = mutableMapOf<BluetoothGatt, Runnable>()
  private fun live(): Boolean = active && lease.live(System.currentTimeMillis(), SystemClock.elapsedRealtime())
  private fun safely(work: () -> Unit) { try { work() } catch (_: Exception) { stop("radio_unavailable") } }
  private fun dispatch(work: () -> Unit) { main.post { if (live()) safely(work) else if (active) stop("expired") } }

  fun start() {
    check(Looper.myLooper() == Looper.getMainLooper())
    if (!live()) { stop("expired"); return }
    val available = try { adapter?.isEnabled == true && adapter.isMultipleAdvertisementSupported } catch (_: Exception) { false }
    if (!available) { stop("radio_unavailable"); return }
    main.postDelayed({ stop("expired") }, (lease.monotonicEnd - SystemClock.elapsedRealtime()).coerceAtLeast(1))
    // Startup cannot silently hang after a permission / OS failure.
    main.postDelayed({ if (live() && (!scanning || !advertising)) stop("startup_timeout") }, 8000)
    safely {
      val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
      server = manager.openGattServer(context, serverCallback) ?: throw IllegalStateException()
      val service = BluetoothGattService(lease.service, BluetoothGattService.SERVICE_TYPE_PRIMARY)
      service.addCharacteristic(BluetoothGattCharacteristic(lease.characteristic,
        BluetoothGattCharacteristic.PROPERTY_READ, BluetoothGattCharacteristic.PERMISSION_READ))
      if (server?.addService(service) != true) throw IllegalStateException()
    }
  }

  private val serverCallback = object : BluetoothGattServerCallback() {
    override fun onServiceAdded(status: Int, service: BluetoothGattService) = dispatch {
      if (status != BluetoothGatt.GATT_SUCCESS || service.uuid != lease.service) { stop("service_unavailable"); return@dispatch }
      val advertiser = adapter.bluetoothLeAdvertiser ?: throw IllegalStateException()
      val seconds = (lease.monotonicEnd - SystemClock.elapsedRealtime()).coerceIn(1, NearbyLease.MAX_LEASE_MS).toInt()
      advertiser.startAdvertising(AdvertiseSettings.Builder().setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_LOW).setConnectable(true).setTimeout(seconds).build(),
        AdvertiseData.Builder().addServiceUuid(ParcelUuid(lease.service)).setIncludeDeviceName(false).setIncludeTxPowerLevel(false).build(), advertiserCallback)
    }
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) = dispatch {
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        if (incoming.size >= NearbyLease.MAX_CONNECTIONS && device !in incoming) server?.cancelConnection(device)
        else { incoming.add(device); main.postDelayed({ if (live() && incoming.remove(device)) safely { server?.cancelConnection(device) } }, 5000) }
      } else incoming.remove(device)
    }
    override fun onCharacteristicReadRequest(device: BluetoothDevice, requestId: Int, offset: Int, characteristic: BluetoothGattCharacteristic) {
      main.post {
        val gatt = server ?: return@post
        if (!live() || characteristic.uuid != lease.characteristic || characteristic.service?.uuid != lease.service) {
          safely { gatt.sendResponse(device, requestId, BluetoothGatt.GATT_READ_NOT_PERMITTED, offset, null) }; return@post
        }
        val address = device.address // transient within this lease, never emitted or persisted
        if ((address !in readers && readers.size >= NearbyLease.MAX_PEERS) || (readers[address] ?: 0) >= 8) {
          safely { gatt.sendResponse(device, requestId, BluetoothGatt.GATT_READ_NOT_PERMITTED, offset, null) }; return@post
        }
        readers[address] = (readers[address] ?: 0) + 1
        val bytes = lease.read(offset)
        safely { gatt.sendResponse(device, requestId, if (bytes == null) BluetoothGatt.GATT_INVALID_OFFSET else BluetoothGatt.GATT_SUCCESS, offset, bytes) }
      }
    }
    override fun onCharacteristicWriteRequest(device: BluetoothDevice, requestId: Int, characteristic: BluetoothGattCharacteristic, preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray) {
      if (responseNeeded) dispatch { server?.sendResponse(device, requestId, BluetoothGatt.GATT_WRITE_NOT_PERMITTED, offset, null) }
    }
  }
  private val advertiserCallback = object : AdvertiseCallback() {
    override fun onStartSuccess(settingsInEffect: AdvertiseSettings) = dispatch {
      advertising = true
      val scanner = adapter.bluetoothLeScanner ?: throw IllegalStateException()
      scanner.startScan(listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(lease.service)).build()),
        ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).setReportDelay(0).build(), scanCallback)
      scanning = true
      state("running", null)
    }
    override fun onStartFailure(errorCode: Int) = dispatch { stop("advertising_unavailable") }
  }
  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) = dispatch {
      if (clients.size >= NearbyLease.MAX_CONNECTIONS || attempted.size >= NearbyLease.MAX_PEERS || result.rssi !in -127..-1) return@dispatch
      // Verify the actual advertised service too, rather than trusting a device/OS filter.
      if (result.scanRecord?.serviceUuids?.contains(ParcelUuid(lease.service)) != true) return@dispatch
      if (!attempted.add(result.device.address)) return@dispatch
      val gatt = result.device.connectGatt(context, false, clientCallback, BluetoothDevice.TRANSPORT_LE) ?: return@dispatch
      clients[gatt] = result.rssi
      val expiry = Runnable { close(gatt) }
      timeouts[gatt] = expiry; main.postDelayed(expiry, 5000)
    }
    override fun onScanFailed(errorCode: Int) = dispatch { stop("scan_unavailable") }
  }
  private val clientCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      main.post {
        if (!live() || gatt !in clients) { close(gatt); return@post }
        safely { if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
          if (!gatt.discoverServices()) close(gatt)
        } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) close(gatt) }
      }
    }
    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) = dispatch {
      if (gatt !in clients || status != BluetoothGatt.GATT_SUCCESS) { close(gatt); return@dispatch }
      val value = gatt.getService(lease.service)?.getCharacteristic(lease.characteristic)
      if (value == null || value.properties and BluetoothGattCharacteristic.PROPERTY_READ == 0 || !gatt.readCharacteristic(value)) close(gatt)
    }
    @Deprecated("Android below 33 callback")
    override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      if (Build.VERSION.SDK_INT < 33) received(gatt, characteristic, characteristic.value, status)
    }
    override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray, status: Int) = received(gatt, characteristic, value, status)
  }
  private fun received(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray?, statusCode: Int) {
    main.post {
      val rssi = clients[gatt]
      if (live() && rssi != null && characteristic.uuid == lease.characteristic && characteristic.service?.uuid == lease.service && statusCode == BluetoothGatt.GATT_SUCCESS) {
        lease.peer(value, rssi)?.let { token -> if (emitted.size < NearbyLease.MAX_PEERS && emitted.add(token)) checkpoint(token, rssi, System.currentTimeMillis()) }
      }
      close(gatt)
    }
  }
  private fun close(gatt: BluetoothGatt) {
    timeouts.remove(gatt)?.let(main::removeCallbacks)
    clients.remove(gatt)
    try { gatt.disconnect() } catch (_: Exception) {}
    try { gatt.close() } catch (_: Exception) {}
  }
  fun stop(reason: String = "stopped") {
    check(Looper.myLooper() == Looper.getMainLooper())
    if (!active) return
    active = false; main.removeCallbacksAndMessages(null)
    try { adapter?.bluetoothLeScanner?.stopScan(scanCallback) } catch (_: Exception) {}
    try { adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiserCallback) } catch (_: Exception) {}
    clients.keys.toList().forEach(::close)
    incoming.forEach { try { server?.cancelConnection(it) } catch (_: Exception) {} }; incoming.clear()
    try { server?.clearServices(); server?.close() } catch (_: Exception) {}; server = null
    attempted.clear(); emitted.clear(); readers.clear(); timeouts.clear(); scanning = false; advertising = false
    state(if (reason.endsWith("unavailable") || reason == "startup_timeout") "unavailable" else "stopped", reason)
  }
}
