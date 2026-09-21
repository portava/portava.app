/**
 * creatorShareCanonical — the creator share, computed from ONE ledger.
 * PURE. It reaches no database and moves no money.
 *
 * ── THE CRITERION ───────────────────────────────────────────────────────────
 * `08` §7 (specs/discovery-v1/08_Portava_Revenue_Model.md): *"Revenue
 * architecture is healthy when … attribution is auditable, creator share can be
 * computed from THE SAME LEDGER."*
 *
 * Before migration 2930 there was no "the". Earnings are recorded in two
 * unrelated relations with no relation spanning them:
 *
 *   `public.intel_reward_ledger`         (2170 + 2900) — contributors, NON-CASH,
 *       `qiu numeric` + `earned_units integer`, `CHECK (cash_amount = 0)`, and
 *       SINGLE-SIDED: every row credits `actor_id` and nothing records a
 *       platform counterpart.
 *   `public.rent_buddy_earnings_entries` (2901)        — marketplace, DOUBLE
 *       ENTRY, signed `amount_minor bigint` + `currency char(3)`,
 *       `CHECK (cash_settled_minor = 0)`.
 *
 * 2930 adds `public.creator_share_ledger`, a VIEW over both — the shape `09` §5
 * already names: *"Wallet is a projection … REBUILDABLE FROM LEDGER."* A view
 * stores nothing, so it cannot drift from what it projects; and it is not a
 * second place a balance could be read from, which is what `10` §1's "avoid
 * parallel systems" rules out. This module is the fold over that relation.
 *
 * ── THE HARD PART: TWO UNIT SYSTEMS, AND NO RATE BETWEEN THEM ───────────────
 * `qiu`, non-cash `credits` and currency minor units ARE NOT COMMENSURABLE.
 * Nothing in this repository says what one is worth in another:
 *
 *   • `lib/rewardEarnings.ts` `QIU_TO_CREDITS = 100` looks like a rate and is
 *     not usable as one here: BOTH figures are already recorded on every reward
 *     row, so applying it would restate one earning twice rather than convert
 *     it.
 *   • There is no credit→currency rate anywhere. 2170's header is "Stamps/
 *     credits; no cash", and `fx_rates` holds ECB reference rates between
 *     CURRENCIES only (`docs/architecture/09_Payment_Architecture.md` §2).
 *
 * So no total here ever spans two units, and the shape is what refuses to:
 * `(sourceLedger, unitKind, unitCode)` is part of every result key, not a label
 * attached to a number that has already been added up. That is the repository's
 * own standing rule about absent rates — §8 of that document: *"NEVER
 * FABRICATE. `convert()` returns null when a rate is missing … a missing rate
 * is a REFUSAL TO BOOK, not a guess"* — and `09` §5.3 I4, *"no currency mixing
 * inside one entry pair"*.
 *
 * ── WHAT "SHARE" MEANS, AND WHAT IT REFUSES TO MEAN ─────────────────────────
 * `08` §5 lists "creator/host share" beside "gross booking value, Portava fee,
 * … net payout" — an AMOUNT, not a percentage. `creatorAmount` is therefore the
 * answer to DV-64, and it is computable for BOTH ledgers.
 *
 * A RATIO additionally needs a recorded denominator, and only one of the two
 * ledgers has one. `rent_buddy_earnings_entries` books the platform's take as a
 * `platform_revenue` leg of the same transaction; `intel_reward_ledger` books
 * no counterpart at all. So `sharePpm` is `null` on the contributor ledger —
 * ABSENT, not 100%. `09` §5.3 I7: absence is not permitted to be silent.
 *
 * `07` §7 ("multi-party attribution") is unbuilt, and this module does not
 * pre-empt it: when one attribution names more than one creator, the platform
 * leg cannot be split without inventing the weights, so the basis is
 * `ambiguous_attribution` and the ratio is `null`. The creator's own amount
 * stays computable, because that never needed a split.
 *
 * ── ORDER INDEPENDENCE IS NOT FREE ──────────────────────────────────────────
 * `09` §11: *"no balance depends on mutable totals."* A fold is only a balance
 * if it gives the same answer whatever order the rows arrive in — and in IEEE
 * 754 that is FALSE for fractional addition (0.1 + 0.2 + 0.3 depends on
 * association). `qiu` is a fractional `numeric`. So amounts are accumulated as
 * SCALED INTEGERS, which are exactly commutative and associative, and converted
 * back once at the end. `services/ledger/RewardReversal.ts#reconstructRewardBalance`
 * rounds to 1e-6 after the fact, which fixes the display and not the algebra;
 * this does it before the fact, and the property test quantifies over
 * permutations of adversarial fractions rather than illustrating one.
 *
 * RUNTIME EFFECT: NONE on its own. The shipping reader is
 * `services/ledger/CanonicalShareReader.ts`.
 */

/** The canonical relation created by migration 2930. */
export const CREATOR_SHARE_LEDGER = "creator_share_ledger";

/** The two physical partitions behind the view. */
export type SourceLedger = "intel_reward_ledger" | "rent_buddy_earnings_entries";

export const SOURCE_LEDGERS: readonly SourceLedger[] = [
  "intel_reward_ledger", "rent_buddy_earnings_entries",
] as const;

/**
 * Whose side of a transaction an entry is on. `2901`'s `rbee_account_check`
 * fixes the marketplace domain to four accounts, so this mapping is TOTAL.
 */
export type PartyRole = "creator" | "platform" | "traveler" | "external";

/** 2901 account → party role. Total by construction; no silent default. */
export const ACCOUNT_PARTY_ROLE: Readonly<Record<string, PartyRole>> = {
  buddy_payable: "creator",
  platform_revenue: "platform",
  traveler_receivable: "traveler",
  cash_external: "external",
};

/**
 * The unit an amount is counted in. A GROUPING KEY, never a label:
 *
 *   `currency` — `amount` is signed MINOR units of `unitCode` (ISO 4217).
 *   `credit`   — `amount` is a signed whole count of non-cash credits.
 *   `qiu`      — `amount` is a signed exact quantity of quality-intel units.
 *                It has no fixed scale and IS NOT MONEY.
 *
 * SUMMING ACROSS `unitKind` OR `unitCode` IS A BUG, ALWAYS. There is no rate.
 */
export type UnitKind = "qiu" | "credit" | "currency";

export const UNIT_KINDS: readonly UnitKind[] = ["qiu", "credit", "currency"] as const;

/**
 * Does the source ledger record the platform's counterpart to a creator's
 * earning? STRUCTURAL, read off the migrations rather than off the data: 2170
 * books one single-sided row per earning, 2901 books a balanced transaction.
 *
 * Deriving it from the rows instead would make an honest marketplace booking
 * with a zero platform fee indistinguishable from a ledger that records no
 * denominator at all, and those are different facts.
 */
export const SOURCE_RECORDS_PLATFORM_SIDE: Readonly<Record<SourceLedger, boolean>> = {
  intel_reward_ledger: false,
  rent_buddy_earnings_entries: true,
};

/**
 * Accumulation scale per unit — see "ORDER INDEPENDENCE IS NOT FREE" above.
 * 1e6 for qiu mirrors the 1e-6 resolution `reconstructRewardBalance` already
 * settles on; credits and minor units are integers and need no scaling.
 */
export const UNIT_ACCUMULATION_SCALE: Readonly<Record<UnitKind, number>> = {
  qiu: 1_000_000,
  credit: 1,
  currency: 1,
};

/** One row of `public.creator_share_ledger`. */
export interface CanonicalShareRow {
  sourceLedger: SourceLedger;
  /** The base table's `id`, verbatim. Identifiers are never rewritten. */
  sourceEntryId: string;
  unitKind: UnitKind;
  unitCode: string;
  /** Signed, in `unitKind`'s representation. */
  amount: number;
  partyRole: PartyRole;
  /** The credited party. Null on platform/traveller/external legs. */
  creatorId: string | null;
  entryReason: string;
  ruleVersion: string;
  attributionKind: string;
  /** Null on `intel_reward_ledger`, which carries no attribution id. */
  attributionId: string | null;
  reversesSourceEntryId: string | null;
  /** `cash_amount` / `cash_settled_minor`. CHECK-zero in both base tables. */
  cashRecorded: number;
  occurredAt: string;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
};

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));

const nullableStr = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

// ── Projection: base rows → canonical rows ──────────────────────────────────
//
// These are the TypeScript twin of 2930's SELECT list. They exist so the
// reconciliation can compute the per-ledger answer INDEPENDENTLY of the view —
// a view that reconciles only against itself proves nothing — and so a test can
// hold the two mappings against each other without a database.

/** `public.intel_reward_ledger`, as PostgREST returns it. */
export interface IntelRewardLedgerRowLike {
  id: string;
  actor_id: string;
  source?: string | null;
  qiu?: number | string | null;
  earned_units?: number | string | null;
  cash_amount?: number | string | null;
  ledger_version?: string | null;
  reverses_entry_id?: string | null;
  created_at?: string | null;
}

/**
 * ONE REWARD ROW PROJECTS TO TWO CANONICAL ROWS, one per unit it carries —
 * never to one row converted into the other. Both figures are recorded
 * independently on the source row.
 */
export function projectRewardLedgerRow(row: IntelRewardLedgerRowLike): CanonicalShareRow[] {
  const shared = {
    sourceLedger: "intel_reward_ledger" as const,
    sourceEntryId: str(row.id),
    // Single-sided by construction (2170): every row credits actor_id.
    partyRole: "creator" as const,
    creatorId: nullableStr(row.actor_id),
    entryReason: str(row.source),
    ruleVersion: str(row.ledger_version),
    attributionKind: "contribution",
    // NULL, not a stand-in. This ledger records no attribution id; saying so is
    // `09` §5.3 I7, and reusing the entry's own id as its cause would not be.
    attributionId: null,
    reversesSourceEntryId: nullableStr(row.reverses_entry_id),
    cashRecorded: num(row.cash_amount),
    occurredAt: str(row.created_at),
  };
  return [
    { ...shared, unitKind: "qiu", unitCode: "QIU", amount: num(row.qiu) },
    { ...shared, unitKind: "credit", unitCode: "CREDIT", amount: num(row.earned_units) },
  ];
}

/** `public.rent_buddy_earnings_entries`, as PostgREST returns it. */
export interface RentBuddyEarningsEntryRowLike {
  id: string;
  account: string;
  entry_reason?: string | null;
  amount_minor?: number | string | null;
  currency?: string | null;
  cash_settled_minor?: number | string | null;
  rule_version?: string | null;
  attribution_kind?: string | null;
  attribution_id?: string | null;
  beneficiary_user_id?: string | null;
  reverses_entry_id?: string | null;
  occurred_at?: string | null;
}

export function projectEarningsEntryRow(row: RentBuddyEarningsEntryRowLike): CanonicalShareRow[] {
  const role = ACCOUNT_PARTY_ROLE[str(row.account)];
  if (role === undefined) {
    // Unreachable while 2901's rbee_account_check stands. Refusing loudly is
    // the point: a new account nobody mapped must not silently become a
    // creator's money or silently vanish from the fold.
    throw new Error(
      `creatorShareCanonical: rent_buddy_earnings_entries.account=${JSON.stringify(row.account)} ` +
      "has no party role. Map it in ACCOUNT_PARTY_ROLE and in migration 2930's CASE, in the same change.",
    );
  }
  return [{
    sourceLedger: "rent_buddy_earnings_entries",
    sourceEntryId: str(row.id),
    unitKind: "currency",
    unitCode: str(row.currency).trim(),
    amount: num(row.amount_minor),
    partyRole: role,
    creatorId: nullableStr(row.beneficiary_user_id),
    entryReason: str(row.entry_reason),
    ruleVersion: str(row.rule_version),
    attributionKind: str(row.attribution_kind),
    attributionId: nullableStr(row.attribution_id),
    reversesSourceEntryId: nullableStr(row.reverses_entry_id),
    cashRecorded: num(row.cash_settled_minor),
    occurredAt: str(row.occurred_at),
  }];
}

/** A row of the view itself, as PostgREST returns it. */
export interface CreatorShareLedgerViewRow {
  source_ledger: string;
  source_entry_id: string;
  unit_kind: string;
  unit_code: string;
  amount?: number | string | null;
  party_role: string;
  creator_id?: string | null;
  entry_reason?: string | null;
  rule_version?: string | null;
  attribution_kind?: string | null;
  attribution_id?: string | null;
  reverses_source_entry_id?: string | null;
  cash_recorded?: number | string | null;
  occurred_at?: string | null;
}

export function fromViewRow(row: CreatorShareLedgerViewRow): CanonicalShareRow {
  const ledger = str(row.source_ledger);
  if (ledger !== "intel_reward_ledger" && ledger !== "rent_buddy_earnings_entries") {
    throw new Error(`creatorShareCanonical: unknown source_ledger ${JSON.stringify(ledger)}`);
  }
  const unitKind = str(row.unit_kind);
  if (!(UNIT_KINDS as readonly string[]).includes(unitKind)) {
    // An amount whose unit nobody recognises cannot be added to anything.
    throw new Error(`creatorShareCanonical: unknown unit_kind ${JSON.stringify(unitKind)}`);
  }
  const role = str(row.party_role);
  if (!["creator", "platform", "traveler", "external"].includes(role)) {
    throw new Error(`creatorShareCanonical: unknown party_role ${JSON.stringify(role)}`);
  }
  return {
    sourceLedger: ledger,
    sourceEntryId: str(row.source_entry_id),
    unitKind: unitKind as UnitKind,
    unitCode: str(row.unit_code).trim(),
    amount: num(row.amount),
    partyRole: role as PartyRole,
    creatorId: nullableStr(row.creator_id),
    entryReason: str(row.entry_reason),
    ruleVersion: str(row.rule_version),
    attributionKind: str(row.attribution_kind),
    attributionId: nullableStr(row.attribution_id),
    reversesSourceEntryId: nullableStr(row.reverses_source_entry_id),
    cashRecorded: num(row.cash_recorded),
    occurredAt: str(row.occurred_at),
  };
}

// ── Exact, order-independent accumulation ───────────────────────────────────

const scaleOf = (unitKind: UnitKind): number => UNIT_ACCUMULATION_SCALE[unitKind];

/** Integer addition is exactly commutative; floating addition is not. */
function sumScaled(unitKind: UnitKind, amounts: Iterable<number>): number {
  const scale = scaleOf(unitKind);
  let acc = 0;
  for (const a of amounts) acc += Math.round(a * scale);
  return acc;
}

const unscale = (unitKind: UnitKind, scaled: number): number => scaled / scaleOf(unitKind);

// ── Per-unit totals, for reconciliation ─────────────────────────────────────

export interface UnitTotal {
  sourceLedger: SourceLedger;
  unitKind: UnitKind;
  unitCode: string;
  rows: number;
  amount: number;
}

const unitKeyOf = (r: CanonicalShareRow) => `${r.sourceLedger}|${r.unitKind}|${r.unitCode}`;

/**
 * Totals, grouped so that no two units can meet. Sorted, so the result of a
 * reconciliation never depends on the order the ledger was read in.
 */
export function unitTotals(rows: readonly CanonicalShareRow[]): UnitTotal[] {
  const groups = new Map<string, CanonicalShareRow[]>();
  for (const r of rows) {
    const k = unitKeyOf(r);
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  return [...groups.entries()]
    .map(([, g]) => {
      const head = g[0]!;
      return {
        sourceLedger: head.sourceLedger,
        unitKind: head.unitKind,
        unitCode: head.unitCode,
        rows: g.length,
        amount: unscale(head.unitKind, sumScaled(head.unitKind, g.map((r) => r.amount))),
      };
    })
    .sort((a, b) =>
      a.sourceLedger.localeCompare(b.sourceLedger) ||
      a.unitKind.localeCompare(b.unitKind) ||
      a.unitCode.localeCompare(b.unitCode));
}

// ── The share ───────────────────────────────────────────────────────────────

export type ShareBasis =
  /** The source ledger records both legs; a ratio is derivable from it. */
  | "double_entry"
  /** The source ledger records only the creator's leg. There is no denominator. */
  | "creator_side_only"
  /** One attribution names several creators; splitting it would invent weights. */
  | "ambiguous_attribution";

export interface CreatorShare {
  creatorId: string;
  sourceLedger: SourceLedger;
  unitKind: UnitKind;
  unitCode: string;
  /** THE SHARE — `08` §5's "creator/host share", as an amount in this unit. */
  creatorAmount: number;
  /** The platform's paired take, or null when the ledger records none. */
  platformAmount: number | null;
  /**
   * `creatorAmount + platformAmount`: what the transactions crediting this
   * creator divided between the two parties. NOT `08` §5's "gross booking
   * value" — that additionally includes taxes and reserves this ledger does
   * not record, and calling it gross would overstate what is known.
   */
  sharedBaseAmount: number | null;
  /** creator ÷ base, in parts per million. Null unless genuinely derivable. */
  sharePpm: number | null;
  basis: ShareBasis;
}

/**
 * The creator share, per creator, per source ledger, PER UNIT.
 *
 * One row per `(creatorId, sourceLedger, unitKind, unitCode)` — never one
 * number per creator, because collapsing the units would require a rate that
 * does not exist. The output is sorted, and every total is accumulated in
 * scaled integers, so the answer is a function of the entries alone and not of
 * the order they arrived in.
 */
export function creatorShares(rows: readonly CanonicalShareRow[]): CreatorShare[] {
  // Which creators does each attribution name? Built per source ledger, from
  // the creator legs only — this is what detects the multi-party case `07` §7
  // has not decided yet.
  const creatorsByAttribution = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.partyRole !== "creator" || r.creatorId === null || r.attributionId === null) continue;
    const k = `${r.sourceLedger}|${r.attributionId}`;
    const s = creatorsByAttribution.get(k) ?? new Set<string>();
    s.add(r.creatorId);
    creatorsByAttribution.set(k, s);
  }

  // Platform legs, indexed so a creator's paired take is a lookup rather than
  // a scan per creator.
  const platformByKey = new Map<string, number[]>();
  for (const r of rows) {
    if (r.partyRole !== "platform" || r.attributionId === null) continue;
    const k = `${r.sourceLedger}|${r.attributionId}|${r.unitKind}|${r.unitCode}`;
    const g = platformByKey.get(k);
    if (g) g.push(r.amount); else platformByKey.set(k, [r.amount]);
  }

  interface Bucket {
    creatorId: string; sourceLedger: SourceLedger; unitKind: UnitKind; unitCode: string;
    amounts: number[]; attributions: Set<string>; sawNullAttribution: boolean;
  }
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    if (r.partyRole !== "creator" || r.creatorId === null) continue;
    const k = `${r.sourceLedger}|${r.creatorId}|${r.unitKind}|${r.unitCode}`;
    let b = buckets.get(k);
    if (!b) {
      b = {
        creatorId: r.creatorId, sourceLedger: r.sourceLedger,
        unitKind: r.unitKind, unitCode: r.unitCode,
        amounts: [], attributions: new Set<string>(), sawNullAttribution: false,
      };
      buckets.set(k, b);
    }
    b.amounts.push(r.amount);
    if (r.attributionId === null) b.sawNullAttribution = true;
    else b.attributions.add(r.attributionId);
  }

  const out: CreatorShare[] = [];
  for (const b of buckets.values()) {
    const scale = scaleOf(b.unitKind);
    const creatorScaled = sumScaled(b.unitKind, b.amounts);
    const creatorAmount = creatorScaled / scale;

    const noDenominator = (basis: ShareBasis): CreatorShare => ({
      creatorId: b.creatorId,
      sourceLedger: b.sourceLedger,
      unitKind: b.unitKind,
      unitCode: b.unitCode,
      creatorAmount,
      platformAmount: null,
      sharedBaseAmount: null,
      sharePpm: null,
      basis,
    });

    if (!SOURCE_RECORDS_PLATFORM_SIDE[b.sourceLedger]) {
      out.push(noDenominator("creator_side_only"));
      continue;
    }
    if (b.sawNullAttribution) {
      // A creator leg with no cause cannot be paired with anything.
      out.push(noDenominator("ambiguous_attribution"));
      continue;
    }
    const multiParty = [...b.attributions].some((a) =>
      (creatorsByAttribution.get(`${b.sourceLedger}|${a}`)?.size ?? 0) > 1);
    if (multiParty) {
      out.push(noDenominator("ambiguous_attribution"));
      continue;
    }

    const platformAmounts: number[] = [];
    for (const a of b.attributions) {
      const g = platformByKey.get(`${b.sourceLedger}|${a}|${b.unitKind}|${b.unitCode}`);
      if (g) platformAmounts.push(...g);
    }
    const platformScaled = sumScaled(b.unitKind, platformAmounts);
    const baseScaled = creatorScaled + platformScaled;

    out.push({
      creatorId: b.creatorId,
      sourceLedger: b.sourceLedger,
      unitKind: b.unitKind,
      unitCode: b.unitCode,
      creatorAmount,
      platformAmount: platformScaled / scale,
      sharedBaseAmount: baseScaled / scale,
      // A base of zero (everything reversed) or a negative one has no ratio.
      // 0/0 is not 100% and is not 0%; `09` §5.3 I7 again.
      sharePpm: baseScaled > 0 ? Math.round((creatorScaled * 1_000_000) / baseScaled) : null,
      basis: "double_entry",
    });
  }

  return out.sort((a, b) =>
    a.sourceLedger.localeCompare(b.sourceLedger) ||
    a.creatorId.localeCompare(b.creatorId) ||
    a.unitKind.localeCompare(b.unitKind) ||
    a.unitCode.localeCompare(b.unitCode));
}

// ── Reconciliation ──────────────────────────────────────────────────────────

export interface ReconciliationDifference {
  kind: "missing_entry" | "extra_entry" | "amount" | "unit_total" | "share";
  key: string;
  left: string | null;
  right: string | null;
}

export interface Reconciliation {
  ok: boolean;
  differences: ReconciliationDifference[];
  /** How much was actually compared. A reconciliation over nothing is not a pass. */
  compared: { entries: number; unitTotals: number; shares: number };
}

const entryKeyOf = (r: CanonicalShareRow) =>
  `${r.sourceLedger}|${r.sourceEntryId}|${r.unitKind}`;

/**
 * Does the canonical answer equal the per-ledger answer? Compared BOTH WAYS and
 * at three resolutions — every entry, every per-unit total, every creator's
 * share — because each catches something the others do not. A single lost row
 * shows up in the first; a unit RELABELLING that preserves every count and the
 * grand total shows up only in the second; a mis-paired platform leg only in
 * the third.
 *
 * `left` and `right` are symmetric: `reconcile(a, b).ok === reconcile(b, a).ok`.
 */
export function reconcile(
  left: readonly CanonicalShareRow[],
  right: readonly CanonicalShareRow[],
): Reconciliation {
  const differences: ReconciliationDifference[] = [];

  const index = (rows: readonly CanonicalShareRow[]) => {
    const m = new Map<string, CanonicalShareRow>();
    for (const r of rows) m.set(entryKeyOf(r), r);
    return m;
  };
  const l = index(left);
  const r = index(right);

  for (const [k, row] of l) {
    const other = r.get(k);
    if (!other) {
      differences.push({ kind: "extra_entry", key: k, left: String(row.amount), right: null });
      continue;
    }
    if (Math.round(row.amount * scaleOf(row.unitKind)) !==
        Math.round(other.amount * scaleOf(other.unitKind)) ||
        row.unitCode !== other.unitCode ||
        row.partyRole !== other.partyRole) {
      differences.push({
        kind: "amount", key: k,
        left: `${row.amount} ${row.unitCode} ${row.partyRole}`,
        right: `${other.amount} ${other.unitCode} ${other.partyRole}`,
      });
    }
  }
  for (const [k, row] of r) {
    if (!l.has(k)) {
      differences.push({ kind: "missing_entry", key: k, left: null, right: String(row.amount) });
    }
  }

  const totalsOf = (rows: readonly CanonicalShareRow[]) =>
    new Map(unitTotals(rows).map((t) =>
      [`${t.sourceLedger}|${t.unitKind}|${t.unitCode}`, `${t.rows}@${t.amount}`]));
  const lt = totalsOf(left);
  const rt = totalsOf(right);
  for (const k of new Set([...lt.keys(), ...rt.keys()])) {
    const a = lt.get(k) ?? null;
    const b = rt.get(k) ?? null;
    if (a !== b) differences.push({ kind: "unit_total", key: k, left: a, right: b });
  }

  const sharesOf = (rows: readonly CanonicalShareRow[]) =>
    new Map(creatorShares(rows).map((s) =>
      [`${s.sourceLedger}|${s.creatorId}|${s.unitKind}|${s.unitCode}`,
       `${s.creatorAmount}/${s.platformAmount}/${s.sharePpm}/${s.basis}`]));
  const ls = sharesOf(left);
  const rs = sharesOf(right);
  for (const k of new Set([...ls.keys(), ...rs.keys()])) {
    const a = ls.get(k) ?? null;
    const b = rs.get(k) ?? null;
    if (a !== b) differences.push({ kind: "share", key: k, left: a, right: b });
  }

  differences.sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
  return {
    ok: differences.length === 0,
    differences,
    compared: {
      entries: new Set([...l.keys(), ...r.keys()]).size,
      unitTotals: new Set([...lt.keys(), ...rt.keys()]).size,
      shares: new Set([...ls.keys(), ...rs.keys()]).size,
    },
  };
}
