/**
 * The decision-diff RUNNER: one scenario in, one canonical decision record
 * out (Trips spec §24 decision-diff CI; census-trips TR409, TR410, TR433).
 *
 * The record keeps what a reviewer would want to see change — windows and
 * conflicts, the health level and the priority switch, which signals were
 * kept and which dropped, which triggers fired, urgency bands, feasibility
 * verdicts and booking side effects, replan ops, compile verdicts, the
 * opportunity event, the meeting recommendation and its refusals, the rescue
 * escalation, the attention level — and nothing free-text, so a wording
 * change in an explanation is not a "changed decision". Scores are rounded
 * to three decimals so a floating-point reformulation that does not move a
 * verdict does not move the record either.
 *
 * `conservatismScore` is §24's "increased/decreased conservatism" made
 * countable: every refusal, conflict, fired trigger, high band, unmet verdict
 * and interruption counts one. It is a direction, not a grade — a change that
 * raises it made the planner say "no" more often.
 */
import { computeFreedomWindows, detectPlanOverlaps, type FreedomWindow, type TemporalConflict } from "../../services/trips/TripFreedomEngine.js";
import { deriveTripHealth, prioritySwitch } from "../../services/trips/TripHealth.js";
import { projectSignals, type PulseInterpretation } from "../../services/trips/TripSignals.js";
import { evaluateRiskTriggers, type RiskTrigger } from "../../services/trips/TripRiskTriggers.js";
import { decisionUrgency } from "../../services/trips/TripDecisionUrgency.js";
import { replanDay, simulateChange } from "../../services/trips/TripReplan.js";
import { compileExperiences, type CompileResult, type ExecutableTripExperience } from "../../services/trips/TripExperienceCompiler.js";
import { attentionKindFor, diffOpportunities, shouldNotify, type OpportunityPortfolio } from "../../services/trips/TripOpportunityEngine.js";
import { findMeetingPoint } from "../../services/trips/TripMeetingPoint.js";
import { planRescue } from "../../services/trips/TripRescue.js";
import { decideAttention } from "../../services/trips/TripAttentionPolicy.js";
import { unknownsFromExperiences, valueOfInformation } from "../../services/trips/TripValueOfInformation.js";
import { travel as travelEstimator, tripScenarioCorpus, type TripScenario } from "./corpus.js";

/** The engines a record can carry a verdict from — the test asserts the corpus reaches every one. */
export const DECISION_ENGINES = [
  "freedom", "health", "pulse", "triggers", "urgency", "impact", "replan", "compile", "opportunity", "meeting", "rescue", "attention", "questions",
] as const;
export type DecisionEngine = (typeof DECISION_ENGINES)[number];

export interface ConflictRecord { kind: string; commitmentIds: string[]; planIds: string[]; shortfallMinutes: number | null }
export interface ExperienceRecord { candidateId: string; verdict: string; reasonCodes: string[]; arriveAt: string | null; leaveBy: string | null; score: number }

export interface ScenarioDecisions {
  scenario: string;
  title: string;
  spec: string[];
  freedom: null | {
    windows: { id: string; position: string; beginsAt: string; endsAt: string; durationMinutes: number; certified: boolean; reservedMinutes: number | null; hardConstraints: string[] }[];
    conflicts: ConflictRecord[];
    unplacedCommitmentIds: string[];
  };
  planOverlaps: ConflictRecord[];
  health: {
    level: string;
    reasons: { code: string; level: string; subjectIds: string[] }[];
    priority: { mode: string; priority: string[]; suppression: { commercial: boolean; discovery: boolean; reason: string | null } };
  };
  pulse: null | {
    kept: { kind: string; subjectId: string; effects: { kind: string; subjectIds: string[] }[]; relevance: string[] }[];
    dropped: { kind: string; subjectId: string; reason: string }[];
  };
  triggers: null | { kind: string; fired: boolean; affectedIds: string[]; participantIds: string[]; magnitude: number | null }[];
  urgency: { id: string; band: string; score: number; hoursRemaining: number | null; consequenceLevel: string }[];
  impact: null | {
    change: { kind: string; targetId: string | null; startsAt: string | null };
    feasibility: string;
    reasonCode: string | null;
    conflicts: ConflictRecord[];
    changesConfirmedPlan: boolean;
    affectedReservations: string[];
    affectedTransport: string[];
    affectedParticipants: string[];
    bookingsAtRisk: string[];
    cancellationDeadline: string | null;
    potentialCostMinor: number | null;
    requiresUserConfirmation: boolean;
    governance: { sharedMutation: boolean; affectsOthers: boolean; suggestedDecisionRule: string };
    windowAfter: { id: string; durationMinutesBefore: number; durationMinutesAfter: number } | null;
  }[];
  replan: null | {
    entries: { op: string; planId: string | null; experienceId: string | null; reason: string; toStartsAt: string | null; sharedMutation: boolean }[];
    counts: Record<string, number>;
    proposals: string[];
    requiresUserConfirmation: boolean;
  };
  compile: null | {
    windowId: string;
    before: { counts: Record<string, number>; experiences: ExperienceRecord[] };
    after: { counts: Record<string, number>; experiences: ExperienceRecord[] } | null;
    opportunity: { significance: string; added: string[]; removed: { candidateId: string; reasonCodes: string[] }[]; notify: boolean; kind: string; best: string | null } | null;
    questions: { ask: { key: string; dimension: string; value: number }[]; uncertainty: { key: string; dimension: string; value: number }[] } | null;
  };
  meeting: null | {
    recommended: string | null;
    alternatives: string[];
    refused: { candidateId: string; refusals: string[] }[];
    unplaced: { userId: string; reason: string }[];
    constraintsApplied: string[];
  };
  rescue: { problem: string; severity: string; declareKind: string; escalation: { to: string; when: string }[]; safeReturn: string; steps: number }[];
  attention: { label: string; kind: string; level: string; unbudgetedLevel: string; reasons: string[] }[];
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const conflictRecord = (c: TemporalConflict): ConflictRecord => ({ kind: c.kind, commitmentIds: [...c.commitmentIds], planIds: [...c.planIds], shortfallMinutes: c.shortfallMinutes });
const experienceRecord = (e: ExecutableTripExperience): ExperienceRecord => ({ candidateId: e.candidateId, verdict: e.verdict, reasonCodes: [...e.reasonCodes], arriveAt: e.arriveAt, leaveBy: e.leaveBy, score: r3(e.score) });
const compileRecord = (r: CompileResult) => ({ counts: { ...r.counts }, experiences: r.experiences.map(experienceRecord) });

function portfolio(s: TripScenario, w: FreedomWindow, r: CompileResult): OpportunityPortfolio {
  return {
    tripId: s.id, windowId: w.id,
    window: { id: w.id, beginsAt: w.beginsAt, endsAt: w.endsAt, durationMinutes: w.durationMinutes, certified: w.certified, participants: w.participants },
    executable: r.experiences.filter((e) => e.verdict === "EXECUTABLE"),
    notExecutable: r.experiences.filter((e) => e.verdict !== "EXECUTABLE").map((e) => ({ id: e.id, candidateId: e.candidateId, name: e.name, verdict: e.verdict, reasonCodes: e.reasonCodes })),
    computedAt: new Date(s.now).toISOString(), sourceTripVersion: null,
  };
}

export function runTripScenario(s: TripScenario): ScenarioDecisions {
  // 1. freedom: the windows and the temporal conflicts; plan overlaps from the impact state's plans.
  const freedom = s.freedom ? computeFreedomWindows(s.freedom) : null;
  const windows: FreedomWindow[] = freedom?.windows ?? [];
  const overlaps = s.impact ? detectPlanOverlaps(s.impact.state.plans.map((p) => ({ id: p.id, dayDate: p.dayDate, startsAt: p.startsAt, endsAt: p.endsAt }))) : [];
  const conflicts: TemporalConflict[] = [...s.health.conflicts, ...(freedom?.conflicts ?? []), ...overlaps];

  // 2. health and the priority switch over everything the scenario knows.
  const health = deriveTripHealth({ ...s.health, conflicts });
  const priority = prioritySwitch(health);

  // 3. the pulse.
  const pulse = s.pulse ? projectSignals(s.pulse.signals, s.pulse.ctx) : null;
  const kept: PulseInterpretation[] = pulse?.kept ?? [];

  // 4. the four triggers.
  const triggers: RiskTrigger[] = s.triggers ? evaluateRiskTriggers({ ...s.triggers, now: s.now, signals: kept }) : [];

  // 5. urgency per decision.
  const urgency = s.urgency.map((u) => { const d = decisionUrgency(u.inputs, s.now); return { id: u.id, band: d.band, score: r3(d.score), hoursRemaining: d.hoursRemaining === null ? null : r3(d.hoursRemaining), consequenceLevel: d.consequenceLevel }; });

  // 6. impact + simulate per proposed change.
  const impact = s.impact ? s.impact.changes.map((change) => {
    const v = simulateChange(change, s.impact!.state, windows, s.now);
    const se = v.impact.bookingSideEffects;
    return {
      change: { kind: change.kind, targetId: change.targetId, startsAt: change.startsAt ?? null },
      feasibility: v.feasibility, reasonCode: v.reasonCode, conflicts: v.conflicts.map(conflictRecord), changesConfirmedPlan: v.impact.changesConfirmedPlan,
      affectedReservations: v.impact.affectedReservations.map((x) => x.id), affectedTransport: v.impact.affectedTransport.map((x) => x.id),
      affectedParticipants: [...v.impact.affectedParticipants], bookingsAtRisk: se.bookingsAtRisk.map((b) => b.reservationId),
      cancellationDeadline: se.cancellationDeadline, potentialCostMinor: se.potentialCostMinor, requiresUserConfirmation: se.requiresUserConfirmation,
      governance: { ...v.impact.governance }, windowAfter: v.windowAfter ? { ...v.windowAfter } : null,
    };
  }) : null;

  // 7. the compiler, before and (with the pulse mapped onto candidates) after; the opportunity event between them; §12.3's questions.
  let compile: ScenarioDecisions["compile"] = null;
  if (s.compile) {
    const w = windows.find((x) => x.position === s.compile!.windowPosition) ?? null;
    if (w) {
      const base = { now: s.now, window: w, origin: s.compile.origin, participants: s.compile.participants, candidates: s.compile.candidates, travel: travelEstimator, goals: s.compile.goals, preferences: s.compile.preferences, nextCommitment: s.compile.nextCommitment, prepMinutes: s.compile.prepMinutes };
      const before = compileExperiences({ ...base, liveSignals: [] });
      let after: CompileResult | null = null;
      let opportunity: NonNullable<ScenarioDecisions["compile"]>["opportunity"] = null;
      if (s.pulse && s.compile.signalSubjectMap) {
        const map = s.compile.signalSubjectMap;
        const mapped = kept.map((k) => ({ ...k, effects: k.effects.map((e) => ({ ...e, subjectIds: e.subjectIds.map((id) => map[id] ?? id) })) }));
        after = compileExperiences({ ...base, liveSignals: mapped });
        const ev = diffOpportunities(portfolio(s, w, before), portfolio(s, w, after), "signal");
        opportunity = {
          significance: ev.significance, added: ev.opportunitiesAdded.map((e) => e.candidateId),
          removed: ev.opportunitiesRemoved.map((x) => ({ candidateId: x.candidateId, reasonCodes: [...x.reasonCodes] })),
          notify: shouldNotify(ev), kind: attentionKindFor(ev), best: ev.best.after,
        };
      }
      let questions: NonNullable<ScenarioDecisions["compile"]>["questions"] = null;
      if (s.compile.questions) {
        const v = valueOfInformation(unknownsFromExperiences((after ?? before).experiences));
        questions = { ask: v.ask.map((q) => ({ key: q.key, dimension: q.dimension, value: r3(q.value) })), uncertainty: v.uncertainty.map((q) => ({ key: q.key, dimension: q.dimension, value: r3(q.value) })) };
      }
      compile = { windowId: w.id, before: compileRecord(before), after: after ? compileRecord(after) : null, opportunity, questions };
    }
  }

  // 8. replan over the day, with the executable opportunities the compile produced.
  let replan: ScenarioDecisions["replan"] = null;
  if (s.replan && s.impact) {
    const opportunities = compile ? ((s.compile?.signalSubjectMap ? compile.after : compile.before)?.experiences ?? []) : [];
    const executable = opportunities.filter((e) => e.verdict === "EXECUTABLE").map((e) => e.candidateId);
    const experiences = compileExecutables(s, windows, executable);
    const diff = replanDay({ now: s.now, day: s.day, plans: s.impact.state.plans, state: s.impact.state, conflicts, signals: kept, triggers, windows, opportunities: experiences, actorUserId: s.replan.actorUserId, constraints: s.replan.constraints });
    replan = {
      entries: diff.entries.map((e) => ({ op: e.op, planId: e.planId, experienceId: e.experienceId, reason: e.reason, toStartsAt: e.to?.startsAt ?? null, sharedMutation: e.sharedMutation })),
      counts: { ...diff.counts }, proposals: diff.proposals.map((p) => p.planId ?? p.experienceId ?? p.op), requiresUserConfirmation: diff.requiresUserConfirmation,
    };
  }

  // 9. the meeting point.
  const meeting = s.meeting ? (() => { const m = findMeetingPoint(s.meeting!); return {
    recommended: m.recommended?.candidateId ?? null, alternatives: m.alternatives.map((a) => a.candidateId),
    refused: m.refused.map((x) => ({ candidateId: x.candidateId, refusals: [...x.refusals] })), unplaced: m.unplaced.map((u) => ({ ...u })), constraintsApplied: [...m.constraintsApplied],
  }; })() : null;

  // 10. rescue and attention.
  const rescue = s.rescue.map((r) => { const p = planRescue(r.problem, r.ctx); return { problem: p.problem, severity: p.severity, declareKind: p.declare.kind, escalation: p.escalation.map((e) => ({ to: e.to, when: e.when })), safeReturn: p.safeReturn, steps: p.steps.length }; });
  const attention = s.attention.map((a) => { const d = decideAttention(a.event, a.ctx); return { label: a.label, kind: d.kind, level: d.level, unbudgetedLevel: d.unbudgetedLevel, reasons: [...d.reasons] }; });

  return {
    scenario: s.id, title: s.title, spec: [...s.spec],
    freedom: freedom ? {
      windows: freedom.windows.map((w) => ({ id: w.id, position: w.position, beginsAt: w.beginsAt, endsAt: w.endsAt, durationMinutes: w.durationMinutes, certified: w.certified, reservedMinutes: w.reservedMinutes, hardConstraints: w.hardConstraints.map((h) => h.kind) })),
      conflicts: freedom.conflicts.map(conflictRecord), unplacedCommitmentIds: [...freedom.unplacedCommitmentIds],
    } : null,
    planOverlaps: overlaps.map(conflictRecord),
    health: { level: health.health, reasons: health.reasons.map((r) => ({ code: r.code, level: r.level, subjectIds: [...r.subjectIds] })), priority: { mode: priority.mode, priority: [...priority.priority], suppression: { commercial: priority.suppression.commercial, discovery: priority.suppression.discovery, reason: priority.suppression.reason } } },
    pulse: pulse ? { kept: pulse.kept.map((k) => ({ kind: k.kind, subjectId: k.subjectId, effects: k.effects.map((e) => ({ kind: e.kind, subjectIds: [...e.subjectIds] })), relevance: [...k.relevance] })), dropped: pulse.dropped.map((d) => ({ kind: d.kind, subjectId: d.subjectId, reason: d.reason })) } : null,
    triggers: s.triggers ? triggers.map((t) => ({ kind: t.kind, fired: t.fired, affectedIds: [...t.affectedIds], participantIds: [...t.participantIds], magnitude: t.magnitude })) : null,
    urgency, impact, replan, compile, meeting, rescue, attention,
  };
}

/**
 * The replan wants ExecutableTripExperience objects for the fallback add; the
 * compile step above already produced them. Re-run the compile deterministically
 * for the executable set rather than threading the objects through the record.
 */
function compileExecutables(s: TripScenario, windows: FreedomWindow[], executableIds: string[]): ExecutableTripExperience[] {
  if (!s.compile || executableIds.length === 0) return [];
  const w = windows.find((x) => x.position === s.compile!.windowPosition);
  if (!w) return [];
  const kept = s.pulse ? projectSignals(s.pulse.signals, s.pulse.ctx).kept : [];
  const map = s.compile.signalSubjectMap ?? {};
  const mapped = kept.map((k) => ({ ...k, effects: k.effects.map((e) => ({ ...e, subjectIds: e.subjectIds.map((id) => map[id] ?? id) })) }));
  const r = compileExperiences({ now: s.now, window: w, origin: s.compile.origin, participants: s.compile.participants, candidates: s.compile.candidates, liveSignals: s.compile.signalSubjectMap ? mapped : [], travel: travelEstimator, goals: s.compile.goals, preferences: s.compile.preferences, nextCommitment: s.compile.nextCommitment, prepMinutes: s.compile.prepMinutes });
  return r.experiences.filter((e) => e.verdict === "EXECUTABLE" && executableIds.includes(e.candidateId));
}

export function runTripScenarioCorpus(): ScenarioDecisions[] {
  return tripScenarioCorpus().map(runTripScenario);
}

/** JSON with every object's keys sorted, so two records of the same decisions are the same bytes. */
export function canonicalJson(value: unknown, indent = 2): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(sort(value), null, indent);
}

const HEALTH_RANK: Record<string, number> = { HEALTHY: 0, ATTENTION: 1, AT_RISK: 2, DISRUPTED: 3 };
const ATTENTION_RANK: Record<string, number> = { IGNORE: 0, PASSIVE: 1, SURFACE: 2, NOTIFY: 3, INTERRUPT: 4 };

/**
 * §24 "increased/decreased conservatism", countable. Every "no" the planner
 * said counts one: a conflict, a refusal, a fired trigger, an urgent band, an
 * infeasible or non-executable verdict, a suppressed discovery, a confirmation
 * demanded, a cancel, an interruption. Higher = more conservative.
 */
export function conservatismScore(d: ScenarioDecisions): number {
  let n = 0;
  n += (d.freedom?.conflicts.length ?? 0) + d.planOverlaps.length + (d.freedom?.unplacedCommitmentIds.length ?? 0);
  n += HEALTH_RANK[d.health.level] ?? 0;
  n += d.health.priority.suppression.discovery ? 1 : 0;
  n += d.health.priority.suppression.commercial ? 1 : 0;
  n += d.pulse?.dropped.length ?? 0;
  n += (d.triggers ?? []).filter((t) => t.fired).length;
  n += d.urgency.filter((u) => u.band === "high" || u.band === "critical").length;
  for (const i of d.impact ?? []) n += (i.feasibility === "INFEASIBLE" ? 1 : 0) + (i.feasibility === "UNKNOWN" ? 1 : 0) + (i.requiresUserConfirmation ? 1 : 0) + i.conflicts.length;
  if (d.replan) n += (d.replan.counts["cancel"] ?? 0) + (d.replan.counts["move"] ?? 0) + (d.replan.requiresUserConfirmation ? 1 : 0);
  if (d.compile) {
    for (const c of [d.compile.before, d.compile.after]) if (c) n += (c.counts["NOT_EXECUTABLE"] ?? 0) + (c.counts["UNCERTAIN"] ?? 0);
    n += d.compile.opportunity?.removed.length ?? 0;
    n += d.compile.questions?.ask.length ?? 0;
  }
  if (d.meeting) n += d.meeting.refused.length + d.meeting.unplaced.length + (d.meeting.recommended ? 0 : 1);
  for (const r of d.rescue) n += r.escalation.filter((e) => e.when === "now").length + (r.severity === "critical" ? 1 : 0);
  n += d.attention.filter((a) => (ATTENTION_RANK[a.level] ?? 0) >= ATTENTION_RANK["NOTIFY"]).length;
  return n;
}

/** The engines a record actually carries a verdict from (for the corpus-coverage assertion). */
export function enginesExercised(d: ScenarioDecisions): DecisionEngine[] {
  const out: DecisionEngine[] = ["health"];
  if (d.freedom) out.push("freedom");
  if (d.pulse) out.push("pulse");
  if (d.triggers) out.push("triggers");
  if (d.urgency.length > 0) out.push("urgency");
  if (d.impact && d.impact.length > 0) out.push("impact");
  if (d.replan) out.push("replan");
  if (d.compile) out.push("compile");
  if (d.compile?.opportunity) out.push("opportunity");
  if (d.compile?.questions) out.push("questions");
  if (d.meeting) out.push("meeting");
  if (d.rescue.length > 0) out.push("rescue");
  if (d.attention.length > 0) out.push("attention");
  return out;
}
