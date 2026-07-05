/**
 * Find Your Circle — API service layer.
 *
 * All calls go through the Express API server (`/api/circle/...`).
 * Uses the same freshToken/authedFetch pattern as intelligence.ts.
 * No GPS or precise location is ever sent or received.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';

export type VisibilityMode = 'status_only' | 'approximate_area' | 'venue_checkin';
export type ContextSharingDefault = 'off' | VisibilityMode;

export interface CircleSettings {
  globalEnabled: boolean;
  visibilityMode: VisibilityMode;
  tripSharingDefault: ContextSharingDefault;
  eventSharingDefault: ContextSharingDefault;
  isPaused: boolean;
  pausedUntil: string | null;
  consentVersion: string | null;
  consentedAt: string | null;
  currentConsentVersion: string;
  updatedAt: string | null;
}

export interface CircleContextSettings {
  enabled: boolean;
  visibilityModeOverride: VisibilityMode | null;
  paused: boolean;
  pausedUntil: string | null;
  updatedAt: string | null;
}

export interface CircleMember {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
  statusLabel: string | null;
  visibilityMode: string;
  freshnessLabel: string;
  lastUpdatedAt: string | null;
  approximateLabel: string | null;
  venueLabel: string | null;
  /** Broad-area coordinates for map pins. Always null in V1; populated in V2. */
  publicLat: number | null;
  publicLng: number | null;
  isStale: boolean;
  canMessage: boolean;
  canViewProfile: boolean;
  safetyActionsAllowed: boolean;
  presenceAbsent: boolean;
}

export interface CircleWatcher {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface CircleMembersPage {
  members: CircleMember[];
  totalCount: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface MeetingPoint {
  id: string;
  venueLabel: string | null;
  approximateLabel: string | null;
  description: string | null;
  /** Coordinates for directions and map pin. Always null in V1; populated in V2. */
  lat: number | null;
  lng: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CheckInResult {
  id: string | null;
  checkinType: string | null;
  createdAt: string | null;
}

type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function freshToken(): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

async function authedFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = await freshToken();
  return fetch(`${apiBase()}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

// ── Membership check ──────────────────────────────────────────────────────────

/**
 * Returns true if the current user is an accepted Circle member for the given
 * context (trip or event).  Returns false on any error — never throws.
 * Used by the Telegraph thread to gate circle_status_card rendering.
 */
export async function checkCircleMembership(
  contextType: 'trip' | 'event',
  contextId: string,
): Promise<boolean> {
  if (!isSupabaseConfigured || !apiBase()) return false;
  try {
    const res = await authedFetch(`/api/circle/contexts/${contextType}/${contextId}/is-member`);
    if (!res.ok) return false;
    const data = await res.json();
    return data.isMember === true;
  } catch {
    return false;
  }
}

// ── Global settings ───────────────────────────────────────────────────────────

export async function getCircleSettings(): Promise<ServiceResult<CircleSettings>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch('/api/circle/settings');
    const data = await res.json();
    if (res.ok) return { ok: true, data };
    return { ok: false, error: data.error ?? 'unknown', status: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

export async function patchCircleSettings(patch: {
  globalEnabled?: boolean;
  visibilityMode?: VisibilityMode;
  tripSharingDefault?: ContextSharingDefault;
  eventSharingDefault?: ContextSharingDefault;
  isPaused?: boolean;
  consentVersion?: string;
}): Promise<ServiceResult<CircleSettings>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch('/api/circle/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (res.ok) return { ok: true, data };
    return { ok: false, error: data.error ?? data.message ?? 'unknown', status: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

export async function pauseAllCircleSharing(): Promise<ServiceResult<CircleSettings>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch('/api/circle/pause-all', { method: 'POST' });
    const data = await res.json();
    if (res.ok) return { ok: true, data };
    return { ok: false, error: data.error ?? 'unknown', status: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

/**
 * Called when the app transitions to "background" or "inactive" (AppState).
 * Tells the server to pause the caller's Circle presence across all active
 * contexts so other members don't see a stale "active" badge after the app
 * closes.  Errors are swallowed — this is best-effort and must never surface
 * UI to the user (they may already be gone when the call fires).
 */
export async function pauseOnSessionEnd(): Promise<void> {
  if (!isSupabaseConfigured || !apiBase()) return;
  try {
    await authedFetch('/api/circle/pause-on-session-end', { method: 'POST' });
  } catch {
    // Network errors on background transition are expected — swallow silently.
  }
}

// ── Per-context settings ──────────────────────────────────────────────────────

export async function getCircleContextSettings(
  contextType: 'trip' | 'event',
  contextId: string,
): Promise<ServiceResult<CircleContextSettings>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch(`/api/circle/contexts/${contextType}/${contextId}/settings`);
    const data = await res.json();
    if (res.ok) return { ok: true, data };
    return { ok: false, error: data.error ?? 'unknown', status: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

export async function patchCircleContextSettings(
  contextType: 'trip' | 'event',
  contextId: string,
  patch: {
    enabled?: boolean;
    visibilityModeOverride?: VisibilityMode | null;
    pausedUntil?: string | null;
  },
): Promise<ServiceResult<CircleContextSettings>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch(`/api/circle/contexts/${contextType}/${contextId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (res.ok) return { ok: true, data };
    return { ok: false, error: data.error ?? data.message ?? 'unknown', status: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

// ── Circle members ────────────────────────────────────────────────────────────

export async function getCircleMembers(
  contextType: 'trip' | 'event',
  contextId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<ServiceResult<CircleMembersPage>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const params = new URLSearchParams();
    if (opts.limit != null) params.set('limit', String(opts.limit));
    if (opts.offset != null) params.set('offset', String(opts.offset));
    const qs = params.toString() ? `?${params}` : '';
    const res = await authedFetch(`/api/circle/contexts/${contextType}/${contextId}/members${qs}`);
    const data = await res.json();
    if (res.ok) return { ok: true, data };
    return { ok: false, error: data.error ?? 'unknown', status: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

// ── Who can see me ────────────────────────────────────────────────────────────

export async function getWhoCanSeeMe(
  contextType: 'trip' | 'event',
  contextId: string,
): Promise<ServiceResult<{ members: CircleWatcher[] }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch(`/api/circle/contexts/${contextType}/${contextId}/who-can-see-me`);
    const data = await res.json();
    if (res.ok) return { ok: true, data };
    return { ok: false, error: data.error ?? 'unknown', status: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

// ── Pause / resume per-context ────────────────────────────────────────────────

export async function pauseCircleContext(
  contextType: 'trip' | 'event',
  contextId: string,
): Promise<ServiceResult<{ paused: boolean }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch(`/api/circle/contexts/${contextType}/${contextId}/pause`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) return { ok: true, data };
    return { ok: false, error: data.error ?? 'unknown', status: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

export async function resumeCircleContext(
  contextType: 'trip' | 'event',
  contextId: string,
): Promise<ServiceResult<{ paused: boolean }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch(`/api/circle/contexts/${contextType}/${contextId}/resume`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) return { ok: true, data };
    return { ok: false, error: data.error ?? 'unknown', status: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

// ── My own presence ───────────────────────────────────────────────────────────
// The /members endpoint excludes the current user. Use this to fetch the
// viewer's own presence row for the pinned self-row at the top of Circle.

export async function getMyPresence(
  contextType: 'trip' | 'event',
  contextId: string,
): Promise<ServiceResult<CircleMember>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch(`/api/circle/contexts/${contextType}/${contextId}/my-presence`);
    const data = await res.json();
    if (res.ok) return { ok: true, data };
    return { ok: false, error: data.error ?? 'unknown', status: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

// ── Check-in ──────────────────────────────────────────────────────────────────

export async function postCheckIn(
  contextType: 'trip' | 'event',
  contextId: string,
  payload: {
    checkinType: 'arrived' | 'with_group' | 'leaving' | 'safe';
    note?: string | null;
    venueLabel?: string | null;
    approximateLabel?: string | null;
  },
): Promise<ServiceResult<CheckInResult>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch(`/api/circle/contexts/${contextType}/${contextId}/check-in`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) return { ok: true, data };
    return { ok: false, error: data.error ?? data.message ?? 'unknown', status: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

// ── Meeting point ─────────────────────────────────────────────────────────────

export async function getMeetingPoint(
  contextType: 'trip' | 'event',
  contextId: string,
): Promise<ServiceResult<{ meetingPoint: MeetingPoint | null }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch(`/api/circle/contexts/${contextType}/${contextId}/meeting-point`);
    const data = await res.json();
    if (res.ok) return { ok: true, data };
    return { ok: false, error: data.error ?? 'unknown', status: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

export async function postMeetingPoint(
  contextType: 'trip' | 'event',
  contextId: string,
  payload: {
    venueLabel?: string | null;
    approximateLabel?: string | null;
    description?: string | null;
  },
): Promise<ServiceResult<MeetingPoint>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch(`/api/circle/contexts/${contextType}/${contextId}/meeting-point`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) return { ok: true, data };
    return { ok: false, error: data.error ?? data.message ?? 'unknown', status: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

export async function patchMeetingPoint(
  contextType: 'trip' | 'event',
  contextId: string,
  payload: {
    venueLabel?: string | null;
    approximateLabel?: string | null;
    description?: string | null;
  },
): Promise<ServiceResult<MeetingPoint>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'not_configured' };
  try {
    const res = await authedFetch(`/api/circle/contexts/${contextType}/${contextId}/meeting-point`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) return { ok: true, data };
    return { ok: false, error: data.error ?? data.message ?? 'unknown', status: res.status };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}
