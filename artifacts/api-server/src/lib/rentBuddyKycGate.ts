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
 * ── Failure semantics: closed ───────────────────────────────────────────────
 * The override flag is read with isFlagEnabled(), which returns false on any
 * DB error. "No override" means "stay blocked", so a database problem cannot
 * open bookings.
 */
import { isFlagEnabled } from "./featureFlags.js";
import { identityProviderStatus } from "../services/identityVerification/readiness.js";
import { logger as rootLogger } from "./logger.js";

const logger = rootLogger.child({ gate: "RentBuddyKycGate" });

/**
 * Escape hatch for running a marketplace pilot without KYC. Deliberately
 * verbose: enabling it is an explicit statement that you accept unverified
 * strangers meeting in person.
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
 * Decide whether a booking may be created right now.
 *
 * Returns `{ allowed: true }` when identity verification is operational, or
 * when the override flag is explicitly on.
 */
export async function checkBookingKycGate(sc: any): Promise<KycGateResult> {
  const status = identityProviderStatus();
  if (status.operational) return { allowed: true };

  // Not operational — only an explicit override may let this through.
  const overridden = await isFlagEnabled(sc, KYC_OVERRIDE_FLAG);
  if (overridden) {
    logger.warn(
      { provider: status.provider, reason: status.reason, flag: KYC_OVERRIDE_FLAG },
      "Booking allowed WITHOUT working identity verification — override flag is on",
    );
    return { allowed: true };
  }

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
