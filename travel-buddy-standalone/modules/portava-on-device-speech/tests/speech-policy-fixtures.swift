import Foundation

@main struct SpeechPolicyFixtures {
  static func main() throws {
    let lease = try SpeechLease(requestId: "speech-1", language: "fr-FR", expiresAtMs: 61000, wall: 1000, monotonic: 9)
    precondition(lease.live(wall: 60999, monotonic: 68.999))
    precondition(!lease.live(wall: 61000, monotonic: 10))
    precondition(!lease.live(wall: 0, monotonic: 69))
    for end in [1000.0, 999, 61001, Double.nan, Double.infinity] {
      precondition((try? SpeechLease(requestId: "speech-1", language: "en-US", expiresAtMs: end, wall: 1000, monotonic: 0)) == nil)
    }
    for language in ["", "en-US\n", "xx-<script>", "en_US"] { precondition(!SpeechLease.validLanguage(language)) }
    precondition(SpeechLease.validLanguage("zh-Hant-TW"))
    precondition((try? SpeechLease(requestId: String(repeating: "x", count: 65), language: "en-US", expiresAtMs: 5000, wall: 1000, monotonic: 0)) == nil)
    print("PASS: speech deadline, malformed session, selected-locale format (3 fixtures)")
  }
}
