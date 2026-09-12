/**
 * Trips spec §16 — Trip Pulse and World Intelligence, the PURE half.
 *
 * §16.2 `SignalEstimate { value confidence sourceClass observedAt expiresAt
 * fallbackUsed contradictorySources[] }` and its one rule: "Contradictory
 * sources increase uncertainty; the system must not silently select whichever
 * source makes a recommendation easier."
 *
 * §16.1 "Trip Pulse is not a generic city feed. It projects world intelligence
 * through the active Trip context: stage, current location band, goals, saved
 * ideas, commitments, crew, and attention state." — and the five-row table of
 * signal → trip interpretation, which is reproduced here VERBATIM as the
 * `interpretation` strings, so the projection says what the spec says.
 *
 * Nothing in this file reads a database. The projection
 * (TripPulseProjection.ts) gathers observations and context and calls
 * `estimateFromObservations` then `projectSignals`. Every decision here is a
 * function of its inputs, so the ledger (§21.2) can explain it and a scenario
 * test can replay it.
 *
 * WHAT "SILENTLY SELECT" MEANS, MECHANICALLY
 * ==========================================
 * `estimateFromObservations` has no notion of a recommendation, so it CANNOT
 * prefer the value that makes one easier. It picks by SUPPORT (agreeing
 * sources), breaks ties by source class rank and then by the lexical order of
 * the serialised value — never by input order, which the test proves by
 * shuffling — and it does two things whenever any source disagrees:
 *   1. every disagreeing observation is listed in `contradictorySources`, and
 *   2. confidence is multiplied by the agreeing share (2 of 3 agree → ×0.667).
 * A consumer that wants the "easier" value has to overrule a listed
 * contradiction in the open.
 */
import type { SourceClass } from "../../lib/intelContracts.js";

// ── §16.2 contract ──────────────────────────────────────────────────────────

export interface ContradictorySource {
  sourceClass: SourceClass;
  value: unknown;
  observedAt: string;
  confidence: number;
}

export interface SignalEstimate<T = unknown> {
  value: T;
  /** 0..1. Reduced by disagreement; never raised by it. */
  confidence: number;
  sourceClass: SourceClass;
  /** ISO. The latest observation among those that agree with `value`. */
  observedAt: string;
  /** ISO. The earliest expiry among those that agree — the estimate is only as fresh as its weakest supporter. */
  expiresAt: string;
  /** True when the value rests on a pattern or prediction rather than an observation, or when a source said so itself. */
  fallbackUsed: boolean;
  contradictorySources: ContradictorySource[];
  /** How many observations agreed with `value`, of how many were admissible. */
  support: { agreeing: number; total: number };
}

export interface SignalObservation<T = unknown> {
  value: T;
  confidence: number;
  sourceClass: SourceClass;
  observedAt: string;
  expiresAt: string;
  /** The source says this is a stand-in (a cached or modelled value), not an observation. */
  fallback?: boolean;
}

/**
 * Source classes ranked for TIE-BREAKING ONLY. Rank decides between two
 * groups of equal support; it never overrides support, because "the official
 * source said X" over "three verified visitors said Y" is exactly the silent
 * selection §16.2 forbids — both are surfaced, one is the value, the other is
 * listed.
 */
export const SOURCE_CLASS_RANK: Readonly<Record<SourceClass, number>> = {
  verified_firsthand: 7,
  official_signed: 6,
  firsthand_unverified: 5,
  imported_owned: 4,
  historical_pattern: 3,
  portava_prediction: 2,
  sponsored: 1,
  hearsay: 0,
};

/** A pattern or a prediction is a fallback for an observation, by definition. */
export const FALLBACK_SOURCE_CLASSES: readonly SourceClass[] = ["historical_pattern", "portava_prediction"];

function serialise(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(serialise).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${serialise(o[k])}`).join(",")}}`;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/**
 * §16.2. Null when nothing admissible remains (every observation expired or
 * none given) — an absent estimate, not a zero-confidence one, because "we
 * do not know" and "we are sure it is nothing" are different claims.
 */
export function estimateFromObservations<T>(
  observations: readonly SignalObservation<T>[],
  opts: { now: number },
): SignalEstimate<T> | null {
  const admissible = observations.filter((o) => {
    const exp = Date.parse(o.expiresAt);
    const obs = Date.parse(o.observedAt);
    return Number.isFinite(exp) && Number.isFinite(obs) && exp > opts.now;
  });
  if (admissible.length === 0) return null;

  const groups = new Map<string, SignalObservation<T>[]>();
  for (const o of admissible) {
    const k = serialise(o.value);
    const g = groups.get(k);
    if (g) g.push(o); else groups.set(k, [o]);
  }
  const ranked = [...groups.entries()].map(([key, members]) => ({
    key,
    members,
    support: members.length,
    bestRank: Math.max(...members.map((m) => SOURCE_CLASS_RANK[m.sourceClass] ?? 0)),
    bestConfidence: Math.max(...members.map((m) => clamp01(m.confidence))),
  }));
  ranked.sort((a, b) => b.support - a.support || b.bestRank - a.bestRank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const chosen = ranked[0];
  const agreeing = chosen.members;
  const best = [...agreeing].sort((a, b) =>
    (SOURCE_CLASS_RANK[b.sourceClass] ?? 0) - (SOURCE_CLASS_RANK[a.sourceClass] ?? 0) || clamp01(b.confidence) - clamp01(a.confidence),
  )[0];
  const contradictory: ContradictorySource[] = [];
  for (const g of ranked.slice(1)) {
    for (const m of g.members) {
      contradictory.push({ sourceClass: m.sourceClass, value: m.value, observedAt: m.observedAt, confidence: clamp01(m.confidence) });
    }
  }
  contradictory.sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0) || (SOURCE_CLASS_RANK[b.sourceClass] - SOURCE_CLASS_RANK[a.sourceClass]));

  const share = agreeing.length / admissible.length;
  const observedAt = agreeing.map((m) => m.observedAt).sort().at(-1)!;
  const expiresAt = agreeing.map((m) => m.expiresAt).sort()[0];
  const fallbackUsed = agreeing.some((m) => m.fallback === true) || FALLBACK_SOURCE_CLASSES.includes(best.sourceClass);

  return {
    value: best.value,
    confidence: clamp01(chosen.bestConfidence * share),
    sourceClass: best.sourceClass,
    observedAt,
    expiresAt,
    fallbackUsed,
    contradictorySources: contradictory,
    support: { agreeing: agreeing.length, total: admissible.length },
  };
}

// ── §16.1 signals ───────────────────────────────────────────────────────────

/** The five rows of §16.1's table, by name. */
export const SIGNAL_KINDS = ["crowd_rising", "rain_arriving", "taxi_demand_high", "event_delayed", "friend_nearby"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export interface CrowdRisingValue { placeId: string; level: string; trajectory: string }
export interface RainArrivingValue { date: string; precipMm: number; weatherCode: number; summary?: string | null }
export interface TaxiDemandValue { zone: string; condition: string }
export interface EventDelayedValue { eventId: string; status: string; delayMinutes: number | null; newStartsAt: string | null }
export interface FriendNearbyValue { userId: string; distanceBand: "same_venue" | "walking" | "nearby"; bothSharing: boolean }

export type SignalValue = CrowdRisingValue | RainArrivingValue | TaxiDemandValue | EventDelayedValue | FriendNearbyValue;

export interface TripSignal<V extends SignalValue = SignalValue> {
  kind: SignalKind;
  /** The world object the signal is about: a place id, a date, a zone, an event id, a user id. */
  subjectId: string;
  estimate: SignalEstimate<V>;
}

/** §16.1's second column, verbatim. */
export const SIGNAL_INTERPRETATIONS: Readonly<Record<SignalKind, string>> = {
  crowd_rising: "Saved nightlife venue may be better now; queue risk may increase later.",
  rain_arriving: "Invalidate weather-sensitive plan; create indoor fallback opportunity.",
  taxi_demand_high: "Increase future transport uncertainty/cost for affected route chains.",
  event_delayed: "New free window may appear or downstream commitment may conflict.",
  friend_nearby: "Potential meetup opportunity subject to both parties' privacy/presence.",
};

/** What a kept signal does to the trip — the typed consequence a consumer acts on. */
export const SIGNAL_EFFECT_KINDS = [
  "saved_idea_better_now", "queue_risk_later",
  "plan_invalidated", "fallback_opportunity",
  "transport_uncertainty",
  "free_window_may_appear", "downstream_conflict",
  "meetup_opportunity",
] as const;
export type SignalEffectKind = (typeof SIGNAL_EFFECT_KINDS)[number];

export interface SignalEffect {
  kind: SignalEffectKind;
  /** Trip objects affected: saved idea ids, plan ids, transport segment ids, commitment ids, member ids. */
  subjectIds: string[];
  detail: string;
}

/** The seven context axes §16.1 names, as the reasons a signal passed the filter. */
export const PULSE_RELEVANCE = ["stage", "location", "goals", "saved_ideas", "commitments", "crew", "attention"] as const;
export type PulseRelevance = (typeof PULSE_RELEVANCE)[number];

export interface PulseInterpretation {
  kind: SignalKind;
  subjectId: string;
  estimate: SignalEstimate<SignalValue>;
  interpretation: string;
  effects: SignalEffect[];
  relevance: PulseRelevance[];
}

export interface DroppedSignal {
  kind: SignalKind;
  subjectId: string;
  reason: string;
}

// ── §16.1 context ───────────────────────────────────────────────────────────

export interface GeoPoint { lat: number; lng: number }

export interface PulseStage { id: string; startsAt: string | null; endsAt: string | null; anchor: GeoPoint | null }
export interface PulseSavedIdea { id: string; placeId: string | null; placeType: string | null; name: string; point: GeoPoint | null }
export interface PulseCommitment { id: string; type: string; startsAt: string | null; requiredArrivalAt: string | null; placeId: string | null; eventId: string | null }
export interface PulsePlan { id: string; title: string | null; category: string | null; startsAt: string | null; endsAt: string | null; weatherSensitive: boolean; point: GeoPoint | null }
export interface PulseTransport { id: string; mode: string; state: string; plannedDepartureAt: string | null }
export interface PulseGoal { type: string; scope: string; status: string }

export const ATTENTION_STATES = ["NORMAL", "AT_RISK", "SAFETY_EVENT"] as const;
export type AttentionState = (typeof ATTENTION_STATES)[number];

export interface PulseContext {
  now: number;
  stage: PulseStage | null;
  /** The current location band: a centre and radius. Null when nothing places the viewer. */
  locationBand: { centre: GeoPoint; radiusM: number } | null;
  goals: PulseGoal[];
  savedIdeas: PulseSavedIdea[];
  commitments: PulseCommitment[];
  plans: PulsePlan[];
  transport: PulseTransport[];
  crew: { viewerId: string; memberIds: string[] };
  attention: AttentionState;
}

/** Plan-title / place-type hints that make a plan weather-sensitive. Exported so the heuristic is inspectable, not hidden. */
export const WEATHER_SENSITIVE_HINTS: readonly string[] = [
  "beach", "hike", "hiking", "trek", "park", "walk", "walking tour", "rooftop", "terrace", "boat", "kayak", "surf",
  "garden", "market", "picnic", "bike", "cycling", "outdoor", "open-air", "open air", "viewpoint", "sunset", "zoo", "safari",
];

export function looksWeatherSensitive(title: string | null | undefined, placeType?: string | null): boolean {
  const hay = `${title ?? ""} ${placeType ?? ""}`.toLowerCase();
  return WEATHER_SENSITIVE_HINTS.some((h) => hay.includes(h));
}

/** Nightlife by goal, saved-idea type or plan category — the venues §16.1's first row is about. */
export const NIGHTLIFE_PLACE_TYPES: readonly string[] = ["bar", "club", "nightclub", "nightlife", "pub", "lounge", "rooftop", "live_music"];

/** Transport modes a taxi-demand signal affects. */
export const TAXI_LIKE_MODES: readonly string[] = ["taxi", "rideshare", "ride_hail", "car_hire", "car"];

const RISING_TRAJECTORIES = new Set(["emerging", "building", "peaking"]);
const BUSY_LEVELS = new Set(["busy", "packed", "unsafe_density"]);
const DELAY_STATUSES = new Set(["delayed", "not_started", "starting_soon", "cancelled"]);
const HIGH_DEMAND = new Set(["delayed", "disrupted", "closed", "high_demand", "surge"]);

export function metresBetween(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function inStage(ctx: PulseContext, at: string | null): boolean {
  if (!ctx.stage || !at) return false;
  const t = Date.parse(at);
  const s = ctx.stage.startsAt ? Date.parse(ctx.stage.startsAt) : -Infinity;
  const e = ctx.stage.endsAt ? Date.parse(ctx.stage.endsAt) : Infinity;
  return Number.isFinite(t) && t >= s && t < e;
}

function inBand(ctx: PulseContext, p: GeoPoint | null): boolean {
  if (!ctx.locationBand || !p) return false;
  return metresBetween(ctx.locationBand.centre, p) <= ctx.locationBand.radiusM;
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * §16.1. One signal in, one interpretation or one dropped record out. The
 * filter is the trip context: a signal that touches nothing the trip is doing
 * is a city-feed item, and the spec says Trip Pulse is not that.
 *
 * Attention state is the seventh axis: under SAFETY_EVENT every non-safety
 * signal is dropped with TRIP_DISRUPTION_SUPPRESSED (§17.2), and under AT_RISK
 * the discovery-flavoured ones (crowd rising, friend nearby) are.
 */
export function interpretSignal(signal: TripSignal, ctx: PulseContext): { kept: PulseInterpretation } | { dropped: DroppedSignal } {
  const drop = (reason: string) => ({ dropped: { kind: signal.kind, subjectId: signal.subjectId, reason } });
  const keep = (effects: SignalEffect[], relevance: PulseRelevance[]) => ({
    kept: { kind: signal.kind, subjectId: signal.subjectId, estimate: signal.estimate, interpretation: SIGNAL_INTERPRETATIONS[signal.kind], effects, relevance: [...new Set(relevance)] },
  });
  if (Date.parse(signal.estimate.expiresAt) <= ctx.now) return drop("estimate expired");
  const discovery = signal.kind === "crowd_rising" || signal.kind === "friend_nearby";
  if (ctx.attention === "SAFETY_EVENT") return drop("TRIP_DISRUPTION_SUPPRESSED: a safety event has the crew's attention (§17.2)");
  if (ctx.attention === "AT_RISK" && discovery) return drop("TRIP_DISRUPTION_SUPPRESSED: the trip is AT_RISK; discovery is suppressed (§17.2)");

  switch (signal.kind) {
    case "crowd_rising": {
      const v = signal.estimate.value as CrowdRisingValue;
      const rising = RISING_TRAJECTORIES.has(v.trajectory) || BUSY_LEVELS.has(v.level);
      if (!rising) return drop(`crowd is ${v.level}/${v.trajectory}, not rising`);
      const ideas = ctx.savedIdeas.filter((s) => s.placeId === v.placeId);
      const plans = ctx.plans.filter((p) => p.id === v.placeId);
      if (ideas.length === 0 && plans.length === 0) return drop("no saved idea or plan at that place");
      const nightlife = ideas.some((s) => NIGHTLIFE_PLACE_TYPES.includes(String(s.placeType ?? "").toLowerCase()))
        || ctx.goals.some((g) => g.type.toLowerCase() === "nightlife" && g.status !== "dropped" && g.status !== "DROPPED");
      const relevance: PulseRelevance[] = ["saved_ideas"];
      if (nightlife) relevance.push("goals");
      if (ideas.some((s) => inBand(ctx, s.point))) relevance.push("location");
      const ids = [...ideas.map((s) => s.id), ...plans.map((p) => p.id)];
      return keep([
        { kind: "saved_idea_better_now", subjectIds: ids, detail: `${v.level}, ${v.trajectory}: ${nightlife ? "a saved nightlife venue" : "a saved place"} may be better now` },
        { kind: "queue_risk_later", subjectIds: ids, detail: "queue risk may increase later as the crowd builds" },
      ], relevance);
    }
    case "rain_arriving": {
      const v = signal.estimate.value as RainArrivingValue;
      const rainy = v.precipMm > 2 || v.weatherCode >= 51;
      if (!rainy) return drop(`forecast for ${v.date} is not rain (${v.precipMm} mm, code ${v.weatherCode})`);
      const onDate = (at: string | null) => !!at && at.slice(0, 10) === v.date;
      const plans = ctx.plans.filter((p) => p.weatherSensitive && (onDate(p.startsAt) || onDate(p.endsAt)));
      if (plans.length === 0) return drop(`no weather-sensitive plan on ${v.date}`);
      const relevance: PulseRelevance[] = ["stage"];
      if (plans.some((p) => inStage(ctx, p.startsAt))) relevance.push("stage");
      const indoorIdeas = ctx.savedIdeas.filter((s) => !looksWeatherSensitive(s.name, s.placeType));
      if (indoorIdeas.length > 0) relevance.push("saved_ideas");
      return keep([
        { kind: "plan_invalidated", subjectIds: plans.map((p) => p.id), detail: `rain on ${v.date} (${v.precipMm} mm) invalidates ${plans.length} weather-sensitive plan(s)` },
        { kind: "fallback_opportunity", subjectIds: indoorIdeas.map((s) => s.id), detail: indoorIdeas.length > 0 ? `${indoorIdeas.length} saved indoor idea(s) fit as a fallback` : "no saved indoor idea to fall back to; an indoor plan is still needed" },
      ], relevance);
    }
    case "taxi_demand_high": {
      const v = signal.estimate.value as TaxiDemandValue;
      if (!HIGH_DEMAND.has(v.condition)) return drop(`transit condition is ${v.condition}`);
      const horizon = ctx.now + SIX_HOURS;
      const segments = ctx.transport.filter((t) => TAXI_LIKE_MODES.includes(t.mode.toLowerCase()) && t.state !== "completed" && t.state !== "COMPLETED"
        && (!t.plannedDepartureAt || (Date.parse(t.plannedDepartureAt) >= ctx.now - SIX_HOURS && Date.parse(t.plannedDepartureAt) <= horizon)));
      const unplaced = ctx.commitments.filter((c) => {
        const at = Date.parse(c.requiredArrivalAt ?? c.startsAt ?? "");
        return Number.isFinite(at) && at > ctx.now && at <= horizon;
      });
      if (segments.length === 0 && unplaced.length === 0) return drop("no taxi-like transport segment or commitment in the next six hours");
      const relevance: PulseRelevance[] = segments.length > 0 ? ["commitments", "stage"] : ["commitments"];
      if (ctx.locationBand) relevance.push("location");
      return keep([
        { kind: "transport_uncertainty", subjectIds: [...segments.map((s) => s.id), ...unplaced.map((c) => c.id)], detail: `${v.condition} taxi demand in ${v.zone}: transport uncertainty and cost rise for ${segments.length} segment(s) and ${unplaced.length} upcoming commitment(s)` },
      ], relevance);
    }
    case "event_delayed": {
      const v = signal.estimate.value as EventDelayedValue;
      if (!DELAY_STATUSES.has(v.status) && v.delayMinutes === null) return drop(`event status is ${v.status} with no delay`);
      const commitments = ctx.commitments.filter((c) => c.eventId === v.eventId || c.placeId === v.eventId);
      const plans = ctx.plans.filter((p) => p.id === v.eventId);
      if (commitments.length === 0 && plans.length === 0) return drop("the event is not a commitment or plan of this trip");
      const effects: SignalEffect[] = [];
      const ids = [...commitments.map((c) => c.id), ...plans.map((p) => p.id)];
      if (v.status === "cancelled") {
        effects.push({ kind: "free_window_may_appear", subjectIds: ids, detail: "the event is cancelled; its slot may become a free window" });
      } else {
        effects.push({ kind: "free_window_may_appear", subjectIds: ids, detail: `the event is ${v.status}${v.delayMinutes !== null ? ` by ${v.delayMinutes} min` : ""}; a free window may open before it` });
        const later = commitments.filter((c) => {
          const at = Date.parse(c.requiredArrivalAt ?? c.startsAt ?? "");
          const newStart = v.newStartsAt ? Date.parse(v.newStartsAt) : NaN;
          return Number.isFinite(at) && Number.isFinite(newStart) && at > newStart && !ids.includes(c.id);
        });
        const downstream = ctx.commitments.filter((c) => !ids.includes(c.id) && Number.isFinite(Date.parse(c.requiredArrivalAt ?? c.startsAt ?? "")) && Date.parse(c.requiredArrivalAt ?? c.startsAt ?? "") > ctx.now);
        const affected = later.length > 0 ? later : downstream;
        if (affected.length > 0) effects.push({ kind: "downstream_conflict", subjectIds: affected.map((c) => c.id), detail: `${affected.length} downstream commitment(s) may conflict with the delayed event` });
      }
      return keep(effects, ["commitments", "stage"]);
    }
    case "friend_nearby": {
      const v = signal.estimate.value as FriendNearbyValue;
      if (!v.bothSharing) return drop("TRIP_PRIVACY_SCOPE: both parties must be sharing presence for a meetup to be surfaced");
      if (v.userId === ctx.crew.viewerId) return drop("the viewer is not a friend nearby of themself");
      const crew = ctx.crew.memberIds.includes(v.userId);
      return keep([
        { kind: "meetup_opportunity", subjectIds: [v.userId], detail: `${crew ? "a crew member" : "a friend"} is ${v.distanceBand.replace("_", " ")}; a meetup is possible` },
      ], crew ? ["crew", "location"] : ["location"]);
    }
  }
}

export interface PulseProjectionResult {
  kept: PulseInterpretation[];
  dropped: DroppedSignal[];
}

/** All signals through the filter, kept ones ordered by confidence desc then kind. */
export function projectSignals(signals: readonly TripSignal[], ctx: PulseContext): PulseProjectionResult {
  const kept: PulseInterpretation[] = [];
  const dropped: DroppedSignal[] = [];
  for (const s of signals) {
    const r = interpretSignal(s, ctx);
    if ("kept" in r) kept.push(r.kept); else dropped.push(r.dropped);
  }
  kept.sort((a, b) => b.estimate.confidence - a.estimate.confidence || a.kind.localeCompare(b.kind) || a.subjectId.localeCompare(b.subjectId));
  return { kept, dropped };
}
