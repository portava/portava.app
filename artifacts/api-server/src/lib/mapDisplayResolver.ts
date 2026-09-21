/**
 * mapDisplayResolver — Sensing §7's display resolver / clutter budget: "so
 * safety, mode, zoom, user intent and relevance decide what renders", and its
 * safety rule: "Safety constraints outrank opportunity/vibe. A dangerous place
 * must never simultaneously be promoted as 'best move now'."
 *
 * ── WHAT EXISTED, AND WHAT THIS ADDS ─────────────────────────────────────────
 * Before this module the gateway's "resolver" was a priority sort
 * (`rankObjects`) and a page cap (`paginate`): zoom decided aggregation, and
 * mode, intent and relevance decided nothing (census-sensing S65). This adds,
 * as ONE pure pass between ranking and paging:
 *
 *   SAFETY     `safety_notice` objects are never budgeted and never dropped.
 *              Every other object AT a noticed place (same canonical place id)
 *              or within SAFETY_CONSTRAINT_RADIUS_KM of a notice is marked
 *              `payload.safetyConstraint = { noticeRef, promotable: false }`
 *              and has any PROMOTION stripped: its renderingPriority falls
 *              back to its kind's default, so a live-evidence bump to
 *              "high-confidence live zone" (the map's only opportunity
 *              promotion) cannot survive next to a safety notice. It still
 *              renders — hiding a dangerous place would be its own failure —
 *              it just cannot be an opportunity.
 *   ZOOM       the §17 band sets the overall clutter budget
 *              (BAND_CLUTTER_BUDGET), never above the caller's `limit`.
 *   MODE       §30's seven primary modes allocate that budget across five
 *              display classes (MODE_CLASS_SHARES): Trip mode spends on trip
 *              and people objects, Crowd Flow on live objects, and so on.
 *   INTENT     §13's nine intents add a small affinity to matching kinds
 *              (INTENT_KIND_AFFINITY). Affinity only ever REORDERS WITHIN a
 *              priority tier — it is a tie-break after `renderingPriority`
 *              and before distance — so no intent can lift a social
 *              opportunity above a safety notice or a trip stop.
 *   RELEVANCE  within a class, priority then affinity then distance; the
 *              budget an under-filled class leaves is spent on the best
 *              remaining objects in the same order.
 *
 * ── WHAT IT REFUSES TO DECIDE ────────────────────────────────────────────────
 * It never adds an object, never re-derives a privacy class, never changes
 * geometry, and never raises a priority. It only marks, caps and drops — and
 * every drop is COUNTED in the report by kind, so a thinned viewport cannot be
 * mistaken for an empty one.
 *
 * ── THE NUMBERS ARE TUNABLES ─────────────────────────────────────────────────
 * Budgets, shares and affinities are declared as data with one rationale each
 * and are NOT owner-ruled product values; they are the resolver's initial
 * calibration and the thing an owner would change. The SHAPE is the
 * requirement Sensing §7 states; the numbers are where a decision is owed.
 *
 * Gated at the route by `map_display_resolver_enabled` (migration 2350,
 * seeded OFF). With the flag off the route pages the ranked list exactly as
 * before and the envelope's `display` is null.
 */
import type { ZoomBand } from "./mapAggregation.js";
import {
  KIND_DEFAULT_PRIORITY,
  centroidOf,
  compareByRenderingPriority,
  type MapObject,
  type MapObjectKind,
} from "./mapObjects.js";
import { haversineKm } from "./mapSearch.js";

/** Map spec §30's primary modes, mirrored from the app's vocabulary.ts. */
export const DISPLAY_MODES = [
  "LIVE",
  "PLACE_SELECTED",
  "COMPASS",
  "TRIP",
  "CROWD_FLOW",
  "LOCATE_FRIENDS",
  "TIME_MACHINE",
] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

/** Map spec §13's primary intents, mirrored from the app's intentModel.ts. */
export const DISPLAY_INTENTS = [
  "bored",
  "eat",
  "party",
  "explore",
  "meet_people",
  "date_night",
  "chill",
  "local",
  "surprise_me",
] as const;
export type DisplayIntent = (typeof DISPLAY_INTENTS)[number];

export const DISPLAY_CLASSES = ["safety", "people", "trip", "live", "places"] as const;
export type DisplayClass = (typeof DISPLAY_CLASSES)[number];
export type BudgetedClass = Exclude<DisplayClass, "safety">;

/** Every kind belongs to exactly one class. Keyed so a new kind fails to compile here. */
export const CLASS_OF_KIND: Record<MapObjectKind, DisplayClass> = {
  safety_notice: "safety",
  crew_member: "people",
  meeting_point: "people",
  social_zone: "people",
  buddy_zone: "people",
  trip_stop: "trip",
  activity_zone: "live",
  crowd_flow: "live",
  prediction: "live",
  world_pulse: "live",
  traveler_flow: "live",
  place: "places",
  event: "places",
  hidden_gem: "places",
  saved_place: "places",
  memory: "places",
  city_model: "places",
  personal_city: "places",
};

/**
 * Overall clutter budget per §17 band. Wide bands aggregate already, so they
 * need fewer objects; street/venue are where individual objects are the
 * answer. Never exceeds the caller's `limit` (≤ 200 at the route).
 */
export const BAND_CLUTTER_BUDGET: Record<ZoomBand, number> = {
  world: 40,
  city: 80,
  district: 120,
  street: 160,
  venue: 200,
};

/** Share of the budget each class may claim first, per §30 mode. Rows sum to 1. */
export const MODE_CLASS_SHARES: Record<DisplayMode, Record<BudgetedClass, number>> = {
  LIVE:           { people: 0.20, trip: 0.10, live: 0.35, places: 0.35 },
  PLACE_SELECTED: { people: 0.15, trip: 0.10, live: 0.25, places: 0.50 },
  COMPASS:        { people: 0.15, trip: 0.15, live: 0.20, places: 0.50 },
  TRIP:           { people: 0.30, trip: 0.40, live: 0.10, places: 0.20 },
  CROWD_FLOW:     { people: 0.10, trip: 0.05, live: 0.65, places: 0.20 },
  LOCATE_FRIENDS: { people: 0.60, trip: 0.15, live: 0.05, places: 0.20 },
  TIME_MACHINE:   { people: 0.05, trip: 0.10, live: 0.65, places: 0.20 },
};

/**
 * §13 intent → kind affinity. Small integers; a tie-break WITHIN a priority
 * tier only. Absent means 0.
 */
export const INTENT_KIND_AFFINITY: Record<DisplayIntent, Partial<Record<MapObjectKind, number>>> = {
  bored:       { event: 2, activity_zone: 2, hidden_gem: 1 },
  eat:         { place: 2, saved_place: 1 },
  party:       { event: 3, activity_zone: 2, social_zone: 2, crowd_flow: 1 },
  explore:     { hidden_gem: 3, place: 1, memory: 1 },
  meet_people: { social_zone: 3, buddy_zone: 2, event: 1 },
  date_night:  { place: 2, event: 1, saved_place: 1 },
  chill:       { saved_place: 2, place: 1, memory: 1 },
  local:       { hidden_gem: 2, place: 1 },
  surprise_me: { hidden_gem: 2, event: 1, activity_zone: 1 },
};

/**
 * How near a safety notice an object must be to inherit its constraint. ~100 m
 * is "the same venue and its doorstep"; a notice is minted at a place's own
 * point, so the same-place-id match below is the primary door and the radius
 * is the backstop for aggregates and events drawn around it.
 */
export const SAFETY_CONSTRAINT_RADIUS_KM = 0.1;

export interface SafetyConstraint {
  /** The notice's object id. Opaque; never a contributor. */
  noticeRef: string;
  /** Always false: a constrained object may render, never be promoted. */
  promotable: false;
}

export interface DisplayReport {
  mode: DisplayMode;
  intent: DisplayIntent | null;
  band: ZoomBand;
  /** The budget actually applied: min(limit, band budget). */
  budget: number;
  /** Non-safety objects offered. */
  considered: number;
  /** Non-safety objects kept. */
  kept: number;
  /** Safety notices, all kept, none budgeted. */
  safetyNotices: number;
  /** Objects marked with a safety constraint (kept or not). */
  safetyConstrained: number;
  droppedForBudget: number;
  droppedByKind: Partial<Record<MapObjectKind, number>>;
}

export interface ResolveDisplayInput {
  band: ZoomBand;
  mode?: string | null;
  intent?: string | null;
  /** The caller's page limit; the budget never exceeds it. */
  limit: number;
}

export interface ResolveDisplayResult {
  objects: MapObject[];
  report: DisplayReport;
}

export function parseDisplayMode(raw: unknown): DisplayMode | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  return (DISPLAY_MODES as readonly string[]).includes(v) ? (v as DisplayMode) : null;
}

export function parseDisplayIntent(raw: unknown): DisplayIntent | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return (DISPLAY_INTENTS as readonly string[]).includes(v) ? (v as DisplayIntent) : null;
}

function canonicalPlaceIdOf(obj: MapObject): string | null {
  const [kind, rest] = obj.id.split(":", 2);
  if (kind === "place" && rest) return rest;
  const p = obj.payload as { canonicalPlaceId?: unknown; placeId?: unknown } | undefined;
  if (typeof p?.canonicalPlaceId === "string" && p.canonicalPlaceId) return p.canonicalPlaceId;
  if (typeof p?.placeId === "string" && p.placeId) return p.placeId;
  return null;
}

/**
 * Mark and cap every non-safety object a safety notice constrains. Pure;
 * returns new objects for the constrained ones and the originals otherwise.
 */
export function applySafetyPrecedence(
  objects: readonly MapObject[],
  notices: readonly MapObject[],
  radiusKm: number = SAFETY_CONSTRAINT_RADIUS_KM,
): { objects: MapObject[]; constrained: number } {
  if (notices.length === 0) return { objects: [...objects], constrained: 0 };
  const anchors = notices.map((n) => ({
    ref: n.id,
    placeId: (n.payload as { placeId?: unknown } | undefined)?.placeId,
    at: centroidOf(n.geometry),
  }));
  let constrained = 0;
  const out = objects.map((obj) => {
    if (obj.kind === "safety_notice") return obj;
    const placeId = canonicalPlaceIdOf(obj);
    const here = centroidOf(obj.geometry);
    const hit = anchors.find((a) => {
      if (placeId && typeof a.placeId === "string" && a.placeId === placeId) return true;
      if (!here || !a.at) return false;
      return haversineKm(here.lat, here.lng, a.at.lat, a.at.lng) <= radiusKm;
    });
    if (!hit) return obj;
    constrained += 1;
    const basePayload =
      obj.payload && typeof obj.payload === "object" && !Array.isArray(obj.payload)
        ? (obj.payload as Record<string, unknown>)
        : {};
    const constraint: SafetyConstraint = { noticeRef: hit.ref, promotable: false };
    return {
      ...obj,
      // Only ever LOWERS: a promotion is stripped, a default is kept.
      renderingPriority: Math.min(obj.renderingPriority, KIND_DEFAULT_PRIORITY[obj.kind]),
      payload: { ...basePayload, safetyConstraint: constraint },
    };
  });
  return { objects: out, constrained };
}

/**
 * Resolve what renders. `ranked` must already carry `distanceKm` and be in
 * `compareByRenderingPriority` order (the route's `rankObjects` output).
 */
export function resolveDisplay(ranked: readonly MapObject[], input: ResolveDisplayInput): ResolveDisplayResult {
  const mode: DisplayMode = parseDisplayMode(input?.mode) ?? "LIVE";
  const intent: DisplayIntent | null = parseDisplayIntent(input?.intent);
  const band = input.band;
  const limit = Number.isFinite(input?.limit) ? Math.max(1, Math.floor(input.limit)) : 1;
  const budget = Math.max(1, Math.min(limit, BAND_CLUTTER_BUDGET[band] ?? limit));

  const notices = ranked.filter((o) => o.kind === "safety_notice");
  const others = ranked.filter((o) => o.kind !== "safety_notice");

  const precedence = applySafetyPrecedence(others, notices);
  const affinityOf = (o: MapObject): number =>
    intent ? (INTENT_KIND_AFFINITY[intent][o.kind] ?? 0) : 0;

  // Priority, then intent affinity, then distance, then id: the affinity is a
  // tie-break inside a tier by construction.
  const ordered = [...precedence.objects].sort((a, b) => {
    if (b.renderingPriority !== a.renderingPriority) return b.renderingPriority - a.renderingPriority;
    const fa = affinityOf(a), fb = affinityOf(b);
    if (fb !== fa) return fb - fa;
    return compareByRenderingPriority(a, b);
  });

  const shares = MODE_CLASS_SHARES[mode];
  const caps: Record<BudgetedClass, number> = {
    people: Math.floor(shares.people * budget),
    trip: Math.floor(shares.trip * budget),
    live: Math.floor(shares.live * budget),
    places: Math.floor(shares.places * budget),
  };
  const taken: Record<BudgetedClass, number> = { people: 0, trip: 0, live: 0, places: 0 };
  const kept: MapObject[] = [];
  const remainder: MapObject[] = [];
  for (const o of ordered) {
    const cls = CLASS_OF_KIND[o.kind] as BudgetedClass;
    if (taken[cls] < caps[cls]) { taken[cls] += 1; kept.push(o); }
    else remainder.push(o);
  }
  // Spend what under-filled classes left, best first.
  let leftover = budget - kept.length;
  const dropped: MapObject[] = [];
  for (const o of remainder) {
    if (leftover > 0) { kept.push(o); leftover -= 1; }
    else dropped.push(o);
  }

  const droppedByKind: Partial<Record<MapObjectKind, number>> = {};
  for (const o of dropped) droppedByKind[o.kind] = (droppedByKind[o.kind] ?? 0) + 1;

  const objects = [...notices, ...kept].sort(compareByRenderingPriority);
  return {
    objects,
    report: {
      mode,
      intent,
      band,
      budget,
      considered: others.length,
      kept: kept.length,
      safetyNotices: notices.length,
      safetyConstrained: precedence.constrained,
      droppedForBudget: dropped.length,
      droppedByKind,
    },
  };
}
