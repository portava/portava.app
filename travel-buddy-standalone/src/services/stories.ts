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
    const response = await fetch(await videoUriForUpload(localUri, mediaType.startsWith('video/'))); // §37 MD282: localUri itself unless a compressor module is in the binary and switched on
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
    const json = await uploadRes.json(); if (mediaType.startsWith('video/')) void attachPosterInBackground(json?.path, localUri, token); // §37 poster
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

// ── Save to highlight ─────────────────────────────────────────────────────────

export async function saveToHighlight(storyId: string): Promise<{ ok: true; highlightId: string } | { ok: false; message: string }> {
  try { // The route CREATES a Highlight from the story (no highlightId is read); a 409 says why this audience cannot.
    const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
    const res = await fetch(`${apiBase()}/api/stories/${storyId}/save-to-highlight`, {
      method: 'POST', headers, body: JSON.stringify({}),
    }); const j = await res.json().catch(() => null) as { highlightId?: unknown; message?: string } | null;
    return res.ok && typeof j?.highlightId === 'string' ? { ok: true, highlightId: j.highlightId as string } : { ok: false, message: j?.message ?? 'Could not save this story to your highlights. Please try again.' };
  } catch { return { ok: false, message: 'You appear to be offline. Check your connection and try again.' }; }
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

// §37 (census-media §22): a story video gets its poster, attached in the
// background. Imported at the TAIL so no line above moves; ESM hoists it.
import { attachPosterInBackground } from './media/generalVideoPoster.ts';
// §37 MD282 (census-media §37): the device compression seam. At the TAIL for the same reason.
import { videoUriForUpload } from './media/videoCompression.ts';

// ── Your own live stories (PLAT-F33) ──────────────────────────────────────────
// GET /me/stories. The feed never includes the viewer's own stories, so this is
// how the owner opens the story they posted (and reaches save-to-highlight).
// Appended at the foot so no cited line above moves.
export async function getMyStories(): Promise<{ ok: true; user: StoryFeedUser } | { ok: false; disabled: boolean; message: string }> {
  try {
    const res = await fetch(`${apiBase()}/api/me/stories`, { headers: await authHeader() });
    const j = await res.json().catch(() => null) as { error?: string; message?: string; author?: StoryAuthor; stories?: Story[] } | null;
    if (!res.ok) return { ok: false, disabled: j?.error === 'feature_disabled', message: j?.message ?? 'Your stories could not be loaded.' };
    if (!j?.author || !Array.isArray(j.stories)) return { ok: false, disabled: false, message: 'Your stories could not be read.' };
    return { ok: true, user: { ...j.author, stories: j.stories, hasUnviewed: false } };
  } catch {
    return { ok: false, disabled: false, message: 'You appear to be offline. Check your connection and try again.' };
  }
}
