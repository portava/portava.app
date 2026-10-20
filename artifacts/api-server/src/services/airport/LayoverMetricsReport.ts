/** Shared collector for the authenticated admin report and scheduled monitoring.
 * Exact counts protect every window; all data leaving here is aggregated. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { readSafeReturnMetricWindow } from './LayoverMetricsReturns.js';
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { computeLayoverMetrics, type LayoverEventRow } from "./layoverObservability.js"; import { recommendationContractWindow, recommendationContractCounters } from "./layoverContractMonitor.js"; import { replayStoredComputations, type ReplaySummary } from "./layoverReplay.js";
import { countedLayoverWindow, decisionsInWindow, storedComputationsInWindow } from "../layover/LayoverDecisionStore.js";
import { staleFallbackCounters } from "./AirportProfileService.js"; import { layoverRankingWindow, layoverRankingCounters } from "./layoverRankingMode.js"; import { LAYOVER_LIVE_FLAGS_WITHOUT_SHADOW, LAYOVER_SHADOW_ARMS, resolveLayoverRolloutMode } from "../../lib/layoverRolloutMode.js"; import { describeCohort } from "../../lib/discoveryCohort.js"; // census L78/L242 — on one line, so every line cited below holds


/** The most event rows one read folds. */
export const EVENT_WINDOW_LIMIT = 50_000;
export const METRICS_MAX_DAYS = 90;
export const METRICS_DEFAULT_DAYS = 7;
const EVENT_COLUMNS = "session_id, event_type, created_at, metadata";
const GENERATION_COLUMNS = "created_at, metadata";

/** `?days=` as an integer in 1..90; anything else is the default. */
export function metricsWindowDays(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= METRICS_MAX_DAYS ? n : METRICS_DEFAULT_DAYS;
}

export async function readLayoverMetricsReport(sc: SupabaseClient, options: { nowMs?: number; days?: number } = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const days = metricsWindowDays(options.days);
  const toIso = new Date(nowMs).toISOString();
  const fromIso = new Date(nowMs - days * 24 * 3_600_000).toISOString();

  const ev = await sc
    .from("layover_events")
    .select(EVENT_COLUMNS, { count: "exact" })
    .gte("created_at", fromIso)
    .lt("created_at", toIso)
    .order("created_at", { ascending: false })
    .limit(EVENT_WINDOW_LIMIT + 1);
  const eventWindow = countedLayoverWindow(ev, EVENT_COLUMNS, EVENT_WINDOW_LIMIT);
  if (!eventWindow) {
    return { ok:false as const, message:"layover_events could not be read, so no metric is reported." };
  }
  const eventsTruncated = eventWindow.truncated;
  const events: LayoverEventRow[] = eventWindow.rows.map((r) => ({
    sessionId: String(r.session_id), eventType: String(r.event_type), at: String(r.created_at), metadata: r.metadata,
  }));

  // ── census L216: every generation's contract tally, from its audit event ──
  // `layover_events` is 0127's, written on every database, so this half runs on
  // production. Its own read and its own bound: a generation event carries the
  // whole audit metadata, which the counters above never need.
  const gen = await sc
    .from("layover_events")
    .select(GENERATION_COLUMNS, { count: "exact" })
    .eq("event_type", "recommendation_generated")
    .gte("created_at", fromIso)
    .lt("created_at", toIso)
    .order("created_at", { ascending: false })
    .limit(CONTRACT_EVENT_LIMIT + 1);
  const generationWindow = countedLayoverWindow(gen, GENERATION_COLUMNS, CONTRACT_EVENT_LIMIT);
  if (!generationWindow || generationWindow.rows.some((row) => row.metadata === null
    || typeof row.metadata !== "object" || Array.isArray(row.metadata))) {
    return { ok:false as const, message:"layover_events could not be read, so no metric is reported." };
  }
  const genRows = generationWindow.rows;
  const contract = recommendationContractWindow(
    genRows.map((r) => r.metadata),
    generationWindow.truncated,
  );

  const persistenceOn = await isFlagEnabled(sc, "layover_decision_persistence_enabled");
  let decisionsState: "read" | "persistence_off" = "persistence_off";
  let decisionsTruncated = false;
  let decisions: Parameters<typeof computeLayoverMetrics>[0]["decisions"] = [];
  // census L217: null = no replay pass ran (persistence OFF), never an empty pass.
  let replay: ReplaySummary | null = null;
  let replayTruncated = false;
  if (persistenceOn) {
    const read = await decisionsInWindow(sc, fromIso, toIso);
    if (!read.ok) {
      return { ok:false as const, message:"layover_certified_computations could not be read, so no metric is reported." };
    }
    decisionsState = "read";
    decisions = read.value.records;
    decisionsTruncated = read.value.truncated;
    // The rows AS WRITTEN, replayed against their own inputs. `decisions` above
    // cannot be the replay's input: `decisionsInWindow` rebuilds each record BY
    // replaying it, so it would compare a recomputation with a recomputation.
    const stored = await storedComputationsInWindow(sc, fromIso, toIso);
    if (!stored.ok) {
      return { ok:false as const, message:"layover_certified_computations could not be read, so no metric is reported." };
    }
    replay = replayStoredComputations(stored.value.rows);
    replayTruncated = stored.value.truncated;
  }

  // ── census L78 / L242: the layover rollout mode, and the objective's divergence ──
  // The same generation events as L216, already read and bounded above: no new
  // read of `layover_events`. A generation with no `ranking` key ran legacy.
  // Counts only — no session id, user id, card or order leaves this route.
  const ranking = layoverRankingWindow(
    genRows.map((r) => r.metadata),
    generationWindow.truncated,
  );
  const rankingMode = await resolveLayoverRolloutMode(sc, "ranking_objective");

  const safeReturns = persistenceOn
    ? await readSafeReturnMetricWindow(sc, events, eventsTruncated, fromIso, toIso)
    : { available:false as const, reason:'layover_decision_persistence_enabled is OFF; layover_outcomes (2992) measurements are unavailable.' };
  const metrics = computeLayoverMetrics({ events, decisions, replay, contract, replans:{rows:events,truncated:eventsTruncated}, safeReturns });
  // A bounded/truncated sample is not the requested window. Expose the reason,
  // but never export its partial value as if the window were complete.
  for (const metric of metrics) {
    const incomplete = metric.name === 'layover_sessions_detected' ? eventsTruncated
      : ['layover_sessions_evaluated','critical_unknown_rate','landside_eligible_rate','return_warning_rate','stale_fallback_rate'].includes(metric.name) ? decisionsTruncated
      : metric.name === 'decision_replay_mismatch' ? replayTruncated
      : metric.name === 'recommendation_contract_violation' ? generationWindow.truncated : false;
    if (incomplete) { metric.status='UNPRODUCIBLE'; metric.value=null; metric.blockedBy='layover metrics source window is truncated; a partial value is not a complete measurement.'; }
  }
  return {
    ok: true as const,
    window: { from: fromIso, to: toIso, days },
    sources: {
      events: { rows: events.length, truncated: eventsTruncated },
      decisions: { state: decisionsState, rows: decisions.length, truncated: decisionsTruncated },
      recommendationGenerations: {
        rows: contract.generations, checked: contract.checkedGenerations, unchecked: contract.unchecked,
        malformed: contract.malformed, truncated: contract.truncated,
      },
      replay: { state: replay === null ? "persistence_off" : "replayed", rows: replay?.read ?? 0, truncated: replayTruncated },
    },
    metrics,
    operationalSources: { safeReturns: safeReturns.available ? { state:"read", started:safeReturns.started.length, outcomes:safeReturns.outcomes.length, truncated:safeReturns.truncated } : { state:"unavailable", reason:safeReturns.reason } },
    // census L216 — which checks the window's violations broke, by card. Counts only.
    recommendationContract: { checked: contract.checked, violating: contract.violating, byCheck: contract.byCheck },
    // census L217 — the replay pass, as aggregates: no session id, no snapshot id.
    replay: replay === null ? null : replayAggregate(replay),
    staleFallbackSinceStart: staleFallbackCounters(),
    // census L216 — the monitor's own in-process counter (this process, since it started).
    recommendationContractSinceStart: recommendationContractCounters(),
    // census L242 — the rollout mechanism, and L78's objective under it.
    layoverRollout: {
      // Which layover capabilities can be run beside the live path, and which
      // live flags cannot (owner question OQ-7: those stay untouched).
      shadowArms: Object.entries(LAYOVER_SHADOW_ARMS).map(([capability, a]) => ({ capability, flag: a.flag, mechanism: a.mechanism, shadowLog: a.shadowLog })),
      liveWithoutShadow: [...LAYOVER_LIVE_FLAGS_WITHOUT_SHADOW],
      ranking: {
        flag: LAYOVER_SHADOW_ARMS.ranking_objective.flag,
        mode: rankingMode.mode,
        reason: rankingMode.reason,
        cohort: rankingMode.mode === "legacy" ? null : describeCohort(rankingMode.cohort),
        // The window: how many generations ran each mode, and how often the
        // objective's order differed from the legacy one.
        window: ranking,
        sinceStart: layoverRankingCounters(),
      },
    },
  };
}

/** The most `recommendation_generated` events one read folds. */
export const CONTRACT_EVENT_LIMIT = 5_000;

/** A replay summary with every per-row identifier removed. */
function replayAggregate(r: ReplaySummary) {
  const mismatchedColumns: Record<string, number> = {};
  for (const x of r.results) for (const f of x.mismatchedFields) mismatchedColumns[f] = (mismatchedColumns[f] ?? 0) + 1;
  return {
    read: r.read, replayed: r.replayed, matched: r.matched, mismatched: r.mismatched,
    refused: r.refused, refusalsByReason: r.refusalsByReason, mismatchedColumns,
  };
}

