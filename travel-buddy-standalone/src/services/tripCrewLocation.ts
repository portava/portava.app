/**
 * Trip Crew Location — mobile service layer
 *
 * Typed fetch helpers for all trip crew location endpoints.
 * Pattern: same as safeReturn.ts / trips.ts — EXPO_PUBLIC_API_BASE_URL + supabase Bearer token.
 */
import { supabase } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';
import { serviceFailure, thrownFailure } from './serviceFailure.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CrewStatusLabel =
  | 'not_shared'
  | 'city_only'
  | 'neighborhood'
  | 'nearby'
  | 'arrived'
  | 'safe_return_active'
  | 'live_sharing_active'
  | 'location_hidden';

export interface CrewMemberCard {
  userId: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  statusLabel: CrewStatusLabel;
  areaLabel: string | null;
  planCheckInStatus: string | null;
  safeReturnActive: boolean;
  liveShareActive: boolean;
  liveShareExpiresAt: string | null;
  ghostMode: boolean;
  updatedAt: string | null;
  // ── §10.1 / §10.2, by the spec's names — what the server has carried since
  // census-trips §40.6 and this client did not read until §58 ─────────────
  /**
   * Exact coordinates. Present ONLY when the server put them there: an active
   * live-share grant to this viewer, hotel/home blur off, and a position
   * judged LIVE / RECENT on its own clock (api-server lib/tripCrewLocation.ts).
   * Map spec §23's "permitted temporary precise" — never invented here.
   */
  exactCoords?: { lat: number; lng: number } | null;
  /** Legacy bucket on the same clock as `freshnessClass`. */
  freshness?: 'live' | 'recent' | 'stale' | null;
  /** §10.2 LIVE | RECENT | LAST_KNOWN | OFFLINE, judged on the position's own clock. */
  freshnessClass?: 'LIVE' | 'RECENT' | 'LAST_KNOWN' | 'OFFLINE';
  /** §10.1 observed_at — the instant `freshnessClass` is about. */
  observedAt?: string | null;
  observedAtSource?: 'last_known_at' | 'updated_at' | null;
  /** §10.1 source: the client's own word for how it got the fix. */
  source?: string | null;
  /** §10.1 confidence: the device's accuracy, banded by the server. */
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  /** Appendix B: why presence is withheld; null when it is shown. */
  presenceReason?: 'TRIP_PRESENCE_GHOST' | 'TRIP_PRESENCE_HIDDEN' | null;
}

export interface CrewMapResponse {
  members: CrewMemberCard[];
  totalCount: number;
  featureEnabled: boolean;
}

export interface CrewPreferences {
  defaultVisibility: 'hidden' | 'city_only' | 'neighborhood' | 'nearby' | 'arrived_only';
  ghostModeEnabled: boolean;
  shareArrivalStatus: boolean;
  shareSafeReturnStatus: boolean;
  updatedAt: string | null;
}

export interface ActiveLiveShare {
  sessionId: string;
  userId: string;
  visibilityLevel: string;
  expiresAt: string;
  startedAt: string;
}

export type ShareDuration = '15m' | '30m' | '1h' | 'plan_end';

// ── Helpers ───────────────────────────────────────────────────────────────────

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function authHeaders(): Promise<Record<string, string>> {
  const token = await freshApiToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function apiFetch<T>(
  path: string,
  opts: RequestInit = {},
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const headers = await authHeaders();
    const res = await fetch(`${apiBase()}${path}`, {
      ...opts,
      headers: { ...headers, ...(opts.headers as any) },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: serviceFailure('tripCrewLocation', res, (json as any).message, 'Could not update crew location settings.') };
    return { ok: true, data: json as T };
  } catch (e: any) {
    return { ok: false, error: thrownFailure('tripCrewLocation', e) };
  }
}

// ── Crew map ──────────────────────────────────────────────────────────────────

export async function getCrewMap(tripId: string) {
  return apiFetch<CrewMapResponse>(`/api/trips/${tripId}/crew/map`);
}

// ── Preferences ───────────────────────────────────────────────────────────────

export async function getCrewPreferences(tripId: string) {
  return apiFetch<CrewPreferences>(`/api/trips/${tripId}/crew/location-preferences`);
}

export async function updateCrewPreferences(
  tripId: string,
  patch: Partial<{
    defaultVisibility: CrewPreferences['defaultVisibility'];
    ghostModeEnabled: boolean;
    shareArrivalStatus: boolean;
    shareSafeReturnStatus: boolean;
  }>,
) {
  return apiFetch<{ ok: boolean }>(`/api/trips/${tripId}/crew/location-preferences`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

// ── Ghost mode ────────────────────────────────────────────────────────────────

export async function enableGhostMode(tripId: string) {
  return apiFetch<{ ok: boolean }>(`/api/trips/${tripId}/crew/ghost-mode/enable`, {
    method: 'POST',
  });
}

export async function disableGhostMode(tripId: string) {
  return apiFetch<{ ok: boolean }>(`/api/trips/${tripId}/crew/ghost-mode/disable`, {
    method: 'POST',
  });
}

// ── Live share ────────────────────────────────────────────────────────────────

export async function startLiveShare(
  tripId: string,
  opts: {
    duration: ShareDuration;
    visibilityLevel?: 'city_only' | 'neighborhood' | 'nearby';
    allowedMemberIds: string[];
  },
) {
  return apiFetch<{ ok: boolean; sessionId: string; expiresAt: string }>(
    `/api/trips/${tripId}/crew/live-share/start`,
    { method: 'POST', body: JSON.stringify(opts) },
  );
}

export async function stopLiveShare(tripId: string) {
  return apiFetch<{ ok: boolean }>(`/api/trips/${tripId}/crew/live-share/stop`, {
    method: 'POST',
  });
}

export async function getActiveLiveShares(tripId: string) {
  return apiFetch<{ liveShares: ActiveLiveShare[] }>(
    `/api/trips/${tripId}/crew/live-shares`,
  );
}
