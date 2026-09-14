/**
 * creatorLedgerEntries — the append-only entry model the acceptance criteria
 * actually ask for. PURE. It reaches no database and moves no money.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `07` §10 and `09` §11 set a bar that is reachable BEFORE a payment processor
 * exists — "earnings can be recorded without paying", "every earning can be
 * reconstructed", "no balance depends on mutable totals", "reversals are
 * possible", "provider can be swapped later". The repository's own reading of
 * its state (`docs/architecture/09_Payment_Architecture.md:71-105`, §1.3) is
 * that `rent_buddy_earnings_ledger` fails that bar for a structural reason:
 * it is ONE MUTABLE SUMMARY ROW PER BOOKING, `UNIQUE (booking_id)`, written by
 * a single upsert on that conflict target. From that shape follow all four
 * consequences §1.3 lists, of which the first is the one that matters —
 * *"It records money as collected that was never collected."*
 *
 * A summary row cannot express a correction, cannot express a recomputation,
 * and cannot be audited, because the value it held a moment ago is gone. This
 * module is the other shape: a balance is a FOLD OVER SIGNED ENTRIES, and a
 * correction is a new, opposite entry — exactly the principle `2277:36-40`
 * already establishes for derived attribution data ("a re-computation is a new
 * row under a new algorithm_version, never a rewrite").
 *
 * ── THE PRE-MONEY BOUNDARY IS IN THE TYPE SYSTEM AND IN THE REFUSALS ────────
 * `09` §1: *"Portava moves no money."* That is still true and this module does
 * not change it. There is no `collection`, `capture`, `payout` or `settlement`
 * entry reason, and `buildBookingEntries` REFUSES outright if a caller hands it
 * a non-zero `collectedMinor`. It is the code-side twin of `2170:40`'s
 * `CHECK (cash_amount = 0)`: the boundary is structural, not a convention.
 *
 * ── MINOR UNITS, NOT FLOATS ─────────────────────────────────────────────────
 * `09` §3 refusal 1: no amount is stored as a float and no amount is stored
 * without its currency. Every amount here is a signed integer number of minor
 * units carried beside a `currency`. This also closes the independent-rounding
 * complaint at `docs/architecture/09_Payment_Architecture.md:385`: each
 * component is rounded ONCE, at the boundary, by `toMinor`.
 *
 * ── DOUBLE ENTRY, AND WHAT IT BUYS ──────────────────────────────────────────
 * Every transaction's entries sum to zero per currency (`09` §5.3 I1). That is
 * not accounting ceremony: it is what makes §1.3.1 impossible. A collection
 * recorded with no counterpart fails the invariant, so the fictitious figure
 * has nowhere to go.
 *
 * ── HAND-TO-HAND CASH IS DELIBERATELY NOT HERE ─────────────────────────────
 * `09` §9.2: *"Cash is not booked to the ledger as platform money."* The
 * `deposit_plus_cash` half settles between two humans and the platform has no
 * claim on it; it stays a booking fact (`rent_buddy_bookings.cash_balance_usd`)
 * and is not an entry.
 *
 * RUNTIME EFFECT: NONE on its own. Two shipping callers persist what it builds:
 * `lib/rentBuddyEarningsLedger.ts#createEarningsLedgerEntry`, reached from the
 * five booking-creation routes named in that module's header, and — for the
 * non-cash contributor ledger's own reversals —
 * `services/ledger/RewardReversal.ts`, reached from the reward worker
 * `lib/intelRewardScheduler.ts#runIntelRewardPass`.
 */

/** The addressable sides. A "wallet" is a name for a party's accounts (`09` §4). */
export type LedgerAccount =
  | "buddy_payable"       // what the platform would owe the buddy
  | "platform_revenue"    // the platform's take
  | "traveler_receivable" // what the traveller owes — NOT money the platform holds
  | "cash_external";      // reserved for the off-ledger memo pair (`09` §9.2); unwritten today

export const LEDGER_ACCOUNTS: readonly LedgerAccount[] = [
  "buddy_payable", "platform_revenue", "traveler_receivable", "cash_external",
] as const;

/**
 * Why an entry exists. There is deliberately NO value here that asserts money
 * arrived, left, or settled — see the module header.
 */
export type EntryReason =
  | "booking_gross"
  | "tip"
  | "platform_fee"
  | "traveler_service_fee"
  | "reversal";

export interface LedgerEntry {
  /** Deterministic, derived from the event — never from the attempt (`09` §7.1). */
  entryId: string;
  /** Entries sharing a transactionKey must sum to zero per currency (`09` §5.3 I1). */
  transactionKey: string;
  account: LedgerAccount;
  /** Signed minor units. Never zero — a zero entry is noise, not a fact. */
  amountMinor: number;
  currency: string;
  entryReason: EntryReason;
  /** The rule version that decided this amount (`07` §8, `09` §5.4). */
  ruleVersion: string;
  /** The commercial cause (`09` §6): booking → buddy profile → user, not ranking metadata. */
  attributionKind: "booking";
  attributionId: string;
  /** The credited party, on the entries that credit one. Null elsewhere. */
  beneficiaryUserId: string | null;
  /** Set on a reversing entry; names the exact entry it negates. */
  reversesEntryId: string | null;
  /**
   * Processor identity. `"none"` until one is chosen (`09` §1.1: no payment
   * processor is installed). NOTHING derived reads this field — that is the
   * property "provider can be swapped later" reduces to, and it is tested.
   */
  provider: string;
  externalRef: string | null;
  /** Replay key. Uniqueness is a database index, not an application check (`09` §7.2). */
  idempotencyKey: string;
}

export const NO_PROVIDER = "none";
export const DEFAULT_CURRENCY = "USD";

/** One rounding, at the boundary. `09` §3 refusal 1. */
export function toMinor(amount: number): number {
  return Math.round(amount * 100);
}
export function fromMinor(minor: number): number {
  return Math.round(minor) / 100;
}

// ── Reconstruction ──────────────────────────────────────────────────────────

export type Balances = Record<LedgerAccount, number>;

const zeroBalances = (): Balances => ({
  buddy_payable: 0, platform_revenue: 0, traveler_receivable: 0, cash_external: 0,
});

/**
 * THE balance. A fold over the entries, in minor units — never a stored total.
 * Addition is commutative over integers, so the result cannot depend on the
 * order entries arrive in; that is the property the test quantifies over.
 */
export function reconstructBalances(entries: readonly LedgerEntry[]): Balances {
  const out = zeroBalances();
  for (const e of entries) out[e.account] += e.amountMinor;
  return out;
}

export function balanceOf(entries: readonly LedgerEntry[], account: LedgerAccount): number {
  return reconstructBalances(entries)[account];
}

export interface UnbalancedTransaction {
  transactionKey: string;
  currency: string;
  residualMinor: number;
}

/** `09` §5.3 I1 — the residual of every (transaction, currency) group must be 0. */
export function unbalancedTransactions(entries: readonly LedgerEntry[]): UnbalancedTransaction[] {
  const sums = new Map<string, { transactionKey: string; currency: string; residualMinor: number }>();
  for (const e of entries) {
    const k = `${e.transactionKey}|${e.currency}`;
    const cur = sums.get(k) ?? { transactionKey: e.transactionKey, currency: e.currency, residualMinor: 0 };
    cur.residualMinor += e.amountMinor;
    sums.set(k, cur);
  }
  return [...sums.values()].filter((s) => s.residualMinor !== 0);
}

/** Every entry booked under one rule version — the audit read for `07` §8. */
export function entriesAtRuleVersion(entries: readonly LedgerEntry[], ruleVersion: string): LedgerEntry[] {
  return entries.filter((e) => e.ruleVersion === ruleVersion);
}

/**
 * What the ledger SAID under one rule version — `07` §10's "historical
 * recalculation is possible", read backwards.
 *
 * Corrections are excluded deliberately, and the distinction is the point. A
 * reversal carries the rule version of the entry it reverses (it is a fact
 * about THAT computation, not about today's), so folding a version's rows
 * wholesale nets a recomputed booking to zero and answers a different, useless
 * question. `entriesAtRuleVersion` stays complete — nothing is hidden — and
 * this is the read that reconstructs the historical answer.
 */
export function historicalBalanceAt(entries: readonly LedgerEntry[], ruleVersion: string): Balances {
  return reconstructBalances(
    entriesAtRuleVersion(entries, ruleVersion).filter((e) => e.entryReason !== "reversal"),
  );
}

// ── Building a booking's entries ────────────────────────────────────────────

export interface BookingEntryInput {
  bookingId: string;
  beneficiaryUserId: string;
  ruleVersion: string;
  totalUsd: number;
  tipUsd: number;
  platformFeeUsd: number;
  travelerServiceFeeUsd: number;
  currency?: string;
  /**
   * How much money actually arrived. The ONLY accepted value is 0 (or absent).
   * A caller that believes money was collected is describing something this
   * platform cannot do (`09` §1, §1.3.1) and is refused rather than recorded.
   */
  collectedMinor?: number;
}

export type BuildRefusal =
  | "collection_not_recordable"
  | "negative_input"
  | "missing_attribution"
  | "missing_rule_version";

export type BuildResult =
  | { status: "built"; entries: LedgerEntry[] }
  | { status: "refused"; reason: BuildRefusal; detail: string };

interface Leg { account: LedgerAccount; amountMinor: number; beneficiary: boolean }

function makeTransaction(
  input: Required<Pick<BookingEntryInput, "bookingId" | "beneficiaryUserId" | "ruleVersion">> & { currency: string },
  reason: EntryReason,
  legs: readonly Leg[],
): LedgerEntry[] {
  const transactionKey = `booking:${input.bookingId}:${reason}:${input.ruleVersion}`;
  return legs.map((leg, i) => ({
    entryId: `${transactionKey}#${i}`,
    transactionKey,
    account: leg.account,
    amountMinor: leg.amountMinor,
    currency: input.currency,
    entryReason: reason,
    ruleVersion: input.ruleVersion,
    attributionKind: "booking" as const,
    attributionId: input.bookingId,
    beneficiaryUserId: leg.beneficiary ? input.beneficiaryUserId : null,
    reversesEntryId: null,
    provider: NO_PROVIDER,
    externalRef: null,
    idempotencyKey: `${transactionKey}#${i}`,
  }));
}

/**
 * Turn one booking's priced breakdown into a balanced, versioned, attributed
 * entry set. Refuses rather than guesses; records nothing that claims money
 * moved.
 */
export function buildBookingEntries(input: BookingEntryInput): BuildResult {
  if (typeof input.collectedMinor === "number" && input.collectedMinor !== 0) {
    return {
      status: "refused",
      reason: "collection_not_recordable",
      detail:
        `collectedMinor=${input.collectedMinor}: Portava moves no money (09 §1); ` +
        "pay-deposit and pay-full return 503 and no funding source exists to book against",
    };
  }
  if (!input.bookingId || !input.beneficiaryUserId) {
    return { status: "refused", reason: "missing_attribution", detail: "an entry with no cause cannot be audited" };
  }
  if (!input.ruleVersion) {
    return { status: "refused", reason: "missing_rule_version", detail: "an unversioned entry cannot be recomputed" };
  }

  const amounts = {
    total: input.totalUsd, tip: input.tipUsd,
    fee: input.platformFeeUsd, tsf: input.travelerServiceFeeUsd,
  };
  for (const [name, v] of Object.entries(amounts)) {
    if (!Number.isFinite(v) || v < 0) {
      return { status: "refused", reason: "negative_input", detail: `${name}=${v}` };
    }
  }

  const currency = input.currency ?? DEFAULT_CURRENCY;
  const base = {
    bookingId: input.bookingId,
    beneficiaryUserId: input.beneficiaryUserId,
    ruleVersion: input.ruleVersion,
    currency,
  };

  const entries: LedgerEntry[] = [];
  const push = (reason: EntryReason, minor: number, legs: (m: number) => Leg[]) => {
    if (minor === 0) return; // a zero entry states nothing; omit it rather than book noise
    entries.push(...makeTransaction(base, reason, legs(minor)));
  };

  push("booking_gross", toMinor(amounts.total), (m) => [
    { account: "traveler_receivable", amountMinor: -m, beneficiary: false },
    { account: "buddy_payable", amountMinor: m, beneficiary: true },
  ]);
  push("tip", toMinor(amounts.tip), (m) => [
    { account: "traveler_receivable", amountMinor: -m, beneficiary: false },
    { account: "buddy_payable", amountMinor: m, beneficiary: true },
  ]);
  push("platform_fee", toMinor(amounts.fee), (m) => [
    { account: "buddy_payable", amountMinor: -m, beneficiary: true },
    { account: "platform_revenue", amountMinor: m, beneficiary: false },
  ]);
  push("traveler_service_fee", toMinor(amounts.tsf), (m) => [
    { account: "traveler_receivable", amountMinor: -m, beneficiary: false },
    { account: "platform_revenue", amountMinor: m, beneficiary: false },
  ]);

  return { status: "built", entries };
}

// ── Reversal ────────────────────────────────────────────────────────────────

export type ReversalRefusal = "unknown_transaction" | "already_reversed";

export type ReversalResult =
  | { status: "reversed"; entries: LedgerEntry[] }
  | { status: "refused"; reason: ReversalRefusal; detail: string };

const reversalKeyFor = (transactionKey: string) => `reversal:${transactionKey}`;

/**
 * The platform's own correction of its own error (`09` §9.2). A NEW transaction
 * whose entries are the negation of the original, each linked by
 * `reversesEntryId`. Never a DELETE and never an edit.
 *
 * At most one reversal per transaction: reversing twice re-credits money that
 * was only ever earned once, which is how a ledger invents money. The database
 * enforces the same rule with a partial unique index on the link column, so the
 * guarantee survives a concurrent second caller that this pure check cannot see.
 */
export function buildReversal(
  entries: readonly LedgerEntry[],
  opts: { transactionKey: string },
): ReversalResult {
  const originals = entries.filter((e) => e.transactionKey === opts.transactionKey);
  if (originals.length === 0) {
    return { status: "refused", reason: "unknown_transaction", detail: opts.transactionKey };
  }
  const originalIds = new Set(originals.map((e) => e.entryId));
  if (entries.some((e) => e.reversesEntryId !== null && originalIds.has(e.reversesEntryId))) {
    return { status: "refused", reason: "already_reversed", detail: opts.transactionKey };
  }

  const transactionKey = reversalKeyFor(opts.transactionKey);
  return {
    status: "reversed",
    entries: originals.map((e, i) => ({
      ...e,
      entryId: `${transactionKey}#${i}`,
      transactionKey,
      amountMinor: -e.amountMinor,
      entryReason: "reversal" as const,
      // The rule version of the entry being reversed, NOT today's: the reversal
      // is a fact about the old computation, and must read back under it.
      ruleVersion: e.ruleVersion,
      reversesEntryId: e.entryId,
      idempotencyKey: `${transactionKey}#${i}`,
    })),
  };
}

// ── Historical recalculation ────────────────────────────────────────────────

export type RecomputeRefusal = "same_rule_version" | "nothing_to_recompute" | BuildRefusal | ReversalRefusal;

export type RecomputeResult =
  | { status: "recomputed"; entries: LedgerEntry[]; reversed: string[] }
  | { status: "refused"; reason: RecomputeRefusal; detail: string };

/**
 * `07` §10 "historical recalculation is possible". Recomputing a booking under
 * a new rule version reverses every transaction booked under the old one and
 * appends the new ones. The old entries are never touched, so the historical
 * answer stays readable via `entriesAtRuleVersion` — the audit property `08` §7
 * asks for.
 */
export function recomputeUnderRuleVersion(
  entries: readonly LedgerEntry[],
  opts: { attributionId: string; ruleVersion: string; next: BookingEntryInput },
): RecomputeResult {
  const live = entries.filter(
    (e) => e.attributionId === opts.attributionId && e.entryReason !== "reversal",
  );
  if (live.length === 0) {
    return { status: "refused", reason: "nothing_to_recompute", detail: opts.attributionId };
  }
  if (live.some((e) => e.ruleVersion === opts.ruleVersion)) {
    return {
      status: "refused",
      reason: "same_rule_version",
      detail: `${opts.attributionId} already has entries at ${opts.ruleVersion}`,
    };
  }

  const built = buildBookingEntries({ ...opts.next, ruleVersion: opts.ruleVersion });
  if (built.status !== "built") {
    return { status: "refused", reason: built.reason, detail: built.detail };
  }

  const out: LedgerEntry[] = [];
  const reversed: string[] = [];
  const seen = new Set<string>();
  for (const e of live) {
    if (seen.has(e.transactionKey)) continue;
    seen.add(e.transactionKey);
    const r = buildReversal(entries, { transactionKey: e.transactionKey });
    if (r.status !== "reversed") return { status: "refused", reason: r.reason, detail: r.detail };
    out.push(...r.entries);
    reversed.push(e.transactionKey);
  }
  out.push(...built.entries);
  return { status: "recomputed", entries: out, reversed };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE CREATOR-TYPE LEDGER — `07` §10 for all SIX of §2's creator value types
// ═══════════════════════════════════════════════════════════════════════════
//
// ── WHY THIS SECTION EXISTS ────────────────────────────────────────────────
// Everything above is CORRECT and is about ONE creator type. `buildBookingEntries`
// takes a `bookingId`, stamps `attributionKind: "booking"`, and maps onto
// `rent_buddy_earnings_entries` (2901) — a table whose `booking_id` is
// `NOT NULL REFERENCES rent_buddy_bookings(id)` and whose `attribution_kind`
// CHECK admits the single value `'booking'`. That is `07` §2's **Travel
// Partner**, and it cannot be widened: a Trail Builder's earning is not a
// Rent-a-Buddy booking and must not FK to one.
//
// The other five types had no earning path at all. `intel_reward_ledger` (2170)
// covers **Local Expert** and is equally per-subsystem — no object, no creator
// type, no double entry. So `07` §10's "earnings can be recorded without
// paying" held for two of six.
//
// This section is the type-generic half, mapping onto `creator_earning_entries`
// (2921). Same shape, same invariants, same refusals — and one rule the booking
// half does not need:
//
// ── NO PRODUCER, NO EARNING ────────────────────────────────────────────────
// Four of the six types have no code that records their value event
// (`lib/creatorTypes.ts`). `buildCreatorEarningEntries` REFUSES such an
// attribution (`not_earnable`), and refuses one under a fraud hold
// (`fraud_hold`). Both refusals are structural at the database too — 2921's
// `cee_requires_recorded_value_event` trigger — so they hold for any writer,
// not only for callers of this module. A silent zero instead of a refusal is
// how a seam becomes indistinguishable from coverage.
//
// PRE-MONEY THROUGHOUT. There is no `collection`, `capture`, `payout` or
// `settlement` entry reason, no wallet account, no balance field, and
// `buildCreatorEarningEntries` refuses a non-zero `settledMinor` outright
// (`09` §1). A balance is a fold over signed entries and nothing else.

import type { CreatorAttribution } from "./creatorTypeAttribution.js";
import type { CreatorType } from "./creatorTypes.js";

/**
 * 2921's account vocabulary. `creator_payable`, not `buddy_payable`: the party
 * is a creator of one of six types, and only one of those is a buddy.
 */
export type CreatorLedgerAccount =
  | "creator_payable"
  | "platform_revenue"
  | "traveler_receivable"
  | "cash_external";

export const CREATOR_LEDGER_ACCOUNTS: readonly CreatorLedgerAccount[] = [
  "creator_payable", "platform_revenue", "traveler_receivable", "cash_external",
] as const;

/** 2921's reasons. NOTHING here asserts money arrived, left or settled. */
export type CreatorEntryReason = "value_attribution" | "revenue_share" | "platform_fee" | "reversal";

/** `07` §6's five revenue share sources, verbatim as slugs. */
export type RevenueSource =
  | "booking_commission"
  | "marketplace_fee"
  | "affiliate_commission"
  | "paid_trail_or_guide_product"
  | "sponsored_collaboration";

export const REVENUE_SOURCES: readonly RevenueSource[] = [
  "booking_commission", "marketplace_fee", "affiliate_commission",
  "paid_trail_or_guide_product", "sponsored_collaboration",
] as const;

export interface CreatorLedgerEntry {
  entryId: string;
  transactionKey: string;
  /** `07` §2's dimension, ON THE ENTRY — so a per-type read needs no join. */
  creatorType: CreatorType;
  /** The `creator_attributions` row this earning came from (`07` §7). */
  attributionId: string;
  account: CreatorLedgerAccount;
  amountMinor: number;
  currency: string;
  entryReason: CreatorEntryReason;
  revenueSource: RevenueSource | null;
  /** Always 0. Present so a reader can assert the boundary rather than assume it. */
  cashSettledMinor: 0;
  ruleVersion: string;
  beneficiaryUserId: string | null;
  reversesEntryId: string | null;
  /** Recorded, never read by any derived quantity (`09` §11). */
  provider: string;
  externalRef: string | null;
  idempotencyKey: string;
}

export type CreatorBalances = Record<CreatorLedgerAccount, number>;

/**
 * The ONE fold, shared by both account vocabularies. Extracted rather than
 * copied: `reconstructBalances` above and `reconstructCreatorBalances` below
 * differ only in which keys start at zero, and a second hand-written loop is a
 * second place for the two to drift.
 *
 * Addition is commutative over integers, so the result cannot depend on the
 * order entries arrive in — the property both test files quantify over.
 */
function foldBalances<A extends string>(
  entries: readonly { account: A; amountMinor: number }[],
  accounts: readonly A[],
): Record<A, number> {
  const out = Object.fromEntries(accounts.map((a) => [a, 0])) as Record<A, number>;
  for (const e of entries) out[e.account] += e.amountMinor;
  return out;
}

export function reconstructCreatorBalances(entries: readonly CreatorLedgerEntry[]): CreatorBalances {
  return foldBalances(entries, CREATOR_LEDGER_ACCOUNTS);
}

/** `09` §5.3 I1 — the residual of every (transaction, currency) group must be 0. */
export function unbalancedCreatorTransactions(
  entries: readonly CreatorLedgerEntry[],
): UnbalancedTransaction[] {
  const sums = new Map<string, UnbalancedTransaction>();
  for (const e of entries) {
    const k = `${e.transactionKey}|${e.currency}`;
    const cur = sums.get(k) ?? { transactionKey: e.transactionKey, currency: e.currency, residualMinor: 0 };
    cur.residualMinor += e.amountMinor;
    sums.set(k, cur);
  }
  return [...sums.values()].filter((s) => s.residualMinor !== 0);
}

export function creatorEntriesAtRuleVersion(
  entries: readonly CreatorLedgerEntry[],
  ruleVersion: string,
): CreatorLedgerEntry[] {
  return entries.filter((e) => e.ruleVersion === ruleVersion);
}

/**
 * What the ledger SAID under one rule version — `07` §10's "historical
 * recalculation is possible", read backwards. Corrections are excluded for the
 * reason `historicalBalanceAt` gives above: a reversal carries the rule version
 * of the entry it reverses, so folding a version's rows wholesale nets a
 * recomputed earning to zero and answers a different, useless question.
 */
export function historicalCreatorBalanceAt(
  entries: readonly CreatorLedgerEntry[],
  ruleVersion: string,
): CreatorBalances {
  return reconstructCreatorBalances(
    creatorEntriesAtRuleVersion(entries, ruleVersion).filter((e) => e.entryReason !== "reversal"),
  );
}

// ── Building one attribution's earning ──────────────────────────────────────

export interface CreatorEarningInput {
  /** `07` §8 "gross revenue" — what the conversion produced, as observed. */
  grossRevenueMinor: number;
  /** `07` §8 "provisional share" — what the RULE VERSION says the creator gets. */
  creatorShareMinor: number;
  /** The platform's take under the same rule version. */
  platformFeeMinor: number;
  revenueSource?: RevenueSource | null;
  currency?: string;
  /**
   * How much money actually settled. The ONLY accepted value is 0 (or absent).
   * `09` §1: Portava moves no money, and no funding source exists for any of the
   * six creator types.
   */
  settledMinor?: number;
}

export type CreatorEarningRefusal =
  | "not_earnable"
  | "fraud_hold"
  | "settlement_not_recordable"
  | "negative_input"
  | "share_exceeds_gross"
  | "unknown_revenue_source";

export type CreatorEarningResult =
  | { status: "built"; entries: CreatorLedgerEntry[] }
  | { status: "refused"; reason: CreatorEarningRefusal; detail: string };

interface CreatorLeg { account: CreatorLedgerAccount; amountMinor: number; beneficiary: boolean }

/**
 * Turn ONE attribution into a balanced, versioned, type-stamped entry set.
 *
 * Computes no percentage of its own: `creatorShareMinor` and `platformFeeMinor`
 * were decided by the rule version named on the attribution, whose parameters
 * live in `creator_rule_versions.params` (2920). `07` §8's "Actual percentages
 * must remain configurable" is the reason the arithmetic is not here.
 */
export function buildCreatorEarningEntries(
  attribution: CreatorAttribution,
  input: CreatorEarningInput,
): CreatorEarningResult {
  // `09` §1, checked FIRST: a caller asserting a settlement is wrong about the
  // platform, and nothing else it says should be interpreted.
  if (typeof input.settledMinor === "number" && input.settledMinor !== 0) {
    return {
      status: "refused",
      reason: "settlement_not_recordable",
      detail:
        `settledMinor=${input.settledMinor}: Portava moves no money (09 §1) and no payout, wallet ` +
        "or disbursement path exists for any of 07 §2's six creator types",
    };
  }
  // The two independent reasons an attribution can exist and produce nothing.
  // Ordered so the more fundamental one is reported: a seam has nothing to hold.
  if (attribution.basis !== "recorded_value_event") {
    return {
      status: "refused",
      reason: "not_earnable",
      detail:
        `${attribution.creatorType}: attribution basis is ${attribution.basis} — no value event was ` +
        "recorded, so there is nothing to earn against (07 §10)",
    };
  }
  if (attribution.fraudHold) {
    return {
      status: "refused",
      reason: "fraud_hold",
      detail: `${attribution.creatorType}: held for ${attribution.fraudHoldReason ?? "an unstated reason"} (07 §9)`,
    };
  }

  for (const [name, v] of Object.entries({
    grossRevenueMinor: input.grossRevenueMinor,
    creatorShareMinor: input.creatorShareMinor,
    platformFeeMinor: input.platformFeeMinor,
  })) {
    if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
      return { status: "refused", reason: "negative_input", detail: `${name}=${v}` };
    }
  }
  if (input.creatorShareMinor + input.platformFeeMinor > input.grossRevenueMinor) {
    return {
      status: "refused",
      reason: "share_exceeds_gross",
      detail:
        `${input.creatorShareMinor} + ${input.platformFeeMinor} > ${input.grossRevenueMinor}: ` +
        "distributing more than the conversion produced is how a ledger invents money",
    };
  }
  const revenueSource = input.revenueSource ?? null;
  if (revenueSource !== null && !REVENUE_SOURCES.includes(revenueSource)) {
    return { status: "refused", reason: "unknown_revenue_source", detail: String(revenueSource) };
  }

  const currency = input.currency ?? DEFAULT_CURRENCY;
  const entries: CreatorLedgerEntry[] = [];

  const push = (reason: CreatorEntryReason, minor: number, legs: (m: number) => CreatorLeg[]) => {
    if (minor === 0) return; // a zero entry states nothing; omit it rather than book noise
    const transactionKey = `creator:${attribution.id}:${reason}:${attribution.ruleVersion}`;
    entries.push(...legs(minor).map((leg, i) => ({
      entryId: `${transactionKey}#${i}`,
      transactionKey,
      creatorType: attribution.creatorType,
      attributionId: attribution.id,
      account: leg.account,
      amountMinor: leg.amountMinor,
      currency,
      entryReason: reason,
      revenueSource,
      cashSettledMinor: 0 as const,
      ruleVersion: attribution.ruleVersion,
      beneficiaryUserId: leg.beneficiary ? attribution.beneficiaryUserId : null,
      reversesEntryId: null,
      provider: NO_PROVIDER,
      externalRef: null,
      idempotencyKey: `${transactionKey}#${i}`,
    })));
  };

  push("revenue_share", input.creatorShareMinor, (m) => [
    { account: "traveler_receivable", amountMinor: -m, beneficiary: false },
    { account: "creator_payable", amountMinor: m, beneficiary: true },
  ]);
  push("platform_fee", input.platformFeeMinor, (m) => [
    { account: "traveler_receivable", amountMinor: -m, beneficiary: false },
    { account: "platform_revenue", amountMinor: m, beneficiary: false },
  ]);

  return { status: "built", entries };
}

// ── Reversal ────────────────────────────────────────────────────────────────

export type CreatorReversalResult =
  | { status: "reversed"; entries: CreatorLedgerEntry[] }
  | { status: "refused"; reason: ReversalRefusal; detail: string };

/**
 * The platform's own correction of its own error (`09` §9.2). A NEW transaction
 * whose entries are the negation of the original, each linked by
 * `reversesEntryId`. Never a DELETE and never an edit.
 *
 * At most one reversal per transaction: reversing twice re-credits an earning
 * that was only ever earned once. 2921 enforces the same rule with a partial
 * unique index on the link column, so the guarantee survives a concurrent
 * second caller this pure check cannot see.
 */
export function buildCreatorReversal(
  entries: readonly CreatorLedgerEntry[],
  opts: { transactionKey: string },
): CreatorReversalResult {
  const originals = entries.filter((e) => e.transactionKey === opts.transactionKey);
  if (originals.length === 0) {
    return { status: "refused", reason: "unknown_transaction", detail: opts.transactionKey };
  }
  const originalIds = new Set(originals.map((e) => e.entryId));
  if (entries.some((e) => e.reversesEntryId !== null && originalIds.has(e.reversesEntryId))) {
    return { status: "refused", reason: "already_reversed", detail: opts.transactionKey };
  }

  const transactionKey = `reversal:${opts.transactionKey}`;
  return {
    status: "reversed",
    entries: originals.map((e, i) => ({
      ...e,
      entryId: `${transactionKey}#${i}`,
      transactionKey,
      amountMinor: -e.amountMinor,
      entryReason: "reversal" as const,
      // The rule version of the entry being reversed, NOT today's: the reversal
      // is a fact about the old computation and must read back under it.
      ruleVersion: e.ruleVersion,
      reversesEntryId: e.entryId,
      idempotencyKey: `${transactionKey}#${i}`,
    })),
  };
}

// ── Historical recalculation ────────────────────────────────────────────────

export type CreatorRecomputeResult =
  | { status: "recomputed"; entries: CreatorLedgerEntry[]; reversed: string[] }
  | { status: "refused"; reason: RecomputeRefusal | CreatorEarningRefusal; detail: string };

/**
 * `07` §10 "historical recalculation is possible", per creator type. Recomputing
 * one attribution under a new rule version reverses every transaction booked
 * under the old one and appends the new ones. The old entries are never touched,
 * so the historical answer stays readable via `creatorEntriesAtRuleVersion`.
 */
export function recomputeCreatorUnderRuleVersion(
  entries: readonly CreatorLedgerEntry[],
  opts: { attributionId: string; ruleVersion: string; next: CreatorEarningInput },
): CreatorRecomputeResult {
  const live = entries.filter(
    (e) => e.attributionId === opts.attributionId && e.entryReason !== "reversal",
  );
  if (live.length === 0) {
    return { status: "refused", reason: "nothing_to_recompute", detail: opts.attributionId };
  }
  if (live.some((e) => e.ruleVersion === opts.ruleVersion)) {
    return {
      status: "refused",
      reason: "same_rule_version",
      detail: `${opts.attributionId} already has entries at ${opts.ruleVersion}`,
    };
  }

  // The attribution is reconstructed from the entries rather than re-supplied:
  // a caller that hands in a DIFFERENT attribution would silently re-file the
  // earning under another party or another type.
  const seed = live[0];
  const rebuiltAgainst: CreatorAttribution = {
    id: opts.attributionId,
    creatorType: seed.creatorType,
    // These four are not read by buildCreatorEarningEntries; they are carried so
    // the value passed is a whole attribution rather than a partial cast.
    subjectKind: "booking",
    subjectId: opts.attributionId,
    valueEvent: "verified_booking",
    valueEventId: opts.attributionId,
    basis: "recorded_value_event",
    beneficiaryUserId: live.find((e) => e.beneficiaryUserId !== null)?.beneficiaryUserId ?? "",
    weight: 0,
    confidence: 0,
    grossRevenueMinor: 0,
    provisionalShareMinor: 0,
    currency: seed.currency,
    settledMinor: 0,
    ruleVersion: opts.ruleVersion,
    fraudHold: false,
    fraudHoldReason: null,
    supersedesId: null,
    earnable: true,
    idempotencyKey: opts.attributionId,
  };

  const built = buildCreatorEarningEntries(rebuiltAgainst, { ...opts.next, currency: seed.currency });
  if (built.status !== "built") {
    return { status: "refused", reason: built.reason, detail: built.detail };
  }

  const out: CreatorLedgerEntry[] = [];
  const reversed: string[] = [];
  const seen = new Set<string>();
  for (const e of live) {
    if (seen.has(e.transactionKey)) continue;
    seen.add(e.transactionKey);
    const r = buildCreatorReversal(entries, { transactionKey: e.transactionKey });
    if (r.status !== "reversed") return { status: "refused", reason: r.reason, detail: r.detail };
    out.push(...r.entries);
    reversed.push(e.transactionKey);
  }
  out.push(...built.entries);
  return { status: "recomputed", entries: out, reversed };
}
