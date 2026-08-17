import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';
import { serviceFailure, thrownFailure } from './serviceFailure.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

export interface BlockResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface BlockedUser {
  id: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
  blockedAt: string;
}

export interface BlockStatus {
  userId: string;
  iBlocked: boolean;
  theyBlockedMe: boolean;
}

export async function blockUser(userId: string): Promise<BlockResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/users/${encodeURIComponent(userId)}/block`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? 'Failed to block user' };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: thrownFailure('blocks', e) };
  }
}

export async function unblockUser(userId: string): Promise<BlockResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/users/${encodeURIComponent(userId)}/block`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? 'Failed to unblock user' };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: thrownFailure('blocks', e) };
  }
}

export async function getBlockList(): Promise<BlockResult<BlockedUser[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/me/blocks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? 'Failed to load block list' };
    }
    const body = await res.json();
    return { ok: true, data: body.blocked ?? [] };
  } catch (e: any) {
    return { ok: false, error: thrownFailure('blocks', e) };
  }
}

export async function getBlockerIds(): Promise<BlockResult<string[]>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/me/blocker-ids`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? 'Failed to load blocker ids' };
    }
    const body = await res.json();
    return { ok: true, data: body.ids ?? [] };
  } catch (e: any) {
    return { ok: false, error: thrownFailure('blocks', e) };
  }
}

export async function getBlockStatus(userId: string): Promise<BlockResult<BlockStatus>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/users/${encodeURIComponent(userId)}/block-status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? 'Failed to fetch block status' };
    }
    const body = await res.json();
    return { ok: true, data: body as BlockStatus };
  } catch (e: any) {
    return { ok: false, error: thrownFailure('blocks', e) };
  }
}
