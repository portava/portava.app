/**
 * CreatorLedgerReader — a creator's OWN ledger, computed on the server.
 *
 * census-discovery DC-23: `11` §6 "Creator economy API — Read: impact
 * summaries, attributed conversions, provisional earnings, payout eligibility
 * … No client-side earning calculation." Three of the four reads are here; the
 * fourth, payout eligibility, is `07` §4's progression and eligibility inputs,
 * which are the owner's rule and are NOT invented (census §52).
 *
 * ── ONE CREATOR, AND ONLY THE CALLER ────────────────────────────────────────
 * Every read takes the creator id from the caller's session (the route passes
 * `requireUser`'s user id and accepts no id parameter), and every query is
 * filtered on it. There is no path by which one creator reads another's rows.
 *
 * ── COMPUTED FROM THE SAME LEDGER, NEVER FROM A STORED TOTAL ────────────────
 * Earnings are folded from `public.creator_share_ledger` — the one relation
 * the share is computed from (2930 + 3385) — per (source ledger, unit), and
 * every figure is sent to the client finished. The client is given numbers to
 * render, not rows to add up (`11` §6).
 *
 * A PARTIAL FOLD IS REFUSED, NOT RETURNED. Every relation is paged to
 * exhaustion, and the caller's `creator_earning_entries` legs are read BOTH
 * directly and through the view: if the view is missing any of them (3385 not
 * applied), the read refuses `degraded_unavailable` rather than reporting a
 * smaller balance that looks like a real one.
 *
 * FAIL-CLOSED on `creator_attribution_enabled` (2922, seeded FALSE): off means
 * `disabled`, never an empty ledger that reads as "you earned nothing".
 */
import {
  CREATOR_SHARE_LEDGER,
  fromViewRow,
  type CanonicalShareRow,
  type CreatorShareLedgerViewRow,
} from "../../lib/creatorShareCanonical.js";
import {
  attributedConversions,
  impactSummary,
  summarizeCreatorEarnings,
  type AttributedConversion,
  type AttributionRow,
  type EarningsSummary,
  type ImpactSummary,
  type StatusedCanonicalRow,
} from "../../lib/creatorLedgerStatus.js";
import {
  creatorLedgerEnabled,
  classifyDbError,
  fail,
  type CreatorServiceResult,
} from "./CreatorAttributionService.js";

export const READ_PAGE_SIZE = 500;

async function readAllFor<T>(
  sc: any,
  relation: string,
  column: string,
  value: string,
  orderBy: readonly string[],
  pageSize: number,
): Promise<CreatorServiceResult<T[]>> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    // Ordered by a UNIQUE key, or a row can be skipped or read twice across a
    // page boundary. On the view that key is (source_entry_id, unit_kind): an
    // intel_reward_ledger row projects twice under one source_entry_id.
    let q = sc.from(relation).select("*").eq(column, value);
    for (const o of orderBy) q = q.order(o, { ascending: true });
    const { data, error } = await q.range(from, from + pageSize - 1);
    if (error) return classifyDbError(error);
    const page: T[] = Array.isArray(data) ? data : [];
    out.push(...page);
    if (page.length < pageSize) return { ok: true, value: out };
    if (out.length > 1_000_000) return fail("db_error", `${relation}: paging exceeded 1,000,000 rows for one creator`);
  }
}

export interface CreatorLedgerView {
  creatorId: string;
  impact: ImpactSummary;
  conversions: AttributedConversion[];
  earnings: EarningsSummary;
  entries: StatusedCanonicalRow[];
}

/** Everything `11` §6's three buildable reads need, for ONE creator, in one consistent pass. */
export async function readMyCreatorLedger(
  sc: any,
  creatorId: string,
  opts: { pageSize?: number } = {},
): Promise<CreatorServiceResult<CreatorLedgerView>> {
  if (!(await creatorLedgerEnabled(sc))) return fail("disabled");
  if (typeof creatorId !== "string" || creatorId.length === 0) return fail("not_found", "no creator");
  const page = opts.pageSize ?? READ_PAGE_SIZE;

  const attrs = await readAllFor<AttributionRow>(sc, "creator_attributions", "beneficiary_user_id", creatorId, ["id"], page);
  if (!attrs.ok) return attrs;

  const view = await readAllFor<CreatorShareLedgerViewRow>(sc, CREATOR_SHARE_LEDGER, "creator_id", creatorId, ["source_ledger", "source_entry_id", "unit_kind"], page);
  if (!view.ok) return view;
  let rows: CanonicalShareRow[];
  try {
    rows = view.value.map(fromViewRow);
  } catch (e) {
    return fail("db_error", String((e as Error)?.message ?? e));
  }

  // The completeness check: every one of this creator's creator_earning_entries
  // legs must reach the view. A view that predates 3385 projects none of them.
  const direct = await readAllFor<{ id: string }>(sc, "creator_earning_entries", "beneficiary_user_id", creatorId, ["id"], page);
  if (!direct.ok) return direct;
  const projected = new Set(rows.filter((r) => r.sourceLedger === "creator_earning_entries").map((r) => r.sourceEntryId));
  const missing = direct.value.filter((d) => !projected.has(String(d.id)));
  if (missing.length > 0) {
    return fail(
      "degraded_unavailable",
      `${missing.length} creator_earning_entries row(s) of this creator are absent from ${CREATOR_SHARE_LEDGER} ` +
        "(migration 3385 not applied here); a fold without them would under-state the creator's earnings",
    );
  }

  const { summary, entries } = summarizeCreatorEarnings(creatorId, rows, attrs.value);
  return {
    ok: true,
    value: {
      creatorId,
      impact: impactSummary(attrs.value),
      conversions: attributedConversions(attrs.value),
      earnings: summary,
      entries,
    },
  };
}
