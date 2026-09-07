/**
 * Stories service — wraps /api/stories and /api/users/me/close-friends endpoints.
 */
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
  /** True when the author holds verified traveler status. */
  verified?: boolean;
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
  verified?: boolean;
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
 * Upload a local media URI through the canonical server-side processing
 * pipeline (POST /api/media/upload) and return the storage URL.
 *
 * Routing through the API server ensures EXIF/GPS metadata is stripped and
 * images are re-encoded before storage, matching the privacy guarantees of
 * the main post-media path. A direct client-to-bucket write bypasses this
 * processing and leaves raw originals (potentially carrying capture
 * coordinates) permanently retrievable at a guessable public URL.
 *
 * Returns null on failure (caller shows error).
 */
export async function uploadStoryMedia(localUri: string, mediaType: string): Promise<string | null> {
  try {
    const token = await freshApiToken();
    if (!token) return null;

    // Fetch the local file as a blob
    const response = await fetch(localUri);
    const blob = await response.blob();

    const uploadRes = await fetch(`${apiBase()}/api/media/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': mediaType,
        Authorization: `Bearer ${token}`,
      },
      body: blob,
    });

    if (!uploadRes.ok) return null;
    const json = await uploadRes.json();
    return typeof json?.url === 'string' ? json.url : null;
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

// ── Archive ───────────────────────────────────────────────────────────────────
//
// An expired story is ARCHIVED, not gone. The owner can list what expired and
// re-post it. A story's term is fixed at 24h, so re-post takes no argument.

export async function getArchivedStories(
  limit?: number,
): Promise<{ ok: true; stories: Story[] } | { ok: false; message: string }> {
  try {
    const headers = await authHeader();
    const qs = limit ? `?limit=${limit}` : '';
    const res = await fetch(`${apiBase()}/api/stories/archive${qs}`, { headers });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, message: j.message ?? `HTTP ${res.status}` };
    }
    const json = await res.json();
    return { ok: true, stories: json.stories ?? [] };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

/** Re-activate an archived story for a fresh 24 hours. Stories have no term choice. */
export async function repostStory(
  storyId: string,
): Promise<{ ok: true; story: Story; expiresAt: string } | { ok: false; message: string }> {
  try {
    const headers = await authHeader();
    const res = await fetch(`${apiBase()}/api/stories/${storyId}/repost`, { method: 'POST', headers });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, message: j.message ?? `HTTP ${res.status}` };
    }
    const json = await res.json();
    return { ok: true, story: json.story, expiresAt: json.expiresAt };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

// ── Save to highlight ─────────────────────────────────────────────────────────

/**
 * Promote a story into a Highlight.
 *
 * @param expiresInHours Term for the new highlight, or `null` for permanent.
 *                       There is no default on either side of the wire — the
 *                       user picks the term, so the caller must pass one.
 */
export async function saveToHighlight(
  storyId: string,
  expiresInHours: number | null,
): Promise<{ ok: true; highlightId: string; permanent: boolean; expiresAt: string | null } | { ok: false; message: string }> {
  try {
    const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
    const res = await fetch(`${apiBase()}/api/stories/${storyId}/save-to-highlight`, {
      method: 'POST', headers, body: JSON.stringify({ expiresInHours }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, message: j.message ?? `HTTP ${res.status}` };
    }
    const json = await res.json();
    return {
      ok: true,
      highlightId: json.highlightId,
      permanent: json.permanent === true,
      expiresAt: json.expiresAt ?? null,
    };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
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
