/**
 * Compass service — all API calls for the Compass personalisation system.
 *
 * Uses the same authedFetch / freshToken pattern as intelligence.ts.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

type AsyncStorageStub = {
  setItem(k: string, v: string): Promise<void>;
  getItem(k: string): Promise<string | null>;
  removeItem(k: string): Promise<void>;
};
const getStorage = (): AsyncStorageStub | null => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Platform } = require('react-native') as { Platform: { OS: string } };
    if (Platform.OS === 'web') return null;
    return require('@react-native-async-storage/async-storage').default as AsyncStorageStub;
  } catch {
    return null;
  }
};

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

let _testAuthToken: string | null = null;
/** For tests only — override the token used by authedFetch. */
export function _setTestAuthToken(t: string | null): void { _testAuthToken = t; }

async function freshToken(): Promise<string | null> {
  if (_testAuthToken !== null) return _testAuthToken;
  return freshApiToken();
}

async function authedFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = await freshToken();
  return fetch(`${apiBase()}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

// A Compass reply normally lands well under this even on a slow multi-tool-call
// turn; this exists purely so a stalled request (upstream hang, dropped
// connection, proxy stall) fails soft with a visible retry instead of leaving
// the "AI BUDDY" bubble spinning forever with no feedback at all.
const COMPASS_ASK_TIMEOUT_MS = 30_000;

/** Rejects with an Error whose message is 'timeout' after `ms` unless `signal` fires first. */
function timeoutSignal(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function notConfigured() {
  return { ok: false as const, error: 'not_configured' };
}

// ── Feed ──────────────────────────────────────────────────────────────────────

export interface CompassFeedSection {
  name: string;
  items: CompassFeedItem[];
  total: number;
}

export interface CompassFeedItem {
  id: string;
  type: string;
  category: string;
  title?: string;
  score?: number;
  recommendationToken?: string;
  explanationKey?: string;
  data?: Record<string, unknown>;
}

export interface CompassFeedResponse {
  sections: CompassFeedSection[];
  nextCursor: string | null;
  fallback: boolean;
  fallbackReason?: string;
  compassEnabled?: boolean;
  safeItems?: CompassFeedItem[];
}

/**
 * The device's real UTC offset in minutes (UTC+8 → 480). JS
 * getTimezoneOffset() is inverted, so negate it. Sent on all time-aware
 * Compass calls so evening styling follows the traveler's clock even when
 * no timezone is saved server-side.
 */
function deviceTzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

export async function fetchCompassFeed(
  params: { city?: string; cursor?: string } = {},
): Promise<{ ok: boolean; data?: CompassFeedResponse; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const qs = new URLSearchParams();
    if (params.city) qs.set('city', params.city);
    if (params.cursor) qs.set('cursor', params.cursor);
    qs.set('tzOffsetMinutes', String(deviceTzOffsetMinutes()));
    const r = await authedFetch(`/api/compass/feed?${qs.toString()}`);
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true, data: await r.json() };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

/**
 * Normalize a raw section API response to the CompassFeedResponse envelope.
 * Handles two historical shapes:
 *  - Old: { section: FeedSection, nextCursor, fallback }  (singular)
 *  - New: { sections: FeedSection[], nextCursor, fallback } (plural, matches full feed)
 * In either case, FeedItem shape is also normalized to flat CompassFeedItem.
 */
function normalizeSectionResponse(raw: any): CompassFeedResponse {
  // Determine the sections array regardless of response shape
  let rawSections: any[] = [];
  if (Array.isArray(raw.sections)) {
    rawSections = raw.sections;
  } else if (raw.section && typeof raw.section === 'object') {
    rawSections = [raw.section];
  }

  // Normalize items from FeedItem (nested .item) → CompassFeedItem (flat)
  const sections: CompassFeedSection[] = rawSections.map((sec: any) => ({
    name:  sec.name ?? '',
    total: sec.total ?? 0,
    items: (sec.items ?? []).map((fi: any): CompassFeedItem => {
      // FeedItem has nested fi.item (CompassItem), flat fields on fi
      const inner = fi.item ?? fi;
      return {
        id:                 String(inner.id ?? fi.id ?? ''),
        type:               String(inner.type ?? fi.type ?? ''),
        category:           String(inner.category ?? fi.category ?? ''),
        title:              inner.title ?? fi.title ?? undefined,
        score:              fi.finalScore ?? undefined,
        recommendationToken: fi.recommendationId ?? fi.recommendationToken ?? undefined,
        explanationKey:     fi.explanationKey ?? undefined,
        data:               inner.data ?? undefined,
      };
    }),
  }));

  return {
    sections,
    nextCursor:    raw.nextCursor ?? null,
    fallback:      raw.fallback ?? false,
    fallbackReason: raw.fallbackReason ?? undefined,
    compassEnabled: raw.compassEnabled ?? !raw.fallback,
    safeItems:     (raw.safeItems ?? []).map((fi: any): CompassFeedItem => {
      const inner = fi.item ?? fi;
      return {
        id:       String(inner.id ?? fi.id ?? ''),
        type:     String(inner.type ?? fi.type ?? ''),
        category: String(inner.category ?? fi.category ?? ''),
        title:    inner.title ?? fi.title ?? undefined,
        data:     inner.data ?? undefined,
        recommendationToken: fi.recommendationId ?? fi.recommendationToken ?? undefined,
        explanationKey:      fi.explanationKey ?? undefined,
      };
    }),
  };
}

// A section fetch normally resolves quickly even for a cold/uncached city;
// this bounds a stalled request (e.g. a slow live lookup for a low-confidence
// city) so the caller's loading state always clears instead of leaving a
// skeleton spinning forever with no feedback.
const COMPASS_SECTION_TIMEOUT_MS = 15_000;

export async function fetchCompassSection(
  section: string,
  params: { city?: string; cursor?: string } = {},
): Promise<{ ok: boolean; data?: CompassFeedResponse; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  const { signal, cancel } = timeoutSignal(COMPASS_SECTION_TIMEOUT_MS);
  try {
    const qs = new URLSearchParams();
    if (params.city) qs.set('city', params.city);
    if (params.cursor) qs.set('cursor', params.cursor);
    qs.set('tzOffsetMinutes', String(deviceTzOffsetMinutes()));
    const r = await authedFetch(`/api/compass/feed/section/${encodeURIComponent(section)}?${qs.toString()}`, { signal });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true, data: normalizeSectionResponse(await r.json()) };
  } catch (err) {
    return { ok: false, error: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    cancel();
  }
}

// ── Why ───────────────────────────────────────────────────────────────────────

export interface CompassWhyFactor {
  key:     string;
  label:   string;
  weight:  number;
  detail?: string;
}

export async function fetchCompassWhy(
  recommendationId: string,
): Promise<{
  ok: boolean;
  explanation?: string;
  factors?: CompassWhyFactor[];
  compassMatch?: number | null;
  communityScore?: number | null;
  error?: string;
}> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch(`/api/compass/why/${encodeURIComponent(recommendationId)}`);
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    return {
      ok: true,
      explanation:    body.explanation ?? 'Based on your travel preferences.',
      factors:        Array.isArray(body.factors) ? body.factors : [],
      compassMatch:   typeof body.compassMatch   === 'number' ? body.compassMatch   : null,
      communityScore: typeof body.communityScore === 'number' ? body.communityScore : null,
    };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

// ── Feedback ──────────────────────────────────────────────────────────────────

export type CompassFeedbackAction =
  | 'show_more'
  | 'show_less'
  | 'not_interested'
  | 'hide_category'
  | 'hide_user'
  | 'mute_topic'
  | 'report'
  | 'block'
  | 'too_expensive'
  | 'not_my_vibe'
  | 'save'
  // Phase 5 — feedback loop actions
  | 'not_now'
  | 'hide_this'
  | 'wrong_city'
  | 'already_went'
  | 'not_safe';

export async function postCompassFeedback(body: {
  recommendationId: string;
  action: CompassFeedbackAction;
  itemType: string;
  category?: string;
  hashtag?: string;
  topic?: string;
  targetUserId?: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch('/api/compass/feedback', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

// ── Outcomes ──────────────────────────────────────────────────────────────────

/** One-shot dedupe: recommendationIds already reported as viewed this session. */
const reportedViewedIds = new Set<string>();

/** For tests only — clear the one-shot viewed dedupe set. */
export function _resetReportedOutcomes(): void { reportedViewedIds.clear(); }

/**
 * Fire-and-forget "viewed" outcome report for a recommendation the user
 * actually opened (not merely scrolled past). One-shot per recommendationId
 * per session; the server additionally dedupes per user+recommendation+stage.
 * Never blocks the UI and never throws — failures are silent.
 */
export function reportCompassViewed(
  recommendationId: string | null | undefined,
  itemId?: string | null,
): void {
  const key = recommendationId ?? (itemId ? `item:${itemId}` : null);
  if (!key) return;
  if (!isSupabaseConfigured || !apiBase()) return;
  if (reportedViewedIds.has(key)) return;
  reportedViewedIds.add(key);
  void authedFetch('/api/compass/outcomes', {
    method: 'POST',
    body: JSON.stringify(
      recommendationId
        ? { recommendationId, stage: 'viewed' }
        : { itemId, stage: 'viewed' },
    ),
  }).catch(() => { /* silent — outcome reporting must never surface errors */ });
}

// ── Preferences ───────────────────────────────────────────────────────────────

export interface CompassPreferences {
  user_id?: string;
  interests?: string[];
  travel_styles?: string[];
  preferred_languages?: string[];
  hidden_categories?: string[];
  muted_hashtags?: string[];
  exclude_budget_styles?: string[];
  category_weights?: Record<string, number>;
  notification_preferences?: Record<string, boolean>;
  boost_visibility_enabled?: boolean;
  location_privacy_mode?: string;
  delayed_post_default?: boolean;
  visibility_sub_controls?: Record<string, boolean>;
  safety_preference?: string;
  rent_buddy_discoverable?: boolean;
}

// ── City confidence ───────────────────────────────────────────────────────────

export interface CityConfidence {
  city: string;
  depthScore: number;
  tier: 'deep' | 'moderate' | 'thin';
  note: string | null;
  computedAt: string | null;
}

// Short-lived in-memory cache, keyed by normalized city. Confidence only
// changes on graph rebuilds, so repeat Discovery visits within the TTL can
// skip the network round-trip (same pattern as the discovery counts cache).
const _cityConfidenceCache = new Map<string, { data: CityConfidence; at: number }>();
const CITY_CONFIDENCE_TTL_MS = 10 * 60 * 1_000; // 10 minutes

// L2 — AsyncStorage persistence (native only; getStorage() returns null on web).
// Entries older than the hard cap are dropped; entries past the soft TTL are
// served immediately (instant badge paint on relaunch) while a background
// network refresh updates both cache layers (stale-while-revalidate).
export const CITY_CONFIDENCE_STORAGE_KEY = 'city_confidence_cache_v1';
const CITY_CONFIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000; // 24 hours hard cap

type CityConfidenceBlob = Record<string, { data: CityConfidence; at: number }>;

async function readCityConfidenceBlob(storage: AsyncStorageStub): Promise<CityConfidenceBlob> {
  try {
    const raw = await storage.getItem(CITY_CONFIDENCE_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as CityConfidenceBlob;
  } catch {
    return {};
  }
}

function persistCityConfidence(cacheKey: string, data: CityConfidence, at: number): void {
  const storage = getStorage();
  if (!storage) return;
  void (async () => {
    try {
      const blob = await readCityConfidenceBlob(storage);
      const now = Date.now();
      // Prune hard-expired entries so the blob doesn't grow indefinitely.
      for (const [k, v] of Object.entries(blob)) {
        if (!v || now - v.at > CITY_CONFIDENCE_MAX_AGE_MS) delete blob[k];
      }
      blob[cacheKey] = { data, at };
      await storage.setItem(CITY_CONFIDENCE_STORAGE_KEY, JSON.stringify(blob));
    } catch {
      // Fire-and-forget — storage failures must never break the badge.
    }
  })();
}

/** For tests only — clear the city-confidence cache (memory + storage). */
export function _clearCityConfidenceCache(): void {
  _cityConfidenceCache.clear();
  const storage = getStorage();
  if (storage) void storage.removeItem(CITY_CONFIDENCE_STORAGE_KEY).catch(() => {});
}

async function fetchCityConfidenceFromNetwork(
  city: string,
  cacheKey: string,
): Promise<{ ok: boolean; data?: CityConfidence; error?: string }> {
  try {
    const r = await authedFetch(`/api/compass/city-confidence?city=${encodeURIComponent(city.trim())}`);
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    const data = body as CityConfidence;
    const at = Date.now();
    _cityConfidenceCache.set(cacheKey, { data, at });
    persistCityConfidence(cacheKey, data, at);
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export async function fetchCityConfidence(
  city: string,
): Promise<{ ok: boolean; data?: CityConfidence; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  if (!city.trim()) return { ok: false, error: 'no_city' };
  const cacheKey = city.trim().toLowerCase();
  const cached = _cityConfidenceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CITY_CONFIDENCE_TTL_MS) {
    return { ok: true, data: cached.data };
  }

  // L2 — check persisted cache (native only) before paying the round-trip.
  const storage = getStorage();
  if (storage && !cached) {
    const blob = await readCityConfidenceBlob(storage);
    const entry = blob[cacheKey];
    if (entry && Date.now() - entry.at <= CITY_CONFIDENCE_MAX_AGE_MS) {
      _cityConfidenceCache.set(cacheKey, entry);
      if (Date.now() - entry.at < CITY_CONFIDENCE_TTL_MS) {
        return { ok: true, data: entry.data };
      }
      // Stale-while-revalidate: paint instantly, refresh in the background.
      void fetchCityConfidenceFromNetwork(city, cacheKey).catch(() => {});
      return { ok: true, data: entry.data };
    }
  }

  return fetchCityConfidenceFromNetwork(city, cacheKey);
}

export async function fetchCompassPreferences(): Promise<{ ok: boolean; data?: CompassPreferences; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch('/api/compass/me/preferences');
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    return { ok: true, data: body.preferences };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export async function patchCompassPreferences(
  patch: Partial<CompassPreferences>,
): Promise<{ ok: boolean; data?: CompassPreferences; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch('/api/compass/me/preferences', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    return { ok: true, data: body.preferences };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

// ── Active reward ─────────────────────────────────────────────────────────────

export interface CompassActiveReward {
  tier: string;
  tierLabel: string;
  badges: string[];
  visibilityMessage: string;
  boostEnabled: boolean;
}

export async function fetchCompassActiveReward(): Promise<{ ok: boolean; data?: CompassActiveReward; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch('/api/compass/me/active-reward');
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true, data: await r.json() };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

// ── Frontload ─────────────────────────────────────────────────────────────────

export interface CompassFrontloadData {
  compassEnabled: boolean;
  tier0: Record<string, unknown>;
  preloadedAt: number;
}

export async function fetchCompassFrontload(params: {
  city?: string | null;
  interests?: string[];
} = {}): Promise<{ ok: boolean; data?: CompassFrontloadData; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const qs = new URLSearchParams();
    if (params.city) qs.set('city', params.city);
    if (params.interests?.length) qs.set('interests', params.interests.join(','));
    const r = await authedFetch(`/api/compass/frontload?${qs.toString()}`);
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    return { ok: true, data: { ...body, preloadedAt: Date.now() } };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export async function postCompassFrontloadEvent(event: {
  eventType: string;
  screen?: string;
  city?: string;
  itemId?: string;
}): Promise<void> {
  if (!isSupabaseConfigured || !apiBase()) return;
  try {
    // Server schema uses snake_case: event_type, screen, city.
    const body = {
      event_type: event.eventType,
      screen:     event.screen,
      city:       event.city,
    };
    await authedFetch('/api/compass/frontload/event', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch {
    // fire-and-forget
  }
}

// ── Boost visibility ──────────────────────────────────────────────────────────

export async function putCompassBoostVisibility(
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch('/api/compass/me/boost-visibility', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

// ── AI Buddy (ask) — Phase 1 ─────────────────────────────────────────────────

export interface CompassQuickAction {
  label:       string;
  actionType:  string;
  params?:     Record<string, unknown>;
}

export interface CompassAskPayload {
  type:         'recommendation' | 'itinerary';
  picks?:       Array<{ title: string; category?: string; why?: string; priceLevel?: string }>;
  primaryPick?: number;
  destination?: string;
  days?:        Array<{ label: string; highlights: string[] }>;
}

// ── Phase 5: dynamic UI blocks — server-validated, hydrated from tool results ──

/** Phase 8 — confidence source class carried end-to-end (API → UI). */
export type CompassSourceClass =
  | 'verified_live'
  | 'community_reported'
  | 'historical'
  | 'ai_inference';

export interface CompassUiConfidence {
  sourceClass: CompassSourceClass;
  label:       string;
  checkedAt?:  string;
  dataNote?:   string;
}

export interface CompassUiPlace {
  id:           string;
  name:         string;
  category:     string | null;
  city:         string | null;
  neighborhood: string | null;
  rating:       number | null;
  blurb:        string | null;
  verified:     boolean;
  lat:          number | null;
  lng:          number | null;
  /** Phase 8 — data confidence label; absent on older server payloads. */
  confidence?:  CompassUiConfidence | null;
  /** Phase 8 — live open-now status; null/absent when not verifiable. */
  openNow?:     boolean | null;
  /** Signed recommendation token for outcome attribution; absent on older payloads. */
  recommendationToken?: string;
  /** Optional hero photo URL — rendered when present, emoji fallback when absent. */
  headerImageUrl?: string | null;
  /**
   * How the hero image was sourced. Used by the client resolver to set the
   * correct priority and flag AI representations for disclosure.
   */
  headerImageSource?: 'ai_generated' | 'provider' | 'user_upload' | 'official' | 'portava_media' | null;
}

export interface CompassUiEvent {
  id:          string;
  title:       string;
  city:        string | null;
  country:     string | null;
  startsAt:    string | null;
  category:    string | null;
  description: string | null;
  /** Phase 8 — data confidence label; absent on older server payloads. */
  confidence?: CompassUiConfidence | null;
  /** Venue coordinates — hydrated server-side; absent on older payloads. */
  lat?:        number | null;
  lng?:        number | null;
  /** Signed recommendation token for outcome attribution; absent on older payloads. */
  recommendationToken?: string;
}

export interface CompassUiPerson {
  handle:     string;
  circleName: string | null;
}

export interface CompassComparisonRow {
  kind:   'place' | 'event';
  id:     string;
  label:  string;
  values: string[];
  place?: CompassUiPlace;
  event?: CompassUiEvent;
}

export type CompassUiBlock =
  | { type: 'place_cards'; places: CompassUiPlace[] }
  | { type: 'event_cards'; events: CompassUiEvent[] }
  | { type: 'person_cards'; people: CompassUiPerson[] }
  | { type: 'map'; places: CompassUiPlace[] }
  | { type: 'comparison'; columns: string[]; rows: CompassComparisonRow[] };

/** Phase-4 add_to_trip pending proposal — awaiting explicit user confirmation. */
export interface CompassPendingProposal {
  proposalId: string;
  tripId:     string;
  tripTitle:  string | null;
  placeId:    string | null;
  title:      string;
  category:   string;
  dayDate:    string | null;
  status:     'pending_confirmation';
}

/** Phase-1 response shape from POST /api/compass/ask. */
export interface CompassAskResponse {
  conversationId:  string | null;
  message:         string;
  payload:         CompassAskPayload | null;
  quickActions:    CompassQuickAction[];
  /** Phase 4: add_to_trip proposals awaiting confirm/decline. */
  pendingProposals?: CompassPendingProposal[];
  /** Phase 5: server-validated UI blocks — every entity is real tool data. */
  uiBlocks?:       CompassUiBlock[];
  promptVersion:   string;
  intent?:         { intent: string; confidence: number };
  fallback?:       boolean;
  fallbackReason?: string;
}

/**
 * @deprecated Legacy shape — kept for types that reference it.
 * New code should use CompassAskResponse.
 */
export type CompassAskRecommendation = CompassAskResponse;

export async function postCompassAsk(
  prompt:  string,
  opts: {
    city?:            string;
    conversationId?:  string;
    /** @deprecated ignored when conversationId is present */
    conversationContext?: string;
    stream?:          boolean;
  } = {},
): Promise<{ ok: boolean; data?: CompassAskResponse; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  const { signal, cancel } = timeoutSignal(COMPASS_ASK_TIMEOUT_MS);
  try {
    const r = await authedFetch('/api/compass/ask', {
      method: 'POST',
      body:   JSON.stringify({ prompt, ...opts, tzOffsetMinutes: deviceTzOffsetMinutes() }),
      signal,
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true, data: await r.json() };
  } catch {
    if (signal.aborted) return { ok: false, error: 'timeout' };
    return { ok: false, error: 'network_error' };
  } finally {
    cancel();
  }
}

// ── Streaming ask (SSE) ───────────────────────────────────────────────────────
// The server streams the raw model output (a JSON envelope) as `delta` events,
// then a `done` event with the parsed/validated fields (conversationId, payload,
// quickActions, pendingProposals, uiBlocks…). The final message text is NOT on
// the done event — the client reconstructs it from the accumulated raw stream.

/**
 * Extract the value of the envelope's "message" field from a PARTIAL raw model
 * stream, decoding JSON string escapes as far as the stream has progressed.
 * Returns '' until the message field starts. If the stream doesn't look like a
 * JSON envelope, the raw text is shown as-is (matches server fallback parse).
 * Exported for tests.
 */
export function extractPartialCompassMessage(raw: string): string {
  const cleaned = raw.replace(/^\s*```(?:json)?\n?/, '');
  const trimmed = cleaned.trimStart();
  if (!trimmed.startsWith('{')) {
    // Plain-text answer — strip a trailing fence if one has arrived.
    return cleaned.replace(/\n?```\s*$/, '');
  }
  const key = trimmed.indexOf('"message"');
  if (key === -1) return '';
  let i = trimmed.indexOf(':', key + 9);
  if (i === -1) return '';
  i = trimmed.indexOf('"', i + 1);
  if (i === -1) return '';
  let out = '';
  for (let j = i + 1; j < trimmed.length; j++) {
    const ch = trimmed[j]!;
    if (ch === '\\') {
      const next = trimmed[j + 1];
      if (next === undefined) break; // dangling escape mid-stream
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else if (next === 'u') {
        const hex = trimmed.slice(j + 2, j + 6);
        if (hex.length < 4) break; // incomplete \uXXXX mid-stream
        const code = parseInt(hex, 16);
        if (!Number.isNaN(code)) out += String.fromCharCode(code);
        j += 4;
      } else out += next;
      j++;
      continue;
    }
    if (ch === '"') break; // message string closed
    out += ch;
  }
  return out;
}

/**
 * Finalize the assistant message from the complete raw model output — same
 * logic as the server's envelope parse (strip fences, JSON.parse, take
 * .message, else the raw text). Exported for tests.
 */
export function finalizeCompassMessage(raw: string): string {
  const cleaned = raw.trim().replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '');
  try {
    const p = JSON.parse(cleaned);
    if (p && typeof p.message === 'string') return p.message.slice(0, 2000);
  } catch { /* not JSON — plain message */ }
  return raw.slice(0, 2000);
}

/**
 * Split an SSE text buffer into complete parsed `data:` events plus the
 * unterminated remainder to carry into the next chunk. Exported for tests.
 */
export function splitCompassSseBuffer(buffer: string): { events: Array<Record<string, unknown>>; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    for (const line of part.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const parsed = JSON.parse(line.slice(5).trim());
        if (parsed && typeof parsed === 'object') events.push(parsed);
      } catch { /* skip malformed event */ }
    }
  }
  return { events, rest };
}

/** Streaming-capable fetch: expo/fetch on native (RN's global fetch has no
 *  response.body streams); the global fetch on web/tests. */
function getStreamFetch(): typeof fetch | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('expo/fetch') as { fetch?: typeof fetch };
    if (typeof mod?.fetch === 'function') return mod.fetch;
  } catch { /* expo/fetch unavailable (web bundles, node tests) */ }
  return typeof fetch === 'function' ? fetch : null;
}

let _testStreamFetch: typeof fetch | null | undefined;
/** For tests only — override the streaming fetch implementation. */
export function _setTestStreamFetch(f: typeof fetch | null | undefined): void { _testStreamFetch = f; }

export interface CompassAskStreamHandlers {
  /** Called with the progressively decoded assistant message (already stripped
   *  of the JSON envelope scaffolding) each time new delta text arrives. */
  onDelta?: (messageSoFar: string) => void;
}

/**
 * Streaming variant of postCompassAsk. Consumes the SSE delta events for a
 * progressive-typing UI and finalizes message/quickActions/pendingProposals/
 * uiBlocks from the done event. On any streaming failure (transport error,
 * unsupported streams, missing done event, or a server error event) it falls
 * back to the plain non-streaming postCompassAsk — callers always get the
 * same result envelope. `streamed` reports whether deltas were live.
 */
export async function postCompassAskStream(
  prompt: string,
  opts: { city?: string; conversationId?: string } = {},
  handlers: CompassAskStreamHandlers = {},
): Promise<{ ok: boolean; data?: CompassAskResponse; error?: string; streamed?: boolean }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  const { signal, cancel } = timeoutSignal(COMPASS_ASK_TIMEOUT_MS);
  try {
    const doFetch = _testStreamFetch !== undefined ? _testStreamFetch : getStreamFetch();
    if (!doFetch) throw new Error('stream_unsupported');
    const token = await freshToken();
    const r = await doFetch(`${apiBase()}/api/compass/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ prompt, ...opts, stream: true, tzOffsetMinutes: deviceTzOffsetMinutes() }),
      signal,
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}`, streamed: false };
    const body: any = (r as any).body;
    if (!body || typeof body.getReader !== 'function') throw new Error('stream_unsupported');

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let raw = '';
    let doneEvent: Record<string, unknown> | null = null;
    let serverError = false;
    for (;;) {
      // Belt-and-braces alongside the fetch `signal`: some fetch polyfills
      // (notably expo/fetch) don't reliably unblock a pending reader.read()
      // when the request signal aborts, which is exactly the "spins forever
      // with no error" failure mode this timeout exists to prevent.
      if (signal.aborted) throw new Error('timeout');
      const { value, done: eof } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (eof) buffer += '\n\n'; // flush a final unterminated event, if any
      const { events, rest } = splitCompassSseBuffer(buffer);
      buffer = rest;
      for (const ev of events) {
        if (typeof ev['delta'] === 'string') {
          raw += ev['delta'] as string;
          if (handlers.onDelta) {
            const partial = extractPartialCompassMessage(raw);
            if (partial) handlers.onDelta(partial);
          }
        } else if (ev['done']) {
          doneEvent = ev;
        } else if (ev['error']) {
          serverError = true;
        }
      }
      if (eof) break;
    }
    if (serverError || !doneEvent) throw new Error('stream_incomplete');

    const data: CompassAskResponse = {
      conversationId:   (doneEvent['conversationId'] as string | null | undefined) ?? null,
      message:          finalizeCompassMessage(raw),
      payload:          (doneEvent['payload'] as CompassAskPayload | null | undefined) ?? null,
      quickActions:     Array.isArray(doneEvent['quickActions']) ? doneEvent['quickActions'] as CompassQuickAction[] : [],
      pendingProposals: Array.isArray(doneEvent['pendingProposals']) ? doneEvent['pendingProposals'] as CompassPendingProposal[] : [],
      uiBlocks:         Array.isArray(doneEvent['uiBlocks']) ? doneEvent['uiBlocks'] as CompassUiBlock[] : [],
      promptVersion:    typeof doneEvent['promptVersion'] === 'string' ? doneEvent['promptVersion'] as string : '',
      intent:           (doneEvent['intent'] as CompassAskResponse['intent']) ?? undefined,
    };
    return { ok: true, data, streamed: true };
  } catch (err) {
    // A genuine timeout means the whole request is stuck — don't retry via
    // the non-streaming fallback, which would just wait the full timeout
    // again. Surface it immediately so the UI can fail soft with a retry.
    if (signal.aborted || (err instanceof Error && err.message === 'timeout')) {
      return { ok: false, error: 'timeout', streamed: false };
    }
    // Non-streaming fallback — same request minus stream:true.
    const fallback = await postCompassAsk(prompt, opts);
    return { ...fallback, streamed: false };
  } finally {
    cancel();
  }
}

/** Confirm a pending add_to_trip proposal — this is the ONLY path that executes the write. */
export async function confirmCompassProposal(
  proposalId: string,
  conversationId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch(`/api/compass/proposals/${encodeURIComponent(proposalId)}/confirm`, {
      method: 'POST',
      body:   JSON.stringify({ conversationId }),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

/** Decline a pending add_to_trip proposal. */
export async function declineCompassProposal(
  proposalId: string,
  conversationId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch(`/api/compass/proposals/${encodeURIComponent(proposalId)}/decline`, {
      method: 'POST',
      body:   JSON.stringify({ conversationId }),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

// ── Compass recommendations ───────────────────────────────────────────────────

export interface CompassRecommendation {
  id:       string;
  type:     string;
  category: string;
  title?:   string;
  reason?:  string;
  city?:    string;
  data?:    Record<string, unknown>;
}

export interface CompassRecommendationsResponse {
  recommendations: CompassRecommendation[];
  surface: string;
}

export async function fetchCompassRecommendations(params: {
  surface?:   string;
  q?:         string;
  city?:      string;
  limit?:     number;
  startDate?: string;
  endDate?:   string;
  tripId?:    string;
} = {}): Promise<{ ok: boolean; data?: CompassRecommendationsResponse; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const qs = new URLSearchParams();
    if (params.surface)   qs.set('surface', params.surface);
    if (params.q)         qs.set('q', params.q);
    if (params.city)      qs.set('city', params.city);
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.startDate) qs.set('startDate', params.startDate);
    if (params.endDate)   qs.set('endDate', params.endDate);
    if (params.tripId)    qs.set('tripId', params.tripId);
    qs.set('tzOffsetMinutes', String(deviceTzOffsetMinutes()));
    const r = await authedFetch(`/api/compass/recommendations?${qs.toString()}`);
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true, data: await r.json() };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

// ── Trip brief (surface=trip shorthand) ───────────────────────────────────────

export async function fetchCompassTripBrief(params: {
  tripId:     string;
  city?:      string;
  startDate?: string;
  endDate?:   string;
  limit?:     number;
}): Promise<{ ok: boolean; data?: CompassRecommendationsResponse; error?: string }> {
  return fetchCompassRecommendations({
    surface:   'trip',
    city:      params.city,
    startDate: params.startDate,
    endDate:   params.endDate,
    limit:     params.limit ?? 6,
    tripId:    params.tripId,
  });
}

// ── Create suggestions ────────────────────────────────────────────────────────

export interface CompassCreateSuggestion {
  category: string;
  vibe:     string;
  reason:   string;
}

export async function postCompassCreateSuggestions(params: {
  type: 'event';
  titleDraft: string;
}): Promise<{ ok: boolean; suggestions?: CompassCreateSuggestion[]; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch('/api/compass/create-suggestions', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const data = await r.json();
    return { ok: true, suggestions: data.suggestions ?? [] };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

// ── Compass context (city switcher) ───────────────────────────────────────────

export async function postCompassContext(params: {
  city?: string;
  country?: string;
  contextState?: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const body: Record<string, string> = {};
    if (params.city)         body['city']          = params.city;
    if (params.country)      body['country']        = params.country;
    if (params.contextState) body['context_state']  = params.contextState;
    const r = await authedFetch('/api/compass/context', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

// ── Compass settings ─────────────────────────────────────────────────────────

export interface CompassSettings {
  use_location?: boolean;
  use_chosen_city?: boolean;
  use_trip_data?: boolean;
  use_saved_items?: boolean;
  use_history?: boolean;
  show_buddy_recommendations?: boolean;
  show_people_recommendations?: boolean;
  allow_smart_notifications?: boolean;
  onboarding_completed?: boolean;
  onboarding_completed_at?: string;
  updated_at?: string;
}

// ── Compass Sense (Phase 11) ─────────────────────────────────────────────────

export type CompassSensePresence = 'passive' | 'aware' | 'active';

export interface CompassSenseSettings {
  presenceLevel: CompassSensePresence;
  categories: Record<string, boolean>;
}

export interface CompassSenseSettingsResult {
  ok: boolean;
  data?: CompassSenseSettings;
  compassEnabled?: boolean;
  error?: string;
}

export async function fetchCompassSenseSettings(): Promise<CompassSenseSettingsResult> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch('/api/compass/sense/settings');
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    if (body.compassEnabled === false) return { ok: true, compassEnabled: false };
    return { ok: true, compassEnabled: true, data: body.settings };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export async function putCompassSenseSettings(
  patch: { presenceLevel?: CompassSensePresence; categories?: Record<string, boolean> },
): Promise<CompassSenseSettingsResult> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch('/api/compass/sense/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    if (body.compassEnabled === false) return { ok: true, compassEnabled: false };
    return { ok: true, compassEnabled: true, data: body.settings };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

// ── Compass Live (Phase 12) ──────────────────────────────────────────────────

export interface CompassLivePlanItem {
  id: string;
  title: string;
  startsAt: string | null;
}

export interface CompassLiveSessionEvent {
  at: string;
  kind: string;
  detail: string;
}

export interface CompassLiveContext {
  city: string | null;
  tripId: string | null;
  currentStop: CompassLivePlanItem | null;
  nextItem: CompassLivePlanItem | null;
  minutesToNext: number | null;
  recentEvents: CompassLiveSessionEvent[];
  updatedAt: string;
}

export interface CompassLiveSession {
  id: string;
  status: 'active' | 'ended';
  context: CompassLiveContext;
  checksRun: number;
  nudgesDelivered: number;
  startedAt: string;
}

export interface CompassLiveNudge {
  type: string;
  title: string;
  body: string;
  actionUrl: string;
}

export interface CompassLiveSummary {
  durationMinutes: number;
  checksRun: number;
  nudgesDelivered: number;
  eventsRecorded: number;
  stopsReached: number;
  city: string | null;
}

export interface CompassLiveResult {
  ok: boolean;
  compassEnabled?: boolean;
  active?: boolean;
  session?: CompassLiveSession | null;
  delivered?: CompassLiveNudge[];
  summary?: CompassLiveSummary | null;
  error?: string;
}

async function liveCall(path: string, method: 'GET' | 'POST'): Promise<CompassLiveResult> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch(path, method === 'POST' ? { method } : undefined);
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    if (body.compassEnabled === false) return { ok: true, compassEnabled: false };
    return {
      ok: true,
      compassEnabled: true,
      active: Boolean(body.active),
      session: body.session ?? null,
      delivered: body.delivered ?? [],
      summary: body.summary ?? null,
    };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export function fetchCompassLiveSession(): Promise<CompassLiveResult> {
  return liveCall('/api/compass/live/session', 'GET');
}
export function startCompassLive(): Promise<CompassLiveResult> {
  return liveCall('/api/compass/live/start', 'POST');
}
export function stopCompassLive(): Promise<CompassLiveResult> {
  return liveCall('/api/compass/live/stop', 'POST');
}
export function checkCompassLive(): Promise<CompassLiveResult> {
  return liveCall('/api/compass/live/check', 'POST');
}

// ── Trip Autopilot / Heartbeat (Phase 13) ────────────────────────────────────

export interface TripHeartbeatIssue {
  type: string;
  severity: 'watch' | 'attention' | 'high';
  itemIds: string[];
  reason: string;
}

export interface TripHeartbeatRisk {
  type: string;
  label: string;
  detail: string;
}

export interface TripHeartbeat {
  status: 'healthy' | 'attention' | 'at_risk';
  issues: TripHeartbeatIssue[];
  risks: TripHeartbeatRisk[];
  pendingProposals: number;
  itemCounts: { fixed: number; flexible: number; optional: number; total: number };
  nextItem: { id: string; title: string; startsAt: string | null; dayDate: string | null } | null;
}

export interface AutopilotProposalChange {
  itemId: string;
  title: string;
  lockType: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface AutopilotProposal {
  id: string;
  issueType: string;
  severity: string;
  reason: string;
  changes: AutopilotProposalChange[];
  status: 'pending' | 'confirmed' | 'declined' | 'expired';
  createdAt: string;
  resolvedAt: string | null;
}

export interface TripHeartbeatResult {
  ok: boolean;
  compassEnabled?: boolean;
  heartbeat?: TripHeartbeat;
  error?: string;
}

export async function fetchTripHeartbeat(tripId: string): Promise<TripHeartbeatResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const r = await authedFetch(`/api/trips/${tripId}/heartbeat`);
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    if (body.compassEnabled === false) return { ok: true, compassEnabled: false };
    return { ok: true, compassEnabled: true, heartbeat: body.heartbeat };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export async function runTripAutopilotCheck(tripId: string): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const r = await authedFetch(`/api/trips/${tripId}/autopilot/check`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return r.ok ? { ok: true } : { ok: false, error: `http_${r.status}` };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export async function fetchAutopilotProposals(
  tripId: string,
): Promise<{ ok: boolean; proposals?: AutopilotProposal[]; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const r = await authedFetch(`/api/trips/${tripId}/autopilot/proposals`);
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    return { ok: true, proposals: body.proposals ?? [] };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export async function resolveAutopilotProposal(
  proposalId: string,
  action: 'confirm' | 'decline',
): Promise<{ ok: boolean; applied?: number; blocked?: string[]; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const r = await authedFetch(`/api/autopilot/proposals/${proposalId}/${action}`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    return { ok: true, applied: body.applied, blocked: body.blocked };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export interface AutopilotSettings {
  enabled: boolean;
  allowMoveFlexible: boolean;
  allowMoveOptional: boolean;
  allowRemoveOptional: boolean;
}

export interface AutopilotSettingsResult {
  ok: boolean;
  compassEnabled?: boolean;
  settings?: AutopilotSettings;
  error?: string;
}

export async function fetchAutopilotSettings(tripId: string): Promise<AutopilotSettingsResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const r = await authedFetch(`/api/trips/${tripId}/autopilot/settings`);
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    if (body.compassEnabled === false) return { ok: true, compassEnabled: false };
    return { ok: true, compassEnabled: true, settings: body.settings };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export async function putAutopilotSettings(
  tripId: string,
  patch: Partial<AutopilotSettings>,
): Promise<AutopilotSettingsResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const r = await authedFetch(`/api/trips/${tripId}/autopilot/settings`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    if (body.compassEnabled === false) return { ok: true, compassEnabled: false };
    return { ok: true, compassEnabled: true, settings: body.settings };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export interface CompassSettingsResult {
  ok: boolean;
  data?: CompassSettings;
  error?: string;
}

export async function fetchCompassSettings(): Promise<CompassSettingsResult> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch('/api/compass/settings');
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    return { ok: true, data: body.settings ?? {} };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export async function patchCompassSettings(
  patch: Partial<CompassSettings>,
): Promise<CompassSettingsResult> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch('/api/compass/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    return { ok: true, data: body.settings ?? {} };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export async function deleteCompassContext(): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch('/api/compass/context', { method: 'DELETE' });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

/** Semantic version of the Compass ranking engine used in analytics events. */
export const COMPASS_ENGINE_VERSION = '1.0';

// ── Analytics ─────────────────────────────────────────────────────────────────

export type CompassAnalyticsEventName =
  | 'compass_card_viewed'
  | 'compass_card_tapped'
  | 'compass_feedback_submitted'
  | 'compass_settings_changed'
  | 'compass_onboarding_completed'
  | 'compass_onboarding_skipped';

export interface CompassAnalyticsEvent {
  event_name: CompassAnalyticsEventName;
  compass_engine_version?: string;
  item_id?: string;
  item_type?: string;
  section_name?: string;
  city?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Fire-and-forget analytics event write.
 * Never throws. No private fields or coordinates.
 */
export async function postCompassAnalyticsEvent(
  event: CompassAnalyticsEvent,
): Promise<void> {
  if (!isSupabaseConfigured || !apiBase()) return;
  try {
    await authedFetch('/api/compass/analytics', {
      method: 'POST',
      body: JSON.stringify(event),
    });
  } catch {
    // fire-and-forget
  }
}

// ── Buddy matches ─────────────────────────────────────────────────────────────

export interface CompassBuddyData {
  userId: string;
  verified: boolean;
  averageRating: number | null;
  reviewCount: number;
  languages: string[];
  categories: string[];
  coverPhotoUrl: string | null;
  hourlyRateUsd: number | null;
  availabilityStatus: 'available_today' | 'available_this_week' | 'not_available';
  reasonCode: string;
}

export interface CompassBuddyResult {
  id: string;
  type: 'buddy';
  category: string;
  title: string | null;
  reason: string;
  city: string | null;
  data: CompassBuddyData;
}

export interface CompassBuddyMatchesResult {
  ok: boolean;
  data?: CompassBuddyResult[];
  disabled?: boolean;
  error?: string;
}

export async function fetchCompassBuddyMatches(params: {
  city?: string | null;
  limit?: number;
} = {}): Promise<CompassBuddyMatchesResult> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured() as CompassBuddyMatchesResult;
  try {
    const qs = new URLSearchParams({ surface: 'buddy' });
    if (params.city) qs.set('city', params.city);
    if (params.limit != null) qs.set('limit', String(params.limit));
    qs.set('tzOffsetMinutes', String(deviceTzOffsetMinutes()));
    const r = await authedFetch(`/api/compass/recommendations?${qs.toString()}`);
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    if (body.disabled) return { ok: true, data: [], disabled: true };
    return { ok: true, data: (body.recommendations ?? []) as CompassBuddyResult[] };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

// ── Traveler matches ──────────────────────────────────────────────────────────

export interface CompassTravelerData {
  userId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  homeCity: string | null;
  isPrivate: boolean;
  verified: boolean;
  sharedInterests: string[];
  reasonCode: string;
  followStatus: 'following' | 'requested' | 'not_following';
}

export interface CompassTravelerResult {
  id: string;
  type: 'traveler';
  category: 'traveler';
  title: string | null;
  reason: string;
  city: string | null;
  data: CompassTravelerData;
}

export interface CompassTravelerMatchesResult {
  ok: boolean;
  data?: CompassTravelerResult[];
  disabled?: boolean;
  error?: string;
}

export async function fetchCompassTravelerMatches(params: {
  city?: string | null;
  limit?: number;
} = {}): Promise<CompassTravelerMatchesResult> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured() as CompassTravelerMatchesResult;
  try {
    const qs = new URLSearchParams({ surface: 'traveler' });
    if (params.city) qs.set('city', params.city);
    if (params.limit != null) qs.set('limit', String(params.limit));
    qs.set('tzOffsetMinutes', String(deviceTzOffsetMinutes()));
    const r = await authedFetch(`/api/compass/recommendations?${qs.toString()}`);
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    if (body.disabled) return { ok: true, data: [], disabled: true };
    return { ok: true, data: (body.recommendations ?? []) as CompassTravelerResult[] };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

// ── Telegraph surface ─────────────────────────────────────────────────────────

export interface CompassTelegraphCard {
  id:          string;
  type:        'event' | 'place' | 'hidden_gem' | 'activity' | string;
  title:       string | null;
  city:        string | null;
  category:    string | null;
  description: string | null;
  imageUrl:    string | null;
  data?:       Record<string, unknown>;
}

export interface CompassTelegraphResult {
  ok:           boolean;
  cards?:       CompassTelegraphCard[];
  city?:        string | null;
  flagDisabled?: boolean;
  error?:       string;
}

/**
 * Fetch Compass recommendation cards for the Ask Compass chip in Telegraph.
 * Returns up to 4 cards relevant to the chat thread context.
 * Returns flagDisabled=true when the compass_telegraph flag is off.
 */
export async function fetchCompassTelegraphCards(
  threadId: string,
): Promise<CompassTelegraphResult> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, error: 'not_configured' };
  }
  try {
    const qs = new URLSearchParams({ threadId, tzOffsetMinutes: String(deviceTzOffsetMinutes()) });
    const r = await authedFetch(`/api/compass/telegraph?${qs.toString()}`);
    if (r.status === 404 || r.status === 403) {
      const body = await r.json().catch(() => ({}));
      if ((body as any)?.error === 'feature_disabled') {
        return { ok: true, cards: [], flagDisabled: true };
      }
      return { ok: false, error: r.status === 403 ? 'forbidden' : `http_${r.status}` };
    }
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    return {
      ok:    true,
      cards: (body.cards ?? []) as CompassTelegraphCard[],
      city:  body.city ?? null,
    };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

/**
 * Lightweight flag check: returns true when COMPASS_TELEGRAPH is enabled for
 * this thread. Returns false when the flag is off or on any network/auth error.
 * Use this to gate the Ask Compass chip without loading full card data.
 */
export async function checkCompassTelegraphAvailable(threadId: string): Promise<boolean> {
  const result = await fetchCompassTelegraphCards(threadId);
  return result.ok && !result.flagDisabled;
}

// ── AsyncStorage helpers ──────────────────────────────────────────────────────

const FEED_CACHE_PREFIX = 'compass_feed_cache:';

export async function getCachedFeed(userId: string): Promise<CompassFeedResponse | null> {
  const store = getStorage();
  if (!store) return null;
  try {
    const raw = await store.getItem(`${FEED_CACHE_PREFIX}${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Expire cache after 30 minutes
    if (Date.now() - (parsed._cachedAt ?? 0) > 30 * 60 * 1000) return null;
    return parsed.feed ?? null;
  } catch {
    return null;
  }
}

export async function setCachedFeed(userId: string, feed: CompassFeedResponse): Promise<void> {
  const store = getStorage();
  if (!store) return;
  try {
    await store.setItem(`${FEED_CACHE_PREFIX}${userId}`, JSON.stringify({ feed, _cachedAt: Date.now() }));
  } catch {
    // ignore storage errors
  }
}

/** Remove the cached Compass feed for a user from local storage (e.g. on logout). */
export async function clearCachedFeed(userId: string): Promise<void> {
  const store = getStorage();
  if (!store) return;
  try {
    await store.removeItem(`${FEED_CACHE_PREFIX}${userId}`);
  } catch {
    // best-effort
  }
}

// ── Phase 6: Compass Remembers — layered memory ───────────────────────────────

export type CompassMemoryScope = 'session' | 'trip' | 'long_term' | 'circle';

export interface CompassMemory {
  id:             string;
  userId:         string;
  scope:          CompassMemoryScope;
  circleOwnerId:  string | null;
  tripId:         string | null;
  conversationId: string | null;
  category:       string;
  content:        string;
  source:         'taught' | 'compressed' | 'inferred';
  confidence:     number;
  createdAt:      string;
  updatedAt:      string;
}

export async function fetchCompassMemories(
  scope?: CompassMemoryScope,
): Promise<{ ok: boolean; data?: CompassMemory[]; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const qs = scope ? `?scope=${encodeURIComponent(scope)}` : '';
    const r = await authedFetch(`/api/compass/me/memories${qs}`);
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    return { ok: true, data: body.memories ?? [] };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

/** "Teach My Compass": turn an explicit statement into a structured preference. */
export async function teachCompassMemory(
  statement: string,
  opts: { circleOwnerId?: string } = {},
): Promise<{ ok: boolean; data?: CompassMemory; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch('/api/compass/me/memories/teach', {
      method: 'POST',
      body:   JSON.stringify({ statement, ...opts }),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    return { ok: true, data: body.memory };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export async function updateCompassMemory(
  memoryId: string,
  patch: { content?: string; category?: string },
): Promise<{ ok: boolean; data?: CompassMemory; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch(`/api/compass/me/memories/${encodeURIComponent(memoryId)}`, {
      method: 'PATCH',
      body:   JSON.stringify(patch),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    return { ok: true, data: body.memory };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

export async function forgetCompassMemory(
  memoryId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch(`/api/compass/me/memories/${encodeURIComponent(memoryId)}`, {
      method: 'DELETE',
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

// ── Compass Home (Phase 10) ───────────────────────────────────────────────────

export interface CompassHomeEvent {
  id:       string;
  title:    string;
  city:     string | null;
  country:  string | null;
  startsAt: string | null;
  category: string | null;
}

export interface CompassHomePerson {
  label:           string;
  handle:          string | null;
  status:          string;
  statusLabel:     string | null;
  approximateArea: string | null;
  venue:           string | null;
  context:         { type: string; title: string } | null;
}

export interface CompassHomeResponse {
  compassEnabled: boolean;
  fallback:       boolean;
  timeOfDay?:     'morning' | 'afternoon' | 'evening' | 'night';
  contextState?:  string;
  city?:          string | null;
  bestNextMove?:  {
    id:             string;
    type:           string;
    title:          string | null;
    category:       string | null;
    city:           string | null;
    data:           Record<string, unknown> | null;
    explanationKey: string | null;
  } | null;
  circleActivity?: { people: CompassHomePerson[] } | null;
  startingSoon?:   CompassHomeEvent[] | null;
  tonightVibe?:    { headline: string; events: CompassHomeEvent[] } | null;
  weatherWindow?:  {
    city:     string;
    date:     string;
    summary:  string;
    maxTempC: number;
    minTempC: number;
    precipMm: number;
    headline: string;
  } | null;
}

export async function fetchCompassHome(): Promise<{
  ok: boolean;
  data?: CompassHomeResponse;
  error?: string;
}> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    // Send the device's real UTC offset so time-of-day buckets follow the
    // traveler's clock (JS getTimezoneOffset() is inverted: UTC+8 → -480).
    const tzOffsetMinutes = -new Date().getTimezoneOffset();
    const r = await authedFetch(`/api/compass/home?tzOffsetMinutes=${tzOffsetMinutes}`);
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true, data: await r.json() };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

// ── Memory + Experience Intelligence (derived memory, migrations 2183-2197) ─────
// The projected-memory contract: Rediscovery (§8), plus view / feedback / export
// / reset (§17). Everything here is empty until the server's `memory_projection`
// flag is on and the projector has populated memory_projections — so the client
// surfaces render graceful empty states, never errors, when nothing comes back.

/** Why a rediscovered memory is being resurfaced now. */
export type RediscoverReason = 'been_here_before' | 'you_saved' | 'you_know' | 'relevant';

/** A memory resurfaced on returning to a city (GET /memory/rediscover). */
export interface RediscoverMemory {
  id: string;
  memory_type: string;
  subject_type: string;
  subject_id: string;
  content: string;
  confidence: number;
  reason: RediscoverReason;
}

/** A currently-served projected memory (GET /memory). */
export interface ProjectedMemory {
  id: string;
  memory_type: string;
  subject_type: string;
  subject_id: string;
  content: string;
  confidence: number;
  last_supported_at: string | null;
  valid_from: string | null;
}

/** A row from the full export (GET /memory/export) — includes suppressed/decayed. */
export interface ExportedMemory {
  memory_type: string;
  subject_type: string;
  subject_id: string;
  content: string;
  confidence: number;
  state: string;
  sensitivity?: string;
  visibility?: string;
  retention_class?: string;
  valid_from: string | null;
  valid_to: string | null;
  last_supported_at: string | null;
  suppressed_by?: unknown;
}

/** Feedback the user can give on a single derived memory. */
export type MemoryFeedbackKind = 'hide' | 'forget' | 'incorrect' | 'not_interested' | 'already_known';

/** Memory classes that a reset can be scoped to (omit for a full reset). */
export type MemoryClass = 'episodic' | 'semantic' | 'social' | 'place' | 'intent';

export interface MemoryResetResult {
  reset: boolean;
  projectionsCleared: number;
  eventsCleared: number;
  feedbackKept: number;
}

/**
 * Rediscovery (§8) — on returning to a city, the user's prior memory that
 * matters now, each tagged with a `reason`. Empty array (not an error) when
 * there is nothing to resurface.
 */
export async function fetchRediscover(
  city: string,
  limit = 20,
): Promise<{ ok: boolean; data?: RediscoverMemory[]; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  if (!city.trim()) return { ok: false, error: 'no_city' };
  try {
    const r = await authedFetch(
      `/api/compass/me/memory/rediscover?city=${encodeURIComponent(city.trim())}&limit=${limit}`,
    );
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    return { ok: true, data: (body.rediscover ?? []) as RediscoverMemory[] };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

/**
 * View (§17/§10) — the ranked projected memories currently served on a surface.
 */
export async function fetchProjectedMemories(
  surface: 'compass' | 'discovery' | 'passport' = 'compass',
  limit = 50,
): Promise<{ ok: boolean; data?: ProjectedMemory[]; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch(
      `/api/compass/me/memory?surface=${encodeURIComponent(surface)}&limit=${limit}`,
    );
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    return { ok: true, data: (body.memories ?? []) as ProjectedMemory[] };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

/**
 * Feedback (§17) — hide / forget / incorrect / not_interested / already_known
 * on one memory. Pass `projectionId` (preferred — ownership is enforced server
 * side) or a durable `subjectType`+`subjectId` pair.
 */
export async function postMemoryFeedback(body: {
  kind: MemoryFeedbackKind;
  projectionId?: string;
  subjectType?: string;
  subjectId?: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch('/api/compass/me/memory/feedback', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

/**
 * Export (§17) — everything derived about the user, including suppressed and
 * decayed rows and what suppresses them.
 */
export async function fetchMemoryExport(): Promise<{ ok: boolean; data?: ExportedMemory[]; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch('/api/compass/me/memory/export');
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    return { ok: true, data: (body.memories ?? []) as ExportedMemory[] };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

/**
 * Reset (§17) — clear the derived picture (all classes, or only the ones given).
 * Destructive: rebuilds personalization from scratch. Previous "forget" choices
 * survive (feedbackKept), so suppressed memory is never resurrected.
 */
export async function postMemoryReset(
  memoryTypes?: MemoryClass[],
): Promise<{ ok: boolean; data?: MemoryResetResult; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch('/api/compass/me/memory/reset', {
      method: 'POST',
      body: JSON.stringify(memoryTypes && memoryTypes.length ? { memoryTypes } : {}),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    return {
      ok: true,
      data: {
        reset: Boolean(body.reset),
        projectionsCleared: Number(body.projectionsCleared ?? 0),
        eventsCleared: Number(body.eventsCleared ?? 0),
        feedbackKept: Number(body.feedbackKept ?? 0),
      },
    };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}
