/**
 * ledgerPostings — the double-entry postings a Rent-a-Buddy payment produces,
 * planned as pure data, and the port they are posted through.
 *
 * `09` (hash-verified spec, docs/specs/discovery-v1/09_Payment_Architecture.md):
 * "Never make wallet balance the source of truth. Use immutable ledger entries"
 * (§2); "Never mutate old ledger rows. Create reversing entries" (§6); "Store
 * monetary amounts as integers in minor units" (§8); idempotency keys (§10).
 *
 * ── THE ACCOUNTS (the vocabulary of PR #598's ledger, 3821) ─────────────────
 *   processor_clearing  money on a provider balance. Under a DIRECT charge the
 *                       charge lands on the BUDDY's provider balance, so the
 *                       clearing entries name the buddy as party.
 *   user_payable        what the buddy has earned and not yet been paid out.
 *   platform_revenue    the platform's commission.
 *   tax_withheld        tax the PLATFORM must remit (`remittedBy: platform`).
 * Signed integer minor units: positive = debit, negative = credit. Every
 * posting sums to zero in its one currency.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ──────────────────────────────────────────────
 * A posting's key is derived from the CUMULATIVE counters the provider reported
 * (captured 5000 / fee 500), never from a delivery. The same snapshot delivered
 * twice plans the same key and the same entries, so the ledger replays it; a
 * late, smaller snapshot plans nothing (the webhook processor discards stale
 * snapshots before planning). A counter that FALLS (a refund that failed after
 * it was reported) plans the exact reversal of the difference.
 *
 * ── NO PERSON IN A KEY ───────────────────────────────────────────────────────
 * Keys name THINGS — a payment row id, a refund ref, a payout id — never a
 * profile id (#598 refuses a profile id in any ledger text column).
 */
import type { BookingPaymentRecord, MonthlyPayoutRecord } from "./model.js";

export type LedgerAccount = "processor_clearing" | "user_payable" | "platform_revenue" | "tax_withheld";
export type LedgerReason = "principal" | "tip" | "platform_fee" | "processor_fee" | "tax" | "refund" | "chargeback" | "payout" | "payout_return";
export type LedgerPostingKind = "capture" | "refund" | "fee" | "chargeback" | "payout" | "payout_return";

export interface LedgerEntry {
  readonly account: LedgerAccount;
  /**
   * For `user_payable`: the buddy's PAYMENT PARTY id (3821's pseudonym — never a
   * profile id). Null for the processor's clearing account and the platform's
   * accounts, whose owner the account type decides (3821 pa_account_type_owner_kind).
   */
  readonly partyId: string | null;
  /** Signed integer minor units: + debit, − credit. Never 0. */
  readonly amountMinor: number;
  readonly reason: LedgerReason;
}

export interface LedgerPosting {
  readonly key: string;
  readonly kind: LedgerPostingKind;
  readonly currency: string;
  readonly occurredAt: string;
  /** What the money is about — a payment row or a payout row id. Never a person. */
  readonly subjectId: string;
  /** The booking the money is for, when there is exactly one (null for a monthly payout). */
  readonly bookingId: string | null;
  /** The provider holding the money: owner label of the processor_clearing account. */
  readonly processor: string;
  /** The provider's object id (`pi_…`, `po_…`), for disputes and reconciliation. */
  readonly externalRef: string | null;
  readonly entries: readonly LedgerEntry[];
}

export type LedgerPostResult =
  | { readonly ok: true; readonly replayed: boolean }
  | {
      readonly ok: false;
      /** ledger_unavailable: no ledger that can record settled money is reachable (PR #598 not merged/applied). */
      readonly reason: "ledger_unavailable" | "idempotency_conflict" | "unbalanced" | "rejected";
      readonly detail: string;
    };

export interface PaymentLedgerPort {
  post(posting: LedgerPosting): Promise<LedgerPostResult>;
}

/**
 * The production binding on a tree without PR #598's ledger. It books nothing
 * and says so; every caller that must book money refuses on it.
 */
export const LEDGER_NOT_AVAILABLE: PaymentLedgerPort = Object.freeze({
  post: async (): Promise<LedgerPostResult> => ({
    ok: false,
    reason: "ledger_unavailable",
    detail:
      "no ledger that can record settled money is available on this tree: the double-entry payment ledger is PR #598 " +
      "(payment_post_transaction, migrations 3821-3823). Nothing was booked.",
  }),
});

/** Sum of entries; a valid posting sums to 0. */
export function postingBalance(p: Pick<LedgerPosting, "entries">): number {
  return p.entries.reduce((n, e) => n + e.amountMinor, 0);
}

function entry(account: LedgerAccount, partyId: string | null, amountMinor: number, reason: LedgerReason): LedgerEntry | null {
  return amountMinor === 0 ? null : { account, partyId, amountMinor, reason };
}

function compact(entries: Array<LedgerEntry | null>): LedgerEntry[] {
  return entries.filter((e): e is LedgerEntry => e !== null);
}

/** floor(a × b / c) in integers, sign-preserving toward zero; 0 when c is 0. */
function share(a: number, b: number, c: number): number {
  if (c === 0) return 0;
  return Number((BigInt(a) * BigInt(b)) / BigInt(c));
}

export interface CaptureCounters {
  readonly capturedMinor: number;
  readonly refundedMinor: number;
  readonly feeCollectedMinor: number;
  readonly feeRefundedMinor: number;
}

type PaymentForPosting = Pick<BookingPaymentRecord, "id" | "bookingId" | "provider" | "intentRef" | "recipientPartyId" | "amount" | "components" | "platformFee">;

const base = (p: Pick<BookingPaymentRecord, "id" | "bookingId" | "provider" | "intentRef" | "amount">, occurredAt: string) => ({
  currency: p.amount.currency,
  occurredAt,
  subjectId: p.id,
  bookingId: p.bookingId,
  processor: p.provider,
  externalRef: p.intentRef,
});

/**
 * The postings that move a payment's books from `prev` to `next` counters.
 * Up to two: the capture delta and the refund delta. Each may be negative (a
 * reported counter fell) and then plans the exact reversal of that difference.
 *
 * The money of a DIRECT charge sits with the PROCESSOR (on the buddy's account
 * there), so the debit side is the processor's clearing account — 3821 lets
 * only a `processor` party own one. The credits name who it is for: the buddy's
 * `user_payable` (principal and tip, kept apart), the platform's revenue (the
 * commission) and the tax the platform must remit.
 */
export function planPaymentPostings(payment: PaymentForPosting, prev: CaptureCounters, next: CaptureCounters, occurredAt: string): LedgerPosting[] {
  const out: LedgerPosting[] = [];
  const party = payment.recipientPartyId;
  const total = payment.amount.amountMinor;
  const feeTotal = payment.platformFee.commissionMinor + payment.platformFee.taxMinor;

  const dCap = next.capturedMinor - prev.capturedMinor;
  const dFee = next.feeCollectedMinor - prev.feeCollectedMinor;
  if (dCap !== 0 || dFee !== 0) {
    const taxPart = share(dFee, payment.platformFee.taxMinor, feeTotal);
    const revenue = dFee - taxPart;
    const tipShare = share(dCap, payment.components.tipMinor, total);
    const principal = dCap - dFee - tipShare;
    out.push({
      key: `rabpay:${payment.id}:captured:${next.capturedMinor}:fee:${next.feeCollectedMinor}`,
      kind: "capture",
      ...base(payment, occurredAt),
      entries: compact([
        entry("processor_clearing", null, dCap, "principal"),
        entry("user_payable", party, -principal, "principal"),
        entry("user_payable", party, -tipShare, "tip"),
        entry("platform_revenue", null, -revenue, "platform_fee"),
        entry("tax_withheld", null, -taxPart, "tax"),
      ]),
    });
  }

  const dRef = next.refundedMinor - prev.refundedMinor;
  const dFeeRef = next.feeRefundedMinor - prev.feeRefundedMinor;
  if (dRef !== 0 || dFeeRef !== 0) {
    const taxPart = share(dFeeRef, payment.platformFee.taxMinor, feeTotal);
    const revenue = dFeeRef - taxPart;
    out.push({
      key: `rabpay:${payment.id}:refunded:${next.refundedMinor}:feeref:${next.feeRefundedMinor}`,
      kind: "refund",
      ...base(payment, occurredAt),
      entries: compact([
        entry("processor_clearing", null, -dRef, "refund"),
        entry("user_payable", party, dRef - dFeeRef, "refund"),
        entry("platform_revenue", null, revenue, "refund"),
        entry("tax_withheld", null, taxPart, "refund"),
      ]),
    });
  }
  return out;
}

/**
 * The provider's OWN processing fee, debited from the buddy's balance (direct
 * charges): what is payable to the buddy falls by it. Its own `fee`
 * transaction — 3822 requires a transaction's credits to total its original
 * amount, so a fee is never a rider on a capture. Keyed by the reported
 * cumulative fee, so a re-report of the same fee replays.
 */
export function planProviderFeePosting(
  payment: Pick<BookingPaymentRecord, "id" | "bookingId" | "provider" | "intentRef" | "recipientPartyId" | "amount">,
  prevFeeMinor: number,
  nextFeeMinor: number,
  occurredAt: string,
): LedgerPosting | null {
  const d = nextFeeMinor - prevFeeMinor;
  if (d === 0) return null;
  return {
    key: `rabpay:${payment.id}:providerfee:${nextFeeMinor}`,
    kind: "fee",
    ...base(payment, occurredAt),
    entries: compact([
      entry("user_payable", payment.recipientPartyId, d, "processor_fee"),
      entry("processor_clearing", null, -d, "processor_fee"),
    ]),
  };
}

/** A LOST dispute: the disputed amount leaves the buddy's provider balance by chargeback. */
export function planChargebackPosting(
  payment: Pick<BookingPaymentRecord, "id" | "bookingId" | "provider" | "intentRef" | "recipientPartyId" | "amount">,
  disputeRef: string,
  amountMinor: number,
  occurredAt: string,
): LedgerPosting {
  return {
    key: `rabpay:${payment.id}:dispute:${disputeRef}:lost`,
    kind: "chargeback",
    ...base(payment, occurredAt),
    entries: compact([
      entry("user_payable", payment.recipientPartyId, amountMinor, "chargeback"),
      entry("processor_clearing", null, -amountMinor, "chargeback"),
    ]),
  };
}

type PayoutForPosting = Pick<MonthlyPayoutRecord, "id" | "recipientPartyId" | "currency" | "amountMinor" | "payoutRef"> & { readonly provider: string };

const payoutBase = (p: PayoutForPosting, occurredAt: string) => ({
  currency: p.currency,
  occurredAt,
  subjectId: p.id,
  bookingId: null,
  processor: p.provider,
  externalRef: p.payoutRef,
});

/** A payout reached the buddy's bank: what was payable leaves the provider's balance. */
export function planPayoutPaidPosting(payout: PayoutForPosting, occurredAt: string): LedgerPosting {
  return {
    key: `rabpayout:${payout.id}:paid`,
    kind: "payout",
    ...payoutBase(payout, occurredAt),
    entries: compact([
      entry("user_payable", payout.recipientPartyId, payout.amountMinor, "payout"),
      entry("processor_clearing", null, -payout.amountMinor, "payout"),
    ]),
  };
}

/** A paid payout came back (returned by the bank): the exact reversal. */
export function planPayoutReturnedPosting(payout: PayoutForPosting, occurredAt: string): LedgerPosting {
  return {
    key: `rabpayout:${payout.id}:returned`,
    kind: "payout_return",
    ...payoutBase(payout, occurredAt),
    entries: compact([
      entry("processor_clearing", null, payout.amountMinor, "payout_return"),
      entry("user_payable", payout.recipientPartyId, -payout.amountMinor, "payout_return"),
    ]),
  };
}
