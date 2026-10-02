/**
 * mediaRankingSignals — the §24 terms the World-shell ranker scores, as PURE
 * functions over one candidate row plus the per-page signals
 * `services/ranking/MediaRankingSignalLoader` loads.
 *
 * Spec §24 names seventeen inputs and eight objective terms and gives no
 * formula for any of them. Every term below therefore carries its DEFINITION in
 * its own header, so what a number means can be argued with rather than
 * guessed. Two rules hold for all of them:
 *
 *   1. ABSENCE IS NEUTRAL, NEVER A GUESS. A signal the loader could not read is
 *      `null` on `MediaRankingSignals`, and a term over a `null` signal scores
 *      the same for every row on the page, so an unreadable input reorders
 *      nothing. A term never invents evidence it was not handed.
 *   2. NOTHING HERE READS ENGAGEMENT. No term takes a like, stamp, view, watch
 *      time or completion rate. §26: social analytics "do not dominate the
 *      hierarchy"; §45: do not optimise for minutes watched. The only
 *      behavioural counts read are §45 OUTCOME events (a real-world action taken
 *      from the media), and they feed exactly one term — Expected Real-World
 *      Utility — never quality, never trust.
 *
 * Nothing in this file touches a database, a flag or the clock: `nowMs` is
 * always passed in.
 */
import type { MediaCandidateRow } from "./media/mediaProjection.js";
import { normalizeProvenance, classifyEdit } from "./media/mediaEvidenceEligibility.js";

// ── Per-page signals (loaded once per ranked page) ────────────────────────────

/** One of the viewer's trips, reduced to what trip context needs. Coarse only. */
export interface ViewerTripWindow {
  id: string;
  city: string | null;
  country: string | null;
  /** Epoch ms of the first day, or null when the trip has no dates. */
  startMs: number | null;
  /** Epoch ms of the END of the last day, or null when open-ended. */
  endMs: number | null;
}

/** The gated live state of one canonical place, as the ranker needs it. */
export interface PlaceLiveState {
  /** At least one served claim is live-qualified (band live/strong, no material conflict). */
  live: boolean;
  /** Claims ARE served for the place and none of them is live-qualified, or one carries a material conflict. */
  lowConfidence: boolean;
}

/** §45 outcome events and impressions recorded against one media id. */
export interface MediaOutcomeCounts {
  outcomes: number;
  impressions: number;
}

/** A PUBLIC event the media is linked to (post_event_links). Timing and city only. */
export interface LinkedEvent {
  startMs: number | null;
  endMs: number | null;
  city: string | null;
  /** The event is cancelled or archived — it cannot be had. */
  closed: boolean;
}

/**
 * Everything the ranker may know beyond the row itself. Every field is `null`
 * when it was NOT determined (the read failed, or was not attempted), which is
 * different from an empty set (read, and there is nothing). See rule 1 above.
 */
export interface MediaRankingSignals {
  /** The viewer's own §15.1 "I Want This" signals, generalised. */
  intent: {
    mediaIds: ReadonlySet<string>;
    placeIds: ReadonlySet<string>;
    categories: ReadonlySet<string>;
  } | null;
  /** The viewer's trips (owned or accepted member). */
  trips: readonly ViewerTripWindow[] | null;
  /** The viewer's home country from their profile. */
  homeCountry: string | null;
  /** The viewer's declared travel interests, lowercased. */
  interests: ReadonlySet<string> | null;
  /** Authors the viewer follows. */
  followed: ReadonlySet<string> | null;
  /** Canonical places the viewer saved — their own discovery behaviour. */
  savedPlaceIds: ReadonlySet<string> | null;
  /** People the viewer actually coordinates with: trip crew and Shared Moment co-participants. */
  affinity: { tripCrew: ReadonlySet<string>; sharedMoment: ReadonlySet<string> } | null;
  /** Gated live state per canonical place on the page. */
  livePlaces: ReadonlyMap<string, PlaceLiveState> | null;
  /** §45 outcomes and impressions per media id on the page. */
  outcomes: ReadonlyMap<string, MediaOutcomeCounts> | null;
  /** Public events per post id on the page. */
  events: ReadonlyMap<string, LinkedEvent> | null;
  /** Post ids on the page that are an active, public Postcard. */
  postcards: ReadonlySet<string> | null;
  /** Post ids on the page whose capture location was verified at the place. */
  verifiedCapture: ReadonlySet<string> | null;
}

export const EMPTY_MEDIA_RANKING_SIGNALS: MediaRankingSignals = Object.freeze({
  intent: null,
  trips: null,
  homeCountry: null,
  interests: null,
  followed: null,
  savedPlaceIds: null,
  affinity: null,
  livePlaces: null,
  outcomes: null,
  events: null,
  postcards: null,
  verifiedCapture: null,
});

// ── Page context (derived from the candidate page itself) ─────────────────────

/** How long a perspective counts as FRESH coverage of its place. */
export const FRESH_COVERAGE_WINDOW_MS = 72 * 3_600_000;

export interface MediaRankingPage {
  /** placeId → distinct authors with a perspective there on this page. */
  authorsAtPlace: ReadonlyMap<string, ReadonlySet<string>>;
  /** placeId → how many FRESH perspectives this page holds there. */
  freshAtPlace: ReadonlyMap<string, number>;
}

function norm(s: unknown): string {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function placeOf(row: MediaCandidateRow): string | null {
  return typeof row.canonical_place_id === "string" && row.canonical_place_id ? row.canonical_place_id : null;
}

function createdMs(row: MediaCandidateRow): number | null {
  const t = Date.parse(String(row.created_at ?? ""));
  return Number.isFinite(t) ? t : null;
}

export function buildRankingPage(rows: readonly MediaCandidateRow[], nowMs: number): MediaRankingPage {
  const authorsAtPlace = new Map<string, Set<string>>();
  const freshAtPlace = new Map<string, number>();
  for (const row of rows) {
    const place = placeOf(row);
    if (!place) continue;
    const author = typeof row.author_id === "string" ? row.author_id : null;
    if (author) {
      const set = authorsAtPlace.get(place) ?? new Set<string>();
      set.add(author);
      authorsAtPlace.set(place, set);
    }
    const t = createdMs(row);
    if (t !== null && nowMs - t <= FRESH_COVERAGE_WINDOW_MS && nowMs - t >= 0) {
      freshAtPlace.set(place, (freshAtPlace.get(place) ?? 0) + 1);
    }
  }
  return { authorsAtPlace, freshAtPlace };
}

// ── Provenance (§2 "authentic outranks generated", §24 Trust / provenance) ────

/**
 * The provenance CLASS of the asset a row would display.
 *
 *   authentic       camera / library / community — a first-party capture.
 *   third_party     official / provider — real, but not a traveller's capture.
 *   non_observation screenshot — a capture of a screen, not of the world.
 *   synthetic       generated / derivative, OR any asset whose lineage carries
 *                   an evidence-BREAKING (generative) edit (§35 "major
 *                   generative alteration"). This is §2's "generated fallback".
 *   unknown         no provenance is attached — the legacy 'user' default, or
 *                   no canonical asset at all.
 *
 * READS `canonical_media` ONLY. `posts` / `post_media` carry no provenance
 * column, so a row without canonical media is `unknown` — neutral, never
 * presumed authentic and never presumed generated.
 */
export type ProvenanceClass = "authentic" | "third_party" | "non_observation" | "synthetic" | "unknown";

const SERVABLE_READY = "ready";

function displayedCanonicalAsset(row: MediaCandidateRow): Record<string, unknown> | null {
  const raw = Array.isArray(row.canonical_media) ? row.canonical_media : [];
  const ready = raw
    .filter((m: any) => m && m.processing_status === SERVABLE_READY)
    .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));
  return (ready[0] as Record<string, unknown> | undefined) ?? null;
}

export function provenanceClassOf(row: MediaCandidateRow): ProvenanceClass {
  const asset = displayedCanonicalAsset(row);
  if (!asset) return "unknown";
  const prov = normalizeProvenance(asset.provenance);
  if (prov && prov.editHistory.some((e) => classifyEdit(e.op) === "evidence_breaking")) return "synthetic";
  const raw = prov && asset.provenance && (asset.provenance as any).sourceType != null
    ? prov.sourceType
    : norm(asset.source_type);
  switch (raw) {
    case "camera":
    case "library":
    case "community":
      return "authentic";
    case "official":
    case "provider":
      return "third_party";
    case "screenshot":
      return "non_observation";
    case "generated":
    case "derivative":
      return "synthetic";
    default:
      return "unknown";
  }
}

const PROVENANCE_SCORE: Readonly<Record<ProvenanceClass, number>> = {
  authentic: 1,
  third_party: 0.7,
  unknown: 0.5,
  non_observation: 0.25,
  synthetic: 0,
};

/** §24 Trust / provenance — the ASSET half. Author trust is `authorTrustTerm`. */
export function provenanceTerm(row: MediaCandidateRow): number {
  return PROVENANCE_SCORE[provenanceClassOf(row)];
}

/** §24 Trust / provenance — the AUTHOR half: official > verified > neither. */
export function authorTrustTerm(row: MediaCandidateRow): number {
  const p = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
  if (p?.is_official === true) return 1;
  if (p?.verified === true) return 0.8;
  return 0.5;
}

// ── §24 Media quality — a property of the FILE, never of how long it was watched

/**
 * Media quality from the file's own metadata:
 *   resolution  — the SHORT side: ≥1080 → 1, ≥720 → 0.85, ≥480 → 0.6, else 0.3
 *   aspect      — an extreme strip (long:short > 3) scores 0.6, else 1
 *   durationFit — video only: 3–90 s → 1, 90–300 s → 0.7, <3 s → 0.4, >300 s → 0.5
 * The score is the MEAN of the parts that could be determined; with none it is
 * the neutral 0.5. Sharpness and composition need a decode step this tier does
 * not have (lib/mediaProcessing: no ffmpeg; images are re-encoded, not
 * analysed), so they are not scored — and not pretended.
 */
export interface MediaQuality {
  score: number;
  resolution: number | null;
  aspect: number | null;
  durationFit: number | null;
}

function displayedMedia(row: MediaCandidateRow): Record<string, any> | null {
  const canonical = displayedCanonicalAsset(row);
  if (canonical) return canonical as Record<string, any>;
  const raw = Array.isArray(row.post_media) ? row.post_media : [];
  const sorted = [...raw].filter(Boolean).sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  return (sorted[0] as Record<string, any> | undefined) ?? null;
}

export function mediaQualityOf(row: MediaCandidateRow): MediaQuality {
  const m = displayedMedia(row);
  let resolution: number | null = null;
  let aspect: number | null = null;
  let durationFit: number | null = null;
  const w = typeof m?.width === "number" ? m.width : null;
  const h = typeof m?.height === "number" ? m.height : null;
  if (w !== null && h !== null && w > 0 && h > 0) {
    const short = Math.min(w, h);
    const long = Math.max(w, h);
    resolution = short >= 1080 ? 1 : short >= 720 ? 0.85 : short >= 480 ? 0.6 : 0.3;
    aspect = long / short > 3 ? 0.6 : 1;
  }
  if (m && m.media_type === "video") {
    const seconds =
      typeof m.duration_seconds === "number" ? m.duration_seconds
        : typeof m.duration_ms === "number" ? m.duration_ms / 1000
          : null;
    if (seconds !== null && seconds > 0) {
      durationFit = seconds < 3 ? 0.4 : seconds <= 90 ? 1 : seconds <= 300 ? 0.7 : 0.5;
    }
  }
  const parts = [resolution, aspect, durationFit].filter((x): x is number => x !== null);
  const score = parts.length === 0 ? 0.5 : parts.reduce((a, b) => a + b, 0) / parts.length;
  return { score, resolution, aspect, durationFit };
}

// ── §24 inputs ────────────────────────────────────────────────────────────────

/**
 * Viewer intent (§24, fed by §15.1). A want is "a signal for what the user
 * wants to do", so it generalises past the one item: the wanted item itself
 * 1.0, another perspective of a wanted PLACE 0.8, another perspective in a
 * wanted CATEGORY 0.5. The viewer's own signals only.
 */
export function intentTerm(row: MediaCandidateRow, s: MediaRankingSignals, legacyWanted?: ReadonlySet<string>): number {
  const id = String(row.id);
  if (legacyWanted?.has(id) || s.intent?.mediaIds.has(id)) return 1;
  if (!s.intent) return 0;
  const place = placeOf(row);
  if (place && s.intent.placeIds.has(place)) return 0.8;
  const cat = norm(row.category);
  if (cat && s.intent.categories.has(cat)) return 0.5;
  return 0;
}

const DAY_MS = 86_400_000;

function tripNotOver(t: ViewerTripWindow, nowMs: number): boolean {
  return t.endMs === null || t.endMs >= nowMs;
}

function tripActive(t: ViewerTripWindow, nowMs: number): boolean {
  return t.startMs !== null && t.startMs <= nowMs && tripNotOver(t, nowMs);
}

/**
 * Trip context (§24): media on one of the viewer's own trips 1.0; media in the
 * destination CITY of a trip that is not over 0.8; in its country 0.3.
 */
export function tripContextTerm(
  row: MediaCandidateRow,
  s: MediaRankingSignals,
  viewerTripIds: ReadonlySet<string> | undefined,
  nowMs: number,
): number {
  const tripId = typeof row.trip_id === "string" ? row.trip_id : null;
  if (tripId && viewerTripIds?.has(tripId)) return 1;
  if (!s.trips) return 0;
  const city = norm(row.location_city);
  const country = norm(row.location_country);
  let best = 0;
  for (const t of s.trips) {
    if (!tripNotOver(t, nowMs)) continue;
    if (city && norm(t.city) === city) best = Math.max(best, 0.8);
    else if (country && norm(t.country) === country) best = Math.max(best, 0.3);
  }
  return best;
}

/**
 * Current location (§24). Media never carries the viewer's GPS and the ranker
 * never asks for it: the viewer's location is the destination of a trip that
 * is ACTIVE today (1.0 on a city match), else their home country (0.3).
 */
export function locationTerm(row: MediaCandidateRow, s: MediaRankingSignals, nowMs: number): number {
  const city = norm(row.location_city);
  const country = norm(row.location_country);
  if (s.trips && city) {
    for (const t of s.trips) if (tripActive(t, nowMs) && norm(t.city) === city) return 1;
  }
  if (country && s.homeCountry && norm(s.homeCountry) === country) return 0.3;
  return 0;
}

/** The window an event occupies; an event with no end is taken to run 6 h. */
function eventWindow(e: LinkedEvent): { start: number; end: number } | null {
  if (e.startMs === null) return null;
  return { start: e.startMs, end: e.endMs ?? e.startMs + 6 * 3_600_000 };
}

function eventOver(e: LinkedEvent, nowMs: number): boolean {
  if (e.closed) return true;
  const w = eventWindow(e);
  return w !== null && w.end < nowMs;
}

/**
 * Availability (§24). Only a TIME-BOUND experience has an availability to fit,
 * so this reads the public event the media is linked to: over or closed 0;
 * running now or starting within 8 h 1.0; inside one of the viewer's trip
 * windows in the event's city 0.8; any other future time 0.2. Media with no
 * linked event scores 0 — the viewer's free time is never inferred.
 */
export function availabilityTerm(row: MediaCandidateRow, s: MediaRankingSignals, nowMs: number): number {
  const e = s.events?.get(String(row.id));
  if (!e) return 0;
  if (eventOver(e, nowMs)) return 0;
  const w = eventWindow(e);
  if (!w) return 0.2;
  if (w.start <= nowMs + 8 * 3_600_000) return 1;
  if (s.trips && e.city) {
    for (const t of s.trips) {
      if (norm(t.city) !== norm(e.city) || t.startMs === null) continue;
      const tEnd = t.endMs ?? t.startMs + DAY_MS;
      if (w.start <= tEnd && w.end >= t.startMs) return 0.8;
    }
  }
  return 0.2;
}

/** Travel preferences (§24): the media's category is one of the viewer's declared interests. */
export function preferenceTerm(row: MediaCandidateRow, s: MediaRankingSignals): number {
  const cat = norm(row.category);
  return cat && s.interests?.has(cat) ? 1 : 0;
}

/** Follow graph (§24): the author is someone the viewer follows. */
export function followTerm(row: MediaCandidateRow, s: MediaRankingSignals, followed?: ReadonlySet<string>): number {
  const author = typeof row.author_id === "string" ? row.author_id : null;
  if (!author) return 0;
  return followed?.has(author) || s.followed?.has(author) ? 1 : 0;
}

/** Discovery behaviour (§24, §47 "You've saved nearby places"): the media is at a place the viewer saved. */
export function discoveryTerm(row: MediaCandidateRow, s: MediaRankingSignals): number {
  const place = placeOf(row);
  return place && s.savedPlaceIds?.has(place) ? 1 : 0;
}

/** Live state (§24): the place carries a live-QUALIFIED claim through the gated read. */
export function liveTerm(row: MediaCandidateRow, s: MediaRankingSignals): number {
  const place = placeOf(row);
  return place && s.livePlaces?.get(place)?.live ? 1 : 0;
}

/**
 * "− Low-confidence Live Claims" (§24 objective penalty). 1 when the place's
 * served claims are all below the live band or one is materially conflicted —
 * the ranker must not push a perspective on the strength of a shaky claim.
 */
export function lowConfidenceLiveTerm(row: MediaCandidateRow, s: MediaRankingSignals): number {
  const place = placeOf(row);
  return place && s.livePlaces?.get(place)?.lowConfidence ? 1 : 0;
}

/** Freshness (§24) and, by its decay, "− Staleness": exp(−age / 7 days); unparseable → 0.5. */
export function freshnessTerm(row: MediaCandidateRow, nowMs: number): number {
  const t = createdMs(row);
  if (t === null) return 0.5;
  const ageHours = Math.max(0, nowMs - t) / 3_600_000;
  return Math.exp(-ageHours / (24 * 7));
}

/** Place relevance (§24): bound to a canonical place 1.0, only a free-text label 0.5, no place 0. */
export function placeRelevanceTerm(row: MediaCandidateRow): number {
  if (placeOf(row)) return 1;
  return typeof row.location_name === "string" && row.location_name.trim() ? 0.5 : 0;
}

/**
 * Social relevance (§24): how many OTHER people from the viewer's own graph —
 * followed, trip crew, Shared Moment — have a perspective at the same place on
 * this page. Saturates at 3. Global like/view counts are never read.
 */
export function socialTerm(row: MediaCandidateRow, s: MediaRankingSignals, page: MediaRankingPage, followed?: ReadonlySet<string>): number {
  const place = placeOf(row);
  if (!place) return 0;
  const authors = page.authorsAtPlace.get(place);
  if (!authors) return 0;
  const self = typeof row.author_id === "string" ? row.author_id : null;
  let n = 0;
  for (const a of authors) {
    if (a === self) continue;
    if (followed?.has(a) || s.followed?.has(a) || s.affinity?.tripCrew.has(a) || s.affinity?.sharedMoment.has(a)) n += 1;
  }
  return Math.min(1, n / 3);
}

// ── §24 objectives ────────────────────────────────────────────────────────────

/** Smoothing for the outcome rate: a prior of 0.5 outcomes in 10 impressions. */
export const UTILITY_PRIOR_OUTCOMES = 0.5;
export const UTILITY_PRIOR_IMPRESSIONS = 10;
/** An outcome rate at or above this reads as full utility. */
export const UTILITY_SATURATION_RATE = 0.2;

/**
 * Expected Real-World Utility (§24 objective). The empirical rate at which a
 * perspective led viewers to a §45 real-world action — open the place, ask
 * Compass, route, add to a trip, plan, arrive — per impression, smoothed
 * toward a small prior so one lucky tap is not "utility", and saturating at
 * UTILITY_SATURATION_RATE. It is a prediction of real-world action taken FROM
 * THIS MEDIA, not a property of the candidate's kind. Watch time and likes are
 * not outcomes and are not counted.
 */
export function utilityTerm(row: MediaCandidateRow, s: MediaRankingSignals): number {
  if (!s.outcomes) return 0;
  const c = s.outcomes.get(String(row.id)) ?? { outcomes: 0, impressions: 0 };
  const rate = (Math.max(0, c.outcomes) + UTILITY_PRIOR_OUTCOMES) / (Math.max(0, c.impressions) + UTILITY_PRIOR_IMPRESSIONS);
  return Math.min(1, rate / UTILITY_SATURATION_RATE);
}

function inViewerTripCity(city: string, s: MediaRankingSignals, nowMs: number): boolean {
  if (!city || !s.trips) return false;
  return s.trips.some((t) => tripNotOver(t, nowMs) && norm(t.city) === city);
}

/**
 * Experience Fit (§24 objective). Does the EXPERIENCE this media belongs to
 * (a linked event, or the trip it was posted on) fit the viewer's actual
 * situation? An experience that is over cannot fit: 0. One in a city the
 * viewer is in or going to, or at a place / in a category they WANT, 1.0. An
 * experience that is still available but fits neither, 0.3. Media that belongs
 * to no experience scores 0 — there is nothing to fit.
 */
export function experienceFitTerm(row: MediaCandidateRow, s: MediaRankingSignals, nowMs: number): number {
  const e = s.events?.get(String(row.id)) ?? null;
  const onTrip = typeof row.trip_id === "string" && row.trip_id.length > 0;
  if (!e && !onTrip) return 0;
  if (e && eventOver(e, nowMs)) return 0;
  const city = norm(e?.city ?? row.location_city);
  const place = placeOf(row);
  const cat = norm(row.category);
  const wanted =
    (place !== null && Boolean(s.intent?.placeIds.has(place))) ||
    (cat !== "" && Boolean(s.intent?.categories.has(cat)));
  return inViewerTripCity(city, s, nowMs) || wanted ? 1 : 0.3;
}

/**
 * Useful Social Connection (§24 objective). Distinct from follow-graph
 * PROXIMITY (§24 Follow graph): a connection is USEFUL when it can change what
 * the viewer does in the real world. The author is trip crew or a Shared Moment
 * co-participant — someone the viewer is actually coordinating with — 1.0; the
 * author is followed AND the media is in the city of a trip the viewer has not
 * finished — someone who has been where they are going — 0.6; otherwise 0.
 */
export function usefulSocialTerm(row: MediaCandidateRow, s: MediaRankingSignals, nowMs: number, followed?: ReadonlySet<string>): number {
  const author = typeof row.author_id === "string" ? row.author_id : null;
  if (!author) return 0;
  if (s.affinity && (s.affinity.tripCrew.has(author) || s.affinity.sharedMoment.has(author))) return 1;
  const isFollowed = Boolean(followed?.has(author) || s.followed?.has(author));
  if (isFollowed && inViewerTripCity(norm(row.location_city), s, nowMs)) return 0.6;
  return 0;
}

/**
 * Contribution Value (§24 objective): the MARGINAL information this perspective
 * adds to the world picture — NOT who posted it. Two parts:
 *   coverage gap  (0.6) — a FRESH perspective at a place this page otherwise
 *                         holds few fresh perspectives of: 1 / (fresh there).
 *                         Stale or place-less media fills no current gap: 0.
 *   verified      (0.4) — the capture location was verified at the place.
 * It deliberately does NOT read contributor reputation: since migration 3002 a
 * contributor's intel rows are keyed by rotating tokens, and resolving another
 * account's tokens to rank their media would re-link contributions to accounts
 * for a purpose the bridge was not built for.
 */
export function contributionTerm(row: MediaCandidateRow, s: MediaRankingSignals, page: MediaRankingPage, nowMs: number): number {
  const place = placeOf(row);
  const t = createdMs(row);
  let gap = 0;
  if (place && t !== null && nowMs - t >= 0 && nowMs - t <= FRESH_COVERAGE_WINDOW_MS) {
    const fresh = Math.max(1, page.freshAtPlace.get(place) ?? 1);
    gap = 1 / fresh;
  }
  const verified = s.verifiedCapture?.has(String(row.id)) ? 1 : 0;
  return 0.6 * gap + 0.4 * verified;
}

/** A caption counts as narrative from this many words. */
export const NARRATIVE_CAPTION_MIN_WORDS = 8;

/**
 * Narrative Value (§24 objective): the media is part of a STORY rather than a
 * lone frame. A Postcard — §28's "curated travel narrative" — 1.0; part of an
 * experience (a linked event, or posted on a trip) 0.7; a caption of at least
 * NARRATIVE_CAPTION_MIN_WORDS words 0.4; otherwise 0.
 */
export function narrativeTerm(row: MediaCandidateRow, s: MediaRankingSignals): number {
  const id = String(row.id);
  if (s.postcards?.has(id)) return 1;
  if (s.events?.has(id) || (typeof row.trip_id === "string" && row.trip_id.length > 0)) return 0.7;
  const words = typeof row.content === "string" ? row.content.trim().split(/\s+/).filter(Boolean).length : 0;
  return words >= NARRATIVE_CAPTION_MIN_WORDS ? 0.4 : 0;
}
