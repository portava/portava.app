/**
 * VERIFIED layover specialists for a fake layover world (LAYOVER 165, lane B2-BUDDY).
 *
 * Since B2-BUDDY (census-layover L273; docs/ops/layover-165-remediation-progress.md
 * "### L273", docs/architecture/census-layover.md "The specialist booking path now
 * requires verified live-mode identity, existing payout/trust checks…"), the layover
 * buddies list serves a profile only when ALL of these hold:
 *   - `layover_buddy_specialist_enabled` is ON beside `rent_buddy_enabled`
 *     (routes/airport.ts, GET /airport/sessions/:id/buddies);
 *   - the profile declares the `layover` category (LayoverBuddyGate.ts
 *     LAYOVER_COMPATIBLE_BUDDY_CATEGORIES / filterLayoverCompatible);
 *   - its owner has a current LIVE-mode, adult identity verification and an
 *     identity `profiles.verification_level`, a verified payout recipient with
 *     charges enabled, and no hosting restriction
 *     (LayoverBuddyBooking.ts verifiedLayoverSpecialists).
 *
 * A suite that tests something ELSE about the buddies list — the master flag,
 * the block read, the visa screen, the safety gate — must therefore STATE that
 * each profile it stages is a verified specialist, exactly as production needs
 * one. This adds the flag and the three reads `verifiedLayoverSpecialists` makes
 * for every `rent_buddy_profiles` row present when it is called. It does NOT add
 * the `layover` category: each suite declares that on its own profiles, so a
 * profile that lacks it is withheld for that reason and no other.
 *
 * It mutates and returns `tables` so a world builder can wrap its own object.
 * The same fixture shape as layoverBuddySafetyGate.test.ts `withConfirmedSpecialists`.
 */
type Row = Record<string, any>;

export const LAYOVER_SPECIALIST_FLAG = "layover_buddy_specialist_enabled"; // services/airport/LayoverBuddyBooking.ts LAYOVER_SPECIALIST_FLAG

export function withVerifiedLayoverSpecialists<T extends Record<string, Row[]>>(tables: T, at = "2026-01-01T00:00:00.000Z"): T {
  const t = tables as Record<string, Row[]>;
  t.feature_flags = t.feature_flags ?? [];
  if (!t.feature_flags.some((f) => f.flag === LAYOVER_SPECIALIST_FLAG)) t.feature_flags.push({ flag: LAYOVER_SPECIALIST_FLAG, enabled: true });
  const owners = [...new Set((t.rent_buddy_profiles ?? []).map((b) => String(b.user_id)))];
  t.profiles = [...(t.profiles ?? []), ...owners.map((id) => ({ id, verification_level: "id_verified" }))];
  t.identity_verifications = [...(t.identity_verifications ?? []), ...owners.map((id) => ({
    id: `id-${id}`, user_id: id, provider: "stripe", provider_mode: "live", status: "verified",
    is_over_18: true, document_country: null, verified_at: at, created_at: at,
  }))];
  t.payment_parties = [...(t.payment_parties ?? []), ...owners.map((id) => ({ id: `party-${id}`, profile_id: id, kind: "user" }))];
  t.rent_buddy_payment_recipients = [...(t.rent_buddy_payment_recipients ?? []), ...owners.map((id) => ({
    party_id: `party-${id}`, provider: "stripe", recipient_ref: "fixture", onboarding: "verified",
    charges_enabled: true, payouts_enabled: true, livemode: false,
  }))];
  return tables;
}
