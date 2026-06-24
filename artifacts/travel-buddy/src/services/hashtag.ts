/**
 * Hashtag mobile service — fetch metadata, follow/unfollow, feed, and user preview.
 */
import { supabase } from '../lib/supabase';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  try {
    const { data: refreshed } = await supabase.auth.refreshSession();
    const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
    return session?.access_token ?? null;
  } catch {
    return null;
  }
}

async function apiGet<T>(path: string): Promise<{ ok: boolean; data?: T; error?: string }> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any)?.message ?? res.statusText };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function apiPost<T>(path: string): Promise<{ ok: boolean; data?: T; error?: string }> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any)?.message ?? res.statusText };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function apiDelete<T>(path: string): Promise<{ ok: boolean; data?: T; error?: string }> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any)?.message ?? res.statusText };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface HashtagMeta {
  id: string;
  slug: string;
  name: string;
  usageCount: number;
  isFollowing: boolean;
  createdAt: string;
}

export type FeedTab = 'top' | 'recent' | 'events' | 'people' | 'places' | 'circles' | 'trips';
export type FeedScope = 'global' | 'city' | 'nearby';

export interface FeedPostItem {
  id: string; type: 'post'; content: string; mediaUrls: string[];
  createdAt: string; likeCount: number; commentCount: number;
  author: { id: string; handle: string; name: string; avatarUrl: string | null } | null;
  /** Saved @mention annotations — whitelist for RichText rendering. */
  tags: Array<{ type: 'user'; id: string; matchToken: string; isBlocked?: boolean }>;
  /** Saved #hashtag annotations — whitelist for RichText rendering. */
  hashtagUsages: Array<{ slug: string; isBlocked?: boolean }>;
}
export interface FeedUserItem {
  id: string; type: 'user'; handle: string; name: string | null; avatarUrl: string | null;
}
export interface FeedPlaceItem {
  id: string; type: 'place'; name: string; city: string | null;
  placeType: string | null; imageUrl: string | null;
}
export interface FeedTripItem {
  id: string; type: 'trip'; name: string; destination: string | null; status: string;
}
export interface FeedCircleItem { id: string; type: 'circle'; name: string; }
export interface FeedEventItem {
  id: string; type: 'event'; name: string;
  location: string | null; startAt: string | null; endAt: string | null;
}
export type FeedItem =
  | FeedPostItem | FeedUserItem | FeedPlaceItem
  | FeedTripItem | FeedCircleItem | FeedEventItem;

export interface HashtagFeedResponse {
  items: FeedItem[];
  hasMore: boolean;
  /** ISO timestamp of the oldest usage row in this page; pass as `before` for the next page. */
  nextCursor: string | null;
  tab: FeedTab;
  scope: FeedScope;
}

export interface UserPreview {
  id: string; handle: string; name: string | null;
  avatarUrl: string | null; bio: string | null;
  followersCount: number; isFollowing: boolean;
}

// ── API calls ──────────────────────────────────────────────────────────────────

export async function getHashtag(slug: string) {
  return apiGet<HashtagMeta>(`/api/hashtags/${encodeURIComponent(slug)}`);
}

export async function followHashtag(slug: string) {
  return apiPost<{ ok: boolean; following: boolean }>(
    `/api/hashtags/${encodeURIComponent(slug)}/follow`,
  );
}

export async function unfollowHashtag(slug: string) {
  return apiDelete<{ ok: boolean; following: boolean }>(
    `/api/hashtags/${encodeURIComponent(slug)}/follow`,
  );
}

export async function getHashtagFeed(
  slug: string,
  tab: FeedTab,
  scope: FeedScope,
  city?: string | null,
  before?: string | null,
  limit = 20,
) {
  const qs = new URLSearchParams({ tab, scope, limit: String(limit) });
  if (city) qs.set('city', city);
  if (before) qs.set('before', before);
  return apiGet<HashtagFeedResponse>(
    `/api/hashtags/${encodeURIComponent(slug)}/feed?${qs}`,
  );
}

export async function getUserByHandle(handle: string) {
  return apiGet<UserPreview>(`/api/users/by-handle/${encodeURIComponent(handle)}`);
}
