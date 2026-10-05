/**
 * Rent-a-Buddy booking KYC gate (audit P1 item 8)
 *
 * Rent-a-Buddy pairs strangers for in-person meetings. Production currently has
 * NO working identity verification: both real adapters in
 * services/identityVerification/providers.ts are stubs and the mock provider is
 * refused in production, so nobody can complete a check.
 *
 * Booking creation is therefore hard-disabled while KYC is non-operational.
 *
 * ── Why this is not already covered ─────────────────────────────────────────
 * The existing protections are all incidental rather than structural:
 *   * `disable_rent_buddy_booking` / `disable_rab_bookings` are opt-in kill
 *     switches that default to allowing bookings, and the call site documents
 *     itself as fail-OPEN on DB error;
 *   * `rent_buddy_launch_controls.require_id_verification` happens to be true
 *     on all 13 live rows, but it is ordinary admin-editable config — one
 *     unticked checkbox opens bookings with zero KYC;
 *   * `POST /rent-a-buddy/bookings/:bookingId/rebook` inserts a booking row
 *     while skipping the kill switches, rollout checks and launch controls
 *     entirely.
 * This gate is tied directly to whether verification actually works, so it
 * cannot be defeated by config drift, and it is applied to BOTH insert paths.
 *
 * ── Failure semantics: closed, and no override ──────────────────────────────
 * No escape hatch (owner, 2026-10-04: "No tester bypass or sandbox verification
 * key"): the retired override flag is not read, and a sandbox (test) identity
 * key keeps bookings closed too (verificationIsBookingGrade, at the foot).
 */
import { configuredIdentityProvider, identityKeyDecision, mockIdentityPermitted } from "./paymentsMode.js";
import { identityProviderStatus } from "../services/identityVerification/readiness.js";
import { logger as rootLogger } from "./logger.js";

const logger = rootLogger.child({ gate: "RentBuddyKycGate" });

/**
 * RETIRED 2026-10-05. Was an escape hatch for a pilot without KYC; the owner
 * ruled out any tester bypass, and the gate no longer reads it. Kept exported
 * so a stale row or a test that seeds it is visibly inert, not an error.
 */
export const KYC_OVERRIDE_FLAG = "rent_buddy_allow_bookings_without_kyc";

export interface KycGateResult {
  allowed: boolean;
  /** Set when blocked — the HTTP body to return. */
  httpStatus?: number;
  code?: string;
  message?: string;
}

/**
 * Decide whether a booking may be created right now: `{ allowed: true }` only
 * when identity verification is operational AND booking-grade (a live key, or
 * the mock in a local run). There is no override (owner, 2026-10-04: no tester
 * bypass).
 */
export async function checkBookingKycGate(_sc: any): Promise<KycGateResult> {
  const status = identityProviderStatus();
  if (status.operational && verificationIsBookingGrade()) return { allowed: true };

  // Not operational, or operational only on a SANDBOX key. Nothing lets this
  // through: the owner ruled (2026-10-04) that first-release bookings require
  // REAL identity verification — "No tester bypass or sandbox verification
  // key." KYC_OVERRIDE_FLAG used to be read here as an escape hatch for a
  // pilot without KYC; it is no longer read by anything, so turning the row on
  // changes nothing. A sandbox key verifies nobody for real, so a deployment
  // whose identity key is a test key stays closed exactly like one with no
  // provider at all (verificationIsBookingGrade, at the foot).
  void KYC_OVERRIDE_FLAG;

  logger.error(
    { provider: status.provider, reason: status.reason },
    "Booking creation blocked: identity verification is not operational",
  );

  return {
    allowed: false,
    httpStatus: 503,
    code: "verification_unavailable",
    // Deliberately does not leak provider/env detail to the caller.
    message:
      "Bookings are temporarily unavailable while identity verification is being set up. " +
      "We can't safely confirm identities right now, so new bookings are paused.",
  };
}

/**
 * Express helper: returns true when the request may proceed, otherwise writes
 * the error response and returns false.
 */
export async function requireBookingKyc(sc: any, res: any): Promise<boolean> {
  const gate = await checkBookingKycGate(sc);
  if (gate.allowed) return true;
  res.status(gate.httpStatus).json({ error: gate.code, message: gate.message });
  return false;
}

// ── Booking-grade verification (appended at the foot so every cited line keeps its number) ──
//
// `identityProviderStatus().operational` answers "can a verification be
// completed?". A SANDBOX key can complete one — the vendors' sandboxes approve
// test documents on demand — and that is not a real verification. So for
// BOOKINGS the gate additionally requires the configured provider's key to be a
// LIVE key that this process is allowed to use (lib/paymentsMode.ts:
// PAYMENTS_ALLOW_LIVE exactly "true"), or the unsigned mock in a positively
// evidenced local run (tests, `pnpm dev`) — never on a hosted deployment. Every
// per-person check (services/identityVerification/currentVerification.ts) also
// refuses a sandbox-mode verification row; this is the deployment-level half.
export function verificationIsBookingGrade(env: NodeJS.ProcessEnv = process.env): boolean {
  const provider = configuredIdentityProvider(env);
  if (provider === "mock") return mockIdentityPermitted(env);
  const decision = identityKeyDecision(env);
  return decision !== null && decision.allowed && decision.mode === "live";
}
