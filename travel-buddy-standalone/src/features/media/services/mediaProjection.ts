/**
 * features/media — client projection service (spec §33/§42/§43).
 *
 * Authenticated read client for the Media v2 projection endpoints. Follows the
 * exact conventions of services/mediaFeed.ts:
 *   - EXPO_PUBLIC_API_BASE_URL + a fresh Supabase bearer token,
 *   - a lazy token seam so node:test can inject a static token without pulling
 *     react-native into the runner,
 *   - every fetch returns a typed ProjectionResult and NEVER throws.
 *
 * GRACEFUL DEGRADATION (task requirement): the backend projection endpoints are
 * landing in a parallel PR. A 404 (route not deployed yet) maps to an EMPTY
 * result, not an error, so the shell renders a clean empty state. Network /
 * server / auth failures are reported by kind so the UI can pick copy — but the
 * service still never throws.
 *
 * The mapping functions are PURE and defensive (accept `unknown`, coerce every
 * field) so they are unit-testable and cannot crash on a partial/absent payload.
 */
import type {
  MediaProjection,
  MediaContributor,
  ObservationClass,
  FreshnessClass,
  ProjectionResult,
  ProjectionErrorKind,
} from '../types/media.ts';
import type {
  MediaWorldProjection,
  MediaCity,
  CityVisualZone,
  CityZoneState,
  ForYouNowItem,
  ForYouNowKind,
  ChangingNowItem,
} from '../types/mediaContext.ts';
import type { ActivityTrend, PlaceCurrentView, CurrentPicture, PerspectiveGroup } from '../types/perspective.ts';
import type {
  MediaExperienceProjection,
  ExperienceState,
  ExperienceChain,
  ExperienceChainStep,
} from '../types/mediaExperience.ts';
import type { HiddenGemMediaProjection, HiddenGemState, GemLocationPrecision } from '../types/hiddenGemMedia.ts';
import type { ConfidenceState } from '../types/media.ts';
import type { PeopleLensGroup, PeopleLensProjection } from '../types/peopleLens.ts';
import type { MyWorldBucket, MyWorldLibrary } from '../types/myWorld.ts';

// ── Token seam (mirrors services/mediaFeed.ts) ────────────────────────────────
let _testToken: string | null = null;
/** Inject a static token for node:test runs. Bypasses Supabase entirely. */
export function _setTestFreshToken(token: string): void {
  _testToken = token;
}
/** Remove the injected token. Always call in afterEach. */
export function _clearTestFreshToken(): void {
  _testToken = null;
}
async function freshToken(): Promise<string | null> {
  if (_testToken !== null) return _testToken;
  const { freshToken: real } = await import('../../../services/apiToken.ts');
  return real();
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

// ── Coercion helpers (defensive; never throw) ─────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function asBool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

const OBSERVATION_CLASSES: readonly ObservationClass[] = [
  'observed',
  'inferred',
  'user_claimed',
  'generated',
  'predicted',
];
const FRESHNESS_CLASSES: readonly FreshnessClass[] = ['live', 'fresh', 'recent', 'historical'];
const TRENDS: readonly ActivityTrend[] = ['rising', 'steady', 'falling'];
const ZONE_STATES: readonly CityZoneState[] = [
  'starting',
  'building',
  'peak',
  'moderate',
  'quiet',
  'winding_down',
];
const FORYOU_KINDS: readonly ForYouNowKind[] = [
  'fresh_perspectives',
  'recently_confirmed',
  'changing',
  'seasonal',
];
const CONFIDENCE_STATES: readonly ConfidenceState[] = ['low', 'moderate', 'strong'];
const EXPERIENCE_STATES: readonly ExperienceState[] = [
  'upcoming',
  'starting',
  'building',
  'peak',
  'winding_down',
  'ended',
  'typical',
];
const GEM_STATES: readonly HiddenGemState[] = [
  'recently_confirmed',
  'still_hidden',
  'quiet_now',
  'getting_discovered',
  'seasonal',
  'hard_to_find',
  'access_changed',
  'temporarily_unavailable',
  'overcrowding_risk',
  'no_longer_hidden',
];
const GEM_PRECISIONS: readonly GemLocationPrecision[] = ['hidden', 'approximate', 'area', 'open'];

// ── Server-shape helpers (§43 reconciliation) ─────────────────────────────────
//
// The §43 endpoints (#278) carry a DELIBERATELY coarse, anti-fabrication shape:
//   • media freshness is 'fresh' | 'recent' | 'historical' | 'none' — never 'live'
//     (the word 'live' is reserved for the gated Live Intelligence path);
//   • a zone / place carries NO qualitative activity state UNLESS a gated live
//     crowd claim exists (server field `liveCrowdLabel` / `currentState.crowdLabel`).
// These helpers translate that honest server output into the client view-model
// WITHOUT inventing a state the server refused to assert.

/** Map a server FreshnessState ('none' included) to the client FreshnessClass. */
function freshnessClass(v: unknown): FreshnessClass {
  // 'none' (the server's honest "no media") has no client class → treat as historical.
  if (v === 'none') return 'historical';
  return oneOf<FreshnessClass>(v, FRESHNESS_CLASSES, 'recent');
}

/**
 * Map a gated live crowd label (the ONLY honest source of a qualitative state)
 * to a CityZoneState. Returns null for an absent/unknown label so the UI shows
 * no fabricated pulse (§46/§46.2).
 */
function crowdLabelToState(v: unknown): CityZoneState | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!s) return null;
  // Direct hits on the state vocabulary first.
  if ((ZONE_STATES as readonly string[]).includes(s)) return s as CityZoneState;
  switch (s) {
    case 'busy':
    case 'lively':
    case 'filling':
    case 'filling_up':
      return 'building';
    case 'packed':
    case 'full':
    case 'peaking':
    case 'crowded':
      return 'peak';
    case 'steady':
    case 'normal':
    case 'average':
      return 'moderate';
    case 'empty':
    case 'dead':
    case 'calm':
      return 'quiet';
    case 'emptying':
    case 'clearing':
    case 'winding down':
      return 'winding_down';
    default:
      return null;
  }
}

/** Corroboration → current-picture strength (§12/§18 "3 independent sources"). */
function strengthFromSources(sourceCount: number): ConfidenceState {
  if (sourceCount >= 3) return 'strong';
  if (sourceCount >= 2) return 'moderate';
  return 'low';
}

/** Whole minutes since an ISO timestamp; null when unparseable/absent. */
function ageMinutesFromIso(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 60000));
}

/** Newest capturedAt (ISO) across a media list, or null. */
function newestCapturedAt(media: MediaProjection[]): string | null {
  let newest = -Infinity;
  let iso: string | null = null;
  for (const m of media) {
    const c = m.capturedAt ?? null;
    if (!c) continue;
    const t = Date.parse(c);
    if (!Number.isNaN(t) && t > newest) {
      newest = t;
      iso = c;
    }
  }
  return iso;
}

// ── Pure mappers ──────────────────────────────────────────────────────────────

/**
 * Map a raw media object into a MediaProjection. Always returns a valid object.
 *
 * Reads the REAL §43 server shape (flat: `durationSeconds`, `placeId` /
 * `placeLabel`, `contributor.name` / `isOfficial`) while still accepting the
 * earlier speculative nested shape (`durationMs`, `place: {…}`,
 * `contributor.displayName`) so both the live payload and older fixtures map.
 */
export function mapMediaProjection(raw: unknown): MediaProjection {
  const o = isObj(raw) ? raw : {};
  const contributorRaw = o.contributor;
  const co = isObj(contributorRaw) ? contributorRaw : null;
  const placeRaw = o.place;
  const po = isObj(placeRaw) ? placeRaw : null;

  // Duration: server sends whole seconds; accept a pre-computed ms too.
  const durationSeconds = asNumber(o.durationSeconds);
  const durationMs = asNumber(o.durationMs) ?? (durationSeconds != null ? durationSeconds * 1000 : null);

  // Coarse place: server is flat (placeId + placeLabel); older shape was nested.
  const placeId = asString(o.placeId) ?? (po ? asString(po.id) : null);
  const placeName = asString(o.placeLabel) ?? (po ? asString(po.name) : null);
  const category = asString(o.category);

  return {
    id: asString(o.id) ?? '',
    mediaType: o.mediaType === 'video' ? 'video' : 'image',
    thumbnailUrl: asString(o.thumbnailUrl) ?? asString(o.thumbnail_url) ?? null,
    url: asString(o.url),
    width: asNumber(o.width),
    height: asNumber(o.height),
    durationMs,
    capturedAt: asString(o.capturedAt),
    // The server does not label an evidence class on projected media; a captured
    // photo/video is 'observed'. Honour an explicit value when present (fixtures).
    observationClass: oneOf<ObservationClass>(o.observationClass, OBSERVATION_CLASSES, 'observed'),
    freshness: freshnessClass(o.freshness),
    ageMinutes: asNumber(o.ageMinutes),
    // Perspective bucket: explicit key if given, else the coarse category bucket.
    perspectiveKey: asString(o.perspectiveKey) ?? (category ? category.toLowerCase() : null),
    freshnessLabel: asString(o.freshnessLabel),
    contributor: co
      ? {
          id: asString(co.id) ?? '',
          displayName:
            asString(co.name) ?? asString(co.displayName) ?? asString(co.username) ?? 'Contributor',
          username: asString(co.username),
          avatarUrl: asString(co.avatarUrl),
          verified: asBool(co.verified),
          // Prefer an explicit trust label; else surface an official badge honestly.
          trustLabel: asString(co.trustLabel) ?? (asBool(co.isOfficial) ? 'Official' : null),
        }
      : null,
    place: placeId != null || placeName != null ? { id: placeId, name: placeName } : null,
    category,
    note: asString(o.note),
    whyThis: asString(o.whyThis) ?? asString(o.compassExplanation),
  };
}

/**
 * Map a media list, stamping each item's `perspectiveKey` with the given group
 * key so the PerspectiveMosaic's group filter matches (server media carries the
 * group only implicitly via `category`). Used when flattening place/perspective
 * group media into a hero list.
 */
function mapGroupMedia(raw: unknown, groupKey: string | null): MediaProjection[] {
  return asArray(raw)
    .map((m) => {
      const mapped = mapMediaProjection(m);
      if (groupKey) mapped.perspectiveKey = groupKey;
      return mapped;
    })
    .filter((m) => m.id !== '');
}

function mapMediaList(raw: unknown): MediaProjection[] {
  return asArray(raw)
    .map(mapMediaProjection)
    .filter((m) => m.id !== '');
}

function mapCity(raw: unknown): MediaCity | null {
  // §43 world projection sends `city` as a bare label string; older shape was an object.
  if (typeof raw === 'string') {
    const name = raw.trim();
    return name ? { id: null, name } : null;
  }
  if (!isObj(raw)) return null;
  const name = asString(raw.name);
  if (!name) return null;
  return { id: asString(raw.id), name, timezone: asString(raw.timezone) };
}

/**
 * Map a §43 WorldZone → CityVisualZone. The server zone is
 * `{ placeId, label, perspectiveCount, freshness, liveClaims, liveCrowdLabel }`;
 * the older shape was `{ id, name, state, trend }`. A qualitative state is only
 * ever taken from an explicit `state` (fixtures) or a gated `liveCrowdLabel` —
 * never invented (§46). Absent → null state, and the pulse renders neutrally.
 */
export function mapCityVisualZone(raw: unknown): CityVisualZone | null {
  if (!isObj(raw)) return null;
  const name = asString(raw.label) ?? asString(raw.name);
  const id = asString(raw.placeId) ?? asString(raw.id) ?? name;
  if (!name || !id) return null;
  const state =
    (raw.state != null ? oneOf<CityZoneState>(raw.state, ZONE_STATES, 'moderate') : null) ??
    crowdLabelToState(raw.liveCrowdLabel);
  return {
    id,
    name,
    state,
    trend: raw.trend != null ? oneOf<ActivityTrend>(raw.trend, TRENDS, 'steady') : null,
    perspectiveCount: asNumber(raw.perspectiveCount),
    freshness: raw.freshness != null ? freshnessClass(raw.freshness) : null,
  };
}

/**
 * Map a §43 CategoryBucket → ForYouNowItem. Server sends
 * `{ category, label, freshPerspectives, totalPerspectives }`; the count shown
 * is the FRESH count (a contribution signal, not a view counter — §46).
 */
function mapForYouNow(raw: unknown): ForYouNowItem | null {
  if (!isObj(raw)) return null;
  const category = asString(raw.label) ?? asString(raw.category);
  if (!category) return null;
  const count =
    asNumber(raw.count) ?? asNumber(raw.freshPerspectives) ?? asNumber(raw.totalPerspectives) ?? 0;
  const isGem = category.toLowerCase().includes('gem');
  return {
    id: asString(raw.id) ?? asString(raw.category) ?? category,
    category,
    count,
    kind: oneOf<ForYouNowKind>(raw.kind, FORYOU_KINDS, isGem ? 'recently_confirmed' : 'fresh_perspectives'),
    // Gems open the Hidden Gems lens; everything else defaults to Places.
    lens: (asString(raw.lens) as ForYouNowItem['lens']) ?? (isGem ? 'gems' : 'places'),
    entityId: asString(raw.entityId),
  };
}

/**
 * Map a §43 changing-now zone → ChangingNowItem. On the server a changing-now
 * entry is a WorldZone that HAS a gated live claim, so `liveCrowdLabel` is the
 * honest source of both the state chip and a subtitle. No heroMedia is carried
 * at this level (the card renders its designed fallback).
 */
function mapChangingNow(raw: unknown): ChangingNowItem | null {
  if (!isObj(raw)) return null;
  const title = asString(raw.title) ?? asString(raw.label);
  if (!title) return null;
  const crowd = asString(raw.liveCrowdLabel);
  const state =
    (raw.state != null ? oneOf<CityZoneState>(raw.state, ZONE_STATES, 'moderate') : null) ??
    crowdLabelToState(raw.liveCrowdLabel);
  return {
    id: asString(raw.id) ?? asString(raw.placeId) ?? title,
    title,
    subtitle: asString(raw.subtitle) ?? crowd,
    state,
    trend: raw.trend != null ? oneOf<ActivityTrend>(raw.trend, TRENDS, 'steady') : null,
    freshness: freshnessClass(raw.freshness),
    freshnessLabel: asString(raw.freshnessLabel),
    whyThis: asString(raw.whyThis),
    heroMedia: mapMediaList(raw.heroMedia),
    placeId: asString(raw.placeId),
  };
}

/**
 * Map the GET /media/world payload. Every collection defaults to [] and the
 * whole thing is safe on `{}` / null / garbage — the reason isWorldProjectionEmpty
 * can then classify it as an empty (not error) state.
 */
export function mapWorldProjection(raw: unknown): MediaWorldProjection {
  const o = isObj(raw) ? raw : {};
  return {
    city: mapCity(o.city),
    cityVisualState: asArray(o.cityVisualState)
      .map(mapCityVisualZone)
      .filter((z): z is CityVisualZone => z !== null),
    forYouNow: asArray(o.forYouNow)
      .map(mapForYouNow)
      .filter((f): f is ForYouNowItem => f !== null),
    changingNow: asArray(o.changingNow)
      .map(mapChangingNow)
      .filter((c): c is ChangingNowItem => c !== null),
    generatedAt: asString(o.generatedAt),
  };
}

function mapPerspectiveGroup(raw: unknown): PerspectiveGroup | null {
  if (!isObj(raw)) return null;
  const label = asString(raw.label);
  const key = asString(raw.key) ?? (label ? label.toLowerCase() : null);
  if (!label || !key) return null;
  return {
    key,
    label,
    count: asNumber(raw.count) ?? 0,
    cover: isObj(raw.cover) ? mapMediaProjection(raw.cover) : null,
  };
}

/** Map an explicit `currentPicture` object (older fixture shape). */
function mapCurrentPicture(raw: unknown): CurrentPicture {
  const o = isObj(raw) ? raw : {};
  return {
    strength: oneOf<ConfidenceState>(o.strength, CONFIDENCE_STATES, 'low'),
    updatedAt: asString(o.updatedAt),
    ageMinutes: asNumber(o.ageMinutes),
    perspectiveCount: asNumber(o.perspectiveCount) ?? 0,
    contributorCount: asNumber(o.contributorCount) ?? 0,
    sourceCount: asNumber(o.sourceCount) ?? 0,
    trend: oneOf<ActivityTrend>(o.trend, TRENDS, 'steady'),
  };
}

/** Map a §43 server `perspectives` group → client PerspectiveGroup (+ its media). */
function mapServerPerspectiveGroup(raw: unknown): { group: PerspectiveGroup; media: MediaProjection[] } | null {
  if (!isObj(raw)) return null;
  const label = asString(raw.label);
  const key = asString(raw.key) ?? (label ? label.toLowerCase() : null);
  if (!label || !key) return null;
  const media = mapGroupMedia(raw.media, key);
  return {
    group: {
      key,
      label,
      count: asNumber(raw.perspectiveCount) ?? asNumber(raw.count) ?? media.length,
      cover: media[0] ?? (isObj(raw.cover) ? mapMediaProjection(raw.cover) : null),
    },
    media,
  };
}

/**
 * Map GET /media/places/:id (§13). Reads the REAL server PlaceProjection:
 *   { placeId, place:{id,name,city,country,neighborhood},
 *     currentState:{live,claims,crowdLabel}, perspectives:PerspectiveSummary, freshness }
 * and derives the client's "current picture" (a corroboration/coverage summary)
 * from it. Still accepts the older flat fixture shape (`placeName`,
 * `currentPicture`, top-level `groups`/`heroMedia`) so both map.
 *
 * @param nowMs single clock read (no split clock) for the "updated Nm ago" age.
 */
export function mapPlaceCurrentView(raw: unknown, nowMs: number = Date.now()): PlaceCurrentView | null {
  const o = isObj(raw) ? raw : {};
  const placeObj = isObj(o.place) ? o.place : null;
  const placeId = (placeObj ? asString(placeObj.id) : null) ?? asString(o.placeId) ?? asString(o.id);
  if (!placeId) return null;
  const placeName =
    (placeObj ? asString(placeObj.name) : null) ?? asString(o.placeName) ?? asString(o.name);

  // Live state label — ONLY from a gated live crowd claim; never fabricated.
  const currentStateObj = isObj(o.currentState) ? o.currentState : null;
  const crowdLabel = currentStateObj ? asString(currentStateObj.crowdLabel) : null;

  // New server path: derive everything from `perspectives`.
  const perspectivesObj = isObj(o.perspectives) ? o.perspectives : null;
  if (perspectivesObj) {
    const mappedGroups = asArray(perspectivesObj.groups)
      .map(mapServerPerspectiveGroup)
      .filter((g): g is { group: PerspectiveGroup; media: MediaProjection[] } => g !== null);
    const groups = mappedGroups.map((g) => g.group);
    // Hero list = all group media, newest-first (each already stamped with its key).
    const heroMedia = mappedGroups
      .flatMap((g) => g.media)
      .sort((a, b) => Date.parse(b.capturedAt ?? '') - Date.parse(a.capturedAt ?? ''));

    const sourceCount = asNumber(perspectivesObj.independentSourceCount) ?? 0;
    const updatedAt = newestCapturedAt(heroMedia);
    const currentPicture: CurrentPicture = {
      strength: strengthFromSources(sourceCount),
      updatedAt,
      ageMinutes: ageMinutesFromIso(updatedAt, nowMs),
      perspectiveCount: asNumber(perspectivesObj.totalPerspectives) ?? heroMedia.length,
      contributorCount: asNumber(perspectivesObj.contributorCount) ?? 0,
      sourceCount,
      // The server refuses to assert a trend; 'steady' is the neutral default.
      trend: 'steady',
    };
    return {
      placeId,
      placeName,
      stateLabel: crowdLabel ? titleCase(crowdLabel) : null,
      currentPicture,
      groups,
      heroMedia,
      areaName:
        (placeObj ? asString(placeObj.neighborhood) ?? asString(placeObj.city) : null) ??
        asString(o.areaName),
    };
  }

  // Older fixture path: flat currentPicture + top-level groups/heroMedia.
  return {
    placeId,
    placeName,
    stateLabel: asString(o.stateLabel) ?? (crowdLabel ? titleCase(crowdLabel) : null),
    currentPicture: mapCurrentPicture(o.currentPicture),
    groups: asArray(o.groups)
      .map(mapPerspectiveGroup)
      .filter((g): g is PerspectiveGroup => g !== null),
    heroMedia: mapMediaList(o.heroMedia),
    areaName: asString(o.areaName),
  };
}

/** True when a mapped place view carries no perspectives worth rendering. */
export function isPlaceViewEmpty(view: PlaceCurrentView | null): boolean {
  return view === null || view.currentPicture.perspectiveCount === 0;
}

function titleCase(s: string): string {
  const t = s.trim().replace(/_/g, ' ');
  return t.length === 0 ? t : t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Map one experience projection (§23) from GET /media/experiences/:id.
 *
 * The server (MediaExperienceResolver) returns
 *   { id, kind, title, placeIds, eventId?/tripId?, startedAt, expectedEndAt,
 *     currentState:{live,claims,crowdLabel}, perspectiveCount, contributorCount,
 *     freshness, heroMedia, available }
 * and, when the viewer may not see it, a well-formed `{ available: false, … }`.
 * That maps to null (nothing to render) — NOT an error. Note the server's
 * `currentState` is a live-claim OBJECT, not an ExperienceState lifecycle enum,
 * so a lifecycle state is only taken from an explicit string value (fixtures);
 * a live-claim object never fabricates one (§46).
 */
export function mapExperienceProjection(raw: unknown): MediaExperienceProjection | null {
  if (!isObj(raw)) return null;
  // A server "not available" shape → null (private/blocked/ineligible/not found).
  if (raw.available === false) return null;
  const id = asString(raw.id);
  if (!id) return null;
  const kind = asString(raw.kind);
  const title =
    asString(raw.title) ?? (kind === 'trip' ? 'Trip' : kind === 'event' ? 'Event' : 'Experience');
  // Only an explicit lifecycle STRING becomes currentState; the live-claim object does not.
  const currentState =
    typeof raw.currentState === 'string'
      ? oneOf<ExperienceState>(raw.currentState, EXPERIENCE_STATES, 'typical')
      : null;
  return {
    id,
    title,
    placeIds: asArray(raw.placeIds)
      .map((p) => asString(p))
      .filter((p): p is string => p !== null),
    eventId: asString(raw.eventId),
    tripId: asString(raw.tripId),
    startedAt: asString(raw.startedAt),
    expectedEndAt: asString(raw.expectedEndAt),
    currentState,
    perspectiveCount: asNumber(raw.perspectiveCount) ?? 0,
    contributorCount: asNumber(raw.contributorCount) ?? 0,
    freshness: freshnessClass(raw.freshness),
    confidence:
      raw.confidence != null ? oneOf<ConfidenceState>(raw.confidence, CONFIDENCE_STATES, 'low') : null,
    heroMedia: mapMediaList(raw.heroMedia),
  };
}

export function mapExperienceList(raw: unknown): MediaExperienceProjection[] {
  return asArray(raw)
    .map(mapExperienceProjection)
    .filter((e): e is MediaExperienceProjection => e !== null);
}

/**
 * Derive an experience CHAIN (§23.1 "Dinner → Rooftop → Nightclub") from an
 * experience's hero media, grouped by distinct place (id, else label). Returns
 * null when fewer than two distinct places are represented — a single-place
 * experience is not a chain, and we never invent steps we cannot label.
 */
export function buildExperienceChain(exp: MediaExperienceProjection): ExperienceChain | null {
  const byPlace = new Map<string, ExperienceChainStep>();
  const order: string[] = [];
  for (const m of exp.heroMedia) {
    const placeId = m.place?.id ?? null;
    const label = m.place?.name ?? null;
    const key = placeId ?? (label ? `label:${label.toLowerCase()}` : null);
    if (!key || !label) continue; // unlabeled media cannot be an honest chain step
    const existing = byPlace.get(key);
    if (existing) {
      existing.perspectiveCount += 1;
    } else {
      byPlace.set(key, { placeId, label, perspectiveCount: 1, cover: m });
      order.push(key);
    }
  }
  if (order.length < 2) return null;
  return {
    id: exp.id,
    title: exp.title,
    steps: order.map((k) => byPlace.get(k)!),
    freshness: exp.freshness,
  };
}

/** Map one hidden-gem media projection (§16). Never exposes precise GPS. */
export function mapHiddenGemMedia(raw: unknown): HiddenGemMediaProjection | null {
  if (!isObj(raw)) return null;
  const title = asString(raw.title);
  const id = asString(raw.id);
  if (!title || !id) return null;
  return {
    id,
    title,
    state: oneOf<HiddenGemState>(raw.state, GEM_STATES, 'still_hidden'),
    freshness: oneOf<FreshnessClass>(raw.freshness, FRESHNESS_CLASSES, 'recent'),
    areaLabel: asString(raw.areaLabel),
    locationPrecision: oneOf<GemLocationPrecision>(raw.locationPrecision, GEM_PRECISIONS, 'hidden'),
    collectionLabel: asString(raw.collectionLabel),
    confirmationCount: asNumber(raw.confirmationCount) ?? 0,
    cover: isObj(raw.cover) ? mapMediaProjection(raw.cover) : null,
  };
}

export function mapHiddenGemList(raw: unknown): HiddenGemMediaProjection[] {
  return asArray(raw)
    .map(mapHiddenGemMedia)
    .filter((g): g is HiddenGemMediaProjection => g !== null);
}

// ── People lens (§27) ─────────────────────────────────────────────────────────

/** Map a server contributor object → client MediaContributor. */
function mapContributor(raw: unknown): MediaContributor | null {
  if (!isObj(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;
  return {
    id,
    displayName:
      asString(raw.name) ?? asString(raw.displayName) ?? asString(raw.username) ?? 'Contributor',
    username: asString(raw.username),
    avatarUrl: asString(raw.avatarUrl),
    verified: asBool(raw.verified),
    trustLabel: asString(raw.trustLabel) ?? (asBool(raw.isOfficial) ? 'Official' : null),
  };
}

/** Map one server PeopleGroup → PeopleLensGroup, or null when unusable. */
function mapPeopleGroup(raw: unknown): PeopleLensGroup | null {
  if (!isObj(raw)) return null;
  const contributor = mapContributor(raw.contributor);
  const media = mapMediaList(raw.media);
  // A social group with no identity or no renderable perspective is dropped.
  if (!contributor || media.length === 0) return null;
  return {
    contributor,
    perspectiveCount: asNumber(raw.perspectiveCount) ?? media.length,
    freshness: freshnessClass(raw.freshness),
    media,
  };
}

/**
 * Map GET /media/people (§27). Server shape: `{ generatedAt, people:[…], … }`.
 * Groups are already contributor-grouped and eligibility-gated server-side.
 */
export function mapPeopleProjection(raw: unknown): PeopleLensProjection {
  const o = isObj(raw) ? raw : {};
  return {
    people: asArray(o.people)
      .map(mapPeopleGroup)
      .filter((g): g is PeopleLensGroup => g !== null),
    generatedAt: asString(o.generatedAt),
  };
}

// ── My World (owner library, §30) ─────────────────────────────────────────────

function mapMyWorldBucket(raw: unknown): MyWorldBucket | null {
  if (!isObj(raw)) return null;
  const key = asString(raw.key);
  const label = asString(raw.label);
  if (!key || !label) return null;
  const media = mapMediaList(raw.media);
  return {
    key,
    label,
    ownerOnly: asBool(raw.ownerOnly),
    count: asNumber(raw.count) ?? media.length,
    media,
  };
}

/**
 * Map GET /media/me (§30). Server shape: `{ generatedAt, buckets:[…] }`. The
 * buckets are always well-formed (even when empty) so the lens can render its
 * filter chips from real data.
 */
export function mapMyWorldLibrary(raw: unknown): MyWorldLibrary {
  const o = isObj(raw) ? raw : {};
  return {
    buckets: asArray(o.buckets)
      .map(mapMyWorldBucket)
      .filter((b): b is MyWorldBucket => b !== null),
    generatedAt: asString(o.generatedAt),
  };
}

/** True when a My World library carries no media in any bucket. */
export function isMyWorldEmpty(lib: MyWorldLibrary): boolean {
  return lib.buckets.every((b) => b.media.length === 0);
}

// ── Transport ─────────────────────────────────────────────────────────────────

/**
 * GET `path` and parse JSON, mapping HTTP/network conditions to a
 * ProjectionResult. Never throws.
 *
 * A 404 becomes `errorKind: 'empty'` (route not deployed yet in the parallel
 * backend PR) so the caller renders an empty — not error — state.
 * `signal` supports request cancellation (§33 fetch conventions).
 */
async function getJson<T>(
  path: string,
  map: (raw: unknown) => T,
  opts?: { signal?: AbortSignal },
): Promise<ProjectionResult<T>> {
  const token = await freshToken();
  if (!token) {
    return { ok: false, data: null, errorKind: 'auth', message: 'Not authenticated' };
  }
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: opts?.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, data: null, errorKind: 'auth', message: 'Unauthorized' };
    }
    if (res.status === 404) {
      // Route not present (parallel backend PR not deployed) → treat as empty.
      return { ok: false, data: null, errorKind: 'empty', message: 'Not available yet' };
    }
    if (!res.ok) {
      return { ok: false, data: null, errorKind: 'server', message: `HTTP ${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // 200 with a non-JSON / empty body → degrade to empty, don't throw.
      return { ok: false, data: null, errorKind: 'empty', message: 'Empty response' };
    }
    return { ok: true, data: map(body) };
  } catch (err) {
    const kind: ProjectionErrorKind = classifyFetchError(err);
    return { ok: false, data: null, errorKind: kind, message: errMessage(err) };
  }
}

function classifyFetchError(err: unknown): ProjectionErrorKind {
  if (err instanceof Error && err.name === 'AbortError') return 'network';
  const msg = errMessage(err).toLowerCase();
  if (msg.includes('network') || msg.includes('fetch') || msg.includes('timeout')) return 'network';
  return 'unknown';
}
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

// ── Public fetchers (§43) ─────────────────────────────────────────────────────

export interface WorldParams {
  cityId?: string | null;
  lat?: number | null;
  lng?: number | null;
  signal?: AbortSignal;
}

function worldQuery(params: WorldParams): string {
  const qs = new URLSearchParams();
  if (params.cityId) qs.set('cityId', params.cityId);
  if (params.lat != null) qs.set('lat', String(params.lat));
  if (params.lng != null) qs.set('lng', String(params.lng));
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/** GET /media/world — the NOW dashboard projection. */
export function fetchWorld(params: WorldParams = {}): Promise<ProjectionResult<MediaWorldProjection>> {
  return getJson(`/api/media/world${worldQuery(params)}`, (b) => {
    // The server may wrap the payload as { world: {...} } or return it bare.
    const inner = isObj(b) && 'world' in b ? (b as Record<string, unknown>).world : b;
    return mapWorldProjection(inner);
  }, { signal: params.signal });
}

/**
 * GET /media/places/:placeId — Place Current View (§13).
 *
 * The whole body is passed to the mapper: the server payload has a `.place`
 * sub-object for the coarse identity AND a `.perspectives` summary — we must not
 * unwrap to `.place`, which would drop the perspectives. `nowMs` is threaded so
 * the "updated Nm ago" age uses a single clock read.
 */
export function fetchPlaceView(
  placeId: string,
  opts?: { signal?: AbortSignal; nowMs?: number },
): Promise<ProjectionResult<PlaceCurrentView | null>> {
  const nowMs = opts?.nowMs ?? Date.now();
  return getJson(
    `/api/media/places/${encodeURIComponent(placeId)}`,
    (b) => mapPlaceCurrentView(b, nowMs),
    opts,
  );
}

/**
 * GET /media/experiences/:experienceId — a single experience projection (§23).
 *
 * The §43 surface resolves an experience from a canonical Event or Trip id; there
 * is no server-side "list of experiences" endpoint, so the Experiences lens
 * resolves the specific experiences it is handed (deep-link / trip / event
 * context). An unavailable experience maps to null (empty), never an error.
 */
export function fetchExperience(
  experienceId: string,
  opts?: { signal?: AbortSignal },
): Promise<ProjectionResult<MediaExperienceProjection | null>> {
  return getJson(
    `/api/media/experiences/${encodeURIComponent(experienceId)}`,
    (b) => {
      const inner = isObj(b) && 'experience' in b ? (b as Record<string, unknown>).experience : b;
      return mapExperienceProjection(inner);
    },
    opts,
  );
}

/**
 * Resolve a set of experience ids into the projections the viewer may see, in
 * the input order. Each id is fetched via the single-experience endpoint;
 * unavailable / errored ids are simply omitted (degrade-graceful). The combined
 * result is `ok` when at least one id resolved, otherwise it forwards the first
 * error kind so the lens can distinguish empty from a real failure. An empty id
 * list resolves to an empty (ok) list, never a wasted request.
 */
export async function fetchExperiencesByIds(
  ids: string[],
  opts?: { signal?: AbortSignal },
): Promise<ProjectionResult<MediaExperienceProjection[]>> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  if (unique.length === 0) return { ok: true, data: [] };
  const results = await Promise.all(unique.map((id) => fetchExperience(id, opts)));
  const data: MediaExperienceProjection[] = [];
  let firstErr: ProjectionErrorKind | null = null;
  for (const r of results) {
    if (r.ok) {
      if (r.data) data.push(r.data);
    } else if (firstErr === null) {
      firstErr = r.errorKind;
    }
  }
  // Any successful resolution → an ok list (possibly filtered). Only when EVERY
  // id failed at the transport level do we surface the error so the lens can
  // show a retry rather than a misleading "no experiences".
  if (data.length === 0 && firstErr !== null && results.every((r) => !r.ok)) {
    return { ok: false, data: null, errorKind: firstErr, message: 'Could not load experiences' };
  }
  return { ok: true, data };
}

/** GET /media/gems — hidden-gem media (§16). */
export function fetchGems(opts?: {
  cityId?: string | null;
  signal?: AbortSignal;
}): Promise<ProjectionResult<HiddenGemMediaProjection[]>> {
  const qs = opts?.cityId ? `?cityId=${encodeURIComponent(opts.cityId)}` : '';
  return getJson(
    `/api/media/gems${qs}`,
    (b) => {
      const inner = isObj(b) && 'gems' in b ? (b as Record<string, unknown>).gems : b;
      return mapHiddenGemList(inner);
    },
    opts,
  );
}

/** GET /media/people — explicitly social lens grouped by contributor (§27). */
export function fetchPeople(opts?: {
  signal?: AbortSignal;
}): Promise<ProjectionResult<PeopleLensProjection>> {
  // The server returns the projection bare ({ generatedAt, people, … }); the
  // mapper reads `.people`, so no unwrapping is needed.
  return getJson(`/api/media/people`, mapPeopleProjection, opts);
}

/** GET /media/me — owner "My World" library, bucketed (§30). */
export function fetchMyWorld(opts?: {
  signal?: AbortSignal;
}): Promise<ProjectionResult<MyWorldLibrary>> {
  // Bare body ({ generatedAt, buckets }); the mapper reads `.buckets`.
  return getJson(`/api/media/me`, mapMyWorldLibrary, opts);
}

/** GET /media/:mediaId — a single projected media object. */
export function fetchMedia(
  mediaId: string,
  opts?: { signal?: AbortSignal },
): Promise<ProjectionResult<MediaProjection>> {
  return getJson(
    `/api/media/${encodeURIComponent(mediaId)}`,
    (b) => {
      const inner = isObj(b) && 'item' in b ? (b as Record<string, unknown>).item : b;
      return mapMediaProjection(inner);
    },
    opts,
  );
}
