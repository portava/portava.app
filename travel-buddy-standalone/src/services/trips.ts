/**
 * Profiles + Trips services — typed wrappers over supabase-js. Map DB rows
 * (snake_case) to the app's types (camelCase). UI calls these, never supabase
 * tables directly.
 */
import { supabase, isSupabaseConfigured, authedClient } from '../lib/supabase.ts';
import type { TripStatus, TripVisibility } from '../types/models.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

const API_BASE = (() => {
  const d = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  return d.endsWith('/') ? d.slice(0, -1) : d;
})();

/** Converts server-relative /api/... cover URLs to absolute so React Native image loaders work. */
function resolveApiUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/')) return `${API_BASE}${url}`;
  return url;
}

// NOTE: profile reads/updates must go through services/profile.ts
// (getMyProfile / updateMyProfile), which surfaces partial saves
// (`partial_save` / unsavedFields) and typed errors — do not re-add them here.

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
  coverMediaType: 'image' | 'video' | null;
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
  /** Whether non-members can see the trip's cover image. Default false for private trips. */
  showHeaderPublicly: boolean;
}

function mapTrip(r: any): TripRow {
  return {
    id: r.id, ownerId: r.owner_id, title: r.title, destinationCity: r.destination_city,
    destinationCountry: r.destination_country, neighborhoods: r.neighborhoods ?? [],
    startDate: r.start_date, endDate: r.end_date, status: r.status, visibility: r.visibility,
    travelStyle: r.travel_style, openToMeet: r.open_to_meet, coverUrl: resolveApiUrl(r.cover_url),
    coverMediaType: (r.cover_media_type as 'image' | 'video' | null) ?? null,
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
    showHeaderPublicly: r.show_header_publicly ?? false,
  };
}

// GET /api/trips/me serializes rows through toAuthorizedTripView on the
// server, which already returns camelCase fields (destinationCity,
// startDate, ...) — NOT raw snake_case DB columns. mapTrip() expects a raw
// snake_case Supabase row (used by getTrip() below, which selects directly
// from the `trips` table). Running the API's camelCase payload back through
// mapTrip() looked up r.destination_city / r.start_date, which are always
// undefined on that shape, silently blanking the destination and dates on
// every card in the Trips list while the detail screen (fed by getTrip())
// rendered the same trip correctly. Map the already-camelCase API row
// directly instead of re-using the snake_case mapper.
function mapTripApiRow(r: any): TripRow {
  return {
    id: r.id, ownerId: r.ownerId, title: r.title, destinationCity: r.destinationCity,
    destinationCountry: r.destinationCountry ?? null, neighborhoods: r.neighborhoods ?? [],
    startDate: r.startDate ?? null, endDate: r.endDate ?? null, status: r.status, visibility: r.visibility,
    travelStyle: r.travelStyle ?? null, openToMeet: Boolean(r.openToMeet), coverUrl: resolveApiUrl(r.coverUrl),
    coverMediaType: (r.coverMediaType as 'image' | 'video' | null) ?? null,
    progress: r.progress ?? 0,
    tripType: r.tripType ?? null,
    timezone: r.timezone ?? null,
    destinationLat: r.destinationLat ?? null,
    destinationLng: r.destinationLng ?? null,
    destinationPlaceId: r.destinationPlaceId ?? null,
    tripNotes: r.tripNotes ?? null,
    showOnProfile: r.showOnProfile ?? true,
    showInDiscovery: r.showInDiscovery ?? false,
    allowFriendSuggestions: r.allowFriendSuggestions ?? true,
    allowTripCrewInvites: r.allowTripCrewInvites ?? true,
    allowJoinRequests: r.allowJoinRequests ?? false,
    showExactDates: r.showExactDates ?? true,
    showDestinationCity: r.showDestinationCity ?? true,
    delayedPostingDefault: r.delayedPostingDefault ?? false,
    preciseLocationVisible: r.preciseLocationVisible ?? false,
    planEditPermission: r.planEditPermission ?? null,
    showHeaderPublicly: r.showHeaderPublicly ?? false,
  };
}

export async function listMyTrips(): Promise<TripRow[]> {
  if (!isSupabaseConfigured) return [];
  // Must go through GET /api/trips/me, which scopes by trip_members
  // (owner OR any non-"invited" role) — the same membership definition used
  // by the passport "Trips" stat (countUserTrips). A raw `trips` SELECT *
  // relying on RLS previously used a different visibility rule and could
  // return a different set/count of trips than the stat, e.g. the Trips tab
  // showing several trips while the passport stat said "1 Trips".
  const token = await freshToken();
  if (!token) return [];
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const res = await fetch(`${apiBase}/api/trips/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  const trips = (data?.trips ?? []) as any[];
  return trips
    .map(mapTripApiRow)
    .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''));
}

export async function getTrip(id: string): Promise<TripRow | null> {
  if (!isSupabaseConfigured) return null;
  const { data, error } = await supabase.from('trips').select('*').eq('id', id).single();
  if (error || !data) return null;
  return mapTrip(data);
}

/**
 * Returns the current user's role in a trip, or null if they are not a member.
 * Possible values: 'owner', 'co_host', 'member', 'invited'.
 */
export async function getTripMemberRole(tripId: string): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  const { data: { session } } = await supabase.auth.getSession();
  const userId = session?.user?.id;
  if (!userId) return null;
  const { data, error } = await supabase
    .from('trip_members')
    .select('role')
    .eq('trip_id', tripId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return (data as any).role as string;
}

export interface CreateTripInput {
  title: string;
  destinationCity: string;
  destinationCountry?: string;
  startDate?: string;
  endDate?: string;
  status?: TripStatus;
  visibility?: TripVisibility;
  coverUrl?: string | null;
  coverMediaType?: 'image' | 'video' | null;
  /** Pixel width of the cover image (stored for OG preview tags). */
  coverImageWidth?: number | null;
  /** Pixel height of the cover image (stored for OG preview tags). */
  coverImageHeight?: number | null;
  tripNotes?: string | null;
  /** Whether non-members can see the trip's cover image. */
  showHeaderPublicly?: boolean;
}

export async function createTrip(input: CreateTripInput): Promise<TripRow | null> {
  if (!isSupabaseConfigured) return null;

  // Get a fresh session token (refreshes only when near expiry).
  const token = await freshToken();

  if (!token) {
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
      Authorization: `Bearer ${token}`,
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
      coverMediaType: input.coverMediaType ?? null,
      coverImageWidth: input.coverImageWidth ?? null,
      coverImageHeight: input.coverImageHeight ?? null,
      tripNotes: input.tripNotes ?? null,
      showHeaderPublicly: input.showHeaderPublicly ?? false,
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
  if (patch.coverMediaType !== undefined) body.coverMediaType = patch.coverMediaType;
  if (patch.coverImageWidth !== undefined) body.coverImageWidth = patch.coverImageWidth;
  if (patch.coverImageHeight !== undefined) body.coverImageHeight = patch.coverImageHeight;
  if (patch.tripNotes !== undefined) body.tripNotes = patch.tripNotes;
  if (patch.progress !== undefined) body.progress = patch.progress;
  if (patch.showHeaderPublicly !== undefined) body.showHeaderPublicly = patch.showHeaderPublicly;
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

/** Test seam — set to a non-null string to bypass Supabase auth in tests. */
let _testAuthToken: string | null = null;
export function _setTestAuthToken(t: string | null): void { _testAuthToken = t; }

async function freshToken(): Promise<string | null> {
  if (_testAuthToken !== null) return _testAuthToken;
  return freshApiToken();
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
    const err = await res.json().catch(() => ({}) as Record<string, unknown>);
    if (res.status === 410 && (err as Record<string, unknown>).error === 'gone') {
      const e = new Error('gone');
      (e as Error & { code: string }).code = 'gone';
      throw e;
    }
    throw new Error((err as Record<string, unknown>).message as string | undefined ?? `HTTP ${res.status}`);
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
  /** True when accepted member count >= max_members (and max_members is set). */
  isFull: boolean;
}

/** Minimal trip data returned alongside a trip_inactive 410 response. */
export interface TripTombstone {
  title: string | null;
  destinationCity: string | null;
  destinationCountry: string | null;
  startDate: string | null;
  endDate: string | null;
  coverUrl: string | null;
}

export interface InvitePreviewResult {
  data: InvitePreview | null;
  gone?: boolean;
  /**
   * Populated when `gone` is true. `'trip_inactive'` means the trip itself
   * has ended or been cancelled; other values (or absence) mean the link was
   * revoked, expired, or exhausted.
   */
  goneReason?: string;
  /** Populated when `goneReason === 'trip_inactive'` — basic trip info for the tombstone UI. */
  goneTripInfo?: TripTombstone;
  error?: string;
}

/**
 * Fetch a non-sensitive preview of the trip for a given invite token.
 * Requires the caller to be authenticated; returns `error: 'not_authenticated'` if not.
 * Returns `gone: true` when the link is expired, revoked, or exhausted.
 * Sets `goneReason: 'trip_inactive'` when the 410 is specifically because the
 * trip itself has ended or been cancelled (vs the link being revoked/expired).
 */
export async function previewInviteLink(token: string): Promise<InvitePreviewResult> {
  const accessToken = await freshToken();
  if (!accessToken) return { data: null, error: 'not_authenticated' };
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  const res = await fetch(
    `${apiBase}/api/trips/invite-link/${encodeURIComponent(token)}/preview`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (res.status === 410) {
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    const goneReason = body?.reason === 'trip_inactive' ? 'trip_inactive' : undefined;
    const rawTrip = (body?.trip ?? null) as Record<string, unknown> | null;
    const goneTripInfo: TripTombstone | undefined =
      goneReason === 'trip_inactive' && rawTrip
        ? {
            title:              (rawTrip.title as string | null) ?? null,
            destinationCity:    (rawTrip.destinationCity as string | null) ?? null,
            destinationCountry: (rawTrip.destinationCountry as string | null) ?? null,
            startDate:          (rawTrip.startDate as string | null) ?? null,
            endDate:            (rawTrip.endDate as string | null) ?? null,
            coverUrl:           (rawTrip.coverUrl as string | null) ?? null,
          }
        : undefined;
    return { data: null, gone: true, goneReason, goneTripInfo };
  }
  if (!res.ok) return { data: null };
  return { data: await res.json().catch(() => null) };
}

export interface AcceptInviteResult {
  tripId: string | null;
  alreadyMember: boolean;
  error?: string;
  reason?: string;
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
          return { tripId: null, alreadyMember: false, error: errCode, reason: (body?.reason as string) ?? undefined };
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

/**
 * Request access to a private trip. The server creates a pending access
 * request that the trip owner can approve or deny.
 */
export async function requestTripAccess(tripId: string): Promise<{ ok: boolean }> {
  const token = await freshToken();
  if (!token) return { ok: false };
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  try {
    const res = await fetch(`${apiBase}/api/trips/${tripId}/join-request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

/**
 * Fetch a minimal private-trip preview when the viewer does not have access.
 * Returns null when the trip is public (full data available via getTrip) or
 * when the endpoint is not yet implemented by the backend.
 *
 * The preview shape matches PrivateTripPreview from the privacy components.
 */
export async function fetchTripPrivatePreview(tripId: string): Promise<{
  isPrivate: true;
  id: string;
  title: string | null;
  coverImageUrl: string | null;
  ownerDisplayName: string | null;
  ownerHandle: string | null;
  ownerId: string | null;
  myJoinRequestStatus: 'pending' | null;
} | null> {
  try {
    const token = await freshToken();
    const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${apiBase}/api/trips/${tripId}`, { headers });
    if (!res.ok) return null;
    const d = await res.json();
    if (d?.isPrivate === true || d?.locked === true) {
      return {
        isPrivate: true,
        id: d.id ?? d.tripId ?? tripId,
        title: d.title ?? null,
        coverImageUrl: d.coverImageUrl ?? d.coverUrl ?? null,
        ownerDisplayName: d.ownerDisplayName ?? d.owner?.displayName ?? null,
        ownerHandle: d.ownerHandle ?? d.owner?.handle ?? null,
        ownerId: d.ownerId ?? d.owner?.id ?? null,
        myJoinRequestStatus: d.myJoinRequestStatus ?? d.myAccessRequestStatus ?? null,
      };
    }
    return null;
  } catch {
    return null;
  }
}
