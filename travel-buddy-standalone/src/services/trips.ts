/**
 * Profiles + Trips services — typed wrappers over the API server and supabase-js.
 * Map DB rows (snake_case) to the app's types (camelCase).
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import type { TripStatus, TripVisibility } from '../types/models';

/* ─────────────────────────────────────────────────────────────────────────────
   Auth helpers
   ───────────────────────────────────────────────────────────────────────────── */

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

function getApiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function apiFetch(path: string, opts: RequestInit = {}, requireAuth = true): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> | undefined),
  };
  if (requireAuth) {
    const token = await freshToken();
    if (!token) throw new Error('Not authenticated');
    headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(`${getApiBase()}${path}`, { ...opts, headers });
}

/* ─────────────────────────────────────────────────────────────────────────────
   Profiles
   ───────────────────────────────────────────────────────────────────────────── */

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

/* ─────────────────────────────────────────────────────────────────────────────
   Trips — core types
   ───────────────────────────────────────────────────────────────────────────── */

export interface TripRow {
  id: string;
  ownerId: string;
  title: string;
  destinationCity: string;
  destinationCountry: string | null;
  destinationLat: number | null;
  destinationLng: number | null;
  destinationPlaceId: string | null;
  neighborhoods: string[];
  startDate: string | null;
  endDate: string | null;
  status: TripStatus;
  visibility: TripVisibility;
  tripType: string | null;
  travelStyle: string | null;
  openToMeet: boolean;
  coverUrl: string | null;
  progress: number;
  tripNotes: string | null;
  allowJoinRequests: boolean;
  showOnProfile: boolean;
  showExactDates: boolean;
  allowTripCrewInvites: boolean;
  delayedPostingDefault: boolean;
  timezone: string | null;
}

function mapTrip(r: any): TripRow {
  return {
    id: r.id,
    ownerId: r.owner_id,
    title: r.title,
    destinationCity: r.destination_city,
    destinationCountry: r.destination_country ?? null,
    destinationLat: r.destination_lat ?? null,
    destinationLng: r.destination_lng ?? null,
    destinationPlaceId: r.destination_place_id ?? null,
    neighborhoods: r.neighborhoods ?? [],
    startDate: r.start_date ?? null,
    endDate: r.end_date ?? null,
    status: r.status,
    visibility: r.visibility,
    tripType: r.trip_type ?? null,
    travelStyle: r.travel_style ?? null,
    openToMeet: r.open_to_meet ?? false,
    coverUrl: r.cover_url ?? null,
    progress: r.progress ?? 0,
    tripNotes: r.trip_notes ?? null,
    allowJoinRequests: r.allow_join_requests ?? false,
    showOnProfile: r.show_on_profile ?? true,
    showExactDates: r.show_exact_dates ?? true,
    allowTripCrewInvites: r.allow_trip_crew_invites ?? true,
    delayedPostingDefault: r.delayed_posting_default ?? false,
    timezone: r.timezone ?? null,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   Trips — list / read
   ───────────────────────────────────────────────────────────────────────────── */

/** All my trips via the API server (correct JWT verification, bypasses RLS issues). */
export async function listMyTrips(): Promise<TripRow[]> {
  if (!isSupabaseConfigured) return [];
  try {
    const res = await apiFetch('/api/trips/me');
    if (!res.ok) return [];
    const data = await res.json();
    return (data.trips ?? []).map(mapTrip);
  } catch {
    return [];
  }
}

export async function getTrip(id: string): Promise<TripRow | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const res = await apiFetch(`/api/trips/${id}`);
    if (!res.ok) return null;
    const data = await res.json();
    return mapTrip(data);
  } catch {
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Trips — create / update / delete
   ───────────────────────────────────────────────────────────────────────────── */

export interface CreateTripInput {
  title: string;
  destinationCity: string;
  destinationCountry?: string;
  destinationLat?: number;
  destinationLng?: number;
  destinationPlaceId?: string;
  startDate?: string;
  endDate?: string;
  status?: TripStatus;
  visibility?: TripVisibility;
  coverUrl?: string;
  tripType?: string;
  travelStyle?: string;
  openToMeet?: boolean;
  allowJoinRequests?: boolean;
  showOnProfile?: boolean;
  showExactDates?: boolean;
  delayedPostingDefault?: boolean;
  timezone?: string;
  tripNotes?: string;
}

export async function createTrip(input: CreateTripInput): Promise<TripRow | null> {
  if (!isSupabaseConfigured) return null;

  const res = await apiFetch('/api/trips', {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      destinationCity: input.destinationCity,
      destinationCountry: input.destinationCountry,
      destinationLat: input.destinationLat,
      destinationLng: input.destinationLng,
      destinationPlaceId: input.destinationPlaceId,
      startDate: input.startDate,
      endDate: input.endDate,
      status: input.status ?? 'planning',
      visibility: input.visibility ?? 'private',
      coverUrl: input.coverUrl,
      tripType: input.tripType,
      travelStyle: input.travelStyle,
      openToMeet: input.openToMeet ?? false,
      allowJoinRequests: input.allowJoinRequests ?? false,
      showOnProfile: input.showOnProfile ?? true,
      showExactDates: input.showExactDates ?? true,
      delayedPostingDefault: input.delayedPostingDefault ?? false,
      timezone: input.timezone,
      tripNotes: input.tripNotes,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`API ${res.status}: ${err.error ?? res.statusText}`);
  }

  const data = await res.json();
  return mapTrip(data);
}

export type UpdateTripInput = Partial<Omit<CreateTripInput, 'title'> & { title: string; progress: number }>;

export async function updateTrip(id: string, patch: UpdateTripInput): Promise<TripRow | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const res = await apiFetch(`/api/trips/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return mapTrip(data);
  } catch {
    return null;
  }
}

export async function deleteTrip(id: string): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  try {
    const res = await apiFetch(`/api/trips/${id}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Trip members
   ───────────────────────────────────────────────────────────────────────────── */

export interface TripMember {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  role: 'owner' | 'co_host' | 'member' | 'viewer' | 'invited';
  followsYou: boolean;
  youFollow: boolean;
}

export async function listTripMembers(tripId: string): Promise<{ members: TripMember[]; invited: TripMember[] }> {
  try {
    const res = await apiFetch(`/api/trips/${tripId}/members`);
    if (!res.ok) return { members: [], invited: [] };
    const data = await res.json();
    return {
      members: (data.members ?? []).map((m: any) => ({ ...m, role: 'member' as const })),
      invited: (data.invited ?? []).map((m: any) => ({ ...m, role: 'invited' as const })),
    };
  } catch {
    return { members: [], invited: [] };
  }
}

export interface InvitableUser {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  section: 'group' | 'followers';
}

export async function listInvitableUsers(tripId: string): Promise<InvitableUser[]> {
  try {
    const res = await apiFetch(`/api/trips/${tripId}/invitable-users`);
    if (!res.ok) return [];
    const data = await res.json();
    const group = (data.groupMembers ?? []).map((u: any) => ({ ...u, avatarUrl: u.avatarUrl ?? u.avatar_url ?? null, section: 'group' as const }));
    const others = (data.otherFollowers ?? []).map((u: any) => ({ ...u, avatarUrl: u.avatarUrl ?? u.avatar_url ?? null, section: 'followers' as const }));
    return [...group, ...others];
  } catch {
    return [];
  }
}

export async function inviteMember(tripId: string, userId: string, role: 'member' | 'viewer' = 'member'): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/trips/${tripId}/invite`, {
      method: 'POST',
      body: JSON.stringify({ userId, role }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Trip invites
   ───────────────────────────────────────────────────────────────────────────── */

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

export async function getPendingTripInvites(): Promise<TripInvite[]> {
  if (!isSupabaseConfigured) return [];
  try {
    const res = await apiFetch('/api/me/trip-invites/pending');
    if (!res.ok) return [];
    const data = await res.json();
    return (data.invites ?? []) as TripInvite[];
  } catch {
    return [];
  }
}

export async function acceptTripInvite(tripId: string): Promise<void> {
  const res = await apiFetch(`/api/trips/${tripId}/accept-invite`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message ?? `HTTP ${res.status}`);
  }
}

export async function declineTripInvite(tripId: string): Promise<void> {
  const res = await apiFetch(`/api/trips/${tripId}/decline-invite`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message ?? `HTTP ${res.status}`);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Join requests
   ───────────────────────────────────────────────────────────────────────────── */

export interface JoinRequest {
  requestId: string;
  tripId: string;
  tripTitle: string;
  destinationCity: string;
  status: 'pending' | 'approved' | 'declined';
  requestedAt: string;
  requester: {
    id: string;
    name: string;
    handle: string;
    avatarUrl: string | null;
  } | null;
}

export async function listIncomingJoinRequests(): Promise<JoinRequest[]> {
  if (!isSupabaseConfigured) return [];
  try {
    const res = await apiFetch('/api/trips/join-requests');
    if (!res.ok) return [];
    const data = await res.json();
    return (data.requests ?? []) as JoinRequest[];
  } catch {
    return [];
  }
}

export async function approveJoinRequest(tripId: string, requestId: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/trips/${tripId}/join-requests/${requestId}/approve`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function declineJoinRequest(tripId: string, requestId: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/trips/${tripId}/join-requests/${requestId}/decline`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Invite links
   ───────────────────────────────────────────────────────────────────────────── */

export interface InviteLink {
  id: string;
  token: string;
  url: string;
  expiresAt: string | null;
}

export async function generateInviteLink(tripId: string): Promise<InviteLink | null> {
  try {
    const res = await apiFetch(`/api/trips/${tripId}/invite-link`, { method: 'POST' });
    if (!res.ok) return null;
    return await res.json() as InviteLink;
  } catch {
    return null;
  }
}

export async function revokeInviteLink(tripId: string, linkId: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/trips/${tripId}/invite-link/${linkId}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Budget
   ───────────────────────────────────────────────────────────────────────────── */

export interface TripBudget {
  id: string;
  totalBudget: number | null;
  dailyBudget: number | null;
  lodgingBudget: number | null;
  foodBudget: number | null;
  nightlifeBudget: number | null;
  transportBudget: number | null;
  activitiesBudget: number | null;
  currency: string;
  isPrivate: boolean;
}

function mapBudget(r: any): TripBudget {
  return {
    id: r.id,
    totalBudget: r.total_budget ?? null,
    dailyBudget: r.daily_budget ?? null,
    lodgingBudget: r.lodging_budget ?? null,
    foodBudget: r.food_budget ?? null,
    nightlifeBudget: r.nightlife_budget ?? null,
    transportBudget: r.transport_budget ?? null,
    activitiesBudget: r.activities_budget ?? null,
    currency: r.currency ?? 'USD',
    isPrivate: r.is_private ?? true,
  };
}

export async function getTripBudget(tripId: string): Promise<TripBudget | null> {
  try {
    const res = await apiFetch(`/api/trips/${tripId}/budget`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.budget ? mapBudget(data.budget) : null;
  } catch {
    return null;
  }
}

export async function upsertTripBudget(tripId: string, budget: Partial<Omit<TripBudget, 'id'>>): Promise<TripBudget | null> {
  try {
    const res = await apiFetch(`/api/trips/${tripId}/budget`, {
      method: 'PUT',
      body: JSON.stringify(budget),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.budget ? mapBudget(data.budget) : null;
  } catch {
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Notes
   ───────────────────────────────────────────────────────────────────────────── */

export interface TripNote {
  id: string;
  content: string;
  isPrivate: boolean;
  createdAt: string;
}

function mapNote(r: any): TripNote {
  return {
    id: r.id,
    content: r.content ?? '',
    isPrivate: r.is_private ?? false,
    createdAt: r.created_at,
  };
}

export async function listTripNotes(tripId: string): Promise<TripNote[]> {
  try {
    const res = await apiFetch(`/api/trips/${tripId}/notes`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.notes ?? []).map(mapNote);
  } catch {
    return [];
  }
}

export async function createTripNote(tripId: string, content: string, isPrivate = false): Promise<TripNote | null> {
  try {
    const res = await apiFetch(`/api/trips/${tripId}/notes`, {
      method: 'POST',
      body: JSON.stringify({ content, isPrivate }),
    });
    if (!res.ok) return null;
    return mapNote(await res.json());
  } catch {
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Checklists
   ───────────────────────────────────────────────────────────────────────────── */

export interface TripChecklistItem {
  id: string;
  text: string;
  isChecked: boolean;
  position: number;
}

export interface TripChecklist {
  id: string;
  title: string;
  items: TripChecklistItem[];
  createdAt: string;
}

function mapChecklist(r: any): TripChecklist {
  return {
    id: r.id,
    title: r.title ?? 'Checklist',
    items: (r.items ?? []).map((it: any) => ({
      id: it.id,
      text: it.text ?? '',
      isChecked: it.is_checked ?? false,
      position: it.position ?? 0,
    })),
    createdAt: r.created_at,
  };
}

export async function listTripChecklists(tripId: string): Promise<TripChecklist[]> {
  try {
    const res = await apiFetch(`/api/trips/${tripId}/checklists`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.checklists ?? []).map(mapChecklist);
  } catch {
    return [];
  }
}

export async function createTripChecklist(tripId: string, title: string): Promise<TripChecklist | null> {
  try {
    const res = await apiFetch(`/api/trips/${tripId}/checklists`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    if (!res.ok) return null;
    return mapChecklist(await res.json());
  } catch {
    return null;
  }
}

export async function addChecklistItem(tripId: string, checklistId: string, text: string): Promise<TripChecklistItem | null> {
  try {
    const res = await apiFetch(`/api/trips/${tripId}/checklists/${checklistId}/items`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return { id: d.id, text: d.text ?? text, isChecked: d.is_checked ?? false, position: d.position ?? 0 };
  } catch {
    return null;
  }
}

export async function toggleChecklistItem(tripId: string, checklistId: string, itemId: string, isChecked: boolean): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/trips/${tripId}/checklists/${checklistId}/items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ isChecked }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Activity log
   ───────────────────────────────────────────────────────────────────────────── */

export interface TripActivityEntry {
  id: string;
  actorId: string;
  eventType: string;
  metadata: Record<string, any>;
  createdAt: string;
}

export async function getTripActivity(tripId: string): Promise<TripActivityEntry[]> {
  try {
    const res = await apiFetch(`/api/trips/${tripId}/activity`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.activity ?? []).map((e: any) => ({
      id: e.id,
      actorId: e.actor_id,
      eventType: e.event_type,
      metadata: e.metadata ?? {},
      createdAt: e.created_at,
    }));
  } catch {
    return [];
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Legacy helpers kept for backward compat
   ───────────────────────────────────────────────────────────────────────────── */

export async function addMember(tripId: string, userId: string, role: 'member' | 'invited' = 'member'): Promise<boolean> {
  return inviteMember(tripId, userId, role === 'invited' ? 'member' : role);
}

export async function removeMember(tripId: string, userId: string): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  const { error } = await supabase.from('trip_members').delete().eq('trip_id', tripId).eq('user_id', userId);
  return !error;
}
