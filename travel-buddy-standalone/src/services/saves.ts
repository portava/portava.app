import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

export interface SaveResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface SaveStatus {
  userId: string;
  isSaved: boolean;
}

export async function saveProfile(userId: string): Promise<SaveResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/users/${encodeURIComponent(userId)}/save`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? 'Failed to save profile' };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export async function unsaveProfile(userId: string): Promise<SaveResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/users/${encodeURIComponent(userId)}/save`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? 'Failed to unsave profile' };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export async function getSaveStatus(userId: string): Promise<SaveResult<SaveStatus>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/users/${encodeURIComponent(userId)}/save-status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? 'Failed to fetch save status' };
    }
    const body = await res.json();
    return { ok: true, data: toSaveStatus(userId, body) }; // the route answers { userId, saved } — TM-social PLAT-F16
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/**
 * GET /users/:userId/save-status answers `{ userId, saved }` (routes/saves.ts).
 * The client type says `isSaved`, and the cast that used to stand here made
 * `isSaved` permanently undefined — so a saved profile always offered "Save
 * profile" again and could never be unsaved from its own menu. Both spellings
 * are accepted; anything else is "not saved", never a guess.
 */
export function toSaveStatus(userId: string, body: unknown): SaveStatus {
  const b = (body ?? {}) as { userId?: unknown; saved?: unknown; isSaved?: unknown };
  return {
    userId: typeof b.userId === 'string' ? b.userId : userId,
    isSaved: b.saved === true || b.isSaved === true,
  };
}

export interface SavedProfile {
  id: string;
  handle: string | null;
  /** Real name only when the saved user opted in; otherwise null (show @handle). */
  name: string | null;
  avatarUrl: string | null;
  savedAt: string;
}

/**
 * GET /me/saves — the people I have saved, newest first.
 *
 * An error is an error: the saved-people screen shows "couldn't load" with a
 * retry, never an empty list, when this read fails (DV-83). The server has
 * already removed anyone in a block relation with me.
 */
export async function getMySavedProfiles(): Promise<SaveResult<SavedProfile[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/me/saves`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? 'Failed to load saved people' };
    }
    const body = (await res.json()) as { saves?: unknown };
    if (!Array.isArray(body?.saves)) return { ok: false, error: 'Unexpected response' };
    return {
      ok: true,
      data: (body.saves as any[]).map((s) => ({
        id: String(s.id),
        handle: typeof s.handle === 'string' ? s.handle : null,
        name: typeof s.name === 'string' ? s.name : null,
        avatarUrl: typeof s.avatarUrl === 'string' ? s.avatarUrl : null,
        savedAt: String(s.savedAt ?? ''),
      })),
    };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Network error' };
  }
}
