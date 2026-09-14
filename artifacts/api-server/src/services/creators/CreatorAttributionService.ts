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
 * Writers: none yet in the request path — see the module header on seams.
 * Readers of what it writes: `lib/creatorTypeAttribution.ts` (the pure model),
 *                            `lib/creatorLedgerRows.ts` (the row mapping).
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

export const CREATOR_ATTRIBUTION_FLAG = "creator_attribution_enabled";

const ATTRIBUTIONS = "creator_attributions";
const RULE_VERSIONS = "creator_rule_versions";
const EARNING_ENTRIES = "creator_earning_entries";

export type CreatorServiceRefusal =
  | "disabled"
  | "degraded_unavailable"
  | "unknown_creator_type"
  | "no_active_rule_version"
  | "refused_by_model"
  | "not_found"
  | "db_error";

export type CreatorServiceResult<T> =
  | { ok: true; value: T; replayed?: true }
  | { ok: false; reason: CreatorServiceRefusal; detail?: string };

const fail = (reason: CreatorServiceRefusal, detail?: string): CreatorServiceResult<never> =>
  ({ ok: false, reason, detail });

/**
 * PostgREST returns a missing relation as an error rather than throwing, and
 * 42P01 specifically means "this migration is not applied here". Distinguishing
 * it from a genuine fault is what lets an unapplied deployment DEGRADE rather
 * than look broken — the same posture `services/trails/TrailService.ts` takes.
 */
function classifyDbError(error: any): CreatorServiceResult<never> {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? error ?? "");
  if (code === "42P01" || /does not exist|could not find the table/i.test(message)) {
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
    .from(RULE_VERSIONS)
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
    .from(RULE_VERSIONS)
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

  const model = buildAttribution({ ...input, ruleVersion });
  if (model.status !== "built") return fail("refused_by_model", `${model.reason}: ${model.detail}`);

  const row = toCreatorAttributionRow(model.attribution);
  const { data, error } = await sc.from(ATTRIBUTIONS).insert(row).select().single();
  if (!error) return { ok: true, value: { id: String(data.id), attribution: model.attribution, row: data } };

  if (String((error as any).code) === "23505") {
    const { data: existing, error: replayErr } = await sc
      .from(ATTRIBUTIONS).select().eq("idempotency_key", row.idempotency_key).maybeSingle();
    if (replayErr) return classifyDbError(replayErr);
    if (existing) {
      return { ok: true, value: { id: String(existing.id), attribution: model.attribution, row: existing }, replayed: true };
    }
    return fail("db_error", "attribution replay lookup found nothing after a 23505");
  }
  return classifyDbError(error);
}

// ── `07` §10 property 2 — earnings recorded WITHOUT PAYING ──────────────────

/**
 * Book one attribution's earning. Refuses for a seam and under a fraud hold,
 * and the database refuses the same two things independently (2921's
 * `cee_requires_recorded_value_event` trigger, and the `earnable` gate in the
 * pure model). Nothing here moves money: both legs of every transaction are
 * signed minor units and `cash_settled_minor` is written as the literal 0.
 */
export async function recordCreatorEarning(
  sc: any,
  attributionRowId: string,
  attribution: CreatorAttribution,
  input: CreatorEarningInput,
): Promise<CreatorServiceResult<{ entries: any[] }>> {
  if (!(await isFlagEnabled(sc, CREATOR_ATTRIBUTION_FLAG))) return fail("disabled");

  const built = buildCreatorEarningEntries(attribution, input);
  if (built.status !== "built") return fail("refused_by_model", `${built.reason}: ${built.detail}`);
  if (built.entries.length === 0) {
    // Every component was zero. Booking nothing is correct; saying so is better
    // than returning success over an empty write nobody notices.
    return { ok: true, value: { entries: [] } };
  }

  const rows = built.entries.map((e) => toCreatorEarningEntryRow(e, attributionRowId));
  // ON CONFLICT DO NOTHING on the TOTAL idempotency index: a redelivery is a
  // genuine no-op replay rather than an overwrite (`09` §7.2).
  const { data, error } = await sc
    .from(EARNING_ENTRIES)
    .upsert(rows, { onConflict: "idempotency_key", ignoreDuplicates: true })
    .select();
  if (error) return classifyDbError(error);
  return { ok: true, value: { entries: (data ?? []) as any[] } };
}

// ── `07` §10 property 4 — fraud holds exist ─────────────────────────────────

/**
 * Place a hold by APPENDING a superseding attribution that carries it. There is
 * no UPDATE path: 2920 grants service_role INSERT + SELECT only and a BEFORE
 * UPDATE trigger blocks the rest, so a hold cannot silently rewrite the
 * evidence the detection produced (`07` §9).
 *
 * `originalRowId` is the PERSISTED uuid of the attribution being held, which is
 * what `supersedes_id` FKs to. The pure model's `supersedesId` is a derived
 * natural key and is deliberately NOT written into that column: they are two
 * different identifiers and conflating them would produce a dangling FK.
 */
export async function holdCreatorAttribution(
  sc: any,
  original: CreatorAttribution,
  reason: string,
  originalRowId: string | null = null,
): Promise<CreatorServiceResult<{ id: string; attribution: CreatorAttribution }>> {
  if (!(await isFlagEnabled(sc, CREATOR_ATTRIBUTION_FLAG))) return fail("disabled");

  // The pure model owns the rule, including the refusal for an unexplained or
  // duplicate hold. Re-checking it here would be a second place to drift.
  const held = holdAttribution(original, reason);
  if (held.status !== "built") return fail("refused_by_model", `${held.reason}: ${held.detail}`);

  const row = { ...toCreatorAttributionRow(held.attribution), supersedes_id: originalRowId };
  const { data, error } = await sc.from(ATTRIBUTIONS).insert(row).select().single();
  if (error) return classifyDbError(error);
  return { ok: true, value: { id: String(data.id), attribution: held.attribution } };
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
    .from(ATTRIBUTIONS).select("creator_type, attribution_basis");
  if (attrErr) return classifyDbError(attrErr);
  const { data: entries, error: entryErr } = await sc
    .from(EARNING_ENTRIES).select("creator_type");
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
