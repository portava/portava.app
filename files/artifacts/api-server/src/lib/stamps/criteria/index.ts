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
    if (error || !Array.isArray(data)) return [];
    defs = data;
  } catch {
    return [];
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
