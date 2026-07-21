/**
 * CompassOutcomeEngine — Phase 14 outcome learning.
 *
 * Tracks the full recommendation outcome chain:
 *   recommended → viewed → saved → went → stayed → liked → invited →
 *   made_memory → returned
 *
 * Each realized stage is tied back to the originating recommendation record
 * in compass_served_recommendations (which persists the predicted Compass
 * Match at delivery time inside ranking_factors). Recording an outcome:
 *
 *   1. Resolves the originating served-recommendation row — either directly
 *      via the signed recommendationId token, or by (user, item) lookup for
 *      organic signals (saves, RSVPs, likes, stamps, invites, return visits)
 *      that arrive without a token.
 *   2. Inserts a deduplicated row into compass_outcome_events (one row per
 *      user + recommendation + stage).
 *   3. Re-scores the realized outcome chain (0–100) against the predicted
 *      Compass Match, and when the |delta| crosses the feedback threshold,
 *      nudges the user's category weight for that item's category — the same
 *      per-user weight surface the ranking pipeline already consumes
 *      (compass_user_preferences.category_weights via profile.categoryWeights)
 *      — so prediction error feeds directly back into ranking.
 *
 * Value delivered (north-star aggregate):
 *   computeValueDelivered() aggregates the outcome chain into value points
 *   per stage. It is explicitly built from realized real-world outcomes
 *   (went, stayed, made_memory, returned…), NEVER from chat length or
 *   session time.
 *
 * All entry points are fail-soft: outcome recording must never break the
 * signal route that triggered it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ── Outcome chain ─────────────────────────────────────────────────────────────

export const OUTCOME_STAGES = [
  "viewed",
  "saved",
  "went",
  "stayed",
  "liked",
  "invited",
  "made_memory",
  "returned",
] as const;

export type OutcomeStage = typeof OUTCOME_STAGES[number];

/**
 * Realized-fit value of each stage on the same 0–100 scale as the predicted
 * Compass Match. The realized score of a chain is the MAX stage value reached
 * — deeper stages indicate the recommendation delivered more real value.
 */
export const STAGE_FIT_VALUE: Record<OutcomeStage, number> = {
  viewed:      15,
  saved:       35,
  went:        65,
  stayed:      75,
  liked:       70,
  invited:     85,
  made_memory: 95,
  returned:    100,
};

/**
 * Value-delivered points per stage — the north-star aggregate is the sum of
 * these across all recorded outcomes. Weighted toward real-world outcomes
 * (going, staying, making memories, returning), not screen engagement.
 */
export const STAGE_VALUE_POINTS: Record<OutcomeStage, number> = {
  viewed:      1,
  saved:       3,
  went:        8,
  stayed:      10,
  liked:       5,
  invited:     8,
  made_memory: 10,
  returned:    12,
};

/** |realized − predicted| must reach this before a ranking-weight nudge fires. */
export const FIT_DELTA_THRESHOLD = 20;

/** Per-outcome weight nudge magnitude (bounded ±10 total, same as feedback). */
const WEIGHT_NUDGE_STEP = 1;

/** Only link organic signals to recommendations served within this window. */
const LINK_WINDOW_DAYS = 30;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecordOutcomeRequest {
  /** Signed recommendation token (preferred — exact provenance). */
  recommendationId?: string;
  /** Entity id — used to find the most recent served recommendation. */
  itemId?: string;
  stage: OutcomeStage;
  /** Where the signal came from, e.g. "route:saves", "client". */
  source?: string;
}

export interface RecordOutcomeResult {
  recorded: boolean;
  reason?: "no_recommendation" | "duplicate" | "db_unavailable" | "error";
  recommendationId?: string;
  predictedMatch?: number | null;
  realizedScore?: number;
  fitDelta?: number | null;
  weightAdjusted?: boolean;
}

interface ServedRecRow {
  recommendation_id: string;
  item_id: string;
  item_type: string;
  ranking_factors: Record<string, unknown> | null;
}

// ── Recommendation resolution ─────────────────────────────────────────────────

async function resolveServedRecommendation(
  db: SupabaseClient,
  userId: string,
  req: RecordOutcomeRequest,
): Promise<ServedRecRow | null> {
  const cols = "recommendation_id, item_id, item_type, ranking_factors";

  if (req.recommendationId) {
    const { data } = await db
      .from("compass_served_recommendations")
      .select(cols)
      .eq("user_id", userId)
      .eq("recommendation_id", req.recommendationId)
      .maybeSingle();
    return (data as ServedRecRow | null) ?? null;
  }

  if (req.itemId) {
    const cutoff = new Date(Date.now() - LINK_WINDOW_DAYS * 86_400_000).toISOString();
    const { data } = await db
      .from("compass_served_recommendations")
      .select(cols)
      .eq("user_id", userId)
      .eq("item_id", req.itemId)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(1);
    return ((data as ServedRecRow[] | null) ?? [])[0] ?? null;
  }

  return null;
}

function extractPredictedMatch(rankingFactors: Record<string, unknown> | null): number | null {
  const v = rankingFactors?.compassMatch;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ── Realized-fit scoring ──────────────────────────────────────────────────────

/** Realized score = max stage value reached in the chain (0 when empty). */
export function computeRealizedScore(stages: OutcomeStage[]): number {
  let max = 0;
  for (const s of stages) {
    const v = STAGE_FIT_VALUE[s];
    if (typeof v === "number" && v > max) max = v;
  }
  return max;
}

/** Signed prediction error: realized − predicted. Null when no prediction. */
export function computeFitDelta(
  predicted: number | null | undefined,
  realized: number,
): number | null {
  if (predicted == null || !Number.isFinite(predicted)) return null;
  return Math.round((realized - predicted) * 100) / 100;
}

// ── Ranking feedback ──────────────────────────────────────────────────────────

/**
 * Nudge the user's category weight for the item's category/type by the sign
 * of the fit delta. Uses the SAME per-user weight surface the ranking
 * pipeline reads (compass_user_preferences.category_weights →
 * profile.categoryWeights → CompassFeedBuilder / CompassRecommendationEngine),
 * so prediction error directly shifts future ranking.
 */
async function applyRankingNudge(
  db: SupabaseClient,
  userId: string,
  categoryKey: string,
  fitDelta: number,
): Promise<boolean> {
  try {
    const { data } = await db
      .from("compass_user_preferences")
      .select("category_weights")
      .eq("user_id", userId)
      .maybeSingle();
    const weights: Record<string, number> =
      ((data as any)?.category_weights as Record<string, number>) ?? {};
    const step = fitDelta > 0 ? WEIGHT_NUDGE_STEP : -WEIGHT_NUDGE_STEP;
    weights[categoryKey] = Math.max(-10, Math.min(10, (weights[categoryKey] ?? 0) + step));
    const { error } = await db
      .from("compass_user_preferences")
      .upsert(
        { user_id: userId, category_weights: weights, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
    return !error;
  } catch {
    return false;
  }
}

// ── Record an outcome ─────────────────────────────────────────────────────────

/**
 * Record one realized stage of the outcome chain against its originating
 * recommendation. Dedupes per (user, recommendation, stage). Never throws.
 */
export async function recordOutcome(
  db: SupabaseClient | null,
  userId: string,
  req: RecordOutcomeRequest,
): Promise<RecordOutcomeResult> {
  if (!db) return { recorded: false, reason: "db_unavailable" };

  try {
    const rec = await resolveServedRecommendation(db, userId, req);
    if (!rec) return { recorded: false, reason: "no_recommendation" };

    // Dedupe: one row per user + recommendation + stage
    const { data: existing } = await db
      .from("compass_outcome_events")
      .select("id")
      .eq("user_id", userId)
      .eq("recommendation_id", rec.recommendation_id)
      .eq("stage", req.stage)
      .limit(1);
    if (((existing as any[]) ?? []).length > 0) {
      return { recorded: false, reason: "duplicate", recommendationId: rec.recommendation_id };
    }

    const predicted = extractPredictedMatch(rec.ranking_factors);

    const { error: insertErr } = await db.from("compass_outcome_events").insert({
      user_id:           userId,
      recommendation_id: rec.recommendation_id,
      item_id:           rec.item_id,
      item_type:         rec.item_type,
      stage:             req.stage,
      stage_value:       STAGE_VALUE_POINTS[req.stage],
      predicted_match:   predicted,
      source:            req.source ?? null,
    });
    if (insertErr) return { recorded: false, reason: "error" };

    // Realized chain so far for this recommendation
    const { data: chainRows } = await db
      .from("compass_outcome_events")
      .select("stage")
      .eq("user_id", userId)
      .eq("recommendation_id", rec.recommendation_id);
    const stages = (((chainRows as any[]) ?? []).map((r) => r.stage) as OutcomeStage[])
      .concat(chainRows == null ? [req.stage] : []);
    const realized = computeRealizedScore(stages.length > 0 ? stages : [req.stage]);
    const fitDelta = computeFitDelta(predicted, realized);

    // Ranking feedback: significant prediction error nudges category weight.
    let weightAdjusted = false;
    if (fitDelta != null && Math.abs(fitDelta) >= FIT_DELTA_THRESHOLD) {
      weightAdjusted = await applyRankingNudge(db, userId, rec.item_type, fitDelta);
    }

    return {
      recorded: true,
      recommendationId: rec.recommendation_id,
      predictedMatch:   predicted,
      realizedScore:    realized,
      fitDelta,
      weightAdjusted,
    };
  } catch {
    return { recorded: false, reason: "error" };
  }
}

/**
 * Fire-and-forget hook for organic signal routes (saves, RSVPs, likes,
 * stamps, invites, return visits). Links the signal back to the most recent
 * served recommendation for the entity; silently no-ops when the entity was
 * never recommended. Call with `void` — never blocks, never throws.
 */
export async function linkOutcomeSignal(
  db: SupabaseClient | null,
  userId: string,
  itemId: string | null | undefined,
  stage: OutcomeStage,
  source: string,
): Promise<void> {
  if (!db || !itemId) return;
  try {
    await recordOutcome(db, userId, { itemId, stage, source });
  } catch { /* never break the signal route */ }
}

// ── Value-delivered aggregate ─────────────────────────────────────────────────

export interface ValueDeliveredReport {
  period_days: number;
  served_recommendations: number;
  recommendations_with_outcomes: number;
  outcome_conversion_rate: number;
  stage_counts: Record<OutcomeStage, number>;
  value_points_total: number;
  value_points_by_stage: Record<OutcomeStage, number>;
  /** Per served recommendation with at least one outcome. */
  avg_value_per_converted_recommendation: number;
  prediction: {
    with_prediction: number;
    avg_predicted: number | null;
    avg_realized: number | null;
    avg_fit_delta: number | null;
    overpredicted: number;   // predicted ≥ realized + threshold
    underpredicted: number;  // realized ≥ predicted + threshold
  };
  by_item_type: Record<string, { outcomes: number; value_points: number }>;
  /** North-star basis — real outcomes only; explicitly excludes time-based proxies. */
  basis: "outcome_chain";
}

/**
 * Compute the "value delivered" aggregate from the outcome chain.
 * Explicitly NOT chat-length or session-time based — every point comes from
 * a realized outcome stage tied to a served recommendation.
 */
export async function computeValueDelivered(
  db: SupabaseClient,
  opts: { days?: number } = {},
): Promise<ValueDeliveredReport> {
  const days = Math.min(90, Math.max(1, opts.days ?? 30));
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  const [{ data: outcomeRows }, { count: servedCount }] = await Promise.all([
    db.from("compass_outcome_events")
      .select("recommendation_id, item_type, stage, stage_value, predicted_match")
      .gte("occurred_at", cutoff),
    db.from("compass_served_recommendations")
      .select("id", { count: "exact", head: true })
      .gte("created_at", cutoff),
  ]);

  const rows = ((outcomeRows as any[]) ?? []);

  const stageCounts = Object.fromEntries(OUTCOME_STAGES.map((s) => [s, 0])) as Record<OutcomeStage, number>;
  const stagePoints = Object.fromEntries(OUTCOME_STAGES.map((s) => [s, 0])) as Record<OutcomeStage, number>;
  const byType: Record<string, { outcomes: number; value_points: number }> = {};
  const byRec = new Map<string, { stages: OutcomeStage[]; predicted: number | null }>();

  let totalPoints = 0;
  for (const r of rows) {
    const stage = r.stage as OutcomeStage;
    if (!(stage in stageCounts)) continue;
    const pts = typeof r.stage_value === "number" ? r.stage_value : STAGE_VALUE_POINTS[stage];
    stageCounts[stage]++;
    stagePoints[stage] += pts;
    totalPoints += pts;

    const t = (r.item_type as string) ?? "unknown";
    if (!byType[t]) byType[t] = { outcomes: 0, value_points: 0 };
    byType[t].outcomes++;
    byType[t].value_points += pts;

    const key = r.recommendation_id as string;
    const entry = byRec.get(key) ?? { stages: [], predicted: null };
    entry.stages.push(stage);
    if (entry.predicted == null && typeof r.predicted_match === "number") {
      entry.predicted = r.predicted_match;
    }
    byRec.set(key, entry);
  }

  // Prediction calibration across converted recommendations
  let withPrediction = 0, sumPredicted = 0, sumRealized = 0, sumDelta = 0;
  let over = 0, under = 0;
  for (const entry of byRec.values()) {
    if (entry.predicted == null) continue;
    const realized = computeRealizedScore(entry.stages);
    const delta = realized - entry.predicted;
    withPrediction++;
    sumPredicted += entry.predicted;
    sumRealized  += realized;
    sumDelta     += delta;
    if (delta <= -FIT_DELTA_THRESHOLD) over++;
    if (delta >=  FIT_DELTA_THRESHOLD) under++;
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const converted = byRec.size;
  const served = servedCount ?? 0;

  return {
    period_days: days,
    served_recommendations: served,
    recommendations_with_outcomes: converted,
    outcome_conversion_rate: served === 0 ? 0 : round2(converted / served),
    stage_counts: stageCounts,
    value_points_total: totalPoints,
    value_points_by_stage: stagePoints,
    avg_value_per_converted_recommendation: converted === 0 ? 0 : round2(totalPoints / converted),
    prediction: {
      with_prediction: withPrediction,
      avg_predicted: withPrediction === 0 ? null : round2(sumPredicted / withPrediction),
      avg_realized:  withPrediction === 0 ? null : round2(sumRealized / withPrediction),
      avg_fit_delta: withPrediction === 0 ? null : round2(sumDelta / withPrediction),
      overpredicted: over,
      underpredicted: under,
    },
    by_item_type: byType,
    basis: "outcome_chain",
  };
}
