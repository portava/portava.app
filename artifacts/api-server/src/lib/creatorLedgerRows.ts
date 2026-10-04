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
 * ── THE RENT-A-BUDDY FEE RULE LINEAGE ───────────────────────────────────────
 *
 * `07` §8 ("No payout formula hard-coding") says to store the RULE VERSION, not
 * the outcome of a hard-coded percentage. The percentages themselves stay in
 * `rent_buddy_fee_rules` and are read by `lib/rentBuddyFeeSchedule.ts`; a
 * version names the schedule GENERATION the entries were computed under, so a
 * later recomputation is a new version's entries BESIDE the old ones rather
 * than a rewrite of them (`07` §10, "historical recalculation is possible").
 *
 * ── OWNER DECISION, 2026-10-04 ──────────────────────────────────────────────
 *   "Change `RENT_BUDDY_FEE_RULE_VERSION` to `/v2`. Preserve `/v1` for
 *    historical records and calculations."
 *
 * `/v1` is the per-level ladder: 25 / 22 / 15 / 12 / 12 percent, seeded by the
 * frozen legacy tree and stored in an integer percent column. `/v2` is the flat
 * 10 % carried in basis points (3520) with `standard` priced (3521). Those are
 * two different schedules, so entries computed under them are two different
 * generations and must not be conflated.
 *
 * ── WHY `/v1` IS A NAMED EXPORT AND NOT A DELETED STRING ────────────────────
 * "Preserve for historical records and calculations" is only real if `/v1`
 * stays NAMEABLE. Had the constant simply been edited in place, `/v1` would
 * survive only as a literal sitting in database rows with no symbol in the tree
 * corresponding to it — readable by accident, recomputable only by someone
 * retyping the string correctly. Preservation that depends on nobody making a
 * typo is not preservation. So:
 *
 *   • `RENT_BUDDY_FEE_RULE_VERSION_V1` names the old generation, so
 *     `entriesAtRuleVersion(entries, …_V1)` and
 *     `historicalBalanceAt(entries, …_V1)` (`lib/creatorLedgerEntries.ts`) can
 *     be asked for the `/v1` answer by name;
 *   • `RENT_BUDDY_FEE_RULE_VERSION` is the CURRENT generation and is the only
 *     one anything WRITES with;
 *   • `RENT_BUDDY_FEE_RULE_VERSIONS` is the lineage, oldest first, so a reader
 *     can enumerate the generations rather than guess at them.
 *
 * ── WHAT MAKES THE PRESERVATION STRUCTURAL ──────────────────────────────────
 * Not this comment. Three mechanisms, each of which already existed and each of
 * which this change relies on rather than adds:
 *
 *   1. THE VERSION IS PART OF THE KEY. `buildBookingEntries` derives
 *      `transaction_key` as `booking:<id>:<reason>:<ruleVersion>` and
 *      `idempotency_key` from it. A `/v2` entry therefore has a DIFFERENT key
 *      from the `/v1` entry for the same booking and reason, so appending `/v2`
 *      cannot collide with, update, or displace `/v1`. The upsert in
 *      `lib/rentBuddyEarningsLedger.ts` is `ignoreDuplicates` against the total
 *      unique index `rbee_idempotency_key_once`, so it is an INSERT … ON
 *      CONFLICT DO NOTHING: nothing is ever overwritten.
 *   2. THE VERSION IS STORED, NOT DERIVED. `rent_buddy_earnings_entries.rule_version`
 *      is `NOT NULL` (2901) and is surfaced by the canonical share view
 *      (2930 / 3385). Every historical row states its own generation, so
 *      attribution needs no outside knowledge of when the cutover happened.
 *   3. RECOMPUTATION REFUSES TO CONFLATE. `recomputeBookingEntries` refuses
 *      `same_rule_version` when entries already exist at the target version,
 *      and recomputes by REVERSING the old transactions and appending new ones
 *      — the reversals carrying the ORIGINAL version, which is why
 *      `historicalBalanceAt` can still state the `/v1` balance afterwards.
 *
 * ── THE HONEST LIMIT ───────────────────────────────────────────────────────
 * Those three are model- and storage-level. There is no ROUTE today that serves
 * a "balance as of `/v1`" read, and no query that filters
 * `rent_buddy_earnings_entries` by `rule_version`: `entriesAtRuleVersion` and
 * `historicalBalanceAt` are pure functions over an in-memory entry set. So a
 * `/v1` entry is preserved, self-describing and recomputable BY CODE; it is not
 * yet exposed as a `/v1` view to any caller. That gap is named in the PR rather
 * than papered over here.
 */

/** The superseded generation: the per-level percent ladder. Written by nothing; still read. */
export const RENT_BUDDY_FEE_RULE_VERSION_V1 = "rent-buddy-fee-schedule/v1";

/** The current generation: flat 10 % in basis points (3520), `standard` priced (3521). */
export const RENT_BUDDY_FEE_RULE_VERSION_V2 = "rent-buddy-fee-schedule/v2";

/**
 * The rule version stamped on every NEW Rent-a-Buddy entry.
 *
 * Deliberately an alias of the newest generation rather than its own literal:
 * two spellings of "the current version" is how the three disagreeing
 * commission constants in `lib/rentBuddyFeeSchedule.ts`' header came to exist.
 */
export const RENT_BUDDY_FEE_RULE_VERSION = RENT_BUDDY_FEE_RULE_VERSION_V2;

/** Every generation that has ever been written, OLDEST FIRST. */
export const RENT_BUDDY_FEE_RULE_VERSIONS = [
  RENT_BUDDY_FEE_RULE_VERSION_V1,
  RENT_BUDDY_FEE_RULE_VERSION_V2,
] as const;

/**
 * Whether a stored `rule_version` is a generation this tree knows about.
 *
 * NOT a validator for writes — writes use `RENT_BUDDY_FEE_RULE_VERSION`. This
 * is for a READER that has a row in hand and needs to know whether it can
 * attribute it. An unknown version is a row this code cannot recompute, which a
 * caller must treat as "I do not know" and never as "the current version".
 */
export function isKnownRentBuddyFeeRuleVersion(version: unknown): boolean {
  return (
    typeof version === "string" &&
    (RENT_BUDDY_FEE_RULE_VERSIONS as readonly string[]).includes(version)
  );
}

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
