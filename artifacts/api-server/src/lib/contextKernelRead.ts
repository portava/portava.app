/**
 * contextKernelRead — the I/O half of Sensing §6's kernel: it fills
 * lib/contextKernel's nine contexts from the seams that ALREADY exist, and
 * opens none of its own.
 *
 *   live claims        lib/liveClaimRead.readLiveClaimEnvelopes — the ONE read
 *                      path, gated and fail-closed there; `liveLabelsServable`
 *                      decides whether we may look at all, and a closed gate is
 *                      reported as `readable: false`, never as "nothing there".
 *   crowd / forecast   lib/crowdState, lib/forecastState (pure folds over those
 *                      envelopes).
 *   attention          services/notifications/NotificationPreferenceService for
 *                      availability, the `notifications` table for the hour's
 *                      interruption cost — the same two reads the Wall's
 *                      moments route makes, with the same fail-closed rules
 *                      (an unreadable preference is NULL, never "available").
 *
 * Calibration for the forecast is NOT read: the tree's only calibration
 * producer (lib/intelCalibrationScheduler) writes a read-only daily report and
 * attributes nothing per subject, and `intel_attributions` is not in
 * production. So every forecast this reader produces is UNCALIBRATED, which
 * lib/forecastState caps below the Live floor. That is a fact about the
 * deployment, recorded here rather than hidden behind a default accuracy.
 *
 * Reads only. Nothing here writes, and no coordinate leaves this module: the
 * viewer's point, when supplied, produces one ETA scalar per subject and is
 * then dropped (§4.3).
 */
import { isEmergingInfluenceEligible, isLiveConstraintEligible } from "../compass/CompassLiveConstraints.js";
import { buildCrowdState, envelopeTemporal } from "./crowdState.js";
import { buildForecastState, type ForecastRefused, type ForecastState } from "./forecastState.js";
import { truthOfEnvelopes } from "./liveEnvelopeTruth.js";
import { readLiveClaimEnvelopes, type LiveClaimEnvelope } from "./liveClaimRead.js";
import { ATTENTION_BUDGET_PER_WINDOW, ATTENTION_WINDOW_MINUTES } from "./attentionEngine.js";
import { NotificationPreferenceService } from "../services/notifications/NotificationPreferenceService.js";
import type { AttentionContext, SubjectWorldContext } from "./contextKernel.js";

/** Default horizon for the per-subject forecast, in minutes. */
export const DEFAULT_FORECAST_HORIZON_MINUTES = 60;

export interface ReadSubjectWorldOptions {
  now: Date;
  /** Whether the Live gates allow a read at all (lib/liveClaimRead.liveLabelsServable). */
  readable: boolean;
  horizonMinutes?: number;
}

/**
 * One subject's world context: the envelopes, the Crowd state folded from them,
 * and the Forecast extrapolated from that — or the forecast's named refusal.
 */
export async function readSubjectWorld(
  sc: unknown,
  subjectId: string,
  opts: ReadSubjectWorldOptions,
): Promise<SubjectWorldContext> {
  const nowMs = opts.now.getTime();
  const envelopes: readonly LiveClaimEnvelope[] = opts.readable
    ? await readLiveClaimEnvelopes(sc as never, subjectId, { now: opts.now })
    : [];
  const crowd = buildCrowdState({ envelopes, qualifies: isLiveConstraintEligible }, nowMs);
  let forecast: ForecastState | null = null;
  let forecastRefused: ForecastRefused | null = null;
  const result = buildForecastState(
    { crowd, horizonMinutes: opts.horizonMinutes ?? DEFAULT_FORECAST_HORIZON_MINUTES, calibration: null },
    nowMs,
  );
  if (result.forecast) forecast = result.forecast;
  else forecastRefused = result.refused;

  // The evidence a surface may USE: a hard fact (live-qualified) or a soft
  // influence (emerging-eligible), by Compass's own two predicates — never a
  // third rule invented here. The truth block and the window are composed over
  // exactly that set, so a GO SOON on an emerging signal carries that claim's
  // own band and expiry rather than an empty one.
  const usable = envelopes.filter((e) => isLiveConstraintEligible(e, nowMs) || isEmergingInfluenceEligible(e, nowMs));
  return {
    subjectId,
    readable: opts.readable,
    crowd,
    forecast,
    forecastRefused,
    envelopes,
    truth: truthOfEnvelopes(usable, nowMs),
    evidenceWindow: envelopeTemporal(usable, nowMs),
  };
}

/** Availability: push off or quiet hours ⇒ false; an UNREADABLE preference ⇒ null, never "available". */
export async function readViewerAvailability(sc: any, userId: string, now: Date): Promise<boolean | null> {
  const svc = new NotificationPreferenceService(sc);
  const { prefs, readFailed } = await svc.getPreferencesResult(userId);
  if (readFailed) return null;
  if ((prefs as { pushEnabled?: boolean }).pushEnabled === false) return false;
  if (prefs.quietHoursEnabled && svc.isQuietHour(prefs, now)) return false;
  return true;
}

/** Interruptions already spent this window, or null when the count could not be read. */
export async function readDeliveredInWindow(sc: any, userId: string, now: Date): Promise<number | null> {
  try {
    const since = new Date(now.getTime() - ATTENTION_WINDOW_MINUTES * 60_000).toISOString();
    const { count, error } = await sc
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", since);
    if (error) return null;
    return typeof count === "number" ? count : null;
  } catch {
    return null;
  }
}

/** The AttentionContext for one viewer. `seenIds` is the client's novelty list; it is never stored. */
export async function readAttentionContext(
  sc: any,
  userId: string,
  now: Date,
  seenIds: readonly string[] = [],
): Promise<AttentionContext> {
  const [available, deliveredInWindow] = await Promise.all([
    readViewerAvailability(sc, userId, now),
    readDeliveredInWindow(sc, userId, now),
  ]);
  return { available, deliveredInWindow, budgetPerWindow: ATTENTION_BUDGET_PER_WINDOW, seenIds };
}
