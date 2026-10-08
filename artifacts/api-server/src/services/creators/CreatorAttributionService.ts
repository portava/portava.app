/**
 * CreatorAttributionService — the persistence seam for `07` §2's SIX creator
 * value types.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ───────────────────────────────────────
 * It is the one writer for `public.creator_attributions` and
 * `public.creator_earning_entries` (migrations 2920, 2921), and the reader for
 * `public.creator_rule_versions`. It is NOT a payment path: there is no wallet,
 * no balance, no payout and no disbursement here, and the two tables it writes
 * both CHECK their settlement column to 0 (`09` §1, "Portava moves no money").
 * `07` §10's bar is pre-money by its own words — "earnings can be recorded
 * WITHOUT PAYING" — and this is the code that clears it.
 *
 * ── A SEAM WITH NO PRODUCER IS STILL A SEAM ────────────────────────────────
 * Four of the six types have no code that records their value event
 * (`lib/creatorTypes.ts` names each absence and why). For those,
 * `recordCreatorAttribution` writes an `attribution_basis = 'seam_no_producer'`
 * row — real, addressable, auditable — and `recordCreatorEarning` REFUSES.
 * That refusal is the honest boundary: the attribution machinery works for all
 * six, four of them have nothing to attribute yet, and the day a producer lands
 * the earning path is already there and already tested. Claiming more than that
 * would be the defect.
 *
 * ── FAIL-CLOSED, TWICE ─────────────────────────────────────────────────────
 * 1. The feature flag `creator_attribution_enabled` is read through
 *    `lib/featureFlags.ts#isFlagEnabled`, which returns false on ANY error. No
 *    migration in this lane creates that flag row, and an absent row reads
 *    false — so this surface is OFF in every deployment until an owner turns it
 *    on. Nothing is read or written before the flag check.
 * 2. Until 2920/2921 are applied, every call reads a missing relation and
 *    returns `degraded_unavailable` rather than throwing.
 *
 * ── THE RULE VERSION IS DERIVED, NEVER STORED AS A FLAG ────────────────────
 * 2920's `creator_rule_versions` has no `active` column on purpose. The version
 * in force for a type is the row with the greatest `effective_from` that is not
 * in the future — a fold over an append-only table, the same principle as the
 * ledger's balance. `resolveActiveRuleVersion` is that read, and it REFUSES
 * when a type has none rather than substituting a default, because an earning
 * booked under an invented version cannot be recomputed (`07` §10).
 *
 * ── WHAT CALLS IT (census-discovery §52) ───────────────────────────────────
 * `services/creators/CreatorAttributionProducers.ts` (the Travel Partner
 * producer, driven by `lib/creatorAttributionScheduler.ts`), and
 * `services/creators/CreatorLedgerOperations.ts` (holds, releases,
 * recomputations and reversals, reached from `routes/adminCreatorLedger.ts`).
 * Every one of them is behind the same flag, still seeded FALSE by 2922.
 *
 * ── A RECOMMENDATION IS BOUND, NEVER TAKEN (3386) ──────────────────────────
 * An attribution may carry the served Discovery recommendation that led to it
 * (`08` §4). The id arrives as a CLAIM; `resolveServedRecommendation` binds it
 * to the converting viewer's own `rank_events` exposure through
 * `lib/creatorServedRecommendation.ts`, and `recordCreatorAttribution` accepts
 * only the bound form.
 *
 * Readers of what it writes: `lib/creatorTypeAttribution.ts` (the pure model),
 *                            `lib/creatorLedgerRows.ts` (the row mapping),
 *                            `services/creators/CreatorLedgerReader.ts`.
 */
import { isFlagEnabled } from "../../lib/featureFlags.js";
import {
  CREATOR_TYPES,
  creatorTypeFacts,
  isCreatorType,
  type CreatorType,
} from "../../lib/creatorTypes.js";
import {
  buildAttribution,
  holdAttribution,
  type AttributionInput,
  type CreatorAttribution,
} from "../../lib/creatorTypeAttribution.js";
import {
  buildCreatorEarningEntries,
  type CreatorEarningInput,
} from "../../lib/creatorLedgerEntries.js";
import {
  toCreatorAttributionRow,
  toCreatorEarningEntryRow,
} from "../../lib/creatorLedgerRows.js";
import {
  bindServedRecommendation,
  checkRecommendationClaimShape,
  type BoundRecommendation,
  type RecommendationBindingRefusal,
  type RecommendationClaim,
} from "../../lib/creatorServedRecommendation.js";
import { evaluateCreatorRule, type RuleEvaluationRefusal } from "../../lib/creatorRuleEvaluation.js";
import {
  beneficiaryIsNamed,
  beneficiaryState,
  indexChains,
  isIdentitySevered,
  type AttributionRow,
  type EarningEntryRow,
} from "../../lib/creatorLedgerStatus.js";
import {
  attributionModelFromRow,
  planHold,
  resolveHead,
  type DoorPayload,
  type LedgerActor,
  type PlanRefusal,
} from "../../lib/creatorLedgerPlans.js";
import type { RevenueSource } from "../../lib/creatorLedgerEntries.js";

export const CREATOR_ATTRIBUTION_FLAG = "creator_attribution_enabled";

/**
 * The ONE read of the creator-ledger gate for every module outside this file
 * (operations, reader, producer), so the flag is read through a single
 * resolvable call site — `check:flag-polarity` resolves a const within its own
 * file only — and fail-closed exactly as `isFlagEnabled` is.
 */
export async function creatorLedgerEnabled(sc: any): Promise<boolean> {
  return isFlagEnabled(sc, CREATOR_ATTRIBUTION_FLAG);
}

/**
 * The three table names, and why every `.from()` below spells its LITERAL
 * instead of using one of these.
 *
 * `check:write-path-columns` extracts write and read sites statically and
 * verifies their columns against the live schema. It cannot follow a module
 * constant, so `.from(ATTRIBUTIONS)` is reported as a `dynamic table name` —
 * a BLIND SPOT, not an error, and one that would have to be allowlisted. An
 * allowlisted site is a site the column check does not check, and these are
 * brand-new tables whose columns nothing else verifies.
 *
 * So the literals are spelled at the call sites. The two constants that remain
 * are the ones still needed as VALUES — they appear in the degraded-read
 * message, not in a query — and `creator_rule_versions` has no such use, so it
 * is gone rather than kept as a second spelling nothing reads.
 */
const ATTRIBUTIONS = "creator_attributions";
const EARNING_ENTRIES = "creator_earning_entries";

export type CreatorServiceRefusal =
  | "disabled"
  | "degraded_unavailable"
  | "unknown_creator_type"
  | "no_active_rule_version"
  | "refused_by_model"
  | "not_found"
  | "db_error"
  // ── 3386/3387, each a refusal the database makes and names ──────────────
  /** A hold or booking raced another change to the same attribution; re-read and retry. */
  | "stale_head"
  /** A key replayed with DIFFERENT content (SQLSTATE CL409). Never a success. */
  | "conflicting_replay"
  /** Booking against a superseded attribution (held, released or recomputed). */
  | "attribution_not_current"
  | "attribution_held"
  /** A version older than the one in force, or one that is not published. */
  | "stale_rule_version"
  | "unpublished_rule_version"
  /** The booking's earning is already in rent_buddy_earnings_entries (one earning, one ledger). */
  | "booked_in_subsystem_ledger"
  | "transaction_unbalanced"
  | "recommendation_not_served"
  | RecommendationBindingRefusal
  | RuleEvaluationRefusal
  | PlanRefusal;

export type CreatorServiceResult<T> =
  | { ok: true; value: T; replayed?: true }
  | { ok: false; reason: CreatorServiceRefusal; detail?: string };

export const fail = (reason: CreatorServiceRefusal, detail?: string): CreatorServiceResult<never> =>
  ({ ok: false, reason, detail });

/**
 * The refusals 3386/3387's triggers raise, by the token each message carries.
 * A trigger's refusal is a DECISION the database made about the ledger, and
 * reporting it as `db_error` would tell a caller to retry something that will
 * never succeed.
 */
const TRIGGER_REFUSALS: ReadonlyArray<[RegExp, CreatorServiceRefusal]> = [
  [/conflicting_replay/, "conflicting_replay"],
  [/attribution_not_current/, "attribution_not_current"],
  [/attribution_held/, "attribution_held"],
  [/stale_rule_version/, "stale_rule_version"],
  [/is not a published .* rule/, "unpublished_rule_version"],
  [/booked_in_subsystem_ledger/, "booked_in_subsystem_ledger"],
  [/transaction_unbalanced/, "transaction_unbalanced"],
  [/names no served exposure/, "recommendation_not_served"],
  [/recompute_while_held/, "recompute_while_held"],
  [/ca_one_supersede_per_row/, "stale_head"],
  // 3600 (C-11 answer B, PR #592): SQLSTATE CL452. A pseudonymised record is
  // frozen (`creator_ledger_subject_pseudonymised`), no row is inserted already
  // carrying a pseudonym (`creator_ledger_pseudonym_on_insert`), and no ledger
  // row is deleted (`creator_ledger_retained`). Each is the database's DECISION
  // about a record whose identity was severed or is retained for that reason —
  // the same 409 the plans answer before reaching it, never a retryable 500.
  // 3600 (4b) adds `creator_ledger_subject_erased`: a new row naming a person
  // whose profile is the erasure tombstone is refused the same way.
  [/creator_ledger_subject_pseudonymised|creator_ledger_pseudonym_on_insert|creator_ledger_retained|creator_ledger_subject_erased/, "identity_severed"],
];

/**
 * PostgREST returns a missing relation as an error rather than throwing, and
 * 42P01 specifically means "this migration is not applied here". Distinguishing
 * it from a genuine fault is what lets an unapplied deployment DEGRADE rather
 * than look broken — the same posture `services/trails/TrailService.ts` takes.
 */
export function classifyDbError(error: any): CreatorServiceResult<never> {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? error ?? "");
  const text = `${message} ${String(error?.details ?? "")}`;
  for (const [re, reason] of TRIGGER_REFUSALS) if (re.test(text)) return fail(reason, message);
  if (code === "CL409") return fail("conflicting_replay", message);
  if (code === "CL452") return fail("identity_severed", message); // 3600's SQLSTATE, whatever the message says
  // Narrow on purpose: 2921's own trigger says "attribution % does not exist"
  // about a ROW, and that is a refused write, not an unapplied migration.
  if (code === "42P01" || code === "42883" || code === "PGRST202" ||
      /relation "[^"]+" does not exist|function \S+ does not exist|could not find the (table|function)/i.test(message)) {
    return fail("degraded_unavailable", `${ATTRIBUTIONS}/${EARNING_ENTRIES} are not applied here: ${message}`);
  }
  return fail("db_error", message);
}

// ── `07` §8/§10 — the rule version in force, DERIVED ────────────────────────

export interface ActiveRuleVersion {
  creatorType: CreatorType;
  ruleVersion: string;
  /** `07` §8's configurable percentages. Seeded empty by 2920 — none is decided. */
  params: Record<string, unknown>;
  effectiveFrom: string;
}

/**
 * The version in force for one type: the greatest `effective_from` not in the
 * future. Refuses rather than defaulting — an earning booked under an invented
 * version cannot be recomputed, which is the whole of `07` §10's fifth property.
 */
export async function resolveActiveRuleVersion(
  sc: any,
  creatorType: CreatorType,
): Promise<CreatorServiceResult<ActiveRuleVersion>> {
  if (!(await isFlagEnabled(sc, CREATOR_ATTRIBUTION_FLAG))) return fail("disabled");
  if (!isCreatorType(creatorType)) return fail("unknown_creator_type", String(creatorType));

  const { data, error } = await sc
    .from("creator_rule_versions")
    .select("creator_type, rule_version, params, effective_from")
    .eq("creator_type", creatorType)
    .lte("effective_from", new Date().toISOString())
    .order("effective_from", { ascending: false })
    .limit(1);
  if (error) return classifyDbError(error);

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) {
    return fail(
      "no_active_rule_version",
      `${creatorType} has no rule version in force; 2920 seeds one per type, so this means the seed was removed`,
    );
  }
  return {
    ok: true,
    value: {
      creatorType,
      ruleVersion: String(row.rule_version),
      params: (row.params ?? {}) as Record<string, unknown>,
      effectiveFrom: String(row.effective_from),
    },
  };
}

/**
 * Every type's version in force, in `07` §2's order. The read that answers
 * "are rules versioned for all six?" without six round trips — and it reports
 * the MISSING ones rather than omitting them, so a partial answer cannot be
 * mistaken for a complete one.
 */
export async function resolveAllActiveRuleVersions(
  sc: any,
): Promise<CreatorServiceResult<Record<CreatorType, string | null>>> {
  if (!(await isFlagEnabled(sc, CREATOR_ATTRIBUTION_FLAG))) return fail("disabled");

  const { data, error } = await sc
    .from("creator_rule_versions")
    .select("creator_type, rule_version, effective_from")
    .lte("effective_from", new Date().toISOString())
    .order("effective_from", { ascending: false });
  if (error) return classifyDbError(error);

  const out = Object.fromEntries(CREATOR_TYPES.map((t) => [t, null])) as Record<CreatorType, string | null>;
  for (const row of (data ?? []) as any[]) {
    const t = row?.creator_type;
    // Rows arrive newest-first, so the FIRST one seen per type is the one in
    // force. Later ones are that type's history and must not overwrite it.
    if (isCreatorType(t) && out[t] === null) out[t] = String(row.rule_version);
  }
  return { ok: true, value: out };
}

// ── `07` §10 property 1 — value can be attributed ───────────────────────────

export interface RecordAttributionInput extends Omit<AttributionInput, "ruleVersion"> {
  /** Optional: omit to use the version in force for the type (the normal path). */
  ruleVersion?: string;
  /**
   * 3386: the served recommendation this action is linked to — ONLY in the
   * bound form `resolveServedRecommendation` returns. There is no string field:
   * a client-quoted id cannot reach the column by any typed path.
   */
  recommendation?: BoundRecommendation | null;
}

// ── 3386 — the served recommendation, bound to the converting viewer ────────

/**
 * Bind a claimed recommendation id to the converting viewer's OWN exposure.
 *
 * `claim.viewerUserId` must come from the authenticated session; the id is what
 * the client quoted. The read is filtered on (user_id = viewer, recommendation_id
 * = id), so another viewer's id reads nothing, and `bindServedRecommendation`
 * re-checks the owner anyway. Refusals never say whether the id belongs to
 * somebody else.
 */
export async function resolveServedRecommendation(
  sc: any,
  claim: RecommendationClaim,
): Promise<CreatorServiceResult<BoundRecommendation>> {
  if (!(await isFlagEnabled(sc, CREATOR_ATTRIBUTION_FLAG))) return fail("disabled");
  const shape = checkRecommendationClaimShape(claim);
  if (shape && !shape.ok) return fail(shape.reason, shape.detail);
  const { data, error } = await sc
    .from("rank_events")
    .select("id, user_id, item_id, surface, served_at, recommendation_id")
    .eq("user_id", claim.viewerUserId)
    .eq("recommendation_id", String(claim.recommendationId))
    .neq("outcome", "analytics")
    .order("served_at", { ascending: false })
    .limit(1);
  if (error) return classifyDbError(error);
  const bound = bindServedRecommendation(claim, Array.isArray(data) ? data[0] ?? null : null);
  return bound.ok ? { ok: true, value: bound.value } : fail(bound.reason, bound.detail);
}

/**
 * Record one party's contribution. A seam row (a type with no producer) is
 * written exactly like any other — that is the point of recording it — and is
 * simply not earnable.
 *
 * Idempotent: the natural key is (type, subject, event-or-seam, beneficiary),
 * and 2920's total unique index on `idempotency_key` makes a redelivery a 23505
 * that is read back rather than a second row. The index is TOTAL, so PostgREST
 * conflict-target inference matches it.
 */
export async function recordCreatorAttribution(
  sc: any,
  input: RecordAttributionInput,
): Promise<CreatorServiceResult<{ id: string; attribution: CreatorAttribution; row: any }>> {
  if (!(await isFlagEnabled(sc, CREATOR_ATTRIBUTION_FLAG))) return fail("disabled");
  if (!isCreatorType(input.creatorType)) return fail("unknown_creator_type", String(input.creatorType));

  let ruleVersion = input.ruleVersion;
  if (!ruleVersion) {
    const active = await resolveActiveRuleVersion(sc, input.creatorType);
    if (!active.ok) return active;
    ruleVersion = active.value.ruleVersion;
  }

  const { recommendation, ...modelInput } = input;
  const model = buildAttribution({ ...modelInput, ruleVersion });
  if (model.status !== "built") return fail("refused_by_model", `${model.reason}: ${model.detail}`);

  const base = toCreatorAttributionRow(model.attribution);
  const rec = recommendation ?? null;
  // A SEAM's natural key has no event in it, so two recommendations of the same
  // Trail to the same contributor would collapse into one row; the bound id
  // separates them. A recorded event's key already names the event, and a
  // second recommendation claimed for it is a conflict, not a new row.
  const key = rec && model.attribution.basis === "seam_no_producer"
    ? `${base.idempotency_key}@rec:${rec.recommendationId}`
    : base.idempotency_key;
  // recommendation_id is spread in only when there is one, so a write with no
  // recommendation is byte-identical to what it was before 3386 and still
  // succeeds on a database where 3386 is not applied.
  const row = rec ? { ...base, idempotency_key: key, recommendation_id: rec.recommendationId } : { ...base, idempotency_key: key };
  const { data, error } = await sc.from("creator_attributions").insert(row).select().single();
  if (!error) return { ok: true, value: { id: String(data.id), attribution: model.attribution, row: data } };

  if (String((error as any).code) === "23505") {
    const { data: existing, error: replayErr } = await sc
      .from("creator_attributions").select().eq("idempotency_key", row.idempotency_key).maybeSingle();
    if (replayErr) return classifyDbError(replayErr);
    if (existing) {
      // A SEVERED RECORD IS NEITHER A REPLAY NOR A CONFLICT. Its identity was
      // erased and the accounting row retained, so it no longer says WHO —
      // and a comparison against the incoming beneficiary would have to decide
      // what `null` equals. It equals nothing: `String(null)` is the string
      // `"null"`, which would differ from every real id and report this as
      // "already recorded with different content", a sentence about a conflict
      // that does not exist. Said plainly instead, before any comparison.
      const existingState = beneficiaryState(existing as { beneficiary_user_id?: unknown });
      if (existingState === "severed") {
        return fail(
          "identity_severed",
          `attribution key ${row.idempotency_key} is recorded on a row whose beneficiary identity was erased; ` +
            `that record names nobody, so this write is neither its replay nor a second claim about it`,
        );
      }
      // An ABSENT or malformed column is a read fault, not an erasure (verifier F5):
      // `?? null` here used to turn "the column was not read" into "erased".
      if (existingState === "unreadable") {
        return fail("beneficiary_unreadable", `attribution key ${row.idempotency_key}: the recorded row's beneficiary_user_id could not be read`);
      }
      const existingBeneficiary = String((existing as { beneficiary_user_id: string }).beneficiary_user_id);
      // A REPLAY IS ONLY A REPLAY IF IT SAYS THE SAME THING. Same key with a
      // different recommendation, beneficiary or figures is a second claim about
      // one event, and answering it `replayed` would silently discard it. The
      // rule version is NOT compared: it is resolved server-side from the clock,
      // and a replay arriving after a re-pricing is still the same event,
      // recorded under the version in force when it first arrived.
      const differs =
        (existing.recommendation_id ?? null) !== (rec?.recommendationId ?? null) ||
        existingBeneficiary !== String(row.beneficiary_user_id) ||
        Number(existing.gross_revenue_minor) !== Number(row.gross_revenue_minor) ||
        Number(existing.provisional_share_minor) !== Number(row.provisional_share_minor) ||
        Boolean(existing.fraud_hold) !== Boolean(row.fraud_hold);
      if (differs) {
        return fail("conflicting_replay", `attribution key ${row.idempotency_key} is already recorded with different content`);
      }
      const replayedModel = attributionModelFromRow(existing as AttributionRow);
      if (!replayedModel.ok) return fail(replayedModel.reason, replayedModel.detail);
      return {
        ok: true,
        value: { id: String(existing.id), attribution: replayedModel.model, row: existing },
        replayed: true,
      };
    }
    return fail("db_error", "attribution replay lookup found nothing after a 23505");
  }
  return classifyDbError(error);
}

// ── `07` §8/§10 — figures from a PUBLISHED rule version, never a literal ────

/** A published version's params, read by (type, version). */
async function readRuleParams(
  sc: any,
  creatorType: CreatorType,
  ruleVersion: string,
): Promise<CreatorServiceResult<Record<string, unknown>>> {
  const { data, error } = await sc
    .from("creator_rule_versions")
    .select("creator_type, rule_version, params, effective_from")
    .eq("creator_type", creatorType)
    .eq("rule_version", ruleVersion)
    .maybeSingle();
  if (error) return classifyDbError(error);
  if (!data) return fail("unpublished_rule_version", `${creatorType} has no published version ${ruleVersion}`);
  return { ok: true, value: (data.params ?? {}) as Record<string, unknown> };
}

export interface AttributionUnderRuleInput
  extends Omit<RecordAttributionInput, "ruleVersion" | "provisionalShareMinor"> {
  revenueSource?: RevenueSource | null;
}

/**
 * Record an attribution whose provisional share is COMPUTED from the version in
 * force — `07` §8's "store … rule version, provisional share" with the
 * percentage read from `creator_rule_versions.params`, never from code. A
 * version whose params publish no percentage (every seeded one: 2920 seeds
 * `{}`) refuses with `rule_params_incomplete` and records nothing.
 */
export async function recordCreatorAttributionUnderRule(
  sc: any,
  input: AttributionUnderRuleInput,
): Promise<CreatorServiceResult<{ id: string; attribution: CreatorAttribution; row: any }>> {
  if (!(await isFlagEnabled(sc, CREATOR_ATTRIBUTION_FLAG))) return fail("disabled");
  if (!isCreatorType(input.creatorType)) return fail("unknown_creator_type", String(input.creatorType));
  const active = await resolveActiveRuleVersion(sc, input.creatorType);
  if (!active.ok) return active;
  const figures = evaluateCreatorRule(active.value.params, {
    grossRevenueMinor: input.grossRevenueMinor, weight: input.weight, revenueSource: input.revenueSource,
  });
  if (!figures.ok) return fail(figures.reason, figures.detail);
  const { revenueSource: _rs, ...rest } = input;
  return recordCreatorAttribution(sc, {
    ...rest,
    ruleVersion: active.value.ruleVersion,
    provisionalShareMinor: figures.value.creatorShareMinor,
  });
}

/**
 * Book the earning of ONE persisted attribution under ITS OWN rule version.
 *
 * The figures are re-evaluated from that version's published params over the
 * attribution's recorded gross, and must reproduce the provisional share the
 * attribution recorded; if they do not, the attribution was not computed by the
 * rule it names and nothing is booked. The database then refuses a superseded
 * or held attribution, a stale version, an unbalanced transaction and a booking
 * already in `rent_buddy_earnings_entries` (3387), independently of this code.
 */
export async function bookCreatorEarningUnderRule(
  sc: any,
  attributionRowId: string,
  opts: { revenueSource?: RevenueSource | null } = {},
): Promise<CreatorServiceResult<RecordedCreatorEarning>> {
  if (!(await isFlagEnabled(sc, CREATOR_ATTRIBUTION_FLAG))) return fail("disabled");
  const { data: row, error } = await sc.from("creator_attributions").select().eq("id", attributionRowId).maybeSingle();
  if (error) return classifyDbError(error);
  if (!row) return fail("not_found", attributionRowId);
  const a = row as AttributionRow;
  if (!isCreatorType(a.creator_type)) return fail("unknown_creator_type", String(a.creator_type));
  // Who the earning is for is settled BEFORE anything else is read: a severed or
  // unreadable beneficiary has no earning to price (verifier F6 pins this).
  const model = attributionModelFromRow(a);
  if (!model.ok) return fail(model.reason, model.detail);
  const params = await readRuleParams(sc, a.creator_type, a.rule_version);
  if (!params.ok) return params;
  const figures = evaluateCreatorRule(params.value, {
    grossRevenueMinor: Number(a.gross_revenue_minor), weight: Number(a.weight),
    revenueSource: opts.revenueSource ?? null, currency: String(a.currency).trim(),
  });
  if (!figures.ok) return fail(figures.reason, figures.detail);
  if (figures.value.creatorShareMinor !== Number(a.provisional_share_minor)) {
    return fail(
      "refused_by_model",
      `attribution ${a.id} records a provisional share of ${a.provisional_share_minor} but ${a.rule_version} computes ` +
        `${figures.value.creatorShareMinor}; it was not computed by the rule it names`,
    );
  }
  return recordCreatorEarning(sc, String(a.id), model.model, figures.value);
}

// ── The one-transaction door (3387) ─────────────────────────────────────────

export interface LedgerAppendResult {
  attribution_id: string | null;
  attribution_inserted: boolean;
  entries_inserted: number;
  entries_replayed: number;
  audit_id: string | null;
  audit_inserted: boolean;
}

/**
 * Send one payload through `public.creator_ledger_append`. One call is one
 * transaction: every row lands or none does. Every refusal the database makes
 * is mapped to its name by `classifyDbError`.
 */
export async function appendToLedger(sc: any, payload: DoorPayload): Promise<CreatorServiceResult<LedgerAppendResult>> {
  if (typeof sc?.rpc !== "function") return fail("degraded_unavailable", "this client cannot call creator_ledger_append");
  const { data, error } = await sc.rpc("creator_ledger_append", { p: payload });
  if (error) return classifyDbError(error);
  const r = (typeof data === "string" ? JSON.parse(data) : data) as LedgerAppendResult | null;
  if (!r || typeof r !== "object") return fail("db_error", "creator_ledger_append returned nothing");
  // A replay is a call that appended NOTHING: every key was already recorded
  // with this content (a differing one would have raised CL409 above).
  const replayed = !r.attribution_inserted && r.entries_inserted === 0 && !r.audit_inserted;
  return replayed ? { ok: true, value: r, replayed: true } : { ok: true, value: r };
}

/**
 * Every attribution row that can share a chain with `attributionId`: the same
 * type, subject and beneficiary. A supersession keeps all three (3387's
 * `ca_supersession_is_lawful`), so the chain is always inside this set.
 */
export async function readAttributionChain(
  sc: any,
  attributionId: string,
): Promise<CreatorServiceResult<AttributionRow[]>> {
  const { data: row, error } = await sc.from("creator_attributions").select().eq("id", attributionId).maybeSingle();
  if (error) return classifyDbError(error);
  if (!row) return fail("not_found", attributionId);
  // A SEVERED BENEFICIARY IS NOT A GROUPING KEY. The chain is found by the
  // three things a supersession must keep, one of which is the beneficiary. On
  // a row whose identity was erased that column is NULL, and PostgREST's
  // `beneficiary_user_id=eq.null` matches NOTHING — so this read would hand
  // back an EMPTY chain for a row it had just fetched by id, reporting "the
  // identity is gone" as "there is no record", and `readCreatorLedgerAuditTrail`
  // would then present a reconstruction with no rows, no entries and no audit
  // as if the attribution had never been acted on. Refuse: the chain is not
  // establishable from this column, and that is a different answer from empty.
  if (isIdentitySevered(row as AttributionRow)) {
    return fail(
      "identity_severed",
      `attribution ${attributionId}'s beneficiary identity was erased; its chain cannot be grouped by ` +
        `beneficiary_user_id, and an empty chain would misreport the row as never acted on`,
    );
  }
  // ABSENT OR MALFORMED IS NOT ERASED (verifier F5): a row read without its
  // beneficiary column, or with one that is not a uuid, is a read fault.
  if (!beneficiaryIsNamed(row as AttributionRow)) {
    return fail("beneficiary_unreadable", `attribution ${attributionId} was read without a readable beneficiary_user_id`);
  }
  const { data, error: e2 } = await sc
    .from("creator_attributions")
    .select()
    .eq("creator_type", row.creator_type)
    .eq("subject_id", row.subject_id)
    .eq("beneficiary_user_id", row.beneficiary_user_id)
    .limit(10_000);
  if (e2) return classifyDbError(e2);
  const rows = (Array.isArray(data) ? data : []) as AttributionRow[];
  const chain = indexChains(rows).chainOf(attributionId);
  return { ok: true, value: chain };
}

/** Every entry booked against any row of `attributionIds`, reversals included. */
export async function readEntriesFor(
  sc: any,
  attributionIds: readonly string[],
): Promise<CreatorServiceResult<EarningEntryRow[]>> {
  if (attributionIds.length === 0) return { ok: true, value: [] };
  const { data, error } = await sc
    .from("creator_earning_entries")
    .select()
    .in("attribution_id", [...attributionIds])
    .limit(100_000);
  if (error) return classifyDbError(error);
  return { ok: true, value: (Array.isArray(data) ? data : []) as EarningEntryRow[] };
}

// ── `07` §10 property 2 — earnings recorded WITHOUT PAYING ──────────────────

/**
 * What this call did to the ledger. FOUR answers, not two.
 *
 * "Earnings can be recorded without paying" is a claim about what a reader can
 * TELL. The not-paying half is structural — `cash_settled_minor` is CHECK-zero
 * in 2921 and typed `0` in the model, so no row can assert a settlement. The
 * RECORDED half needs this enum, because three of these four outcomes used to
 * be reported with the same value.
 */
export type CreatorEarningBooking =
  /** The earning was worth nothing. No entry exists and none is owed. */
  | "nothing_to_book"
  /** Every entry was written by THIS call. */
  | "booked"
  /** Every entry was already on the ledger. The entitlement stands, recorded. */
  | "already_booked"
  /** Some legs were already present and this call wrote the rest. */
  | "partially_already_booked";

export interface RecordedCreatorEarning {
  booking: CreatorEarningBooking;
  /**
   * The rows THIS call inserted. Empty on `already_booked` — which is why it
   * must never be read as "the creator earned nothing"; read `booking`.
   */
  entries: any[];
  /**
   * How many entries the earning CONSISTS of, whoever wrote them. Zero only
   * under `nothing_to_book`.
   */
  entryCount: number;
}

/**
 * Book one attribution's earning. Refuses for a seam and under a fraud hold,
 * and the database refuses the same two things independently (2921's
 * `cee_requires_recorded_value_event` trigger, and the `earnable` gate in the
 * pure model). Nothing here moves money: both legs of every transaction are
 * signed minor units and `cash_settled_minor` is written as the literal 0.
 *
 * ── WHY THE OUTCOME IS AN ENUM AND NOT A ROW COUNT ─────────────────────────
 * The upsert carries `ignoreDuplicates`, so PostgREST sends
 * `Prefer: resolution=ignore-duplicates` and Postgres runs
 * `INSERT ... ON CONFLICT DO NOTHING ... RETURNING`, which returns ONLY the
 * rows it actually inserted. A redelivered earning therefore comes back as
 * `data: []` with `error: null`.
 *
 * This function used to return that as `{ ok: true, entries: [] }` — the same
 * value, field for field, as an all-zero earning that booked nothing. So a
 * caller asking "is this creator's earning on the ledger?" could not tell "yes,
 * already, in full" from "no, and nothing is owed". That is a false negative
 * about someone's money delivered as a SUCCESS, which no error handling would
 * have caught, and `recordCreatorAttribution` two functions up already had the
 * `replayed` flag this path was missing.
 *
 * `entries` (what this call wrote) and `entryCount` (what the earning consists
 * of) are separate fields for the same reason: one cannot be misread as the
 * other.
 */
export async function recordCreatorEarning(
  sc: any,
  attributionRowId: string,
  attribution: CreatorAttribution,
  input: CreatorEarningInput,
): Promise<CreatorServiceResult<RecordedCreatorEarning>> {
  if (!(await isFlagEnabled(sc, CREATOR_ATTRIBUTION_FLAG))) return fail("disabled");

  const built = buildCreatorEarningEntries(attribution, input);
  if (built.status !== "built") return fail("refused_by_model", `${built.reason}: ${built.detail}`);
  if (built.entries.length === 0) {
    // Every component was zero. Booking nothing is correct; saying so is better
    // than returning success over an empty write nobody notices.
    return { ok: true, value: { booking: "nothing_to_book", entries: [], entryCount: 0 } };
  }

  const rows = built.entries.map((e) => toCreatorEarningEntryRow(e, attributionRowId));
  // ON CONFLICT DO NOTHING on the TOTAL idempotency index: a redelivery is a
  // genuine no-op replay rather than an overwrite (`09` §7.2).
  const { data, error } = await sc
    .from("creator_earning_entries")
    .upsert(rows, { onConflict: "idempotency_key", ignoreDuplicates: true })
    .select();
  if (error) return classifyDbError(error);

  const inserted = (data ?? []) as any[];
  const entryCount = rows.length;
  if (inserted.length >= entryCount) {
    return { ok: true, value: { booking: "booked", entries: inserted, entryCount } };
  }
  // A replay, whole or partial. Both are flagged `replayed` — the caller that
  // only wants "was this delivered before?" reads one field, and the caller
  // reconciling legs reads `booking`.
  return {
    ok: true,
    value: {
      booking: inserted.length === 0 ? "already_booked" : "partially_already_booked",
      entries: inserted,
      entryCount,
    },
    replayed: true,
  };
}

// ── `07` §10 property 4 — fraud holds exist ─────────────────────────────────

/**
 * Place a hold by APPENDING a superseding attribution that carries it. There is
 * no UPDATE path: 2920 grants service_role INSERT + SELECT only and a BEFORE
 * UPDATE trigger blocks the rest, so a hold cannot silently rewrite the
 * evidence the detection produced (`07` §9).
 *
 * ── WHAT CHANGED (census-discovery §52) ─────────────────────────────────────
 * This used to INSERT the hold row directly, with `supersedes_id` defaulting to
 * NULL. A hold with no `originalRowId` was therefore a new, UNLINKED held row —
 * the attribution it meant to hold stayed un-held and earnable, and the hold
 * held nothing. And no hold was audited: nobody could say who placed it.
 *
 * Now `originalRowId` is REQUIRED (a hold on nothing is refused), the hold is
 * placed on the HEAD of that row's chain, and it goes through 3387's
 * `creator_ledger_append` together with its audit row, in one transaction.
 * The pure model still rules first, so an unexplained or duplicate hold is
 * refused before anything is read.
 */
export async function holdCreatorAttribution(
  sc: any,
  original: CreatorAttribution,
  reason: string,
  originalRowId: string | null = null,
  actor: LedgerActor = { kind: "system", userId: null },
): Promise<CreatorServiceResult<{ id: string; attribution: CreatorAttribution }>> {
  if (!(await isFlagEnabled(sc, CREATOR_ATTRIBUTION_FLAG))) return fail("disabled");

  // The pure model owns the rule, including the refusal for an unexplained or
  // duplicate hold. Re-checking it here would be a second place to drift.
  const held = holdAttribution(original, reason);
  if (held.status !== "built") return fail("refused_by_model", `${held.reason}: ${held.detail}`);
  if (!originalRowId) {
    return fail("not_found", "a hold must name the persisted attribution it holds; a hold on no row holds nothing");
  }

  const chain = await readAttributionChain(sc, originalRowId);
  if (!chain.ok) return chain;
  const head = resolveHead(chain.value, originalRowId);
  if (!head.ok) return fail(head.reason, head.detail);
  const plan = planHold(head.head, reason, actor);
  if (!plan.ok) return fail(plan.reason, plan.detail);
  const appended = await appendToLedger(sc, plan.payload);
  if (!appended.ok) return appended;
  const heldRow = { ...head.head, ...plan.payload.attribution!, id: String(appended.value.attribution_id) } as AttributionRow;
  const heldModel = attributionModelFromRow(heldRow);
  if (!heldModel.ok) return fail(heldModel.reason, heldModel.detail);
  return { ok: true, value: { id: String(appended.value.attribution_id), attribution: heldModel.model } };
}

// ── Coverage read ───────────────────────────────────────────────────────────

export interface CreatorTypeCoverage {
  creatorType: CreatorType;
  specName: string;
  /** The object contributions are attributed against, or null if none exists. */
  subjectTable: string | null;
  /** The shipping code that records the value event, or null. */
  valueEventProducer: string | null;
  ruleVersionInForce: string | null;
  attributionsRecorded: number;
  /** Of those, how many name a real value event rather than being a seam. */
  attributionsWithValueEvent: number;
  earningEntriesRecorded: number;
}

/**
 * What is actually true per type, read from the database rather than asserted.
 *
 * This exists so "the five properties hold for all six types" is a QUERY and
 * not a claim in a report: a type with a null producer and zero
 * `attributionsWithValueEvent` is a seam, and this says so out loud instead of
 * letting a row count imply coverage.
 */
export async function readCreatorTypeCoverage(
  sc: any,
): Promise<CreatorServiceResult<CreatorTypeCoverage[]>> {
  if (!(await isFlagEnabled(sc, CREATOR_ATTRIBUTION_FLAG))) return fail("disabled");

  const versions = await resolveAllActiveRuleVersions(sc);
  if (!versions.ok) return versions;

  const { data: attrs, error: attrErr } = await sc
    .from("creator_attributions").select("creator_type, attribution_basis");
  if (attrErr) return classifyDbError(attrErr);
  const { data: entries, error: entryErr } = await sc
    .from("creator_earning_entries").select("creator_type");
  if (entryErr) return classifyDbError(entryErr);

  return {
    ok: true,
    value: CREATOR_TYPES.map((t) => {
      const facts = creatorTypeFacts(t);
      const mine = ((attrs ?? []) as any[]).filter((r) => r?.creator_type === t);
      return {
        creatorType: t,
        specName: facts.specName,
        subjectTable: facts.subjectTable,
        valueEventProducer: facts.valueEventProducer,
        ruleVersionInForce: versions.value[t],
        attributionsRecorded: mine.length,
        attributionsWithValueEvent: mine.filter((r) => r?.attribution_basis === "recorded_value_event").length,
        earningEntriesRecorded: ((entries ?? []) as any[]).filter((r) => r?.creator_type === t).length,
      };
    }),
  };
}
