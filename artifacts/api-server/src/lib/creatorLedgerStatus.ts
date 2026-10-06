/**
 * creatorLedgerStatus — what a creator's ledger SAYS, read from its rows.
 * PURE. It reaches no database and moves no money.
 *
 * census-discovery DC-23 (`11` §6: "Read: impact summaries, attributed
 * conversions, provisional earnings, payout eligibility … No client-side
 * earning calculation"), DV-59 (a hold must READ as held), DV-65 ("every
 * earning can be reconstructed"), DV-66 ("no balance depends on mutable
 * totals"), DV-68 ("reversals are possible").
 *
 * ── THE CHAIN ───────────────────────────────────────────────────────────────
 * `creator_attributions` is append-only (2920). A hold, a release and a
 * recomputation are each a NEW row naming the row it supersedes, and 2920's
 * `ca_one_supersede_per_row` admits at most one successor per row, so every
 * attribution belongs to exactly one linear chain whose HEAD — the row nothing
 * supersedes — is its current state. Nothing stores "current": it is derived
 * here, the same fold-not-a-flag principle as the balance.
 *
 * ── THE STATUS OF AN EARNING, OF `09` §3's EIGHT ────────────────────────────
 * `09` §3 names observed · provisional · pending · verified · held · payable ·
 * paid · reversed. This module can derive THREE of them from rows and says so:
 *
 *   reversed     the entry is a reversal, or a reversal names it (the pair nets
 *                to zero and is kept, never deleted — `09` §6);
 *   held         the head of the entry's attribution chain carries a fraud hold;
 *   provisional  everything else.
 *
 * `payable` and `paid` are NEVER produced. Payable needs payout eligibility,
 * and `07` §4's progression (account age, verification, trust, contribution
 * history, fraud signals, payout compliance) is the owner's rule, not yet
 * written; paid needs a provider, and none exists (DV-81: "payouts remain
 * disabled"). `pending` and `verified` need a verification step no producer
 * records. An earning is therefore never shown as money a creator can
 * withdraw, and the summary says `availableMinor: 0` with the reason, rather
 * than omitting the field for a client to fill in.
 *
 * ── WHICH LEDGERS A HOLD CAN REACH ──────────────────────────────────────────
 *   creator_earning_entries      — attribution_id is the FK; a hold reaches it.
 *   rent_buddy_earnings_entries  — attribution_id is the booking id, which a
 *                                  travel_partner attribution names as its
 *                                  subject; a hold on that attribution reaches
 *                                  the booking's legs.
 *   intel_reward_ledger          — carries no attribution id (2930 says NULL
 *                                  rather than inventing one), so no hold can
 *                                  be linked to it. Reported as `holdable: false`.
 */
import {
  UNIT_ACCUMULATION_SCALE,
  type CanonicalShareRow,
  type SourceLedger,
  type UnitKind,
} from "./creatorShareCanonical.js";

// ── Row shapes, as PostgREST returns them ───────────────────────────────────

export interface AttributionRow {
  id: string;
  creator_type: string;
  subject_kind: string;
  subject_id: string;
  value_event: string;
  value_event_id: string | null;
  attribution_basis: string;
  /**
   * NULL means the beneficiary identity was SEVERED — see `isIdentitySevered`.
   * 2920 declares the column NOT NULL; the C-11 "retain pseudonymised" answer
   * drops that, so every reader must already be able to say what a severed
   * identity means before it is applied.
   */
  beneficiary_user_id: string | null;
  weight: number | string;
  confidence: number | string;
  gross_revenue_minor: number | string;
  provisional_share_minor: number | string;
  currency: string;
  settled_minor?: number | string;
  rule_version: string;
  fraud_hold: boolean;
  fraud_hold_reason: string | null;
  supersedes_id: string | null;
  idempotency_key: string;
  computed_at?: string;
  /** 3386. Absent on a database where 3386 is not applied. */
  recommendation_id?: string | null;
}

export interface EarningEntryRow {
  id: string;
  transaction_key: string;
  creator_type: string;
  attribution_id: string;
  account: string;
  entry_reason: string;
  revenue_source: string | null;
  amount_minor: number | string;
  currency: string;
  cash_settled_minor?: number | string;
  rule_version: string;
  beneficiary_user_id: string | null;
  reverses_entry_id: string | null;
  provider?: string;
  external_ref?: string | null;
  idempotency_key: string;
  occurred_at?: string;
}

/**
 * Whether a persisted attribution row's beneficiary identity has been SEVERED.
 *
 * `creator_attributions.beneficiary_user_id` is NULL on exactly one kind of
 * row: one the C-11 "retain pseudonymised" answer has erased the identity from
 * — the profile id is replaced by a pseudonym and the accounting row is kept.
 *
 * That is a STATE, and specifically NOT any of these:
 *   * not a read that failed — the row is intact and readable, and what it no
 *     longer says is WHO;
 *   * not an absent row — `resolveHead`/`readAttributionChain` answer
 *     `unknown_attribution`/`not_found` for that, and must keep doing so;
 *   * not a beneficiary. `String(null)` is the string `"null"`, and a reader
 *     that produced it would hand every erased creator in the ledger the SAME
 *     phantom id — one collapsed beneficiary named `"null"`.
 *
 * Every reader asks the question here so there is one notion of severed and no
 * second place for a coercion to reappear.
 */
export function beneficiaryIsNamed<T extends { beneficiary_user_id: string | null }>(
  row: T,
): row is T & { beneficiary_user_id: string } {
  return beneficiaryState(row) === "named"; // a uuid; NULL is severed, anything else unreadable (foot)
}

/** Exactly NULL: erased. NOT the negation of `beneficiaryIsNamed` — see `beneficiaryState`. */
export const isIdentitySevered = (row: { beneficiary_user_id: string | null }): boolean =>
  beneficiaryState(row) === "severed";

export const toNum = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
};

// ── Chains ──────────────────────────────────────────────────────────────────

export interface ChainIndex {
  byId: ReadonlyMap<string, AttributionRow>;
  /** The row that supersedes `id`, if any. */
  successorOf(id: string): AttributionRow | null;
  /** The current state of `id`'s chain. Null for an unknown id. */
  headOf(id: string): AttributionRow | null;
  /** Oldest → newest. Empty for an unknown id. */
  chainOf(id: string): AttributionRow[];
  /** Every head (one per chain). */
  heads(): AttributionRow[];
  /**
   * Rows superseded by MORE THAN ONE row. 2920's `ca_one_supersede_per_row`
   * makes this impossible in the database; a non-empty list means the rows
   * were not read from it, and every derived answer is refused.
   */
  forks: readonly string[];
}

export function indexChains(rows: readonly AttributionRow[]): ChainIndex {
  const byId = new Map<string, AttributionRow>();
  for (const r of rows) byId.set(String(r.id), r);
  const successor = new Map<string, AttributionRow>();
  const forks: string[] = [];
  for (const r of rows) {
    if (!r.supersedes_id) continue;
    const prev = String(r.supersedes_id);
    if (successor.has(prev)) forks.push(prev);
    else successor.set(prev, r);
  }
  const limit = rows.length + 1;
  const headOf = (id: string): AttributionRow | null => {
    let cur = byId.get(id) ?? null;
    for (let i = 0; cur && i < limit; i++) {
      const next = successor.get(String(cur.id));
      if (!next) return cur;
      cur = next;
    }
    return null; // unknown id, or a cycle the database cannot produce
  };
  const chainOf = (id: string): AttributionRow[] => {
    let root = byId.get(id) ?? null;
    for (let i = 0; root && root.supersedes_id && i < limit; i++) {
      const prev = byId.get(String(root.supersedes_id));
      if (!prev) break;
      root = prev;
    }
    const out: AttributionRow[] = [];
    for (let cur = root, i = 0; cur && i < limit; i++) {
      out.push(cur);
      cur = successor.get(String(cur.id)) ?? null;
    }
    return out;
  };
  return {
    byId,
    successorOf: (id) => successor.get(id) ?? null,
    headOf,
    chainOf,
    heads: () => rows.filter((r) => !successor.has(String(r.id))),
    forks,
  };
}

export type AttributionState = "active" | "held" | "seam" | "superseded";

/** The state of one row: a non-head is superseded; a head is held, a seam, or active. */
export function attributionState(row: AttributionRow, chains: ChainIndex): AttributionState {
  if (chains.successorOf(String(row.id))) return "superseded";
  if (row.fraud_hold) return "held";
  if (row.attribution_basis !== "recorded_value_event") return "seam";
  return "active";
}

// ── Entry status ────────────────────────────────────────────────────────────

/** The three of `09` §3's eight states that rows alone can establish. */
export type EarningStatus = "provisional" | "held" | "reversed";

/**
 * The attribution chain a canonical row belongs to, or null.
 *
 * `creator_earning_entries` names it by FK; a Rent-a-Buddy leg names its
 * booking, which a travel_partner attribution names as its subject;
 * `intel_reward_ledger` names nothing.
 */
export function attributionHeadForCanonicalRow(
  row: CanonicalShareRow,
  chains: ChainIndex,
  travelPartnerChainByBooking: ReadonlyMap<string, string>,
): AttributionRow | null {
  if (row.attributionId === null) return null;
  if (row.sourceLedger === "creator_earning_entries") return chains.headOf(row.attributionId);
  if (row.sourceLedger === "rent_buddy_earnings_entries") {
    const member = travelPartnerChainByBooking.get(row.attributionId);
    return member ? chains.headOf(member) : null;
  }
  return null;
}

/** Can a hold reach this ledger's rows at all? Structural, per ledger. */
export const HOLD_REACHES: Readonly<Record<SourceLedger, boolean>> = {
  creator_earning_entries: true,
  rent_buddy_earnings_entries: true,
  intel_reward_ledger: false,
};

/** booking id → one attribution id of the travel_partner chain that names it. */
export function travelPartnerChainsByBooking(rows: readonly AttributionRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.creator_type === "travel_partner" && r.subject_kind === "booking" && !out.has(String(r.subject_id))) {
      out.set(String(r.subject_id), String(r.id));
    }
  }
  return out;
}

export function statusOfCanonicalRow(
  row: CanonicalShareRow,
  reversedIds: ReadonlySet<string>,
  head: AttributionRow | null,
): EarningStatus {
  if (row.reversesSourceEntryId !== null || reversedIds.has(`${row.sourceLedger}|${row.sourceEntryId}`)) {
    return "reversed";
  }
  if (head?.fraud_hold) return "held";
  return "provisional";
}

// ── The earnings summary (`11` §6 "provisional earnings") ───────────────────

export interface EarningsBucket {
  sourceLedger: SourceLedger;
  unitKind: UnitKind;
  unitCode: string;
  /** Not held, not reversed. NOT money that can be withdrawn. */
  provisional: number;
  /** Under a fraud hold. Rendered as held, never as payable. */
  held: number;
  /** Reversal pairs, netted. Zero unless a reversal is itself unpaired. */
  reversedNet: number;
  /** Every creator leg summed: provisional + held + reversedNet. */
  lifetimeNet: number;
  /**
   * What could be paid out now. Always 0: no payout eligibility rule exists
   * (`07` §4 is the owner's) and payouts remain disabled (DV-81).
   */
  available: 0;
  /** Whether a fraud hold can reach this ledger's rows at all. */
  holdable: boolean;
  entries: number;
}

export interface EarningsSummary {
  buckets: EarningsBucket[];
  availableReason: string;
}

export const AVAILABLE_REASON =
  "No payout eligibility rule exists (07 §4 is an owner decision) and payouts remain disabled (DV-81); " +
  "every figure here is provisional or held, never payable.";

export interface StatusedCanonicalRow extends CanonicalShareRow {
  status: EarningStatus;
  attributionHeadId: string | null;
}

/**
 * Status every creator leg of ONE creator, and fold them per (ledger, unit).
 *
 * `rows` must be that creator's creator-role legs (their reversals included —
 * a reversal leg carries the same beneficiary). Accumulated in scaled
 * integers, per `lib/creatorShareCanonical.ts`'s order-independence argument;
 * no two units ever meet.
 */
export function summarizeCreatorEarnings(
  creatorId: string,
  rows: readonly CanonicalShareRow[],
  attributions: readonly AttributionRow[],
): { summary: EarningsSummary; entries: StatusedCanonicalRow[] } {
  const chains = indexChains(attributions);
  const byBooking = travelPartnerChainsByBooking(attributions);
  const mine = rows.filter((r) => r.partyRole === "creator" && r.creatorId === creatorId);
  const reversedIds = new Set<string>();
  for (const r of mine) {
    if (r.reversesSourceEntryId) reversedIds.add(`${r.sourceLedger}|${r.reversesSourceEntryId}`);
  }

  const entries: StatusedCanonicalRow[] = mine.map((r) => {
    const head = attributionHeadForCanonicalRow(r, chains, byBooking);
    return { ...r, status: statusOfCanonicalRow(r, reversedIds, head), attributionHeadId: head ? String(head.id) : null };
  });

  interface Acc { sourceLedger: SourceLedger; unitKind: UnitKind; unitCode: string; p: number; h: number; r: number; n: number }
  const acc = new Map<string, Acc>();
  for (const e of entries) {
    const k = `${e.sourceLedger}|${e.unitKind}|${e.unitCode}`;
    const a = acc.get(k) ?? { sourceLedger: e.sourceLedger, unitKind: e.unitKind, unitCode: e.unitCode, p: 0, h: 0, r: 0, n: 0 };
    const scaled = Math.round(e.amount * UNIT_ACCUMULATION_SCALE[e.unitKind]);
    if (e.status === "provisional") a.p += scaled;
    else if (e.status === "held") a.h += scaled;
    else a.r += scaled;
    a.n += 1;
    acc.set(k, a);
  }
  const buckets: EarningsBucket[] = [...acc.values()]
    .map((a) => {
      const s = UNIT_ACCUMULATION_SCALE[a.unitKind];
      return {
        sourceLedger: a.sourceLedger,
        unitKind: a.unitKind,
        unitCode: a.unitCode,
        provisional: a.p / s,
        held: a.h / s,
        reversedNet: a.r / s,
        lifetimeNet: (a.p + a.h + a.r) / s,
        available: 0 as const,
        holdable: HOLD_REACHES[a.sourceLedger],
        entries: a.n,
      };
    })
    .sort((x, y) =>
      x.sourceLedger.localeCompare(y.sourceLedger) ||
      x.unitKind.localeCompare(y.unitKind) ||
      x.unitCode.localeCompare(y.unitCode));
  return { summary: { buckets, availableReason: AVAILABLE_REASON }, entries };
}

// ── Attributed conversions and impact (`11` §6) ─────────────────────────────

export interface AttributedConversion {
  /** The HEAD of the chain — the attribution's current state. */
  attributionId: string;
  creatorType: string;
  subjectKind: string;
  subjectId: string;
  valueEvent: string;
  valueEventId: string | null;
  state: Exclude<AttributionState, "superseded">;
  ruleVersion: string;
  /** Whether a served recommendation is linked. The id itself is a traveller's exposure and is not shown. */
  recommendationLinked: boolean;
  /** How many rows the chain has (1 = never held, released or recomputed). */
  revisions: number;
  computedAt: string | null;
}

/**
 * One entry per chain, at its head. Seams are listed (they are real,
 * addressable records) and labelled `seam`; they are never counted as value.
 * Weight and confidence are NOT exposed: `07` §3 keeps Traveler Impact
 * internal, and a per-row confidence is exactly a score a creator could game.
 */
export function attributedConversions(rows: readonly AttributionRow[]): AttributedConversion[] {
  const chains = indexChains(rows);
  return chains.heads()
    .map((h) => ({
      attributionId: String(h.id),
      creatorType: h.creator_type,
      subjectKind: h.subject_kind,
      subjectId: String(h.subject_id),
      valueEvent: h.value_event,
      valueEventId: h.value_event_id ? String(h.value_event_id) : null,
      state: attributionState(h, chains) as Exclude<AttributionState, "superseded">,
      ruleVersion: h.rule_version,
      recommendationLinked: typeof h.recommendation_id === "string" && h.recommendation_id.length > 0,
      revisions: chains.chainOf(String(h.id)).length,
      computedAt: h.computed_at ?? null,
    }))
    .sort((a, b) => (b.computedAt ?? "").localeCompare(a.computedAt ?? "") || a.attributionId.localeCompare(b.attributionId));
}

export interface ImpactSummary {
  /** Per `07` §3 outcome: recorded value events attributed to this creator. Seams excluded. */
  outcomes: Array<{ valueEvent: string; attributed: number; held: number }>;
  /** Seam rows — contributions recorded with no value-event producer. Not value. */
  seams: number;
}

/**
 * `11` §6 "impact summaries" — COUNTS per outcome, never one number. `07` §3:
 * "Do not expose one raw public score that creators can game."
 */
export function impactSummary(rows: readonly AttributionRow[]): ImpactSummary {
  const chains = indexChains(rows);
  const per = new Map<string, { attributed: number; held: number }>();
  let seams = 0;
  for (const h of chains.heads()) {
    // Basis FIRST: a held seam is still a seam, and never value.
    if (h.attribution_basis !== "recorded_value_event") { seams++; continue; }
    const cur = per.get(h.value_event) ?? { attributed: 0, held: 0 };
    cur.attributed++;
    if (h.fraud_hold) cur.held++;
    per.set(h.value_event, cur);
  }
  return {
    outcomes: [...per.entries()].map(([valueEvent, c]) => ({ valueEvent, ...c }))
      .sort((a, b) => a.valueEvent.localeCompare(b.valueEvent)),
    seams,
  };
}

// ── The three states of a persisted beneficiary column ───────────────────────
// Appended at the foot so every cited line above keeps its number (verifier
// finding F5 on PR #594, 2026-10-06).
//
//   named       a uuid-shaped string — the column is `uuid`, so anything else
//               did not come from it intact;
//   severed     exactly NULL — the identity was erased (C-11 "retain
//               pseudonymised") and the accounting row kept;
//   unreadable  anything else. `undefined` means the column was not selected or
//               the row is not the shape this module thinks it is; `""`,
//               whitespace, a non-uuid or a number cannot be a beneficiary. That
//               is a READ FAULT, and it is never reported as `identity_severed`:
//               doing so would assert an erasure that did not happen, which is
//               the master invariant (a failed read is never an answer) seen from
//               the other side.
export type BeneficiaryState = "named" | "severed" | "unreadable";

const BENEFICIARY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function beneficiaryState(row: { beneficiary_user_id?: unknown }): BeneficiaryState {
  const v = row?.beneficiary_user_id;
  if (v === null) return "severed";
  if (typeof v === "string" && BENEFICIARY_UUID.test(v)) return "named";
  return "unreadable";
}
