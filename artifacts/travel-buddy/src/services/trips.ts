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

  // Refresh the session to guarantee a fresh, valid JWT before the insert.
  // This is the primary fix for 403s caused by stale or post-rotation tokens.
  const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;

  if (!session?.user?.id) {
    console.warn('[createTrip] no authenticated user after refresh:', refreshErr?.message);
    return null;
  }
  const uid = session.user.id;
  const tok = session.access_token;

  // Use a client that carries the token explicitly in the Authorization header,
  // so auth.uid() resolves on the DB side (default client wasn't attaching it on web).
  const db = authedClient(tok);
  const { data, error } = await db.from('trips').insert({
    owner_id: uid,
    title: input.title,
    destination_city: input.destinationCity,
    destination_country: input.destinationCountry ?? null,
    start_date: input.startDate ?? null,
    end_date: input.endDate ?? null,
    status: input.status ?? 'planning',
    visibility: input.visibility ?? 'private',
    cover_url: input.coverUrl ?? null,
  }).select('*').single();

  if (error) {
    console.warn('[createTrip] insert error:', error.message, 'code:', error.code, 'details:', error.details);
    return null;
  }
  if (!data) return null;
  return mapTrip(data);
}

export async function updateTrip(id: string, patch: Partial<CreateTripInput & { progress: number }>): Promise<TripRow | null> {
  if (!isSupabaseConfigured) return null;
  const row: any = {};
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.visibility !== undefined) row.visibility = patch.visibility;
  if (patch.coverUrl !== undefined) row.cover_url = patch.coverUrl;
  if (patch.progress !== undefined) row.progress = patch.progress;
  const { data, error } = await supabase.from('trips').update(row).eq('id', id).select('*').single();
  if (error || !data) return null;
  return mapTrip(data);
}

export async function deleteTrip(id: string): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  const { error } = await supabase.from('trips').delete().eq('id', id);
  return !error;
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
