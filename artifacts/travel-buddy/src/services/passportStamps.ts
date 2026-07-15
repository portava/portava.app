/**
 * Passport Stamps & Memories service
 * Calls the API server endpoints for the new stamp/memory/map system.
 * Uses the same fetch + freshToken pattern as other mobile services.
 */
import { supabase } from '../lib/supabase';

export type StampVisibility = 'public' | 'circle_only' | 'friends_only' | 'trip_crew' | 'private';
export type MemoryVisibility = 'public' | 'circle_only' | 'trip_crew' | 'private';

export interface StampDefinition {
  slug: string;
  name: string;
  iconUrl: string | null;
  /** AI-generated universal artwork image URL for this stamp definition. */
  universalArtworkUrl?: string | null;
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  stampType: string;
  category: string | null;
  description: string | null;
}

export interface PassportStampNew {
  id: string;
  stampDefinitionId: string | null;
  definition: StampDefinition | null;
  /** Legacy/fallback stamp type slug when definition is absent */
  stampType: string;
  country: string | null;
  city: string | null;
  neighborhood: string | null;
  titleOverride: string | null;
  placeId: string | null;
  planId: string | null;
  tripId: string | null;
  sourceType: string;
  verificationLevel: string;
  visibility: StampVisibility;
  displayOnPassport: boolean;
  isRevoked: boolean;
  earnedAt: string;
  createdAt: string;
}

export interface PassportMemory {
  id: string;
  status: 'suggested' | 'active' | 'dismissed';
  title: string | null;
  description: string | null;
  country: string | null;
  city: string | null;
  neighborhood: string | null;
  category: string | null;
  visibility: MemoryVisibility;
  verificationLevel: string;
  sourceType: string | null;
  photoUrl: string | null;
  planId: string | null;
  tripId: string | null;
  suggestionReason: string | null;
  earnedAt: string;
  createdAt: string;
}

export interface PassportMapMarker {
  country: string;
  city: string;
  neighborhood: string | null;
  stampCount: number;
  verificationLevel: string;
  displayLabel: string;
}

export interface PassportMapPayload {
  markers: PassportMapMarker[];
  countries: string[];
  cities: string[];
}

export interface PassportStats {
  countries: number;
  cities: number;
  neighborhoods: number;
  planStamps: number;
  hostStamps: number;
  hiddenGemStamps: number;
  safeReturnStamps: number;
  totalStamps: number;
}

export interface PassportVisibilityPrefs {
  defaultStampVisibility: StampVisibility;
  defaultMemoryVisibility: MemoryVisibility;
  showCityMap: boolean;
  showNeighborhoods: boolean;
  showPlanStamps: boolean;
  showSafeReturnStamps: boolean;
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** Test seam — set to a non-null string to bypass Supabase auth in tests. */
let _testAuthToken: string | null = null;
export function _setTestAuthToken(t: string | null): void { _testAuthToken = t; }

async function freshToken(): Promise<string | null> {
  if (_testAuthToken !== null) return _testAuthToken;
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
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

async function apiPost<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  const token = await freshToken();
  if (!token) return { ok: false, message: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}/api${path}`, {
      method: 'POST',
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

export { mapStamp, mapDefinition } from './passportStampMappers';
import { mapStamp } from './passportStampMappers';

function mapMemory(r: any): PassportMemory {
  return {
    id: r.id,
    status: r.status ?? 'active',
    title: r.title ?? null,
    description: r.description ?? null,
    country: r.country ?? null,
    city: r.city ?? null,
    neighborhood: r.neighborhood ?? null,
    category: r.category ?? null,
    visibility: r.visibility ?? 'private',
    verificationLevel: r.verification_level ?? r.verificationLevel ?? 'unverified',
    sourceType: r.source_type ?? r.sourceType ?? null,
    photoUrl: r.photo_url ?? r.photoUrl ?? null,
    planId: r.plan_id ?? r.planId ?? null,
    tripId: r.trip_id ?? r.tripId ?? null,
    suggestionReason: r.suggestion_reason ?? r.suggestionReason ?? null,
    earnedAt: r.earned_at ?? r.earnedAt ?? new Date().toISOString(),
    createdAt: r.created_at ?? r.createdAt ?? new Date().toISOString(),
  };
}

// ── Stamps ─────────────────────────────────────────────────────────────────

export async function getMyPassportStamps(filters?: {
  country?: string;
  city?: string;
  type?: string;
}): Promise<ApiResult<PassportStampNew[]>> {
  const params = new URLSearchParams();
  if (filters?.country) params.set('country', filters.country);
  if (filters?.city) params.set('city', filters.city);
  if (filters?.type) params.set('type', filters.type);
  const qs = params.toString();
  const res = await apiGet<{ stamps: any[] }>(`/stamps/me${qs ? `?${qs}` : ''}`);
  if (!res.ok) return { ok: false, message: res.message };
  return { ok: true, data: ((res.data as any)?.stamps ?? []).map(mapStamp) };
}

export async function getUserStampsByUsername(
  username: string,
): Promise<ApiResult<PassportStampNew[]>> {
  const res = await apiGet<{ stamps: any[] }>(`/stamps/profile/${encodeURIComponent(username)}`);
  if (!res.ok) return { ok: false, message: res.message };
  return { ok: true, data: ((res.data as any)?.stamps ?? []).map(mapStamp) };
}

export async function updateStampVisibility(
  stampId: string,
  visibility: StampVisibility,
): Promise<ApiResult<void>> {
  const res = await apiPatch<void>(`/me/passport/stamps/${stampId}`, { visibility });
  return res;
}

// ── Memories ───────────────────────────────────────────────────────────────

export async function getMyPassportMemories(): Promise<ApiResult<PassportMemory[]>> {
  const res = await apiGet<{ memories: any[] }>('/me/passport/memories');
  if (!res.ok) return { ok: false, message: res.message };
  return { ok: true, data: ((res.data as any)?.memories ?? []).map(mapMemory) };
}

export async function createPassportMemory(body: {
  title: string;
  description?: string;
  country?: string;
  city?: string;
  neighborhood?: string;
  category?: string;
  visibility?: MemoryVisibility;
  photoUrl?: string;
}): Promise<ApiResult<PassportMemory>> {
  const res = await apiPost<any>('/me/passport/memories', body);
  if (!res.ok) return { ok: false, message: res.message };
  return { ok: true, data: mapMemory((res.data as any)?.memory ?? res.data) };
}

export async function updatePassportMemory(
  memoryId: string,
  patch: {
    title?: string;
    description?: string | null;
    visibility?: MemoryVisibility;
    photoUrl?: string | null;
  },
): Promise<ApiResult<void>> {
  return apiPatch<void>(`/me/passport/memories/${memoryId}`, patch);
}

// ── Suggestions ────────────────────────────────────────────────────────────

export async function getMyPassportSuggestions(): Promise<ApiResult<PassportMemory[]>> {
  const res = await apiGet<{ suggestions: any[] }>('/me/passport/suggestions');
  if (!res.ok) return { ok: false, message: res.message };
  return { ok: true, data: ((res.data as any)?.suggestions ?? []).map(mapMemory) };
}

export async function acceptPassportSuggestion(
  memoryId: string,
  patch: { title?: string; visibility?: MemoryVisibility },
): Promise<ApiResult<void>> {
  return apiPost<void>(`/me/passport/suggestions/${memoryId}/accept`, patch);
}

export async function dismissPassportSuggestion(
  memoryId: string,
): Promise<ApiResult<void>> {
  return apiPost<void>(`/me/passport/suggestions/${memoryId}/dismiss`, {});
}

// ── Map ────────────────────────────────────────────────────────────────────

export async function getPassportMap(): Promise<ApiResult<PassportMapPayload>> {
  const res = await apiGet<PassportMapPayload>('/me/passport/map');
  if (!res.ok) return { ok: false, message: res.message };
  return { ok: true, data: res.data! };
}

// ── Stats ──────────────────────────────────────────────────────────────────

export async function getPassportStats(): Promise<ApiResult<PassportStats>> {
  const res = await apiGet<PassportStats>('/me/passport/stats');
  if (!res.ok) return { ok: false, message: res.message };
  return { ok: true, data: res.data! };
}

// ── Visibility Preferences ─────────────────────────────────────────────────

export async function getPassportVisibilityPrefs(): Promise<ApiResult<PassportVisibilityPrefs>> {
  const res = await apiGet<any>('/me/passport/visibility-preferences');
  if (!res.ok) return { ok: false, message: res.message };
  const d: any = res.data;
  return {
    ok: true,
    data: {
      defaultStampVisibility: d.defaultStampVisibility ?? d.default_stamp_visibility ?? 'public',
      defaultMemoryVisibility: d.defaultMemoryVisibility ?? d.default_memory_visibility ?? 'private',
      showCityMap: d.showCityMap ?? d.show_city_map ?? true,
      showNeighborhoods: d.showNeighborhoods ?? d.show_neighborhoods ?? true,
      showPlanStamps: d.showPlanStamps ?? d.show_plan_stamps ?? true,
      showSafeReturnStamps: d.showSafeReturnStamps ?? d.show_safe_return_stamps ?? false,
    },
  };
}

export async function updatePassportVisibilityPrefs(
  patch: Partial<PassportVisibilityPrefs>,
): Promise<ApiResult<void>> {
  return apiPatch<void>('/me/passport/visibility-preferences', patch);
}
