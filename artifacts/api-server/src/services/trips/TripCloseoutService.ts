/**
 * Trips spec §20.2 — the closeout, performed. `POST /trips/:tripId/complete`
 * calls this AFTER the status transition has succeeded (kernel or legacy
 * path), so a closeout step that fails cannot un-complete the trip; every
 * step's outcome is reported instead.
 *
 * WHAT IT DOES
 * ============
 *   1. reads the inputs (active live-share sessions; live plan items; pending
 *      decision tasks only when the operational capability is on — that table
 *      is kernel-era schema);
 *   2. asks services/trips/TripCloseout.ts which §20.2 steps are actionable;
 *   3. performs the ONE step this deployment can perform — stopping temporary
 *      presence — with the same update shape TripCrewLiveShareService uses;
 *   4. returns the plan, the §20.3 questions and what happened, so the
 *      response to `complete` carries the closeout rather than implying it.
 *
 * A read that fails does not throw: the trip IS completed, and the caller
 * gets `status: "failed"` on that step with the reason.
 */
import { logger } from "../../lib/logger.js";
import { tripOperationalProjectionsGate } from "../../lib/tripOperationalProjections.js";
import { localClock } from "./TripOperationalPhase.js";
import { planCloseout, type CloseoutStepPlan, type ReconciliationQuestion } from "./TripCloseout.js";

const log = logger.child({ mod: "tripCloseout" });

export type CloseoutStepOutcome = CloseoutStepPlan | { step: CloseoutStepPlan["step"]; status: "performed" | "failed"; ids: string[]; detail: string };

export interface TripCloseoutReport {
  performedAt: string;
  steps: CloseoutStepOutcome[];
  questions: ReconciliationQuestion[];
  /** Which inputs could not be read; a step over an unread input is reported, not assumed. */
  unread: string[];
}

export async function runTripCloseout(sc: any, tripId: string, opts: { now?: Date; timezone?: string | null; dryRun?: boolean } = {}): Promise<TripCloseoutReport> {
  const now = opts.now ?? new Date();
  const unread: string[] = [];

  const { data: sessions, error: sErr } = await sc
    .from("trip_crew_location_sessions")
    .select("id")
    .eq("trip_id", tripId)
    .eq("status", "active");
  if (sErr) { unread.push("trip_crew_location_sessions"); log.warn({ err: sErr.message, tripId }, "closeout: live-share sessions unreadable"); }
  const activeLiveShareIds = sErr ? [] : ((sessions ?? []) as any[]).map((s) => String(s.id));

  const { data: items, error: iErr } = await sc
    .from("trip_plan_items")
    .select("id, title, status, day_date, location_name")
    .eq("trip_id", tripId)
    .is("removed_at", null);
  if (iErr) { unread.push("trip_plan_items"); log.warn({ err: iErr.message, tripId }, "closeout: plan items unreadable"); }
  const planItems = iErr ? [] : ((items ?? []) as any[]).map((p) => ({
    id: String(p.id), title: p.title ?? null, status: p.status ?? null, dayDate: p.day_date ?? null, locationName: p.location_name ?? null,
  }));

  let pendingDecisionTaskIds: string[] | null = null;
  const gate = await tripOperationalProjectionsGate(sc);
  if (gate.enabled) {
    const { data: tasks, error: tErr } = await sc.from("trip_decision_tasks").select("id").eq("trip_id", tripId).eq("status", "pending");
    if (tErr) { unread.push("trip_decision_tasks"); log.warn({ err: tErr.message, tripId }, "closeout: decision tasks unreadable"); }
    else pendingDecisionTaskIds = ((tasks ?? []) as any[]).map((t) => String(t.id));
  }

  const plan = planCloseout({
    activeLiveShareIds, planItems, pendingDecisionTaskIds,
    tripEndDate: null, today: localClock(now, opts.timezone ?? null).date,
  });

  const steps: CloseoutStepOutcome[] = [];
  for (const step of plan.steps) {
    if (step.step === "stop_temporary_presence" && step.status === "actionable") {
      if (opts.dryRun) { steps.push(step); continue; }
      const { data: stopped, error: stopErr } = await sc
        .from("trip_crew_location_sessions")
        .update({ status: "stopped", stopped_at: now.toISOString() })
        .eq("trip_id", tripId)
        .eq("status", "active")
        .select("id");
      if (stopErr) {
        log.warn({ err: stopErr.message, tripId }, "closeout: stopping live shares failed");
        steps.push({ step: step.step, status: "failed", ids: step.ids, detail: `stopping ${step.ids.length} live-share session(s) failed: ${stopErr.message}` });
      } else {
        const ids = ((stopped ?? []) as any[]).map((s) => String(s.id));
        steps.push({ step: step.step, status: "performed", ids, detail: `${ids.length} live-share session(s) stopped at completion (§20.2)` });
      }
      continue;
    }
    if (step.step === "reconcile_uncertain_plan_outcomes" && iErr) {
      steps.push({ step: step.step, status: "failed", ids: [], detail: "plan items could not be read; no question can be asked" });
      continue;
    }
    if (step.step === "stop_temporary_presence" && sErr) {
      steps.push({ step: step.step, status: "failed", ids: [], detail: "live-share sessions could not be read; nothing was stopped" });
      continue;
    }
    steps.push(step);
  }

  return { performedAt: now.toISOString(), steps, questions: iErr ? [] : plan.questions, unread };
}
