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

// ═══════════════════════════════════════════════════════════════════════════
// The CREATOR-TYPE tables: 2920 `creator_attributions`, 2921 `creator_earning_entries`
// ═══════════════════════════════════════════════════════════════════════════
//
// Same reason as above: ONE place where a pure record becomes a row, so the
// model and the columns cannot drift. These map the six-type records rather
// than the Rent-a-Buddy ones — a different table with a different vocabulary
// (`creator_payable`, not `buddy_payable`) because a Trail Builder's earning is
// not a booking and must not FK to one.
//
// PURE. Neither function reaches a database and neither moves money: the
// settlement columns are written as the literal 0, which 2920's
// `CHECK (settled_minor = 0)` and 2921's `cee_no_settlement` enforce again.

import type { CreatorLedgerEntry } from "./creatorLedgerEntries.js";
import type { CreatorAttribution } from "./creatorTypeAttribution.js";

export interface CreatorAttributionRow {
  creator_type: string;
  subject_kind: string;
  subject_id: string;
  value_event: string;
  value_event_id: string | null;
  attribution_basis: string;
  beneficiary_user_id: string;
  weight: number;
  confidence: number;
  gross_revenue_minor: number;
  provisional_share_minor: number;
  currency: string;
  settled_minor: number;
  rule_version: string;
  fraud_hold: boolean;
  fraud_hold_reason: string | null;
  supersedes_id: string | null;
  idempotency_key: string;
}

/** Shape one attribution into its 2920 row. */
export function toCreatorAttributionRow(a: CreatorAttribution): CreatorAttributionRow {
  return {
    creator_type: a.creatorType,
    subject_kind: a.subjectKind,
    subject_id: a.subjectId,
    value_event: a.valueEvent,
    value_event_id: a.valueEventId,
    attribution_basis: a.basis,
    beneficiary_user_id: a.beneficiaryUserId,
    weight: a.weight,
    confidence: a.confidence,
    gross_revenue_minor: a.grossRevenueMinor,
    provisional_share_minor: a.provisionalShareMinor,
    currency: a.currency,
    // Structurally 0, and CHECK-enforced by 2920 as well. `09` §1: Portava moves
    // no money, so no row may assert that any did.
    settled_minor: 0,
    rule_version: a.ruleVersion,
    fraud_hold: a.fraudHold,
    fraud_hold_reason: a.fraudHoldReason,
    supersedes_id: a.supersedesId,
    idempotency_key: a.idempotencyKey,
  };
}

export interface CreatorEarningEntryRow {
  transaction_key: string;
  creator_type: string;
  attribution_id: string;
  account: string;
  entry_reason: string;
  revenue_source: string | null;
  amount_minor: number;
  currency: string;
  cash_settled_minor: number;
  rule_version: string;
  beneficiary_user_id: string | null;
  reverses_entry_id: string | null;
  provider: string;
  external_ref: string | null;
  idempotency_key: string;
}

/**
 * Shape one entry into its 2921 row.
 *
 * `attributionId` is passed separately rather than read off the entry for the
 * same reason `toEarningsEntryRow` takes a `bookingId`: the pure model's id is
 * a derived natural key, and the COLUMN is a uuid FK to the persisted
 * attribution row. The caller holds the mapping between the two.
 */
export function toCreatorEarningEntryRow(
  e: CreatorLedgerEntry,
  attributionId: string,
): CreatorEarningEntryRow {
  return {
    transaction_key: e.transactionKey,
    creator_type: e.creatorType,
    attribution_id: attributionId,
    account: e.account,
    entry_reason: e.entryReason,
    revenue_source: e.revenueSource,
    amount_minor: e.amountMinor,
    currency: e.currency,
    cash_settled_minor: 0,
    rule_version: e.ruleVersion,
    beneficiary_user_id: e.beneficiaryUserId,
    reverses_entry_id: e.reversesEntryId,
    provider: e.provider,
    external_ref: e.externalRef,
    idempotency_key: e.idempotencyKey,
  };
}
