/**
 * DuplicateDetectionService (Phase 5 — Creation, spec §20/§36/§55).
 *
 * Real duplicate detection for the creation contexts: when a user is CREATING a
 * Gem, Place, or Event, first surface likely-existing canonical records so the
 * flow can resolve an existing record instead of minting a duplicate (§20
 * "resolve existing records first", §55 gem creation, §36 duplicate-entity
 * suppression).
 *
 * REUSE, not reimplementation:
 *   - Name folding is the SAME `searchKey` (stroke/diacritic/case fold) the
 *     canonical geographic registry is indexed by — so "Đà Nẵng"/"da nang" and
 *     "Sky 36"/"sky36" collapse identically on both sides.
 *   - Token-set name similarity + haversine proximity reuse the proven place
 *     dedup primitives (`nameSimilarity`, `haversineKm`, `isSamePlace`) from
 *     lib/places/placeResolve — the same math the canonical `places` merge uses.
 *
 * This REPLACES the gem-dedup STUB (services/hiddenGems/HiddenGemModerationService
 * .getDuplicateCandidates, which returned pending gems with NO similarity): the
 * scoring core here is what genuinely decides "same gem" vs "different gem".
 *
 * IMPORTANT (§20/§37 — SUGGEST, never block): every finder here only PROPOSES an
 * existing record. It never blocks creation and never auto-merges; the creation
 * flow (or the user) decides. Empty entity tables are normal pre-launch
 * (completeness-framing) — every finder degrades to [] gracefully.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { searchKey, haversineKm } from '../canonicalLocations';
import { nameSimilarity, isSamePlace, type PlaceLike } from '../places/placeResolve';
import { safeOrIlikeValue } from '../postgrestFilter';

// ── Canonical dedup entity (the shape both sides compare on) ───────────────────

export interface DedupEntity {
  id: string;
  name: string;
  city: string | null;
  country: string | null;
  category?: string | null;
  lat: number | null;
  lng: number | null;
}

/** What the caller is trying to create. Coordinates optional (a gem may only have a city). */
export interface DedupCandidateInput {
  name: string;
  city?: string | null;
  country?: string | null;
  category?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export type DuplicateStrength = 'strong' | 'likely' | 'weak';

export interface DuplicateMatch {
  entity: DedupEntity;
  /** 0..1 — higher means more confidently the same real-world entity. */
  score: number;
  strength: DuplicateStrength;
  /** Short human label for the "why" ("Same spot", "Same name in Da Nang"). */
  reason: string;
}

// ── Thresholds (tuned, documented) ────────────────────────────────────────────

/** At/under this distance two same-ish-named entities are the SAME spot. */
export const GEM_SAME_SPOT_KM = 0.25; // ~250 m
/** Beyond same-spot but still "near"; a strong name match here is a likely dup. */
export const GEM_NEAR_KM = 1.0;
/** Name too dissimilar below this → never a duplicate (avoids false merges). */
export const NAME_MIN_SIM = 0.5;
/** A "strong" name match (near-identical wording). */
export const NAME_STRONG_SIM = 0.8;
/** Score at/above which a candidate is surfaced as a probable duplicate. */
export const DUPLICATE_THRESHOLD = 0.6;

function cityFold(city: string | null | undefined): string {
  return searchKey(city ?? '');
}

function sameCity(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = cityFold(a);
  const kb = cityFold(b);
  return ka.length > 0 && ka === kb;
}

/**
 * PURE scoring core (§20/§36). Returns 0..1 for how confidently `existing` is the
 * SAME real-world gem as the `candidate` being created.
 *
 * Combines three signals, all reused primitives:
 *   1. Name — `searchKey`-folded equality (score 1) else token-set similarity.
 *   2. Proximity — haversine, when BOTH sides carry coordinates.
 *   3. City — folded-name equality of the free-text city.
 *
 * Rules (proximity dominates when coordinates exist):
 *   • coords + ≤ same-spot distance + a real name match → STRONG (0.9–1.0)
 *   • coords + ≤ near distance + strong name match      → LIKELY (~0.75)
 *   • coords + BEYOND near distance                     → 0 (different spot,
 *       even if the name is identical — two "Sunset Bar"s far apart differ)
 *   • no coords + same city + strong name               → LIKELY (~0.8)
 *   • no coords + same city + weak-but-present name      → weak (~0.55)
 *   • no coords + exact folded name + unknown city       → weak (0.5)
 * A name below `NAME_MIN_SIM` is never a duplicate.
 *
 * Exported so a test can prove it directly (and prove the gateway goes RED when
 * this is neutered to always-0).
 */
export function scoreGemDuplicate(candidate: DedupCandidateInput, existing: DedupEntity): number {
  const kCand = searchKey(candidate.name ?? '');
  const kEx = searchKey(existing.name ?? '');
  if (!kCand || !kEx) return 0;

  const foldEqual = kCand === kEx;
  const nameSim = foldEqual ? 1 : nameSimilarity(candidate.name, existing.name);
  if (nameSim < NAME_MIN_SIM) return 0; // names too different → not the same entity

  const haveCoords =
    candidate.lat != null && candidate.lng != null &&
    existing.lat != null && existing.lng != null;

  if (haveCoords) {
    const dist = haversineKm(candidate.lat!, candidate.lng!, existing.lat!, existing.lng!);
    if (dist <= GEM_SAME_SPOT_KM) {
      // Same spot + a plausible name → strong. Blend so an exact name scores top.
      return Math.min(1, 0.6 + 0.4 * nameSim);
    }
    if (dist <= GEM_NEAR_KM) {
      return nameSim >= NAME_STRONG_SIM ? 0.6 + 0.2 * nameSim : 0.35 * nameSim;
    }
    // Coordinates present but far apart → genuinely different place.
    return 0;
  }

  // No coordinates: fall back to name + city text.
  if (sameCity(candidate.city, existing.city)) {
    return nameSim >= NAME_STRONG_SIM ? 0.6 + 0.25 * nameSim : 0.55 * nameSim;
  }
  // Exact folded name but city unknown/different → weak (surface as low-confidence).
  return foldEqual ? 0.5 : 0;
}

function classify(score: number): DuplicateStrength {
  if (score >= 0.85) return 'strong';
  if (score >= DUPLICATE_THRESHOLD) return 'likely';
  return 'weak';
}

function reasonFor(candidate: DedupCandidateInput, existing: DedupEntity, score: number): string {
  const strong = score >= 0.85;
  if (existing.city && sameCity(candidate.city, existing.city)) {
    return strong ? `Same spot in ${existing.city}` : `Similar gem in ${existing.city}`;
  }
  if (existing.city) return existing.city;
  return strong ? 'Same spot' : 'Possible existing gem';
}

/** Turn a raw score into a surfaced match, or null when below the surfacing bar. */
export function toDuplicateMatch(
  candidate: DedupCandidateInput,
  existing: DedupEntity,
  score: number,
): DuplicateMatch | null {
  if (score < DUPLICATE_THRESHOLD) return null;
  return { entity: existing, score, strength: classify(score), reason: reasonFor(candidate, existing, score) };
}

// ── DB-backed finders (graceful on empty / error) ─────────────────────────────

interface GemRow {
  id: string;
  name: string | null;
  city: string | null;
  country: string | null;
  category: string | null;
  latitude: number | null;
  longitude: number | null;
  status: string | null;
}

/**
 * Fetch the candidate pool of existing gems to compare against: approved/active
 * gems whose free-text city OR name loosely matches the input. Bounded + safe:
 * values are wildcard/structural-escaped for the `.or()` expression (the same
 * hazard postgrestFilter guards elsewhere). Fail-soft to [] (pre-launch empty is
 * normal). Deliberately does NOT read exact protected coordinates — it selects
 * only the coarse fields the dedup math needs.
 */
async function fetchGemCandidates(
  sc: SupabaseClient,
  input: DedupCandidateInput,
  poolLimit: number,
): Promise<GemRow[]> {
  const preds: string[] = [];
  const nameVal = safeOrIlikeValue((input.name ?? '').trim());
  const cityVal = safeOrIlikeValue((input.city ?? '').trim());
  if (nameVal) preds.push(`name.ilike.%${nameVal}%`);
  if (cityVal) preds.push(`city.ilike.%${cityVal}%`);
  if (preds.length === 0) return [];

  try {
    const { data, error } = await sc
      .from('hidden_gems')
      .select('id, name, city, country, category, latitude, longitude, status')
      .or(preds.join(','))
      .in('status', ['approved', 'active'])
      .limit(poolLimit);
    if (error || !data) return [];
    return data as GemRow[];
  } catch {
    return [];
  }
}

function gemRowToEntity(r: GemRow): DedupEntity {
  return {
    id: r.id,
    name: r.name ?? '',
    city: r.city,
    country: r.country,
    category: r.category,
    lat: r.latitude ?? null,
    lng: r.longitude ?? null,
  };
}

/**
 * Find likely-existing gems that duplicate what the user is creating (§20/§55).
 * Returns the strongest matches first, capped at `max`. Never blocks creation —
 * the caller surfaces these as a disambiguation choice.
 *
 * `selfId` excludes the record being edited (so editing a gem never flags itself).
 */
export async function findDuplicateGems(
  sc: SupabaseClient,
  input: DedupCandidateInput,
  opts: { max?: number; poolLimit?: number; selfId?: string } = {},
): Promise<DuplicateMatch[]> {
  const max = opts.max ?? 3;
  if (!(input.name ?? '').trim() && !(input.city ?? '').trim()) return [];

  const rows = await fetchGemCandidates(sc, input, opts.poolLimit ?? 50);
  const matches: DuplicateMatch[] = [];
  for (const r of rows) {
    if (opts.selfId && r.id === opts.selfId) continue;
    const entity = gemRowToEntity(r);
    if (!entity.name) continue;
    const score = scoreGemDuplicate(input, entity);
    const m = toDuplicateMatch(input, entity, score);
    if (m) matches.push(m);
  }
  return dedupeById(matches).sort((a, b) => b.score - a.score).slice(0, Math.max(0, max));
}

interface PlaceRow {
  id: string;
  name: string | null;
  city: string | null;
  /** `places` stores an ISO code, not a country name — the column is `country_code`. */
  country_code: string | null;
  primary_category: string | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * Find likely-existing canonical Places for a place/event-location creation
 * (§20/§23 "Canonical Place first"). Reuses the SAME `isSamePlace` decision the
 * canonical `places` merge uses (geo proximity + category family + Jaccard), plus
 * a no-coordinate name+city fallback. The `places` table is largely unpopulated
 * pre-launch (external_places_enabled OFF) so this normally returns []; it must
 * still be correct when it does not.
 */
export async function findDuplicatePlaces(
  sc: SupabaseClient,
  input: DedupCandidateInput,
  opts: { max?: number; poolLimit?: number; selfId?: string } = {},
): Promise<DuplicateMatch[]> {
  const max = opts.max ?? 3;
  const nameVal = safeOrIlikeValue((input.name ?? '').trim());
  const cityVal = safeOrIlikeValue((input.city ?? '').trim());
  if (!nameVal && !cityVal) return [];

  let rows: PlaceRow[] = [];
  try {
    const preds: string[] = [];
    if (nameVal) preds.push(`name.ilike.%${nameVal}%`);
    if (cityVal) preds.push(`city.ilike.%${cityVal}%`);
    // `country_code`, not `country`: `places` has no `country` column, and
    // PostgREST fails the WHOLE query on an unknown select column (PGRST100).
    // With `error` short-circuiting to [] just below, that made this function
    // return an EMPTY candidate pool every time — so canonical-place duplicate
    // detection never matched anything and every submission looked unique.
    const { data, error } = await sc
      .from('places')
      .select('id, name, city, country_code, primary_category, latitude, longitude')
      .or(preds.join(','))
      .limit(opts.poolLimit ?? 50);
    if (error || !data) return [];
    rows = data as PlaceRow[];
  } catch {
    return [];
  }

  const candLike: PlaceLike = {
    name: input.name ?? '',
    latitude: input.lat ?? null,
    longitude: input.lng ?? null,
    primary_category: input.category ?? null,
  };

  const matches: DuplicateMatch[] = [];
  for (const r of rows) {
    if (opts.selfId && r.id === opts.selfId) continue;
    const entity: DedupEntity = {
      id: r.id,
      name: r.name ?? '',
      city: r.city,
      country: r.country_code,
      category: r.primary_category,
      lat: r.latitude ?? null,
      lng: r.longitude ?? null,
    };
    if (!entity.name) continue;

    let score = 0;
    let reason = entity.city ?? 'Existing place';
    const exLike: PlaceLike = {
      name: entity.name,
      latitude: entity.lat,
      longitude: entity.lng,
      primary_category: entity.category ?? null,
    };
    if (candLike.latitude != null && exLike.latitude != null && isSamePlace(candLike, exLike)) {
      score = 0.95;
      reason = entity.city ? `Same place in ${entity.city}` : 'Same place';
    } else {
      // No-coordinate fallback: exact folded name in the same city.
      const foldEqual = searchKey(candLike.name) && searchKey(candLike.name) === searchKey(entity.name);
      if (foldEqual && sameCity(input.city, entity.city)) {
        score = 0.8;
        reason = entity.city ? `Same name in ${entity.city}` : 'Same name';
      } else if (foldEqual) {
        score = 0.55;
      }
    }
    if (score >= DUPLICATE_THRESHOLD) {
      matches.push({ entity, score, strength: classify(score), reason });
    }
  }
  return dedupeById(matches).sort((a, b) => b.score - a.score).slice(0, Math.max(0, max));
}

interface EventRow {
  id: string;
  title: string | null;
  city: string | null;
  country: string | null;
  starts_at: string | null;
  visibility: string | null;
  state: string | null;
}

/** Within this many days a same-named same-city event is the SAME event, not a recurring series. */
export const EVENT_SAME_WINDOW_DAYS = 7;

/**
 * Find likely-existing PUBLIC events that duplicate the one being created
 * (§20 "Duplicate ... Event candidates"). Matches folded title + same city, and
 * — when both have a start time — treats occurrences within a week as the same
 * event (a far-apart same-name event is a recurring series, surfaced weakly).
 *
 * Only PUBLIC, non-cancelled/deleted/banned events are ever candidates, so this
 * never turns dedup into an oracle for private events (§29 fail-closed spirit).
 */
export async function findDuplicateEvents(
  sc: SupabaseClient,
  input: DedupCandidateInput & { startsAt?: string | null },
  opts: { max?: number; poolLimit?: number; selfId?: string } = {},
): Promise<DuplicateMatch[]> {
  const max = opts.max ?? 3;
  const titleVal = safeOrIlikeValue((input.name ?? '').trim());
  const cityVal = safeOrIlikeValue((input.city ?? '').trim());
  if (!titleVal) return [];

  let rows: EventRow[] = [];
  try {
    const preds: string[] = [`title.ilike.%${titleVal}%`];
    if (cityVal) preds.push(`city.ilike.%${cityVal}%`);
    const { data, error } = await sc
      .from('events')
      .select('id, title, city, country, starts_at, visibility, state')
      .or(preds.join(','))
      .eq('visibility', 'public')
      .not('state', 'in', '(cancelled,deleted,banned)')
      .limit(opts.poolLimit ?? 50);
    if (error || !data) return [];
    rows = data as EventRow[];
  } catch {
    return [];
  }

  const candStart = input.startsAt ? Date.parse(input.startsAt) : NaN;
  const matches: DuplicateMatch[] = [];
  for (const r of rows) {
    if (opts.selfId && r.id === opts.selfId) continue;
    const title = r.title ?? '';
    if (!title) continue;
    const foldEqual = searchKey(input.name) && searchKey(input.name) === searchKey(title);
    const nameSim = foldEqual ? 1 : nameSimilarity(input.name, title);
    if (nameSim < NAME_MIN_SIM) continue;
    const inSameCity = sameCity(input.city, r.city);
    if (!inSameCity && !foldEqual) continue;

    let score = inSameCity ? (nameSim >= NAME_STRONG_SIM ? 0.75 : 0.55 * nameSim) : 0.5;

    // Date proximity refinement when both sides carry a start time.
    const exStart = r.starts_at ? Date.parse(r.starts_at) : NaN;
    if (Number.isFinite(candStart) && Number.isFinite(exStart)) {
      const days = Math.abs(candStart - exStart) / 86_400_000;
      if (days <= EVENT_SAME_WINDOW_DAYS) score = Math.min(1, score + 0.2);
      else score = Math.max(0, score - 0.25); // likely a recurring series, weaker
    }

    if (score >= DUPLICATE_THRESHOLD) {
      matches.push({
        entity: {
          id: r.id,
          name: title,
          city: r.city,
          country: r.country,
          category: null,
          lat: null,
          lng: null,
        },
        score,
        strength: classify(score),
        reason: r.city ? `Event in ${r.city}` : 'Existing event',
      });
    }
  }
  return dedupeById(matches).sort((a, b) => b.score - a.score).slice(0, Math.max(0, max));
}

function dedupeById(matches: DuplicateMatch[]): DuplicateMatch[] {
  const seen = new Set<string>();
  const out: DuplicateMatch[] = [];
  for (const m of matches) {
    if (seen.has(m.entity.id)) continue;
    seen.add(m.entity.id);
    out.push(m);
  }
  return out;
}
