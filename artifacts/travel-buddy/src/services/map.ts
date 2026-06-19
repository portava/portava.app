/**
 * Map + location services. Backend contract for migration 0002. Privacy is enforced
 * by RLS in the DB; these wrappers never bypass it. This pass scaffolds the calls;
 * the Live Map UI does NOT render live locations yet.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';

export type LocationSharing = 'private' | 'circle' | 'public';

export interface MapPin {
  id: string;
  ownerId: string;
  tripId: string | null;
  title: string;
  category: string | null;
  lat: number | null;
  lng: number | null;
  city: string | null;
  isPrivate: boolean;
}

function mapPin(r: any): MapPin {
  return {
    id: r.id, ownerId: r.owner_id, tripId: r.trip_id, title: r.title,
    category: r.category, lat: r.lat, lng: r.lng, city: r.city, isPrivate: r.is_private,
  };
}

/** Pins the viewer is allowed to see (RLS: own pins + non-private pins on visible trips). */
export async function listMapPins(tripId?: string): Promise<MapPin[]> {
  if (!isSupabaseConfigured) return [];
  let q = supabase.from('map_pins').select('*');
  if (tripId) q = q.eq('trip_id', tripId);
  const { data, error } = await q;
  if (error || !data) return [];
  return data.map(mapPin);
}

export async function createMapPin(input: {
  title: string; tripId?: string; category?: string; lat?: number; lng?: number; city?: string; isPrivate?: boolean;
}): Promise<MapPin | null> {
  if (!isSupabaseConfigured) return null;
  const { data: s } = await supabase.auth.getSession();
  const uid = s.session?.user?.id;
  if (!uid) return null;
  const { data, error } = await supabase.from('map_pins').insert({
    owner_id: uid,
    trip_id: input.tripId ?? null,
    title: input.title,
    category: input.category ?? null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    city: input.city ?? null,
    is_private: input.isPrivate ?? true,   // private by default
  }).select('*').single();
  if (error || !data) return null;
  return mapPin(data);
}

/* ---------- Location privacy (default private; ghost mode) ---------- */
export interface LocationPrivacy {
  sharing: LocationSharing;
  ghostMode: boolean;
  staleMinutes: number;
}

export async function getMyLocationPrivacy(): Promise<LocationPrivacy> {
  const fallback: LocationPrivacy = { sharing: 'private', ghostMode: false, staleMinutes: 30 };
  if (!isSupabaseConfigured) return fallback;
  const { data: s } = await supabase.auth.getSession();
  const uid = s.session?.user?.id;
  if (!uid) return fallback;
  const { data } = await supabase.from('user_location_privacy').select('*').eq('user_id', uid).single();
  if (!data) return fallback;
  return { sharing: data.sharing, ghostMode: data.ghost_mode, staleMinutes: data.stale_minutes };
}

/** PATCH /me/location-privacy. Upserts; defaults stay private until user opts in. */
export async function updateMyLocationPrivacy(patch: Partial<LocationPrivacy>): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  const { data: s } = await supabase.auth.getSession();
  const uid = s.session?.user?.id;
  if (!uid) return false;
  const row: any = { user_id: uid };
  if (patch.sharing !== undefined) row.sharing = patch.sharing;
  if (patch.ghostMode !== undefined) row.ghost_mode = patch.ghostMode;
  if (patch.staleMinutes !== undefined) row.stale_minutes = patch.staleMinutes;
  const { error } = await supabase.from('user_location_privacy').upsert(row, { onConflict: 'user_id' });
  return !error;
}

/**
 * Circle members whose location the viewer is allowed to see. RLS does the gating;
 * this returns only rows the DB permits. UI does NOT render these yet (placeholder pass).
 */
export async function listVisibleCircleLocations(): Promise<{ userId: string; lat: number; lng: number; city: string | null }[]> {
  if (!isSupabaseConfigured) return [];
  const { data, error } = await supabase.from('user_locations').select('user_id, approx_lat, approx_lng, city');
  if (error || !data) return [];
  // RLS already filtered to visible rows; map shape.
  return data
    .filter((r: any) => r.approx_lat != null && r.approx_lng != null)
    .map((r: any) => ({ userId: r.user_id, lat: r.approx_lat, lng: r.approx_lng, city: r.city }));
}
