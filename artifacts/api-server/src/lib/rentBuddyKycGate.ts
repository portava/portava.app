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
 *
 * ── TWO INDEPENDENT REFUSALS ────────────────────────────────────────────────
 * Since the owner's Sumsub decision there are two, and they answer different
 * questions:
 *
 *   1. IS VERIFICATION WORKING AT ALL?  readiness.identityProviderStatus()
 *   2. IS THIS MARKET COVERED?          marketCoverage.identityMarketAvailability()
 *
 * Both must say yes. (2) refuses on "unsupported" AND on "unknown", where
 * unknown includes an unreadable coverage list, an unmounted one, a market the
 * list does not mention, and no market supplied — see `checkBookingKycGate`.
 */
import { isFlagEnabled } from "./featureFlags.js";
import {
  identityProviderStatus,
  type IdentityProviderStatus,
} from "../services/identityVerification/readiness.js";
import {
  identityMarketAvailability,
  type MarketAvailability,
} from "../services/identityVerification/marketCoverage.js";
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
 * Probes the gate composes, injectable ONLY by tests.
 *
 * Both default to the real, env-driven probes, and both are read through this
 * object on every call so there is one code path rather than a test path and a
 * production path. The same device is used by
 * `services/identityVerification/providerErasure.ts` for its provider factory,
 * and for the same reason: the composition is the behaviour under test, and
 * with the real probes the only reachable answer today is "refuse".
 */
export interface KycGateProbes {
  status?: () => IdentityProviderStatus;
  marketAvailability?: (provider: string, market: unknown) => MarketAvailability;
}

/**
 * Decide whether a booking may be created right now.
 *
 * Returns `{ allowed: true }` when identity verification is operational AND the
 * booking's market is covered, or when the override flag is explicitly on.
 *
 * ── THE SECOND HALF OF THE OWNER'S DECISION ─────────────────────────────────
 *   "Verify market coverage; fail closed and keep bookings unavailable where
 *    suitable verification is unsupported."
 *
 * A provider being operational says the plumbing works. It says NOTHING about
 * whether that provider can verify a person in the market this booking is in —
 * no vendor covers every country, the owner's own note says Sumsub's "220+" is
 * "not literally universal", and a booking in an uncovered market pairs
 * strangers in person on a check that can never have happened. So coverage is
 * a second, independent refusal, and all three of its bad answers refuse:
 *
 *   supported    -> may proceed
 *   unsupported  -> `verification_unsupported_market`, and the message says so
 *   unknown      -> `verification_market_unknown` — including an unreadable or
 *                   unmounted coverage list, a market not in the list, and NO
 *                   MARKET SUPPLIED AT ALL
 *
 * ── `market` IS OPTIONAL AND THAT IS NOT A HOLE ─────────────────────────────
 * No call site passes one yet, and omitting it makes the gate STRICTER, never
 * looser: a market-scoped provider with no market resolves `unknown` and the
 * booking is refused. The mock provider is not market-scoped (it is refused in
 * production outright), so local development and the suite are unaffected, and
 * every real provider is already refused by the readiness check above. The
 * moment a market-scoped provider is activated, every booking path refuses
 * until the market is threaded through — which is the fail-closed direction and
 * is named as the remaining wiring in the PR rather than defaulted away here.
 */
export async function checkBookingKycGate(
  sc: any,
  /** ISO 3166-1 alpha-2 market the booking takes place in. Absent => unknown => refused. */
  market?: string | null,
  probes: KycGateProbes = {},
): Promise<KycGateResult> {
  const readStatus = probes.status ?? (() => identityProviderStatus());
  const readMarket =
    probes.marketAvailability ?? ((provider: string, m: unknown) => identityMarketAvailability(provider, m));

  const status = readStatus();

  // Coverage is only asked once the provider itself is usable; an unusable
  // provider is refused for its own reason, which is the more actionable one.
  if (status.operational) {
    const coverage = readMarket(status.provider, market);
    if (coverage.available) return { allowed: true };

    const overriddenForMarket = await isFlagEnabled(sc, KYC_OVERRIDE_FLAG);
    if (overriddenForMarket) {
      logger.warn(
        { provider: coverage.provider, market: coverage.market, code: coverage.code, flag: KYC_OVERRIDE_FLAG },
        "Booking allowed in a market with NO verified identity coverage — override flag is on",
      );
      return { allowed: true };
    }

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
    // `unsupported` message is final and says why; the `unknown` message says
    // we could not establish coverage, which is the honest thing to say when
    // the list is missing, unreadable or silent about this market. Neither
    // names the vendor, the env var or the manifest.
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
