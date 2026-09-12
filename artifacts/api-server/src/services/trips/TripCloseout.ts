/**
 * Trips spec §20.2 trip closeout and §20.3 minimal reconciliation, PURE.
 *
 * §20.2, verbatim:
 *
 *   COMPLETED → stop/expire temporary presence → dissolve temporary crews
 *   where appropriate → reconcile uncertain plan outcomes → close
 *   operational decision tasks → preserve decision/audit evidence per policy
 *   → project Passport/Memory candidates → archive rebuildable operational
 *   projections
 *
 * §20.3: "When evidence is incomplete, ask only the smallest useful post-trip
 * question set. Example: 'Did you make it to Hoi An?' instead of forcing the
 * user to mark every plan manually."
 *
 * WHAT EXISTED
 * ============
 * census-trips TR383-TR390: `POST /trips/:tripId/complete` was "an
 * authorization check, a status update and a logActivity line" — it touched
 * no presence table, reconciled nothing, asked nothing. TR388: stamps are
 * awarded on completion by the Passport programme's own engine.
 *
 * THIS FILE DECIDES; THE ROUTE ACTS
 * =================================
 * `planCloseout` takes what the route read and returns the §20.2 steps in
 * order, each either ACTIONABLE (with the ids to act on) or NOT APPLICABLE
 * (with the reason) or DEFERRED (needs a table or a command this deployment
 * does not have). The route performs the actionable ones and reports every
 * step, so a closeout that could only do two of seven says so.
 *
 * `reconciliationQuestions` is §20.3: one question per plan item whose
 * outcome is uncertain — a `tentative` or `confirmed` item on a past day that
 * was never marked done or cancelled — phrased as the spec's example. The
 * smallest set: items already `done` or `cancelled` are not asked about,
 * and items with no day cannot have "happened" and are not asked about.
 */

export const CLOSEOUT_STEPS = [
  "stop_temporary_presence",
  "dissolve_temporary_crews",
  "reconcile_uncertain_plan_outcomes",
  "close_operational_decision_tasks",
  "preserve_decision_evidence",
  "project_passport_memory_candidates",
  "archive_rebuildable_projections",
] as const;
export type CloseoutStep = (typeof CLOSEOUT_STEPS)[number];

export type CloseoutStepPlan =
  | { step: CloseoutStep; status: "actionable"; ids: string[]; riskIds?: string[]; detail: string }
  | { step: CloseoutStep; status: "not_applicable"; detail: string }
  | { step: CloseoutStep; status: "deferred"; detail: string };

export interface CloseoutInputs {
  /** Active temporary presence sessions (trip_crew_location_sessions) for this trip. */
  activeLiveShareIds: readonly string[];
  /** Live plan items with their status and day. */
  planItems: readonly { id: string; title: string | null; status: string | null; dayDate: string | null; locationName: string | null }[];
  /** Pending decision tasks, when the deployment can read them (null = could not, or not enabled). */
  pendingDecisionTaskIds: readonly string[] | null;
  /** Open risks (trip_risks.status = open), when the deployment can read them (null / omitted = could not, or not enabled). §5.3: operational, they expire with the trip. */
  openRiskIds?: readonly string[] | null;
  /** Active temporary subgroups (trip_subgroups, 2780), when the deployment can read them (null = could not, or not enabled). */
  activeSubgroupIds?: readonly string[] | null;
  /** §21.2 ledger rows (trip_decisions, 2781) still within retention, when the deployment can read them (null / omitted = could not, or not enabled). */
  storedDecisionIds?: readonly string[] | null;
  /** The trip's last day, YYYY-MM-DD. */
  tripEndDate: string | null;
  /** Local date at closeout, YYYY-MM-DD. */
  today: string;
}

export interface ReconciliationQuestion {
  planId: string;
  question: string;
  /** The two answers the spec's example admits, mapped to trip_outcomes types. */
  answers: readonly ["completed", "skipped"];
}

export function reconciliationQuestions(inputs: Pick<CloseoutInputs, "planItems" | "today">): ReconciliationQuestion[] {
  const out: ReconciliationQuestion[] = [];
  for (const p of inputs.planItems) {
    if (p.status === "done" || p.status === "cancelled") continue;   // certain
    if (!p.dayDate || p.dayDate > inputs.today) continue;             // cannot have happened yet
    const what = p.locationName ?? p.title ?? "that plan";
    out.push({ planId: p.id, question: `Did you make it to ${what}?`, answers: ["completed", "skipped"] });
  }
  return out;
}

export function planCloseout(inputs: CloseoutInputs): { steps: CloseoutStepPlan[]; questions: ReconciliationQuestion[] } {
  const questions = reconciliationQuestions(inputs);
  const steps: CloseoutStepPlan[] = [
    inputs.activeLiveShareIds.length > 0
      ? { step: "stop_temporary_presence", status: "actionable", ids: [...inputs.activeLiveShareIds], detail: `${inputs.activeLiveShareIds.length} active live-share session(s) stop at completion` }
      : { step: "stop_temporary_presence", status: "not_applicable", detail: "no active live-share session" },
    inputs.activeSubgroupIds === null || inputs.activeSubgroupIds === undefined
      ? { step: "dissolve_temporary_crews", status: "deferred", detail: "trip_subgroups is kernel-era schema (2780) behind trip_operational_projections_enabled; not read" }
      : inputs.activeSubgroupIds.length > 0
        ? { step: "dissolve_temporary_crews", status: "actionable", ids: [...inputs.activeSubgroupIds], detail: `${inputs.activeSubgroupIds.length} active temporary subgroup(s) dissolve at completion (§9.2, §20.2) — DISSOLVE_SUBGROUP commands` }
        : { step: "dissolve_temporary_crews", status: "not_applicable", detail: "no active temporary subgroup" },
    questions.length > 0
      ? { step: "reconcile_uncertain_plan_outcomes", status: "actionable", ids: questions.map((q) => q.planId), detail: `${questions.length} plan(s) with an uncertain outcome; §20.3 questions attached, answers are RECORD_OUTCOME commands (kernel, not enabled here)` }
      : { step: "reconcile_uncertain_plan_outcomes", status: "not_applicable", detail: "every dated plan is already done or cancelled" },
    inputs.pendingDecisionTaskIds === null
      ? { step: "close_operational_decision_tasks", status: "deferred", detail: "trip_decision_tasks is kernel-era schema behind trip_operational_projections_enabled; not read" }
      : inputs.pendingDecisionTaskIds.length > 0 || (inputs.openRiskIds?.length ?? 0) > 0
        ? {
          step: "close_operational_decision_tasks", status: "actionable", ids: [...inputs.pendingDecisionTaskIds],
          ...((inputs.openRiskIds?.length ?? 0) > 0 ? { riskIds: [...(inputs.openRiskIds ?? [])] } : {}),
          detail: (inputs.openRiskIds?.length ?? 0) > 0
            ? `${inputs.pendingDecisionTaskIds.length} pending decision task(s) and ${inputs.openRiskIds!.length} open risk(s) expire at completion — UPDATE_DECISION_TASK / UPDATE_RISK through the kernel`
            : `${inputs.pendingDecisionTaskIds.length} pending decision task(s) expire at completion — UPDATE_DECISION_TASK through the kernel`,
        }
        : { step: "close_operational_decision_tasks", status: "not_applicable", detail: "no pending decision task or open risk" },
    { step: "preserve_decision_evidence", status: "not_applicable", detail: "trip_activity_log keeps completion evidence by default (no retention policy exists — census-trips TR100/TR387); the decision ledger is in-process (§21.2, §40.6)" },
    { step: "project_passport_memory_candidates", status: "not_applicable", detail: "Passport stamps are awarded by the completion path already (awardTripCompletionStamps); no Memory candidate producer exists" },
    inputs.storedDecisionIds == null
      ? { step: "archive_rebuildable_projections", status: "deferred", detail: "trip_decisions (2781, the §21.2 ledger) is kernel-era schema behind trip_operational_projections_enabled; not read" }
      : inputs.storedDecisionIds.length > 0
        ? { step: "archive_rebuildable_projections", status: "actionable", ids: [...inputs.storedDecisionIds], detail: `${inputs.storedDecisionIds.length} stored decision(s) in the §21.2 ledger: retention ends at completion; every other operational projection is generated per request` }
        : { step: "archive_rebuildable_projections", status: "not_applicable", detail: "no stored decision within retention; every other operational projection is generated per request" },
  ];
  return { steps, questions };
}
