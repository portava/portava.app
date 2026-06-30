import { supabase, isSupabaseConfigured } from '../lib/supabase';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

export interface SaveResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface SavedUser {
  id: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
  savedAt: string;
}

export interface SaveStatus {
  userId: string;
  saved: boolean;
}

export async function saveUser(userId: string): Promise<SaveResult> {
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

export async function unsaveUser(userId: string): Promise<SaveResult> {
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
    return { ok: true, data: body as SaveStatus };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export async function getSaveList(): Promise<SaveResult<SavedUser[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/me/saves`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? 'Failed to load saves' };
    }
    const body = await res.json();
    return { ok: true, data: body.saves ?? [] };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
