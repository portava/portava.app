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
import type { MediaExperienceProjection, ExperienceState } from '../types/mediaExperience.ts';
import type { HiddenGemMediaProjection, HiddenGemState, GemLocationPrecision } from '../types/hiddenGemMedia.ts';
import type { ConfidenceState } from '../types/media.ts';

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

// ── Pure mappers ──────────────────────────────────────────────────────────────

/** Map a raw media object into a MediaProjection. Always returns a valid object. */
export function mapMediaProjection(raw: unknown): MediaProjection {
  const o = isObj(raw) ? raw : {};
  const contributorRaw = o.contributor;
  const co = isObj(contributorRaw) ? contributorRaw : null;
  const placeRaw = o.place;
  const po = isObj(placeRaw) ? placeRaw : null;
  return {
    id: asString(o.id) ?? '',
    mediaType: o.mediaType === 'video' ? 'video' : 'image',
    thumbnailUrl: asString(o.thumbnailUrl) ?? asString(o.thumbnail_url) ?? null,
    url: asString(o.url),
    width: asNumber(o.width),
    height: asNumber(o.height),
    durationMs: asNumber(o.durationMs),
    capturedAt: asString(o.capturedAt),
    observationClass: oneOf<ObservationClass>(o.observationClass, OBSERVATION_CLASSES, 'observed'),
    freshness: oneOf<FreshnessClass>(o.freshness, FRESHNESS_CLASSES, 'recent'),
    ageMinutes: asNumber(o.ageMinutes),
    perspectiveKey: asString(o.perspectiveKey),
    freshnessLabel: asString(o.freshnessLabel),
    contributor: co
      ? {
          id: asString(co.id) ?? '',
          displayName: asString(co.displayName) ?? asString(co.username) ?? 'Contributor',
          username: asString(co.username),
          avatarUrl: asString(co.avatarUrl),
          verified: asBool(co.verified),
          trustLabel: asString(co.trustLabel),
        }
      : null,
    place: po ? { id: asString(po.id), name: asString(po.name) } : null,
    note: asString(o.note),
    whyThis: asString(o.whyThis) ?? asString(o.compassExplanation),
  };
}

function mapMediaList(raw: unknown): MediaProjection[] {
  return asArray(raw)
    .map(mapMediaProjection)
    .filter((m) => m.id !== '');
}

function mapCity(raw: unknown): MediaCity | null {
  if (!isObj(raw)) return null;
  const name = asString(raw.name);
  if (!name) return null;
  return { id: asString(raw.id), name, timezone: asString(raw.timezone) };
}

export function mapCityVisualZone(raw: unknown): CityVisualZone | null {
  if (!isObj(raw)) return null;
  const name = asString(raw.name);
  const id = asString(raw.id) ?? name;
  if (!name || !id) return null;
  return {
    id,
    name,
    state: oneOf<CityZoneState>(raw.state, ZONE_STATES, 'moderate'),
    trend: oneOf<ActivityTrend>(raw.trend, TRENDS, 'steady'),
    perspectiveCount: asNumber(raw.perspectiveCount),
    freshness: raw.freshness ? oneOf<FreshnessClass>(raw.freshness, FRESHNESS_CLASSES, 'recent') : null,
  };
}

function mapForYouNow(raw: unknown): ForYouNowItem | null {
  if (!isObj(raw)) return null;
  const category = asString(raw.category);
  if (!category) return null;
  return {
    id: asString(raw.id) ?? category,
    category,
    count: asNumber(raw.count) ?? 0,
    kind: oneOf<ForYouNowKind>(raw.kind, FORYOU_KINDS, 'fresh_perspectives'),
    lens: asString(raw.lens) as ForYouNowItem['lens'],
    entityId: asString(raw.entityId),
  };
}

function mapChangingNow(raw: unknown): ChangingNowItem | null {
  if (!isObj(raw)) return null;
  const title = asString(raw.title);
  if (!title) return null;
  return {
    id: asString(raw.id) ?? title,
    title,
    subtitle: asString(raw.subtitle),
    state: oneOf<CityZoneState>(raw.state, ZONE_STATES, 'moderate'),
    trend: oneOf<ActivityTrend>(raw.trend, TRENDS, 'steady'),
    freshness: oneOf<FreshnessClass>(raw.freshness, FRESHNESS_CLASSES, 'recent'),
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

/** Map GET /media/places/:id. */
export function mapPlaceCurrentView(raw: unknown): PlaceCurrentView | null {
  const o = isObj(raw) ? raw : {};
  const placeId = asString(o.placeId) ?? asString(o.id);
  const placeName = asString(o.placeName) ?? asString(o.name);
  if (!placeId || !placeName) return null;
  return {
    placeId,
    placeName,
    stateLabel: asString(o.stateLabel),
    currentPicture: mapCurrentPicture(o.currentPicture),
    groups: asArray(o.groups)
      .map(mapPerspectiveGroup)
      .filter((g): g is PerspectiveGroup => g !== null),
    heroMedia: mapMediaList(o.heroMedia),
    areaName: asString(o.areaName),
  };
}

/** Map one experience projection (§23). */
export function mapExperienceProjection(raw: unknown): MediaExperienceProjection | null {
  if (!isObj(raw)) return null;
  const title = asString(raw.title);
  const id = asString(raw.id);
  if (!title || !id) return null;
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
    currentState: raw.currentState
      ? oneOf<ExperienceState>(raw.currentState, EXPERIENCE_STATES, 'typical')
      : null,
    perspectiveCount: asNumber(raw.perspectiveCount) ?? 0,
    contributorCount: asNumber(raw.contributorCount) ?? 0,
    freshness: oneOf<FreshnessClass>(raw.freshness, FRESHNESS_CLASSES, 'recent'),
    confidence: raw.confidence
      ? oneOf<ConfidenceState>(raw.confidence, CONFIDENCE_STATES, 'low')
      : null,
    heroMedia: mapMediaList(raw.heroMedia),
  };
}

export function mapExperienceList(raw: unknown): MediaExperienceProjection[] {
  return asArray(raw)
    .map(mapExperienceProjection)
    .filter((e): e is MediaExperienceProjection => e !== null);
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

/** GET /media/places/:placeId — Place Current View (§13). */
export function fetchPlaceView(
  placeId: string,
  opts?: { signal?: AbortSignal },
): Promise<ProjectionResult<PlaceCurrentView | null>> {
  return getJson(
    `/api/media/places/${encodeURIComponent(placeId)}`,
    (b) => {
      const inner = isObj(b) && 'place' in b ? (b as Record<string, unknown>).place : b;
      return mapPlaceCurrentView(inner);
    },
    opts,
  );
}

/** GET /media/experiences — experience projections list (§23). */
export function fetchExperiences(opts?: {
  cityId?: string | null;
  signal?: AbortSignal;
}): Promise<ProjectionResult<MediaExperienceProjection[]>> {
  const qs = opts?.cityId ? `?cityId=${encodeURIComponent(opts.cityId)}` : '';
  return getJson(
    `/api/media/experiences${qs}`,
    (b) => {
      const inner = isObj(b) && 'experiences' in b ? (b as Record<string, unknown>).experiences : b;
      return mapExperienceList(inner);
    },
    opts,
  );
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

/** GET /media/people — explicitly social lens (§27). */
export function fetchPeople(opts?: {
  signal?: AbortSignal;
}): Promise<ProjectionResult<MediaProjection[]>> {
  return getJson(
    `/api/media/people`,
    (b) => {
      const inner = isObj(b) && 'items' in b ? (b as Record<string, unknown>).items : b;
      return mapMediaList(inner);
    },
    opts,
  );
}

/** GET /media/me — owner "My World" library (§30). */
export function fetchMyWorld(opts?: {
  signal?: AbortSignal;
}): Promise<ProjectionResult<MediaProjection[]>> {
  return getJson(
    `/api/media/me`,
    (b) => {
      const inner = isObj(b) && 'items' in b ? (b as Record<string, unknown>).items : b;
      return mapMediaList(inner);
    },
    opts,
  );
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
