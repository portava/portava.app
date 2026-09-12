/**
 * Trips spec §13.3 — Opportunity events, PURE (census-trips TR244–TR253).
 *
 *   OpportunityEvent { trigger previousFreedomWindow? newFreedomWindow?
 *                      opportunitiesAdded[] opportunitiesRemoved[] significance
 *                      expiresAt reasonCodes[] }
 *
 *   "Notify only when the action universe changes enough to matter. 'Weather
 *    changed' is raw data; 'your saved rooftop is no longer viable, but an
 *    indoor plan now fits' is an opportunity-state change."
 *
 * A PORTFOLIO is what the compiler said about one window at one instant:
 * the EXECUTABLE experiences. An OPPORTUNITY EVENT is the diff between two
 * portfolios of the same trip — what became possible, what stopped being —
 * with a significance that is a function of that diff and nothing else:
 *
 *   none      the executable set is unchanged
 *   low       something changed and the best option did not
 *   medium    the best option changed, or an added one serves an open goal
 *   high      an executable option was removed for a hard reason (closed,
 *             weather, queue) — the spec's rooftop — or a fallback appeared
 *             for one that was
 *   critical  the window itself disappeared or every option was removed
 *
 * `shouldNotify` is significance ≥ high. The attention policy (§11.4)
 * decides the level from there; this file does not push.
 */
import type { FreedomWindow } from "./TripFreedomEngine.js";
import type { ExecutableTripExperience, ExperienceReasonCode } from "./TripExperienceCompiler.js";

export const OPPORTUNITY_TRIGGERS = ["initial", "window_changed", "signal", "plan_changed", "commitment_changed", "expired", "recompute"] as const;
export type OpportunityTrigger = (typeof OPPORTUNITY_TRIGGERS)[number];

export const OPPORTUNITY_SIGNIFICANCES = ["none", "low", "medium", "high", "critical"] as const;
export type OpportunitySignificance = (typeof OPPORTUNITY_SIGNIFICANCES)[number];

export interface OpportunityPortfolio {
  tripId: string;
  windowId: string;
  window: Pick<FreedomWindow, "id" | "beginsAt" | "endsAt" | "durationMinutes" | "certified" | "participants"> | null;
  /** EXECUTABLE experiences only, in the compiler's order. */
  executable: ExecutableTripExperience[];
  /** Everything else, so a removal can say why. */
  notExecutable: Pick<ExecutableTripExperience, "id" | "candidateId" | "name" | "verdict" | "reasonCodes">[];
  computedAt: string;
  sourceTripVersion: number | null;
}

export interface RemovedOpportunity {
  id: string;
  candidateId: string;
  name: string;
  /** Why it is no longer executable — from the new compilation when it is still a candidate, else "candidate gone". */
  reasonCodes: ExperienceReasonCode[];
  verdictNow: "NOT_EXECUTABLE" | "UNCERTAIN" | "GONE";
}

export const OPPORTUNITY_REASON_CODES = [
  "OPPORTUNITY_WINDOW_OPENED", "OPPORTUNITY_WINDOW_CLOSED", "OPPORTUNITY_WINDOW_CHANGED",
  "OPPORTUNITY_ADDED", "OPPORTUNITY_REMOVED", "OPPORTUNITY_BEST_CHANGED",
  "OPPORTUNITY_GOAL_SERVED", "OPPORTUNITY_FALLBACK_AVAILABLE", "OPPORTUNITY_ALL_REMOVED",
  "OPPORTUNITY_UNCHANGED",
] as const;
export type OpportunityReasonCode = (typeof OPPORTUNITY_REASON_CODES)[number];

export interface OpportunityEvent {
  trigger: OpportunityTrigger;
  tripId: string;
  windowId: string;
  previousFreedomWindow: OpportunityPortfolio["window"] | null;
  newFreedomWindow: OpportunityPortfolio["window"] | null;
  opportunitiesAdded: ExecutableTripExperience[];
  opportunitiesRemoved: RemovedOpportunity[];
  significance: OpportunitySignificance;
  /** The window's end: after it, the event is history. */
  expiresAt: string;
  reasonCodes: (OpportunityReasonCode | ExperienceReasonCode)[];
  /** The top executable before and after, by id. */
  best: { before: string | null; after: string | null };
  detail: string;
}

/** Hard removal reasons — the "no longer viable" of the spec's example. */
export const HARD_REMOVAL_REASONS: readonly ExperienceReasonCode[] = [
  "EXPERIENCE_CLOSED_BEFORE_ARRIVAL", "EXPERIENCE_CLOSES_DURING_STAY", "EXPERIENCE_CLOSED_LIVE",
  "EXPERIENCE_QUEUE_EXCEEDS_WINDOW", "EXPERIENCE_UNSAFE_DENSITY", "EXPERIENCE_WEATHER_INVALIDATED", "TRIP_TEMPORAL_INFEASIBLE",
];

const RANK: Record<OpportunitySignificance, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
function atLeast(a: OpportunitySignificance, b: OpportunitySignificance): OpportunitySignificance { return RANK[a] >= RANK[b] ? a : b; }

function sameWindow(a: OpportunityPortfolio["window"], b: OpportunityPortfolio["window"]): boolean {
  if (!a || !b) return a === b;
  return a.beginsAt === b.beginsAt && a.endsAt === b.endsAt && a.certified === b.certified;
}

export function diffOpportunities(previous: OpportunityPortfolio | null, next: OpportunityPortfolio, trigger: OpportunityTrigger): OpportunityEvent {
  const prevIds = new Map((previous?.executable ?? []).map((e) => [e.id, e]));
  const nextIds = new Map(next.executable.map((e) => [e.id, e]));
  const added = next.executable.filter((e) => !prevIds.has(e.id));
  const removed: RemovedOpportunity[] = [];
  for (const [id, e] of prevIds) {
    if (nextIds.has(id)) continue;
    const now = next.notExecutable.find((n) => n.id === id);
    removed.push({ id, candidateId: e.candidateId, name: e.name, reasonCodes: now ? [...now.reasonCodes] : [], verdictNow: now ? (now.verdict as "NOT_EXECUTABLE" | "UNCERTAIN") : "GONE" });
  }
  const reasons = new Set<OpportunityReasonCode | ExperienceReasonCode>();
  let significance: OpportunitySignificance = "none";
  const bestBefore = previous?.executable[0]?.id ?? null;
  const bestAfter = next.executable[0]?.id ?? null;

  if (!previous || !previous.window) { if (next.window) { reasons.add("OPPORTUNITY_WINDOW_OPENED"); significance = atLeast(significance, next.executable.length > 0 ? "medium" : "low"); } }
  else if (!next.window) { reasons.add("OPPORTUNITY_WINDOW_CLOSED"); significance = "critical"; }
  else if (!sameWindow(previous.window, next.window)) { reasons.add("OPPORTUNITY_WINDOW_CHANGED"); significance = atLeast(significance, "low"); }

  if (added.length > 0) { reasons.add("OPPORTUNITY_ADDED"); significance = atLeast(significance, "low"); }
  if (removed.length > 0) { reasons.add("OPPORTUNITY_REMOVED"); significance = atLeast(significance, "low"); }
  if (bestBefore !== bestAfter && (previous?.executable.length ?? 0) > 0) { reasons.add("OPPORTUNITY_BEST_CHANGED"); significance = atLeast(significance, "medium"); }
  if (added.some((e) => e.servesGoalIds.length > 0)) { reasons.add("OPPORTUNITY_GOAL_SERVED"); significance = atLeast(significance, "medium"); }
  const hardRemoved = removed.filter((r) => r.reasonCodes.some((c) => HARD_REMOVAL_REASONS.includes(c)));
  if (hardRemoved.length > 0) {
    significance = atLeast(significance, "high");
    for (const r of hardRemoved) for (const c of r.reasonCodes) if (HARD_REMOVAL_REASONS.includes(c)) reasons.add(c);
    if (added.length > 0) reasons.add("OPPORTUNITY_FALLBACK_AVAILABLE");
  }
  if ((previous?.executable.length ?? 0) > 0 && next.executable.length === 0 && next.window) { reasons.add("OPPORTUNITY_ALL_REMOVED"); significance = "critical"; }
  if (reasons.size === 0) reasons.add("OPPORTUNITY_UNCHANGED");

  const detail = significance === "none" ? "the action universe is unchanged"
    : hardRemoved.length > 0 && added.length > 0 ? `${hardRemoved.map((r) => r.name).join(", ")} no longer viable; ${added.map((a) => a.name).join(", ")} now fits`
    : hardRemoved.length > 0 ? `${hardRemoved.map((r) => r.name).join(", ")} no longer viable`
    : added.length > 0 && removed.length === 0 ? `${added.length} new option(s): ${added.slice(0, 3).map((a) => a.name).join(", ")}`
    : `${added.length} added, ${removed.length} removed`;

  return {
    trigger, tripId: next.tripId, windowId: next.windowId,
    previousFreedomWindow: previous?.window ?? null, newFreedomWindow: next.window,
    opportunitiesAdded: added, opportunitiesRemoved: removed,
    significance, expiresAt: next.window?.endsAt ?? previous?.window?.endsAt ?? next.computedAt,
    reasonCodes: [...reasons], best: { before: bestBefore, after: bestAfter }, detail,
  };
}

/** §13.3's rule, as a predicate the attention policy is handed. */
export function shouldNotify(ev: OpportunityEvent): boolean {
  return RANK[ev.significance] >= RANK.high;
}

/** The attention-policy event kind an opportunity event maps to (TRIP_PUSH_EVENT_PROFILES has each). */
export function attentionKindFor(ev: OpportunityEvent): "opportunity_added" | "opportunity_removed" | "plan_invalidated" {
  if (ev.opportunitiesRemoved.some((r) => r.reasonCodes.includes("EXPERIENCE_WEATHER_INVALIDATED"))) return "plan_invalidated";
  return ev.opportunitiesRemoved.length > 0 && ev.opportunitiesAdded.length === 0 ? "opportunity_removed" : "opportunity_added";
}
