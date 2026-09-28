/**
 * discoveryStopMeasurements — the database half of `12`'s stop conditions.
 *
 * census-discovery DV-82 / §54. lib/discoveryStopConditions.ts judges seven
 * conditions; three are measured in-process on the serve path. The other four
 * live in the database, and this module reads them in ONE round trip through
 * `public.discovery_stop_measurements(since, until)` (migration 3391) and hands
 * each to `recordStopMeasurement`:
 *
 *   creator_concentration     Herfindahl index of Discovery exposures across
 *                             creators — the discovery_places.submitted_by join
 *                             the shadow writer already does, over what was
 *                             SERVED. Coverage travels with it.
 *   reports_hides             (dismisses + place reports + Trail reports) per
 *                             exposure in the window.
 *   rls_leak                  deviations of the live catalogue from 3390's
 *                             declared posture.
 *   attribution_double_count  live attributions crediting one beneficiary twice
 *                             for one value event.
 *
 * IT DECIDES NOTHING. No threshold lives here; the evaluator reports each of the
 * four as `unruled` until the owner rules one (§54).
 *
 * WHEN IT RUNS
 * ============
 * `refreshDiscoveryStopMeasurements(sc)` is meant to be called — NOT awaited —
 * from the engine-mode resolver's uncached path, which runs at most every 30 s
 * per instance and only while DISCOVERY_ENGINE_MODE is non-legacy. The call is
 * a hunk routed by §54 (lib/discoveryEngineMode.ts is another lane's file);
 * until it lands these four read `no_evidence`, and
 * STOP_CONDITION_PRODUCERS says so (`hookPending: true`).
 *
 * FAILURE IS A READING, NEVER A ZERO
 * ==================================
 * A rejected call, a missing function (3391 unapplied) or a malformed body
 * records all four as `unreadable`. The evaluator reports `unreadable`, which is
 * not `clear`: "the read failed" and "nothing happened" must stay different
 * facts, exactly as in lib/discoveryShadow's creator axis.
 */
import {
  recordStopMeasurement, refreshStopEnforcement,  // §82: the arming read rides this refresh
  DATABASE_MEASURED,
  STOP_WINDOW_MS,
  type DatabaseMeasuredCondition,
  type StopMeasurement,
} from "./discoveryStopConditions.js";
import { logger } from "./logger.js";

/** The 3391 function this module reads. */
export const STOP_MEASUREMENTS_RPC = "discovery_stop_measurements";

export type StopMeasurementSet = Record<DatabaseMeasuredCondition, StopMeasurement>;

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}
function isShareOrNull(v: unknown): v is number | null {
  return v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 + 1e-9);
}

/** Every condition unreadable, for one reason. */
export function unreadableMeasurements(atMs: number, reason: string, code?: string): StopMeasurementSet {
  const out = {} as StopMeasurementSet;
  for (const c of DATABASE_MEASURED) {
    out[c] = { state: "unreadable", value: null, sample: 0, at: atMs, detail: code ? { reason, code } : { reason } };
  }
  return out;
}

/**
 * Parse 3391's body into the four measurements. Pure; never throws. A part that
 * is missing or malformed is `unreadable` ON ITS OWN — one bad field does not
 * blank the other three, and none of them is ever defaulted to 0.
 */
export function parseStopMeasurements(raw: unknown, atMs: number): StopMeasurementSet {
  const out = unreadableMeasurements(atMs, "malformed_response");
  const body = raw && typeof raw === "object" ? (raw as Record<string, any>) : null;
  if (!body) return out;

  const rh = body["reports_hides"];
  if (rh?.state === "measured" && isCount(rh.exposures) && isCount(rh.hides) && isCount(rh.place_reports)
      && (rh.trail_reports === null || isCount(rh.trail_reports))) {
    const reports = rh.place_reports + (rh.trail_reports ?? 0);
    out.reports_hides = {
      state: "measured",
      value: rh.exposures > 0 ? (rh.hides + reports) / rh.exposures : null,
      sample: rh.exposures,
      at: atMs,
      detail: {
        exposures: rh.exposures, hides: rh.hides, placeReports: rh.place_reports,
        trailReports: rh.trail_reports,
        hideRate: rh.exposures > 0 ? rh.hides / rh.exposures : null,
        reportRate: rh.exposures > 0 ? reports / rh.exposures : null,
      },
    };
  }

  const cc = body["creator_concentration"];
  if (cc?.state === "measured" && isCount(cc.exposures) && isCount(cc.resolved) && isCount(cc.creators)
      && isShareOrNull(cc.hhi) && isShareOrNull(cc.top_creator_share)
      && ((cc.resolved === 0) === (cc.hhi === null))) {
    out.creator_concentration = {
      state: "measured",
      // Nothing resolved is NOT concentration 0: there is no distribution.
      value: cc.resolved > 0 ? cc.hhi : null,
      sample: cc.resolved,
      at: atMs,
      detail: {
        exposures: cc.exposures, resolved: cc.resolved, creators: cc.creators,
        coverage: cc.exposures > 0 ? cc.resolved / cc.exposures : null,
        topCreatorShare: cc.top_creator_share,
      },
    };
  }

  const ad = body["attribution_double_count"];
  if (ad?.state === "input_absent") {
    out.attribution_double_count = { state: "input_absent", value: null, sample: 0, at: atMs, detail: { reason: "creator_attributions_absent" } };
  } else if (ad?.state === "measured" && isCount(ad.duplicate_groups) && isCount(ad.extra_rows) && isCount(ad.attributions_in_window)) {
    out.attribution_double_count = {
      state: "measured",
      value: ad.duplicate_groups,
      sample: ad.attributions_in_window,
      at: atMs,
      detail: { duplicateGroups: ad.duplicate_groups, extraRows: ad.extra_rows, attributionsInWindow: ad.attributions_in_window },
    };
  }

  const rl = body["rls_leak"];
  if (rl?.state === "measured" && isCount(rl.deviations) && Array.isArray(rl.detail)) {
    out.rls_leak = {
      state: "measured",
      value: rl.deviations,
      sample: 1,             // one catalogue read
      at: atMs,
      detail: { deviations: rl.detail.filter((d: unknown) => typeof d === "string") },
    };
  }
  return out;
}

/**
 * Read the four measurements for [since, until). Never throws; failures come
 * back as `unreadable` readings.
 */
export async function measureDiscoveryStopInputs(
  sc: any, sinceMs: number, untilMs: number, atMs: number = untilMs,
): Promise<StopMeasurementSet> {
  if (!sc || typeof sc.rpc !== "function") return unreadableMeasurements(atMs, "no_client");
  try {
    // Literal at the call site (the static checkers read call sites, not
    // constants); STOP_MEASUREMENTS_RPC names the same function for callers.
    const { data, error } = await sc.rpc("discovery_stop_measurements", {
      p_since: new Date(sinceMs).toISOString(),
      p_until: new Date(untilMs).toISOString(),
    });
    if (error) {
      const code = typeof error?.code === "string" ? error.code : undefined;
      // 42883 from PostgreSQL, PGRST202 from PostgREST: the function is not
      // there — 3391 is unapplied on this database. Said, not hidden.
      const reason = code === "42883" || code === "PGRST202" ? "function_absent" : "rpc_error";
      logger.warn({ code, reason }, "discoveryStopMeasurements: measurement read failed — four stop conditions read UNREADABLE, not clear");
      return unreadableMeasurements(atMs, reason, code);
    }
    return parseStopMeasurements(data, atMs);
  } catch (err) {
    logger.warn({ err }, "discoveryStopMeasurements: measurement read threw — four stop conditions read UNREADABLE, not clear");
    return unreadableMeasurements(atMs, "threw");
  }
}

let _inFlight: Promise<void> | null = null;

/**
 * Measure the last STOP_WINDOW_MS and record all four. Single-flight per
 * process: a call while one is running returns that one. Never throws.
 */
export function refreshDiscoveryStopMeasurements(sc: any, nowMs: number = Date.now()): Promise<void> {
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    try {
      const [set] = await Promise.all([measureDiscoveryStopInputs(sc, nowMs - STOP_WINDOW_MS, nowMs, nowMs), refreshStopEnforcement(sc)]);  // §82 (W10-O): read the arming flag (3470) beside the measurement
      for (const c of DATABASE_MEASURED) recordStopMeasurement(c, set[c]);
    } catch (err) {
      logger.warn({ err }, "discoveryStopMeasurements: refresh threw");
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}
