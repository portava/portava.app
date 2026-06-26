/**
 * Compass service — all API calls for the Compass personalisation system.
 *
 * Uses the same authedFetch / freshToken pattern as intelligence.ts.
 */
import { Platform } from 'react-native';
import { supabase, isSupabaseConfigured } from '../lib/supabase';

type AsyncStorageStub = {
  setItem(k: string, v: string): Promise<void>;
  getItem(k: string): Promise<string | null>;
  removeItem(k: string): Promise<void>;
};
const getStorage = (): AsyncStorageStub | null => {
  if (Platform.OS === 'web') return null;
  return require('@react-native-async-storage/async-storage').default as AsyncStorageStub;
};

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function freshToken(): Promise<string | null> {
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
    await authedFetch('/api/compass/frontload/event', {
      method: 'POST',
      body: JSON.stringify(event),
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
