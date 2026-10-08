/**
 * currentVerification — the ONE definition of "this person holds a current,
 * real identity verification", used by every consumer that must not accept less.
 *
 * ── THE OWNER'S RULINGS THIS ENCODES (2026-10-04) ────────────────────────────
 *   • Rent-a-Buddy: "No unverified bookings. Require identity and
 *     payment-provider verification before someone can offer or book the
 *     service." The mission text adds: "real identity verification. No tester
 *     bypass or sandbox verification key. Keep booking paths fail-closed."
 *   • Buddy payment eligibility: "Allow only adults who pass identity
 *     verification, provider onboarding, and safety checks, in supported
 *     markets. No payments for minors."
 *   • Verified badge: "Yes, for a defined, current verification state only.
 *     Make criteria visible; don't sell the badge or present it as an
 *     endorsement."
 *
 * ── THE DEFINITION (each clause is a criterion a user can be shown) ─────────
 *   1. The person's MOST RECENT finished verification attempt
 *      (`identity_verifications` row whose status is verified, failed, expired
 *      or canceled) is `verified`. An attempt still in progress changes
 *      nothing; a later failed or canceled attempt ends the earlier success.
 *   2. That attempt ran in a mode that counts: `live` — a real provider with a
 *      live key. A `test` (sandbox-key) attempt NEVER counts: the owner ruled
 *      out a sandbox verification key. The unsigned `local_mock` counts only in
 *      a test process (`node --test`; mockVerificationIsBookingGrade), never on a
 *      hosted deployment. An attempt whose mode was not recorded (every row
 *      written before migration 3930) does not count: an unknown mode is not a
 *      live one.
 *   3. `profiles.verification_level` is one of the identity levels the
 *      verification flow writes (`id_verified`, `id_selfie_verified`). The
 *      flow is the only writer of those two values, and an admin revocation
 *      clears the column (routes/admin.ts), so this clause is what makes a
 *      revocation end the state. The platform-standing levels
 *      (`basic_verified`, `trusted_traveler`, `host_verified`,
 *      `buddy_verified`) and the admin-set `verification_status` are labels,
 *      not checks, and are deliberately NOT accepted.
 *   `adult` is a separate, stated fact: the verified attempt's `is_over_18`
 *   is exactly `true`. Unknown is not adult.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 * Not a session-expiry check: `identity_verifications.expires_at` is the
 * provider SESSION's expiry (routes/verification.ts writes `session.expiresAt`
 * at creation), not a validity period for a completed verification, and no
 * owner decision sets one. Not a payment-provider check: recipient onboarding
 * is the payment provider's answer (services/payments/bookingPayments/).
 *
 * ── FAIL-CLOSED ──────────────────────────────────────────────────────────────
 * supabase-js RESOLVES `{ data, error }`; an error on either read is
 * `unreadable`, never "not verified" and never "verified". A caller must refuse
 * on `unreadable` (503), not treat it as a definitive "no".
 */
import { identityKeyDecision, mockIdentityPermitted, mockVerificationIsBookingGrade } from "../../lib/paymentsMode.js";

/** The mode a verification attempt ran in, recorded on the row at session creation (migration 3930). */
export type IdentityProviderMode = "test" | "live" | "local_mock";

export const IDENTITY_PROVIDER_MODES: readonly IdentityProviderMode[] = ["test", "live", "local_mock"];

/** The two `profiles.verification_level` values the verification flow writes (types.ts toVerificationLevel). */
export const IDENTITY_VERIFIED_LEVELS: readonly string[] = ["id_verified", "id_selfie_verified"];

/** Statuses that END an attempt. `created` / `pending` / `processing` are in progress and change nothing. */
export const FINISHED_ATTEMPT_STATUSES: readonly string[] = ["verified", "failed", "expired", "canceled"];

/**
 * The mode a session created NOW, with the configured provider, runs in — or
 * null when no attempt can be recorded as any counted-or-uncounted mode (an
 * unknown provider, a refused key). Written onto the row at creation.
 */
export function sessionProviderMode(provider: string, env: NodeJS.ProcessEnv = process.env): IdentityProviderMode | null {
  if (provider === "mock") return mockIdentityPermitted(env) ? "local_mock" : null;
  const decision = identityKeyDecision(env);
  if (!decision || !decision.allowed) return null;
  if (decision.provider !== provider) return null;
  return decision.mode === "live" ? "live" : decision.mode === "test" ? "test" : null;
}

/** Does an attempt in this mode count as a REAL verification in this process? */
export function providerModeCounts(mode: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (mode === "live") return true;
  if (mode === "local_mock") return mockVerificationIsBookingGrade(env); // under node --test only (Step 5(d))
  return false;
}

export type NotVerifiedReason =
  /** No finished attempt exists. */
  | "no_verification"
  /** The most recent finished attempt failed, expired or was canceled. */
  | "latest_attempt_not_verified"
  /** The verified attempt ran with a sandbox (test) key. The owner ruled these out. */
  | "sandbox_verification"
  /** The verified attempt ran on the unsigned local mock, outside a `node --test` process. */
  | "mock_verification"
  /** The verified attempt's mode was never recorded (written before migration 3930). */
  | "mode_unrecorded"
  /** The profile does not carry an identity level: never set, or revoked by an admin. */
  | "profile_level_not_identity";

export type CurrentIdentityVerification =
  | {
      readonly state: "verified";
      readonly verificationId: string;
      readonly provider: string;
      readonly providerMode: IdentityProviderMode;
      readonly verifiedAt: string | null;
      /** `is_over_18` exactly true on the verified attempt. Unknown is NOT adult. */
      readonly adult: boolean;
      /** ISO 3166-1 alpha-2 the document was issued in, when the provider reported it. */
      readonly documentCountry: string | null;
      readonly level: string;
    }
  | { readonly state: "not_verified"; readonly reason: NotVerifiedReason }
  | { readonly state: "unreadable"; readonly detail: string };

/** The `identity_verifications` columns this module reads. */
export const CURRENT_VERIFICATION_COLUMNS = "id, provider, provider_mode, status, is_over_18, document_country, verified_at, created_at";

/**
 * Read a person's current identity-verification state. Never throws.
 * `db` is a service-role supabase client (or a test double of one).
 */
export async function readCurrentIdentityVerification(
  db: any,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CurrentIdentityVerification> {
  let attempt: Record<string, any> | null;
  let level: unknown;
  try {
    const [attemptRead, profileRead] = await Promise.all([
      db
        .from("identity_verifications")
        .select(CURRENT_VERIFICATION_COLUMNS)
        .eq("user_id", userId)
        .in("status", FINISHED_ATTEMPT_STATUSES as string[])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db.from("profiles").select("verification_level").eq("id", userId).maybeSingle(),
    ]);
    if (attemptRead?.error) return { state: "unreadable", detail: "identity_verifications could not be read" };
    if (profileRead?.error) return { state: "unreadable", detail: "profiles.verification_level could not be read" };
    attempt = (attemptRead?.data as Record<string, any> | null) ?? null;
    level = (profileRead?.data as Record<string, any> | null)?.["verification_level"];
  } catch {
    return { state: "unreadable", detail: "identity verification state could not be read" };
  }

  if (!attempt) return { state: "not_verified", reason: "no_verification" };
  if (attempt["status"] !== "verified") return { state: "not_verified", reason: "latest_attempt_not_verified" };

  const mode = attempt["provider_mode"];
  if (mode === null || mode === undefined) return { state: "not_verified", reason: "mode_unrecorded" };
  if (mode === "test") return { state: "not_verified", reason: "sandbox_verification" };
  if (!providerModeCounts(mode, env)) return { state: "not_verified", reason: mode === "local_mock" ? "mock_verification" : "mode_unrecorded" };

  if (typeof level !== "string" || !IDENTITY_VERIFIED_LEVELS.includes(level)) {
    return { state: "not_verified", reason: "profile_level_not_identity" };
  }

  return {
    state: "verified",
    verificationId: String(attempt["id"]),
    provider: String(attempt["provider"]),
    providerMode: mode as IdentityProviderMode,
    verifiedAt: typeof attempt["verified_at"] === "string" ? attempt["verified_at"] : null,
    adult: attempt["is_over_18"] === true,
    documentCountry: typeof attempt["document_country"] === "string" ? attempt["document_country"] : null,
    level,
  };
}

/**
 * The criteria a person can be SHOWN (the owner: "make criteria visible").
 * Plain language; no vendor name, no key mode jargon.
 */
export const VERIFIED_BADGE_CRITERIA: readonly string[] = Object.freeze([
  "Your most recent identity check with our verification provider was approved.",
  "The check used a government-issued ID, and was not a test or practice check.",
  "Your verification has not been withdrawn.",
]);

/** The public statement that travels with the badge. It is a fact about a check, not an endorsement. */
export const VERIFIED_BADGE_STATEMENT =
  "Verified means this person passed an identity check. It is not an endorsement, and it cannot be bought.";
