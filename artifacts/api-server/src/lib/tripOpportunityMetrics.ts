/**
 * Trips spec §21.1 — `opportunity_created_total / accepted / completed`
 * ("Real-world opportunity conversion"), the COMPLETED third.
 *
 * created is counted where the opportunity projection first sees an
 * executable experience (services/trips/TripOpportunityProjection.ts);
 * accepted where POST /trips/:id/opportunities/:experienceId/accept writes
 * the plan through the kernel (routes/tripProjections.ts). Completed is
 * this: a COMPLETE_ACTIVITY that succeeded on a plan whose source_type is
 * 'opportunity' — the kernel's result is the plan row (to_jsonb(v_row)), so
 * no second read is needed. Called on every path that issues plan commands
 * through the kernel: the plan PATCH cutover in routes/trips.ts and the
 * Compass autopilot. A duplicate (an idempotent replay) is not a second
 * completion.
 */
import { incrementTripMetric } from "./tripMetrics.js";

export function recordOpportunityCompletion(
  type: string,
  result: unknown,
  tripId: string,
  duplicate: boolean,
): boolean {
  if (type !== "COMPLETE_ACTIVITY" || duplicate) return false;
  const row = result as Record<string, unknown> | null | undefined;
  if (!row || typeof row !== "object" || row.source_type !== "opportunity") return false;
  incrementTripMetric("opportunity_completed_total", { trip: tripId, primitive: typeof row.category === "string" ? row.category : "unknown" });
  return true;
}
