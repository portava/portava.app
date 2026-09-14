/**
 * creatorLedgerRows — the one place a pure `LedgerEntry` becomes a
 * `public.rent_buddy_earnings_entries` row (migration 2901).
 *
 * Separate from `creatorLedgerEntries.ts` on purpose: that module is the entry
 * MODEL and knows nothing about a database, and this one is the single mapping
 * from the model to the table's column names. One mapping, so the two cannot
 * drift — which is the same reason `lib/rentBuddyEarningsLedger.ts` exists at
 * all (five booking routes, one fee computation).
 *
 * PURE. It reaches no database and moves no money.
 */
import type { LedgerEntry } from "./creatorLedgerEntries.js";

/**
 * The rule version stamped on every Rent-a-Buddy entry.
 *
 * `07` §8 ("No payout formula hard-coding") says to store the RULE VERSION, not
 * the outcome of a hard-coded percentage. The percentages themselves stay in
 * `rent_buddy_fee_rules` and are read by `lib/rentBuddyFeeSchedule.ts`; this
 * names the schedule generation the entries were computed under, so a later
 * recomputation is a new version's entries BESIDE the old ones rather than a
 * rewrite of them (`07` §10, "historical recalculation is possible").
 */
export const RENT_BUDDY_FEE_RULE_VERSION = "rent-buddy-fee-schedule/v1";

export interface RentBuddyEarningsEntryRow {
  transaction_key: string;
  booking_id: string;
  account: string;
  entry_reason: string;
  amount_minor: number;
  currency: string;
  cash_settled_minor: number;
  rule_version: string;
  attribution_kind: string;
  attribution_id: string;
  beneficiary_user_id: string | null;
  reverses_entry_id: string | null;
  provider: string;
  external_ref: string | null;
  idempotency_key: string;
}

/** Shape one entry into its 2901 row. */
export function toEarningsEntryRow(e: LedgerEntry, bookingId: string): RentBuddyEarningsEntryRow {
  return {
    transaction_key: e.transactionKey,
    booking_id: bookingId,
    account: e.account,
    entry_reason: e.entryReason,
    amount_minor: e.amountMinor,
    currency: e.currency,
    // Structurally 0, and CHECK-enforced by 2901 as well. `09` §1: Portava moves
    // no money, so no entry may assert that any arrived.
    cash_settled_minor: 0,
    rule_version: e.ruleVersion,
    attribution_kind: e.attributionKind,
    attribution_id: e.attributionId,
    beneficiary_user_id: e.beneficiaryUserId,
    reverses_entry_id: e.reversesEntryId,
    provider: e.provider,
    external_ref: e.externalRef,
    idempotency_key: e.idempotencyKey,
  };
}
