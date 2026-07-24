/**
 * Stamps service — typed wrappers for the new stamp API endpoints.
 * Re-exports shared types + functions from passportStamps.ts and
 * adds new endpoints: getRecentStamps, getMyProgress, toggleDisplayOnPassport.
 */
export {
  getMyPassportStamps as getMyStamps,
  getUserStampsByUsername,
  getMyPassportStamps,
} from './passportStamps.ts';

export type {
  PassportStampNew,
  StampDefinition,
  StampVisibility,
} from './passportStamps.ts';

/** Visibility values used by the new /api/stamps/* endpoints (v2). */
export type NewStampVisibility = 'public' | 'friends_only' | 'private';

import { supabase } from '../lib/supabase.ts';
import type { PassportStampNew, StampDefinition } from './passportStamps.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** Test seam — set to a non-null string to bypass Supabase auth in tests. */
let _testAuthToken: string | null = null;
export function _setTestAuthToken(t: string | null): void { _testAuthToken = t; }

async function freshToken(): Promise<string | null> {
  if (_testAuthToken !== null) return _testAuthToken;
  return freshApiToken();
}

async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const token = await freshToken();
  if (!token) return { ok: false, message: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, message: (body as any)?.message ?? `API ${res.status}` };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Network error' };
  }
}

async function apiPatch<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  const token = await freshToken();
  if (!token) return { ok: false, message: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api${path}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, message: (b as any)?.message ?? `API ${res.status}` };
    }
    if (res.status === 204) return { ok: true, data: {} as T };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Network error' };
  }
}

function mapDefinition(d: any): StampDefinition | null {
  if (!d) return null;
  return {
    slug:        d.slug ?? '',
    name:        d.name ?? '',
    iconUrl:     d.icon_url ?? d.iconUrl ?? null,
    rarity:      d.rarity ?? 'common',
    stampType:   d.stamp_type ?? d.stampType ?? 'city',
    category:    d.category ?? null,
    description: d.description ?? null,
  };
}

function mapStamp(r: any): PassportStampNew {
  const def = mapDefinition(r.definition ?? r.stamp_definitions ?? null);
  return {
    id:                r.id,
    stampDefinitionId: r.stamp_definition_id ?? r.stampDefinitionId ?? null,
    definition:        def,
    stampType:         def?.stampType ?? r.stamp_type ?? r.stampType ?? 'city',
    country:           r.country ?? null,
    city:              r.city ?? null,
    neighborhood:      r.neighborhood ?? null,
    titleOverride:     r.title_override ?? r.titleOverride ?? null,
    placeId:           r.place_id ?? r.placeId ?? null,
    planId:            r.plan_id ?? r.planId ?? null,
    tripId:            r.trip_id ?? r.tripId ?? null,
    sourceType:        r.source_type ?? r.sourceType ?? 'system',
    verificationLevel: r.verification_level ?? r.verificationLevel ?? 'unverified',
    visibility:        r.visibility ?? 'public',
    displayOnPassport: r.display_on_passport ?? r.displayOnPassport ?? true,
    isRevoked:         r.is_revoked ?? r.isRevoked ?? false,
    earnedAt:          r.earned_at ?? r.earnedAt ?? new Date().toISOString(),
    createdAt:         r.created_at ?? r.createdAt ?? new Date().toISOString(),
    catalogId:         r.catalog_id ?? r.catalogId ?? null,
    activeArtworkUrl:  r.active_artwork_url ?? r.activeArtworkUrl ?? null,
    thumbnailUrl:      r.thumbnail_url ?? r.thumbnailUrl ?? null,
  };
}

export interface StampProgress {
  nextStamp: {
    slug: string;
    name: string;
    description: string | null;
    progressPct: number;
  } | null;
}

/**
 * GET /stamps/me — caller's own stamps, newest first.
 * Used by the StampEarnedToast to detect newly earned stamps.
 * Deliberately scoped to the signed-in user so we never surface
 * other users' stamps in the earned-toast queue.
 */
export async function getMyRecentStamps(limit = 20): Promise<ApiResult<PassportStampNew[]>> {
  const res = await apiGet<{ stamps: any[] }>(`/stamps/me?limit=${limit}`);
  if (!res.ok) return { ok: false, message: res.message };
  return { ok: true, data: ((res.data as any)?.stamps ?? []).map(mapStamp) };
}

/** @deprecated Use getMyRecentStamps() — /stamps/recent returns globally public stamps. */
export async function getRecentStamps(): Promise<ApiResult<PassportStampNew[]>> {
  return getMyRecentStamps();
}

/**
 * GET /stamps/user/:userId — another user's stamps (visibility-gated).
 * Returns only public (and friends_only if caller is a friend) stamps.
 */
export async function getUserStamps(
  userId: string,
  filters?: { city?: string; country?: string },
): Promise<ApiResult<PassportStampNew[]>> {
  const params = new URLSearchParams();
  if (filters?.city)    params.set('city', filters.city);
  if (filters?.country) params.set('country', filters.country);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await apiGet<{ stamps: any[] }>(`/stamps/user/${encodeURIComponent(userId)}${qs}`);
  if (!res.ok) return { ok: false, message: res.message };
  return { ok: true, data: ((res.data as any)?.stamps ?? []).map(mapStamp) };
}

/** GET /stamps/me/progress — next achievable stamp progress. */
export async function getMyProgress(): Promise<ApiResult<StampProgress>> {
  const res = await apiGet<{ progress: any[] }>('/stamps/me/progress');
  if (!res.ok) return { ok: false, message: res.message };

  const items: any[] = res.data?.progress ?? [];
  const incomplete = items
    .filter((p) => p.progress_target > 0 && p.progress_count < p.progress_target)
    .map((p) => ({
      slug:        (p.stamp_definitions?.slug ?? '') as string,
      name:        (p.stamp_definitions?.name ?? '') as string,
      description: null as string | null,
      progressPct: Math.round((p.progress_count / p.progress_target) * 100),
    }))
    .sort((a, b) => b.progressPct - a.progressPct);

  return { ok: true, data: { nextStamp: incomplete[0] ?? null } };
}

/** PATCH /stamps/:userStampId/visibility — update stamp visibility (owner only). */
export async function updateStampVisibility(
  userStampId: string,
  visibility: NewStampVisibility,
): Promise<ApiResult<void>> {
  return apiPatch<void>(`/stamps/${userStampId}/visibility`, { visibility });
}

/** PATCH /stamps/:userStampId/display — toggle display_on_passport (owner only). */
export async function toggleDisplayOnPassport(
  userStampId: string,
  display: boolean,
): Promise<ApiResult<void>> {
  return apiPatch<void>(`/stamps/${userStampId}/display`, { displayOnPassport: display });
}

/** GET /stamps/profile/:username — public stamps for a given username. */
export async function getProfileStamps(
  username: string,
): Promise<ApiResult<PassportStampNew[]>> {
  const res = await apiGet<{ stamps: any[] }>(`/stamps/profile/${encodeURIComponent(username)}`);
  if (!res.ok) return { ok: false, message: res.message };
  return { ok: true, data: ((res.data as any)?.stamps ?? []).map(mapStamp) };
}

/**
 * GET /stamps/:stampId — fetch a single stamp by its user_stamp ID.
 * Returns full details for the owner; visibility-gated for others.
 */
export async function getStampById(
  stampId: string,
): Promise<ApiResult<{ stamp: PassportStampNew; isOwner: boolean }>> {
  const token = await freshToken();
  if (!token) return { ok: false, message: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/stamps/${encodeURIComponent(stampId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return { ok: false, message: 'Stamp not found' };
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, message: (body as any)?.message ?? `API ${res.status}` };
    }
    const json = await res.json();
    const stamp = mapStamp((json as any).stamp);
    const { data: { user } } = await supabase.auth.getUser();
    // formatStamp() in the API server converts user_id → userId (camelCase)
    const isOwner = user?.id != null && (json as any).stamp?.userId === user.id;
    return { ok: true, data: { stamp, isOwner } };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Network error' };
  }
}
