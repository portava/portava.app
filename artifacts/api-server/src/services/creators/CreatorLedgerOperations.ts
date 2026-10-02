/**
 * CreatorLedgerOperations — the AUDITED operations on a creator's ledger: place
 * a fraud hold, lift it, recompute an earning under a newer rule version,
 * reverse a transaction, and read the whole trail back.
 *
 * census-discovery DV-59 (`07` §10 "fraud holds exist"), DV-60 ("historical
 * recalculation is possible"), DV-68 (`09` §11 "reversals are possible"),
 * DV-63 (`08` §7 "attribution is auditable"), DV-74 (`11` §8 "creator fraud
 * holds", "ledger audit"; `11` §10 "admin actions are audited").
 *
 * ── ONE OPERATION, ONE TRANSACTION ─────────────────────────────────────────
 * Each operation reads, plans ONE payload with `lib/creatorLedgerPlans.ts`, and
 * sends it through `public.creator_ledger_append` (3387) — which appends the
 * superseding attribution, every entry, and the audit row in one transaction,
 * or nothing. There is no multi-request path here, so no failure between two
 * writes can leave a half-ledger; the harness suite proves it by failing the
 * last row of a payload and finding none of the others.
 *
 * ── WHAT THE DATABASE STILL DECIDES ─────────────────────────────────────────
 * The plan is checked here for the cases worth a clear refusal, and 3387's
 * triggers decide again for every writer: an attribution superseded by a
 * concurrent operation (`stale_head`), a hold that would not change the hold
 * state, a recomputation of a held row, a version that is not published, an
 * unbalanced transaction, a reversal that is not an exact negation.
 *
 * FAIL-CLOSED on `creator_attribution_enabled` (2922, seeded FALSE): with it off
 * every operation refuses `disabled` and reads nothing.
 */
import { isCreatorType } from "../../lib/creatorTypes.js";
import { evaluateCreatorRule } from "../../lib/creatorRuleEvaluation.js";
import { indexChains, type AttributionRow, type EarningEntryRow } from "../../lib/creatorLedgerStatus.js";
import {
  planHold,
  planRecompute,
  planRelease,
  planReversal,
  resolveHead,
  type LedgerActor,
} from "../../lib/creatorLedgerPlans.js";
import {
  creatorLedgerEnabled,
  appendToLedger,
  classifyDbError,
  fail,
  readAttributionChain,
  readEntriesFor,
  resolveActiveRuleVersion,
  type CreatorServiceResult,
  type LedgerAppendResult,
} from "./CreatorAttributionService.js";

export interface LedgerOperationResult {
  /** The row acted on (the chain's head at the time). */
  subjectAttributionId: string;
  /** The superseding row this operation appended, if any. */
  resultingAttributionId: string | null;
  append: LedgerAppendResult;
}

async function headFor(sc: any, attributionId: string):
  Promise<CreatorServiceResult<{ chain: AttributionRow[]; head: AttributionRow }>> {
  const chain = await readAttributionChain(sc, attributionId);
  if (!chain.ok) return chain;
  const head = resolveHead(chain.value, attributionId);
  if (!head.ok) return fail(head.reason, head.detail);
  return { ok: true, value: { chain: chain.value, head: head.head } };
}

function done(subjectId: string, r: { ok: true; value: LedgerAppendResult; replayed?: true }, supersedes: boolean):
  CreatorServiceResult<LedgerOperationResult> {
  return {
    ok: true,
    value: {
      subjectAttributionId: subjectId,
      resultingAttributionId: supersedes ? r.value.attribution_id : null,
      append: r.value,
    },
    ...(r.replayed ? { replayed: true as const } : {}),
  };
}

/** `07` §9/§10 — hold the CURRENT state of `attributionId`'s chain, with a stated reason. */
export async function placeCreatorHold(
  sc: any,
  input: { attributionId: string; reason: unknown; actor: LedgerActor },
): Promise<CreatorServiceResult<LedgerOperationResult>> {
  if (!(await creatorLedgerEnabled(sc))) return fail("disabled");
  const h = await headFor(sc, input.attributionId);
  if (!h.ok) return h;
  const plan = planHold(h.value.head, input.reason, input.actor);
  if (!plan.ok) return fail(plan.reason, plan.detail);
  const r = await appendToLedger(sc, plan.payload);
  if (!r.ok) return r;
  return done(plan.subjectId, r, true);
}

/**
 * Lift a hold. WHY it was lifted is recorded in the audit row, in the same
 * transaction as the release: 2920's `ca_hold_is_explained` gives the released
 * row no reason column to carry it.
 */
export async function releaseCreatorHold(
  sc: any,
  input: { attributionId: string; reason: unknown; actor: LedgerActor },
): Promise<CreatorServiceResult<LedgerOperationResult>> {
  if (!(await creatorLedgerEnabled(sc))) return fail("disabled");
  const h = await headFor(sc, input.attributionId);
  if (!h.ok) return h;
  const plan = planRelease(h.value.head, input.reason, input.actor);
  if (!plan.ok) return fail(plan.reason, plan.detail);
  const r = await appendToLedger(sc, plan.payload);
  if (!r.ok) return r;
  return done(plan.subjectId, r, true);
}

/**
 * `07` §10 — recompute `attributionId`'s earning under the version NOW in force
 * for its type. The old entries are reversed (never edited), the new ones are
 * booked from the new version's PUBLISHED params over the attribution's
 * recorded gross, and the old version's answer stays readable
 * (`historicalCreatorBalanceAt`).
 */
export async function recomputeCreatorAttribution(
  sc: any,
  input: { attributionId: string; reason: unknown; actor: LedgerActor },
): Promise<CreatorServiceResult<LedgerOperationResult>> {
  if (!(await creatorLedgerEnabled(sc))) return fail("disabled");
  const h = await headFor(sc, input.attributionId);
  if (!h.ok) return h;
  const { chain, head } = h.value;
  if (!isCreatorType(head.creator_type)) return fail("unknown_creator_type", String(head.creator_type));
  const active = await resolveActiveRuleVersion(sc, head.creator_type);
  if (!active.ok) return active;
  const figures = evaluateCreatorRule(active.value.params, {
    grossRevenueMinor: Number(head.gross_revenue_minor),
    weight: Number(head.weight),
    currency: String(head.currency).trim(),
  });
  if (!figures.ok) return fail(figures.reason, figures.detail);
  const entries = await readEntriesFor(sc, chain.map((r) => String(r.id)));
  if (!entries.ok) return entries;
  // The revenue source of the earning being recomputed carries forward.
  const src = entries.value.find((e) => e.entry_reason !== "reversal" && e.revenue_source)?.revenue_source ?? null;
  const plan = planRecompute(
    chain, entries.value, head,
    { ruleVersion: active.value.ruleVersion, figures: { ...figures.value, revenueSource: src as any } },
    input.reason, input.actor,
  );
  if (!plan.ok) return fail(plan.reason, plan.detail);
  const r = await appendToLedger(sc, plan.payload);
  if (!r.ok) return r;
  return done(plan.subjectId, r, true);
}

/** `09` §6 — reverse one transaction with exact negations, audited. */
export async function reverseCreatorTransaction(
  sc: any,
  input: { transactionKey: string; reason: unknown; actor: LedgerActor },
): Promise<CreatorServiceResult<LedgerOperationResult>> {
  if (!(await creatorLedgerEnabled(sc))) return fail("disabled");
  const { data, error } = await sc
    .from("creator_earning_entries").select().eq("transaction_key", input.transactionKey).limit(1000);
  if (error) return classifyDbError(error);
  const originals = (Array.isArray(data) ? data : []) as EarningEntryRow[];
  if (originals.length === 0) return fail("unknown_transaction", input.transactionKey);
  // Every entry of the attribution, so an existing reversal of this transaction is seen.
  const all = await readEntriesFor(sc, [String(originals[0]!.attribution_id)]);
  if (!all.ok) return all;
  const plan = planReversal(all.value, input.transactionKey, input.reason, input.actor);
  if (!plan.ok) return fail(plan.reason, plan.detail);
  const r = await appendToLedger(sc, plan.payload);
  if (!r.ok) return r;
  return done(plan.subjectId, r, false);
}

// ── `11` §8 "ledger audit" — the whole trail of one attribution ─────────────

export interface CreatorLedgerAuditTrail {
  /** Oldest → newest; the last row is the current state. */
  chain: AttributionRow[];
  headId: string;
  /** Every entry booked against any row of the chain, reversals included. */
  entries: EarningEntryRow[];
  /** Every audited operation on any row of the chain, oldest first. */
  audit: Array<Record<string, unknown>>;
  /** The chain's entries reconcile: each transaction sums to zero per currency. */
  unbalancedTransactions: string[];
}

/**
 * Reconstruct one attribution completely (`09` §11 "every earning can be
 * reconstructed"): its chain, every entry against it, and every audited act.
 * No stored total is read — there is none.
 */
export async function readCreatorLedgerAuditTrail(
  sc: any,
  attributionId: string,
): Promise<CreatorServiceResult<CreatorLedgerAuditTrail>> {
  if (!(await creatorLedgerEnabled(sc))) return fail("disabled");
  const chain = await readAttributionChain(sc, attributionId);
  if (!chain.ok) return chain;
  const ids = chain.value.map((r) => String(r.id));
  const entries = await readEntriesFor(sc, ids);
  if (!entries.ok) return entries;
  const { data, error } = await sc
    .from("creator_ledger_audit_events").select().in("attribution_id", ids).order("created_at", { ascending: true });
  if (error) return classifyDbError(error);
  const residual = new Map<string, number>();
  for (const e of entries.value) {
    const k = `${e.transaction_key}|${String(e.currency).trim()}`;
    residual.set(k, (residual.get(k) ?? 0) + Number(e.amount_minor));
  }
  const head = indexChains(chain.value).headOf(attributionId);
  return {
    ok: true,
    value: {
      chain: chain.value,
      headId: head ? String(head.id) : attributionId,
      entries: entries.value,
      audit: (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>,
      unbalancedTransactions: [...residual.entries()].filter(([, v]) => v !== 0).map(([k]) => k),
    },
  };
}
