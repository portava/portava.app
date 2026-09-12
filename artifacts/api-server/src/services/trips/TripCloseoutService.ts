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
import { randomUUID } from "node:crypto";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { executeTripCommand } from "../../lib/tripKernel.js";
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

export async function runTripCloseout(sc: any, tripId: string, opts: { now?: Date; timezone?: string | null; dryRun?: boolean; actorUserId?: string | null } = {}): Promise<TripCloseoutReport> {
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
  let activeSubgroupIds: string[] | null = null;
  let storedDecisionIds: string[] | null = null;
  let openRiskIds: string[] | null = null;
  const gate = await tripOperationalProjectionsGate(sc);
  if (gate.enabled) {
    const { data: tasks, error: tErr } = await sc.from("trip_decision_tasks").select("id").eq("trip_id", tripId).eq("status", "pending");
    if (tErr) { unread.push("trip_decision_tasks"); log.warn({ err: tErr.message, tripId }, "closeout: decision tasks unreadable"); }
    else pendingDecisionTaskIds = ((tasks ?? []) as any[]).map((t) => String(t.id));
    // §5.3: risks are operational; an open one expires with the trip (§20.2).
    const { data: risks, error: rErr } = await sc.from("trip_risks").select("id").eq("trip_id", tripId).eq("status", "open");
    if (rErr) { unread.push("trip_risks"); log.warn({ err: rErr.message, tripId }, "closeout: risks unreadable"); }
    else openRiskIds = ((risks ?? []) as any[]).map((r) => String(r.id));
    // §9.2 / §20.2 (2780): temporary subgroups dissolve at completion.
    const { data: groups, error: gErr } = await sc.from("trip_subgroups").select("id").eq("trip_id", tripId).eq("state", "active");
    if (gErr) { unread.push("trip_subgroups"); log.warn({ err: gErr.message, tripId }, "closeout: subgroups unreadable"); }
    else activeSubgroupIds = ((groups ?? []) as any[]).map((g) => String(g.id));
    // §20.2 / §21.2 (2781): the ledger rows still within retention are what "archive" can act on.
    const { data: decisions, error: dErr } = await sc.from("trip_decisions").select("decision_id, retain_until").eq("trip_id", tripId);
    if (dErr) { unread.push("trip_decisions"); log.warn({ err: dErr.message, tripId }, "closeout: decision ledger unreadable"); }
    else storedDecisionIds = ((decisions ?? []) as any[]).filter((d) => { const t = Date.parse(String(d.retain_until ?? "")); return !Number.isFinite(t) || t > now.getTime(); }).map((d) => String(d.decision_id));
  }

  const plan = planCloseout({
    activeLiveShareIds, planItems, pendingDecisionTaskIds, activeSubgroupIds, storedDecisionIds, openRiskIds,
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
    if (step.step === "dissolve_temporary_crews" && step.status === "actionable") {
      if (opts.dryRun) { steps.push(step); continue; }
      // DISSOLVE_SUBGROUP is a kernel command (2780): the creator's or a host's.
      // The actor is whoever completed the trip — the owner — and the key is
      // the closeout's, so a repeated completion is a duplicate, not a second
      // dissolution. Behind trip_kernel_enabled like every kernel write.
      if (!opts.actorUserId) {
        steps.push({ step: step.step, status: "failed", ids: step.ids, detail: "no actor to issue DISSOLVE_SUBGROUP as" });
        continue;
      }
      if (!(await isFlagEnabled(sc, "trip_kernel_enabled"))) {
        steps.push({ step: step.step, status: "deferred", detail: `${step.ids?.length ?? 0} active subgroup(s) remain (${(step.ids ?? []).join(", ")}): DISSOLVE_SUBGROUP is a kernel command and trip_kernel_enabled is false` });
        continue;
      }
      const dissolved: string[] = []; const failures: string[] = [];
      for (const id of step.ids ?? []) {
        const r = await executeTripCommand(sc, {
          commandId: randomUUID(), tripId, actorUserId: opts.actorUserId, idempotencyKey: `closeout:dissolve:${id}`,
          type: "DISSOLVE_SUBGROUP", payload: { subgroup_id: id, reason: "trip completed (§20.2 closeout)" },
        });
        if (r.ok) dissolved.push(id); else failures.push(`${id}: ${r.reason}`);
      }
      steps.push(failures.length === 0
        ? { step: step.step, status: "performed", ids: dissolved, detail: `${dissolved.length} temporary subgroup(s) dissolved at completion (§9.2, §20.2)` }
        : { step: step.step, status: "failed", ids: dissolved, detail: `${dissolved.length} dissolved, ${failures.length} refused: ${failures.join("; ")}` });
      continue;
    }
    if (step.step === "close_operational_decision_tasks" && step.status === "actionable") {
      if (opts.dryRun) { steps.push(step); continue; }
      // UPDATE_DECISION_TASK is a kernel command (2766): a pending task expires
      // with the trip. Keyed by the closeout, so a repeated completion is a
      // duplicate; behind trip_kernel_enabled like every kernel write.
      if (!opts.actorUserId) {
        steps.push({ step: step.step, status: "failed", ids: step.ids, detail: "no actor to issue UPDATE_DECISION_TASK as" });
        continue;
      }
      const riskIds = step.riskIds ?? [];
      if (!(await isFlagEnabled(sc, "trip_kernel_enabled"))) {
        steps.push({ step: step.step, status: "deferred", detail: `${step.ids.length} pending task(s) remain (${step.ids.join(", ")})${riskIds.length > 0 ? ` and ${riskIds.length} open risk(s) (${riskIds.join(", ")})` : ""}: UPDATE_DECISION_TASK / UPDATE_RISK are kernel commands and trip_kernel_enabled is false` });
        continue;
      }
      const expired: string[] = []; const closedRisks: string[] = []; const failures: string[] = [];
      for (const id of step.ids) {
        const r = await executeTripCommand(sc, {
          commandId: randomUUID(), tripId, actorUserId: opts.actorUserId, idempotencyKey: `closeout:task:${id}`,
          type: "UPDATE_DECISION_TASK", payload: { task_id: id, patch: { status: "expired" } },
        });
        if (r.ok) expired.push(id); else failures.push(`${id}: ${r.reason}`);
      }
      for (const id of riskIds) {
        const r = await executeTripCommand(sc, {
          commandId: randomUUID(), tripId, actorUserId: opts.actorUserId, idempotencyKey: `closeout:risk:${id}`,
          type: "UPDATE_RISK", payload: { risk_id: id, patch: { status: "closed" } },
        });
        if (r.ok) closedRisks.push(id); else failures.push(`${id}: ${r.reason}`);
      }
      steps.push(failures.length === 0
        ? { step: step.step, status: "performed", ids: [...expired, ...closedRisks], detail: `${expired.length} pending decision task(s) expired and ${closedRisks.length} open risk(s) closed at completion (§5.3, §8.2, §20.2)` }
        : { step: step.step, status: "failed", ids: [...expired, ...closedRisks], detail: `${expired.length} expired, ${closedRisks.length} closed, ${failures.length} refused: ${failures.join("; ")}` });
      continue;
    }
    if (step.step === "archive_rebuildable_projections" && step.status === "actionable") {
      if (opts.dryRun) { steps.push(step); continue; }
      // The ledger is the server's own table (persistTripDecision writes it
      // directly): ending retention is a direct write too. Rows stay readable
      // until the pruner runs; "archived" means the policy no longer keeps them.
      const { data: archived, error: aErr } = await sc
        .from("trip_decisions")
        .update({ retain_until: now.toISOString() })
        .eq("trip_id", tripId)
        .in("decision_id", step.ids)
        .select("decision_id");
      if (aErr) {
        log.warn({ err: aErr.message, tripId }, "closeout: ending ledger retention failed");
        steps.push({ step: step.step, status: "failed", ids: [], detail: `ending retention on ${step.ids.length} stored decision(s) failed: ${aErr.message}` });
      } else {
        const ids = ((archived ?? []) as any[]).map((d) => String(d.decision_id));
        steps.push({ step: step.step, status: "performed", ids, detail: `${ids.length} stored decision(s) archived: retention ended at completion (§20.2, §21.2)` });
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
