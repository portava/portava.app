import Foundation

@main struct NearbyPolicyFixtures {
  static func main() throws {
    let service = "683a539f-e2e2-4397-8bb4-6ab8b8c1f411"
    let own = String(repeating: "a", count: 64)
    func lease(_ expires: Double = 61_000) throws -> NearbyLease {
      try NearbyLease(service: service, characteristic: NearbyLease.characteristic, token: own, expiresAt: expires, now: 1_000, uptime: 2)
    }
    let valid = try lease()
    precondition(valid.live(now: 60_999, uptime: 61.999))
    precondition(!valid.live(now: 61_000, uptime: 61.999))
    precondition(!valid.live(now: 0, uptime: 62)) // wall clock rollback cannot extend a lease
    for invalid in [61_001.0, 1_000, 999, Double.nan, Double.infinity, 5_000.5] {
      do { _ = try lease(invalid); fatalError("accepted invalid expiry") } catch NearbyError.invalidLease {}
    }
    for args in [("short", NearbyLease.characteristic, own), (service, service, own), (service, NearbyLease.characteristic, own.uppercased())] {
      do { _ = try NearbyLease(service: args.0, characteristic: args.1, token: args.2, expiresAt: 5_000, now: 1_000, uptime: 0); fatalError("accepted invalid identity") } catch NearbyError.invalidLease {}
    }
    let peer = String(repeating: "b", count: 64)
    precondition(valid.peer(Data(peer.utf8), rssi: -60) == peer)
    for value in [own, peer + "b", String(repeating: "z", count: 64)] { precondition(valid.peer(Data(value.utf8), rssi: -60) == nil) }
    for rssi in [127, 0, -128] { precondition(valid.peer(Data(peer.utf8), rssi: rssi) == nil) }
    precondition(valid.read(offset: 0)?.count == 64 && valid.read(offset: 22)?.count == 42 && valid.read(offset: 64)?.count == 0)
    precondition(valid.read(offset: -1) == nil && valid.read(offset: 65) == nil)
    print("4 Swift nearby policy fixtures passed")
  }
}
