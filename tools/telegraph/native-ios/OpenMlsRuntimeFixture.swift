import Foundation
import UIKit

struct FixtureFailure: Error { let label: String }
func require(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
  if try !condition() { throw FixtureFailure(label: label) }
}
func rejects(_ label: String, _ operation: () throws -> Void) throws {
  var rejected = false
  do { try operation() } catch { rejected = true }
  try require(rejected, label)
}
func encode(_ data: Data) -> String { data.base64EncodedString() }
func decode(_ string: String) throws -> Data {
  var raw = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  raw += String(repeating: "=", count: (4 - raw.count % 4) % 4)
  guard let data = Data(base64Encoded: raw) else { throw FixtureFailure(label: "fixture_base64") }; return data
}
struct Persisted: Codable {
  let alice: String
  let bob: String
  let ciphertext: String
  let welcome: String
}
@main struct OpenMlsRuntimeFixture {
  static func main() {
    do { try run() } catch {
      FileHandle.standardError.write(Data("FAIL: \(error)\n".utf8)); exit(1)
    }
  }
  static func run() throws {
    #if !targetEnvironment(simulator)
    throw FixtureFailure(label: "requires_actual_ios_simulator_target")
    #endif
    try require(CommandLine.arguments.count == 3, "arguments")
    try require(UIDevice.current.systemName == "iOS", "ios_runtime")
    let mode = CommandLine.arguments[1]
    let url = URL(fileURLWithPath: CommandLine.arguments[2])
    var passed: [String] = ["actual_ios_simulator_runtime"]
    let pass: (String) -> Void = { label in
      passed.append(label); FileHandle.standardError.write(Data("PASS: \(label)\n".utf8))
    }
    if mode == "create" {
      let alice = try generateDeviceKeyPair(), bob = try generateDeviceKeyPair()
      try require(try decode(alice.ed25519PubB64).count == 32 && decode(alice.ed25519PrivB64).count == 32 && decode(bob.x25519PubB64).count == 32, "key_pair_shape")
      pass("real_uniffi_key_generation")
      let kp = try generateKeyPackage(userId: "bob-ios-fixture", deviceEd25519PrivB64: bob.ed25519PrivB64, deviceEd25519PubB64: bob.ed25519PubB64)
      let group = try createGroup(userId: "alice-ios-fixture", deviceEd25519PrivB64: alice.ed25519PrivB64, deviceEd25519PubB64: alice.ed25519PubB64, recipientKeyPackageB64: kp.keyPackageB64)
      let bobState = try processWelcome(welcomeB64: group.welcomeB64, pendingStateB64: kp.pendingStateB64)
      let aliceOwner = try sessionOwnerId(groupStateB64: group.groupStateB64), bobOwner = try sessionOwnerId(groupStateB64: bobState)
      try require(aliceOwner == "alice-ios-fixture" && bobOwner == "bob-ios-fixture" && aliceOwner != bobOwner, "session_owner_credentials")
      pass("create_join_distinct_session_owners")
      let aSafety = try deriveSafetyNumber(groupStateB64: group.groupStateB64), bSafety = try deriveSafetyNumber(groupStateB64: bobState)
      try require(aSafety == bSafety && aSafety.count == 60 && aSafety.allSatisfy(\.isNumber), "safety_numbers")
      pass("member_safety_numbers_agree")
      // Strings cross Swift/Rust in both directions, including Unicode and NUL.
      let plaintext = "Portava iOS → Bob 🌏 Đà Nẵng\u{0000} restored"
      let encrypted = try encryptMessage(groupStateB64: group.groupStateB64, plaintext: plaintext)
      try require(encrypted.ciphertextB64 != plaintext, "ciphertext_is_not_plaintext")
      let decrypted = try decryptMessage(groupStateB64: bobState, ciphertextB64: encrypted.ciphertextB64)
      try require(decrypted.plaintext == plaintext, "unicode_roundtrip")
      pass("encrypted_unicode_nul_roundtrip")
      // A top-level claimed owner is not authoritative: the exported Rust reader
      // must return the local MLS leaf credential, not caller-provided metadata.
      var bundle = try JSONSerialization.jsonObject(with: decode(encrypted.updatedGroupStateB64)) as! [String: Any]
      bundle["owner_id"] = "mallory"; bundle["user_id"] = "mallory"
      let decoy = encode(try JSONSerialization.data(withJSONObject: bundle))
      try require(try sessionOwnerId(groupStateB64: decoy) == "alice-ios-fixture", "owner_metadata_ignored")
      pass("owner_comes_from_mls_credential")
      let snapshot = Persisted(alice: encrypted.updatedGroupStateB64, bob: decrypted.updatedGroupStateB64, ciphertext: encrypted.ciphertextB64, welcome: group.welcomeB64)
      try JSONEncoder().encode(snapshot).write(to: url, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
      pass("serialized_session_written_for_new_process")
    } else if mode == "restore" {
      let saved = try JSONDecoder().decode(Persisted.self, from: Data(contentsOf: url))
      try require(try sessionOwnerId(groupStateB64: saved.alice) == "alice-ios-fixture" && sessionOwnerId(groupStateB64: saved.bob) == "bob-ios-fixture", "restored_owners")
      pass("owners_survive_fresh_process_restore")
      let next = try encryptMessage(groupStateB64: saved.alice, plaintext: "second message after process restart")
      let received = try decryptMessage(groupStateB64: saved.bob, ciphertextB64: next.ciphertextB64)
      try require(received.plaintext == "second message after process restart", "restored_roundtrip")
      pass("ratchet_survives_fresh_process_restore")
      let reply = try encryptMessage(groupStateB64: received.updatedGroupStateB64, plaintext: "Bob replies after restoring")
      let replyReceived = try decryptMessage(groupStateB64: next.updatedGroupStateB64, ciphertextB64: reply.ciphertextB64)
      try require(replyReceived.plaintext == "Bob replies after restoring", "reply_roundtrip")
      pass("bidirectional_encrypted_roundtrip")
      try rejects("replayed_ciphertext_accepted") { _ = try decryptMessage(groupStateB64: saved.bob, ciphertextB64: saved.ciphertext) }
      pass("replayed_ciphertext_refused")
      var tampered = try decode(next.ciphertextB64); tampered[tampered.count - 1] ^= 0x40
      try rejects("tampered_ciphertext_accepted") { _ = try decryptMessage(groupStateB64: saved.bob, ciphertextB64: encode(tampered)) }
      pass("tampered_ciphertext_refused")
      let other = try generateDeviceKeyPair()
      let wrongPackage = try generateKeyPackage(userId: "charlie-ios-fixture", deviceEd25519PrivB64: other.ed25519PrivB64, deviceEd25519PubB64: other.ed25519PubB64)
      try rejects("unrelated_welcome_accepted") { _ = try processWelcome(welcomeB64: saved.welcome, pendingStateB64: wrongPackage.pendingStateB64) }
      pass("wrong_recipient_welcome_refused")
      for value in ["not-a-group", "", encode(Data("{}".utf8))] {
        try rejects("malformed_session_owner_accepted") { _ = try sessionOwnerId(groupStateB64: value) }
      }
      pass("malformed_session_owner_refused")
      var invalid = try JSONSerialization.jsonObject(with: decode(saved.alice)) as! [String: Any]
      invalid["group_id_b64"] = encode(Data("wrong-group".utf8))
      try rejects("mismatched_group_accepted") { _ = try sessionOwnerId(groupStateB64: encode(try JSONSerialization.data(withJSONObject: invalid))) }
      pass("mismatched_group_state_refused")
    } else if mode == "legacy" {
      let legacy = try JSONDecoder().decode(Persisted.self, from: Data(contentsOf: url))
      try require(try sessionOwnerId(groupStateB64: legacy.alice) == "alice-ios-fixture" && sessionOwnerId(groupStateB64: legacy.bob) == "bob-ios-fixture", "legacy_owners")
      pass("legacy_060_owners_restore")
      let next = try encryptMessage(groupStateB64: legacy.alice, plaintext: "legacy session upgraded safely")
      let received = try decryptMessage(groupStateB64: legacy.bob, ciphertextB64: next.ciphertextB64)
      try require(received.plaintext == "legacy session upgraded safely", "legacy_exchange")
      pass("legacy_060_sessions_exchange_new_message")
      try rejects("legacy_updated_receive_replay") { _ = try decryptMessage(groupStateB64: received.updatedGroupStateB64, ciphertextB64: next.ciphertextB64) }
      pass("legacy_session_new_consumed_key_removed")
      let reply = try encryptMessage(groupStateB64: received.updatedGroupStateB64, plaintext: "legacy upgraded reply")
      let replyReceived = try decryptMessage(groupStateB64: next.updatedGroupStateB64, ciphertextB64: reply.ciphertextB64)
      try require(replyReceived.plaintext == "legacy upgraded reply", "legacy_reply")
      pass("legacy_060_bidirectional_exchange")
    } else { throw FixtureFailure(label: "mode") }
    let report: [String: Any] = ["mode": mode, "checks": passed, "checkCount": passed.count, "system": UIDevice.current.systemName, "systemVersion": UIDevice.current.systemVersion, "physicalDevice": false]
    print(String(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)
  }
}
