package expo.modules.openmls

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// UniFFI-generated bindings. Generated into
// android/src/main/java/uniffi/openmls/openmls.kt by the `generateUniffiBindings`
// gradle task. This import was MISSING, so even a generated binding would not
// have resolved.
import uniffi.openmls.createGroup
import uniffi.openmls.decryptMessage
import uniffi.openmls.deriveSafetyNumber
import uniffi.openmls.encryptMessage
import uniffi.openmls.generateDeviceKeyPair
import uniffi.openmls.generateIdentityKeyPair
import uniffi.openmls.generateKeyPackage
import uniffi.openmls.processWelcome

/**
 * ExpoOpenmlsModule — Expo SDK 53+ native module for Android.
 * Wraps UniFFI-generated Kotlin bindings from src/openmls.udl.
 *
 * The JNI library (libexpo_openmls.so) is loaded at class-load time by UniFFI.
 * All functions run on the Expo coroutine dispatcher (off the main thread).
 *
 * Key material is never logged or retained beyond each function's stack frame.
 */
class ExpoOpenmlsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoOpenmls")

    // ── Key generation ───────────────────────────────────────────────────────

    AsyncFunction("generateIdentityKeyPair") {
      val result = generateIdentityKeyPair()
      mapOf("pubKeyB64" to result.pubKeyB64, "privKeyB64" to result.privKeyB64)
    }

    AsyncFunction("generateDeviceKeyPair") {
      val result = generateDeviceKeyPair()
      mapOf(
        "ed25519PubB64"  to result.ed25519PubB64,
        "ed25519PrivB64" to result.ed25519PrivB64,
        "x25519PubB64"   to result.x25519PubB64,
        "x25519PrivB64"  to result.x25519PrivB64,
      )
    }

    // ── KeyPackage ───────────────────────────────────────────────────────────

    // Returns the pending provider state alongside the KeyPackage: it holds the
    // private material processWelcome needs later.
    AsyncFunction("generateKeyPackage") {
      userId: String,
      deviceEd25519PrivB64: String,
      deviceEd25519PubB64: String,
      ->
      val result = generateKeyPackage(userId, deviceEd25519PrivB64, deviceEd25519PubB64)
      mapOf(
        "keyPackageB64"   to result.keyPackageB64,
        "pendingStateB64" to result.pendingStateB64,
      )
    }

    // ── Group operations ─────────────────────────────────────────────────────

    AsyncFunction("createGroup") {
      userId: String,
      deviceEd25519PrivB64: String,
      deviceEd25519PubB64: String,
      recipientKeyPackageB64: String,
      ->
      val result = createGroup(
        userId, deviceEd25519PrivB64, deviceEd25519PubB64, recipientKeyPackageB64,
      )
      mapOf("groupStateB64" to result.groupStateB64, "welcomeB64" to result.welcomeB64)
    }

    AsyncFunction("processWelcome") { welcomeB64: String, pendingStateB64: String ->
      processWelcome(welcomeB64, pendingStateB64)
    }

    // ── Encrypt / decrypt ────────────────────────────────────────────────────

    AsyncFunction("encryptMessage") { groupStateB64: String, plaintext: String ->
      val result = encryptMessage(groupStateB64, plaintext)
      mapOf("ciphertextB64" to result.ciphertextB64, "updatedGroupStateB64" to result.updatedGroupStateB64)
    }

    AsyncFunction("decryptMessage") { groupStateB64: String, ciphertextB64: String ->
      val result = decryptMessage(groupStateB64, ciphertextB64)
      mapOf("plaintext" to result.plaintext, "updatedGroupStateB64" to result.updatedGroupStateB64)
    }

    // ── Safety number ────────────────────────────────────────────────────────

    // Derived from the group's real member signature keys — see src/openmls.udl.
    AsyncFunction("deriveSafetyNumber") { groupStateB64: String ->
      deriveSafetyNumber(groupStateB64)
    }
  }
}
