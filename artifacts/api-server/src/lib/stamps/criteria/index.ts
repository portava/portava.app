/**
 * Criteria engine public surface — Stamp Wave 3.
 *
 * Two integration modes, both flag-gated by `stamp_criteria_engine_enabled`
 * (default off — the ~30 hard-coded award sites remain the source of truth
 * until you deliberately enable this):
 *
 *   GATE  — criteriaGate(): an ADDITIVE eligibility check used inside
 *           checkEligibility. If a definition has authored criteria and the
 *           flag is on, the criteria must be met. A definition with null
 *           criteria is unaffected (legacy behavior preserved).
 *
 *   AWARD — evaluateAndAwardCriteria(): the data-driven path. Evaluates every
 *           active, automatic definition that has authored criteria for a
 *           user, and awards the newly-met ones via the (idempotent) award
 *           engine. Overlap with a hard-coded site is a harmless no-op because
 *           awardStamp dedupes on (user:def:sourceType:sourceId).
 */

import { evaluateCriteria, type CriteriaResult } from "./evaluator.js";
import type { EvalContext } from "./metrics.js";

export const CRITERIA_FLAG = "stamp_criteria_engine_enabled";

export { evaluateCriteria, evaluateIfPresent } from "./evaluator.js";
export type { CriteriaResult, CriteriaCheck } from "./evaluator.js";
export { referencedMetrics, CRITERIA_SCHEMA_VERSION } from "./schema.js";
export { isKnownMetric, knownMetricNames, CONTEXT_ONLY_METRICS } from "./metrics.js";

async function flagOn(sc: any): Promise<boolean> {
  try {
    const { data, error } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", CRITERIA_FLAG)
      .maybeSingle();
    if (error) return false;
    return (data as any)?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Additive gate for checkEligibility. Returns:
 *   { blocked: false }                       — no criteria authored, or flag off, or criteria met
 *   { blocked: true, reason, result }        — criteria authored + flag on + NOT met (or malformed)
 * Never throws.
 */
export async function criteriaGate(
  sc: any,
  userId: string,
  definition: { criteria?: unknown } | null | undefined,
  ctx: EvalContext = {},
): Promise<{ blocked: boolean; reason?: string; result?: CriteriaResult }> {
  const criteria = definition?.criteria ?? null;
  if (criteria === null || criteria === undefined) return { blocked: false }; // legacy path
  if (!(await flagOn(sc))) return { blocked: false };                         // engine disabled
  const result = await evaluateCriteria(sc, userId, criteria, ctx);
  if (result.met) return { blocked: false };
  return { blocked: true, reason: result.reason, result };
}

export interface CriteriaAwardOutcome {
  slug: string;
  met: boolean;
  awarded: boolean;
  reason: string;
  userStampId?: string;
}

/**
 * Evaluate + award all automatic, criteria-bearing definitions for a user.
 * Returns per-definition outcomes. No-op (empty) when the flag is off.
 *
 * `awardFn` is injected (defaults to the real award engine) so this is unit
 * testable without HTTP or a live award pipeline.
 */
export async function evaluateAndAwardCriteria(
  sc: any,
  userId: string,
  opts: {
    ctx?: EvalContext;
    sourceType?: string;
    sourceId?: string;
    /** Restrict evaluation to these slugs (e.g. the ones a trigger touches). */
    onlySlugs?: string[];
    awardFn?: (input: {
      userId: string;
      definitionSlug: string;
      sourceType?: string;
      sourceId?: string;
    }) => Promise<{ awarded: boolean; reason: string; userStampId?: string }>;
  } = {},
): Promise<CriteriaAwardOutcome[]> {
  if (!(await flagOn(sc))) return [];

  let query = sc
    .from("stamp_definitions")
    .select("slug, criteria, criteria_type, is_active")
    .eq("is_active", true)
    .eq("criteria_type", "automatic")
    .not("criteria", "is", null);
  if (opts.onlySlugs && opts.onlySlugs.length > 0) query = query.in("slug", opts.onlySlugs);

  let defs: any[] = [];
  try {
    const { data, error } = await query;
    // D11: an unread definition table is NOT "nothing to award" — see
    // CriteriaDefinitionsUnavailableError at the bottom of this file.
    if (error || !Array.isArray(data)) throw new CriteriaDefinitionsUnavailableError(error ?? null);
    defs = data;
  } catch (e) {
    if (e instanceof CriteriaDefinitionsUnavailableError) throw e;
    throw new CriteriaDefinitionsUnavailableError(e);
  }

  const awardFn =
    opts.awardFn ??
    (async (input) => {
      const { awardStamp } = await import("../../../services/passport/StampAwardEngine.js");
      return awardStamp(sc, input as any);
    });

  const outcomes: CriteriaAwardOutcome[] = [];
  for (const def of defs) {
    const result = await evaluateCriteria(sc, userId, def.criteria, opts.ctx ?? {});
    if (!result.met) {
      outcomes.push({ slug: def.slug, met: false, awarded: false, reason: result.reason });
      continue;
    }
    try {
      const award = await awardFn({
        userId,
        definitionSlug: def.slug,
        sourceType: opts.sourceType ?? "criteria",
        sourceId: opts.sourceId ?? "none",
      });
      outcomes.push({ slug: def.slug, met: true, awarded: award.awarded, reason: award.reason, userStampId: award.userStampId });
    } catch {
      outcomes.push({ slug: def.slug, met: true, awarded: false, reason: "award_error" });
    }
  }
  return outcomes;
}

/**
 * D11 (docs/architecture/swallowed-read-inventory.md, SILENT column):
 * `evaluateAndAwardCriteria`'s `stamp_definitions` read used to answer a
 * failure with the same `[]` that "the engine flag is off" and "no active
 * automatic definition has authored criteria" legitimately return. The caller
 * could not tell an outage from a quiet day: routes/stampCatalog.ts:1472
 * serialises the result straight into the admin response as
 * `{ dryRun: false, outcomes: [] }`, which reads as "there was nothing to
 * award"; routes/events.ts:2954 and routes/posts.ts:771 decide from it which
 * stamps to award and notify.
 *
 * Rejecting keeps the fail-closed direction exactly — nothing is awarded, and
 * now nothing is CLAIMED awarded either.
 */
export class CriteriaDefinitionsUnavailableError extends Error {
  /** The postgrest error object the read resolved with, when there was one. */
  readonly readError: unknown;
  constructor(readError: unknown) {
    super("stamp_definitions read failed — criteria engine cannot say what is awardable");
    this.name = "CriteriaDefinitionsUnavailableError";
    this.readError = readError;
  }
}
