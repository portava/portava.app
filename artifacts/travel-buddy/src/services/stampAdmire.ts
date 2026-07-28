/**
 * stampAdmire.ts — client for stamp admiration (Stamp Wave 2).
 * Fail-soft: null/false when the API is unconfigured or the flag is off, so
 * detail surfaces simply hide the admire affordance.
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function authedFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = await freshApiToken();
  return fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

export interface StampAdmirer {
  userId: string;
  admiredAt: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  /** True when the admirer holds verified traveler status. */
  verified?: boolean;
}

export interface AdmirersResult {
  count: number;
  admiredByMe: boolean;
  admirers: StampAdmirer[];
}

/** Admire a stamp. True on success (idempotent server-side). */
export async function admireStamp(userStampId: string): Promise<boolean> {
  if (!isSupabaseConfigured || !apiBase() || !userStampId) return false;
  try {
    const res = await authedFetch(`${apiBase()}/api/stamps/${userStampId}/admire`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Remove own admire. */
export async function unadmireStamp(userStampId: string): Promise<boolean> {
  if (!isSupabaseConfigured || !apiBase() || !userStampId) return false;
  try {
    const res = await authedFetch(`${apiBase()}/api/stamps/${userStampId}/admire`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Admirer list + count + whether the caller admires it. Null = feature unavailable. */
export async function getAdmirers(userStampId: string): Promise<AdmirersResult | null> {
  if (!isSupabaseConfigured || !apiBase() || !userStampId) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/stamps/${userStampId}/admirers`);
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.enabled === false) return null;
    return {
      count: Number(body?.count ?? 0),
      admiredByMe: body?.admiredByMe === true,
      admirers: Array.isArray(body?.admirers) ? body.admirers : [],
    };
  } catch {
    return null;
  }
}
