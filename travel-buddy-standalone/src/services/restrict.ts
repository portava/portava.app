import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { freshToken as freshApiToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

export interface RestrictResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface RestrictedUser {
  id: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
  restrictedAt: string;
}

export async function restrictUser(userId: string): Promise<RestrictResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/users/${encodeURIComponent(userId)}/restrict`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? 'Failed to restrict user' };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export async function unrestrictUser(userId: string): Promise<RestrictResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/users/${encodeURIComponent(userId)}/restrict`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? 'Failed to unrestrict user' };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export async function getRestrictList(): Promise<RestrictResult<RestrictedUser[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/me/restrictions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? 'Failed to load restriction list' };
    }
    const body = await res.json();
    return { ok: true, data: body.restricted ?? [] };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
