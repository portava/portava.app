import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken } from './apiToken.ts';

function apiBase(): string { return process.env.EXPO_PUBLIC_API_BASE_URL ?? ''; }
export type RecapStatus = 'draft' | 'reviewed' | 'published' | 'archived' | 'removed' | 'restored';
export interface PlaceRecap {
  id: string; place_id: string; status: RecapStatus; created_at: string; current_version_id: string | null;
}
export interface PlaceRecapDetail {
  recap: PlaceRecap;
  version: { id: string; version_number: number; title: string; summary: string; status: RecapStatus; place_snapshot: { name?: string; city?: string | null } } | null;
  chapters: Array<{ id: string; title: string; body: string; origin: 'manual' | 'compass_suggested' }>;
  snapshots: Array<{ source_id: string; snapshot_kind: 'place' | 'post' | 'media'; payload: { caption?: string | null; mediaUrl?: string | null; thumbnailUrl?: string | null; mediaType?: string | null } }>;
}

export type RecapRequest<T> = { data: T; error: null } | { data: null; error: 'unavailable' | 'disabled' | 'removed' | 'unauthorized' | 'network' | 'server' };
async function request<T>(path: string, init?: RequestInit): Promise<RecapRequest<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { data: null, error: 'unavailable' };
  const token = await freshToken(); if (!token) return { data: null, error: 'unauthorized' };
  try {
    const res = await fetch(`${apiBase()}/api${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
    if (res.ok) return { data: await res.json() as T, error: null };
    const body = await res.json().catch(() => null);
    const code = body?.error;
    return { data: null, error: code === 'feature_disabled' ? 'disabled' : code === 'not_found' ? 'removed' : res.status === 401 ? 'unauthorized' : 'server' };
  } catch { return { data: null, error: 'network' }; }
}
export async function listPlaceRecaps(placeId: string): Promise<PlaceRecap[]> {
  const result = await request<{ recaps: PlaceRecap[] }>(`/places/${encodeURIComponent(placeId)}/recaps`);
  return result.data?.recaps ?? [];
}
export async function getPlaceRecap(id: string): Promise<RecapRequest<PlaceRecapDetail>> {
  return request<PlaceRecapDetail>(`/place-recaps/${encodeURIComponent(id)}`);
}
export async function createPlaceDayRecap(placeDayId: string, title?: string): Promise<any | null> {
  return (await request('/place-recaps', { method: 'POST', body: JSON.stringify({ placeDayId, title }) })).data;
}
export async function recapAction(id: string, action: 'review' | 'publish' | 'regenerate' | 'archive' | 'restore'): Promise<any | null> {
  return (await request(`/place-recaps/${encodeURIComponent(id)}/${action}`, { method: 'POST' })).data;
}