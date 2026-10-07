/** Discovery service — fetches place data from /api/discovery. Destination-scoped, category-filtered. Anonymous
 *  when signed out; sent WITH the viewer's token when signed in, and device-cached per viewer (VIEWER SCOPE, foot of file). */
// The token helper is required LAZILY in freshToken below: a static apiToken → lib/supabase → react-native edge would stop
// this module loading (and type-checking) under Node, where the route→client leg drives it (census-discovery §60, DC-33).
import type { DiscoveryEventPost } from '../types/discovery.ts';
import { openDiscoveryLease, isCurrentDiscoveryScope, isLeaseViewerCurrent, onDiscoveryScopeChange, VIEWER_CHANGED_ERROR, type DiscoveryLease, type DiscoveryScope } from './discoveryViewerScope.ts';
import { stampCandidateReceipt } from '../features/discovery/candidateProjection.ts';
import { placeLiveAnchorOf, liveCoordParam, type PlaceLiveAnchor } from '../features/discovery/placeLiveAnchor.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function freshToken(): Promise<string | null> {
  try {
    return await (_tokenSourceForTests ?? (require('./apiToken.ts') as { freshToken: () => Promise<string | null> }).freshToken)();  // lib/sentry.ts's deferred require()
  } catch {
    return null;
  }
}

// ── Refusals ──────────────────────────────────────────────────────────────────
//
// OWNER RULING, 2026-09-14, verbatim:
//
//   "Add upstream_unavailable for upstream dependency failures. Do not cache
//    rate limits or outages as 'this location does not exist.' Verify that
//    clients recognize refusal responses, preserve existing bookmarks on read
//    failures, and exclude failed responses from exposure accounting. A
//    distinguishable response body alone is insufficient if consumers still
//    treat it as successful empty data."
//
// The server (api-server/src/lib/discoveryRefusal.ts) answers an internal
// failure with the SAME 200 envelope a genuinely empty city gets, plus a
// `refusal` key naming what broke. Until this type existed, every function
// below cast the body to a type with no `refusal` member and returned the same
// value for both — so the server told the truth and the client discarded it.
// That is the last sentence of the ruling, and it is the reason this block is
// here rather than a comment saying the server handles it.
//
// A REFUSAL IS NOT AN ERROR FROM THE TRANSPORT'S POINT OF VIEW. The request
// succeeded; the ANSWER is "we did not look". Callers therefore keep `ok: true`
// where they had it and must branch on `refusal` — which is what makes the
// distinction reach the screen instead of being swallowed by a catch.

/**
 * `11` §9's six classes plus `upstream_unavailable`, the seventh the owner
 * added on 2026-09-14 for dependencies this product calls but does not operate
 * (Nominatim, Overpass). Kept as a union of literals rather than `string` so a
 * typo in a `switch` is a compile error, and widened with `(string & {})` so an
 * unknown class the server adds later degrades to "some refusal" instead of
 * failing to parse.
 */
export type DiscoveryRefusalClass =
  | 'validation'
  | 'authorization'
  | 'constraint_mismatch'
  | 'transient_db'
  | 'feature_disabled'
  | 'unsupported_surface'
  | 'upstream_unavailable';

export interface DiscoveryRefusal {
  class: DiscoveryRefusalClass | (string & {});
  code: string;
  route: string;
  /**
   * "nothing" — the collection in this body is empty BECAUSE of the failure.
   *             Nothing was served; nothing here is exposure.
   * "partial" — part of the collection is a real result and WAS served. Those
   *             items are genuine exposure and must not be discarded.
   */
  coverage: 'nothing' | 'partial';
  /** Which of the route's sources failed, when it has more than one. */
  failedSources?: string[];
}

/**
 * Read `refusal` off any Discovery envelope.
 *
 * Deliberately tolerant: an envelope with no refusal returns `undefined` (the
 * overwhelmingly common case and the one that must stay free), and a malformed
 * refusal is treated as no refusal rather than crashing a screen — a parser
 * that throws on the failure path turns a degraded surface into a blank one.
 */
export function parseRefusal(body: unknown): DiscoveryRefusal | undefined {
  const r = (body as { refusal?: unknown } | null | undefined)?.refusal;
  if (!r || typeof r !== 'object') return undefined;
  const o = r as Record<string, unknown>;
  if (typeof o.class !== 'string' || typeof o.code !== 'string') return undefined;
  return {
    class:    o.class,
    code:     o.code,
    route:    typeof o.route === 'string' ? o.route : '',
    coverage: o.coverage === 'partial' ? 'partial' : 'nothing',
    ...(Array.isArray(o.failedSources)
      ? { failedSources: o.failedSources.filter((x): x is string => typeof x === 'string') }
      : {}),
  };
}

/** True when the body carries NOTHING because it failed — not an empty result. */
export function refusedEverything(refusal?: DiscoveryRefusal): boolean {
  return refusal !== undefined && refusal.coverage === 'nothing';
}

/**
 * An envelope whose `refusal` is the PARSED one, or absent.
 *
 * The wire key is destructured away first, deliberately. Spreading the raw body
 * and then adding the parsed refusal on top looks equivalent and is not: when
 * the wire carries a malformed `refusal` (a string, a null, an object missing
 * `class`), `parseRefusal` correctly declines it and the raw value survives the
 * spread — so a consumer branching on `data.refusal` would treat garbage as a
 * refusal and hide real results behind a failure notice. Parsing has to REPLACE
 * the field, not sit beside it.
 */
function withParsedRefusal<T extends object>(body: unknown): T & { refusal?: DiscoveryRefusal } {
  const { refusal: _wire, ...rest } = (body ?? {}) as Record<string, unknown>;
  const refusal = parseRefusal(body);
  return { ...(rest as T), ...(refusal ? { refusal } : {}) };
}

export type DiscoveryCategory =
  | 'for_you'
  | 'places'
  | 'food'
  | 'nightlife'
  | 'activities'
  | 'events'
  | 'beaches'
  | 'transport';

export interface DiscoveryPlace {
  id: string;
  /** Bare public.places uuid for canonical rows — opens /place/<uuid> (living page + Quick Signal). */
  canonicalPlaceId?: string | null;
  name: string;
  category: string;
  type: string | null;
  description: string | null;
  distanceKm: number | null;
  lat: number | null;
  lng: number | null;
  tags: string[];
  address: string | null;
  /** Neighborhood label (when available from the provider). */
  neighborhood?: string | null;
  website: string | null;
  phone: string | null;
  openingHours: string | null;
  rating: number | null;
  isOpenNow: boolean | null;
  /** Community "Worth It" vote count — populated by the discovery listing API. */
  worthItCount?: number | null;
  /** Average community review rating — populated by the discovery listing API. */
  avgRating?: number | null;
  /** Number of community reviews — populated by the discovery listing API. */
  reviewCount?: number | null;
  /**
   * Primary cover image URL. Null / absent means no image is available;
   * UI falls back to category artwork via PlaceCategoryFallback.
   */
  headerImageUrl?: string | null;
  /**
   * How the header image was sourced. Drives the resolver priority ladder and
   * the "AI-generated representation" disclosure label in the UI.
   *   'ai_generated'  — image was produced by the AI visuals pipeline
   *   'provider'      — FSQ / OSM / other third-party photo
   *   'user_upload'   — uploaded directly by the place owner or a traveler
   *   'official'      — official venue photography
   *   'portava_media' — Portava curated media library
   */
  headerImageSource?: 'ai_generated' | 'provider' | 'user_upload' | 'official' | 'portava_media' | null;
  /** Data-source attribution text for the venue detail view. When present,
   *  replaces the default OSM attribution footer. */
  attribution?: string | null;
  /** Nine-category image source classification from the accuracy pipeline
   *  (mirrors ImageSourceType from api-server/src/lib/visuals/types.ts). */
  imageSourceType?: string | null;
  /** Image accuracy assessment from the verification pipeline. */
  accuracyStatus?: string | null;
  /** When true the UI must render a disclaimer alongside the image. */
  disclaimerRequired?: boolean | null;
  /** Disclaimer copy to show when disclaimerRequired is true. */
  disclaimerText?: string | null;
  /**
   * Wikidata entity id (`Q…`) when OSM carries one. Used to surface a
   * structured-data "More info" link in the detail sheet.
   */
  wikidataId?: string | null;
  /**
   * Server-built DiscoveryCandidate projection (Sensing §8): truth class,
   * confidence, freshness, the grounded why-now and `01` §11's reason labels.
   * Typed `unknown` on purpose: it is ADDITIVE and flag-gated (migration 2361,
   * seeded FALSE), and `getDiscoveryPlaces` casts rather than validates the body.
   * `features/discovery/candidateProjection.ts` parses it defensively and is the
   * only thing that should read it (`getDiscoveryPlaces` stamps `receivedAtMs`).
   */
  candidate?: unknown;
  /** DV-46: THIS viewer's exposure id (signed-in serves only). Echoed as `recommendation_id` on
   *  POST /rank-events/outcome, and never shown or cached across viewers (VIEWER SCOPE). */
  recommendationId?: string;
  /**
   * Raw OSM `image` tag value, kept only when it is an absolute http(s) URL.
   * Used as the lowest-priority header image candidate — only shown when no
   * headerImageUrl or FSQ photo is available. May be a Wikimedia page URL
   * rather than a direct image, so it is placed after all other candidates.
   */
  osmImageUrl?: string | null;
  /**
   * True when this card represents a hosted Compass event (an activity/idea
   * with a real start time and RSVP flow), not a resolved venue. Detail UI
   * must never show venue-only affordances (Directions/phone/hours/website)
   * for these unless real coordinates are present, and should frame it as
   * an event rather than a place.
   */
  isCompassEvent?: boolean;
}

export interface DiscoveryFilters {
  radiusKm: number;
  openNow: boolean;
  minRating: number | null;
  sortBy?: string | null;
  /**
   * The intent mode the user chose on the Discovery screen, sent as
   * `?intentMode=` on GET /discovery. Absent / null ⇒ NOT sent, so a request
   * with no selection is byte-identical to one sent before the selector existed.
   * See INTENT MODES below.
   */
  intentMode?: DiscoveryIntentMode | null;
}

// ── INTENT MODES (census-discovery §71, rows A05 / DV-42) ─────────────────────
//
// Sensing §8 (docs/specs/Portava_Sensing_World_Experience_Intelligence_Upgrade_Architecture_v1.txt:137):
// "Support intent modes using the same shared intelligence: Right Now, Tonight,
// Explore, Quiet, Social, High Energy, Nearby, Trip." The server declares the
// same eight ONCE (artifacts/api-server/src/lib/intentModes.ts INTENT_MODES) and
// parses `?intentMode=` on GET /discovery with `parseIntentMode`; the live rank
// that reads it is gated by `discovery_live_rank_enabled` (migration 2850,
// seeded FALSE). The client cannot import a server module, so the list is
// restated here, and artifacts/api-server/src/test/discoveryIntentModeSender.test.ts
// fails if the two ever differ in members, order or labels.
//
// The selection is per-session UI state held by the screen, never persisted:
// `04` §9 names "session intent" as a representation distinct from long-term
// preference, and no spec states a default or a persistence rule.

/** The eight, in the spec's own order. The server's `INTENT_MODES`, byte for byte. */
export const DISCOVERY_INTENT_MODES = [
  'right_now', 'tonight', 'explore', 'quiet', 'social', 'high_energy', 'nearby', 'trip',
] as const;
export type DiscoveryIntentMode = (typeof DISCOVERY_INTENT_MODES)[number];

/** The spec's mode names, verbatim (the server's `INTENT_MODE_LABELS`). Owner-overrulable copy. */
export const DISCOVERY_INTENT_MODE_LABELS: Readonly<Record<DiscoveryIntentMode, string>> = Object.freeze({
  right_now: 'Right Now',
  tonight: 'Tonight',
  explore: 'Explore',
  quiet: 'Quiet',
  social: 'Social',
  high_energy: 'High Energy',
  nearby: 'Nearby',
  trip: 'Trip',
});

/** The server capability the selector waits for. Unknown / unreadable ⇒ off (FeatureFlagsContext is fail-soft). */
export const DISCOVERY_LIVE_RANK_FLAG = 'discovery_live_rank_enabled';

/** One of the eight. Anything else — another surface's intent kind, a near-miss spelling — is never sent. */
export function isDiscoveryIntentMode(v: unknown): v is DiscoveryIntentMode {
  return typeof v === 'string' && (DISCOVERY_INTENT_MODES as readonly string[]).includes(v);
}

export interface DiscoveryResult {
  places: DiscoveryPlace[];
  total: number;
  destination: string;
  cached: boolean;
  /**
   * Present when the server refused. `places: []` beside a `coverage: "nothing"`
   * refusal is NOT a result — see the Refusals block at the top of this file.
   */
  refusal?: DiscoveryRefusal; /** census-discovery §79/§91 (A07): `liveSafety` is present only when a Live read this page owed FAILED, so its "open around now" claims were withheld. */ meta?: { liveSafety?: { readable: false; claimsWithheld: number } };
}

// ── Live venue status (Phase 8 live intelligence) ─────────────────────────────
//
// Confidence-labeled live open-now status from /api/places/live-status.
// available=false means the live source couldn't verify — callers must
// degrade honestly (no pill / "last known hours"), never invent a status.
// The place's own coordinates go with the name: they are how the server
// confirms a provider record IS this place (lead ruling D-67).

export interface PlaceLiveConfidence {
  sourceClass: 'verified_live' | 'community_reported' | 'historical' | 'ai_inference';
  label: string;
  checkedAt: string;
  dataNote?: string;
}

export interface PlaceLiveStatus {
  available: boolean;
  openNow: boolean | null;
  source?: string;
  checkedAt?: string;
  dataNote?: string;
  confidence: PlaceLiveConfidence;
}

/**
 * `anchor` is the place's OWN stored coordinates (lead ruling D-67). The
 * server labels a provider record "verified live" only when its name matches
 * AND it lies within 150 m of them; sent without them, it answers
 * `available: false` (can't verify) and asks no provider.
 */
export async function getPlaceLiveStatus(
  name: string,
  anchor: PlaceLiveAnchor | null,
): Promise<PlaceLiveStatus | null> {
  const base = apiBase();
  const token = base && name.trim() ? await freshToken() : null; // lead follow-up F5: the route requires a signed-in user — signed out, there is no pill
  if (!base || !name.trim() || !token) return null;
  const at = placeLiveAnchorOf(anchor); const params = new URLSearchParams({ name: name.trim() });
  if (at) {
    params.set('lat', liveCoordParam(at.lat));
    params.set('lng', liveCoordParam(at.lng));
  }
  try {
    const res = await fetch(`${base}/api/places/live-status?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as { liveStatus?: PlaceLiveStatus } | null;  // typed: under Node's lib `json()` is `unknown`
    return (body?.liveStatus as PlaceLiveStatus | undefined) ?? null;
  } catch {
    return null;
  }
}

// ── Cached live-status for list cards ─────────────────────────────────────────
//
// Explore/Discover cards fetch live status lazily as they mount. To avoid a
// request storm while scrolling:
//  - results (including "unavailable") are cached in-memory for 10 minutes,
//    mirroring the server-side cache TTL;
//  - failed lookups (network error → null) are cached for 60 s so a flaky
//    connection doesn't retry on every re-mount;
//  - identical concurrent lookups share one in-flight promise;
//  - at most 3 lookups run concurrently — the rest queue.

const LIVE_STATUS_TTL_MS = 10 * 60 * 1_000;
const LIVE_STATUS_FAIL_TTL_MS = 60 * 1_000;
const LIVE_STATUS_MAX_CONCURRENT = 3;

const _liveStatusCache = new Map<string, { value: PlaceLiveStatus | null; at: number }>();
const _liveStatusInFlight = new Map<string, Promise<PlaceLiveStatus | null>>();
let _liveStatusActive = 0;
const _liveStatusQueue: (() => void)[] = [];

/** Same name at two different places is two entries (D-67): the key carries the anchor. */
function _liveStatusKey(name: string, anchor: PlaceLiveAnchor | null): string {
  const at = placeLiveAnchorOf(anchor);
  return `${name.trim().toLowerCase()}|${at ? `${at.lat},${at.lng}` : '-'}`;
}

function _acquireLiveStatusSlot(): Promise<void> {
  if (_liveStatusActive < LIVE_STATUS_MAX_CONCURRENT) {
    _liveStatusActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    _liveStatusQueue.push(() => { _liveStatusActive++; resolve(); });
  });
}

function _releaseLiveStatusSlot(): void {
  _liveStatusActive--;
  const next = _liveStatusQueue.shift();
  if (next) next();
}

/**
 * Deduped, cached, concurrency-limited variant of getPlaceLiveStatus for
 * list surfaces (Explore cards). Never invents a status — a null return or
 * `available: false` means the caller should render nothing.
 */
export async function getPlaceLiveStatusCached(
  name: string,
  anchor: PlaceLiveAnchor | null,
): Promise<PlaceLiveStatus | null> {
  if (!name.trim()) return null;
  const key = _liveStatusKey(name, anchor);

  const cached = _liveStatusCache.get(key);
  if (cached) {
    const ttl = cached.value ? LIVE_STATUS_TTL_MS : LIVE_STATUS_FAIL_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.value;
    _liveStatusCache.delete(key);
  }

  const inFlight = _liveStatusInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    await _acquireLiveStatusSlot();
    try {
      const value = await getPlaceLiveStatus(name, anchor);
      _liveStatusCache.set(key, { value, at: Date.now() });
      return value;
    } finally {
      _releaseLiveStatusSlot();
      _liveStatusInFlight.delete(key);
    }
  })();
  _liveStatusInFlight.set(key, promise);
  return promise;
}

// ── Community discovery ────────────────────────────────────────────────────────

export interface CommunityPlaceItem {
  id: string;
  city: string;
  name: string;
  placeType: 'hidden_gem' | 'traveler_pick';
  category: string;
  neighborhood: string | null;
  blurb: string | null;
  imageUrl: string | null;
  /**
   * The submitter's byline, as `routes/discovery.ts` emits it from ONE
   * `nameAllowed` decision (self-exemption first, then the opt-in).
   *
   *   displayName  CANONICAL (C19). The real name iff the server authorised
   *                it, else null. Never a handle. Optional on this type only
   *                because a pre-rollout server may omit it; absent is read as
   *                "withheld" by `features/discovery/communityByline.ts`.
   *   name         LEGACY, kept additively. Carries the literal `"@username"`
   *                when the name is withheld — which is exactly why no client
   *                surface may render it as an identity. §6 D2 retires it.
   */
  submittedBy: {
    id: string;
    name: string;
    displayName?: string | null;
    avatarUrl: string | null;
    handle: string | null;
  } | null;
  savedCount: number;
  tag: string | null;
  note: string | null;
  rating: number | null;
  source: string;
  status: string;
  verified: boolean;
  createdAt: string;
  lat: number | null;
  lng: number | null;
  /** Community "Worth It" vote count — populated by the listing API. */
  worthItCount?: number | null;
  /** Average community review rating — populated by the listing API. */
  avgRating?: number | null;
  /** Number of community reviews — populated by the listing API. */
  reviewCount?: number | null;
}

export interface CommunityDiscoveryResult {
  items: CommunityPlaceItem[];
  city: string;
  total: number;
  /** Present when the server refused; `items: []` beside it is not "no gems here". */
  refusal?: DiscoveryRefusal;
}

export async function getCommunityPlaces(
  city: string,
  type: 'hidden_gem' | 'traveler_pick' | 'all' = 'all',
  limit = 20,
  sortBy?: string | null,
): Promise<{ ok: true; data: CommunityDiscoveryResult; scope?: DiscoveryScope } | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };

  const params = new URLSearchParams({ city, type, limit: String(limit) });
  if (sortBy) params.set('sortBy', sortBy);
  const lease = openDiscoveryLease(await freshToken());  // bylines, blocks and mutes are per viewer — VIEWER SCOPE, foot of file
  try {
    const res = await fetch(`${base}/api/discovery/community?${params}`, lease.init);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return communityForLease(lease, withParsedRefusal<CommunityDiscoveryResult>(await res.json()));
  } catch {
    return { ok: false, error: 'Network error — check your connection' };
  }
}

export interface SubmitPlacePayload {
  city: string;
  name: string;
  place_type: 'hidden_gem' | 'traveler_pick';
  category?: string;
  neighborhood?: string;
  blurb?: string;
  tag?: string;
  note?: string;
  rating?: number | null;
  /** Optional coordinates — when present, the place appears as a pin on the For You map. */
  lat?: number | null;
  lng?: number | null;
  /** Optional photos attached to the place submission (up to 3 CDN URLs). */
  photos?: string[];
}

export interface SubmitPlaceResult {
  ok: true;
  place: { id: string; name: string; city: string; place_type: string; status: string; created_at: string };
  /** True when the server successfully geocoded the place name and stored coordinates. */
  geocoded?: boolean;
}

export async function submitCommunityPlace(
  payload: SubmitPlacePayload,
): Promise<SubmitPlaceResult | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };

  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not signed in' };

  try {
    const res = await fetch(`${base}/api/discovery/community`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as unknown;
    const obj = data as Record<string, unknown>;
    if (!res.ok || !obj.ok) {
      return { ok: false, error: (obj.message as string) ?? `HTTP ${res.status}` };
    }
    return obj as unknown as SubmitPlaceResult;
  } catch {
    return { ok: false, error: 'Network error — check your connection' };
  }
}

export async function saveCommunityPlace(
  placeId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };

  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not signed in' };

  try {
    const res = await fetch(`${base}/api/discovery/community/${placeId}/save`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error — check your connection' };
  }
}

/**
 * The current user's saved community-place ids, or a REFUSAL.
 *
 * WHY THIS RETURNS A RESULT AND NOT `string[]`
 * ===========================================
 * Owner ruling, 2026-09-14: "preserve existing bookmarks on read failures".
 *
 * This function used to answer `[]` for all four of:
 *   • you have saved nothing
 *   • the save table could not be read (the server says so, in `refusal`)
 *   • the request failed in transport
 *   • you are signed out
 * The caller pre-populates the filled-bookmark state from the return value, so
 * every one of those became the same thing on screen: EVERY BOOKMARK YOU OWN,
 * GONE. Not an error banner, not a spinner — a silent, confident claim that you
 * had never saved anything, made at the exact moment the server had just said
 * it did not know.
 *
 * `[]` was described in the old comment as "fail-open so a network hiccup
 * doesn't break the Discovery screen", and that reasoning is the trap: the
 * screen did not break, which is precisely why nobody noticed it was lying.
 * Fail-open is right for a FILTER (show more than you should); it is wrong for
 * an INVENTORY, where the open direction is "you own nothing".
 *
 * The caller's obligation is now in the type: it cannot reach the ids without
 * first passing through `ok`, so "treat the refusal as successful empty data"
 * is no longer expressible.
 */
export type SavedPlaceIdsResult =
  | { ok: true;  ids: string[] }
  | { ok: false; reason: 'refused' | 'unavailable' | 'signed_out'; refusal?: DiscoveryRefusal };

export async function getSavedPlaceIds(): Promise<SavedPlaceIdsResult> {
  const base = apiBase();
  if (!base) return { ok: false, reason: 'unavailable' };

  const token = await freshToken();
  // Signed out is NOT a failure and NOT an empty save set: there is no user
  // whose bookmarks these would be. Named separately so the caller can stay
  // silent rather than report a problem that does not exist.
  if (!token) return { ok: false, reason: 'signed_out' };

  try {
    const res = await fetch(`${base}/api/discovery/community/saved-ids`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    const body = (await res.json()) as { ids?: string[] };
    const refusal = parseRefusal(body);
    // `coverage: "nothing"` means the server did not read the save set. The
    // `ids: []` beside it is padding for old clients, not an answer.
    if (refusedEverything(refusal)) return { ok: false, reason: 'refused', refusal };
    return { ok: true, ids: Array.isArray(body.ids) ? body.ids : [] };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

export type PlaceReportReason = 'spam' | 'offensive' | 'inaccurate' | 'unsafe' | 'duplicate' | 'other';

export async function reportCommunityPlace(
  placeId: string,
  reason: PlaceReportReason,
  notes?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };

  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not signed in' };

  try {
    const res = await fetch(`${base}/api/discovery/community/${placeId}/report`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, notes }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error — check your connection' };
  }
}

// ── OSM places (existing) ─────────────────────────────────────────────────────

export type DiscoveryContextMode =
  | 'near_me'
  | 'in_city'
  | 'going_soon'
  | 'around_crew'
  | 'safe_nearby';

export type DiscoveryAgeFilter =
  | 'any'
  | 'open_to_me'
  | '18_plus'
  | '21_plus'
  | 'under_30'
  | '30_plus'
  | 'custom';

// ── Client-side stale-while-revalidate cache for discovery results ─────────────
// Keyed by destination:category:radiusKm:page (plus :intent=<mode> only when one is chosen); each entry carries the VIEWER + epoch it was written in
// and is readable only in that scope (VIEWER SCOPE, foot of file). Serves previously-fetched data instantly
// when the user returns to the Explore tab, then lets the caller decide whether to refresh in the background.
const _CLIENT_CACHE = new Map<string, { data: DiscoveryResult; at: number; scope: DiscoveryScope }>();
const CLIENT_CACHE_TTL = 4 * 60 * 1_000; // 4 minutes

function _discoveryCacheKey(dest: string, cat: string, radiusKm: number, page: number, intentMode?: DiscoveryIntentMode | null): string {
  const key = `${dest.toLowerCase().trim()}:${cat}:${radiusKm}:${page}`;
  // A mode's page is a different order of the same query, so it gets its own
  // entry; the no-mode key stays exactly what it was before modes existed.
  return isDiscoveryIntentMode(intentMode) ? `${key}:intent=${intentMode}` : key;
}

/** Test seam: drop every client-cached result. Carries no production caller. */
export function _resetDiscoveryClientCache(): void {
  _CLIENT_CACHE.clear();
}

/**
 * Synchronous cache read — returns the last-known result for this query (even
 * if stale) or `null` when there is no cached entry.  Use this to paint content
 * immediately before firing a fresh network request.
 */
export function getCachedDiscoveryPlaces(
  destination: string,
  category: DiscoveryCategory,
  radiusKm: number,
  page = 1,
  intentMode?: DiscoveryIntentMode | null,
): DiscoveryResult | null {
  return _liveCacheEntry(_discoveryCacheKey(destination, category, radiusKm, page, intentMode))?.data ?? null;
}

/**
 * Returns true when a cached entry exists AND is still within the TTL window.
 */
export function isDiscoveryCacheFresh(
  destination: string,
  category: DiscoveryCategory,
  radiusKm: number,
  page = 1,
  intentMode?: DiscoveryIntentMode | null,
): boolean {
  const e = _liveCacheEntry(_discoveryCacheKey(destination, category, radiusKm, page, intentMode));
  return !!e && Date.now() - e.at < CLIENT_CACHE_TTL;
}

export async function getDiscoveryPlaces(
  destination: string,
  category: DiscoveryCategory,
  filters: DiscoveryFilters,
  page = 1,
  contextMode?: DiscoveryContextMode | null,
  ageFilter?: DiscoveryAgeFilter | null,
  customMinAge?: number | null,
  customMaxAge?: number | null,
  lat?: number | null,
  lng?: number | null,
  /** User's actual GPS position — used by the backend only to recompute distances
   *  for nearest sort. Never used as the Overpass query centre or for geocoding. */
  userLat?: number | null,
  userLng?: number | null,
  /**
   * When true and page === 1, fires a fire-and-forget Compass search signal so
   * category_weights reflect the user's explicit browsing intent.
   *
   * Must be false (default) for background/count callers such as
   * getDiscoveryCategoryCounts — those enumerate all categories and would
   * corrupt personalization weights with non-intent traffic.
   */
  emitSignal = false,
): Promise<{ ok: true; data: DiscoveryResult } | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };

  const params = new URLSearchParams({
    destination,
    category,
    radiusKm: String(filters.radiusKm),
    page: String(page),
    ...(filters.openNow ? { openNow: '1' } : {}),
    ...(filters.minRating != null ? { minRating: String(filters.minRating) } : {}),
    ...(filters.sortBy ? { sortBy: filters.sortBy } : {}),
    ...(contextMode ? { context: contextMode } : {}),
    ...(ageFilter && ageFilter !== 'any' ? { ageFilter } : {}),
    ...(ageFilter === 'custom' && customMinAge != null ? { customMinAge: String(customMinAge) } : {}),
    ...(ageFilter === 'custom' && customMaxAge != null ? { customMaxAge: String(customMaxAge) } : {}),
    ...(lat != null ? { lat: String(lat) } : {}),
    ...(lng != null ? { lng: String(lng) } : {}),
    ...(userLat != null ? { userLat: String(userLat) } : {}),
    ...(userLng != null ? { userLng: String(userLng) } : {}),
    // Last, and only when chosen: with no selection the URL is the one sent before modes existed.
    ...(isDiscoveryIntentMode(filters.intentMode) ? { intentMode: filters.intentMode } : {}),
  });
  const lease = openDiscoveryLease(await freshToken());  // the viewer this page is fetched AS — VIEWER SCOPE, foot of file
  try {
    const res = await fetch(`${base}/api/discovery?${params}`, lease.init);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as unknown;
    const data = stampCandidateReceipt(withParsedRefusal<DiscoveryResult>(body), Date.now());  // DSV2-04: why-now expiry runs on THIS device's clock
    const refusal = data.refusal;
    // A page fetched AS one viewer is never handed to another: the account switched mid-flight.
    if (!isLeaseViewerCurrent(lease)) return { ok: false, error: VIEWER_CHANGED_ERROR };
    // Populate client cache so the next mount of the same tab is instant — UNLESS the server
    // refused (this 4-minute SWR store paints straight onto the screen, so a refused body would
    // replay the outage from the DEVICE after it ended, with no network call left to notice the
    // recovery; a `coverage: "partial"` body IS cached, its items are real) or the scope moved
    // while this was in flight (a block or dismissal the page may predate).
    if (!refusedEverything(refusal) && isCurrentDiscoveryScope(lease.scope)) {
      _CLIENT_CACHE.set(_discoveryCacheKey(destination, category, filters.radiusKm, page, filters.intentMode), { data, at: Date.now(), scope: lease.scope });
    }
    // Signal search intent to Compass so category_weights reflect browsing.
    // Only fires when the caller opts in (emitSignal=true) AND this is page 1
    // (explicit category selection, not pagination). Background callers such as
    // getDiscoveryCategoryCounts must NOT pass emitSignal=true — they enumerate
    // all categories and would corrupt personalization weights with non-intent traffic.
    // 'for_you' is a personalised feed, not a category intent — never signal.
    if (emitSignal && page === 1 && category !== 'for_you') {
      postSearchSignal(destination, { city: destination, category });
    }
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Network error — check your connection' };
  }
}

/**
 * Fetch total result counts for every countable Discovery category in parallel.
 * Uses broad defaults (radius 25 km, no open-now, no min-rating) so the counts
 * reflect the full set of available places for the destination.
 * Skips `for_you` — the personalised feed has no stable total count.
 * Individual failures are silently dropped; only successful responses contribute
 * to the returned map.
 */
const COUNTABLE_CATEGORIES: DiscoveryCategory[] = [
  'places', 'food', 'nightlife', 'activities', 'events', 'beaches', 'transport',
];
/** Matches the default filters in DiscoveryCategoryTab so initial counts align with tab content. */
const DEFAULT_COUNT_FILTERS: DiscoveryFilters = { radiusKm: 10, openNow: false, minRating: null };

export async function getDiscoveryCategoryCounts(
  destination: string,
  filters: DiscoveryFilters = DEFAULT_COUNT_FILTERS,
  contextMode?: DiscoveryContextMode | null,
  ageFilter?: DiscoveryAgeFilter | null,
  customMinAge?: number | null,
  customMaxAge?: number | null,
): Promise<Partial<Record<DiscoveryCategory, number>>> {
  const results = await Promise.allSettled(
    COUNTABLE_CATEGORIES.map((cat) =>
      getDiscoveryPlaces(destination, cat, filters, 1, contextMode, ageFilter, customMinAge, customMaxAge),
    ),
  );
  const counts: Partial<Record<DiscoveryCategory, number>> = {};
  results.forEach((result, i) => {
    if (result.status !== 'fulfilled' || !result.value.ok) return;
    // `ok: true` IS NOT "the server counted". A refusal arrives as `ok: true`
    // with a `refusal` on the body and `total: 0`, so testing `ok` alone let a
    // category the server never read contribute a real-looking ZERO — and the
    // badge row then said "0" about a category nobody counted. That is not the
    // "silently dropped failure" this function's own docstring promises; it is a
    // fabricated number, the exact thing getDiscoveryCountsResult's type comment
    // warns about for the batch sibling.
    //
    // An ABSENT key is the only honest value this return type can carry for
    // "not counted". `coverage: "partial"` is NOT this case — the total it
    // carries is a real count over real rows, so it is reported.
    if (refusedEverything(result.value.data.refusal)) return;
    counts[COUNTABLE_CATEGORIES[i]] = result.value.data.total;
  });
  return counts;
}

/**
 * Batch counts endpoint — fetches all 7 category counts in ONE HTTP request.
 *
 * The server geocodes the destination once (with its own dedup cache) and fans
 * out to all categories server-side, returning `{ counts: Record<cat, N> }`.
 * Use this as the default; fall back to `getDiscoveryCategoryCounts` only when
 * age-filter or other per-request personalisation is needed.
 */
export interface DiscoveryCountsResult {
  counts: Partial<Record<DiscoveryCategory, number>>;
  /**
   * Present when the server refused. With `coverage: "nothing"` the empty
   * `counts` is not "this city has none of anything" — it is "we could not
   * count", and a badge row rendered from it as zeros is a fabricated number.
   * With `coverage: "partial"` the keys that ARE present are real and
   * `failedSources` names the ones that are absent because they failed.
   */
  refusal?: DiscoveryRefusal;
}

export async function getDiscoveryCategoryCountsBatch(
  destination: string,
  radiusKm = 10,
  lat?: number | null,
  lng?: number | null,
): Promise<DiscoveryCountsResult> {
  const base = apiBase();
  if (!base) return { counts: {} };
  const params = new URLSearchParams({ destination, radiusKm: String(radiusKm) });
  if (lat != null) params.set('lat', String(lat));
  if (lng != null) params.set('lng', String(lng));
  try {
    const res = await fetch(`${base}/api/discovery/counts?${params}`, openDiscoveryLease(await freshToken()).init);  // per viewer, like the page
    if (!res.ok) return { counts: {} };
    const body = (await res.json()) as { counts?: Record<string, number> };
    const refusal = parseRefusal(body);
    return {
      counts: (body.counts ?? {}) as Partial<Record<DiscoveryCategory, number>>,
      ...(refusal ? { refusal } : {}),
    };
  } catch {
    return { counts: {} };
  }
}

// ── Unified discovery feed (serve point 7) ─────────────────────────────────────
//
// GET /api/discovery/feed — the server-side "unified feed" that merges OSM +
// discovery_places rows with the viewer's "Live from events" posts and returns
// one envelope. Unlike getDiscoveryPlaces (GET /discovery) this call is SENT
// WITH the auth token: the endpoint only resolves a viewer, fetches event posts,
// and writes its serve-point-7 rank_events impressions when a Bearer token is
// present (discovery.ts). It returns `sessionId` — the served rank context a
// caller threads back on POST /rank-events/outcome so a 'discovery' outcome
// upgrades the exact impression this load wrote.

export interface DiscoveryFeedResult {
  places: DiscoveryPlace[];
  posts: DiscoveryEventPost[];
  nextCursor: string | null;
  total: number;
  destination: string | null;
  sourceSummary: { seededDbCount: number; osmCount: number; userCreatedCount: number };
  /**
   * Per-load session id from the server; thread it into rank-outcome reporting.
   *
   * NULL ON A `coverage: "nothing"` REFUSAL, deliberately. This id is the served
   * rank context: an outcome posted against it upgrades the impression row THIS
   * load wrote. A refused load wrote none — the server's `logServeUnlessRefused`
   * suppressed it — so keeping the id would let the client report an outcome
   * with no impression behind it, moving the numerator of the exposure funnel
   * while the denominator stayed still. That is the second half of D11, on the
   * client.
   */
  sessionId: string | null;
  /** Present when the server refused; see the Refusals block at the top. */
  refusal?: DiscoveryRefusal;
}

export interface DiscoveryFeedOptions {
  destination?: string | null;
  lat?: number | null;
  lng?: number | null;
  radiusKm?: number;
  /** Categories to fan out across; defaults to the server's for_you feed. */
  categories?: string[];
  limit?: number;
  cursor?: string | null;
  /** Set false to fetch only the event-posts side of the feed (no places). */
  includePlaces?: boolean;
  /** Set false to skip the events section. */
  includeEvents?: boolean;
}

export async function getDiscoveryFeed(
  opts: DiscoveryFeedOptions,
): Promise<{ ok: true; data: DiscoveryFeedResult } | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };

  const { destination, lat, lng, radiusKm, categories, limit, cursor, includePlaces, includeEvents } = opts;
  if (!destination && (lat == null || lng == null)) {
    return { ok: false, error: 'city or lat+lng is required' };
  }

  const params = new URLSearchParams();
  if (destination) params.set('city', destination);
  if (lat != null) params.set('lat', String(lat));
  if (lng != null) params.set('lng', String(lng));
  if (radiusKm != null) params.set('radiusKm', String(radiusKm));
  if (categories && categories.length > 0) params.set('categories', categories.join(','));
  if (limit != null) params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  if (includePlaces === false) params.set('includePlaces', '0');
  if (includeEvents === false) params.set('includeEvents', '0');

  // The token is optional server-side, but event posts and the serve-point-7
  // impression only exist when a viewer resolves — so send it whenever signed in.
  const token = await freshToken();

  const feedBudget = new AbortController(); const feedTimer = setTimeout(() => feedBudget.abort(), DISCOVERY_FEED_TIMEOUT_MS); try {  // census-discovery §94.10 (D-W11X2-12): a hung request is bounded, and answers the transport-failure shape
    const res = await fetch(`${base}/api/discovery/feed?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined, signal: feedBudget.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as Partial<DiscoveryFeedResult>;
    const refusal = parseRefusal(body);
    return {
      ok: true,
      data: {
        places:        Array.isArray(body.places) ? body.places : [],
        posts:         Array.isArray(body.posts) ? body.posts : [],
        nextCursor:    body.nextCursor ?? null,
        total:         typeof body.total === 'number' ? body.total : 0,
        destination:   body.destination ?? destination ?? null,
        sourceSummary: body.sourceSummary ?? { seededDbCount: 0, osmCount: 0, userCreatedCount: 0 },
        // See the field's doc comment: a refused load has no served rank context.
        // `partial` keeps its id — those items really were served and really are
        // exposure, and dropping them would under-count in the other direction.
        sessionId:     refusedEverything(refusal) ? null : (body.sessionId ?? null),
        ...(refusal ? { refusal } : {}),
      },
    };
  } catch (err) {
    return { ok: false, error: (err as { name?: unknown } | null)?.name === 'AbortError' ? 'timeout' : 'Network error — check your connection' };
  } finally { clearTimeout(feedTimer); }
}

// ── "Already know it" discovery feedback ────────────────────────────────────────
//
// POST /api/discovery/already-known — records an already_known memory-feedback
// signal for a Discovery-served place (the backend bridges the served id to the
// canonical discovery_places.id and dedupes). Ownership is enforced server-side
// from the auth token. Idempotent; a 201 or a repeat both count as recorded.

export async function recordAlreadyKnown(
  placeId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };
  if (!placeId) return { ok: false, error: 'placeId is required' };

  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not signed in' };

  try {
    const res = await fetch(`${base}/api/discovery/already-known`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ placeId }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error — check your connection' };
  }
}

// ── Compass search-signal helper ──────────────────────────────────────────────
//
// Fire-and-forget: posts the search intent to the Compass signal endpoint so
// category_weights in compass_user_preferences are nudged for the For You feed.
// Never throws, never delays the search response.

export function postSearchSignal(
  query: string,
  opts?: { city?: string | null; category?: string | null },
): void {
  const base = apiBase();
  if (!base) return;
  freshToken()
    .then((token) => {
      if (!token) return;
      return fetch(`${base}/api/compass/signals/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          query,
          city: opts?.city ?? null,
          category: opts?.category ?? null,
        }),
      });
    })
    .catch(() => {
      // best-effort — signal failures must never surface to the user
    });
}

// ── Unified search ────────────────────────────────────────────────────────────

export interface UnifiedSearchResult {
  id: string;
  type: string;
  title: string;
  subtitle: string | null;
  avatarUrl: string | null;
  imageUrl: string | null;
  fallbackInitials: string | null;
  locationPreview: string | null;
  matchedReason: string | null;
  actionState: Record<string, boolean | string | number> | null;
  privacyState: { isPrivate?: boolean; isPublic?: boolean } | null;
  accessState: { canAccess: boolean } | null;
  destinationRoute: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
  startsAt: string | null;
  /** True when this result's subject holds a verified traveler status. */
  verified?: boolean;
}

export interface UnifiedSearchResponse {
  results: UnifiedSearchResult[];
  nextCursor: string | null;
  hasMore: boolean;
  query: string;
  type: string;
  timeLabel: string | null;
  /**
   * Present when the server refused. `results: []` with a `coverage: "nothing"`
   * refusal is "we could not search", not "nothing matched" — and the two must
   * not share a "No results for …" screen.
   */
  refusal?: DiscoveryRefusal;
}

/**
 * Search across all content types via /api/discovery/search.
 * Requires authentication — returns `{ ok: false }` when not signed in.
 * Pass `cursor` from the previous response to load the next page.
 *
 * @param opts.lat  User latitude (only when location permission already granted)
 * @param opts.lng  User longitude (only when location permission already granted)
 * @param opts.tz   IANA timezone string for time-intent parsing ("tonight" etc.)
 */
export async function searchUnified(
  query: string,
  type = 'all',
  cursor?: string | null,
  opts?: {
    lat?: number;
    lng?: number;
    tz?: string;
    city?: string;
    /** Intent params forwarded from parseSearchIntent() — sent as URL query params */
    intentParams?: Record<string, string>;
  },
): Promise<{ ok: true; data: UnifiedSearchResponse } | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };

  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not signed in' };

  const params = new URLSearchParams({ q: query, type });
  if (cursor)        params.set('cursor', cursor);
  if (opts?.lat != null) params.set('lat',  String(opts.lat));
  if (opts?.lng != null) params.set('lng',  String(opts.lng));
  if (opts?.tz)          params.set('tz',   opts.tz);
  if (opts?.city)        params.set('city', opts.city);
  if (opts?.intentParams) {
    for (const [k, v] of Object.entries(opts.intentParams)) {
      if (v) params.set(k, v);
    }
  }

  try {
    const res = await fetch(`${base}/api/discovery/search?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      return { ok: false, error: (body.message as string) ?? `HTTP ${res.status}` };
    }
    const data = withParsedRefusal<UnifiedSearchResponse>(await res.json());
    // Signal search intent to Compass for For You feed personalisation.
    //
    // STILL SENT ON A REFUSAL, deliberately. This signal records that the USER
    // SEARCHED — it carries the query and the city, never the results — and the
    // user really did search, whatever the server then failed to do. Suppressing
    // it here would throw away a real intent signal precisely during an outage,
    // and it is not what the ruling's "exclude failed responses from exposure
    // accounting" asks for: that sentence is about the impression denominator
    // (rank_events → content_distribution_stats.eligible_impressions), which
    // this endpoint does not touch. A genuinely empty search signals too, so
    // "produced nothing" was never the criterion here.
    postSearchSignal(query, { city: opts?.city ?? null });
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Network error — check your connection' };
  }
}

// ── Live search suggestions (typeahead) ────────────────────────────────────────

export interface SuggestGroup {
  type: string;
  label: string;
  items: UnifiedSearchResult[];
}

/**
 * Grouped typeahead suggestions for the global search bar.
 * Lighter than searchUnified — small per-type limits, single round trip,
 * same backend privacy filtering. Supports AbortSignal so the caller can
 * cancel superseded keystrokes.
 */
export async function getSearchSuggestions(
  query: string,
  opts?: { lat?: number; lng?: number; city?: string },
  signal?: AbortSignal,
): Promise<
  | { ok: true; groups: SuggestGroup[]; refusal?: DiscoveryRefusal }
  | { ok: false; aborted: boolean; error: string }
> {
  const base = apiBase();
  if (!base) return { ok: false, aborted: false, error: 'API not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, aborted: false, error: 'Not signed in' };

  const params = new URLSearchParams({ q: query });
  if (opts?.lat != null) params.set('lat', String(opts.lat));
  if (opts?.lng != null) params.set('lng', String(opts.lng));
  if (opts?.city) params.set('city', opts.city);

  try {
    const res = await fetch(`${base}/api/discovery/suggest?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) return { ok: false, aborted: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { groups?: SuggestGroup[] };
    // /discovery/suggest is the route with THREE distinct empty answers (a
    // too-short query is `validation`, an unreadable visibility state is
    // `transient_db`, a query that matches nothing carries no refusal at all).
    // They arrive as the same `groups: []`, so the refusal is the only thing
    // that tells them apart.
    const refusal = parseRefusal(body);
    return {
      ok: true,
      groups: Array.isArray(body.groups) ? body.groups : [],
      ...(refusal ? { refusal } : {}),
    };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return { ok: false, aborted, error: 'Network error' };
  }
}

// ── Search history ─────────────────────────────────────────────────────────────

export interface SearchHistoryEntry {
  id: string;
  query: string;
  search_type: string;
  searched_at: string;
}

/**
 * Fetch the current user's recent search history (up to `limit` entries).
 * Returns an empty array on any error — fail-open so network hiccups don't break the UI.
 */
export async function getSearchHistory(limit = 20): Promise<SearchHistoryEntry[]> {
  const base = apiBase();
  if (!base) return [];
  const token = await freshToken();
  if (!token) return [];
  try {
    const res = await fetch(`${base}/api/me/search-history?limit=${limit}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { history?: SearchHistoryEntry[] };
    return Array.isArray(data.history) ? data.history : [];
  } catch {
    return [];
  }
}

/**
 * Save a search term to the user's history.
 * Returns the server-assigned UUID for the saved row so the UI can
 * replace its optimistic synthetic id before allowing per-item delete.
 * Returns null on error (save is non-fatal; deletion will fall back to ?q=).
 */
export async function saveSearchHistory(query: string, searchType = 'all'): Promise<string | null> {
  const base = apiBase();
  if (!base) return null;
  const token = await freshToken();
  if (!token) return null;
  try {
    const res = await fetch(`${base}/api/me/search-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, search_type: searchType }),
    });
    if (!res.ok) return null;
    const json = await res.json() as { ok: boolean; id?: string | null };
    return json.id ?? null;
  } catch {
    return null;
  }
}

// ── Wikidata enrichment ───────────────────────────────────────────────────────

export interface WikidataEnrichment {
  /** English short description from Wikidata. */
  description: string | null;
  /** English Wikipedia article URL, when available. */
  wikipediaUrl: string | null;
  /** Wikimedia Commons image URL (via Special:FilePath), when available. */
  commonsImageUrl: string | null;
}

/**
 * Fetch structured enrichment for a Wikidata entity (Qnnn).
 * No auth required. Returns null on any network/parse failure.
 */
export async function getWikidataEnrichment(wikidataId: string): Promise<WikidataEnrichment | null> {
  const base = apiBase();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/discovery/wikidata/${encodeURIComponent(wikidataId)}`);
    if (!res.ok) return null;
    return (await res.json()) as WikidataEnrichment;
  } catch {
    return null;
  }
}

/**
 * Clear the current user's search history.
 * Pass `id` (UUID) to remove a single entry by its row id; omit to clear all.
 */
export async function clearSearchHistory(id?: string): Promise<void> {
  const base = apiBase();
  if (!base) return;
  const token = await freshToken();
  if (!token) return;
  try {
    const url = id
      ? `${base}/api/me/search-history?id=${encodeURIComponent(id)}`
      : `${base}/api/me/search-history`;
    await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // non-fatal
  }
}

// ── VIEWER SCOPE ───────────────────────────────────────────────────────────────
//
// GET /api/discovery, /community and /counts are sent WITH the viewer's token
// when signed in (and with no Authorization header at all when signed out, which
// those routes support). Until 2026-09-27 they were sent with none, so every
// production serve was anonymous: the viewer's blocks (both directions), mutes,
// "Not interested" dismissals, age bounds and Layover gating never applied, no
// per-viewer ranking ran, and no serve telemetry was written for anybody.
//
// Sending the token makes the answer per viewer IN CONTENT, which is why the two
// device caches that hold these answers — `_CLIENT_CACHE` above and the
// community hook's module cache — are scoped by `./discoveryViewerScope.ts`:
// every entry carries the viewer + epoch it was written in and is readable only
// in that scope; both caches are cleared on a viewer change and on a block /
// mute / dismissal; and neither is written from a response whose scope moved
// while it was in flight. The rules, and why each one is there, are in that
// module's header.

// Every scope change empties the page cache: a previous viewer's pages must not
// sit in memory, and pages that predate a block or dismissal must not be painted.
onDiscoveryScopeChange(() => _CLIENT_CACHE.clear());

/** Test seam: how many pages the device holds — a previous viewer's must not even sit in memory. */
export function _discoveryClientCacheSizeForTests(): number {
  return _CLIENT_CACHE.size;
}

/** A cached page, only if it was written in the CURRENT scope; anything else is dropped on sight. */
function _liveCacheEntry(key: string): { data: DiscoveryResult; at: number; scope: DiscoveryScope } | undefined {
  const entry = _CLIENT_CACHE.get(key);
  if (!entry) return undefined;
  if (isCurrentDiscoveryScope(entry.scope)) return entry;
  _CLIENT_CACHE.delete(key);
  return undefined;
}

/**
 * The community answer for the lease it was fetched under. Bylines, blocks and
 * mutes are all per viewer, so an answer fetched for a viewer who is no longer
 * the viewer is DISCARDED; otherwise its scope rides along so the hook's cache
 * can refuse it if a block or dismissal landed while it was in flight.
 */
function communityForLease(
  lease: DiscoveryLease,
  data: CommunityDiscoveryResult,
): { ok: true; data: CommunityDiscoveryResult; scope: DiscoveryScope } | { ok: false; error: string } {
  if (!isLeaseViewerCurrent(lease)) return { ok: false, error: VIEWER_CHANGED_ERROR };
  return { ok: true, data, scope: lease.scope };
}

// ── TOKEN SOURCE (test seam) ──────────────────────────────────────────────────
//
// `freshToken` above resolves the viewer's token through `services/apiToken.ts`,
// imported lazily so this module has no static path to React Native. The ONE
// override is this seam, and it exists for the route→client leg
// (artifacts/api-server/src/test/discoveryClientRouteE2E.test.ts, census-discovery
// §60): that suite runs the real Discovery router in-process and drives THIS
// module against it under Node, where apiToken cannot load. It replaces where the
// token comes from and nothing else — the lease, the header, the parse, the
// projection and both caches are the production code. No production caller.
let _tokenSourceForTests: (() => Promise<string | null>) | null = null;

/** Test seam: resolve the viewer's token from `source` instead of apiToken; `null` restores apiToken. */
export function _setDiscoveryTokenSourceForTests(source: (() => Promise<string | null>) | null): void {
  _tokenSourceForTests = source;
}

/**
 * census-discovery §94.10 (register D-W11X2-12): how long `getDiscoveryFeed`
 * waits before answering the transport-failure shape. The Compass section
 * budget (services/compass.ts COMPASS_SECTION_TIMEOUT_MS): the feed's only
 * caller is the For You tab's supplementary "Live from events" strip, which
 * sits in the same place a Compass section does and should give up on the same
 * clock. Declared at the foot so no cited line above moves; read only at call time.
 */
export const DISCOVERY_FEED_TIMEOUT_MS = 15_000;
