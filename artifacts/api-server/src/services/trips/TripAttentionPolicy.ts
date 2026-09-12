/**
 * Trips spec §11.4 — the attention model, PURE.
 *
 *   IGNORE | PASSIVE | SURFACE | NOTIFY | INTERRUPT
 *   "Trip events must pass an attention policy. Do not convert every social
 *    or live-intel change into a push notification."
 *
 * The five levels are a COST ladder, not an urgency ladder (census-trips
 * TR199 — the platform's 'urgent | important | normal | low' expresses how
 * important a thing is; this expresses what it may cost the traveller):
 *
 *   IGNORE     nothing is recorded for the viewer; the event is noise to them
 *   PASSIVE    recorded; visible only if the viewer goes looking (a ledger row, a count)
 *   SURFACE    shown in-app on the trip's own surfaces (Today, the crew list); no push
 *   NOTIFY     a push notification, subject to quiet hours and the rate budget
 *   INTERRUPT  a push that ignores quiet hours and the budget — safety, or a
 *              deadline the viewer can still act on
 *
 * Every trip push in this codebase goes through lib/tripPush.ts, which calls
 * `decideAttention` and honours the level. §21.1's
 * `notification_actionability_rate` is derived from the counters that file
 * records (sent vs acted), and this policy's decisions are counted per level
 * so "how much did we suppress" is a number, not a feeling.
 */
import type { AttentionState } from "./TripSignals.js";

export const ATTENTION_LEVELS = ["IGNORE", "PASSIVE", "SURFACE", "NOTIFY", "INTERRUPT"] as const;
export type AttentionLevel = (typeof ATTENTION_LEVELS)[number];

export const SIGNIFICANCES = ["none", "low", "medium", "high", "critical"] as const;
export type Significance = (typeof SIGNIFICANCES)[number];

export interface AttentionEvent {
  /** A stable event name: the push `data.type`, a kernel event type, an opportunity kind. */
  kind: string;
  significance: Significance;
  /** The viewer is a party to it (their invite, their request, their commitment), not an onlooker. */
  affectsViewer: boolean;
  /** There is something the viewer can DO about it. */
  actionable: boolean;
  /** ISO. When the viewer's ability to act runs out, if it does. */
  deadlineAt?: string | null;
  /** A safety event (§17.4). Always INTERRUPT. */
  safety?: boolean;
}

export interface AttentionContext {
  now: number;
  /** §17.2's mode for the trip, from TripHealth.prioritySwitch. */
  mode: AttentionState;
  /** Pushes already NOTIFY'd/INTERRUPT'd to this viewer in the last hour. */
  recentNotifyCount: number;
  /** The viewer's quiet hours are in effect (CompassNotificationEngine.isQuietHours). */
  quietHours: boolean;
}

export const ATTENTION_REASON_CODES = [
  "SAFETY", "SAFETY_EVENT_MODE_SUPPRESSES", "AT_RISK_MODE_SUPPRESSES_DISCOVERY",
  "NO_SIGNIFICANCE", "LOW_SIGNIFICANCE", "MEDIUM_SIGNIFICANCE", "HIGH_SIGNIFICANCE", "CRITICAL_SIGNIFICANCE",
  "ONLOOKER", "ACTIONABLE_DEADLINE_SOON", "ACTIONABLE_DEADLINE_IMMINENT", "DEADLINE_PASSED",
  "RATE_BUDGET_EXHAUSTED", "QUIET_HOURS",
] as const;
export type AttentionReasonCode = (typeof ATTENTION_REASON_CODES)[number];

export interface AttentionDecision {
  level: AttentionLevel;
  reasons: AttentionReasonCode[];
  /** The level before the budget and quiet hours were applied, so the suppression is visible. */
  unbudgetedLevel: AttentionLevel;
  kind: string;
}

/** NOTIFY-class pushes per viewer per hour before a NOTIFY becomes a SURFACE. INTERRUPT is exempt. */
export const NOTIFY_BUDGET_PER_HOUR = 5;
export const DEADLINE_SOON_MS = 2 * 60 * 60 * 1000;
export const DEADLINE_IMMINENT_MS = 30 * 60 * 1000;

const RANK: Record<AttentionLevel, number> = { IGNORE: 0, PASSIVE: 1, SURFACE: 2, NOTIFY: 3, INTERRUPT: 4 };

/** Event kinds that are discovery/social by nature — what §17.2 suppresses when a trip is AT_RISK. */
export const DISCOVERY_EVENT_KINDS: readonly string[] = [
  "opportunity_added", "saved_idea_better_now", "meetup_opportunity", "friend_nearby", "crowd_rising", "review_prompt",
];

export function decideAttention(e: AttentionEvent, ctx: AttentionContext): AttentionDecision {
  const reasons: AttentionReasonCode[] = [];
  let level: AttentionLevel;

  if (e.safety) {
    reasons.push("SAFETY");
    return { level: "INTERRUPT", reasons, unbudgetedLevel: "INTERRUPT", kind: e.kind };
  }

  // §17.2: under a safety event nothing else may cost the viewer attention;
  // under AT_RISK the discovery-flavoured events may not.
  if (ctx.mode === "SAFETY_EVENT") {
    reasons.push("SAFETY_EVENT_MODE_SUPPRESSES");
    return { level: "PASSIVE", reasons, unbudgetedLevel: "PASSIVE", kind: e.kind };
  }
  if (ctx.mode === "AT_RISK" && DISCOVERY_EVENT_KINDS.includes(e.kind)) {
    reasons.push("AT_RISK_MODE_SUPPRESSES_DISCOVERY");
    return { level: "PASSIVE", reasons, unbudgetedLevel: "PASSIVE", kind: e.kind };
  }

  switch (e.significance) {
    case "none": reasons.push("NO_SIGNIFICANCE"); level = "IGNORE"; break;
    case "low": reasons.push("LOW_SIGNIFICANCE"); level = "PASSIVE"; break;
    case "medium": reasons.push("MEDIUM_SIGNIFICANCE"); level = "SURFACE"; break;
    case "high": reasons.push("HIGH_SIGNIFICANCE"); level = "NOTIFY"; break;
    case "critical": reasons.push("CRITICAL_SIGNIFICANCE"); level = "NOTIFY"; break;
  }

  // An onlooker's high-significance event is a SURFACE: "X joined" matters to
  // the host it was addressed to, and is a list entry to everyone else.
  if (!e.affectsViewer && RANK[level] >= RANK.NOTIFY) { reasons.push("ONLOOKER"); level = "SURFACE"; }

  // A deadline the viewer can act on raises the level; one that has passed lowers it.
  const deadline = e.deadlineAt ? Date.parse(e.deadlineAt) : NaN;
  if (e.actionable && e.affectsViewer && Number.isFinite(deadline)) {
    const left = deadline - ctx.now;
    if (left <= 0) { reasons.push("DEADLINE_PASSED"); level = RANK[level] > RANK.SURFACE ? "SURFACE" : level; }
    else if (left <= DEADLINE_IMMINENT_MS) { reasons.push("ACTIONABLE_DEADLINE_IMMINENT"); level = "INTERRUPT"; }
    else if (left <= DEADLINE_SOON_MS && RANK[level] < RANK.NOTIFY) { reasons.push("ACTIONABLE_DEADLINE_SOON"); level = "NOTIFY"; }
  }
  if (e.significance === "critical" && e.affectsViewer && level !== "INTERRUPT" && ctx.mode === "AT_RISK") level = "INTERRUPT";

  const unbudgetedLevel = level;
  if (level === "NOTIFY") {
    if (ctx.recentNotifyCount >= NOTIFY_BUDGET_PER_HOUR) { reasons.push("RATE_BUDGET_EXHAUSTED"); level = "SURFACE"; }
    else if (ctx.quietHours && !reasons.includes("ACTIONABLE_DEADLINE_SOON")) { reasons.push("QUIET_HOURS"); level = "SURFACE"; }
  }
  return { level, reasons, unbudgetedLevel, kind: e.kind };
}

/** A push may be sent only at these two levels. */
export function mayPush(level: AttentionLevel): boolean {
  return level === "NOTIFY" || level === "INTERRUPT";
}

/**
 * The profile of every trip push this codebase sends, by its `data.type`.
 * Adding a push means adding a row here — lib/tripPush.ts refuses a kind it
 * does not know, so a new site cannot bypass the policy by omission.
 */
export const TRIP_PUSH_EVENT_PROFILES: Readonly<Record<string, Omit<AttentionEvent, "kind" | "deadlineAt">>> = {
  // Directed at the recipient, with something to do: the invite, the request.
  trip_invite_received:       { significance: "high",   affectsViewer: true,  actionable: true },
  trip_join_request_received: { significance: "high",   affectsViewer: true,  actionable: true },
  // Directed outcomes of the recipient's own act.
  trip_invite_accepted:       { significance: "high",   affectsViewer: true,  actionable: false },
  trip_invite_declined:       { significance: "high",   affectsViewer: true,  actionable: false },
  trip_join_approved:         { significance: "high",   affectsViewer: true,  actionable: false },
  trip_join_declined:         { significance: "high",   affectsViewer: true,  actionable: false },
  // Changes the recipient's plans.
  trip_cancelled:             { significance: "critical", affectsViewer: true, actionable: false },
  trip_24h_reminder:          { significance: "high",   affectsViewer: true,  actionable: true },
  // Informational; the trip's own surfaces carry it. §21.3: not screen time.
  trip_archived:              { significance: "medium", affectsViewer: true,  actionable: false },
  review_prompt:              { significance: "medium", affectsViewer: true,  actionable: true },
  // §16 / §13.3, when the pulse or the opportunity engine asks.
  opportunity_added:          { significance: "medium", affectsViewer: true,  actionable: true },
  opportunity_removed:        { significance: "medium", affectsViewer: true,  actionable: false },
  plan_invalidated:           { significance: "high",   affectsViewer: true,  actionable: true },
  commitment_at_risk:         { significance: "critical", affectsViewer: true, actionable: true },
  meetup_opportunity:         { significance: "medium", affectsViewer: true,  actionable: true },
  trip_disrupted:             { significance: "critical", affectsViewer: true, actionable: true },
  safety_needs_help:          { significance: "critical", affectsViewer: true, actionable: true, safety: true },
};
