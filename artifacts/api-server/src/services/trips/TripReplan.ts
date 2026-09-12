/**
 * Trips spec §11.3 "Replan today" and §12.1 simulatePlan / replanDay, PURE
 * (census-trips TR196, TR209, TR211).
 *
 *   Replan today   Creates a candidate diff; important shared mutations become proposals.
 *   simulatePlan   the schedule a proposal implies, judged, without writing
 *   replanDay      a candidate diff for one day under stated constraints
 *
 * A replan is a DIFF, never a write: a list of candidate operations over the
 * day's plans — keep, move, cancel, add — each with the reason it is
 * proposed, the impact preview (§9.4 / §15.3) it carries, and whether it is
 * a shared mutation that §9.3 says must become a proposal rather than an
 * edit. The caller (routes/tripProjections.ts, Compass) shows the diff or
 * turns the shared entries into CREATE_PROPOSAL commands; nothing here
 * mutates.
 *
 * What drives the diff:
 *   * a plan a live signal invalidated (the pulse's plan_invalidated) → cancel,
 *     with the best executable opportunity in the same window as an add
 *   * a plan in a temporal conflict → move to the nearest free slot that
 *     clears it, else cancel
 *   * a plan a risk trigger names downstream of a tight arrival → move later
 *     by the arrival's magnitude
 *   * everything else → keep
 */
import { previewImpact, type ImpactState, type ImpactPreview, type StatePlan } from "./TripImpactPreview.js";
import type { TemporalConflict, FreedomWindow } from "./TripFreedomEngine.js";
import type { ExecutableTripExperience } from "./TripExperienceCompiler.js";
import type { PulseInterpretation } from "./TripSignals.js";
import type { RiskTrigger } from "./TripRiskTriggers.js";

export const REPLAN_OPS = ["keep", "move", "cancel", "add"] as const;
export type ReplanOp = (typeof REPLAN_OPS)[number];

export const REPLAN_REASONS = [
  "PLAN_INVALIDATED_BY_SIGNAL", "PLAN_IN_CONFLICT", "PLAN_DOWNSTREAM_OF_TIGHT_ARRIVAL", "FALLBACK_OPPORTUNITY", "NO_CHANGE_NEEDED", "CONSTRAINT_DROP",
] as const;
export type ReplanReason = (typeof REPLAN_REASONS)[number];

export interface ReplanEntry {
  op: ReplanOp;
  planId: string | null;
  title: string | null;
  from: { startsAt: string | null; endsAt: string | null } | null;
  to: { startsAt: string | null; endsAt: string | null } | null;
  reason: ReplanReason;
  detail: string;
  /** §9.3: a change to a plan others attend is proposed, not edited. */
  sharedMutation: boolean;
  /** §9.4 / §15.3 for the entries that change something. */
  impact: ImpactPreview | null;
  /** The opportunity an `add` came from. */
  experienceId: string | null;
}

export interface ReplanConstraints {
  /** Do not touch these plans. */
  lockedPlanIds?: string[];
  /** Drop plans of these categories / titles (a "skip the museum" ask). */
  dropPlanIds?: string[];
  /** Keep the day within this budget of moves. */
  maxMoves?: number;
  /** Prefer indoor fallbacks (rain). */
  preferIndoor?: boolean;
}

export interface ReplanInputs {
  now: number;
  day: string;
  /** The day's plans, in the impact state's shape (participants, scope, confirmed). */
  plans: StatePlan[];
  state: ImpactState;
  conflicts: TemporalConflict[];
  signals: PulseInterpretation[];
  triggers: RiskTrigger[];
  windows: FreedomWindow[];
  /** Executable experiences for the day's windows (the opportunity projection's). */
  opportunities: ExecutableTripExperience[];
  actorUserId: string | null;
  constraints?: ReplanConstraints;
}

export interface ReplanDiff {
  day: string;
  entries: ReplanEntry[];
  counts: Record<ReplanOp, number>;
  /** Entries that must become proposals (§9.3) — the caller creates them. */
  proposals: ReplanEntry[];
  /** §15.3: true when any entry puts a booking at risk. */
  requiresUserConfirmation: boolean;
  summary: string;
}

const ms = (iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };

/** The first free window on the day that can hold `durationMin` and starts after `notBefore`. */
function freeSlot(windows: FreedomWindow[], day: string, durationMin: number, notBefore: number, now: number): { startsAt: string; endsAt: string } | null {
  const cands = windows.filter((w) => w.beginsAt.slice(0, 10) === day && ms(w.endsAt)! > now).sort((a, b) => a.beginsAt.localeCompare(b.beginsAt));
  for (const w of cands) {
    const start = Math.max(ms(w.beginsAt)!, notBefore, now);
    const end = ms(w.endsAt)! - (w.reservedMinutes ?? 0) * 60_000;
    if (end - start >= durationMin * 60_000) return { startsAt: new Date(start).toISOString(), endsAt: new Date(start + durationMin * 60_000).toISOString() };
  }
  return null;
}

export function replanDay(inputs: ReplanInputs): ReplanDiff {
  const locked = new Set(inputs.constraints?.lockedPlanIds ?? []);
  const drop = new Set(inputs.constraints?.dropPlanIds ?? []);
  const maxMoves = inputs.constraints?.maxMoves ?? Infinity;
  const invalidated = new Set(inputs.signals.flatMap((s) => s.effects.filter((e) => e.kind === "plan_invalidated").flatMap((e) => e.subjectIds)));
  const conflicted = new Map<string, TemporalConflict>();
  for (const c of inputs.conflicts) for (const id of c.planIds) if (!conflicted.has(id)) conflicted.set(id, c);
  const tight = inputs.triggers.find((t) => t.kind === "tight_arrival" && t.fired) ?? null;
  const downstream = new Set(tight?.affectedIds ?? []);
  const entries: ReplanEntry[] = [];
  let moves = 0;
  const usedExperiences = new Set<string>();
  const dayPlans = inputs.plans.filter((p) => p.dayDate === inputs.day || (p.startsAt ?? "").slice(0, 10) === inputs.day).sort((a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? ""));

  for (const p of dayPlans) {
    const from = { startsAt: p.startsAt, endsAt: p.endsAt };
    const durationMin = Math.max(30, Math.round(((ms(p.endsAt) ?? (ms(p.startsAt) ?? 0) + 3_600_000) - (ms(p.startsAt) ?? 0)) / 60_000));
    if (locked.has(p.id) || p.status === "done" || p.status === "cancelled" || p.status === "skipped") {
      entries.push({ op: "keep", planId: p.id, title: p.title, from, to: from, reason: "NO_CHANGE_NEEDED", detail: locked.has(p.id) ? "locked by the caller" : `status ${p.status}`, sharedMutation: false, impact: null, experienceId: null });
      continue;
    }
    if (drop.has(p.id)) {
      const impact = previewImpact({ kind: "cancel_plan", targetId: p.id, proposedBy: inputs.actorUserId }, inputs.state, inputs.now);
      entries.push({ op: "cancel", planId: p.id, title: p.title, from, to: null, reason: "CONSTRAINT_DROP", detail: "dropped at the caller's ask", sharedMutation: impact.governance.sharedMutation, impact, experienceId: null });
      continue;
    }
    if (invalidated.has(p.id)) {
      const impact = previewImpact({ kind: "cancel_plan", targetId: p.id, proposedBy: inputs.actorUserId }, inputs.state, inputs.now);
      entries.push({ op: "cancel", planId: p.id, title: p.title, from, to: null, reason: "PLAN_INVALIDATED_BY_SIGNAL", detail: "a live signal invalidated it (§16.1)", sharedMutation: impact.governance.sharedMutation, impact, experienceId: null });
      const fallback = inputs.opportunities.filter((e) => e.verdict === "EXECUTABLE" && !usedExperiences.has(e.id) && (!inputs.constraints?.preferIndoor || !["WALK", "PHOTO", "EXPLORE"].includes(e.primitive))).sort((a, b) => b.score - a.score)[0] ?? null;
      if (fallback) {
        usedExperiences.add(fallback.id);
        const addImpact = previewImpact({ kind: "add_plan", targetId: null, startsAt: fallback.arriveAt, endsAt: fallback.leaveBy, title: fallback.name, proposedBy: inputs.actorUserId }, inputs.state, inputs.now);
        entries.push({ op: "add", planId: null, title: fallback.name, from: null, to: { startsAt: fallback.arriveAt, endsAt: fallback.leaveBy }, reason: "FALLBACK_OPPORTUNITY", detail: `${fallback.primitive.toLowerCase()} that fits the same window (score ${fallback.score})`, sharedMutation: p.planScope?.toUpperCase() !== "SOLO" && p.participantIds.some((id) => id !== inputs.actorUserId), impact: addImpact, experienceId: fallback.id });
      }
      continue;
    }
    if (conflicted.has(p.id) && moves < maxMoves) {
      const c = conflicted.get(p.id)!;
      const notBefore = c.kind === "PLAN_OVERLAP" ? (ms(p.endsAt) ?? inputs.now) : inputs.now;
      const slot = freeSlot(inputs.windows, inputs.day, durationMin, notBefore, inputs.now);
      if (slot) {
        moves++;
        const impact = previewImpact({ kind: "move_plan", targetId: p.id, startsAt: slot.startsAt, endsAt: slot.endsAt, proposedBy: inputs.actorUserId }, inputs.state, inputs.now);
        entries.push({ op: "move", planId: p.id, title: p.title, from, to: slot, reason: "PLAN_IN_CONFLICT", detail: `${c.kind}: ${c.detail}; moved to the first free slot that clears it`, sharedMutation: impact.governance.sharedMutation, impact, experienceId: null });
      } else {
        const impact = previewImpact({ kind: "cancel_plan", targetId: p.id, proposedBy: inputs.actorUserId }, inputs.state, inputs.now);
        entries.push({ op: "cancel", planId: p.id, title: p.title, from, to: null, reason: "PLAN_IN_CONFLICT", detail: `${c.kind}: ${c.detail}; no free slot on the day can hold it`, sharedMutation: impact.governance.sharedMutation, impact, experienceId: null });
      }
      continue;
    }
    if (downstream.has(p.id) && tight && tight.magnitude !== null && moves < maxMoves) {
      const s = ms(p.startsAt); const e = ms(p.endsAt);
      if (s !== null) {
        moves++;
        const to = { startsAt: new Date(s + tight.magnitude * 60_000).toISOString(), endsAt: e !== null ? new Date(e + tight.magnitude * 60_000).toISOString() : null };
        const impact = previewImpact({ kind: "move_plan", targetId: p.id, startsAt: to.startsAt, endsAt: to.endsAt, proposedBy: inputs.actorUserId }, inputs.state, inputs.now);
        entries.push({ op: "move", planId: p.id, title: p.title, from, to, reason: "PLAN_DOWNSTREAM_OF_TIGHT_ARRIVAL", detail: `arrival runs ${tight.magnitude} min late; moved by the same`, sharedMutation: impact.governance.sharedMutation, impact, experienceId: null });
        continue;
      }
    }
    entries.push({ op: "keep", planId: p.id, title: p.title, from, to: from, reason: "NO_CHANGE_NEEDED", detail: "nothing invalidates, conflicts with or delays it", sharedMutation: false, impact: null, experienceId: null });
  }

  const counts: Record<ReplanOp, number> = { keep: 0, move: 0, cancel: 0, add: 0 };
  for (const e of entries) counts[e.op] += 1;
  const proposals = entries.filter((e) => e.op !== "keep" && e.sharedMutation);
  const requiresUserConfirmation = entries.some((e) => e.impact?.bookingSideEffects.requiresUserConfirmation);
  const summary = `${inputs.day}: ${counts.keep} kept, ${counts.move} moved, ${counts.cancel} cancelled, ${counts.add} added; ${proposals.length} shared mutation(s) become proposals${requiresUserConfirmation ? "; a booking is at risk — confirmation required" : ""}`;
  return { day: inputs.day, entries, counts, proposals, requiresUserConfirmation, summary };
}

// ── simulatePlan ─────────────────────────────────────────────────────────────

export interface SimulationVerdict {
  change: ReplanEntry["op"] | "move_commitment";
  /** §7: the schedule the proposal implies. */
  feasibility: "FEASIBLE" | "INFEASIBLE" | "UNKNOWN";
  /** Appendix B: TRIP_TEMPORAL_INFEASIBLE when a conflict refuses the change, TRIP_TEMPORAL_UNKNOWN when it could not be judged, null when feasible. */
  reasonCode: "TRIP_TEMPORAL_INFEASIBLE" | "TRIP_TEMPORAL_UNKNOWN" | null;
  conflicts: TemporalConflict[];
  impact: ImpactPreview;
  /** What the freedom window would become, if a window bounds the change. */
  windowAfter: { id: string; durationMinutesBefore: number; durationMinutesAfter: number } | null;
  explanation: string[];
}

/** §12.1 simulatePlan(tripId, proposal): judge one change without writing it. */
export function simulateChange(change: Parameters<typeof previewImpact>[0], state: ImpactState, windows: FreedomWindow[], now: number): SimulationVerdict {
  const impact = previewImpact(change, state, now);
  const conflicts = impact.commitmentConflicts;
  const feasibility: SimulationVerdict["feasibility"] = conflicts.length > 0 ? "INFEASIBLE" : (change.kind === "move_plan" || change.kind === "add_plan") && !change.startsAt ? "UNKNOWN" : "FEASIBLE";
  let windowAfter: SimulationVerdict["windowAfter"] = null;
  if ((change.kind === "move_plan" || change.kind === "add_plan") && change.startsAt) {
    const s = ms(change.startsAt)!; const e = ms(change.endsAt) ?? s + 3_600_000;
    const w = windows.find((x) => ms(x.beginsAt)! <= s && e <= ms(x.endsAt)!) ?? null;
    if (w) windowAfter = { id: w.id, durationMinutesBefore: w.durationMinutes, durationMinutesAfter: Math.max(0, w.durationMinutes - Math.round((e - s) / 60_000)) };
  }
  const explanation = [
    impact.summary,
    feasibility === "INFEASIBLE" ? `${conflicts.length} conflict(s): ${conflicts.map((c) => c.detail).join("; ")}` : feasibility === "UNKNOWN" ? "no slot was given, so feasibility cannot be judged" : "no conflict with the day's plans or the commitments' approach windows",
    windowAfter ? `window ${windowAfter.id} would keep ${windowAfter.durationMinutesAfter} of ${windowAfter.durationMinutesBefore} minutes` : "the change sits in no free window",
    ...impact.bookingSideEffects.explanation,
  ];
  return { change: change.kind === "move_commitment" ? "move_commitment" : change.kind === "cancel_plan" || change.kind === "remove_plan" ? "cancel" : change.kind === "add_plan" ? "add" : "move", feasibility, reasonCode: feasibility === "INFEASIBLE" ? "TRIP_TEMPORAL_INFEASIBLE" : feasibility === "UNKNOWN" ? "TRIP_TEMPORAL_UNKNOWN" : null, conflicts, impact, windowAfter, explanation };
}
