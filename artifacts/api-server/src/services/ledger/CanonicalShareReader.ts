/**
 * CanonicalShareReader — reads `public.creator_share_ledger` (migration 2930)
 * and folds it into the creator share. The executable half of `08` §7's
 * *"creator share can be computed from the same ledger."*
 *
 * ── WHY THIS IS A READER AND NOTHING ELSE ───────────────────────────────────
 * It has no INSERT, no UPDATE, no DELETE and no payment path, and it cannot
 * acquire one: the canonical relation is a UNION ALL view, which PostgreSQL
 * does not make auto-updatable, so there is no write path to grant. The two
 * base ledgers keep the append-only posture 2170/2900/2901 gave them —
 * service_role has no UPDATE on either — and nothing here asks for one.
 *
 * ── NO FLAG GATE, DELIBERATELY ──────────────────────────────────────────────
 * `services/ledger/RewardReversal.ts` is gated on `intel_rewards` because it
 * WRITES. This reads. Gating a balance read fail-closed would return a share of
 * ZERO for a creator who has earned something — a wrong number that looks like
 * a right one, which is worse than an error. Both underlying ledgers are
 * already flag-gated at their write paths (`intel_rewards` OFF at 2170,
 * `rent_buddy_enabled` FALSE at 2210), so with the flags off this reads an
 * empty ledger and says so.
 *
 * ── REFUSES RATHER THAN RETURNING A PARTIAL FOLD ────────────────────────────
 * A balance computed from SOME of the entries is not a smaller balance, it is a
 * wrong one. Every read here pages to exhaustion and any error at any page
 * fails the whole call. `09` §5.3 I7 — absence is not permitted to be silent.
 *
 * ── NO FABRICATED CONVERSION ────────────────────────────────────────────────
 * The share comes back as one row per `(creator, source ledger, unit)`. qiu,
 * non-cash credits and currency minor units are not commensurable and no rate
 * between them exists; see `lib/creatorShareCanonical.ts`, which owns that
 * argument and the fold.
 *
 * RUNTIME EFFECT: NONE today. No route calls it; it is the read DV-64 names,
 * and the reconciliation it performs is the one the portava-ci rehearsal runs
 * in SQL.
 */
import {
  CREATOR_SHARE_LEDGER,
  type CanonicalShareRow,
  type CreatorShare,
  type CreatorShareLedgerViewRow,
  type IntelRewardLedgerRowLike,
  type Reconciliation,
  type RentBuddyEarningsEntryRowLike,
  creatorShares,
  fromViewRow,
  projectEarningsEntryRow,
  projectRewardLedgerRow,
  reconcile,
} from "../../lib/creatorShareCanonical.js";

const REWARD_LEDGER = "intel_reward_ledger";
const EARNINGS_ENTRIES = "rent_buddy_earnings_entries";

/** PostgREST's own ceiling is 1000; this stays under it and is overridable. */
export const DEFAULT_PAGE_SIZE = 500;

export type ReadFailure = { ok: false; reason: "db_error"; detail: string };

export type ReadResult<T> = { ok: true; value: T } | ReadFailure;

const fail = (detail: unknown): ReadFailure => ({
  ok: false, reason: "db_error", detail: String((detail as any)?.message ?? detail),
});

/**
 * Page a relation to exhaustion. Ordered by a stable key so a row cannot be
 * skipped or seen twice across page boundaries — an unordered paged read of a
 * ledger silently drops entries, which is exactly the class of defect this
 * criterion exists to catch.
 */
async function readAll<T>(
  sc: any,
  relation: string,
  columns: string,
  orderBy: string,
  pageSize: number,
  narrow?: (q: any) => any,
): Promise<ReadResult<T[]>> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    let q = sc.from(relation).select(columns).order(orderBy, { ascending: true });
    if (narrow) q = narrow(q);
    const { data, error } = await q.range(from, from + pageSize - 1);
    if (error) return fail(error);
    const page: T[] = Array.isArray(data) ? data : [];
    out.push(...page);
    if (page.length < pageSize) return { ok: true, value: out };
    // A relation that keeps returning full pages forever would loop; PostgREST
    // returns a short page at the end, and an empty one past it.
    if (out.length > 5_000_000) return fail("creator_share_ledger paging exceeded 5,000,000 rows");
  }
}

const VIEW_COLUMNS =
  "source_ledger,source_entry_id,unit_kind,unit_code,amount,party_role,creator_id," +
  "entry_reason,rule_version,attribution_kind,attribution_id,reverses_source_entry_id," +
  "cash_recorded,occurred_at";

/**
 * Every row of the canonical ledger.
 *
 * DELIBERATELY UNFILTERED. A creator-scoped filter on `creator_id` would drop
 * the `platform_revenue` legs, which carry no creator — and those are the
 * denominator of the ratio. A read that quietly loses the denominator reports a
 * 100% share, which is the fabrication this whole unit is about. If a workload
 * ever needs a narrower read, it must fetch the creator's legs AND the platform
 * legs of their attributions, in that order, and not a `creator_id` filter.
 */
export async function readCanonicalShareRows(
  sc: any,
  opts: { pageSize?: number } = {},
): Promise<ReadResult<CanonicalShareRow[]>> {
  const page = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const r = await readAll<CreatorShareLedgerViewRow>(
    sc, CREATOR_SHARE_LEDGER, VIEW_COLUMNS, "source_entry_id", page,
  );
  if (!r.ok) return r;
  try {
    return { ok: true, value: r.value.map(fromViewRow) };
  } catch (e) {
    // An unrecognised unit or role. Refusing is the point: an amount nobody can
    // name the unit of must never be added to anything.
    return fail(e);
  }
}

/**
 * The same rows, computed WITHOUT the view — each base ledger read on its own
 * and projected in TypeScript.
 *
 * This is what makes the reconciliation mean something. A canonical relation
 * checked only against itself proves the SELECT list is internally consistent
 * and nothing else; this is the independent second computation `08` §7's
 * "attribution is auditable" needs in order to be auditable BY SOMETHING.
 */
export async function readPerLedgerShareRows(
  sc: any,
  opts: { pageSize?: number } = {},
): Promise<ReadResult<CanonicalShareRow[]>> {
  const page = opts.pageSize ?? DEFAULT_PAGE_SIZE;

  const rewards = await readAll<IntelRewardLedgerRowLike>(
    sc, REWARD_LEDGER,
    "id,actor_id,source,qiu,earned_units,cash_amount,ledger_version,reverses_entry_id,created_at",
    "id", page,
  );
  if (!rewards.ok) return rewards;

  const entries = await readAll<RentBuddyEarningsEntryRowLike>(
    sc, EARNINGS_ENTRIES,
    "id,account,entry_reason,amount_minor,currency,cash_settled_minor,rule_version," +
    "attribution_kind,attribution_id,beneficiary_user_id,reverses_entry_id,occurred_at",
    "id", page,
  );
  if (!entries.ok) return entries;

  try {
    return {
      ok: true,
      value: [
        ...rewards.value.flatMap(projectRewardLedgerRow),
        ...entries.value.flatMap(projectEarningsEntryRow),
      ],
    };
  } catch (e) {
    return fail(e);
  }
}

/**
 * THE ANSWER DV-64 ASKS FOR: the creator share, computed from the one canonical
 * ledger. One row per `(creator, source ledger, unit)`; never one number per
 * creator, because collapsing the units would need a rate that does not exist.
 */
export async function computeCreatorShares(
  sc: any,
  opts: { pageSize?: number } = {},
): Promise<ReadResult<CreatorShare[]>> {
  const rows = await readCanonicalShareRows(sc, opts);
  if (!rows.ok) return rows;
  return { ok: true, value: creatorShares(rows.value) };
}

export interface CanonicalReconciliation {
  /** Canonical read against the independent per-ledger read. */
  canonicalVsPerLedger: Reconciliation;
  /** The same comparison with the arguments swapped. Both must be clean. */
  perLedgerVsCanonical: Reconciliation;
  ok: boolean;
}

/**
 * Does the canonical ledger say what the two source ledgers say — and do the
 * two source ledgers say what the canonical ledger says?
 *
 * BOTH DIRECTIONS ARE RUN AND BOTH MUST BE CLEAN. They are not the same
 * question: one direction catches an entry the view invented, the other catches
 * an entry the view dropped, and a comparison run one way round can be clean
 * while the other is not.
 */
export async function reconcileCanonicalAgainstSources(
  sc: any,
  opts: { pageSize?: number } = {},
): Promise<ReadResult<CanonicalReconciliation>> {
  const canonical = await readCanonicalShareRows(sc, opts);
  if (!canonical.ok) return canonical;
  const perLedger = await readPerLedgerShareRows(sc, opts);
  if (!perLedger.ok) return perLedger;

  const a = reconcile(canonical.value, perLedger.value);
  const b = reconcile(perLedger.value, canonical.value);
  return { ok: true, value: { canonicalVsPerLedger: a, perLedgerVsCanonical: b, ok: a.ok && b.ok } };
}
