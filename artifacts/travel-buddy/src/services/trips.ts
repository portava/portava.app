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
  // Route through the API server so the update uses the service role key,
  // bypassing PostgREST's JWT verification (P-256 key rotation issue).
  const token = await freshToken();
  if (!token) return null;
  const body: Record<string, unknown> = {};
  if (patch.name !== undefined) body.displayName = patch.name;
  if (patch.bio !== undefined) body.bio = patch.bio;
  if (patch.avatarUrl !== undefined) body.avatarUrl = patch.avatarUrl;
  if (patch.currentCity !== undefined) body.currentCity = patch.currentCity;
  if (patch.openToMeet !== undefined) body.openToMeet = patch.openToMeet;
  if (patch.isPrivate !== undefined) body.isPrivate = patch.isPrivate;
  if (patch.interests !== undefined) body.interests = patch.interests;
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const res = await fetch(`${apiBase}/api/me/profile`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data) return null;
  // API returns camelCase; map back to ProfileRow
  return {
    id: data.id,
    handle: data.handle ?? data.username ?? '',
    name: data.displayName ?? data.name ?? '',
    avatarUrl: data.avatarUrl ?? null,
    homeCity: data.homeCity ?? null,
    homeCountry: data.homeCountry ?? null,
    currentCity: data.currentCity ?? null,
    travelStyle: data.travelStyle ?? null,
    interests: data.interests ?? [],
    verified: data.verified ?? false,
    openToMeet: data.openToMeet ?? false,
    isPrivate: data.isPrivate ?? false,
    bio: data.bio ?? null,
  };
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
  tripType: string | null;
  timezone: string | null;
  destinationLat: number | null;
  destinationLng: number | null;
  destinationPlaceId: string | null;
  tripNotes: string | null;
  showOnProfile: boolean;
  showInDiscovery: boolean;
  allowFriendSuggestions: boolean;
  allowTripCrewInvites: boolean;
  allowJoinRequests: boolean;
  showExactDates: boolean;
  showDestinationCity: boolean;
  delayedPostingDefault: boolean;
  preciseLocationVisible: boolean;
  planEditPermission: string | null;
}

function mapTrip(r: any): TripRow {
  return {
    id: r.id, ownerId: r.owner_id, title: r.title, destinationCity: r.destination_city,
    destinationCountry: r.destination_country, neighborhoods: r.neighborhoods ?? [],
    startDate: r.start_date, endDate: r.end_date, status: r.status, visibility: r.visibility,
    travelStyle: r.travel_style, openToMeet: r.open_to_meet, coverUrl: r.cover_url,
    progress: r.progress ?? 0,
    tripType: r.trip_type ?? null,
    timezone: r.timezone ?? null,
    destinationLat: r.destination_lat ?? null,
    destinationLng: r.destination_lng ?? null,
    destinationPlaceId: r.destination_place_id ?? null,
    tripNotes: r.trip_notes ?? null,
    showOnProfile: r.show_on_profile ?? true,
    showInDiscovery: r.show_in_discovery ?? false,
    allowFriendSuggestions: r.allow_friend_suggestions ?? true,
    allowTripCrewInvites: r.allow_trip_crew_invites ?? true,
    allowJoinRequests: r.allow_join_requests ?? false,
    showExactDates: r.show_exact_dates ?? true,
    showDestinationCity: r.show_destination_city ?? true,
    delayedPostingDefault: r.delayed_posting_default ?? false,
    preciseLocationVisible: r.precise_location_visible ?? false,
    planEditPermission: r.plan_edit_permission ?? null,
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
  if (patch.destinationCity !== undefined) body.destinationCity = patch.destinationCity;
  if (patch.destinationCountry !== undefined) body.destinationCountry = patch.destinationCountry;
  if (patch.startDate !== undefined) body.startDate = patch.startDate;
  if (patch.endDate !== undefined) body.endDate = patch.endDate;
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
  visibility: string | null;
  memberCount: number | null;
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
  // Route through the API server (service role key) to bypass PostgREST RLS.
  const token = await freshToken();
  if (!token) return false;
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const res = await fetch(`${apiBase}/api/trips/${tripId}/members`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, role }),
  });
  return res.ok;
}

export async function removeMember(tripId: string, userId: string): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  // Route through the API server (service role key) to bypass PostgREST RLS.
  const token = await freshToken();
  if (!token) return false;
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const res = await fetch(`${apiBase}/api/trips/${tripId}/members/${userId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}

export interface TripInviteLink {
  id: string;
  token: string;
  maxUses: number | null;
  expiresAt: string | null;
  createdAt: string;
  /** Relative path returned by the server — build full URL with EXPO_PUBLIC_API_BASE_URL. */
  url: string;
}

/**
 * Create a single-use invite link for the given trip.
 * Requires the caller to be the trip owner (enforced by the API server).
 * Returns null on error (e.g. not authenticated, not owner, network failure).
 */
export async function createInviteLink(tripId: string): Promise<TripInviteLink | null> {
  const token = await freshToken();
  if (!token) return null;
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const res = await fetch(`${apiBase}/api/trips/${tripId}/invite-link`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export interface InvitePreview {
  tripId: string;
  tripTitle: string | null;
  destinationCity: string | null;
  destinationCountry: string | null;
  startDate: string | null;
  endDate: string | null;
  coverUrl: string | null;
  alreadyMember: boolean;
  linkId: string;
  expiresAt: string | null;
  /** Trip lifecycle status ('upcoming' | 'in_progress' | 'cancelled' | 'archived' | …). */
  tripStatus: string | null;
  /** True when the trip is in a terminal state (cancelled, archived, or end_date passed). */
  isTerminal: boolean;
  /** Human-readable explanation for isTerminal, or null when not terminal. */
  terminalReason: string | null;
}

export interface InvitePreviewResult {
  data: InvitePreview | null;
  gone?: boolean;
  error?: string;
}

/**
 * Fetch a non-sensitive preview of the trip for a given invite token.
 * Requires the caller to be authenticated; returns `error: 'not_authenticated'` if not.
 * Returns `gone: true` when the link is expired, revoked, or exhausted.
 */
export async function previewInviteLink(token: string): Promise<InvitePreviewResult> {
  const accessToken = await freshToken();
  if (!accessToken) return { data: null, error: 'not_authenticated' };
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const res = await fetch(
    `${apiBase}/api/trips/invite-link/${encodeURIComponent(token)}/preview`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (res.status === 410) return { data: null, gone: true };
  if (!res.ok) return { data: null };
  return { data: await res.json().catch(() => null) };
}

export interface AcceptInviteResult {
  tripId: string | null;
  alreadyMember: boolean;
  error?: string;
}

/**
 * Accept a trip invite by token. The user is added as a member if not already.
 * Returns `alreadyMember: true` when the user was already on the trip (idempotent).
 *
 * Retries automatically on network errors and 5xx responses (up to 2 extra
 * attempts with exponential backoff) so a momentary connection drop or proxy
 * hiccup does not leave the user stranded on an error screen.  4xx responses
 * (e.g. 410 Gone, 403 Forbidden) are never retried — they represent a definitive
 * server decision.
 */
export async function acceptInviteByToken(token: string): Promise<AcceptInviteResult> {
  const accessToken = await freshToken();
  if (!accessToken) return { tripId: null, alreadyMember: false, error: 'not_authenticated' };
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const url = `${apiBase}/api/trips/invite-link/${encodeURIComponent(token)}/accept`;

  const MAX_ATTEMPTS = 3;
  let lastError: string = 'error';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500 * attempt));
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        const errCode = (body?.error as string) ?? 'error';
        if (res.status >= 400 && res.status < 500) {
          return { tripId: null, alreadyMember: false, error: errCode };
        }
        lastError = errCode;
        continue;
      }
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      return {
        tripId: (body.tripId as string) ?? null,
        alreadyMember: body.status === 'already_member',
      };
    } catch {
      lastError = 'network_error';
    }
  }

  return { tripId: null, alreadyMember: false, error: lastError };
}

export interface InviteLinkJoiner {
  id: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  removed?: boolean;
}

export interface InviteLinkUsage {
  id: string;
  token: string;
  useCount: number;
  maxUses: number | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  isActive: boolean;
  isRevoked: boolean;
  isExpired: boolean;
  isExhausted: boolean;
  joiners: InviteLinkJoiner[];
}

/**
 * Fetch all invite links for a trip (owner only).
 * Each entry includes the list of users who joined via that link.
 */
export async function getInviteLinks(tripId: string): Promise<InviteLinkUsage[]> {
  const accessToken = await freshToken();
  if (!accessToken) return [];
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const res = await fetch(`${apiBase}/api/trips/${tripId}/invite-links`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];
  return res.json().catch(() => []);
}

/**
 * Revoke an invite link so it can no longer be used.
 * Only the trip owner can revoke links.
 */
export async function revokeInviteLink(tripId: string, linkId: string): Promise<boolean> {
  const accessToken = await freshToken();
  if (!accessToken) return false;
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const res = await fetch(`${apiBase}/api/trips/${tripId}/invite-link/${linkId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.ok || res.status === 204;
}
