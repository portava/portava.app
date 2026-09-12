/**
 * Trips spec §13.1 / §13.2 — the Experience Compiler, PURE.
 *
 *   place/content + freedom window + participants + live conditions
 *   + transport + opening/queue constraints + goals/preferences
 *   + next commitment = ExecutableTripExperience
 *
 * census-trips TR224–TR243, TR413. Nothing here reads a database: the
 * projection (TripOpportunityProjection.ts) gathers the eight inputs and
 * calls `compileExperiences`. Every verdict is a function of the inputs and
 * carries the reason codes that produced it, so the ledger can explain it
 * and a scenario can replay it.
 *
 * THE THREE VERDICTS
 * ==================
 *   EXECUTABLE      fits the window with travel both ways, is open on arrival
 *                   and stays open for the minimum stay, no live condition or
 *                   accessibility constraint forbids it
 *   NOT_EXECUTABLE  a hard reason: no time, closed before arrival (§22.4),
 *                   closes during the minimum stay, queue longer than the
 *                   window, unsafe density, a participant's need unmet
 *   UNCERTAIN       something needed is unknown — travel time, coordinates,
 *                   opening hours for a place that has some — and the spec's
 *                   rule is that unknown is not safe: it is served as
 *                   UNCERTAIN, never promoted to EXECUTABLE
 *
 * §22.4 "Closed-before-arrival activity cannot remain executable" is a
 * property of `compileExperiences`: no EXECUTABLE result has an arrival
 * outside one of its opening windows. src/test/tripExperienceCompiler.test.ts
 * checks it over generated inputs.
 */
import type { FreedomWindow } from "./TripFreedomEngine.js";
import type { PulseInterpretation } from "./TripSignals.js";

// ── §13.2 activity primitives ────────────────────────────────────────────────

export const ACTIVITY_PRIMITIVES = [
  "EAT", "SEE", "MEET", "DRINK", "SHOP", "WALK", "REST", "PHOTO", "EXPLORE", "PLAY", "LEARN", "NIGHTLIFE", "TRANSIT",
] as const;
export type ActivityPrimitive = (typeof ACTIVITY_PRIMITIVES)[number];

/** Place types (Google-style, the platform's place_type strings) → the primitive they compile to. First match wins; unknown → EXPLORE. */
export const PLACE_TYPE_PRIMITIVES: readonly { pattern: RegExp; primitive: ActivityPrimitive }[] = [
  { pattern: /night ?club|club|nightlife|late_night/i, primitive: "NIGHTLIFE" },
  { pattern: /bar|pub|lounge|brewery|wine|cocktail|rooftop/i, primitive: "DRINK" },
  { pattern: /restaurant|cafe|coffee|bakery|food|diner|bistro|street_food|market_hall/i, primitive: "EAT" },
  { pattern: /museum|gallery|monument|landmark|church|temple|cathedral|castle|palace|viewpoint|lookout/i, primitive: "SEE" },
  { pattern: /library|university|workshop|class|course|tour/i, primitive: "LEARN" },
  { pattern: /shop|store|mall|market|boutique/i, primitive: "SHOP" },
  { pattern: /park|garden|beach|trail|hike|promenade|walk/i, primitive: "WALK" },
  { pattern: /spa|hotel|lodging|resort|onsen|bath|rest/i, primitive: "REST" },
  { pattern: /arcade|bowling|stadium|arena|karaoke|game|escape|amusement|zoo|aquarium/i, primitive: "PLAY" },
  { pattern: /photo|studio|observation|scenic/i, primitive: "PHOTO" },
  { pattern: /station|airport|terminal|transit|bus|metro|ferry|port/i, primitive: "TRANSIT" },
  { pattern: /meetup|meeting_point|meeting/i, primitive: "MEET" },
];

export function primitiveFor(placeType: string | null | undefined, name?: string | null): ActivityPrimitive {
  const hay = `${placeType ?? ""} ${name ?? ""}`;
  for (const { pattern, primitive } of PLACE_TYPE_PRIMITIVES) if (pattern.test(hay)) return primitive;
  return "EXPLORE";
}

// ── §13.2 per-candidate properties (TR234–TR243) ─────────────────────────────

export const INTERRUPTIBILITY = ["low", "medium", "high"] as const;
export const REVERSIBILITY = ["reversible", "partially_reversible", "irreversible"] as const;
export const COST_BANDS = ["free", "low", "medium", "high"] as const;
export const ENERGY_COSTS = ["low", "medium", "high"] as const;

export interface QueueDistribution {
  p50Minutes: number;
  p90Minutes: number;
  /** Where it came from: a live claim, a pattern, a default. */
  source: string;
}

export interface FailureRecoveryRoute {
  failure: string;
  recovery: string;
}

export interface CandidateProperties {
  minimumMinutes: number;
  idealMinutes: number;
  /** 0 = only the ideal works; 1 = anything down to the minimum is as good. */
  compressibility: number;
  interruptibility: (typeof INTERRUPTIBILITY)[number];
  reversibility: (typeof REVERSIBILITY)[number];
  costBand: (typeof COST_BANDS)[number] | null;
  energyCost: (typeof ENERGY_COSTS)[number];
  /** null = unknown, which is not "no". */
  reservationRequired: boolean | null;
  queueDistribution: QueueDistribution | null;
  /** Constraints the venue imposes: "stairs_only", "no_wheelchair", "adults_only", "loud", "standing_only", … */
  accessibilityConstraints: string[];
  failureRecoveryRoutes: FailureRecoveryRoute[];
}

/** Defaults per primitive. A candidate overrides any field it knows better. */
export const PRIMITIVE_DEFAULTS: Readonly<Record<ActivityPrimitive, CandidateProperties>> = {
  EAT:       { minimumMinutes: 45, idealMinutes: 90,  compressibility: 0.5, interruptibility: "low",    reversibility: "partially_reversible", costBand: "medium", energyCost: "low",    reservationRequired: null,  queueDistribution: null, accessibilityConstraints: [], failureRecoveryRoutes: [{ failure: "full or closed", recovery: "the next EAT candidate in the same window" }] },
  SEE:       { minimumMinutes: 30, idealMinutes: 75,  compressibility: 0.7, interruptibility: "high",   reversibility: "reversible",           costBand: "low",    energyCost: "medium", reservationRequired: null,  queueDistribution: null, accessibilityConstraints: [], failureRecoveryRoutes: [{ failure: "queue too long", recovery: "the exterior / a nearby viewpoint" }] },
  MEET:      { minimumMinutes: 20, idealMinutes: 60,  compressibility: 0.8, interruptibility: "high",   reversibility: "reversible",           costBand: "free",   energyCost: "low",    reservationRequired: false, queueDistribution: null, accessibilityConstraints: [], failureRecoveryRoutes: [{ failure: "the other party is late", recovery: "wait at a DRINK candidate within walking distance" }] },
  DRINK:     { minimumMinutes: 30, idealMinutes: 90,  compressibility: 0.7, interruptibility: "high",   reversibility: "reversible",           costBand: "medium", energyCost: "low",    reservationRequired: false, queueDistribution: null, accessibilityConstraints: [], failureRecoveryRoutes: [{ failure: "at capacity", recovery: "the next DRINK candidate" }] },
  SHOP:      { minimumMinutes: 20, idealMinutes: 60,  compressibility: 0.9, interruptibility: "high",   reversibility: "reversible",           costBand: "medium", energyCost: "low",    reservationRequired: false, queueDistribution: null, accessibilityConstraints: [], failureRecoveryRoutes: [] },
  WALK:      { minimumMinutes: 20, idealMinutes: 60,  compressibility: 0.9, interruptibility: "high",   reversibility: "reversible",           costBand: "free",   energyCost: "medium", reservationRequired: false, queueDistribution: null, accessibilityConstraints: [], failureRecoveryRoutes: [{ failure: "rain", recovery: "the nearest indoor SEE candidate" }] },
  REST:      { minimumMinutes: 30, idealMinutes: 90,  compressibility: 0.5, interruptibility: "medium", reversibility: "reversible",           costBand: "free",   energyCost: "low",    reservationRequired: false, queueDistribution: null, accessibilityConstraints: [], failureRecoveryRoutes: [] },
  PHOTO:     { minimumMinutes: 15, idealMinutes: 40,  compressibility: 0.9, interruptibility: "high",   reversibility: "reversible",           costBand: "free",   energyCost: "low",    reservationRequired: false, queueDistribution: null, accessibilityConstraints: [], failureRecoveryRoutes: [{ failure: "weather or light", recovery: "another time of day" }] },
  EXPLORE:   { minimumMinutes: 30, idealMinutes: 90,  compressibility: 0.8, interruptibility: "high",   reversibility: "reversible",           costBand: "free",   energyCost: "medium", reservationRequired: false, queueDistribution: null, accessibilityConstraints: [], failureRecoveryRoutes: [] },
  PLAY:      { minimumMinutes: 45, idealMinutes: 120, compressibility: 0.4, interruptibility: "low",    reversibility: "partially_reversible", costBand: "medium", energyCost: "high",   reservationRequired: null,  queueDistribution: null, accessibilityConstraints: [], failureRecoveryRoutes: [{ failure: "sold out", recovery: "the next PLAY candidate or a WALK" }] },
  LEARN:     { minimumMinutes: 60, idealMinutes: 120, compressibility: 0.3, interruptibility: "low",    reversibility: "partially_reversible", costBand: "medium", energyCost: "medium", reservationRequired: true,  queueDistribution: null, accessibilityConstraints: [], failureRecoveryRoutes: [{ failure: "session full", recovery: "the self-guided SEE version" }] },
  NIGHTLIFE: { minimumMinutes: 60, idealMinutes: 180, compressibility: 0.5, interruptibility: "medium", reversibility: "partially_reversible", costBand: "high",   energyCost: "high",   reservationRequired: null,  queueDistribution: { p50Minutes: 15, p90Minutes: 45, source: "default:nightlife" }, accessibilityConstraints: ["loud", "adults_only"], failureRecoveryRoutes: [{ failure: "queue or door policy", recovery: "the next NIGHTLIFE or DRINK candidate" }] },
  TRANSIT:   { minimumMinutes: 10, idealMinutes: 30,  compressibility: 0.2, interruptibility: "low",    reversibility: "irreversible",         costBand: "low",    energyCost: "low",    reservationRequired: null,  queueDistribution: null, accessibilityConstraints: [], failureRecoveryRoutes: [{ failure: "missed", recovery: "the fallback segment (2782 fallback_of)" }] },
};

// ── inputs ───────────────────────────────────────────────────────────────────

export interface GeoPoint { lat: number; lng: number }

export interface OpeningWindow { opensAt: string; closesAt: string }

export interface LiveConditions {
  /** intel closure.state: open | temporarily_closed | closed_for_private_event | permanently_closed. */
  closure?: string | null;
  /** intel queue.wait, minutes. */
  queueWaitMinutes?: number | null;
  /** intel crowd.level. */
  crowdLevel?: string | null;
  /** 0..1 for the conditions above, from their estimates. */
  confidence?: number | null;
}

export interface ExperienceCandidate {
  id: string;
  placeId: string | null;
  name: string;
  placeType: string | null;
  point: GeoPoint | null;
  /** Explicit override; otherwise primitiveFor(placeType, name). */
  primitive?: ActivityPrimitive;
  /** Partial: what the candidate knows better than PRIMITIVE_DEFAULTS. */
  properties?: Partial<CandidateProperties>;
  /** null = hours unknown (UNCERTAIN unless the primitive is always-open); [] = never open. */
  openingWindows?: OpeningWindow[] | null;
  liveConditions?: LiveConditions | null;
  /** Where it came from: a saved idea, a plan, a pulse fallback. */
  source: string;
}

export interface CompileParticipant {
  userId: string;
  accessibilityNeeds?: string[];
}

export interface CompileGoal { id: string; type: string; scope: string; status: string; priority?: string | null; weight?: number | null }

export interface CompileNextCommitment { id: string; arriveBy: string; point: GeoPoint | null }

export interface TravelEstimator {
  /** Minutes, or null when it cannot be estimated. */
  minutes(from: GeoPoint, to: GeoPoint): { minutes: number; mode: string } | null;
}

export interface CompileInputs {
  now: number;
  window: FreedomWindow;
  /** Where the traveller is at the window's start: the window's origin, else the viewer's position. */
  origin: GeoPoint | null;
  participants: CompileParticipant[];
  candidates: ExperienceCandidate[];
  /** The pulse's kept signals: their effects invalidate or favour candidates. */
  liveSignals: PulseInterpretation[];
  travel: TravelEstimator;
  goals: CompileGoal[];
  preferences: { styles?: string[]; energy?: "low" | "medium" | "high" | null };
  nextCommitment: CompileNextCommitment | null;
  /** Minutes kept back before the next commitment (its prep). */
  prepMinutes?: number;
}

// ── outputs ──────────────────────────────────────────────────────────────────

export const EXPERIENCE_VERDICTS = ["EXECUTABLE", "NOT_EXECUTABLE", "UNCERTAIN"] as const;
export type ExperienceVerdict = (typeof EXPERIENCE_VERDICTS)[number];

/** Reasons the compiler can attach. Appendix B codes are used where a family fits; the rest are this engine's. */
export const EXPERIENCE_REASON_CODES = [
  "TRIP_TEMPORAL_INFEASIBLE",        // no time for travel + minimum stay + return
  "TRIP_TEMPORAL_UNKNOWN",           // travel time could not be estimated
  "TRIP_SPATIAL_NO_COORDINATES",     // the candidate has no point
  "EXPERIENCE_CLOSED_BEFORE_ARRIVAL", // §22.4
  "EXPERIENCE_CLOSES_DURING_STAY",
  "EXPERIENCE_HOURS_UNKNOWN",
  "EXPERIENCE_QUEUE_EXCEEDS_WINDOW",
  "EXPERIENCE_CLOSED_LIVE",          // a live closure claim
  "EXPERIENCE_UNSAFE_DENSITY",
  "EXPERIENCE_RESERVATION_REQUIRED",
  "EXPERIENCE_ACCESSIBILITY_UNMET",
  "EXPERIENCE_WEATHER_INVALIDATED",
  "EXPERIENCE_COMPRESSED",           // fits only below the ideal duration
  "EXPERIENCE_SERVES_GOAL",
  "EXPERIENCE_NO_OPEN_GOAL",
  "EXPERIENCE_BETTER_NOW",           // a live signal favours it
  "EXPERIENCE_WINDOW_UNCERTIFIED",   // the window itself is not certified (§7.3)
] as const;
export type ExperienceReasonCode = (typeof EXPERIENCE_REASON_CODES)[number];

export interface ExecutableTripExperience {
  /** Stable across compilations of the same window and candidate: `${windowId}:${candidateId}`. */
  id: string;
  windowId: string;
  candidateId: string;
  placeId: string | null;
  name: string;
  primitive: ActivityPrimitive;
  verdict: ExperienceVerdict;
  reasonCodes: ExperienceReasonCode[];
  /** The plan the experience would be: arrive, stay, leave to make the next commitment. */
  arriveAt: string | null;
  leaveBy: string | null;
  stayMinutes: number | null;
  travel: { toMinutes: number | null; backMinutes: number | null; mode: string | null };
  participants: string[];
  servesGoalIds: string[];
  /** 0..1, deterministic; EXECUTABLE only. NOT_EXECUTABLE and UNCERTAIN are 0. */
  score: number;
  properties: CandidateProperties;
  explanation: string[];
  source: string;
}

export interface CompileResult {
  windowId: string;
  experiences: ExecutableTripExperience[];
  counts: Record<ExperienceVerdict, number>;
}

// ── the compiler ─────────────────────────────────────────────────────────────

/** Primitives whose venue is "always open" enough that unknown hours are not a blocker. */
export const OPEN_AIR_PRIMITIVES: readonly ActivityPrimitive[] = ["WALK", "PHOTO", "EXPLORE", "MEET", "REST", "TRANSIT"];

/** Spec goal types (§8.1) and the 2762 vocabulary, mapped to primitives. */
export const GOAL_PRIMITIVES: Readonly<Record<string, readonly ActivityPrimitive[]>> = {
  nightlife: ["NIGHTLIFE", "DRINK"],
  food: ["EAT"],
  beach: ["WALK", "REST", "PHOTO"],
  culture: ["SEE", "LEARN", "EXPLORE"],
  social: ["MEET", "DRINK", "NIGHTLIFE", "PLAY"],
  rest: ["REST", "WALK"],
  business: ["MEET", "LEARN"],
  experience: ["SEE", "EXPLORE", "PLAY", "LEARN", "PHOTO"],
  budget: ["WALK", "PHOTO", "EXPLORE", "REST"],
  logistics: ["TRANSIT"],
  safety: [],
  custom: [],
  other: [],
};

const CLOSED_STATES = new Set(["temporarily_closed", "closed_for_private_event", "permanently_closed"]);
const OPEN_GOAL_STATES = new Set(["open", "unserved", "partial", "UNSERVED", "PARTIAL"]);

function clamp01(n: number): number { return Math.min(1, Math.max(0, n)); }

export function candidateProperties(c: ExperienceCandidate): CandidateProperties {
  const primitive = c.primitive ?? primitiveFor(c.placeType, c.name);
  const base = PRIMITIVE_DEFAULTS[primitive];
  return { ...base, ...(c.properties ?? {}), accessibilityConstraints: [...(c.properties?.accessibilityConstraints ?? base.accessibilityConstraints)], failureRecoveryRoutes: [...(c.properties?.failureRecoveryRoutes ?? base.failureRecoveryRoutes)] };
}

function openingCovers(windows: OpeningWindow[], arriveMs: number, leaveMs: number): { arrivalOpen: boolean; staysOpen: boolean } {
  let arrivalOpen = false; let staysOpen = false;
  for (const w of windows) {
    const o = Date.parse(w.opensAt); const cl = Date.parse(w.closesAt);
    if (!Number.isFinite(o) || !Number.isFinite(cl)) continue;
    if (o <= arriveMs && arriveMs < cl) { arrivalOpen = true; if (leaveMs <= cl) staysOpen = true; }
  }
  return { arrivalOpen, staysOpen };
}

/**
 * One window, every candidate. Deterministic: the same inputs give the same
 * experiences in the same order (score desc, then verdict, then id).
 */
export function compileExperiences(inputs: CompileInputs): CompileResult {
  const w = inputs.window;
  const beginsMs = Math.max(Date.parse(w.beginsAt), inputs.now);
  const endsMs = Date.parse(w.endsAt);
  const prep = inputs.prepMinutes ?? 0;
  const returnTo = inputs.nextCommitment?.point ?? w.requiredDestination ?? null;
  const returnPoint: GeoPoint | null = returnTo && "lat" in (returnTo as any) ? { lat: (returnTo as any).lat, lng: (returnTo as any).lng } : null;
  const openGoals = inputs.goals.filter((g) => OPEN_GOAL_STATES.has(g.status));
  const invalidatedIds = new Set<string>();
  const favouredIds = new Set<string>();
  for (const s of inputs.liveSignals) {
    for (const e of s.effects) {
      if (e.kind === "plan_invalidated") for (const id of e.subjectIds) invalidatedIds.add(id);
      if (e.kind === "saved_idea_better_now") for (const id of e.subjectIds) favouredIds.add(id);
    }
  }
  const rainToday = inputs.liveSignals.some((s) => s.kind === "rain_arriving" && s.effects.some((e) => e.kind === "plan_invalidated"));

  const experiences: ExecutableTripExperience[] = [];
  for (const c of inputs.candidates) {
    const primitive = c.primitive ?? primitiveFor(c.placeType, c.name);
    const props = candidateProperties(c);
    const reasons: ExperienceReasonCode[] = [];
    const explanation: string[] = [];
    // A mutable cell rather than a `let`: the closures below assign it, and
    // TypeScript's narrowing cannot see through a closure.
    const v: { verdict: ExperienceVerdict } = { verdict: "EXECUTABLE" };
    const fail = (code: ExperienceReasonCode, why: string) => { reasons.push(code); explanation.push(why); v.verdict = "NOT_EXECUTABLE"; };
    const unsure = (code: ExperienceReasonCode, why: string) => { reasons.push(code); explanation.push(why); if (v.verdict !== "NOT_EXECUTABLE") v.verdict = "UNCERTAIN"; };

    // travel to, and back to the next commitment (or the window's destination)
    let toMinutes: number | null = null; let backMinutes: number | null = null; let mode: string | null = null;
    if (!c.point) {
      unsure("TRIP_SPATIAL_NO_COORDINATES", `${c.name} has no coordinates; travel cannot be estimated`);
    } else {
      if (inputs.origin) {
        const t = inputs.travel.minutes(inputs.origin, c.point);
        if (t) { toMinutes = t.minutes; mode = t.mode; } else unsure("TRIP_TEMPORAL_UNKNOWN", `travel to ${c.name} could not be estimated`);
      } else { toMinutes = 0; explanation.push("no origin is known; travel to the candidate is taken as zero, optimistically"); unsure("TRIP_TEMPORAL_UNKNOWN", "the window has no origin"); }
      if (returnPoint) {
        const b = inputs.travel.minutes(c.point, returnPoint);
        if (b) { backMinutes = b.minutes; mode = mode ?? b.mode; } else unsure("TRIP_TEMPORAL_UNKNOWN", `travel back from ${c.name} could not be estimated`);
      } else { backMinutes = 0; }
    }

    // time: arrive, minimum stay, leave in time
    const arriveMs = toMinutes !== null ? beginsMs + toMinutes * 60_000 : beginsMs;
    const leaveMs = backMinutes !== null ? endsMs - (backMinutes + prep) * 60_000 : endsMs - prep * 60_000;
    const availableMinutes = Math.floor((leaveMs - arriveMs) / 60_000);
    const queueP90 = c.liveConditions?.queueWaitMinutes ?? props.queueDistribution?.p90Minutes ?? 0;
    if (availableMinutes < props.minimumMinutes) {
      fail("TRIP_TEMPORAL_INFEASIBLE", `${availableMinutes} min available after travel; ${props.minimumMinutes} min is the minimum ${primitive.toLowerCase()}`);
    } else if (availableMinutes < props.minimumMinutes + queueP90) {
      fail("EXPERIENCE_QUEUE_EXCEEDS_WINDOW", `a ${queueP90} min queue leaves ${availableMinutes - queueP90} min, under the ${props.minimumMinutes} min minimum`);
    }
    const stayMinutes = v.verdict === "NOT_EXECUTABLE" ? null : Math.min(props.idealMinutes, Math.max(props.minimumMinutes, availableMinutes - queueP90));
    if (stayMinutes !== null && stayMinutes < props.idealMinutes) { reasons.push("EXPERIENCE_COMPRESSED"); explanation.push(`${stayMinutes} min of an ideal ${props.idealMinutes}`); }

    // opening hours (§22.4) and live closure
    if (c.openingWindows === undefined || c.openingWindows === null) {
      if (!OPEN_AIR_PRIMITIVES.includes(primitive)) unsure("EXPERIENCE_HOURS_UNKNOWN", `${c.name}'s opening hours are not known`);
    } else {
      const stayEnd = arriveMs + queueP90 * 60_000 + (stayMinutes ?? props.minimumMinutes) * 60_000;
      const cov = openingCovers(c.openingWindows, arriveMs, Math.min(stayEnd, arriveMs + props.minimumMinutes * 60_000));
      if (!cov.arrivalOpen) fail("EXPERIENCE_CLOSED_BEFORE_ARRIVAL", `${c.name} is closed at ${new Date(arriveMs).toISOString()} (§22.4)`);
      else if (!cov.staysOpen) fail("EXPERIENCE_CLOSES_DURING_STAY", `${c.name} closes before the ${props.minimumMinutes} min minimum stay`);
    }
    if (c.liveConditions?.closure && CLOSED_STATES.has(c.liveConditions.closure)) fail("EXPERIENCE_CLOSED_LIVE", `a live claim says ${c.liveConditions.closure}`);
    if (c.liveConditions?.crowdLevel === "unsafe_density") fail("EXPERIENCE_UNSAFE_DENSITY", "a live claim says unsafe density");
    if (props.reservationRequired === true) fail("EXPERIENCE_RESERVATION_REQUIRED", `${c.name} requires a reservation and none is held`);

    // participants
    const needs = new Set(inputs.participants.flatMap((p) => p.accessibilityNeeds ?? []));
    const unmet = props.accessibilityConstraints.filter((k) => needs.has(k) || [...needs].some((n) => k.includes(n) || n.includes(k)));
    if (unmet.length > 0) fail("EXPERIENCE_ACCESSIBILITY_UNMET", `constraint ${unmet.join(", ")} conflicts with a participant's need`);

    // live conditions from the pulse
    if (invalidatedIds.has(c.id) || (rainToday && OPEN_AIR_PRIMITIVES.includes(primitive) && primitive !== "TRANSIT" && primitive !== "MEET")) {
      fail("EXPERIENCE_WEATHER_INVALIDATED", "rain arriving invalidates an open-air candidate (§16.1)");
    }
    if (favouredIds.has(c.id)) { reasons.push("EXPERIENCE_BETTER_NOW"); explanation.push("a live signal says it may be better now"); }

    // goals / preferences
    const servesGoalIds = openGoals.filter((g) => (GOAL_PRIMITIVES[g.type.toLowerCase()] ?? []).includes(primitive)).map((g) => g.id);
    if (servesGoalIds.length > 0) { reasons.push("EXPERIENCE_SERVES_GOAL"); explanation.push(`serves ${servesGoalIds.length} open goal(s)`); }
    else if (openGoals.length > 0) reasons.push("EXPERIENCE_NO_OPEN_GOAL");
    if (!w.certified) reasons.push("EXPERIENCE_WINDOW_UNCERTIFIED");

    // score, EXECUTABLE only
    let score = 0;
    if (v.verdict === "EXECUTABLE" && stayMinutes !== null) {
      const fit = stayMinutes >= props.idealMinutes ? 1 : 0.4 + 0.6 * props.compressibility * (stayMinutes / props.idealMinutes);
      const goalBoost = Math.min(0.3, servesGoalIds.reduce((acc, id) => acc + 0.1 * (1 + (openGoals.find((g) => g.id === id)?.weight ?? 0)), 0));
      const liveBoost = favouredIds.has(c.id) ? 0.1 : 0;
      const travelPenalty = Math.min(0.3, ((toMinutes ?? 0) + (backMinutes ?? 0)) / 240);
      const energyPenalty = inputs.preferences.energy === "low" && props.energyCost === "high" ? 0.15 : 0;
      const stylePref = inputs.preferences.styles?.some((s) => s.toLowerCase() === primitive.toLowerCase()) ? 0.1 : 0;
      score = clamp01(0.5 * fit + goalBoost + liveBoost + stylePref - travelPenalty - energyPenalty);
    }

    experiences.push({
      id: `${w.id}:${c.id}`, windowId: w.id, candidateId: c.id, placeId: c.placeId, name: c.name, primitive, verdict: v.verdict,
      reasonCodes: [...new Set(reasons)],
      arriveAt: v.verdict === "NOT_EXECUTABLE" ? null : new Date(arriveMs).toISOString(),
      leaveBy: v.verdict === "NOT_EXECUTABLE" ? null : new Date(Math.min(leaveMs, arriveMs + ((stayMinutes ?? 0) + queueP90) * 60_000)).toISOString(),
      stayMinutes, travel: { toMinutes, backMinutes, mode }, participants: [...w.participants], servesGoalIds, score: Math.round(score * 1000) / 1000,
      properties: props, explanation, source: c.source,
    });
  }
  const rank: Record<ExperienceVerdict, number> = { EXECUTABLE: 0, UNCERTAIN: 1, NOT_EXECUTABLE: 2 };
  experiences.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.score - a.score || a.id.localeCompare(b.id));
  const counts: Record<ExperienceVerdict, number> = { EXECUTABLE: 0, NOT_EXECUTABLE: 0, UNCERTAIN: 0 };
  for (const e of experiences) counts[e.verdict] += 1;
  return { windowId: w.id, experiences, counts };
}
