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

async function apiGet<T>(path: string, signal?: AbortSignal): Promise<{ ok: boolean; data?: T; error?: string }> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
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

export type TagPermission = 'anyone' | 'interacted' | 'friends_only' | 'nobody' | 'approval_required';

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
  signal?: AbortSignal,
): Promise<EntityTagSuggestion[]> {
  if (!q.trim()) return [];
  const qs = new URLSearchParams({ q, surface }).toString();
  const res = await apiGet<{ suggestions: any[] }>(`/api/tags/suggestions?${qs}`, signal);
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
export async function fetchHashtagSuggestions(q: string, signal?: AbortSignal): Promise<HashtagSuggestion[]> {
  if (!q.trim()) return [];
  const qs = new URLSearchParams({ q }).toString();
  const res = await apiGet<{ suggestions: any[] }>(`/api/hashtags/suggestions?${qs}`, signal);
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
  signal?: AbortSignal,
): Promise<AnyMentionSuggestion[]> {
  if (trigger.char === '#') return fetchHashtagSuggestions(trigger.query, signal);
  return fetchEntitySuggestions(trigger.query, surface, signal);
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

// ── "Ask me first" (census-discovery §95; §81.4 routed hunk R3; DV-76) ─────────
//
// The server made `approval_required` choosable and approvable behind
// `tag_permission_approval_required_enabled` (3468, seeded FALSE). The client
// offers it ONLY when the server says it is on, and the one question it asks is
// GET /api/me/tags/pending: `feature_disabled` means off, so the settings list
// stays the four options above, byte for byte. A person whose stored setting is
// already `approval_required` still sees it selected, whatever the probe says.
// Nothing here decides what "interacted" or "friends" mean — that copy is the
// owner's consent question (D-W10S2-9), and its flag stays FALSE.

export const ASK_ME_FIRST_OPTION: { key: TagPermission; label: string; desc: string } =
  { key: 'approval_required', label: 'Ask me first', desc: 'Tags of you wait for your approval' };

/** The settings list: the four options, plus "Ask me first" when the server offers it or it is already the stored choice. */
export function tagPermissionOptions(
  approvalAvailable: boolean,
  current: TagPermission | null = null,
): { key: TagPermission; label: string; desc: string }[] {
  return approvalAvailable || current === 'approval_required'
    ? [...TAG_PERMISSION_OPTIONS, ASK_ME_FIRST_OPTION]
    : TAG_PERMISSION_OPTIONS;
}

export interface PendingTag {
  id: string;
  sourceType: string;
  sourceId: string;
  taggedAt: string | null;
  taggerId: string;
  taggerHandle: string | null;
}

export type PendingTagsResult =
  | { status: 'disabled' }
  | { status: 'ok'; tags: PendingTag[] }
  | { status: 'error'; error: string };

async function request(method: 'GET' | 'POST', path: string): Promise<{ status: number; json: any } | null> {
  const token = await freshToken();
  if (!token) return null;
  try {
    const res = await fetch(`${apiBase()}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

/** The caller's pending tags — and, through `disabled`, whether "Ask me first" exists at all. */
export async function fetchPendingTags(): Promise<PendingTagsResult> {
  const r = await request('GET', '/api/me/tags/pending');
  if (!r) return { status: 'error', error: 'Could not load tags waiting for you.' };
  if (r.status === 404 && r.json?.error === 'feature_disabled') return { status: 'disabled' };
  if (r.status !== 200 || !Array.isArray(r.json?.tags)) {
    return { status: 'error', error: typeof r.json?.message === 'string' ? r.json.message : 'Could not load tags waiting for you.' };
  }
  const tags: PendingTag[] = [];
  for (const t of r.json.tags as any[]) {
    if (typeof t?.id !== 'string' || typeof t?.taggerId !== 'string') continue;
    tags.push({
      id: t.id,
      sourceType: String(t.sourceType ?? ''),
      sourceId: String(t.sourceId ?? ''),
      taggedAt: typeof t.taggedAt === 'string' ? t.taggedAt : null,
      taggerId: t.taggerId,
      taggerHandle: typeof t.taggerHandle === 'string' && t.taggerHandle ? t.taggerHandle : null,
    });
  }
  return { status: 'ok', tags };
}

/** Approve one pending tag of you. */
export async function approvePendingTag(tagId: string): Promise<{ ok: boolean; error?: string }> {
  const r = await request('POST', `/api/tags/${encodeURIComponent(tagId)}/approve`);
  if (r && r.status === 200 && r.json?.ok === true) return { ok: true };
  return { ok: false, error: typeof r?.json?.message === 'string' ? r.json.message : 'Could not approve that tag.' };
}

/** Decline one pending tag of you: the existing self-removal, which the server keeps as a suppression. */
export async function declinePendingTag(tagId: string): Promise<{ ok: boolean; error?: string }> {
  const r = await removeSelfTag(tagId);
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'Could not decline that tag.' };
}

/** The inbox after one tag was answered: that tag is gone, the rest keep their order. */
export function withoutPendingTag(tags: readonly PendingTag[], tagId: string): PendingTag[] {
  return tags.filter((t) => t.id !== tagId);
}

/** "@ana tagged you in a post" — the tagger by handle, never a guessed name. */
export function pendingTagLine(t: PendingTag): string {
  const who = t.taggerHandle ? `@${t.taggerHandle}` : 'Someone';
  const where = t.sourceType === 'comment' ? 'a comment' : t.sourceType === 'message' ? 'a message' : 'a post';
  return `${who} tagged you in ${where}`;
}
