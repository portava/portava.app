/**
 * bookingQuote — what a traveller pays for a Rent-a-Buddy booking, and how it
 * is made up, computed BEFORE checkout and recomputed AT checkout.
 *
 * Owner rulings (2026-10-04) this implements:
 *   • "10% platform commission on the pre-tax service price, shown before
 *     checkout" — the quote carries the commission, its rate and its rule
 *     version as display lines (`lines`), so the screen shows exactly what the
 *     server will charge.
 *   • "Charge no platform commission on tips" — a tip is its own component and
 *     its own tax line; the commission base is the service amount only.
 *   • "Don't add a deposit in the first release" — there is no deposit field.
 *     The traveller is charged the whole price at checkout, once.
 *   • "Add a tax-provider interface and configure each launch country before
 *     enabling checkout" — every line is taxed by the registered TaxProvider;
 *     an unconfigured market is `tax_not_configured`, never a zero.
 *   • Commission is taken from the SELLER's price (the buddy is the seller,
 *     direct charge): the traveller's total is service + tip + tax; the
 *     platform's separate fee is commission + platform-remitted tax.
 *
 * WHY RECOMPUTE AT CHECKOUT. A `TaxComputation` is attested by the provider that
 * issued it, by object identity (TaxProvider.ts §4), so it is valid only in the
 * request that computed it. A quote shown earlier is information; the charge is
 * re-quoted from the same inputs and must produce the same total, or checkout
 * refuses with `quote_changed` rather than charging a number nobody saw.
 */
import type { AmountComponents, Money, PlatformFee } from "../PaymentProvider.js";
import type { TaxComputation, TaxProvider } from "../TaxProvider.js";
import { commissionMinor, formatBps, resolveCommission, RAB_SERVICE_PRODUCT, type CommissionRule, COMMISSION_RULES } from "./commissionPolicy.js";

export interface QuoteInput {
  /** PRE-TAX service price, integer minor units. */
  readonly serviceMinor: number;
  /** A tip added at checkout. 0 when none. Never commissioned. */
  readonly tipMinor: number;
  /** ISO 4217, upper case: the currency the price is stated in. */
  readonly currency: string;
  /** ISO 3166-1 alpha-2 of the traveller's market. */
  readonly buyerMarket: string;
  /** ISO 3166-1 alpha-2 of the buddy's (seller's) market. */
  readonly sellerMarket: string;
}

export interface QuoteLine {
  readonly key: "service" | "tip" | "tax" | "total" | "commission_from_service" | "buddy_receives";
  readonly label: string;
  readonly amount: Money;
  /** True for lines the traveller pays; false for lines that explain how the price is split. */
  readonly payable: boolean;
}

export interface BookingQuote {
  readonly amount: Money;
  readonly components: AmountComponents;
  readonly platformFee: PlatformFee;
  readonly tax: readonly TaxComputation[];
  readonly commission: { readonly bps: number; readonly minor: number; readonly version: string; readonly display: string };
  readonly taxProvider: string;
  readonly lines: readonly QuoteLine[];
}

export type QuoteResult =
  | { readonly ok: true; readonly quote: BookingQuote }
  | {
      readonly ok: false;
      readonly reason: "invalid_input" | "no_commission_rule" | "tax_not_configured" | "tax_unavailable" | "tax_invalid";
      readonly detail: string;
    };

const CURRENCY = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;
const nonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export async function quoteBookingCharge(
  input: QuoteInput,
  tax: TaxProvider,
  rules: readonly CommissionRule[] = COMMISSION_RULES,
): Promise<QuoteResult> {
  if (!nonNegInt(input.serviceMinor) || input.serviceMinor === 0) return { ok: false, reason: "invalid_input", detail: "the service price must be a positive integer of minor units" };
  if (!nonNegInt(input.tipMinor)) return { ok: false, reason: "invalid_input", detail: "the tip must be a non-negative integer of minor units" };
  if (!CURRENCY.test(input.currency)) return { ok: false, reason: "invalid_input", detail: "currency must be ISO 4217 upper case" };
  if (!COUNTRY.test(input.buyerMarket) || !COUNTRY.test(input.sellerMarket)) return { ok: false, reason: "invalid_input", detail: "markets must be ISO 3166-1 alpha-2 upper case" };

  const rule = resolveCommission(RAB_SERVICE_PRODUCT, input.sellerMarket, rules);
  if (!rule.ok) return { ok: false, reason: "no_commission_rule", detail: rule.detail };

  const lines: Array<{ kind: "service" | "tip"; amountMinor: number }> = [{ kind: "service", amountMinor: input.serviceMinor }];
  if (input.tipMinor > 0) lines.push({ kind: "tip", amountMinor: input.tipMinor });

  const computations: TaxComputation[] = [];
  for (const line of lines) {
    const r = await tax.computeTax({
      sellerMarket: input.sellerMarket,
      buyerMarket: input.buyerMarket,
      productKind: line.kind,
      amountMinor: line.amountMinor,
      currency: input.currency,
    });
    if (r.status === "unavailable") {
      return r.reason === "tax_not_configured"
        ? { ok: false, reason: "tax_not_configured", detail: r.detail }
        : { ok: false, reason: "tax_unavailable", detail: r.detail };
    }
    if (r.status !== "ok") return { ok: false, reason: "tax_invalid", detail: r.detail };
    computations.push(r.value);
  }

  const taxMinor = computations.reduce((n, c) => n + c.taxMinor, 0);
  const platformTaxMinor = computations.filter((c) => c.remittedBy === "platform").reduce((n, c) => n + c.taxMinor, 0);
  const commission = commissionMinor(input.serviceMinor, rule.bps);
  const total = input.serviceMinor + input.tipMinor + taxMinor;
  const money = (amountMinor: number): Money => ({ amountMinor, currency: input.currency });

  const display: QuoteLine[] = [
    { key: "service", label: "Service price", amount: money(input.serviceMinor), payable: true },
  ];
  if (input.tipMinor > 0) display.push({ key: "tip", label: "Tip (100% to your Buddy, no platform commission)", amount: money(input.tipMinor), payable: true });
  display.push({ key: "tax", label: "Tax", amount: money(taxMinor), payable: true });
  display.push({ key: "total", label: "Total charged now", amount: money(total), payable: true });
  display.push({
    key: "commission_from_service",
    label: `Portava commission (${formatBps(rule.bps)} of the service price, paid from it — not added to your total)`,
    amount: money(commission),
    payable: false,
  });
  display.push({ key: "buddy_receives", label: "Your Buddy receives (service after commission, plus any tip)", amount: money(input.serviceMinor - commission + input.tipMinor), payable: false });

  return {
    ok: true,
    quote: {
      amount: money(total),
      components: { serviceMinor: input.serviceMinor, payerFeeMinor: 0, tipMinor: input.tipMinor, taxMinor },
      platformFee: { commissionMinor: commission, payerFeeMinor: 0, taxMinor: platformTaxMinor },
      tax: computations,
      commission: { bps: rule.bps, minor: commission, version: rule.version, display: formatBps(rule.bps) },
      taxProvider: tax.id,
      lines: display,
    },
  };
}

/**
 * A price stored as a decimal string of MAJOR units (numeric(10,2) as
 * PostgREST returns it, e.g. "40.00" or 40) → integer minor units, without a
 * float. Null when it is not a non-negative amount with at most two decimals.
 */
export function majorDecimalToMinor(value: unknown, exponent = 2): number | null {
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : typeof value === "string" ? value.trim() : "";
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > exponent) {
    // Only trailing zeros beyond the exponent are acceptable ("40.000").
    if (!/^0*$/.test(frac.slice(exponent))) return null;
  }
  const digits = `${m[1]}${frac.slice(0, exponent).padEnd(exponent, "0")}`;
  const n = Number(BigInt(digits));
  return Number.isSafeInteger(n) ? n : null;
}
