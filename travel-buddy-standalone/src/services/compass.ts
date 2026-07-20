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

/** Phase-1 response shape from POST /api/compass/ask. */
export interface CompassAskResponse {
  conversationId:  string | null;
  message:         string;
  payload:         CompassAskPayload | null;
  quickActions:    CompassQuickAction[];
  promptVersion:   string;
  intent?:         { intent: string; confidence: number };
  fallback?:       boolean;
  fallbackReason?: string;
}

/**
 * @deprecated Legacy shape — kept for types that reference it.
 * New code should use CompassAskResponse.
 */
export interface CompassAskRecommendation extends CompassAskResponse {}

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
  try {
    const r = await authedFetch('/api/compass/ask', {
      method: 'POST',
      body:   JSON.stringify({ prompt, ...opts }),
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
    const qs = new URLSearchParams({ threadId });
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
