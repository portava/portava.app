/**
 * Fee-schedule fixtures under lane B's keying (adopted 2026-10-07 in PR #616).
 *
 * The earnings ESTIMATE now prices at the rate the checkout CHARGES
 * (services/payments/bookingPayments/commissionPolicy.ts), and
 * lib/rentBuddyFeeSchedule.ts refuses a schedule row that disagrees. Several
 * suites give a level a distinctive rate (15 %, 20 %, 25 %) to prove a route
 * prices from the schedule row and not from a literal; such a row stands for a
 * world in which the charge is at that rate too. `chargeMatches(row)` makes that
 * so for the ESTIMATE only, through the test-runner-only seam, at the moment the
 * fixture row is built (fakes build it when it is read, and the resolver
 * consults the policy after the read). A row at the flat 1000 (or with no
 * usable rate) puts the owner's real policy back. `resetCharge` is the per-test
 * cleanup.
 *
 * Since lead ruling P-6 (2026-10-08) a level row carries no approval column, so
 * the distinctive rate alone selects the fixture world. A suite that needs an
 * off-flat row the charge does NOT share (to prove the refusal) must not pass
 * that row through this helper.
 */
import { COMMISSION_RULES } from "../../services/payments/bookingPayments/commissionPolicy.js";
import { FLAT_COMMISSION_BASIS_POINTS, _setEstimateCommissionRulesForTest } from "../../lib/rentBuddyFeeSchedule.js";

export function chargeMatches<T>(row: T): T {
  const bps = (row as { platform_fee_basis_points?: unknown } | null)?.platform_fee_basis_points;
  _setEstimateCommissionRulesForTest(
    typeof bps === "number" && Number.isInteger(bps) && bps !== FLAT_COMMISSION_BASIS_POINTS
      ? [{ ...COMMISSION_RULES[0], bps, version: `fixture/charge-at-${bps}` }]
      : null,
  );
  return row;
}

export function resetCharge(): void {
  _setEstimateCommissionRulesForTest(null);
}
