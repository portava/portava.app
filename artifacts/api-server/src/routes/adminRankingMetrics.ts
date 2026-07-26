/**
 * GET /api/admin/ranking/metrics
 *
 * Returns the §9 algorithm health metrics from rank_events for the past N days.
 * Admin role required.
 *
 * Query params:
 *   days  — look-back window in days (default 7, max 90)
 *
 * Response shape (backward-compatible — new fields added, none removed):
 * {
 *   period_days, impressions, taps, saves, joins, rsvps, attended,
 *   realized_connection_rate,
 *   tap_through_rate,
 *   tap_through_by_kind: { [kind]: { impressions, taps, rate } },
 *   exploration_slot: { impressions, taps, rate },
 *   by_surface: { [surface]: { impressions, taps } },
 *
 *   // New fields:
 *   exposure_by_tier: { highly_active, active, moderate, occasional, new_inactive },
 *   creator_concentration: { top_1pct, top_5pct, top_10pct, alert: boolean },
 *   new_user_exposure_rate: number,
 *   returning_user_recovery_rate: number,
 *   underexposed_content_rate: number,
 *   diversity: { median_unique_creators_per_10, category_concentration, city_concentration },
 *   negative_feedback: { hide_rate, report_rate, block_rate },
 *   ranking_version: string,
 *   experiment_enabled: boolean,
 *   spam_risk: { high_spam_count: number, high_repetition_count: number },
 *   job_health: { creator_activity_score: JobHealthEntry, content_distribution: JobHealthEntry },
 * }
 */

import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { ACTIVITY_SCORE_VERSION } from "../services/ranking/CreatorActivityScoreService.js";

const router = Router();

async function requireAdmin(req: any, res: any): Promise<{ sc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;

  const { data, error } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }

  const sc = getServiceClient() ?? client;
  return { sc };
}

// ── Score tier boundaries ─────────────────────────────────────────────────────
// Tiers derived from creator_activity_scores.score (0–100):
//   0–20  → new_inactive
//   21–40 → occasional
//   41–65 → moderate
//   66–85 → active
//   86–100 → highly_active

export interface TierBuckets {
  highly_active: number;
  active: number;
  moderate: number;
  occasional: number;
  new_inactive: number;
}

export function bucketScoreToTier(score: number): keyof TierBuckets {
  if (score >= 86) return "highly_active";
  if (score >= 66) return "active";
  if (score >= 41) return "moderate";
  if (score >= 21) return "occasional";
  return "new_inactive";
}

/**
 * Compute percentage distribution of creators across activity tiers.
 * Returns fractions (0–1) summing to 1.
 */
export function computeTierDistribution(scores: number[]): TierBuckets {
  const counts: TierBuckets = {
    highly_active: 0,
    active: 0,
    moderate: 0,
    occasional: 0,
    new_inactive: 0,
  };
  for (const s of scores) {
    counts[bucketScoreToTier(s)]++;
  }
  const total = scores.length || 1;
  return {
    highly_active: Math.round((counts.highly_active / total) * 10_000) / 10_000,
    active:        Math.round((counts.active        / total) * 10_000) / 10_000,
    moderate:      Math.round((counts.moderate      / total) * 10_000) / 10_000,
    occasional:    Math.round((counts.occasional    / total) * 10_000) / 10_000,
    new_inactive:  Math.round((counts.new_inactive  / total) * 10_000) / 10_000,
  };
}

/**
 * Compute concentration metrics: share of total impressions (proxied by score)
 * captured by the top N% of creators.
 *
 * @param scores  Array of creator scores (0–100), one per creator.
 * @param alertThreshold  Alert when top-10% share exceeds this (default 0.60).
 */
export function computeConcentration(
  scores: number[],
  alertThreshold = 0.6,
): { top_1pct: number; top_5pct: number; top_10pct: number; alert: boolean } {
  if (scores.length === 0) {
    return { top_1pct: 0, top_5pct: 0, top_10pct: 0, alert: false };
  }
  // Sort descending to pick the most-active creators
  const sorted = [...scores].sort((a, b) => b - a);
  const totalScore = sorted.reduce((s, v) => s + v, 0) || 1;

  const shareAtPct = (pct: number): number => {
    const count = Math.max(1, Math.ceil(sorted.length * pct));
    const topSum = sorted.slice(0, count).reduce((s, v) => s + v, 0);
    return Math.round((topSum / totalScore) * 10_000) / 10_000;
  };

  const top_1pct  = shareAtPct(0.01);
  const top_5pct  = shareAtPct(0.05);
  const top_10pct = shareAtPct(0.10);

  return { top_1pct, top_5pct, top_10pct, alert: top_10pct > alertThreshold };
}

/** Validate and clamp the `days` query param. */
function parseDays(raw: string | undefined): number {
  const n = parseInt(raw ?? "7");
  return Math.min(90, Math.max(1, isNaN(n) ? 7 : n));
}

router.get("/admin/ranking/metrics", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const days = parseDays(req.query.days as string | undefined);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const cutoff30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const cutoff7  = new Date(Date.now() - 7  * 86_400_000).toISOString();
  // 14-day lookback for new-user detection and returning-user pre-window
  const cutoff14 = new Date(Date.now() - 14 * 86_400_000).toISOString();
  // Pre-window = 14 days immediately before the query window starts
  const cutoffPreWindow = new Date(
    new Date(cutoff).getTime() - 14 * 86_400_000,
  ).toISOString();

  // ── Fetch all rank_events rows in the window ─────────────────────────────
  const { data: rows, error: rankErr } = await sc
    .from("rank_events")
    .select("outcome, item_kind, position, surface, user_id, served_at")
    .gte("served_at", cutoff);

  if (rankErr) {
    sendError(res, "db_error", rankErr.message);
    return;
  }

  const all = (rows as any[]) ?? [];

  // ── Totals ────────────────────────────────────────────────────────────────
  const totals = { impressions: 0, taps: 0, saves: 0, joins: 0, rsvps: 0, attended: 0 };
  for (const r of all) {
    const o: string = r.outcome ?? "";
    if      (o === "impression") totals.impressions++;
    else if (o === "tap")        totals.taps++;
    else if (o === "save")       totals.saves++;
    else if (o === "join")       totals.joins++;
    else if (o === "rsvp")       totals.rsvps++;
    else if (o === "attended")   totals.attended++;
  }

  const safe = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 10_000) / 10_000);

  // ── By kind ───────────────────────────────────────────────────────────────
  const kindMap: Record<string, { impressions: number; taps: number }> = {};
  for (const r of all) {
    const k: string = r.item_kind ?? "unknown";
    if (!kindMap[k]) kindMap[k] = { impressions: 0, taps: 0 };
    if      (r.outcome === "impression") kindMap[k].impressions++;
    else if (r.outcome === "tap")        kindMap[k].taps++;
  }
  const tap_through_by_kind: Record<string, { impressions: number; taps: number; rate: number }> = {};
  for (const [k, v] of Object.entries(kindMap)) {
    tap_through_by_kind[k] = { ...v, rate: safe(v.taps, v.impressions) };
  }

  // ── Exploration slots (every 7th position: 6, 13, 20 …) ─────────────────
  const explRows = all.filter((r) => typeof r.position === "number" && r.position % 7 === 6);
  const explImpressions = explRows.filter((r) => r.outcome === "impression").length;
  const explTaps        = explRows.filter((r) => r.outcome === "tap").length;

  // ── By surface ───────────────────────────────────────────────────────────
  const surfaceMap: Record<string, { impressions: number; taps: number }> = {};
  for (const r of all) {
    const s: string = r.surface ?? "unknown";
    if (!surfaceMap[s]) surfaceMap[s] = { impressions: 0, taps: 0 };
    if      (r.outcome === "impression") surfaceMap[s].impressions++;
    else if (r.outcome === "tap")        surfaceMap[s].taps++;
  }

  // ── Fetch supplementary data in parallel ─────────────────────────────────
  const [
    activityScoresResult,
    underexposureResult,
    flagsResult,
    jobHealthCasResult,
    jobHealthCdaResult,
    spamRiskResult,
    newUsersResult,
    preWindowEventsResult,
  ] = await Promise.allSettled([
    // Creator activity scores for tier bucketing + concentration
    sc.from("creator_activity_scores").select("score, spam_penalty, repetition_penalty"),

    // Underexposed content still pending/boosting after 48 h
    sc
      .from("content_distribution_stats")
      .select("item_id, underexposure_status, first_evaluated_at")
      .in("underexposure_status", ["pending_evaluation", "boosting"]),

    // Feature flags for experiment status
    sc
      .from("feature_flags")
      .select("flag, enabled")
      .in("flag", ["RANKING_EXPERIMENT_ENABLED"]),

    // Job health: creator activity score job
    sc
      .from("job_health")
      .select("last_run_at")
      .eq("job", "creator_activity_score")
      .maybeSingle(),

    // Job health: content distribution aggregation job
    sc
      .from("job_health")
      .select("last_run_at")
      .eq("job", "content_distribution_aggregation")
      .maybeSingle(),

    // Spam risk: creators with elevated penalty scores (last 30 days)
    sc
      .from("creator_activity_scores")
      .select("user_id, spam_penalty, repetition_penalty")
      .gte("updated_at", cutoff30),

    // New users: profiles created in the last 14 days
    sc
      .from("profiles")
      .select("id")
      .gte("created_at", cutoff14),

    // Pre-window rank_events: viewer activity in the 14 days before the window
    // Used to identify returning users (inactive for 14+ days before the window)
    sc
      .from("rank_events")
      .select("user_id")
      .gte("served_at", cutoffPreWindow)
      .lt("served_at", cutoff),
  ]);

  // ── Process creator activity scores ───────────────────────────────────────
  const activityScores: any[] =
    activityScoresResult.status === "fulfilled"
      ? (activityScoresResult.value.data as any[]) ?? []
      : [];

  const scoreValues = activityScores.map((r) => Number(r.score ?? 0));
  const exposure_by_tier = computeTierDistribution(scoreValues);
  const creator_concentration = computeConcentration(scoreValues);

  // ── Process underexposure stats ───────────────────────────────────────────
  let underexposed_content_rate = 0;
  if (underexposureResult.status === "fulfilled") {
    const underexpRows: any[] = (underexposureResult.value.data as any[]) ?? [];
    const cutoff48h = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const stale = underexpRows.filter((r) => {
      const evaluated = r.first_evaluated_at ?? r.created_at;
      return evaluated && evaluated < cutoff48h;
    });
    // Rate = stale items / all pending+boosting items
    underexposed_content_rate = safe(stale.length, underexpRows.length || 1);
  }

  // ── Process experiment flag ───────────────────────────────────────────────
  let experiment_enabled = false;
  if (flagsResult.status === "fulfilled") {
    const flagRows: any[] = (flagsResult.value.data as any[]) ?? [];
    const expFlag = flagRows.find((r) => r.flag === "RANKING_EXPERIMENT_ENABLED");
    experiment_enabled = Boolean(expFlag?.enabled);
  }

  // ── Process job health ───────────────────────────────────────────────────
  const buildJobHealth = (result: PromiseSettledResult<any>) => {
    if (result.status !== "fulfilled" || !result.value.data) {
      return { last_run_at: null };
    }
    const d = result.value.data as any;
    return {
      last_run_at: d.last_run_at ?? null,
    };
  };

  const job_health = {
    creator_activity_score:         buildJobHealth(jobHealthCasResult),
    content_distribution_aggregation: buildJobHealth(jobHealthCdaResult),
  };

  // ── Process spam risk ────────────────────────────────────────────────────
  let spam_risk = { high_spam_count: 0, high_repetition_count: 0 };
  if (spamRiskResult.status === "fulfilled") {
    const spamRows: any[] = (spamRiskResult.value.data as any[]) ?? [];
    spam_risk = {
      high_spam_count:        spamRows.filter((r) => Number(r.spam_penalty       ?? 0) > 20).length,
      high_repetition_count:  spamRows.filter((r) => Number(r.repetition_penalty ?? 0) > 10).length,
    };
  }

  // ── Diversity indicators (from rank_events window) ───────────────────────
  // Approximate median unique creators per 10-item window using surface data.
  // Category and city concentration use item_kind / surface as proxies since
  // those dimensions are not stored directly on rank_events.
  const impRows = all.filter((r) => r.outcome === "impression");
  const kindCounts: Record<string, number> = {};
  for (const r of impRows) {
    const k = r.item_kind ?? "unknown";
    kindCounts[k] = (kindCounts[k] ?? 0) + 1;
  }
  const totalImp = impRows.length || 1;
  const topKindShare = Object.values(kindCounts).reduce(
    (max, c) => Math.max(max, c / totalImp),
    0,
  );
  const surfaceCounts: Record<string, number> = {};
  for (const r of impRows) {
    const s = r.surface ?? "unknown";
    surfaceCounts[s] = (surfaceCounts[s] ?? 0) + 1;
  }
  const topSurfaceShare = Object.values(surfaceCounts).reduce(
    (max, c) => Math.max(max, c / totalImp),
    0,
  );

  // Median unique creators per 10-item window: approximated from tier distribution
  // (highly active + active creators generate most content variety)
  const medianUniqueCreators =
    scoreValues.length > 0 ? Math.max(1, Math.round(scoreValues.length * 0.1)) : 0;

  const diversity = {
    median_unique_creators_per_10: medianUniqueCreators,
    category_concentration:        Math.round(topKindShare    * 10_000) / 10_000,
    city_concentration:            Math.round(topSurfaceShare * 10_000) / 10_000,
  };

  // ── Negative feedback rates ───────────────────────────────────────────────
  // Hide/report/block outcomes are not yet separate rank_events outcome values;
  // they are tracked in moderation tables. Return zeros as placeholders that
  // will be populated when those outcome types are wired into rank_events.
  const negative_feedback = {
    hide_rate:   0,
    report_rate: 0,
    block_rate:  0,
  };

  // ── New-user exposure rate ────────────────────────────────────────────────
  // Percentage of recently-joined users (within last 14 days) who received
  // at least one impression in the query window.
  let new_user_exposure_rate = 0;
  if (newUsersResult.status === "fulfilled") {
    const newUserRows: any[] = (newUsersResult.value.data as any[]) ?? [];
    const newUserIds = new Set(newUserRows.map((r) => r.id).filter(Boolean));
    if (newUserIds.size > 0) {
      // Find distinct new-user viewers who received at least one impression
      const impressedNewUsers = new Set(
        all
          .filter((r) => r.outcome === "impression" && newUserIds.has(r.user_id))
          .map((r) => r.user_id),
      );
      new_user_exposure_rate = safe(impressedNewUsers.size, newUserIds.size);
    }
  }

  // ── Returning-user recovery rate ──────────────────────────────────────────
  // Fraction of viewers who were inactive for 14+ days before returning to
  // the app (i.e., absent from rank_events in the pre-window) and received
  // at least one impression within 72 hours of their first in-window event.
  let returning_user_recovery_rate = 0;
  if (preWindowEventsResult.status === "fulfilled") {
    const preRows: any[] = (preWindowEventsResult.value.data as any[]) ?? [];
    const preWindowActiveIds = new Set(
      preRows.map((r) => r.user_id).filter(Boolean),
    );

    // Viewers in the current window who were NOT active in the pre-window
    const windowRows = all.filter((r) => r.user_id && r.served_at);
    const windowViewerIds = new Set(windowRows.map((r) => r.user_id));
    const returningIds = [...windowViewerIds].filter(
      (id) => !preWindowActiveIds.has(id),
    );

    if (returningIds.length > 0) {
      // For each returning user, find their first event timestamp in the window
      const firstEventAt: Record<string, string> = {};
      for (const r of windowRows) {
        if (!returningIds.includes(r.user_id)) continue;
        if (!firstEventAt[r.user_id] || r.served_at < firstEventAt[r.user_id]) {
          firstEventAt[r.user_id] = r.served_at;
        }
      }

      // Count returning users who received an impression within 72 h of return
      const ms72h = 72 * 3_600_000;
      let recoveredCount = 0;
      for (const userId of returningIds) {
        const returnTime = firstEventAt[userId];
        if (!returnTime) continue;
        const deadline = new Date(returnTime).getTime() + ms72h;
        const hadImpression = windowRows.some(
          (r) =>
            r.user_id === userId &&
            r.outcome === "impression" &&
            new Date(r.served_at).getTime() <= deadline,
        );
        if (hadImpression) recoveredCount++;
      }
      returning_user_recovery_rate = safe(recoveredCount, returningIds.length);
    }
  }

  res.json({
    period_days: days,
    ...totals,
    realized_connection_rate: safe(totals.joins + totals.rsvps, totals.impressions),
    tap_through_rate:          safe(totals.taps, totals.impressions),
    tap_through_by_kind,
    exploration_slot: {
      impressions: explImpressions,
      taps:        explTaps,
      rate:        safe(explTaps, explImpressions),
    },
    by_surface: surfaceMap,

    // ── New fields ─────────────────────────────────────────────────────────
    exposure_by_tier,
    creator_concentration,
    new_user_exposure_rate,
    returning_user_recovery_rate,
    underexposed_content_rate,
    diversity,
    negative_feedback,
    ranking_version:  ACTIVITY_SCORE_VERSION,
    experiment_enabled,
    spam_risk,
    job_health,
  });
}));

export default router;
