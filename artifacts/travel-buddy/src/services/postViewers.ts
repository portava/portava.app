/**
 * postViewers — typed fetch wrappers for the who-saved and who-viewed endpoints.
 *
 * POST savers  → GET /api/posts/:postId/savers   (owner-only, privacy-filtered)
 * Profile viewers → GET /api/me/profile/viewers  (own viewers, 7-day window)
 *
 * Follows the freshToken / apiBase pattern used by highlights.ts and other services.
 */
import { freshToken as freshApiToken } from './apiToken.ts';
import { isSupabaseConfigured } from '../lib/supabase.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  try { return await freshApiToken(); } catch { return null; }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PostSaver {
  userId: string;
  handle: string;
  name: string | null;
  avatarUrl: string | null;
  isOfficial: boolean;
  savedAt: string;
}

export interface ProfileViewer {
  userId: string;
  handle: string;
  name: string | null;
  avatarUrl: string | null;
  isOfficial: boolean;
  viewedAt: string;
}

// ── fetchPostSavers ───────────────────────────────────────────────────────────

/**
 * Returns the paginated list of users who saved this post.
 * Only succeeds when the caller is the post author.
 */
export async function fetchPostSavers(
  postId: string,
  limit = 50,
): Promise<{ ok: boolean; data?: PostSaver[]; errorKind?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, errorKind: 'config_error' };
  try {
    const token = await freshToken();
    const r = await fetch(`${apiBase()}/api/posts/${postId}/savers?limit=${limit}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!r.ok) return { ok: false, errorKind: r.status === 403 ? 'forbidden' : 'api_error' };
    const body = await r.json();
    return { ok: true, data: (body.savers ?? []) as PostSaver[] };
  } catch {
    return { ok: false, errorKind: 'network_error' };
  }
}

// ── fetchProfileViewers ───────────────────────────────────────────────────────

/**
 * Returns up to 50 distinct users who viewed the current user's profile in the
 * last 7 days. Viewers who have opted out of profile discovery are omitted.
 */
export async function fetchProfileViewers(
  limit = 50,
): Promise<{ ok: boolean; data?: ProfileViewer[]; errorKind?: string }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, errorKind: 'config_error' };
  try {
    const token = await freshToken();
    const r = await fetch(`${apiBase()}/api/me/profile/viewers?limit=${limit}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!r.ok) return { ok: false, errorKind: 'api_error' };
    const body = await r.json();
    return { ok: true, data: (body.viewers ?? []) as ProfileViewer[] };
  } catch {
    return { ok: false, errorKind: 'network_error' };
  }
}
