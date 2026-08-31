/**
 * Global Input Intelligence — Phase 4 (Social Identity): field registration.
 *
 * §5/§52: a field joins the platform by registering a policy, not by building a
 * new engine. This registers the canonical fieldId for the Telegraph recipient
 * picker so its policy (mode `search`, entityTypes `['user']`, `personal`
 * privacy with account-enumeration resistance, `recent_only` offline, telemetry)
 * resolves from the registry. Mirrors `search/searchFields.ts` and
 * `geographic/geoFields.ts`.
 *
 * The recipient field overrides `minChars` to 0 so the picker's zero-state
 * (recent conversations / Trip Crew / followed) is served by the gateway at zero
 * characters (§14 zero-character assistance), while the `telegraph_recipient`
 * context default (minChars 2) still governs any other recipient field.
 *
 * `registerSocialFields()` is idempotent and safe to call at module load or on
 * any screen mount. Pure registry operation (no React/network) — unit-testable.
 */
import type { InputContext } from '../types/inputContext.ts';
import type { InputFieldPolicy } from '../types/fieldPolicy.ts';
import { registerField, isFieldRegistered } from '../contexts/fieldRegistry.ts';

/**
 * Canonical fieldIds for the social-identity surfaces. `telegraph.recipient`
 * matches the id used in the client audit's §50 field table for the (previously
 * missing) new-conversation recipient picker.
 */
export const SOCIAL_FIELD_IDS = {
  telegraphRecipient: 'telegraph.recipient',
} as const;

export type SocialFieldId = (typeof SOCIAL_FIELD_IDS)[keyof typeof SOCIAL_FIELD_IDS];

/** fieldId → InputContext for every social-identity field. */
export const SOCIAL_FIELD_CONTEXTS: Record<SocialFieldId, InputContext> = {
  [SOCIAL_FIELD_IDS.telegraphRecipient]: 'telegraph_recipient',
};

/** Per-field policy overrides (kept explicit so the deviation is auditable). */
const SOCIAL_FIELD_OVERRIDES: Partial<Record<SocialFieldId, Partial<InputFieldPolicy>>> = {
  // Zero-state recents/crew/followed at 0 chars (§14) — the recipient picker
  // opens with useful defaults before the user types.
  [SOCIAL_FIELD_IDS.telegraphRecipient]: { minChars: 0 },
};

let done = false;

/**
 * Register every social-identity field's policy. Idempotent — repeated calls are
 * a no-op after the first, and a field already registered (e.g. by a test) is
 * left untouched.
 */
export function registerSocialFields(): void {
  if (done) return;
  for (const [fieldId, context] of Object.entries(SOCIAL_FIELD_CONTEXTS)) {
    if (!isFieldRegistered(fieldId)) {
      registerField(fieldId, context, SOCIAL_FIELD_OVERRIDES[fieldId as SocialFieldId]);
    }
  }
  done = true;
}

/** Test-only: reset the idempotency latch so registration can be re-exercised. */
export function _resetSocialRegistration(): void {
  done = false;
}
