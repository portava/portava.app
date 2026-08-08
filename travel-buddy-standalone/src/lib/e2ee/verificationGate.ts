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
