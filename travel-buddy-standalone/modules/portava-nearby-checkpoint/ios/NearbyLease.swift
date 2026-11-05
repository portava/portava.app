import Foundation

struct NearbyLease {
  static let characteristic = "8c541bd6-c12b-4f73-8f4f-568b374daf25"
  static let maximumDuration: Double = 60_000
  static let maxConnections = 2
  static let maxPeers = 64
  let service: UUID
  let token: String
  let expiresAt: Double
  let monotonicEnd: TimeInterval

  init(service: String, characteristic: String, token: String, expiresAt: Double,
       now: Double = Date().timeIntervalSince1970 * 1000, uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) throws {
    guard service.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil,
      let id = UUID(uuidString: service), characteristic == Self.characteristic,
      Self.validToken(token), expiresAt.isFinite, expiresAt.rounded() == expiresAt,
      expiresAt > now, expiresAt - now <= Self.maximumDuration else { throw NearbyError.invalidLease }
    self.service = id; self.token = token; self.expiresAt = expiresAt
    self.monotonicEnd = uptime + (expiresAt - now) / 1000
  }
  func live(now: Double = Date().timeIntervalSince1970 * 1000, uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Bool { now < expiresAt && uptime < monotonicEnd }
  func peer(_ bytes: Data?, rssi: Int) -> String? {
    guard let bytes, bytes.count == 64, (-127 ... -1).contains(rssi), let text = String(data: bytes, encoding: .ascii), Self.validToken(text), text != token else { return nil }
    return text
  }
  func read(offset: Int) -> Data? {
    guard (0 ... 64).contains(offset) else { return nil }
    return Data(token.utf8).subdata(in: offset..<64)
  }
  private static func validToken(_ token: String) -> Bool { token.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }
}
enum NearbyError: Error { case invalidLease, unavailable, expired, cancelled }
