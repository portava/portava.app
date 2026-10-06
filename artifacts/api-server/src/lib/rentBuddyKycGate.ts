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
export async function checkBookingKycGate(sc: any, market?: string | null, probes: KycGateProbes = {}): Promise<KycGateResult> {
  const status = probes.status ? probes.status() : identityProviderStatus();
  if (status.operational) return marketCoverageGate(status.provider, market, probes); // second refusal: market coverage (foot of file)

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
export async function requireBookingKyc(sc: any, res: any, market?: string | null): Promise<boolean> {
  const gate = await checkBookingKycGate(sc, market);
  if (gate.allowed) return true;
  res.status(gate.httpStatus).json({ error: gate.code, message: gate.message });
  return false;
}

// ── THE SECOND REFUSAL: is this MARKET covered? (owner's Sumsub decision) ────
//   "Use Sumsub as the primary identity provider behind the provider interface.
//    Verify market coverage; fail closed and keep bookings unavailable where
//    suitable verification is unsupported."
//
// `identityProviderStatus().operational` says the plumbing works. It says
// nothing about whether that provider can verify anyone in the market this
// booking is in — no vendor covers every country, and the owner's own note says
// Sumsub's "220+" is "not literally universal". So once the provider is usable,
// `checkBookingKycGate` asks this second, independent question, and all three of
// its bad answers refuse:
//
//   supported    -> may proceed
//   unsupported  -> `verification_unsupported_market`, and the message says so
//   unknown      -> `verification_market_unknown` — an unreadable or unmounted
//                   coverage list, a market the list does not mention, and NO
//                   MARKET SUPPLIED AT ALL
//
// `market` is optional and that is not a hole: no call site passes one yet, and
// omitting it makes the gate STRICTER (a market-scoped provider with no market
// resolves `unknown`). The mock is not market-scoped (it never runs hosted), so
// local runs and the suite are unaffected.
//
// NO OVERRIDE. The owner's words make coverage a product rule, not a readiness
// state, the 2026-10-04 answers rule out any tester bypass, and the 2026-10-06
// authorization says "Keep unsupported countries ... safely refused". So
// `KYC_OVERRIDE_FLAG` is never consulted for a coverage refusal: a market
// nobody can be verified in is not a pilot a database row can open.
//
// Appended at the foot (with its import) so every cited line above keeps its
// number; the gate itself changes by three lines and composes with lane B's
// rewrite of its not-operational branch.

/** Probes the gate composes, injectable ONLY by tests (the same device providerErasure.ts uses). */
export interface KycGateProbes {
  status?: () => IdentityProviderStatus;
  marketAvailability?: (provider: string, market: unknown) => MarketAvailability;
}

type IdentityProviderStatus = ReturnType<typeof identityProviderStatus>;

/** The coverage half of the gate, for a provider that is already operational. Never reads a flag. */
export function marketCoverageGate(provider: string, market: unknown, probes: KycGateProbes = {}): KycGateResult {
  const readMarket = probes.marketAvailability ?? ((p: string, m: unknown) => identityMarketAvailability(p, m));
  const coverage = readMarket(provider, market);
  if (coverage.available) return { allowed: true };

  logger.error(
    {
      provider: coverage.provider,
      market: coverage.market,
      status: coverage.status,
      code: coverage.code,
      reason: coverage.reason,
      revision: coverage.revision,
    },
    "Booking creation blocked: identity verification has no coverage for this market",
  );

  // A COVERAGE REFUSAL AND A PROVIDER FAILURE ARE DIFFERENT ANSWERS. The
  // `unsupported` message is final and says why; the `unknown` message says we
  // could not establish coverage, which is the honest thing to say when the
  // list is missing, unreadable or silent about this market. Neither names the
  // vendor, the env var or the manifest.
  return coverage.status === "unsupported"
    ? {
        allowed: false,
        httpStatus: 503,
        code: "verification_unsupported_market",
        message:
          "Bookings aren't available in this location yet. We can't verify identity documents here, " +
          "so we don't allow in-person bookings in this market.",
      }
    : {
        allowed: false,
        httpStatus: 503,
        code: "verification_market_unknown",
        message:
          "Bookings aren't available in this location yet. We couldn't confirm that identity " +
          "verification is supported here, so new bookings are paused for this market.",
      };
}

import { identityMarketAvailability, type MarketAvailability } from "../services/identityVerification/marketCoverage.js";
