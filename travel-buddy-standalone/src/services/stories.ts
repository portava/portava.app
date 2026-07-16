/**
 * Stories service — wraps /api/stories and /api/users/me/close-friends endpoints.
 */
import { supabase } from '../lib/supabase';
import { freshToken as freshApiToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export type StoryVisibility =
  | 'public'
  | 'friends_only'
  | 'close_friends'
  | 'trip_crew'
  | 'circle_only'
  | 'custom';

export interface StoryAuthor {
  userId: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface Story {
  id: string;
  owner_id: string;
  media_url: string;
  media_type: string;
  caption: string | null;
  visibility: StoryVisibility;
  close_friends_only: boolean;
  trip_id: string | null;
  expires_at: string;
  state: string;
  hide_viewer_list: boolean;
  created_at: string;
  viewedByMe?: boolean;
}

export interface StoryFeedUser extends StoryAuthor {
  stories: Story[];
  hasUnviewed: boolean;
}

export interface StoryFeedResult {
  ok: true;
  users: StoryFeedUser[];
}

export interface StoryViewer {
  userId: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
  viewedAt: string;
}

export interface ViewersResult {
  ok: true;
  hidden: boolean;
  viewers: StoryViewer[];
  total: number;
}

export interface CloseFriend {
  userId: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
  addedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function authHeader(): Promise<Record<string, string>> {
  const token = await freshApiToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/**
 * Upload a local media URI to Supabase Storage and return a public URL.
 * Returns null on failure (caller shows error).
 */
export async function uploadStoryMedia(localUri: string, mediaType: string): Promise<string | null> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user?.id;
    if (!userId) return null;

    // Fetch the local file as a blob
    const response = await fetch(localUri);
    const blob = await response.blob();

    const ext = mediaType.startsWith('video') ? 'mp4' : 'jpg';
    const path = `stories/${userId}/${Date.now()}.${ext}`;

    const { error } = await supabase.storage
      .from('post-media')
      .upload(path, blob, { contentType: mediaType, upsert: false });

    if (error) return null;

    const { data: urlData } = supabase.storage.from('post-media').getPublicUrl(path);
    return urlData?.publicUrl ?? null;
  } catch {
    return null;
  }
}

// ── Feed ──────────────────────────────────────────────────────────────────────

export async function getStoriesFeed(): Promise<StoryFeedResult | { ok: false; message: string }> {
  try {
    const headers = await authHeader();
    const res = await fetch(`${apiBase()}/api/stories/feed`, { headers });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const json = await res.json();
    return { ok: true, users: json.users ?? [] };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

// ── Single story ──────────────────────────────────────────────────────────────

export async function getStory(id: string): Promise<{ ok: true; story: Story } | { ok: false; message: string }> {
  try {
    const headers = await authHeader();
    const res = await fetch(`${apiBase()}/api/stories/${id}`, { headers });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    return { ok: true, story: await res.json() };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

// ── Create story ──────────────────────────────────────────────────────────────

export interface CreateStoryInput {
  mediaUrl: string;
  mediaType: string;
  caption?: string | null;
  visibility?: StoryVisibility;
  closeFriendsOnly?: boolean;
  tripId?: string | null;
  hideViewerList?: boolean;
}

export async function createStory(input: CreateStoryInput): Promise<{ ok: true; story: Story } | { ok: false; message: string }> {
  try {
    const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
    const res = await fetch(`${apiBase()}/api/stories`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mediaUrl: input.mediaUrl,
        mediaType: input.mediaType,
        caption: input.caption ?? null,
        visibility: input.visibility ?? 'public',
        closeFriendsOnly: input.closeFriendsOnly ?? false,
        tripId: input.tripId ?? null,
        hideViewerList: input.hideViewerList ?? false,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, message: j.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, story: await res.json() };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

// ── Delete story ──────────────────────────────────────────────────────────────

export async function deleteStory(id: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const headers = await authHeader();
    const res = await fetch(`${apiBase()}/api/stories/${id}`, { method: 'DELETE', headers });
    return { ok: res.status === 204 };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

// ── Viewers ───────────────────────────────────────────────────────────────────

export async function getViewers(storyId: string): Promise<ViewersResult | { ok: false; message: string }> {
  try {
    const headers = await authHeader();
    const res = await fetch(`${apiBase()}/api/stories/${storyId}/viewers`, { headers });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    return { ok: true, ...(await res.json()) };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

// ── Reactions ─────────────────────────────────────────────────────────────────

export async function reactToStory(storyId: string, emoji: string): Promise<{ ok: boolean }> {
  try {
    const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
    const res = await fetch(`${apiBase()}/api/stories/${storyId}/react`, {
      method: 'POST', headers, body: JSON.stringify({ emoji }),
    });
    return { ok: res.ok };
  } catch { return { ok: false }; }
}

// ── Replies ───────────────────────────────────────────────────────────────────

export async function replyToStory(storyId: string, message: string): Promise<{ ok: boolean }> {
  try {
    const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
    const res = await fetch(`${apiBase()}/api/stories/${storyId}/reply`, {
      method: 'POST', headers, body: JSON.stringify({ message }),
    });
    return { ok: res.ok };
  } catch { return { ok: false }; }
}

// ── Save to highlight ─────────────────────────────────────────────────────────

export async function saveToHighlight(storyId: string, highlightId: string): Promise<{ ok: boolean }> {
  try {
    const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
    const res = await fetch(`${apiBase()}/api/stories/${storyId}/save-to-highlight`, {
      method: 'POST', headers, body: JSON.stringify({ highlightId }),
    });
    return { ok: res.ok };
  } catch { return { ok: false }; }
}

// ── Close Friends ─────────────────────────────────────────────────────────────

export async function getCloseFriends(): Promise<{ ok: true; closeFriends: CloseFriend[] } | { ok: false; message: string }> {
  try {
    const headers = await authHeader();
    const res = await fetch(`${apiBase()}/api/users/me/close-friends`, { headers });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    return { ok: true, ...(await res.json()) };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

export async function addCloseFriend(userId: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
    const res = await fetch(`${apiBase()}/api/users/me/close-friends`, {
      method: 'POST', headers, body: JSON.stringify({ userId }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, message: j.message ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

export async function removeCloseFriend(userId: string): Promise<{ ok: boolean }> {
  try {
    const headers = await authHeader();
    const res = await fetch(`${apiBase()}/api/users/me/close-friends/${userId}`, {
      method: 'DELETE', headers,
    });
    return { ok: res.status === 204 };
  } catch { return { ok: false }; }
}
