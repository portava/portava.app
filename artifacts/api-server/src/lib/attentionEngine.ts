/**
 * attentionEngine — Sensing §15: "Attention Engine is mandatory: World changes
 * route through relevance, novelty, urgency, half-life, user availability,
 * interruption cost and attention budget before NOTIFY / WALL / SILENT / IGNORE."
 *
 * ── WHAT IT DECIDES, AND WHAT IT DOES NOT DO ─────────────────────────────────
 * It takes ONE world change (a WallMoment) and ONE viewer's context and answers
 * where the change goes for that viewer — and why, with every factor the spec
 * names on the decision. It sends nothing: NOTIFY is a routing decision the
 * notification path would consume, and no dispatcher consumes it yet (stated
 * in the census, not hidden here). WALL means the moment may be shown on the
 * Wall; SILENT means it is recorded and not surfaced; IGNORE means it is not
 * for this viewer at all.
 *
 * ── THE FACTORS ──────────────────────────────────────────────────────────────
 *   relevance          the viewer's relation to the subject, declared by the
 *                      caller from what it knows (a saved place, a trip stop, a
 *                      followed place, merely nearby, none). Only a saved place
 *                      or a trip stop may be interrupted for; a followed place
 *                      reaches the Wall; merely nearby reaches it only when
 *                      urgent. Personalization decides whether the change
 *                      MATTERS to the viewer; it never rewrites the change (§9).
 *   novelty            a moment the viewer has already seen is not news.
 *   urgency            from the transition kind: a safety activation first,
 *                      a peak next, a build or shift, then the rest.
 *   half-life          age over the relevance window: a moment most of the way
 *                      through its window is stale news; past it, it is none.
 *   availability       quiet hours or push off ⇒ not now; UNKNOWN (the
 *                      preferences could not be read) ⇒ not now either — an
 *                      unreadable consent is never read as consent.
 *   interruption cost  interruptions already delivered in the window.
 *   attention budget   the most NOTIFY decisions the window may hold.
 *
 * A safety activation outranks availability and the budget for a viewer with
 * a real relation to the place — the same override the notification path's
 * safety category has — but never novelty: a seen notice is a seen notice.
 *
 * PURE. No I/O, no clock of its own.
 */
import type { WallMoment, WallTransitionKind } from "./wallMoments.js";

export const ATTENTION_ROUTES = ["NOTIFY", "WALL", "SILENT", "IGNORE"] as const;
export type AttentionRoute = (typeof ATTENTION_ROUTES)[number];

export const ATTENTION_RELEVANCE = ["saved", "trip_stop", "followed", "nearby", "none"] as const;
export type AttentionRelevance = (typeof ATTENTION_RELEVANCE)[number];

/** NOTIFY decisions allowed per window, a documented tunable. */
export const ATTENTION_BUDGET_PER_WINDOW = 3;
/** The window the budget and the interruption cost are counted over. */
export const ATTENTION_WINDOW_MINUTES = 60;
/** Past this fraction of its relevance window a moment is stale news. */
export const HALF_LIFE_STALE_RATIO = 0.75;
/** Urgency at or above which a relevant, novel, available moment is NOTIFY. */
export const NOTIFY_URGENCY_FLOOR = 0.7;
/** Relevance at or above which a moment may be NOTIFY: a saved place or a trip stop, not a followed one. */
export const NOTIFY_RELEVANCE_FLOOR = 0.8;
/** Relevance at or above which a moment goes to the WALL on its own. */
export const WALL_RELEVANCE_FLOOR = 0.6;

export const RELEVANCE_WEIGHT: Readonly<Record<AttentionRelevance, number>> = {
  saved: 1.0,
  trip_stop: 1.0,
  followed: 0.6,
  nearby: 0.4,
  none: 0,
};

export const URGENCY_OF: Readonly<Record<WallTransitionKind, number>> = {
  safety_notice_activated: 1.0,
  peaking: 0.7,
  building: 0.5,
  warming: 0.4,
  crowd_shift: 0.5,
  queue_change: 0.4,
  vibe_change: 0.3,
  cooling: 0.2,
  safety_notice_cleared: 0.3,
};

export interface AttentionViewer {
  relevance: AttentionRelevance;
  seenMomentIds: ReadonlySet<string>;
  /** True = may be interrupted now; false = quiet hours or push off; null = unknown. */
  available: boolean | null;
  /** Interruptions already delivered in the window. */
  notifiesInWindow: number;
  budgetPerWindow?: number;
}

export type AttentionReason =
  | "already_seen"
  | "expired"
  | "not_relevant"
  | "safety_override"
  | "urgent_relevant_available"
  | "unavailable_deferred_to_wall"
  | "availability_unknown_deferred_to_wall"
  | "budget_exhausted_deferred_to_wall"
  | "decayed"
  | "relevant"
  | "weakly_relevant";

export interface AttentionFactors {
  relevance: number;
  novelty: boolean;
  urgency: number;
  /** age / window; > 1 past the window. */
  halfLife: number;
  availability: boolean | null;
  interruptionCost: number;
  budget: number;
}

export interface AttentionDecision {
  route: AttentionRoute;
  reasons: AttentionReason[];
  factors: AttentionFactors;
}

export function routeAttention(moment: WallMoment, viewer: AttentionViewer, nowMs: number): AttentionDecision {
  const relevance = RELEVANCE_WEIGHT[viewer.relevance] ?? 0;
  const novelty = !viewer.seenMomentIds.has(moment.id);
  const urgency = URGENCY_OF[moment.transition.kind] ?? 0;
  const from = Date.parse(moment.relevanceWindow.from);
  const until = Date.parse(moment.relevanceWindow.until);
  const window = Number.isFinite(from) && Number.isFinite(until) && until > from ? until - from : NaN;
  const halfLife = Number.isFinite(window) ? (nowMs - from) / window : Number.POSITIVE_INFINITY;
  const budget = viewer.budgetPerWindow ?? ATTENTION_BUDGET_PER_WINDOW;
  const interruptionCost = Math.max(0, viewer.notifiesInWindow);
  const factors: AttentionFactors = { relevance, novelty, urgency, halfLife, availability: viewer.available, interruptionCost, budget };
  const done = (route: AttentionRoute, ...reasons: AttentionReason[]): AttentionDecision => ({ route, reasons, factors });

  if (!novelty) return done("IGNORE", "already_seen");
  if (!(halfLife < 1)) return done("IGNORE", "expired");
  if (relevance <= 0) return done("IGNORE", "not_relevant");

  const safety = moment.transition.kind === "safety_notice_activated";
  if (safety && relevance >= NOTIFY_RELEVANCE_FLOOR) return done("NOTIFY", "safety_override");

  if (halfLife > HALF_LIFE_STALE_RATIO) return done(relevance >= WALL_RELEVANCE_FLOOR ? "SILENT" : "IGNORE", "decayed");

  if (urgency >= NOTIFY_URGENCY_FLOOR && relevance >= NOTIFY_RELEVANCE_FLOOR) {
    if (viewer.available === null) return done("WALL", "availability_unknown_deferred_to_wall");
    if (viewer.available === false) return done("WALL", "unavailable_deferred_to_wall");
    if (interruptionCost >= budget) return done("WALL", "budget_exhausted_deferred_to_wall");
    return done("NOTIFY", "urgent_relevant_available");
  }
  if (relevance >= WALL_RELEVANCE_FLOOR || (relevance >= RELEVANCE_WEIGHT.nearby && urgency >= 0.5)) return done("WALL", "relevant");
  return done("SILENT", "weakly_relevant");
}
