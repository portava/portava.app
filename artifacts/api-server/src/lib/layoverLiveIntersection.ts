/**
 * layoverLiveIntersection — Sensing §11's second bullet, as a PURE engine.
 *
 * §11 (`docs/specs/…Sensing…v1.txt:155-156`): "Layover Temporal Freedom Engine
 * should intersect feasibility with live Experience value, forecast, friction
 * and safe-return constraints" and "Use peak interception: can the user reach
 * the experience before its useful window decays?"
 *
 * census-sensing S85 recorded the gap precisely: `LayoverRecommendationService`
 * and `LayoverSafetyEngine` do feasibility and safe-return, and NEITHER reads
 * `liveClaimRead`, so live experience value, forecast and friction are absent
 * from the intersection. This module is the missing half — and it is
 * deliberately NOT a second feasibility engine.
 *
 * ── HOW IT INTERSECTS, RATHER THAN COMPETING ─────────────────────────────────
 * The existing engine owns the arithmetic: travel + activity + return buffer
 * against the certified deadline. This module changes only its INPUTS and its
 * candidate set, in three ways, and then the existing engine decides:
 *
 *   FRICTION → TIME. A Live-qualified `queue.wait` is real minutes a traveller
 *   will stand still. They are added to the candidate's activity time BEFORE
 *   `assess` runs, so a 45-minute queue can make a card that was feasible on
 *   its category defaults come back CAUTION or NO_GO from the engine that
 *   already knows how to say so. Nothing here re-decides feasibility; it
 *   supplies a number the engine never had.
 *
 *   SAFETY AND A CLOSED DOOR → DROPPED. A Live-qualified `unsafe_density`
 *   drops the card outright (§16: safety outranks opportunity, and a layover
 *   card is a recommendation to GO). A Live-qualified refused walk-in drops it
 *   too: an hour of a four-hour layover spent discovering the door is shut is
 *   the failure this whole surface exists to prevent.
 *
 *   PEAK INTERCEPTION → DROPPED OR DEMOTED. If the claims that qualified will
 *   have expired before the traveller could arrive, the reason to go is gone
 *   by arrival. That is a demotion, never a promotion, and never a drop on its
 *   own — a window closing is not a door closing.
 *
 * ── WHAT IT REFUSES TO DO ────────────────────────────────────────────────────
 *   • NO COVERAGE ≠ QUIET (§2). A candidate with no live reading is returned
 *     UNCHANGED: no minutes added, no drop, no reorder. The absence of a queue
 *     report is not a report of no queue.
 *   • "COULD NOT LOOK" ≠ "SAW NOTHING" (§20). `readable: false` is labelled
 *     `unreadable` and is likewise a no-op, so a closed Live pilot can never
 *     silently shorten or lengthen anybody's layover.
 *   • BUSY ≠ GOOD (§2). Experience value is intent-relative through
 *     lib/compassDecision.experienceValue and is null without a declared
 *     intent; it only ever re-orders cards that are already feasible, and it
 *     cannot make an infeasible card feasible.
 *   • PROMOTIONAL ≠ OBSERVED (§2). Only READINGS count, by
 *     lib/compassDecision.isReading — the same rule Compass's decision and
 *     Discovery's ranking use.
 *
 * PURE. No I/O, no clock of its own, no identity. The gated read lives in the
 * service that calls this.
 */
import {
  experienceValue,
  interceptPeak,
  summariseLiveState,
  type DecisionIntent,
  type DecisionSubject,
  type PeakInterception,
} from "./compassDecision.js";
import type { TruthMetadata } from "./experienceTruth.js";
import type { LiveClaimEnvelope } from "./liveClaimRead.js";

/** Why a card was dropped. `null` on a card that survived. */
export type LayoverDropReason = "unsafe_density" | "walk_in_refused" | null;

/** Whether live intelligence had anything to say about this card. */
export type LayoverLiveEvidence = "reading" | "none" | "unreadable";

export interface LayoverLiveCandidate {
  /** Stable key of the card (the service's `recommendationKey`). */
  key: string;
  /** Canonical `places.id` for the live read; null ⇒ no subject, never looked at. */
  subjectId: string | null;
  envelopes: readonly LiveClaimEnvelope[];
  /** False ⇒ the live gates refused the read. */
  readable: boolean;
  travelTimeMin: number;
  activityTimeMin: number;
}

export interface LayoverLiveVerdict {
  key: string;
  evidence: LayoverLiveEvidence;
  /** Minutes a live queue adds to the card's activity time. 0 without a reading. */
  frictionMinutes: number;
  /** The activity time the safety engine should be given. */
  adjustedActivityMin: number;
  drop: boolean;
  dropReason: LayoverDropReason;
  /** Intent-relative value in 0..1, or null when it cannot be known. */
  experienceValue: number | null;
  /** The trajectory of the qualifying claims, when one was reported. */
  trajectory: string | null;
  /** Arrival against the earliest horizon of the claims that qualified. */
  interception: PeakInterception;
  /** True when the evidence will have expired before arrival — a demotion. */
  windowDecaysBeforeArrival: boolean;
  /** §5.1 block of the evidence, or null when there is none. */
  truth: TruthMetadata | null;
  /** Grounded reasons, in the claims' own vocabulary. Empty ⇒ nothing observed. */
  reasons: string[];
}

export interface LayoverIntersectionOptions {
  nowMs: number;
  /** The viewer's declared crowd preference, when one is known. */
  intent?: DecisionIntent | null;
  /** Claim-family TTLs for the horizon; the service passes the contracts' own. */
  ttlSecondsFor?: (claimType: string) => number | null;
}

/** A queue longer than this is treated as a full stop rather than a wait. */
export const QUEUE_CAP_MINUTES = 180;

/**
 * The layover vibe chips that map onto a CROWD PREFERENCE, and only those.
 * `food`, `shopping` and `culture` say what a traveller wants to DO, not how
 * crowded they want it to be, so they map to nothing and the experience value
 * stays null — §2's "busy ≠ good" applied to a vocabulary that was never a
 * crowd vocabulary. Inventing a mapping for them would be guessing a
 * preference from an activity.
 */
export const LAYOVER_INTENT_BY_CHIP: Readonly<Record<string, DecisionIntent>> = {
  nightlife: "high_energy",
  quiet: "quiet",
  relax: "quiet",
  social: "social",
};

/** The first chip that declares a crowd preference, or null. Order is the traveller's. */
export function intentFromVibeChips(chips: readonly string[] | null | undefined): DecisionIntent | null {
  for (const chip of chips ?? []) {
    const v = LAYOVER_INTENT_BY_CHIP[String(chip).trim().toLowerCase()];
    if (v) return v;
  }
  return null;
}

/** Grade ONE candidate. Pure. */
export function intersectOne(c: LayoverLiveCandidate, opts: LayoverIntersectionOptions): LayoverLiveVerdict {
  const nowMs = opts.nowMs;
  const subject: DecisionSubject = {
    subjectId: c.subjectId ?? c.key,
    envelopes: c.envelopes ?? [],
    readable: c.readable,
  };
  const state = summariseLiveState(subject, nowMs, opts.ttlSecondsFor);
  const interception = interceptPeak(c.travelTimeMin, state.horizonAt, nowMs);

  if (!state.live) {
    // No reading: the card is returned exactly as it arrived. The only thing
    // recorded is WHY there is no reading, which is not the same fact twice.
    return {
      key: c.key,
      evidence: c.readable ? "none" : "unreadable",
      frictionMinutes: 0,
      adjustedActivityMin: c.activityTimeMin,
      drop: false,
      dropReason: null,
      experienceValue: null,
      trajectory: null,
      interception,
      windowDecaysBeforeArrival: false,
      truth: null,
      reasons: [],
    };
  }

  const reasons: string[] = [];
  if (state.crowdLevel) reasons.push(`crowd_${state.crowdLevel}`);
  if (state.trajectory) reasons.push(`trajectory_${state.trajectory}`);

  let drop = false;
  let dropReason: LayoverDropReason = null;
  if (state.unsafe) { drop = true; dropReason = "unsafe_density"; }
  else if (state.walkIn === false) { drop = true; dropReason = "walk_in_refused"; reasons.push("walk_in_refused"); }

  const queue = state.queueMinMinutes;
  const frictionMinutes = queue !== null && queue > 0 ? Math.min(Math.round(queue), QUEUE_CAP_MINUTES) : 0;
  if (frictionMinutes > 0) reasons.push(`queue_${frictionMinutes}m`);

  return {
    key: c.key,
    evidence: "reading",
    frictionMinutes,
    adjustedActivityMin: c.activityTimeMin + frictionMinutes,
    drop,
    dropReason,
    experienceValue: experienceValue(state, opts.intent ?? null),
    trajectory: state.trajectory,
    interception,
    windowDecaysBeforeArrival: interception.reachable === false,
    truth: state.truth,
    reasons,
  };
}

export interface LayoverIntersectionOutcome {
  byKey: Map<string, LayoverLiveVerdict>;
  /** Keys dropped, with the reason, so a caller can say what happened and why. */
  dropped: Array<{ key: string; reason: Exclude<LayoverDropReason, null> }>;
  /** How many cards a live queue reading lengthened. */
  frictionAdjusted: number;
  /** How many cards had a reading at all. */
  withReadings: number;
}

export function intersectLayoverLive(
  candidates: readonly LayoverLiveCandidate[],
  opts: LayoverIntersectionOptions,
): LayoverIntersectionOutcome {
  const byKey = new Map<string, LayoverLiveVerdict>();
  const dropped: Array<{ key: string; reason: Exclude<LayoverDropReason, null> }> = [];
  let frictionAdjusted = 0;
  let withReadings = 0;
  for (const c of candidates) {
    const v = intersectOne(c, opts);
    byKey.set(c.key, v);
    if (v.drop && v.dropReason) dropped.push({ key: c.key, reason: v.dropReason });
    if (v.frictionMinutes > 0) frictionAdjusted += 1;
    if (v.evidence === "reading") withReadings += 1;
  }
  return { byKey, dropped, frictionAdjusted, withReadings };
}

/**
 * Order two surviving cards by live evidence. Returns a negative number when
 * `a` should come first. Cards WITHOUT a reading compare equal to each other
 * and to a card with one (0) — absence never re-orders anything; the caller's
 * stable sort then leaves the existing order intact. A decaying window demotes;
 * nothing here promotes a card above a feasible one it was behind for reasons
 * this engine cannot see.
 */
export function compareByLive(a: LayoverLiveVerdict | undefined, b: LayoverLiveVerdict | undefined): number {
  if (!a || !b) return 0;
  if (a.evidence !== "reading" || b.evidence !== "reading") return 0;
  if (a.windowDecaysBeforeArrival !== b.windowDecaysBeforeArrival) return a.windowDecaysBeforeArrival ? 1 : -1;
  const av = a.experienceValue;
  const bv = b.experienceValue;
  if (av === null || bv === null) return 0;
  return bv - av;
}
