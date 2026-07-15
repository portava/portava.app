/**
 * mapTravelers service — fetches travelers visible on the Discovery live map.
 *
 * The server does ALL privacy work: opt-in filtering, block filtering, and
 * coordinate coarsening (city centroid or ~2 km grid). Coordinates received
 * here are already safe to render as-is.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

export interface MapTraveler {
  id: string;
  handle: string | null;
  displayName: string;
  avatarUrl: string | null;
  verified: boolean;
  openToMeet: boolean;
  city: string | null;
  country: string | null;
  /** 'live' = active < 15 min ago; 'recent' = < 60 min. Server-computed. */
  freshness: 'live' | 'recent';
  /** 'city' = city-centroid placement; 'area' = ~2 km coarse grid. */
  precision: 'city' | 'area';
  lat: number;
  lng: number;
}

export async function getMapTravelers(
  lat: number,
  lng: number,
  radiusKm = 50,
): Promise<{ ok: true; data: MapTraveler[] } | { ok: false; error: string }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'Not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  const params = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    radiusKm: String(radiusKm),
  });

  try {
    const res = await fetch(`${apiBase()}/api/map/travelers?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? `Request failed (${res.status})` };
    }
    const body = (await res.json()) as { travelers?: MapTraveler[] };
    return { ok: true, data: Array.isArray(body.travelers) ? body.travelers : [] };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Network error' };
  }
}
