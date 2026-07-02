/**
 * Profiles + Trips services — typed wrappers over supabase-js. Map DB rows
 * (snake_case) to the app's types (camelCase). UI calls these, never supabase
 * tables directly.
 */
import { supabase, isSupabaseConfigured, authedClient } from '../lib/supabase';
import type { TripStatus, TripVisibility } from '../types/models';

/* ---------- Profiles ---------- */
export interface ProfileRow {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  homeCity: string | null;
  homeCountry: string | null;
  currentCity: string | null;
  travelStyle: string | null;
  interests: string[];
  verified: boolean;
  openToMeet: boolean;
  isPrivate: boolean;
  bio: string | null;
}

function mapProfile(r: any): ProfileRow {
  return {
    id: r.id, handle: r.handle, name: r.name, avatarUrl: r.avatar_url,
    homeCity: r.home_city, homeCountry: r.home_country, currentCity: r.current_city,
    travelStyle: r.travel_style, interests: r.interests ?? [], verified: r.verified,
    openToMeet: r.open_to_meet, isPrivate: r.is_private, bio: r.bio,
  };
}

export async function getMyProfile(): Promise<ProfileRow | null> {
  if (!isSupabaseConfigured) return null;
  const { data: s } = await supabase.auth.getSession();
  const uid = s.session?.user?.id;
  if (!uid) return null;
  const { data, error } = await supabase.from('profiles').select('*').eq('id', uid).single();
  if (error || !data) return null;
  return mapProfile(data);
}

export async function updateMyProfile(patch: Partial<ProfileRow>): Promise<ProfileRow | null> {
  if (!isSupabaseConfigured) return null;
  const { data: s } = await supabase.auth.getSession();
  const uid = s.session?.user?.id;
  if (!uid) return null;
  const row: any = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.bio !== undefined) row.bio = patch.bio;
  if (patch.avatarUrl !== undefined) row.avatar_url = patch.avatarUrl;
  if (patch.currentCity !== undefined) row.current_city = patch.currentCity;
  if (patch.openToMeet !== undefined) row.open_to_meet = patch.openToMeet;
  if (patch.isPrivate !== undefined) row.is_private = patch.isPrivate;
  if (patch.interests !== undefined) row.interests = patch.interests;
  const { data, error } = await supabase.from('profiles').update(row).eq('id', uid).select('*').single();
  if (error || !data) return null;
  return mapProfile(data);
}

/* ---------- Trips ---------- */
export interface TripRow {
  id: string;
  ownerId: string;
  title: string;
  destinationCity: string;
  destinationCountry: string | null;
  neighborhoods: string[];
  startDate: string | null;
  endDate: string | null;
  status: TripStatus;
  visibility: TripVisibility;
  travelStyle: string | null;
  openToMeet: boolean;
  coverUrl: string | null;
  progress: number;
}

function mapTrip(r: any): TripRow {
  return {
    id: r.id, ownerId: r.owner_id, title: r.title, destinationCity: r.destination_city,
    destinationCountry: r.destination_country, neighborhoods: r.neighborhoods ?? [],
    startDate: r.start_date, endDate: r.end_date, status: r.status, visibility: r.visibility,
    travelStyle: r.travel_style, openToMeet: r.open_to_meet, coverUrl: r.cover_url,
    progress: r.progress ?? 0,
  };
}

export async function listMyTrips(): Promise<TripRow[]> {
  if (!isSupabaseConfigured) return [];
  // RLS returns only trips the user can see; order by start date.
  const { data, error } = await supabase.from('trips').select('*').order('start_date', { ascending: true });
  if (error || !data) return [];
  return data.map(mapTrip);
}

export async function getTrip(id: string): Promise<TripRow | null> {
  if (!isSupabaseConfigured) return null;
  const { data, error } = await supabase.from('trips').select('*').eq('id', id).single();
  if (error || !data) return null;
  return mapTrip(data);
}

export interface CreateTripInput {
  title: string;
  destinationCity: string;
  destinationCountry?: string;
  startDate?: string;
  endDate?: string;
  status?: TripStatus;
  visibility?: TripVisibility;
  coverUrl?: string;
}

export async function createTrip(input: CreateTripInput): Promise<TripRow | null> {
  if (!isSupabaseConfigured) return null;

  // Get a fresh session token.
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;

  if (!session?.user?.id) {
    throw new Error('Auth error: No authenticated session');
  }

  // Route through the API server so the insert is done server-side with the
  // service role key — this bypasses PostgREST's JWT verification entirely,
  // which is necessary because the Supabase project uses ECC P-256 signing
  // while PostgREST on this project hasn't picked up the new key yet.
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const res = await fetch(`${apiBase}/api/trips`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      title: input.title,
      destinationCity: input.destinationCity,
      destinationCountry: input.destinationCountry,
      startDate: input.startDate,
      endDate: input.endDate,
      status: input.status ?? 'planning',
      visibility: input.visibility ?? 'private',
      coverUrl: input.coverUrl,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`API ${res.status}: ${err.error ?? res.statusText}`);
  }

  const data = await res.json();
  return mapTrip(data);
}

export async function updateTrip(id: string, patch: Partial<CreateTripInput & { progress: number }>): Promise<TripRow | null> {
  const token = await freshToken();
  if (!token) return null;
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const body: Record<string, any> = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.status !== undefined) body.status = patch.status;
  if (patch.visibility !== undefined) body.visibility = patch.visibility;
  if (patch.coverUrl !== undefined) body.coverUrl = patch.coverUrl;
  if (patch.progress !== undefined) body.progress = patch.progress;
  const res = await fetch(`${apiBase}/api/trips/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data ? mapTrip(data) : null;
}

export async function deleteTrip(id: string): Promise<boolean> {
  const token = await freshToken();
  if (!token) return false;
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const res = await fetch(`${apiBase}/api/trips/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}

/* ---------- Trip Invites ---------- */

export interface TripInvite {
  tripId: string;
  tripTitle: string;
  destinationCity: string;
  destinationCountry: string | null;
  startDate: string | null;
  endDate: string | null;
  coverUrl: string | null;
  invitedAt: string;
  inviter: {
    id: string;
    name: string;
    handle: string;
    avatarUrl: string | null;
  } | null;
}

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

export async function getPendingTripInvites(): Promise<TripInvite[]> {
  if (!isSupabaseConfigured) return [];
  const token = await freshToken();
  if (!token) return [];
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const res = await fetch(`${apiBase}/api/me/trip-invites/pending`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.invites ?? []) as TripInvite[];
}

export async function acceptTripInvite(tripId: string): Promise<void> {
  const token = await freshToken();
  if (!token) throw new Error('Not authenticated');
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const res = await fetch(`${apiBase}/api/trips/${tripId}/accept-invite`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message ?? `HTTP ${res.status}`);
  }
}

export async function declineTripInvite(tripId: string): Promise<void> {
  const token = await freshToken();
  if (!token) throw new Error('Not authenticated');
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const res = await fetch(`${apiBase}/api/trips/${tripId}/decline-invite`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message ?? `HTTP ${res.status}`);
  }
}

export async function addMember(tripId: string, userId: string, role: 'member' | 'invited' = 'member'): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  const { error } = await supabase.from('trip_members').insert({ trip_id: tripId, user_id: userId, role });
  return !error;
}

export async function removeMember(tripId: string, userId: string): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  const { error } = await supabase.from('trip_members').delete().eq('trip_id', tripId).eq('user_id', userId);
  return !error;
}
