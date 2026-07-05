/**
 * Compass service — all API calls for the Compass personalisation system.
 *
 * Uses the same authedFetch / freshToken pattern as intelligence.ts.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';

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
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
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

export async function fetchCompassFeed(
  params: { city?: string; cursor?: string } = {},
): Promise<{ ok: boolean; data?: CompassFeedResponse; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const qs = new URLSearchParams();
    if (params.city) qs.set('city', params.city);
    if (params.cursor) qs.set('cursor', params.cursor);
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

export async function fetchCompassSection(
  section: string,
  params: { city?: string; cursor?: string } = {},
): Promise<{ ok: boolean; data?: CompassFeedResponse; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const qs = new URLSearchParams();
    if (params.city) qs.set('city', params.city);
    if (params.cursor) qs.set('cursor', params.cursor);
    const r = await authedFetch(`/api/compass/feed/section/${encodeURIComponent(section)}?${qs.toString()}`);
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true, data: normalizeSectionResponse(await r.json()) };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

// ── Why ───────────────────────────────────────────────────────────────────────

export async function fetchCompassWhy(
  recommendationId: string,
): Promise<{ ok: boolean; explanation?: string; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch(`/api/compass/why/${encodeURIComponent(recommendationId)}`);
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    const body = await r.json();
    return { ok: true, explanation: body.explanation ?? 'Based on your travel preferences.' };
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
  | 'block';

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

// ── AI Buddy (ask) ────────────────────────────────────────────────────────────

export interface CompassAskRecommendation {
  id: string;
  bestPick: string;
  why: string;
  whyLabel?: string;
  socialProof: string;
  socialProofLabel?: string;
  tradeoff?: string;
  tradeoffLabel?: string;
  usedPostIds: string[];
  nextActions: Array<{ label: string; kind: string }>;
}

export async function postCompassAsk(
  prompt: string,
  opts: { city?: string; mode?: 'recommend' | 'itinerary' } = {},
): Promise<{ ok: boolean; data?: CompassAskRecommendation; error?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return notConfigured();
  try {
    const r = await authedFetch('/api/compass/ask', {
      method: 'POST',
      body: JSON.stringify({ prompt, ...opts }),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true, data: await r.json() };
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
