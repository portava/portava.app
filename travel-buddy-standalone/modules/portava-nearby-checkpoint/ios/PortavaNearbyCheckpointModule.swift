import ExpoModulesCore
import CoreBluetooth
import Foundation
import UIKit

struct NearbyOptionsRecord: Record {
  @Field var serviceUuid: String = ""
  @Field var characteristicUuid: String = ""
  @Field var token: String = ""
  @Field var expiresAtMs: Double = 0
}
public final class PortavaNearbyCheckpointModule: Module {
  private var supported: Bool {
    #if targetEnvironment(simulator)
    return false
    #else
    return true
    #endif
  }
  private var radio: NearbyRadio?
  private var foreground = true
  private var generation = 0
  private var pending: Promise?
  private func stop(_ reason: String) {
    generation += 1
    let old = radio; radio = nil; old?.stop(reason)
    pending?.reject("ERR_NEARBY_CANCELLED", "Nearby checkpoint cancelled"); pending = nil
  }
  public func definition() -> ModuleDefinition {
    Name("PortavaNearbyCheckpoint")
    Events("onCheckpoint", "onState")
    AsyncFunction("capabilities") { () -> [String: Any] in
      let supported = self.supported
      let granted = CBManager.authorization == .allowedAlways
      let powered = self.radio?.poweredOn == true
      return ["supported": supported, "permissionsGranted": granted, "bluetoothEnabled": powered,
        "bleScan": supported && granted && powered, "bleAdvertise": supported && granted && powered,
        "localPeer": supported && granted && powered, "backgroundBle": false]
    }.runOnQueue(.main)
    AsyncFunction("start") { (options: NearbyOptionsRecord, promise: Promise) in
      self.stop("replaced")
      guard self.foreground, UIApplication.shared.applicationState == .active else { promise.reject("ERR_NEARBY_FOREGROUND", "Open the trip to use nearby checkpoints"); return }
      guard self.supported else { promise.reject("ERR_NEARBY_UNAVAILABLE", "Nearby checkpoints require a Bluetooth-capable device"); return }
      do {
        let lease = try NearbyLease(service: options.serviceUuid, characteristic: options.characteristicUuid,
          token: options.token, expiresAt: options.expiresAtMs)
        let version = self.generation
        self.pending = promise
        let radio = NearbyRadio(lease: lease, checkpoint: { [weak self] token, rssi, observed in
          guard let self, self.generation == version, self.foreground else { return }
          self.sendEvent("onCheckpoint", ["token": token, "rssi": rssi, "observedAtMs": observed])
        }, state: { [weak self] state, reason in
          guard let self, self.generation == version else { return }
          if state == "running" { self.pending?.resolve(nil) }
          else { self.pending?.reject("ERR_NEARBY_UNAVAILABLE", "Nearby checkpoint radio is unavailable") }
          self.pending = nil
          var event: [String: Any] = ["state": state]
          if let reason { event["reason"] = reason }
          self.sendEvent("onState", event)
          if state != "running" { self.radio = nil }
        })
        self.radio = radio
        radio.start()
      } catch { promise.reject("ERR_NEARBY_UNAVAILABLE", "Nearby checkpoint lease is invalid or expired") }
    }.runOnQueue(.main)
    AsyncFunction("stop") { self.stop("stopped"); self.sendEvent("onState", ["state": "stopped", "reason": "stopped"]) }.runOnQueue(.main)
    OnAppEntersBackground { self.foreground = false; self.stop("background"); self.sendEvent("onState", ["state": "stopped", "reason": "background"]) }
    OnAppEntersForeground { self.foreground = true }
    OnDestroy { DispatchQueue.main.async { self.foreground = false; self.stop("destroyed") } }
    OnAppContextDestroys { DispatchQueue.main.async { self.foreground = false; self.stop("destroyed") } }
  }
}
