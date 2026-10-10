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
 * `replan_rate`, `safe_return_completion_rate`,
 * `recommendation_contract_violation` and `decision_replay_mismatch` stay
 * UNPRODUCIBLE here with their own reasons; this route does not change that.
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
import { computeLayoverMetrics, type LayoverEventRow } from "../services/airport/layoverObservability.js";
import { decisionsInWindow } from "../services/layover/LayoverDecisionStore.js";
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

  const persistenceOn = await isFlagEnabled(sc, "layover_decision_persistence_enabled");
  let decisionsState: "read" | "persistence_off" = "persistence_off";
  let decisionsTruncated = false;
  let decisions: Parameters<typeof computeLayoverMetrics>[0]["decisions"] = [];
  if (persistenceOn) {
    const read = await decisionsInWindow(sc, fromIso, toIso);
    if (!read.ok) {
      sendError(res, "degraded_unavailable", "layover_certified_computations could not be read, so no metric is reported.");
      return;
    }
    decisionsState = "read";
    decisions = read.value.records;
    decisionsTruncated = read.value.truncated;
  }

  res.json({
    ok: true,
    window: { from: fromIso, to: toIso, days },
    sources: {
      events: { rows: events.length, truncated: eventsTruncated },
      decisions: { state: decisionsState, rows: decisions.length, truncated: decisionsTruncated },
    },
    metrics: computeLayoverMetrics({ events, decisions, replay: null }),
    staleFallbackSinceStart: staleFallbackCounters(),
  });
}));

export default router;
