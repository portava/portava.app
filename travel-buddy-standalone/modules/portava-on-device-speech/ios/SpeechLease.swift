import Foundation

struct SpeechLease {
  let requestId: String
  let language: String
  let wallEnd: Double
  let monotonicEnd: TimeInterval
  static func validLanguage(_ value: String) -> Bool {
    value.range(of: "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,4}\\z", options: .regularExpression) != nil
  }
  init(requestId: String, language: String, expiresAtMs: Double, wall: Double = Date().timeIntervalSince1970 * 1000, monotonic: TimeInterval = ProcessInfo.processInfo.systemUptime) throws {
    guard requestId.range(of: "^[A-Za-z0-9-]{1,64}\\z", options: .regularExpression) != nil,
      Self.validLanguage(language), expiresAtMs.isFinite, expiresAtMs > wall, expiresAtMs - wall <= 60_000 else { throw InvalidLease() }
    self.requestId = requestId; self.language = language; wallEnd = expiresAtMs
    monotonicEnd = monotonic + (expiresAtMs - wall) / 1000
  }
  func live(wall: Double = Date().timeIntervalSince1970 * 1000, monotonic: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Bool {
    wall < wallEnd && monotonic < monotonicEnd
  }
  struct InvalidLease: Error {}
}
