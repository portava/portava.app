/**
 * commissionPolicy — the platform commission on a Rent-a-Buddy booking, as
 * CONFIGURATION with a version, never as a literal inside arithmetic.
 *
 * ── THE OWNER'S RULING (2026-10-04, "Fees, tips, and deposits") ─────────────
 * "Start with a 10% platform commission on the pre-tax service price, shown
 *  before checkout. Charge no platform commission on tips. Don't add a deposit
 *  in the first release … These are recommended starting prices, not a
 *  universal industry standard; keep them configurable by product and market."
 *
 * So:
 *   • the rate is basis points (1000 = 10 %), integer, 0..10000;
 *   • it is resolved by (product, market): an exact market rule wins over the
 *     product's `*` rule. Today there is ONE rule — the owner's default — and
 *     NO market rule, because no regional rate has been decided. Adding one is a
 *     reviewed one-line change to `COMMISSION_RULES`, with its own version;
 *   • the base is the PRE-TAX SERVICE price only. A tip, tax or payer fee is
 *     never a base: `commissionMinor` takes the service amount and nothing else,
 *     and the payment contract independently refuses a commission above the
 *     service component (PaymentProvider.validateCreatePaymentIntent);
 *   • the version travels with every quote and is stored on the payment, so a
 *     historical charge can always be recomputed under the rule it was taken
 *     under (`07` §8, `09` §7: rules versioned, percentages configurable).
 *
 * ── THE EARNINGS ESTIMATE READS THIS RATE (PR #616) ─────────────────────────
 * The per-level schedule (`rent_buddy_fee_rules`: flat 1000 bps in basis points
 * since migrations 3601/3602; 3603 floors the SQL summary) prices the earnings
 * ESTIMATE in lib/rentBuddyFeeSchedule.ts, which refuses any row whose rate is
 * not this policy's (estimateCommissionPolicy): overrides are keyed HERE, by
 * (product, seller market). Estimate and charge agree on rate, base (the
 * pre-tax service total, never a tip) and rounding (floor, integer cents).
 */

/** The product a booking's service is sold as. */
export const RAB_SERVICE_PRODUCT = "rent_a_buddy_service" as const;
export type CommissionProduct = typeof RAB_SERVICE_PRODUCT;

export interface CommissionRule {
  readonly product: CommissionProduct;
  /** ISO 3166-1 alpha-2 of the SELLER's market, or `*` for every market without its own rule. */
  readonly market: string;
  /** Basis points of the pre-tax service price. Integer, 0..10000. */
  readonly bps: number;
  /** Stored with every payment taken under this rule. */
  readonly version: string;
  /** Where the number came from. */
  readonly source: string;
}

export const COMMISSION_RULES: readonly CommissionRule[] = Object.freeze([
  Object.freeze({
    product: RAB_SERVICE_PRODUCT,
    market: "*",
    bps: 1000,
    version: "rab-commission/owner-2026-10-04/v1",
    source: "owner ruling 2026-10-04: 10% platform commission on the pre-tax service price; none on tips",
  }),
]);

export type CommissionResolution =
  | { readonly ok: true; readonly bps: number; readonly version: string; readonly source: string; readonly ruleMarket: string }
  | { readonly ok: false; readonly reason: "no_rule" | "invalid_rule"; readonly detail: string };

function validRule(r: CommissionRule): boolean {
  return Number.isInteger(r.bps) && r.bps >= 0 && r.bps <= 10000 && typeof r.version === "string" && r.version.length > 0;
}

/** The rule in force for (product, seller market). An exact market rule wins over `*`. */
export function resolveCommission(
  product: CommissionProduct,
  sellerMarket: string,
  rules: readonly CommissionRule[] = COMMISSION_RULES,
): CommissionResolution {
  const exact = rules.find((r) => r.product === product && r.market === sellerMarket);
  const rule = exact ?? rules.find((r) => r.product === product && r.market === "*");
  if (!rule) return { ok: false, reason: "no_rule", detail: `no commission rule for ${product} in ${sellerMarket}` };
  if (!validRule(rule)) return { ok: false, reason: "invalid_rule", detail: `the commission rule for ${product}/${rule.market} is not an integer 0..10000 bps with a version` };
  return { ok: true, bps: rule.bps, version: rule.version, source: rule.source, ruleMarket: rule.market };
}

/**
 * floor(service × bps / 10000), in integers. The floor favours the seller, and
 * the remainder is the seller's: commission + seller share = service exactly,
 * so no residual minor unit is created or dropped.
 */
export function commissionMinor(serviceMinor: number, bps: number): number {
  if (!Number.isSafeInteger(serviceMinor) || serviceMinor < 0) throw new RangeError("serviceMinor must be a non-negative safe integer");
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new RangeError("bps must be an integer 0..10000");
  return Number((BigInt(serviceMinor) * BigInt(bps)) / 10000n);
}

/** "10%" / "12.5%" — for display only; never parsed back. */
export function formatBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = bps % 100;
  return frac === 0 ? `${whole}%` : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}%`;
}
