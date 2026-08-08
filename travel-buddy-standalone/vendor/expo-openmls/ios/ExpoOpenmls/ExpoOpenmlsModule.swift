import ExpoModulesCore

// ExpoOpenmlsModule — Expo SDK 53+ native module.
// Wraps UniFFI-generated Swift bindings from openmls.udl.
//
// All async functions run on a background thread (Expo handles this automatically
// for AsyncFunction definitions). Key material is never logged or retained beyond
// the scope of each function call.

public class ExpoOpenmlsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoOpenmls")

    // ── Key generation ──────────────────────────────────────────────────────

    AsyncFunction("generateIdentityKeyPair") { () throws -> [String: String] in
      let result = try generateIdentityKeyPair()
      return [
        "pubKeyB64":  result.pubKeyB64,
        "privKeyB64": result.privKeyB64,
      ]
    }

    AsyncFunction("generateDeviceKeyPair") { () throws -> [String: String] in
      let result = try generateDeviceKeyPair()
      return [
        "ed25519PubB64":  result.ed25519PubB64,
        "ed25519PrivB64": result.ed25519PrivB64,
        "x25519PubB64":   result.x25519PubB64,
        "x25519PrivB64":  result.x25519PrivB64,
      ]
    }

    // ── KeyPackage ──────────────────────────────────────────────────────────

    AsyncFunction("generateKeyPackage") {
      (userId: String, deviceEd25519PrivB64: String, deviceEd25519PubB64: String)
      throws -> [String: String] in
      let result = try generateKeyPackage(
        userId:                userId,
        deviceEd25519PrivB64:  deviceEd25519PrivB64,
        deviceEd25519PubB64:   deviceEd25519PubB64
      )
      return [
        "keyPackageB64":    result.keyPackageB64,
        "pendingStateB64":  result.pendingStateB64,
      ]
    }

    // ── Group operations ────────────────────────────────────────────────────

    AsyncFunction("createGroup") {
      (userId: String, deviceEd25519PrivB64: String,
       deviceEd25519PubB64: String, recipientKeyPackageB64: String)
      throws -> [String: String] in
      let result = try createGroup(
        userId:                  userId,
        deviceEd25519PrivB64:    deviceEd25519PrivB64,
        deviceEd25519PubB64:     deviceEd25519PubB64,
        recipientKeyPackageB64:  recipientKeyPackageB64
      )
      return [
        "groupStateB64": result.groupStateB64,
        "welcomeB64":    result.welcomeB64,
      ]
    }

    AsyncFunction("processWelcome") {
      (welcomeB64: String, pendingStateB64: String)
      throws -> String in
      return try processWelcome(
        welcomeB64:       welcomeB64,
        pendingStateB64:  pendingStateB64
      )
    }

    // ── Encrypt / decrypt ───────────────────────────────────────────────────

    AsyncFunction("encryptMessage") {
      (groupStateB64: String, plaintext: String)
      throws -> [String: String] in
      let result = try encryptMessage(groupStateB64: groupStateB64, plaintext: plaintext)
      return [
        "ciphertextB64":         result.ciphertextB64,
        "updatedGroupStateB64":  result.updatedGroupStateB64,
      ]
    }

    AsyncFunction("decryptMessage") {
      (groupStateB64: String, ciphertextB64: String)
      throws -> [String: String] in
      let result = try decryptMessage(groupStateB64: groupStateB64, ciphertextB64: ciphertextB64)
      return [
        "plaintext":             result.plaintext,
        "updatedGroupStateB64":  result.updatedGroupStateB64,
      ]
    }

    // ── Safety number ───────────────────────────────────────────────────────

    // Derived from the group's real member keys — see openmls.udl.
    AsyncFunction("deriveSafetyNumber") {
      (groupStateB64: String) throws -> String in
      return try deriveSafetyNumber(groupStateB64: groupStateB64)
    }
  }
}
