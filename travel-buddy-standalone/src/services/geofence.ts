/**
 * Plan geofence service — typed wrappers for the geofence API.
 * All coordinates stay server-side; clients receive labels and status text only.
 */
import { supabase } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

async function authedFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = await freshToken();
  return fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type PublicPreviewLevel = 'city_only' | 'neighborhood' | 'venue_tagged';
export type ExactVisibility    = 'exact_after_acceptance' | 'exact_private_host_reveal';
export type AttendanceStatus   =
  | 'not_checked_in' | 'on_the_way' | 'nearby'
  | 'arrived' | 'late' | 'no_show' | 'left';

export interface GeofenceData {
  id: string;
  publicPreviewLevel: PublicPreviewLevel;
  exactVisibility?: ExactVisibility;
  checkInRequired?: boolean;
  checkInWindowStart?: string | null;
  checkInWindowEnd?: string | null;
  arrivalStatusVisible?: boolean;
  noShowAffectsReliability?: boolean;
  hostEnabled: boolean;
  hostRevealed?: boolean;
  city?: string | null;
  neighborhood?: string | null;
  venueName?: string | null;
  locationName?: string | null;
  locationLabel?: string;
  exactLocationRevealed?: boolean;
  checkInRadiusM?: number;
  myCheckInStatus?: AttendanceStatus;
  viewerRole?: 'owner' | 'member' | 'none';
  exactRevealLabel?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface GeofenceResponse {
  featureEnabled: boolean;
  geofence: GeofenceData | null;
}

export interface SetGeofencePayload {
  lat: number;
  lng: number;
  checkInRadiusM?: number;
  publicPreviewLevel?: PublicPreviewLevel;
  exactVisibility?: ExactVisibility;
  checkInRequired?: boolean;
  checkInWindowStart?: string | null;
  checkInWindowEnd?: string | null;
  arrivalStatusVisible?: boolean;
  noShowAffectsReliability?: boolean;
  locationName?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  venueName?: string | null;
  hostEnabled?: boolean;
}

export interface AttendeeStatus {
  userId: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  status: AttendanceStatus;
  statusLabel: string;
  checkedInAt: string | null;
}

export interface AttendanceTotals {
  accepted: number;
  checkedIn: number;
  nearby: number;
  onTheWay: number;
  noShow: number;
  left: number;
  notCheckedIn: number;
}

export interface AttendanceData {
  geofenceId: string;
  checkInRadiusM: number;
  checkInWindowStart: string | null;
  checkInWindowEnd: string | null;
  totals: AttendanceTotals;
  attendees: AttendeeStatus[];
}

// ── API calls ─────────────────────────────────────────────────────────────────

/** Load geofence for a trip. Non-members see only public preview info. */
export async function getGeofence(tripId: string): Promise<GeofenceResponse> {
  const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/geofence`);
  if (!res.ok) throw new Error('Failed to load geofence');
  return res.json();
}

/** Create or update the geofence for a trip (owner only). */
export async function setGeofence(tripId: string, payload: SetGeofencePayload): Promise<void> {
  const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/geofence`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.message ?? 'Failed to save geofence');
  }
}

/** Host reveals exact location to accepted members. */
export async function revealExactLocation(tripId: string): Promise<void> {
  const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/geofence/reveal`, {
    method: 'POST',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.message ?? 'Failed to reveal location');
  }
}

/** Check in using the user's current GPS coordinates. */
export async function checkIn(tripId: string, lat: number, lng: number): Promise<{
  ok: boolean;
  status?: AttendanceStatus;
  message: string;
  reason?: string;
}> {
  const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/geofence/check-in`, {
    method: 'POST',
    body: JSON.stringify({ lat, lng }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.message ?? 'Check-in failed');
  }
  return res.json();
}

/** Load host attendance dashboard (owner only). */
export async function getAttendance(tripId: string): Promise<AttendanceData | null> {
  const res = await authedFetch(`${apiBase()}/api/trips/${tripId}/geofence/attendance`);
  if (res.status === 200) {
    const body = await res.json();
    return body.attendance ?? body;
  }
  return null;
}

/** Host manually overrides a member's attendance status. */
export async function overrideAttendance(
  tripId: string,
  userId: string,
  status: AttendanceStatus,
  note?: string,
): Promise<void> {
  const res = await authedFetch(
    `${apiBase()}/api/trips/${tripId}/geofence/attendance/${userId}/override`,
    { method: 'POST', body: JSON.stringify({ status, note }) },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.message ?? 'Override failed');
  }
}
