/**
 * Whether E2EE verification UI (safety numbers) may be shown.
 *
 * FALSE, deliberately, and it must stay false until the native path is proven
 * end to end on a real device.
 *
 * The reason is specific rather than cautious. The previous safety-number
 * implementation derived its digits from identity keys that the MLS session
 * never touched, so a matching number proved nothing and could not have
 * detected a MitM. It was a verification affordance that verified nothing —
 * theatre — and users were invited to trust it.
 *
 * The derivation is now correct: it reads the signature keys actually present
 * in the group's ratchet tree (see vendor/expo-openmls derive_safety_number).
 * But "correct in Rust that has never executed on a device" is not the same as
 * "correct". Until the FFI boundary is proven by an EAS build, showing the
 * number would recreate the exact failure we just spent the day removing: a UI
 * inviting trust the underlying path has not earned.
 *
 * Keep the data correct. Keep it off screen.
 *
 * FLIP THIS ONLY AFTER: an EAS build produces a working native module AND the
 * two-device runbook (docs/security/e2ee-verification-runbook.md) passes,
 * including step 9, which is the safety-number check itself.
 *
 * This is a source constant, not a server feature flag — nothing to configure
 * and nothing to change in production to keep it off.
 */
export const E2EE_VERIFICATION_UI_ENABLED = false;

/**
 * Whether the UI may *claim* a thread is end-to-end encrypted at all.
 *
 * FALSE, deliberately, and distinct from the gate above.
 *
 * `E2EE_VERIFICATION_UI_ENABLED` gates the *verification affordance* — the
 * tappable safety number. It does not gate the **claim**. With that flag off,
 * the thread header still rendered a padlock carrying the accessibility label
 * "End-to-end encrypted". A padlock is read by every user as "this is secure",
 * and screen readers were literally announcing the claim. So the app asserted
 * verified E2EE while the verification path was switched off for not being
 * trustworthy — the claim outlived the thing that was supposed to substantiate
 * it.
 *
 * Two conditions are unmet, and either alone is sufficient to keep this false:
 *
 *   1. **FFI bar 2 is unproven.** No instrumented test has loaded the produced
 *      .so in an Android runtime and crossed the UniFFI boundary. See issue
 *      #3556 and `travel-buddy-standalone/vendor/expo-openmls/android/src/androidTest/`,
 *      whose header records that the test has never been executed.
 *   2. **The client E2EE UX gap is open.** `app/messages/[id].tsx` still offers
 *      the attachment control on encrypted threads with no `isE2ee` branch. The
 *      server now fail-closes that path, so the send surfaces as a hard error
 *      rather than a silent plaintext write.
 *
 * This does NOT reopen, redefine or downgrade finding 14. That finding was the
 * *server-side* plaintext-media bypass; it is fixed (`9b1f49bdc`) and its status
 * is accurate. This constant addresses the separate client/product claim gap.
 *
 * Scope: with zero `is_e2ee` threads in production (schema evidence,
 * 2026-08-08), this is preventive rather than corrective — no user is currently
 * being shown a false claim. It closes the hole before the first encrypted
 * thread exists.
 *
 * FLIP THIS ONLY AFTER both conditions above are met. It is a source constant,
 * not a server feature flag — nothing to configure in production to keep it off.
 */
export const E2EE_CLAIM_UI_ENABLED = false;
