/**
 * GET /api/admin/layover/metrics — spec §20's layover metrics, computed from
 * what is PERSISTED, for an admin (census-layover L210, L211, L213, L215).
 *
 * `computeLayoverMetrics` (services/airport/layoverObservability.ts) has carried
 * the definitions since §20 was first scored and had NO caller: there is no
 * metrics exporter in this repository, so the numbers went nowhere. This is the
 * caller. It reads two persisted sources over a window and hands them over:
 *
 *   layover_events                    0127, on every database. Counters.
 *   layover_certified_computations    2700, written by `persistDecision` only
 *                                     while `layover_decision_persistence_enabled`
 *                                     is ON. The four rates read it.
 *
 * ── WHAT IS NEVER REPORTED ──────────────────────────────────────────────────
 *   - A rate over no decisions. `computeLayoverMetrics` answers UNPRODUCIBLE
 *     with the reason, and with persistence OFF the decisions are not read at
 *     all — `decisions.state: "persistence_off"` says so.
 *   - A read failure as an empty window. Either source failing is a 503.
 *   - A truncated window as a complete one: `truncated` is on both sources.
 * L216 `recommendation_contract_violation` folds the window's recommendation_generated
 * tallies; L217 `decision_replay_mismatch` replays the window's STORED rows (ON only).
 * `replan_rate` / `safe_return_completion_rate` stay UNPRODUCIBLE, as before. (Below.)
 *
 * `staleFallbackSinceStart` (census L215) is the fallback ladder's own emission
 * — the firings this PROCESS has seen since it started, by rung, site and
 * reason (`AirportProfileService.staleFallbackCounters`). It is not windowed and
 * not a rate; it is the counter the ladder now emits when it fires.
 *
 * Aggregates only: no session id, user id or row leaves this route.
 */
import { Router } from "express";
import { sendError } from "../lib/http.js"; import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdmin } from "../lib/requireAdmin.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { computeLayoverMetrics, type LayoverEventRow } from "../services/airport/layoverObservability.js"; import { recommendationContractWindow, recommendationContractCounters } from "../services/airport/layoverContractMonitor.js"; import { replayStoredComputations, type ReplaySummary } from "../services/airport/layoverReplay.js";
import { decisionsInWindow, storedComputationsInWindow } from "../services/layover/LayoverDecisionStore.js";
import { staleFallbackCounters } from "../services/airport/AirportProfileService.js";

const router = Router();

/** The most event rows one read folds. */
export const EVENT_WINDOW_LIMIT = 50_000;
export const METRICS_MAX_DAYS = 90;
export const METRICS_DEFAULT_DAYS = 7;

/** `?days=` as an integer in 1..90; anything else is the default. */
export function metricsWindowDays(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= METRICS_MAX_DAYS ? n : METRICS_DEFAULT_DAYS;
}

router.get("/admin/layover/metrics", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const nowMs = Date.now();
  const days = metricsWindowDays(req.query?.days);
  const toIso = new Date(nowMs).toISOString();
  const fromIso = new Date(nowMs - days * 24 * 3_600_000).toISOString();

  const ev = await sc
    .from("layover_events")
    .select("session_id, event_type, created_at")
    .gte("created_at", fromIso)
    .lt("created_at", toIso)
    .order("created_at", { ascending: false })
    .limit(EVENT_WINDOW_LIMIT + 1);
  if (ev.error) {
    sendError(res, "degraded_unavailable", "layover_events could not be read, so no metric is reported.");
    return;
  }
  const evRows = (ev.data ?? []) as Array<{ session_id: string; event_type: string; created_at: string }>;
  const eventsTruncated = evRows.length > EVENT_WINDOW_LIMIT;
  const events: LayoverEventRow[] = evRows.slice(0, EVENT_WINDOW_LIMIT).map((r) => ({
    sessionId: String(r.session_id), eventType: String(r.event_type), at: String(r.created_at),
  }));

  // ── census L216: every generation's contract tally, from its audit event ──
  // `layover_events` is 0127's, written on every database, so this half runs on
  // production. Its own read and its own bound: a generation event carries the
  // whole audit metadata, which the counters above never need.
  const gen = await sc
    .from("layover_events")
    .select("created_at, metadata")
    .eq("event_type", "recommendation_generated")
    .gte("created_at", fromIso)
    .lt("created_at", toIso)
    .order("created_at", { ascending: false })
    .limit(CONTRACT_EVENT_LIMIT + 1);
  if (gen.error) {
    sendError(res, "degraded_unavailable", "layover_events could not be read, so no metric is reported.");
    return;
  }
  const genRows = (gen.data ?? []) as Array<{ metadata: unknown }>;
  const contract = recommendationContractWindow(
    genRows.slice(0, CONTRACT_EVENT_LIMIT).map((r) => r.metadata),
    genRows.length > CONTRACT_EVENT_LIMIT,
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
      sendError(res, "degraded_unavailable", "layover_certified_computations could not be read, so no metric is reported.");
      return;
    }
    decisionsState = "read";
    decisions = read.value.records;
    decisionsTruncated = read.value.truncated;
    // The rows AS WRITTEN, replayed against their own inputs. `decisions` above
    // cannot be the replay's input: `decisionsInWindow` rebuilds each record BY
    // replaying it, so it would compare a recomputation with a recomputation.
    const stored = await storedComputationsInWindow(sc, fromIso, toIso);
    if (!stored.ok) {
      sendError(res, "degraded_unavailable", "layover_certified_computations could not be read, so no metric is reported.");
      return;
    }
    replay = replayStoredComputations(stored.value.rows);
    replayTruncated = stored.value.truncated;
  }

  res.json({
    ok: true,
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
    metrics: computeLayoverMetrics({ events, decisions, replay, contract }),
    // census L216 — which checks the window's violations broke, by card. Counts only.
    recommendationContract: { checked: contract.checked, violating: contract.violating, byCheck: contract.byCheck },
    // census L217 — the replay pass, as aggregates: no session id, no snapshot id.
    replay: replay === null ? null : replayAggregate(replay),
    staleFallbackSinceStart: staleFallbackCounters(),
    // census L216 — the monitor's own in-process counter (this process, since it started).
    recommendationContractSinceStart: recommendationContractCounters(),
  });
}));

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

export default router;
