import Foundation
import CoreBluetooth

/** A foreground-only GATT exchange. CoreBluetooth objects and timers are all
 * main-queue confined; a radio object is never reused for another lease. */
final class NearbyRadio: NSObject, CBCentralManagerDelegate, CBPeripheralManagerDelegate, CBPeripheralDelegate {
  private let lease: NearbyLease
  private let checkpoint: (String, Int, Double) -> Void
  private let state: (String, String?) -> Void
  private var central: CBCentralManager?
  private var peripheral: CBPeripheralManager?
  private var active = true
  private var serviceAdded = false
  private var started = false
  private var attempted = Set<UUID>()
  private var emitted = Set<String>()
  private var readers: [UUID: Int] = [:]
  private var connections: [UUID: Connection] = [:]
  private var expiry: DispatchWorkItem?
  private var startup: DispatchWorkItem?
  private struct Connection { let peripheral: CBPeripheral; let rssi: Int; let timeout: DispatchWorkItem }
  private var serviceID: CBUUID { CBUUID(nsuuid: lease.service) }
  private var characteristicID: CBUUID { CBUUID(string: NearbyLease.characteristic) }
  var poweredOn: Bool { central?.state == .poweredOn && peripheral?.state == .poweredOn }
  init(lease: NearbyLease, checkpoint: @escaping (String, Int, Double) -> Void, state: @escaping (String, String?) -> Void) {
    self.lease = lease; self.checkpoint = checkpoint; self.state = state
  }
  private func live() -> Bool {
    if active && !lease.live() { stop("expired") }
    return active
  }
  func start() {
    precondition(Thread.isMainThread)
    guard live() else { return }
    let expiry = DispatchWorkItem { [weak self] in self?.stop("expired") }
    self.expiry = expiry
    DispatchQueue.main.asyncAfter(deadline: .now() + max(0, lease.monotonicEnd - ProcessInfo.processInfo.systemUptime), execute: expiry)
    // Constructing managers may prompt. This only happens after JS explicit opt-in.
    central = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: false])
    peripheral = CBPeripheralManager(delegate: self, queue: .main, options: [CBPeripheralManagerOptionShowPowerAlertKey: false])
  }
  private func beginWhenReady() {
    guard live(), let central, let peripheral else { return }
    let bad: Set<CBManagerState> = [.unauthorized, .unsupported, .poweredOff]
    if bad.contains(central.state) || bad.contains(peripheral.state) { stop("radio_unavailable"); return }
    guard poweredOn, !serviceAdded else { return }
    serviceAdded = true
    let startup = DispatchWorkItem { [weak self] in if self?.started == false { self?.stop("startup_timeout") } }
    self.startup = startup
    DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: startup)
    let service = CBMutableService(type: serviceID, primary: true)
    service.characteristics = [CBMutableCharacteristic(type: characteristicID, properties: [.read], value: nil, permissions: [.readable])]
    peripheral.add(service)
  }
  func centralManagerDidUpdateState(_ central: CBCentralManager) { beginWhenReady() }
  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) { beginWhenReady() }
  func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    guard live(), self.peripheral === peripheral else { return }
    guard error == nil, service.uuid == serviceID else { stop("service_unavailable"); return }
    // No local name, manufacturer data, stable identifier or coordinates.
    peripheral.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [serviceID]])
  }
  func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    guard live(), self.peripheral === peripheral else { return }
    guard error == nil, let central, poweredOn else { stop("advertising_unavailable"); return }
    central.scanForPeripherals(withServices: [serviceID], options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    started = true; startup?.cancel(); startup = nil
    state("running", nil)
  }
  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    guard live(), self.peripheral === peripheral, request.characteristic.uuid == characteristicID,
      request.characteristic.service?.uuid == serviceID else { peripheral.respond(to: request, withResult: .readNotPermitted); return }
    let id = request.central.identifier // transient only, never emitted or persisted
    guard readers[id] != nil || readers.count < NearbyLease.maxPeers, (readers[id] ?? 0) < 8 else {
      peripheral.respond(to: request, withResult: .insufficientResources); return
    }
    readers[id, default: 0] += 1
    guard let bytes = lease.read(offset: request.offset) else { peripheral.respond(to: request, withResult: .invalidOffset); return }
    request.value = bytes
    peripheral.respond(to: request, withResult: .success)
  }
  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    if let request = requests.first { peripheral.respond(to: request, withResult: .writeNotPermitted) }
  }
  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
    guard live(), self.central === central, connections.count < NearbyLease.maxConnections,
      attempted.count < NearbyLease.maxPeers, !attempted.contains(peripheral.identifier), (-127 ... -1).contains(RSSI.intValue),
      (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID])?.contains(serviceID) == true else { return }
    attempted.insert(peripheral.identifier)
    let timeout = DispatchWorkItem { [weak self, weak peripheral] in if let peripheral { self?.close(peripheral) } }
    connections[peripheral.identifier] = Connection(peripheral: peripheral, rssi: RSSI.intValue, timeout: timeout)
    peripheral.delegate = self
    central.connect(peripheral, options: nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: timeout)
  }
  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    guard live(), self.central === central, connections[peripheral.identifier]?.peripheral === peripheral else { close(peripheral); return }
    peripheral.discoverServices([serviceID])
  }
  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) { close(peripheral) }
  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) { close(peripheral) }
  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard live(), connections[peripheral.identifier]?.peripheral === peripheral,
      error == nil, let service = peripheral.services?.first(where: { $0.uuid == serviceID }) else { close(peripheral); return }
    peripheral.discoverCharacteristics([characteristicID], for: service)
  }
  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard live(), connections[peripheral.identifier]?.peripheral === peripheral, error == nil, service.uuid == serviceID,
      let value = service.characteristics?.first(where: { $0.uuid == characteristicID && $0.properties.contains(.read) }) else { close(peripheral); return }
    peripheral.readValue(for: value)
  }
  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    defer { close(peripheral) }
    guard live(), error == nil, let connection = connections[peripheral.identifier], connection.peripheral === peripheral,
      characteristic.uuid == characteristicID, characteristic.service?.uuid == serviceID,
      let token = lease.peer(characteristic.value, rssi: connection.rssi), emitted.count < NearbyLease.maxPeers,
      !emitted.contains(token) else { return }
    emitted.insert(token)
    checkpoint(token, connection.rssi, Date().timeIntervalSince1970 * 1000)
  }
  private func close(_ device: CBPeripheral) {
    connections.removeValue(forKey: device.identifier)?.timeout.cancel()
    device.delegate = nil
    if device.state == .connected || device.state == .connecting { central?.cancelPeripheralConnection(device) }
  }
  func stop(_ reason: String = "stopped") {
    precondition(Thread.isMainThread)
    guard active else { return }
    active = false; expiry?.cancel(); startup?.cancel(); expiry = nil; startup = nil
    central?.stopScan(); peripheral?.stopAdvertising(); peripheral?.removeAllServices()
    for connection in Array(connections.values) { close(connection.peripheral) }
    central?.delegate = nil; peripheral?.delegate = nil; central = nil; peripheral = nil
    attempted.removeAll(); emitted.removeAll(); readers.removeAll(); connections.removeAll()
    state(reason.hasSuffix("unavailable") || reason == "startup_timeout" ? "unavailable" : "stopped", reason)
  }
}
