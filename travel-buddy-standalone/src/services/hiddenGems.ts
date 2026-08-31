/**
 * Hidden Gems — mobile service layer
 *
 * Typed fetch helpers for all Hidden Gems endpoints.
 * Pattern: same as tripCrewLocation.ts / passportStamps.ts.
 */
import { supabase } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';
import type {
  GemState,
  GemConfidence,
  GemContributionType,
} from '../lib/gems/gemStateDisplay.ts';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

// Re-export the Phase-8 Hidden Gem Intelligence types so callers can pull the
// gem-state contract from the service layer alongside the rest of the gem API.
export type { GemState, GemConfidence, GemContributionType };

// ── Types ─────────────────────────────────────────────────────────────────────

export type GemCategory =
  | 'food' | 'drink' | 'nature' | 'culture' | 'adventure'
  | 'nightlife' | 'wellness' | 'local_secret' | 'market'
  | 'viewpoint' | 'transport' | 'other';

export type GemSensitivity =
  | 'public' | 'approximate' | 'reveal_after_save'
  | 'reveal_after_acceptance' | 'protected';

export type GemVerificationLevel =
  | 'unverified' | 'community' | 'guide' | 'gps_verified' | 'admin';

export type GemStatus = 'pending' | 'active' | 'hidden' | 'merged';

export interface HiddenGem {
  id: string;
  name: string;
  category: GemCategory;
  city: string;
  country: string | null;
  neighborhood: string | null;
  description: string | null;
  /** May be null/approximate depending on sensitivity */
  lat: number | null;
  lng: number | null;
  coordsPrecision: 'exact' | 'approximate' | 'hidden';
  vibeTags: string[];
  priceRange: string | null;
  safetyNotes: string | null;
  bestTimeToGo: string | null;
  localEtiquette: string | null;
  layoverSafe: boolean;
  minimumLayoverMinutes: number | null;
  sensitivityLevel: GemSensitivity;
  verificationLevel: GemVerificationLevel;
  status: GemStatus;
  submittedBy: string | null;
  imageUrl: string | null;
  /** UUID of the linked canonical place (from the places table), if set. */
  canonicalPlaceId: string | null;
  saveCount: number;
  visitCount: number;
  createdAt: string;
  updatedAt: string;
  /**
   * §16 Hidden Gem Intelligence — the ten-state semantic status, derived at
   * read time by the Phase-8 backend. Optional: older payloads omit it, in
   * which case the client renders as it did before (degrade, never throws).
   */
  gemState: GemState | null;
  /**
   * §16 bounded evidence confidence ({ score 0..1, band }). A calm indicator,
   * NOT a popularity metric. Optional / degrade-safe like gemState.
   */
  gemConfidence: GemConfidence | null;
}

export interface GuideProfile {
  userId: string;
  guideLevel: number;
  cityExpertise: string[];
  contributionCount: number;
  helpfulVotes: number;
  accuracyScore: number;
  status: string;
  bio: string | null;
  verifiedAt: string | null;
}

export interface GemVisitResult {
  ok: boolean;
  visitId: string | null;
  distanceM: number | null;
  withinRange: boolean;
  trustLevel: string;
  isSuspicious: boolean;
  verificationUpgraded: boolean;
  error?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await freshToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  const json = await res.json();
  if (!res.ok) throw new Error((json as any).message ?? `HTTP ${res.status}`);
  return json as T;
}

// ── Map raw snake_case to camelCase ───────────────────────────────────────────

function mapGem(r: any): HiddenGem {
  return {
    id:                    r.id,
    name:                  r.name,
    category:              r.category,
    city:                  r.city,
    country:               r.country ?? null,
    neighborhood:          r.neighborhood ?? null,
    description:           r.description ?? null,
    lat:                   r.lat ?? null,
    lng:                   r.lng ?? null,
    coordsPrecision:       r.coordsPrecision ?? 'hidden',
    vibeTags:              r.vibe_tags ?? r.vibeTags ?? [],
    priceRange:            r.price_range ?? r.priceRange ?? null,
    safetyNotes:           r.safety_notes ?? r.safetyNotes ?? null,
    bestTimeToGo:          r.best_time_to_go ?? r.bestTimeToGo ?? null,
    localEtiquette:        r.local_etiquette ?? r.localEtiquette ?? null,
    layoverSafe:           r.layover_safe ?? r.layoverSafe ?? false,
    minimumLayoverMinutes: r.minimum_layover_minutes ?? r.minimumLayoverMinutes ?? null,
    sensitivityLevel:      r.sensitivity_level ?? r.sensitivityLevel ?? 'public',
    verificationLevel:     r.verification_level ?? r.verificationLevel ?? 'unverified',
    status:                r.status ?? 'active',
    submittedBy:           r.submitted_by ?? r.submittedBy ?? null,
    imageUrl:              r.image_url ?? r.imageUrl ?? null,
    canonicalPlaceId:      r.canonical_place_id ?? r.canonicalPlaceId ?? null,
    saveCount:             r.save_count ?? r.saveCount ?? 0,
    visitCount:            r.visit_count ?? r.visitCount ?? 0,
    createdAt:             r.created_at ?? r.createdAt ?? '',
    updatedAt:             r.updated_at ?? r.updatedAt ?? '',
    // §16 Phase-8 projections. The backend attaches these camelCase on gem
    // detail + discovery-list responses; absent on older / non-enriched paths.
    gemState:              r.gemState ?? r.gem_state ?? null,
    gemConfidence:         normalizeGemConfidence(r.gemConfidence ?? r.gem_confidence),
  };
}

/** Coerce a raw gemConfidence into { score, band } or null (degrade-safe). */
function normalizeGemConfidence(raw: any): GemConfidence | null {
  if (!raw || typeof raw !== 'object') return null;
  const score = typeof raw.score === 'number' ? raw.score : null;
  const band = typeof raw.band === 'string' ? raw.band : null;
  if (score == null && band == null) return null;
  return { score: score ?? 0, band: band ?? '' };
}

// ── API calls ─────────────────────────────────────────────────────────────────

export interface ListGemsOptions {
  city?: string;
  neighborhood?: string;
  category?: GemCategory;
  layoverSafe?: boolean;
  availableMinutes?: number;
  verificationLevel?: string;
  tripId?: string;
  submittedBy?: string;
  limit?: number;
}

/** List / filter gems. */
export async function listGems(opts: ListGemsOptions = {}): Promise<HiddenGem[]> {
  const params = new URLSearchParams();
  if (opts.city)              params.set('city', opts.city);
  if (opts.neighborhood)      params.set('neighborhood', opts.neighborhood);
  if (opts.category)          params.set('category', opts.category);
  if (opts.layoverSafe)       params.set('layoverSafe', '1');
  if (opts.availableMinutes)  params.set('availableMinutes', String(opts.availableMinutes));
  if (opts.verificationLevel) params.set('verificationLevel', opts.verificationLevel);
  if (opts.tripId)            params.set('tripId', opts.tripId);
  if (opts.submittedBy)       params.set('submittedBy', opts.submittedBy);
  if (opts.limit)             params.set('limit', String(opts.limit));

  const qs = params.toString();
  const data = await apiFetch<{ gems: any[] }>(`/api/hidden-gems${qs ? `?${qs}` : ''}`);
  return (data.gems ?? []).map(mapGem);
}

/** Get a single gem by ID. */
export async function getGem(
  gemId: string,
  tripId?: string,
): Promise<{ gem: HiddenGem; savedByMe: boolean; guideProfile: GuideProfile | null }> {
  const qs = tripId ? `?tripId=${tripId}` : '';
  const data = await apiFetch<{ gem: any; savedByMe: boolean; guideProfile: any | null }>(
    `/api/hidden-gems/${gemId}${qs}`,
  );
  return {
    gem: mapGem(data.gem),
    savedByMe: data.savedByMe ?? false,
    guideProfile: data.guideProfile ?? null,
  };
}

/** Submit a new gem. */
export async function submitGem(input: {
  name: string;
  category: GemCategory;
  city: string;
  country?: string;
  neighborhood?: string;
  description?: string;
  latitude?: number;
  longitude?: number;
  approxLatitude?: number;
  approxLongitude?: number;
  vibeTags?: string[];
  priceRange?: string;
  safetyNotes?: string;
  bestTimeToGo?: string;
  layoverSafe?: boolean;
  minimumLayoverMinutes?: number;
  sensitivityLevel?: GemSensitivity;
  /** Optional representative photo URL for the gem. */
  imageUrl?: string;
  // ── Dedicated "Add a Gem" creation flow fields ──────────────────────────────
  /** UUID of the verified canonical place (required for the dedicated gem flow). */
  canonicalPlaceId?: string;
  /**
   * Explicit attestation that the submitted media depicts the selected place.
   * Must be true when present; the server rejects false or omission alongside
   * canonicalPlaceId.
   */
  sourceConfirmation?: boolean;
  /** Visibility tier: 'public' | 'circle_only' | 'private'. */
  visibility?: string;
  /** Accessibility notes (wheelchair access, sensory-friendly, etc.). */
  accessibility?: string;
  /** Crowd level estimate: 'quiet' | 'moderate' | 'busy' | 'very_busy'. */
  crowdLevel?: string;
  /** UUID of the trip to attach this gem to at submission time (optional). */
  tripId?: string;
}): Promise<HiddenGem> {
  const data = await apiFetch<{ gem: any }>('/api/hidden-gems', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return mapGem(data.gem);
}

/** Get gems for a trip's destination city. */
export async function getTripcityGems(tripId: string): Promise<HiddenGem[]> {
  const data = await apiFetch<{ gems: any[] }>(`/api/hidden-gems/trip-city/${tripId}`);
  return (data.gems ?? []).map(mapGem);
}

/** Get layover-safe gems. */
export async function getLayoverGems(
  availableMinutes: number,
  city?: string,
): Promise<HiddenGem[]> {
  const params = new URLSearchParams({ availableMinutes: String(availableMinutes) });
  if (city) params.set('city', city);
  const data = await apiFetch<{ gems: any[] }>(`/api/hidden-gems/layover-safe?${params}`);
  return (data.gems ?? []).map(mapGem);
}

/** Get caller's saved gems. */
export async function getSavedGems(): Promise<HiddenGem[]> {
  const data = await apiFetch<{ gems: any[] }>('/api/hidden-gems/saved');
  return (data.gems ?? []).map(mapGem);
}

/** Save a gem. */
export async function saveGem(gemId: string): Promise<{ alreadySaved: boolean }> {
  return apiFetch(`/api/hidden-gems/${gemId}/save`, { method: 'POST' });
}

/** Unsave a gem. */
export async function unsaveGem(gemId: string): Promise<{ removed: boolean }> {
  return apiFetch(`/api/hidden-gems/${gemId}/save`, { method: 'DELETE' });
}

/** GPS check-in (verify-visit). */
export async function verifyGemVisit(
  gemId: string,
  latitude: number,
  longitude: number,
  tripId?: string,
): Promise<GemVisitResult> {
  return apiFetch(`/api/hidden-gems/${gemId}/verify-visit`, {
    method: 'POST',
    body: JSON.stringify({ latitude, longitude, tripId }),
  });
}

/** Report a gem. */
export async function reportGem(
  gemId: string,
  reason: string,
  notes?: string,
): Promise<{ ok: boolean; alreadyReported: boolean }> {
  return apiFetch(`/api/hidden-gems/${gemId}/report`, {
    method: 'POST',
    body: JSON.stringify({ reason, notes }),
  });
}

/**
 * §16.3 — record a structured contribution about a gem (an OBSERVATION).
 *
 * Posts one of the nine contribution types to POST /hidden-gems/:id/contribute.
 * The backend guarantees a single contribution never flips the gem's canonical
 * state — it takes CONTRIBUTION_FLIP_THRESHOLD independent observations. The
 * response echoes the freshly-derived (community-derived, not flipped) gemState
 * + gemConfidence so the caller can update the display in place.
 */
export async function contributeToGem(
  gemId: string,
  contributionType: GemContributionType,
  notes?: string,
): Promise<{
  ok: boolean;
  contributionId: string | null;
  alreadyObserved: boolean;
  gemState: GemState | null;
  gemConfidence: GemConfidence | null;
}> {
  const data = await apiFetch<{
    ok: boolean;
    contributionId: string | null;
    alreadyObserved: boolean;
    gemState: GemState | null;
    gemConfidence: any;
  }>(`/api/hidden-gems/${gemId}/contribute`, {
    method: 'POST',
    body: JSON.stringify({ contributionType, notes }),
  });
  return {
    ok: data.ok ?? false,
    contributionId: data.contributionId ?? null,
    alreadyObserved: data.alreadyObserved ?? false,
    gemState: (data.gemState ?? null) as GemState | null,
    gemConfidence: normalizeGemConfidence(data.gemConfidence),
  };
}

/** Share a gem to a Telegraph thread. */
export async function shareGemToTelegraph(
  gemId: string,
  threadId: string,
): Promise<{ ok: boolean; card: any }> {
  return apiFetch(`/api/hidden-gems/${gemId}/share-telegraph`, {
    method: 'POST',
    body: JSON.stringify({ threadId }),
  });
}

/** Add a gem to a trip plan. */
export async function addGemToPlan(
  gemId: string,
  tripId: string,
): Promise<{ ok: boolean; planItemId: string }> {
  return apiFetch(`/api/hidden-gems/${gemId}/plan`, {
    method: 'POST',
    body: JSON.stringify({ tripId }),
  });
}

/** Apply to become a local guide. */
export async function applyForGuide(
  bio?: string,
  cityExpertise?: string[],
): Promise<{ ok: boolean; guide: GuideProfile }> {
  return apiFetch('/api/hidden-gems/guides/apply', {
    method: 'POST',
    body: JSON.stringify({ bio, cityExpertise }),
  });
}

/** Get a guide's public profile. */
export async function getGuideProfile(userId: string): Promise<GuideProfile | null> {
  try {
    const data = await apiFetch<{ guide: any }>(`/api/hidden-gems/guides/${userId}`);
    const g = data.guide;
    if (!g) return null;
    // Normalise snake_case DB fields → camelCase GuideProfile interface
    return {
      userId:            g.user_id      ?? g.userId,
      guideLevel:        g.guide_level  ?? g.guideLevel  ?? 1,
      cityExpertise:     g.city_expertise ?? g.cityExpertise ?? [],
      contributionCount: g.contribution_count ?? g.contributionCount ?? 0,
      helpfulVotes:      g.helpful_votes ?? g.helpfulVotes ?? 0,
      accuracyScore:     g.accuracy_score ?? g.accuracyScore ?? 0,
      status:            g.status,
      bio:               g.bio ?? null,
      verifiedAt:        g.verified_at ?? g.verifiedAt ?? null,
    };
  } catch {
    return null;
  }
}

/** Update a gem (owner/guide edit). */
export async function updateGem(
  gemId: string,
  patch: {
    description?: string;
    safetyNotes?: string;
    bestTimeToGo?: string;
    localEtiquette?: string;
    vibeTags?: string[];
    priceRange?: string;
    sensitivityLevel?: GemSensitivity;
    layoverSafe?: boolean;
    minimumLayoverMinutes?: number;
  },
): Promise<HiddenGem> {
  const data = await apiFetch<{ gem: any }>(`/api/hidden-gems/${gemId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return mapGem(data.gem);
}

// ── Sensitivity display helpers ───────────────────────────────────────────────

export function sensitivityLabel(level: GemSensitivity): string {
  switch (level) {
    case 'public':               return 'Public';
    case 'approximate':          return 'Approximate location';
    case 'reveal_after_save':    return 'Save to reveal location';
    case 'reveal_after_acceptance': return 'Join trip to reveal';
    case 'protected':            return 'Protected';
  }
}

export function verificationBadge(level: GemVerificationLevel): string {
  switch (level) {
    case 'unverified':  return 'Unverified';
    case 'community':   return 'Community verified';
    case 'guide':       return 'Guide verified';
    case 'gps_verified': return 'GPS verified';
    case 'admin':       return 'Official';
  }
}
