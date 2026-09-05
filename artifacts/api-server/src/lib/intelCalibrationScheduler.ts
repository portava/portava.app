/**
 * Intelligence Gathering — §21 DAILY calibration / density report scheduler.
 *
 * Spec §21: "Calibration report daily; model/threshold promotion requires human
 * review." This is the scheduler hook: once a day it tallies the capture→serve
 * funnel and runs the §26 density-gate assessment READ-ONLY, then LOGS the
 * verdict. It writes nothing and promotes nothing — promotion stays a human
 * decision (lib/intelLiveScope header). The report is deliberately fail-closed:
 * it can never certify the gate while any input is uninstrumented or an unproven
 * upper bound (assessDensityGate.certifiable), so the daily log is an honest
 * "here is the flow and why it is not certifiable", not a green light.
 *
 * Gated on `intel_calibration_report`, fail-closed, self-rescheduling — the house
 * scheduler shape (see intelCoverageScheduler). Off ⇒ an inert no-op that reads
 * and writes nothing.
 *
 * The arithmetic lives in lib/intelFunnelReport (pure, tested); this keeps only
 * the read I/O and the interval, exactly like reportIntelFunnel.ts does for the
 * on-demand path.
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";
import {
  assessDensityGate,
  tallyIntelFunnel,
  type FunnelRows,
  type ObservationRow,
  type ClaimRow,
  type SnapshotRow,
  type ConfirmationRow,
  type OutcomeRow,
} from "./intelFunnelReport.js";

const CALIBRATION_FLAG = "intel_calibration_report";
const STARTUP_DELAY_MS = 8 * 60 * 1000;    // after the other intel schedulers settle
const INTERVAL_MS = 24 * 60 * 60 * 1000;   // daily
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // a 7-day window (the weekly-observation threshold's unit)
const FETCH_CAP = 200_000;

let _timer: ReturnType<typeof setTimeout> | null = null;

export interface CalibrationPassResult {
  skipped: boolean;
  reason: "disabled" | "no_client" | "error" | null;
  observations: number;
  outcomes: number;
  certifiable: boolean;
  gateFailures: string[];
  uninstrumented: string[];
}

export async function runCalibrationReportPass(opts: { client?: any; now?: Date } = {}): Promise<CalibrationPassResult> {
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  const empty: CalibrationPassResult = {
    skipped: true, reason: null, observations: 0, outcomes: 0, certifiable: false, gateFailures: [], uninstrumented: [],
  };
  if (!db) return { ...empty, reason: "no_client" };
  if (!(await isFlagEnabled(db, CALIBRATION_FLAG))) return { ...empty, reason: "disabled" };

  const now = opts.now ?? new Date();
  const sinceIso = new Date(now.getTime() - WINDOW_MS).toISOString();
  const nowIso = now.toISOString();

  try {
    const [obs, freshObs, claims, snaps, confs, outcomeEvents] = await Promise.all([
      db.from("intel_observations").select("actor_id, subject_id, zone_id, claim_type, moderation_state, observed_at, expires_at, group_key, party_size_bucket").gte("observed_at", sinceIso).limit(FETCH_CAP),
      db.from("intel_observations").select("actor_id, subject_id, zone_id, claim_type, observed_at, expires_at, group_key, moderation_state").or(`expires_at.is.null,expires_at.gt.${nowIso}`).limit(FETCH_CAP),
      db.from("intel_claims").select("subject_id, claim_type, status, observed_at").gte("observed_at", sinceIso).limit(FETCH_CAP),
      db.from("intel_state_snapshots").select("privacy_eligible, confidence_band, expires_at").gte("computed_at", sinceIso).limit(FETCH_CAP),
      db.from("intel_confirmations").select("stance").gte("created_at", sinceIso).limit(FETCH_CAP),
      db.from("canonical_events").select("subject_id, occurred_at, payload").not("payload->intel", "is", null).gte("occurred_at", sinceIso).limit(FETCH_CAP),
    ]);
    for (const r of [obs, freshObs, claims, snaps, confs, outcomeEvents]) {
      if (r.error) { logger.warn({ err: r.error }, "calibration report: read failed"); return { ...empty, reason: "error" }; }
    }

    const outcomes: OutcomeRow[] = ((outcomeEvents.data ?? []) as any[]).map((e) => ({
      subject_id: e.subject_id ?? e.payload?.intel?.subject_id ?? null,
      snapshot_id: e.payload?.intel?.snapshot_id ?? null,
      outcome: e.payload?.intel?.outcome ?? null,
      occurred_at: e.occurred_at ?? null,
    }));

    const rows: FunnelRows = {
      observations: (obs.data ?? []) as ObservationRow[],
      freshObservations: (freshObs.data ?? []) as ObservationRow[],
      claims: (claims.data ?? []) as ClaimRow[],
      snapshots: (snaps.data ?? []) as SnapshotRow[],
      confirmations: (confs.data ?? []) as ConfirmationRow[],
      outcomes,
    };
    const funnel = tallyIntelFunnel(rows, now);
    const assessment = assessDensityGate(funnel, { qualifyingWeeklyObservations: funnel.observations.pilotClaimable });

    logger.info(
      {
        observations: rows.observations.length,
        outcomes: outcomes.length,
        afterProofPairs: funnel.density.afterProofPairs,
        servableLive: funnel.snapshots.servableLive,
        certifiable: assessment.certifiable,
        gateFailures: assessment.gate.failures,
        uninstrumented: assessment.uninstrumented,
      },
      "IG daily calibration/density report",
    );

    return {
      skipped: false, reason: null,
      observations: rows.observations.length,
      outcomes: outcomes.length,
      certifiable: assessment.certifiable,
      gateFailures: assessment.gate.failures,
      uninstrumented: assessment.uninstrumented,
    };
  } catch (err) {
    logger.warn({ err }, "calibration report pass threw");
    return { ...empty, reason: "error" };
  }
}

export function startIntelCalibrationScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: INTERVAL_MS, flag: CALIBRATION_FLAG },
    "IntelCalibrationScheduler scheduled (no-op until the flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void runCalibrationReportPass()
      .catch((err) => logger.warn({ err }, "calibration report pass failed"))
      .finally(() => { _timer = setTimeout(tick, INTERVAL_MS); });
  }, STARTUP_DELAY_MS);
}

export function stopIntelCalibrationScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
