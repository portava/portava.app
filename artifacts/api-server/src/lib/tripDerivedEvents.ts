/**
 * Trips spec §4.2 derived domain events — commitment_at_risk and
 * free_window_created — issued by the ENGINES, not by a person.
 *
 * census-trips TR61/TR62/TR65 graded these "zero occurrences outside docs/".
 * 2785 gives the kernel MARK_COMMITMENT_AT_RISK, CLEAR_COMMITMENT_RISK and
 * OPEN_FREE_WINDOW under the 'engine' capability (actor_role 'system', no
 * user, or accepted crew). This module is the engine side of that contract:
 * after TripFreedomProjection computes windows and conflicts it hands them
 * here, and each becomes ONE command whose idempotency key is the fact's own
 * identity — so a projection read a second time is a duplicate at the
 * receipt, not a second event, and the aggregate version does not churn.
 *
 * Gated on trip_kernel_enabled, the same flag that gates every kernel write:
 * with it off (production, CI) nothing is issued and the caller is told so
 * by name. Never throws — a failed derived event is logged and counted; the
 * projection that produced it is still served.
 */
import { randomUUID } from "node:crypto";

import { isFlagEnabled } from "./featureFlags.js";
import { executeTripCommand } from "./tripKernel.js";
import { logger } from "./logger.js";
import { incrementTripMetric } from "./tripMetrics.js";
import type { FreedomWindow, TemporalConflict } from "../services/trips/TripFreedomEngine.js";

const log = logger.child({ mod: "tripDerivedEvents" });

export const TRIP_KERNEL_FLAG = "trip_kernel_enabled";

export interface DerivedEventsReport {
  /** Why nothing was issued, when nothing was. */
  skipped: "trip_kernel_enabled is false" | null;
  issued: number;
  duplicates: number;
  failed: number;
  /** The kernel reasons of the failures, for the caller's reading. */
  failures: string[];
}

/** The fact's identity IS the key: same window or same conflict → same receipt. */
export function freeWindowKey(tripId: string, w: Pick<FreedomWindow, "beginsAt" | "endsAt">): string {
  return `engine:free-window:${tripId}:${w.beginsAt}:${w.endsAt}`;
}
export function commitmentAtRiskKey(commitmentId: string, kind: string): string {
  return `engine:at-risk:${commitmentId}:${kind}`;
}

export async function recordDerivedEvents(
  sc: any,
  tripId: string,
  facts: { windows: readonly FreedomWindow[]; conflicts: readonly TemporalConflict[] },
  opts: { now?: Date } = {},
): Promise<DerivedEventsReport> {
  const report: DerivedEventsReport = { skipped: null, issued: 0, duplicates: 0, failed: 0, failures: [] };
  if (!(await isFlagEnabled(sc, TRIP_KERNEL_FLAG))) {
    report.skipped = "trip_kernel_enabled is false";
    return report;
  }
  const observedAt = (opts.now ?? new Date()).toISOString();
  const issue = async (type: "MARK_COMMITMENT_AT_RISK" | "OPEN_FREE_WINDOW", idempotencyKey: string, payload: Record<string, unknown>) => {
    try {
      const r = await executeTripCommand(sc, {
        commandId: randomUUID(), tripId, actorUserId: null, actorRole: "system",
        idempotencyKey, type, payload, clientObservedAt: observedAt,
      });
      if (r.ok) { if (r.duplicate) report.duplicates += 1; else { report.issued += 1; incrementTripMetric("derived_event_total", { type }); } }
      else { report.failed += 1; report.failures.push(r.reason); log.warn({ tripId, type, reason: r.reason }, "derived event refused"); }
    } catch (e: any) {
      report.failed += 1; report.failures.push(String(e?.message ?? e)); log.warn({ tripId, type, err: String(e?.message ?? e) }, "derived event threw");
    }
  };
  for (const c of facts.conflicts) {
    for (const commitmentId of c.commitmentIds) {
      await issue("MARK_COMMITMENT_AT_RISK", commitmentAtRiskKey(commitmentId, c.kind), {
        commitment_id: commitmentId, reason: c.reason, kind: c.kind, shortfall_minutes: c.shortfallMinutes, source: "TripFreedomEngine",
      });
    }
  }
  for (const w of facts.windows) {
    await issue("OPEN_FREE_WINDOW", freeWindowKey(tripId, w), {
      window_id: w.id, begins_at: w.beginsAt, ends_at: w.endsAt, duration_minutes: w.durationMinutes,
      position: w.position, certified: w.certified, source: "TripFreedomEngine",
    });
  }
  return report;
}
