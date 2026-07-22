package expo.modules.openmls

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * ExpoOpenmlsModule — Expo SDK 53+ native module for Android.
 * Wraps UniFFI-generated Kotlin bindings from openmls.udl.
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

    AsyncFunction("generateKeyPackage") {
      identityPrivB64: String,
      deviceEd25519PrivB64: String,
      deviceX25519PrivB64: String,
      ->
      generateKeyPackage(identityPrivB64, deviceEd25519PrivB64, deviceX25519PrivB64)
    }

    // ── Group operations ─────────────────────────────────────────────────────

    AsyncFunction("createGroup") {
      myIdentityPrivB64: String,
      myDeviceEd25519PrivB64: String,
      myDeviceX25519PrivB64: String,
      recipientKeyPackageB64: String,
      ->
      val result = createGroup(
        myIdentityPrivB64, myDeviceEd25519PrivB64,
        myDeviceX25519PrivB64, recipientKeyPackageB64,
      )
      mapOf("groupStateB64" to result.groupStateB64, "welcomeB64" to result.welcomeB64)
    }

    AsyncFunction("processWelcome") {
      myIdentityPrivB64: String,
      myDeviceEd25519PrivB64: String,
      myDeviceX25519PrivB64: String,
      welcomeB64: String,
      ->
      processWelcome(myIdentityPrivB64, myDeviceEd25519PrivB64, myDeviceX25519PrivB64, welcomeB64)
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

    AsyncFunction("deriveSafetyNumber") { identityPubAB64: String, identityPubBB64: String ->
      deriveSafetyNumber(identityPubAB64, identityPubBB64)
    }
  }
}
