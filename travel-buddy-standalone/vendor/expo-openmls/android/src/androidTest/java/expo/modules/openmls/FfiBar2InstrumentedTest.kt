package expo.modules.openmls

/*
 * Real Android instrumentation: packaged Rust library, generated UniFFI calls,
 * two-party MLS exchange, and receive-ratchet replay rejection after restoring
 * serialized state. These tests are wired by android/build.gradle.
 *
 * Executed on the Android 36 ARM64 emulator during the 2026-11-05 completion
 * work. See docs/telegraph/completion-work-20261105.md for results and commands.
 * An emulator run is not signed release-app or physical-device certification.
 */

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.util.zip.ZipFile
import uniffi.openmls.OpenMlsException

import uniffi.openmls.createGroup
import uniffi.openmls.decryptMessage
import uniffi.openmls.encryptMessage
import uniffi.openmls.generateDeviceKeyPair
import uniffi.openmls.generateKeyPackage
import uniffi.openmls.processWelcome
import uniffi.openmls.sessionOwnerId

private const val SO_NAME = "libexpo_openmls.so"
private const val LIB_NAME = "expo_openmls"

@RunWith(AndroidJUnit4::class)
class FfiBar2InstrumentedTest {

    /**
     * BAR 1 — this is running inside a real Android runtime, not a JVM stub.
     *
     * Asserted rather than assumed: a Robolectric or plain-JUnit run would give
     * a passing FFI test that never touched a device, which is the failure mode
     * this whole file exists to prevent.
     */
    @Test
    fun bar1_launchesInAnActualAndroidRuntime() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        assertNotNull("no instrumentation target context — not an Android runtime", ctx)

        // A real device/emulator reports a non-zero API level and a package name.
        assertTrue("SDK_INT looks unreal: ${Build.VERSION.SDK_INT}", Build.VERSION.SDK_INT > 0)
        assertTrue("no package name — not a real app process", ctx.packageName.isNotEmpty())

        // Robolectric reports "robolectric" as the fingerprint manufacturer.
        assertTrue(
            "appears to be a simulated runtime (${Build.FINGERPRINT}) — bar 1 requires a real one",
            !Build.FINGERPRINT.contains("robolectric", ignoreCase = true),
        )
    }

    /**
     * BAR 2 — the produced .so is present in the installed APK and loads.
     *
     * Two distinct claims, deliberately separated:
     *   (a) the .so was packaged at all — findings 8 and 12 were both failures
     *       to package, which look identical to an FFI bug from Kotlin;
     *   (b) the dynamic linker accepts it — an ABI mismatch or a missing JNA
     *       dispatch library (finding 15) fails here, not at (a).
     */
    @Test
    fun bar2_loadsTheProducedNativeSo() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val testContext = InstrumentationRegistry.getInstrumentation().context
        // extractNativeLibs=false maps .so files directly out of the APK. An
        // empty nativeLibraryDir is valid; inspect the actual installed APKs.
        val apkPaths = listOf(ctx, testContext).flatMap { context ->
            listOf(context.applicationInfo.sourceDir) +
                (context.applicationInfo.splitSourceDirs?.toList() ?: emptyList())
        }.distinct()
        val compatibleEntries = Build.SUPPORTED_ABIS.map { abi -> "lib/$abi/$SO_NAME" }
        val packaged = apkPaths.any { path ->
            ZipFile(path).use { apk ->
                compatibleEntries.any { entry -> (apk.getEntry(entry)?.size ?: 0L) > 0L }
            }
        }
        assertTrue(
            "$SO_NAME missing for supported ABIs ${Build.SUPPORTED_ABIS.toList()} in $apkPaths",
            packaged,
        )

        // Throws UnsatisfiedLinkError if the linker rejects it. Not caught —
        // a swallowed load failure is worse than a red test.
        System.loadLibrary(LIB_NAME)
    }

    /**
     * BAR 3 — a call actually crosses the UniFFI boundary and comes back.
     *
     * generateDeviceKeyPair is the cheapest real crossing: no arguments, and it
     * returns a dictionary, so the generated JNA struct marshalling is
     * exercised rather than just a primitive return.
     */
    @Test
    fun bar3_crossesTheUniffiBoundary() {
        System.loadLibrary(LIB_NAME)

        val keys = generateDeviceKeyPair()

        assertNotNull("UniFFI returned null across the boundary", keys)
        assertTrue("ed25519 public key came back empty", keys.ed25519PubB64.isNotEmpty())
        assertTrue("ed25519 private key came back empty", keys.ed25519PrivB64.isNotEmpty())
        assertTrue("x25519 public key came back empty", keys.x25519PubB64.isNotEmpty())
        assertTrue("x25519 private key came back empty", keys.x25519PrivB64.isNotEmpty())
    }

    /**
     * BAR 4 — a known value survives a full round trip through Rust.
     *
     * Encrypt a known plaintext and decrypt it back. This is the strongest
     * available form of "returns a known value": key generation returns random
     * data whose correctness cannot be asserted from Kotlin, whereas an
     * encrypt/decrypt round trip has exactly one right answer.
     *
     * It also exercises the real MLS path — key package, group creation,
     * epoch-advancing encrypt — rather than a trivial echo, so a boundary that
     * works only for simple types fails here.
     */
    @Test
    fun bar4_returnsAKnownValueThroughAFullRoundTrip() {
        System.loadLibrary(LIB_NAME)

        val known = "portava-ffi-bar-2-known-value"

        val alice = generateDeviceKeyPair()
        val bob = generateDeviceKeyPair()

        val bobKeyPackage = generateKeyPackage(
            "bob",
            bob.ed25519PrivB64,
            bob.ed25519PubB64,
        )

        val group = createGroup(
            "alice",
            alice.ed25519PrivB64,
            alice.ed25519PubB64,
            bobKeyPackage.keyPackageB64,
        )
        assertTrue("group state came back empty", group.groupStateB64.isNotEmpty())
        assertTrue("welcome came back empty", group.welcomeB64.isNotEmpty())

        // Bob joins via the Welcome. This is deliberate rather than decrypting
        // with Alice's own state: in MLS a sender cannot generally decrypt its
        // own application message, so a self-decrypt round trip would fail for
        // protocol reasons and be misread as an FFI failure. The two-party path
        // is also the one the app actually uses.
        val bobState = processWelcome(group.welcomeB64, bobKeyPackage.pendingStateB64)
        assertTrue("bob's joined group state came back empty", bobState.isNotEmpty())

        assertEquals("alice", sessionOwnerId(group.groupStateB64))
        assertEquals("bob", sessionOwnerId(bobState))

        val encrypted = encryptMessage(group.groupStateB64, known)
        assertTrue("ciphertext came back empty", encrypted.ciphertextB64.isNotEmpty())
        assertTrue(
            "ciphertext is the plaintext — nothing was encrypted",
            encrypted.ciphertextB64 != known,
        )

        val decrypted = decryptMessage(bobState, encrypted.ciphertextB64)

        assertEquals(
            "round trip through the FFI did not return the known value",
            known,
            decrypted.plaintext,
        )
    }

    @Test
    fun persistedReceiveStateRejectsConsumedCiphertext() {
        System.loadLibrary(LIB_NAME)
        val alice = generateDeviceKeyPair()
        val bob = generateDeviceKeyPair()
        val pending = generateKeyPackage("bob", bob.ed25519PrivB64, bob.ed25519PubB64)
        val group = createGroup("alice", alice.ed25519PrivB64, alice.ed25519PubB64, pending.keyPackageB64)
        val bobState = processWelcome(group.welcomeB64, pending.pendingStateB64)
        val first = encryptMessage(group.groupStateB64, "first generation")
        val second = encryptMessage(first.updatedGroupStateB64, "next generation")
        val received = decryptMessage(bobState, first.ciphertextB64)
        assertEquals("first generation", received.plaintext)

        // Every bridge invocation restores from the returned persisted snapshot;
        // this specifically catches a lost receive-secret-tree write.
        try {
            decryptMessage(received.updatedGroupStateB64, first.ciphertextB64)
            fail("Consumed ciphertext decrypted again from persisted receive state")
        } catch (_: OpenMlsException.DecryptFailed) {
            // The protocol rejects the consumed generation; unrelated bridge or
            // linkage failures must fail the test instead of counting as a pass.
        }
        val next = decryptMessage(received.updatedGroupStateB64, second.ciphertextB64)
        assertEquals("next generation", next.plaintext)
    }
}
