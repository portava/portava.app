/**
 * compassMapModel — Compass Map Mode (Map spec §14).
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE
 * ==========================================
 * Spec §14, second sentence:
 *
 *     "Compass does not create live facts; it reasons over structured state
 *      produced elsewhere."
 *
 * restated as a hard non-goal in §37:
 *
 *     "Do not let Compass invent live conditions."
 *
 * The dangerous version of that bug is not a fabricated place — it is a
 * fabricated *upgrade*. A recommendation engine that is confident about its
 * PICK very easily leaks that confidence onto the pick's underlying live state,
 * and a bar last observed two hours ago is suddenly rendered pulsing and
 * "Confirmed" because Compass ranked it first. Nobody wrote that line of code
 * on purpose; it falls out of building the pick object by spreading defaults
 * over a partial source.
 *
 * `clampToSource()` makes that structurally impossible. Every pick's live state
 * goes through it, and it can only ever move a value toward LESS certain and
 * LESS current — never the other way. `carryLiveState()` is the only blessed
 * constructor of a pick's state, and it routes through the clamp, so a caller
 * cannot bypass it by accident.
 *
 * The second §14 requirement is the count: "highlights approximately three to
 * five best next moves". That is enforced at BOTH ends. The upper bound is a
 * truncation; the lower bound is a refusal — `selectCompassPicks()` returns
 * `ok: false` when fewer than three moves exist, because the honest response to
 * "there are two things worth doing" is to not enter a mode whose whole premise
 * is a shortlist, not to pad the list.
 *
 * WHAT THIS IS NOT
 * ================
 * Pure data + pure functions. No network, no React, no clock. It does no
 * ranking of its own beyond a deterministic tie-break over scores the Compass
 * ranking service already produced (spec §19: the client does not reconstruct
 * Portava intelligence rules).
 */

import {
  CONFIDENCE_STATES,
  FRESHNESS_STATES,
  KIND_DEFAULT_PRIORITY,
  RENDERING_PRIORITY,
  mayRenderAsLive,
  point,
} from '../../../types/mapObjects.ts';
import type {
  ActivityLevel,
  ConfidenceState,
  FreshnessState,
  MapAction,
  MapObject,
  MapObjectKind,
  MapProvenance,
  PrivacyClass,
  TrendState,
} from '../../../types/mapObjects.ts';

// ── The §14 count bound ────────────────────────────────────────────────────────

/** Spec §14: "approximately three to five best next moves." */
export const COMPASS_MAP_MIN_PICKS = 3;
export const COMPASS_MAP_MAX_PICKS = 5;

// ── Live state, as produced elsewhere ──────────────────────────────────────────

/**
 * The live state of a candidate, exactly as the projection handed it over.
 *
 * This type exists so that "the state Compass was GIVEN" and "the state Compass
 * PRESENTS" are two separately nameable things, and the only path from the
 * first to the second is `clampToSource`.
 */
export interface CompassSourceState {
  freshness?: FreshnessState;
  confidence?: ConfidenceState;
  activity?: ActivityLevel;
  trend?: TrendState;
  observedAt?: string;
  expiresAt?: string;
}

/**
 * Rank within FRESHNESS_STATES; higher = LESS current.
 * Order is live, recent, aging, stale, historical, unknown — with `unknown`
 * last precisely because it is the fail-closed default (mapObjects.ts).
 */
function freshnessRank(f: FreshnessState): number {
  return FRESHNESS_STATES.indexOf(f);
}

/** Rank within CONFIDENCE_STATES; higher = MORE certain. */
function confidenceRank(c: ConfidenceState): number {
  return CONFIDENCE_STATES.indexOf(c);
}

/**
 * THE GUARD. Returns a state that is never more current and never more certain
 * than `source`.
 *
 * Rules, all one-directional:
 *  - freshness: the LESS current of the two. An absent source freshness is
 *    `unknown`, which is the least current value there is, so a source that
 *    never stated freshness pins every proposal to `unknown`.
 *  - confidence: the LOWER band of the two. An absent source confidence yields
 *    an absent result — you cannot claim a band you were never given.
 *  - activity / trend / observedAt / expiresAt: carried through from the SOURCE
 *    verbatim. These are observations; a recommender has no standing to restate
 *    them at all, so the proposal's values are discarded rather than merged.
 *
 * The function is idempotent and monotone: `clampToSource(clampToSource(p, s), s)`
 * equals `clampToSource(p, s)`, and clamping can only move values downward.
 */
export function clampToSource(
  proposed: CompassSourceState | null | undefined,
  source: CompassSourceState | null | undefined,
): CompassSourceState {
  const src: CompassSourceState = source ?? {};
  const prop: CompassSourceState = proposed ?? {};

  const srcFresh: FreshnessState = src.freshness ?? 'unknown';
  const propFresh: FreshnessState | undefined = prop.freshness;
  const freshness: FreshnessState =
    propFresh == null
      ? srcFresh
      : freshnessRank(propFresh) >= freshnessRank(srcFresh)
        ? propFresh
        : srcFresh;

  let confidence: ConfidenceState | undefined;
  if (src.confidence != null) {
    const propConf = prop.confidence;
    confidence =
      propConf == null
        ? src.confidence
        : confidenceRank(propConf) <= confidenceRank(src.confidence)
          ? propConf
          : src.confidence;
  } else {
    confidence = undefined;
  }

  const out: CompassSourceState = { freshness };
  if (confidence != null) out.confidence = confidence;
  if (src.activity != null) out.activity = src.activity;
  if (src.trend != null) out.trend = src.trend;
  if (src.observedAt != null) out.observedAt = src.observedAt;
  if (src.expiresAt != null) out.expiresAt = src.expiresAt;
  return out;
}

/**
 * The only blessed way to build the state a Compass pick presents.
 * Equivalent to `clampToSource(source, source)` — i.e. Compass proposes
 * nothing of its own, and the clamp is applied anyway so that the invariant
 * holds by construction rather than by convention.
 */
export function carryLiveState(source: CompassSourceState | null | undefined): CompassSourceState {
  return clampToSource(source, source);
}

// ── Candidates ─────────────────────────────────────────────────────────────────

/**
 * A ranked candidate handed to Compass Map Mode.
 *
 * `score` comes from the Compass ranking service. This module never computes
 * one; it only breaks ties deterministically so that two renders of the same
 * response cannot disagree about the order.
 */
export interface CompassMapCandidate {
  id: string;
  title: string;
  subtitle?: string;
  lat: number;
  lng: number;
  /** Defaults to 'place'. */
  kind?: MapObjectKind;

  /** The live state produced elsewhere. Compass may only carry this through. */
  source?: CompassSourceState;

  /** Ranking score from the Compass ranking service; higher is better. */
  score?: number;

  // §14 "WHY THIS OPTION" inputs — all optional, all facts from elsewhere.
  /** Whether the candidate matched the user's active §13 temporary intent. */
  matchesIntent?: boolean;
  /** Display label of that intent, e.g. "Party". */
  intentLabel?: string | null;
  /** Travel time from the user, in minutes. */
  minutesAway?: number | null;
  /** Travel time from the trip crew, in minutes. */
  crewMinutesAway?: number | null;
  /** How many further good options sit within walking distance. */
  nearbyNextOptions?: number | null;

  privacyClass?: PrivacyClass;
  provenance?: MapProvenance;
  sourceRefs?: string[];
  detailRoute?: string;
  distanceKm?: number | null;
  /** Opaque original row, for cards that render type-specific fields. */
  raw?: unknown;
}

// ── §14 "WHY THIS OPTION" ──────────────────────────────────────────────────────

/** The six factor kinds §14 enumerates, in the spec's own order. */
export const COMPASS_WHY_FACTORS = [
  'matches_intent',
  'getting_busier',
  'minutes_away',
  'strong_current_evidence',
  'crew_minutes_away',
  'good_next_options',
] as const;
export type CompassWhyFactor = (typeof COMPASS_WHY_FACTORS)[number];

export interface CompassWhyLine {
  factor: CompassWhyFactor;
  text: string;
}

/** Trends that legitimately read as "Getting busier". */
const BUSIER_TRENDS: readonly TrendState[] = ['increasing_quickly', 'getting_busier'];

/** Bands that legitimately read as "Strong current evidence". */
const STRONG_BANDS: readonly ConfidenceState[] = ['live', 'strong'];

/**
 * Build the §14 panel for one candidate.
 *
 * Every line is emitted ONLY when the supplied data supports it. The two live
 * lines carry an extra condition beyond "the field is set":
 *
 *  - "Getting busier" additionally requires `mayRenderAsLive(freshness)`. A
 *    rising trend observed an hour ago is not a live condition, and saying so
 *    on a Compass card is precisely §37's "let stale claims remain visually
 *    live" wearing a recommendation's clothes.
 *  - "Strong current evidence" additionally requires the same, because the word
 *    doing the work in that line is *current*, not *strong*.
 *
 * `state` must be a clamped state (`carryLiveState` / `clampToSource`); passing
 * a raw proposal would let a why-line outrun its source.
 */
export function buildWhyLines(
  candidate: CompassMapCandidate,
  state: CompassSourceState,
): CompassWhyLine[] {
  const lines: CompassWhyLine[] = [];
  const live = mayRenderAsLive(state.freshness);

  if (candidate.matchesIntent) {
    const label = candidate.intentLabel?.trim();
    lines.push({
      factor: 'matches_intent',
      text: label ? `Matches current ${label} intent` : 'Matches current intent',
    });
  }

  if (live && state.trend != null && BUSIER_TRENDS.includes(state.trend)) {
    lines.push({ factor: 'getting_busier', text: 'Getting busier' });
  }

  if (candidate.minutesAway != null && Number.isFinite(candidate.minutesAway)) {
    const m = Math.max(1, Math.round(candidate.minutesAway));
    lines.push({ factor: 'minutes_away', text: `${m} minute${m === 1 ? '' : 's'} away` });
  }

  if (live && state.confidence != null && STRONG_BANDS.includes(state.confidence)) {
    lines.push({ factor: 'strong_current_evidence', text: 'Strong current evidence' });
  }

  if (candidate.crewMinutesAway != null && Number.isFinite(candidate.crewMinutesAway)) {
    const m = Math.max(1, Math.round(candidate.crewMinutesAway));
    lines.push({ factor: 'crew_minutes_away', text: `Crew ${m} minute${m === 1 ? '' : 's'} away` });
  }

  if ((candidate.nearbyNextOptions ?? 0) >= 2) {
    lines.push({ factor: 'good_next_options', text: 'Good next options nearby' });
  }

  return lines;
}

// ── Picks ──────────────────────────────────────────────────────────────────────

export interface CompassPick {
  candidate: CompassMapCandidate;
  /** 1-based position in the shortlist. */
  rank: number;
  /** The clamped live state. Never more current or certain than the source. */
  state: CompassSourceState;
  why: CompassWhyLine[];
}

/**
 * The result of shortlisting. `ok: false` is not an error condition — it is the
 * §14 lower bound saying "there is no shortlist here". The caller should stay
 * in LIVE mode and render `picks` (0-2 of them) as ordinary relevant places
 * rather than entering Compass Map Mode with a thin list.
 */
export type CompassPickSet =
  | { ok: true; picks: CompassPick[] }
  | { ok: false; reason: 'insufficient_candidates'; picks: CompassPick[]; available: number };

/**
 * Deterministic candidate ordering: score desc → minutes away asc → title →
 * id. Every tie-break is total, so the same response always yields the same
 * shortlist and the same marker z-order.
 */
export function compareCandidates(a: CompassMapCandidate, b: CompassMapCandidate): number {
  const sa = a.score ?? Number.NEGATIVE_INFINITY;
  const sb = b.score ?? Number.NEGATIVE_INFINITY;
  if (sa !== sb) return sb - sa;
  const ma = a.minutesAway ?? Number.POSITIVE_INFINITY;
  const mb = b.minutesAway ?? Number.POSITIVE_INFINITY;
  if (ma !== mb) return ma - mb;
  const t = a.title.localeCompare(b.title);
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Shortlist to §14's three-to-five best next moves.
 *
 * Candidates without usable coordinates are dropped before counting — a pick
 * the map cannot place is not a "next move", and counting it would let the
 * lower bound pass on a list the user never sees.
 *
 * Duplicate ids collapse to their first occurrence, so a candidate that appears
 * in two ranking sections cannot consume two of the five slots.
 */
export function selectCompassPicks(
  candidates: readonly CompassMapCandidate[],
  opts: { max?: number; min?: number } = {},
): CompassPickSet {
  const max = Math.min(opts.max ?? COMPASS_MAP_MAX_PICKS, COMPASS_MAP_MAX_PICKS);
  const min = Math.max(opts.min ?? COMPASS_MAP_MIN_PICKS, 0);

  const seen = new Set<string>();
  const usable: CompassMapCandidate[] = [];
  for (const c of candidates ?? []) {
    if (!c || typeof c.id !== 'string' || c.id === '') continue;
    if (typeof c.title !== 'string' || c.title.trim() === '') continue;
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    usable.push(c);
  }

  usable.sort(compareCandidates);

  const picks: CompassPick[] = usable.slice(0, max).map((candidate, i) => {
    const state = carryLiveState(candidate.source);
    return { candidate, rank: i + 1, state, why: buildWhyLines(candidate, state) };
  });

  if (picks.length < min) {
    return {
      ok: false,
      reason: 'insufficient_candidates',
      picks,
      available: picks.length,
    };
  }
  return { ok: true, picks };
}

// ── Map objects ────────────────────────────────────────────────────────────────

/** §6: "Star — Compass Pick / high-value recommendation". */
export const COMPASS_STAR_TREATMENT = 'compass_star' as const;

export interface CompassMapObjectPayload {
  compassPick: true;
  rank: number;
  why: CompassWhyLine[];
  /** §6 semantic visual language: Compass Picks render as a star, not a pin. */
  treatment: typeof COMPASS_STAR_TREATMENT;
  /** Canonical entity id, so the §26 bridge can match this to a Pulse subject. */
  sourceId: string;
  /** The untouched source row, for the Live Place sheet. */
  raw?: unknown;
}

const COMPASS_ACTIONS: MapAction[] = ['navigate', 'save', 'add_to_trip', 'meet_here', 'ask_compass', 'share'];

/**
 * Project picks onto the map.
 *
 * Three things are guaranteed here and tested:
 *  1. `freshness` / `confidence` / `activity` / `trend` are the pick's CLAMPED
 *     state — a Compass pick over a stale place stays stale.
 *  2. Every pick sits at `RENDERING_PRIORITY.compass_recommendation` (§31), so
 *     it outranks ordinary places and events but still yields to Safety, the
 *     User, Active Navigation and Trip Crew (§5).
 *  3. Every pick carries the §6 star treatment in its payload.
 *
 * `privacyClass` is carried from the candidate and defaults to `place_level` —
 * a Compass pick is a public venue, not a person. Nothing here sharpens
 * geometry: the coordinates are the candidate's own.
 */
export function toMapObjects(picks: readonly CompassPick[]): MapObject<CompassMapObjectPayload>[] {
  return (picks ?? []).map((pick) => {
    const c = pick.candidate;
    const kind: MapObjectKind = c.kind ?? 'place';
    const state = clampToSource(pick.state, c.source);

    const obj: MapObject<CompassMapObjectPayload> = {
      id: `${kind}:${c.id}`,
      kind,
      geometry: point(c.lat, c.lng),
      title: c.title,
      privacyClass: c.privacyClass ?? 'place_level',
      renderingPriority: RENDERING_PRIORITY.compass_recommendation,
      interaction: {
        actions: COMPASS_ACTIONS,
        detailRoute: c.detailRoute,
        opensSheet: true,
        contributable: kind === 'place' || kind === 'hidden_gem',
      },
      payload: {
        compassPick: true,
        rank: pick.rank,
        why: pick.why,
        treatment: COMPASS_STAR_TREATMENT,
        sourceId: c.id,
        raw: c.raw,
      },
    };

    if (c.subtitle != null) obj.subtitle = c.subtitle;
    if (state.freshness != null) obj.freshness = state.freshness;
    if (state.confidence != null) obj.confidence = state.confidence;
    if (state.activity != null) obj.activity = state.activity;
    if (state.trend != null) obj.trend = state.trend;
    if (state.observedAt != null) obj.observedAt = state.observedAt;
    if (state.expiresAt != null) obj.expiresAt = state.expiresAt;
    if (c.provenance != null) obj.provenance = c.provenance;
    if (c.sourceRefs != null) obj.sourceRefs = c.sourceRefs;
    if (c.distanceKm !== undefined) obj.distanceKm = c.distanceKm;

    return obj;
  });
}

/**
 * The one-call entry point for the Compass Map Mode screen.
 * Returns the pick set alongside its map objects so the caller does not have to
 * remember to route through `selectCompassPicks` before projecting (which would
 * bypass the count bound).
 */
export function buildCompassMapMode(
  candidates: readonly CompassMapCandidate[],
  opts: { max?: number; min?: number } = {},
): { picks: CompassPickSet; objects: MapObject<CompassMapObjectPayload>[] } {
  const picks = selectCompassPicks(candidates, opts);
  return { picks, objects: toMapObjects(picks.picks) };
}

/**
 * Non-Compass objects that share the viewport during Compass Map Mode.
 * §14's first clause is "reduces visual noise": everything below the
 * `relevant_place` rung is suppressed while the mode is active, and Safety /
 * User / Navigation / Crew objects (§5) are always kept.
 */
export function suppressNoise(objects: readonly MapObject[]): MapObject[] {
  return (objects ?? []).filter(
    (o) => o.renderingPriority >= (KIND_DEFAULT_PRIORITY.place ?? RENDERING_PRIORITY.relevant_place),
  );
}
