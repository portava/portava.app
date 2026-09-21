/**
 * opportunityEngine — Sensing §5's OPPORTUNITY engine and §6's stage of the
 * same name:
 *
 *   Owns:          user-specific action relevance
 *   Must not claim: canonical world truth
 *   Primary output: OpportunityProjection
 *
 *   CONTEXT KERNEL  →  OPPORTUNITY ENGINE  →  FEATURE-SPECIFIC PROJECTIONS
 *                                             MAP · DISCOVERY · WALL · HOME ·
 *                                             COMPASS
 *
 * Census S56 found no such stage — "each surface builds candidates directly" —
 * and S46 found the same gap from the object's side: "Wall has a
 * `contextual_opportunity` object type and Compass has recommendations, but
 * each surface builds its own; there is no shared Opportunity engine or
 * projection". This is the shared one.
 *
 * ── IT REIMPLEMENTS NO ENGINE (§5 "surfaces consume projections") ────────────
 * The decision whether a subject is worth acting on NOW is already an engine in
 * this tree — lib/compassDecision, §10's GO NOW · GO SOON · WAIT · STAY ·
 * SWITCH · SKIP · RETURN, with safety first, the live-reading rule, friction,
 * intent compatibility, peak interception and the switching cost. This stage
 * CALLS it, once per subject, and translates its verdict into a projection. It
 * does not restate one rule of it. Likewise the world reading is lib/crowdState
 * and lib/forecastState, and the relevance weights are lib/attentionEngine's
 * own RELEVANCE_WEIGHT table — reused, not re-spelt.
 *
 * ── MUST NOT CLAIM CANONICAL WORLD TRUTH ─────────────────────────────────────
 * An OpportunityProjection carries: a canonical subject id, a kind, a
 * relevance to THIS request, the reasons, the §18.2 window the evidence
 * supports, the §5.1 truth block OF THAT EVIDENCE, and the claim refs. It
 * carries NO world value — no density, no trajectory, no vibe, no expected
 * level. A surface that wants to render what the world is reads the world
 * state (lib/crowdState / the Map's ExperienceState); an opportunity only ever
 * says "this may be worth doing, and here is what that rests on".
 * `opportunityWorldValueKeys` is the live guard for that, not a comment: the
 * route runs it before serializing and refuses the response if it ever finds a
 * world value on a projection.
 *
 * ── SAFETY OUTRANKS OPPORTUNITY (§20) ────────────────────────────────────────
 * A subject the kernel's SafetyContext suppresses yields NO projection at any
 * relevance — it is removed before ranking, not ranked lower — and the
 * suppression is reported as a refusal so the caller can tell it from silence.
 *
 * ── SILENCE IS REPORTED, NEVER IMPLIED (§20) ─────────────────────────────────
 * Every subject that produces no opportunity produces a REFUSAL naming why:
 * suppressed, could-not-look, no reading, waiting on the window, the decision's
 * own reason. "We looked and there is nothing" and "we could not look" are
 * different answers and are never spelled the same way.
 *
 * PURE. No I/O, no clock of its own (`nowMs` is injected), no identity.
 */
import { RELEVANCE_WEIGHT } from "./attentionEngine.js";
import {
  decideCompass,
  experienceValue,
  summariseLiveState,
  type CompassDecision,
  type DecisionReason,
  type DecisionSubject,
  type PeakInterception,
} from "./compassDecision.js";
import type { ContextKernel, SubjectWorldContext } from "./contextKernel.js";
import type { TemporalEnvelope, TruthMetadata } from "./experienceTruth.js";

/** The kinds an opportunity may take. Each names the decision it rests on. */
export const OPPORTUNITY_KINDS = ["go_now", "switch_now", "return_window", "opening_window"] as const;
export type OpportunityKind = (typeof OPPORTUNITY_KINDS)[number];

/** Decision → kind. Only these four decisions are opportunities; the rest are refusals. */
export const KIND_OF_DECISION: Readonly<Partial<Record<CompassDecision, OpportunityKind>>> = Object.freeze({
  GO_NOW: "go_now",
  SWITCH: "switch_now",
  RETURN: "return_window",
  GO_SOON: "opening_window",
});

/**
 * Base relevance per kind, before the user-specific factors. Tunables, and
 * documented as such: the SHAPE (a live reading outranks a forecast-backed
 * window) is the requirement, the exact numbers are not an owner ruling.
 */
export const BASE_RELEVANCE: Readonly<Record<OpportunityKind, number>> = Object.freeze({
  go_now: 0.8,
  switch_now: 0.7,
  return_window: 0.6,
  opening_window: 0.5,
});

/** Multiplier applied when the viewer's arrival against the window cannot be computed. */
export const UNKNOWN_INTERCEPTION_FACTOR = 0.8;
/** Multiplier applied when no intent was declared: not a penalty for the place, an absence of a reason to boost. */
export const UNKNOWN_INTENT_FACTOR = 0.8;
/** Multiplier applied when the subject is the trip's next stop. Capped at 1 afterwards. */
export const TRIP_PATH_FACTOR = 1.1;

export type OpportunityReason =
  | "live_reading"
  | "forecast_window"
  | "intent_compatible"
  | "intent_unknown"
  | "interception_unknown"
  | "on_trip_path"
  | "already_seen";

export type OpportunityRefusalReason =
  | "safety_suppressed"
  | "live_intelligence_unavailable"
  | "no_opportunity"
  | "not_in_world_context";

export interface OpportunityRefusal {
  subjectId: string;
  reason: OpportunityRefusalReason;
  /** The decision that produced it, when there was one — never invented. */
  decision: CompassDecision | null;
  decisionReasons: DecisionReason[];
}

/** §5 / §19 `OpportunityProjection`: user-specific action relevance, and nothing about the world. */
export interface OpportunityProjection {
  subjectId: string;
  kind: OpportunityKind;
  /** 0..1 for THIS request. Not stored, not a score about the place. */
  relevance: number;
  reasons: OpportunityReason[];
  /** The engine's verdict this projection translates. */
  decision: CompassDecision;
  decisionReasons: DecisionReason[];
  /** §18.2: the window the evidence supports, plus predicted_for for a forecast-backed one. */
  window: TemporalEnvelope;
  /** §5.1 metadata OF THE EVIDENCE — weakest on every axis, never upgraded here. */
  truth: TruthMetadata;
  /** Whether the viewer can reach it before the window decays; null ⇒ unknown. */
  reachable: boolean | null;
  /** Snapshot ids the decision rested on. Opaque; never a contributor. */
  claimRefs: string[];
}

export interface OpportunityResult {
  opportunities: OpportunityProjection[];
  refusals: OpportunityRefusal[];
}

/**
 * Keys that would make a projection a claim about the world. The guard is
 * exported and RUN (by the route, before serializing), not merely asserted in a
 * suite: a projection that ever grows one of these is refused on the wire.
 */
export const FORBIDDEN_WORLD_VALUE_KEYS: readonly string[] = Object.freeze([
  "density",
  "level",
  "crowd",
  "crowdLevel",
  "momentum",
  "trajectory",
  "vibe",
  "vibeState",
  "energy",
  "expectedDensity",
  "forecast",
  "activity",
  "queue",
  "occupancy",
  "headcount",
  "sourceCount",
  "distinctActors",
]) as readonly string[];

/** World-value keys found on a projection (recursively). Empty, always — enforced by the route. */
export function opportunityWorldValueKeys(value: unknown, path: string[] = []): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => opportunityWorldValueKeys(v, [...path, String(i)]));
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_WORLD_VALUE_KEYS.includes(k)) out.push([...path, k].join("."));
    out.push(...opportunityWorldValueKeys(v, [...path, k]));
  }
  return out;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function subjectOf(kernel: ContextKernel, subjectId: string | null): SubjectWorldContext | null {
  if (!subjectId) return null;
  return kernel.world.subjects.find((s) => s.subjectId === subjectId) ?? null;
}

function decisionSubject(s: SubjectWorldContext): DecisionSubject {
  return { subjectId: s.subjectId, envelopes: s.envelopes, readable: s.readable };
}

/**
 * The window an opportunity is good for. A live-reading opportunity inherits the
 * crowd evidence's own window; a forecast-backed one (GO SOON) inherits the
 * forecast's, `predicted_for` and all — which is exactly why §18.2's envelope is
 * shared rather than re-declared per domain.
 */
function windowFor(s: SubjectWorldContext, kind: OpportunityKind): TemporalEnvelope {
  if (kind === "opening_window" && s.forecast) return s.forecast.temporal;
  return s.evidenceWindow;
}

function truthFor(s: SubjectWorldContext, kind: OpportunityKind): TruthMetadata {
  if (kind === "opening_window" && s.forecast) return s.forecast.truth;
  return s.truth;
}

export interface BuildOpportunitiesOptions {
  /** Ids the client says it has already shown. Novelty only; never stored. */
  seenIds?: readonly string[];
}

/**
 * Run the stage over every subject in the kernel's world context. Deterministic:
 * ordered by relevance descending, ties broken by subject id.
 */
export function buildOpportunities(kernel: ContextKernel, nowMs: number, opts: BuildOpportunitiesOptions = {}): OpportunityResult {
  const opportunities: OpportunityProjection[] = [];
  const refusals: OpportunityRefusal[] = [];
  const seen = new Set(opts.seenIds ?? kernel.attention.seenIds ?? []);
  const suppressed = new Set(kernel.safety.suppressedSubjectIds);
  const current = subjectOf(kernel, kernel.experience?.currentSubjectId ?? null);

  for (const s of kernel.world.subjects) {
    // Safety first, before any ranking exists to be influenced.
    if (suppressed.has(s.subjectId)) {
      refusals.push({ subjectId: s.subjectId, reason: "safety_suppressed", decision: null, decisionReasons: [] });
      continue;
    }

    const decision = decideCompass(
      {
        candidate: decisionSubject(s),
        current:
          current && current.subjectId !== s.subjectId
            ? { ...decisionSubject(current), sinceMinutes: kernel.experience?.currentSinceMinutes ?? null }
            : null,
        returnSubjectId: kernel.experience?.leftSubjectId ?? null,
        intent: kernel.user.intent,
        etaMinutes: kernel.spatial.etaMinutesBySubject[s.subjectId] ?? null,
        queueToleranceMinutes: kernel.user.queueToleranceMinutes,
      },
      nowMs,
    );

    const kind = KIND_OF_DECISION[decision.decision];
    if (!kind) {
      refusals.push({
        subjectId: s.subjectId,
        reason: s.readable ? "no_opportunity" : "live_intelligence_unavailable",
        decision: decision.decision,
        decisionReasons: decision.reasons,
      });
      continue;
    }

    const reasons: OpportunityReason[] = [];
    let relevance = BASE_RELEVANCE[kind] * (RELEVANCE_WEIGHT[kernel.user.relevance] ?? 0);

    // Intent compatibility — the decision engine's OWN intent-relative value,
    // never a second notion of what a viewer wants.
    const value = experienceValue(summariseLiveState(decisionSubject(s), nowMs), kernel.user.intent);
    if (value === null) {
      relevance *= UNKNOWN_INTENT_FACTOR;
      reasons.push("intent_unknown");
    } else {
      relevance *= 0.5 + 0.5 * clamp01(value);
      reasons.push("intent_compatible");
    }

    reasons.push(kind === "opening_window" ? "forecast_window" : "live_reading");

    const interception: PeakInterception = decision.interception;
    if (interception.reachable === null) {
      relevance *= UNKNOWN_INTERCEPTION_FACTOR;
      reasons.push("interception_unknown");
    }

    if (kernel.trip?.nextStopSubjectId && kernel.trip.nextStopSubjectId === s.subjectId) {
      relevance *= TRIP_PATH_FACTOR;
      reasons.push("on_trip_path");
    }

    if (seen.has(s.subjectId)) reasons.push("already_seen");

    opportunities.push({
      subjectId: s.subjectId,
      kind,
      relevance: clamp01(relevance),
      reasons,
      decision: decision.decision,
      decisionReasons: decision.reasons,
      window: windowFor(s, kind),
      truth: truthFor(s, kind),
      reachable: interception.reachable,
      claimRefs: decision.candidate.claimRefs,
    });
  }

  opportunities.sort((a, b) => (b.relevance - a.relevance) || a.subjectId.localeCompare(b.subjectId));
  return { opportunities, refusals };
}

// ── Feature-specific projections (§6's last stage before the surfaces) ────────

export const OPPORTUNITY_SURFACES = ["map", "discovery", "wall", "home", "compass"] as const;
export type OpportunitySurface = (typeof OPPORTUNITY_SURFACES)[number];

/**
 * Which fields each surface receives. A surface projection may DROP fields and
 * may never ADD one — the whole point of the stage is that the surfaces stop
 * computing their own. `projectForSurface` takes the subset from the built
 * projection, so a value cannot appear on a surface that the engine did not
 * produce.
 */
export const SURFACE_FIELDS: Readonly<Record<OpportunitySurface, readonly (keyof OpportunityProjection)[]>> = Object.freeze({
  map: ["subjectId", "kind", "relevance", "truth"],
  discovery: ["subjectId", "kind", "relevance", "reasons", "truth"],
  wall: ["subjectId", "kind", "relevance", "window", "truth"],
  home: ["subjectId", "kind", "relevance", "reasons", "window", "truth", "reachable"],
  compass: ["subjectId", "kind", "relevance", "reasons", "decision", "decisionReasons", "window", "truth", "reachable", "claimRefs"],
});

export type SurfaceProjection = Partial<OpportunityProjection> & { subjectId: string };

/** Reshape for one surface. Pure subsetting: never a new key, never a new value. */
export function projectForSurface(
  projections: readonly OpportunityProjection[],
  surface: OpportunitySurface,
): SurfaceProjection[] {
  const fields = SURFACE_FIELDS[surface];
  return projections.map((p) => {
    const out: Record<string, unknown> = {};
    for (const f of fields) out[f] = p[f];
    return out as SurfaceProjection;
  });
}
