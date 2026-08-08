package expo.modules.openmls

/*
 * ============================================================================
 *  THIS TEST HAS NEVER BEEN EXECUTED. ITS PASSING IS UNPROVEN.
 * ============================================================================
 *
 * Do not read the presence of this file, or any green CI badge on this
 * repository, as evidence that the FFI boundary works. Nothing in this
 * repository's automated checks runs this test, and nothing can.
 *
 * WHY IT HAS NEVER RUN
 *
 * The environment this was authored in has none of what an instrumented
 * Android test requires. Audited 2026-08-08:
 *
 *   - No Android SDK. adb, emulator, sdkmanager, avdmanager all absent.
 *   - No Java and no Gradle. The module cannot be assembled locally at all.
 *   - No Rust toolchain. cargo and rustc absent, so libexpo_openmls.so cannot
 *     even be produced here, let alone loaded.
 *   - No /dev/kvm. There is no nested virtualisation, so an emulator could not
 *     run even if the SDK were installed.
 *   - No androidTest harness. This directory did not exist before this file;
 *     the module has never had instrumentation tests, and the androidx.test
 *     dependencies required to compile this file are deliberately NOT added to
 *     android/build.gradle (see PREREQUISITES).
 *
 * WHAT THAT MEANS FOR ISSUE #3556
 *
 * #3556 ("prove the FFI") stays OPEN. Bar 2 is NOT cleared. This file is the
 * written acceptance criterion, not evidence of meeting it. A compiling test is
 * not a loading test, and this one has not even been compiled.
 *
 * DELIBERATELY NOT WIRED IN
 *
 * This test is not referenced by check:all, by docs/test-gate-baseline.md, or
 * by any CI job. That is intentional. A test that cannot run must not be able
 * to report success by being skipped — a green "0 failed" from a suite that
 * silently executed nothing is the exact false-green pattern that produced
 * findings 9, 10, 13 and 16 on this project.
 *
 * PREREQUISITES FOR ACTUALLY RUNNING IT
 *
 *   1. A real Android runtime: a physical device, or an emulator on a host with
 *      KVM. A device farm (Firebase Test Lab, AWS Device Farm) or an EAS
 *      pipeline configured for instrumented tests both satisfy this. EAS does
 *      not run connectedAndroidTest by default — that is configuration work,
 *      not a flag.
 *   2. android/build.gradle needs an androidTest dependency block:
 *        androidTestImplementation "androidx.test.ext:junit:1.1.5"
 *        androidTestImplementation "androidx.test:runner:1.5.2"
 *      plus defaultConfig.testInstrumentationRunner
 *        "androidx.test.runner.AndroidJUnitRunner"
 *      Not added here so that a file which cannot run cannot alter the module's
 *      build, and so the currently-green EAS build is not put at risk.
 *   3. The Rust cross-compile must have produced libexpo_openmls.so for the
 *      target ABI and AGP must have packaged it (findings 8-13 were all
 *      failures of exactly this chain).
 *
 * WHAT IT ASSERTS — the four bars, in order
 *
 *   Bar 1  launches in an actual Android runtime
 *   Bar 2  loads the produced native .so
 *   Bar 3  crosses the UniFFI boundary
 *   Bar 4  returns a known value
 *
 * Each is a separate test so a partial pass is legible. "Bar 3 passed, bar 4
 * failed" is a real diagnosis; one monolithic green tick is not.
 */

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

import uniffi.openmls.createGroup
import uniffi.openmls.decryptMessage
import uniffi.openmls.encryptMessage
import uniffi.openmls.generateDeviceKeyPair
import uniffi.openmls.generateKeyPackage
import uniffi.openmls.processWelcome

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
        val nativeDir = File(ctx.applicationInfo.nativeLibraryDir)

        val packaged = nativeDir.listFiles()?.map { it.name } ?: emptyList()
        assertTrue(
            "$SO_NAME not packaged. nativeLibraryDir=$nativeDir contained: $packaged",
            packaged.contains(SO_NAME),
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
}
