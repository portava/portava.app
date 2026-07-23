/**
 * stampShowcase.ts — client for the curated stamp showcase (Stamp Wave 2).
 * Fail-soft: returns null/[] when the API is unconfigured or the feature flag
 * is off server-side, so passport surfaces keep their existing states.
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

export const MAX_SHOWCASE = 8;

export interface ShowcaseStamp {
  userStampId: string;
  rank: number;
  earnedAt: string;
  city: string | null;
  country: string | null;
  titleOverride: string | null;
  definition: {
    slug: string;
    name: string;
    rarity: string;
    stampType: string;
    category: string;
    artworkUrl: string | null;
  } | null;
}

/** Own showcase, ordered. Null when the feature is unavailable. */
export async function getMyShowcase(): Promise<ShowcaseStamp[] | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  try {
    const res = await authedFetch(`${apiBase()}/api/stamps/showcase`);
    if (!res.ok) return null; // 503 = flag off → callers keep default UI
    const body = await res.json();
    return Array.isArray(body?.items) ? (body.items as ShowcaseStamp[]) : [];
  } catch {
    return null;
  }
}

/** Replace the showcase set. Order of ids = display order. */
export async function saveShowcase(userStampIds: string[]): Promise<boolean> {
  if (!isSupabaseConfigured || !apiBase()) return false;
  try {
    const res = await authedFetch(`${apiBase()}/api/stamps/showcase`, {
      method: 'PUT',
      body: JSON.stringify({ userStampIds: userStampIds.slice(0, MAX_SHOWCASE) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Public showcase for a username. Null = unavailable; [] = none/hidden. */
export async function getPublicShowcase(username: string): Promise<ShowcaseStamp[] | null> {
  if (!isSupabaseConfigured || !apiBase() || !username) return null;
  try {
    const res = await authedFetch(
      `${apiBase()}/api/users/${encodeURIComponent(username)}/stamp-showcase`,
    );
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.enabled === false) return null;
    return Array.isArray(body?.items) ? (body.items as ShowcaseStamp[]) : [];
  } catch {
    return null;
  }
}
