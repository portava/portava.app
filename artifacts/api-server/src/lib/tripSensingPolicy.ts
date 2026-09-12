/**
 * Trips spec §10.3 — "increase sensing frequency only when execution/safety
 * requires it" (census-trips TR172). PURE.
 *
 * The server does not sense; the client does, at whatever interval it is
 * told. What the tree lacked was the POLICY: a sampling-rate concept and the
 * rule that raises it. This is that rule, decided from the state Today already
 * derives, and published on the Today projection so a client that honours it
 * samples slowly when nothing needs it and quickly only when something does.
 *
 *   idle       nothing is executing and nobody is at risk           15 minutes
 *   execution  a plan is active (§3.2 ACTIVE_PLAN), the traveller is
 *              in TRANSIT, the day is DISRUPTED, the next leave-by is
 *              within the hour, or §17.2 has the trip AT_RISK          2 minutes
 *   safety     a Safe Return is active for a crew member, or the
 *              trip is in §17.2's SAFETY_EVENT mode                  30 seconds
 *
 * The level is the HIGHEST that applies and the reasons list every one that
 * did, so a renderer can say why the battery is being spent. Nothing here
 * turns sensing on: a client with location off has nothing to sample, and a
 * policy that said "faster" would change nothing there (§10.1).
 */
import type { OperationalPhase } from "../services/trips/TripOperationalPhase.js";
import type { PriorityMode } from "../services/trips/TripHealth.js";

export const SENSING_LEVELS = ["idle", "execution", "safety"] as const;
export type SensingLevel = (typeof SENSING_LEVELS)[number];

export const SENSING_INTERVAL_SECONDS: Readonly<Record<SensingLevel, number>> = {
  idle: 15 * 60,
  execution: 2 * 60,
  safety: 30,
};

/** A leave-by this close raises sensing to execution. */
export const EXECUTION_LEAD_MINUTES = 60;

export const SENSING_REASONS = [
  "PLAN_IN_PROGRESS",
  "LEAVE_BY_WITHIN_HOUR",
  "IN_TRANSIT",
  "DISRUPTED",
  "AT_RISK_MODE",
  "SAFE_RETURN_ACTIVE",
  "SAFETY_EVENT_MODE",
] as const;
export type SensingReason = (typeof SENSING_REASONS)[number];

export interface SensingInputs {
  /** §3.2's phase for now; null when the trip is not in progress today. */
  phase: OperationalPhase | null;
  /** §17.2's mode for the trip. */
  attentionMode: PriorityMode;
  /** The next commitment's leave-by instant, ISO, or null. */
  mustLeaveBy: string | null;
  /** Safe Return sessions active for crew members (null when not read). */
  safeReturnActive: number | null;
  now: number;
}

export interface SensingPolicy {
  level: SensingLevel;
  intervalSeconds: number;
  reasons: SensingReason[];
  reading: string;
}

export function decideSensing(input: SensingInputs): SensingPolicy {
  const reasons: SensingReason[] = [];
  if (input.attentionMode === "SAFETY_EVENT") reasons.push("SAFETY_EVENT_MODE");
  if ((input.safeReturnActive ?? 0) > 0) reasons.push("SAFE_RETURN_ACTIVE");
  if (input.attentionMode === "AT_RISK") reasons.push("AT_RISK_MODE");
  if (input.phase === "ACTIVE_PLAN") reasons.push("PLAN_IN_PROGRESS");
  if (input.phase === "TRANSIT") reasons.push("IN_TRANSIT");
  if (input.phase === "DISRUPTED") reasons.push("DISRUPTED");
  const leaveBy = input.mustLeaveBy ? Date.parse(input.mustLeaveBy) : NaN;
  if (Number.isFinite(leaveBy) && leaveBy - input.now <= EXECUTION_LEAD_MINUTES * 60_000 && leaveBy >= input.now - EXECUTION_LEAD_MINUTES * 60_000) {
    reasons.push("LEAVE_BY_WITHIN_HOUR");
  }
  const level: SensingLevel = reasons.some((r) => r === "SAFETY_EVENT_MODE" || r === "SAFE_RETURN_ACTIVE") ? "safety"
    : reasons.length > 0 ? "execution" : "idle";
  const intervalSeconds = SENSING_INTERVAL_SECONDS[level];
  const reading = level === "idle"
    ? `nothing is executing and nobody is at risk: sample every ${intervalSeconds / 60} minutes (§10.3)`
    : level === "execution"
      ? `execution needs it (${reasons.join(", ")}): sample every ${intervalSeconds / 60} minutes`
      : `safety needs it (${reasons.join(", ")}): sample every ${intervalSeconds} seconds`;
  return { level, intervalSeconds, reasons, reading };
}
