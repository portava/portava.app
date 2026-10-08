/**
 * Fee-schedule fixtures under lane B's keying (adopted 2026-10-07 in PR #616).
 *
 * The earnings ESTIMATE now prices at the rate the checkout CHARGES
 * (services/payments/bookingPayments/commissionPolicy.ts), and
 * lib/rentBuddyFeeSchedule.ts refuses a schedule row that disagrees. Several
 * suites give a level a distinctive APPROVED rate (15 %, 20 %, 25 %) to prove a
 * route prices from the schedule row and not from a literal; such a row stands
 * for a world in which the charge is at that rate too. `chargeMatches(row)`
 * makes that so for the ESTIMATE only, through the test-runner-only seam, at the
 * moment the fixture row is built (fakes build it when it is read, and the
 * resolver consults the policy after the read). A row without an approval
 * (the flat 1000) puts the owner's real policy back. `resetCharge` is the
 * per-test cleanup.
 */
import { COMMISSION_RULES } from "../../services/payments/bookingPayments/commissionPolicy.js";
import { _setEstimateCommissionRulesForTest } from "../../lib/rentBuddyFeeSchedule.js";

export function chargeMatches<T>(row: T): T {
  const r = row as { platform_fee_basis_points?: unknown; commission_override_approval?: unknown } | null;
  const bps = r?.platform_fee_basis_points;
  const approved = typeof r?.commission_override_approval === "string" && r.commission_override_approval.trim().length > 0;
  _setEstimateCommissionRulesForTest(
    approved && typeof bps === "number" && Number.isInteger(bps)
      ? [{ ...COMMISSION_RULES[0], bps, version: `fixture/charge-at-${bps}` }]
      : null,
  );
  return row;
}

export function resetCharge(): void {
  _setEstimateCommissionRulesForTest(null);
}
