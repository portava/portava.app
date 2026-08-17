/**
 * Tagging & hashtag mobile service.
 * Wraps /api/tags/suggestions, /api/hashtags/suggestions,
 * /api/me/tag-permission, and /api/tags/:id (self-removal) endpoints.
 */

import { supabase } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';
import { serviceFailure, thrownFailure } from './serviceFailure.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  try {
    return freshApiToken();
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
      return { ok: false, error: serviceFailure('tagging', res, (body as any).message, 'Could not complete that request.') };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (e: any) {
    return { ok: false, error: thrownFailure('tagging', e) };
  }
}

async function apiPatch<T>(path: string, body: unknown): Promise<{ ok: boolean; data?: T; error?: string }> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, error: serviceFailure('tagging', res, (b as any)?.message, 'Could not complete that request.') };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e: any) {
    return { ok: false, error: thrownFailure('tagging', e) };
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
      const b = await res.json().catch(() => ({}));
      return { ok: false, error: serviceFailure('tagging', res, (b as any)?.message, 'Could not complete that request.') };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e: any) {
    return { ok: false, error: thrownFailure('tagging', e) };
  }
}

// ── Tag permission types ───────────────────────────────────────────────────────

export type TagPermission = 'anyone' | 'interacted' | 'friends_only' | 'nobody';

export const TAG_PERMISSION_OPTIONS: { key: TagPermission; label: string; desc: string }[] = [
  { key: 'anyone',       label: 'Anyone',                       desc: 'Anyone can @mention you in posts and messages' },
  { key: 'interacted',   label: "People I've interacted with",  desc: "Only people you've followed or messaged" },
  { key: 'friends_only', label: 'Friends & circle members',     desc: 'Only mutual follows and circle members' },
  { key: 'nobody',       label: 'Nobody',                       desc: "Your name won't appear in @ suggestions" },
];

// ── Tag suggestion types ───────────────────────────────────────────────────────

export type TagSuggestionType = 'user' | 'trip' | 'circle' | 'place' | 'event';
export type MentionSurface = 'post' | 'comment' | 'message';

export interface EntityTagSuggestion {
  id: string;
  type: TagSuggestionType;
  name: string;
  handle?: string | null;
  avatarUrl?: string | null;
  subtitle?: string | null;
}

export interface HashtagSuggestion {
  id: string;
  type: 'hashtag';
  name: string;
  slug: string;
  usageCount: number;
  isFollowing?: boolean;
}

export type AnyMentionSuggestion = EntityTagSuggestion | HashtagSuggestion;

export interface TagSpan {
  type: string;
  id: string;
  displayText: string;
}

// ── API calls ─────────────────────────────────────────────────────────────────

/**
 * Fetch @ mention suggestions (users, trips, circles, places, events).
 * Backend filters by tag_permission automatically.
 */
export async function fetchEntitySuggestions(
  q: string,
  surface: MentionSurface = 'post',
): Promise<EntityTagSuggestion[]> {
  if (!q.trim()) return [];
  const qs = new URLSearchParams({ q, surface }).toString();
  const res = await apiGet<{ suggestions: any[] }>(`/api/tags/suggestions?${qs}`);
  if (!res.ok || !res.data) return [];
  return (res.data.suggestions ?? []).map((s: any) => ({
    id: s.id,
    type: s.type as TagSuggestionType,
    name: s.name ?? s.handle ?? '',
    handle: s.handle ?? null,
    avatarUrl: s.avatarUrl ?? s.avatar_url ?? null,
    subtitle: buildSubtitle(s),
  }));
}

function buildSubtitle(s: any): string | null {
  if (s.type === 'user') return s.handle ? `@${s.handle}` : null;
  if (s.type === 'trip') return s.destination ?? null;
  if (s.type === 'circle') return 'Circle';
  if (s.type === 'place') return s.placeType ?? s.city ?? null;
  if (s.type === 'event') return s.location ?? null;
  return null;
}

/**
 * Fetch # hashtag autocomplete suggestions.
 * Ordered: followed → city-trending → prefix-matched, excluding blocked hashtags.
 */
export async function fetchHashtagSuggestions(q: string): Promise<HashtagSuggestion[]> {
  if (!q.trim()) return [];
  const qs = new URLSearchParams({ q }).toString();
  const res = await apiGet<{ suggestions: any[] }>(`/api/hashtags/suggestions?${qs}`);
  if (!res.ok || !res.data) return [];
  return (res.data.suggestions ?? []).map((h: any) => ({
    id: h.id,
    type: 'hashtag' as const,
    name: h.name ?? h.slug,
    slug: h.slug,
    usageCount: h.usageCount ?? h.usage_count ?? 0,
    isFollowing: h.isFollowing ?? false,
  }));
}

/**
 * Unified fetch: calls the right endpoint based on trigger character.
 */
export async function fetchMentionSuggestions(
  trigger: { char: '@' | '#'; query: string },
  surface: MentionSurface = 'post',
): Promise<AnyMentionSuggestion[]> {
  if (trigger.char === '#') return fetchHashtagSuggestions(trigger.query);
  return fetchEntitySuggestions(trigger.query, surface);
}

/**
 * Build the display text that is inserted into the composer for a selected suggestion.
 */
export function buildDisplayText(suggestion: AnyMentionSuggestion): string {
  if (suggestion.type === 'hashtag') return `#${suggestion.slug}`;
  if (suggestion.type === 'user' && suggestion.handle) return `@${suggestion.handle}`;
  return `@${(suggestion as EntityTagSuggestion).name}`;
}

// ── Tag permission API calls ───────────────────────────────────────────────────

/** Get the current user's tag_permission setting. */
export async function getTagPermission() {
  return apiGet<{ tagPermission: TagPermission }>('/api/me/tag-permission');
}

/** Update the current user's tag_permission setting. */
export async function updateTagPermission(tagPermission: TagPermission) {
  return apiPatch<{ tagPermission: TagPermission }>('/api/me/tag-permission', { tagPermission });
}

/** Tagged user removes their own @mention tag row. The tag text stays; the link is removed. */
export async function removeSelfTag(tagRowId: string) {
  return apiDelete<{ ok: boolean }>(`/api/tags/${encodeURIComponent(tagRowId)}`);
}
