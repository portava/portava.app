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
export type LedgerPostingKind = "capture" | "refund" | "chargeback" | "payout" | "payout_return";

export interface LedgerEntry {
  readonly account: LedgerAccount;
  /** The user whose sub-account this is (the buddy), or null for the platform's own accounts. */
  readonly partyUserId: string | null;
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

function entry(account: LedgerAccount, partyUserId: string | null, amountMinor: number, reason: LedgerReason): LedgerEntry | null {
  return amountMinor === 0 ? null : { account, partyUserId, amountMinor, reason };
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

/**
 * The postings that move a payment's books from `prev` to `next` counters.
 * Up to two: the capture delta and the refund delta. Each may be negative (a
 * reported counter fell) and then plans the exact reversal of that difference.
 */
export function planPaymentPostings(
  payment: Pick<BookingPaymentRecord, "id" | "recipientUserId" | "amount" | "components" | "platformFee">,
  prev: CaptureCounters,
  next: CaptureCounters,
  occurredAt: string,
): LedgerPosting[] {
  const out: LedgerPosting[] = [];
  const party = payment.recipientUserId;
  const currency = payment.amount.currency;
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
      currency,
      occurredAt,
      subjectId: payment.id,
      entries: compact([
        // Under a direct charge the provider moves the platform fee to the
        // PLATFORM's balance at capture, and the rest stays on the buddy's.
        entry("processor_clearing", party, dCap - dFee, "principal"),
        entry("processor_clearing", null, dFee, "platform_fee"),
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
      currency,
      occurredAt,
      subjectId: payment.id,
      entries: compact([
        entry("processor_clearing", party, -(dRef - dFeeRef), "refund"),
        entry("processor_clearing", null, -dFeeRef, "refund"),
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
 * charges): what is payable to the buddy falls by it. Keyed by the reported
 * cumulative fee, so a re-report of the same fee replays.
 */
export function planProviderFeePosting(
  payment: Pick<BookingPaymentRecord, "id" | "recipientUserId" | "amount">,
  prevFeeMinor: number,
  nextFeeMinor: number,
  occurredAt: string,
): LedgerPosting | null {
  const d = nextFeeMinor - prevFeeMinor;
  if (d === 0) return null;
  return {
    key: `rabpay:${payment.id}:providerfee:${nextFeeMinor}`,
    kind: "capture",
    currency: payment.amount.currency,
    occurredAt,
    subjectId: payment.id,
    entries: compact([
      entry("user_payable", payment.recipientUserId, d, "processor_fee"),
      entry("processor_clearing", payment.recipientUserId, -d, "processor_fee"),
    ]),
  };
}

/** A LOST dispute: the disputed amount leaves the buddy's provider balance by chargeback. */
export function planChargebackPosting(
  payment: Pick<BookingPaymentRecord, "id" | "recipientUserId" | "amount">,
  disputeRef: string,
  amountMinor: number,
  occurredAt: string,
): LedgerPosting {
  return {
    key: `rabpay:${payment.id}:dispute:${disputeRef}:lost`,
    kind: "chargeback",
    currency: payment.amount.currency,
    occurredAt,
    subjectId: payment.id,
    entries: compact([
      entry("user_payable", payment.recipientUserId, amountMinor, "chargeback"),
      entry("processor_clearing", payment.recipientUserId, -amountMinor, "chargeback"),
    ]),
  };
}

/** A payout reached the buddy's bank: what was payable leaves the provider balance. */
export function planPayoutPaidPosting(payout: Pick<MonthlyPayoutRecord, "id" | "recipientUserId" | "currency" | "amountMinor">, occurredAt: string): LedgerPosting {
  return {
    key: `rabpayout:${payout.id}:paid`,
    kind: "payout",
    currency: payout.currency,
    occurredAt,
    subjectId: payout.id,
    entries: compact([
      entry("user_payable", payout.recipientUserId, payout.amountMinor, "payout"),
      entry("processor_clearing", payout.recipientUserId, -payout.amountMinor, "payout"),
    ]),
  };
}

/** A paid payout came back (returned by the bank): the exact reversal. */
export function planPayoutReturnedPosting(payout: Pick<MonthlyPayoutRecord, "id" | "recipientUserId" | "currency" | "amountMinor">, occurredAt: string): LedgerPosting {
  return {
    key: `rabpayout:${payout.id}:returned`,
    kind: "payout_return",
    currency: payout.currency,
    occurredAt,
    subjectId: payout.id,
    entries: compact([
      entry("processor_clearing", payout.recipientUserId, payout.amountMinor, "payout_return"),
      entry("user_payable", payout.recipientUserId, -payout.amountMinor, "payout_return"),
    ]),
  };
}
