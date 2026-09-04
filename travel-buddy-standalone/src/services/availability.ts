/**
 * Availability service — typed wrappers over /api/me/availability,
 * /api/me/quick-availability, /api/trips/:tripId/availability,
 * and /api/circles/:circleId/availability.
 *
 * No GPS fields, no service-role leakage.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

export type TimeBlock = 'morning' | 'afternoon' | 'evening' | 'late';
export type Weekday   = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type QuickStatus = 'free_now' | 'free_tonight' | 'busy' | 'open_to_plans';

export interface WeeklyAvailabilityData {
  weeklyDays: Partial<Record<Weekday, TimeBlock[]>>;
  openToMeet: boolean;
  strictMode: boolean;
  quickStatus: { status: QuickStatus; expiresAt: string } | null;
}

export interface MemberAvailability {
  userId: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
  weeklyDays: Partial<Record<Weekday, TimeBlock[]>>;
  openToMeet: boolean;
  quickStatus: { status: QuickStatus; expiresAt: string } | null;
  isOwner?: boolean;
  /** Trip-scoped specific dates: keys are YYYY-MM-DD, values are free time blocks. */
  openDays?: Record<string, TimeBlock[]> | null;
}

export interface AvailabilityResult<T = null> {
  ok: boolean;
  data: T | null;
  message?: string;
}

function apiBase(): string { return process.env.EXPO_PUBLIC_API_BASE_URL ?? ''; }

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

async function apiGet<T>(path: string): Promise<AvailabilityResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: null };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, message: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, data: null, message: body?.message ?? `API ${res.status}` };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, data: null, message: e instanceof Error ? e.message : 'Network error' };
  }
}

async function apiPatch<T>(path: string, body: Record<string, unknown>): Promise<AvailabilityResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: null };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, message: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, data: null, message: b?.message ?? `API ${res.status}` };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, data: null, message: e instanceof Error ? e.message : 'Network error' };
  }
}

async function apiSend<T>(method: 'POST' | 'DELETE', path: string, body?: Record<string, unknown>): Promise<AvailabilityResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: null };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, message: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, data: null, message: b?.message ?? `API ${res.status}` };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, data: null, message: e instanceof Error ? e.message : 'Network error' };
  }
}

// ── Own availability ──────────────────────────────────────────────────────────

export async function getMyAvailability(): Promise<AvailabilityResult<WeeklyAvailabilityData>> {
  return apiGet('/api/me/availability');
}

export async function patchMyAvailability(
  patch: Partial<{ weeklyDays: Partial<Record<Weekday, TimeBlock[]>>; openToMeet: boolean; strictMode: boolean }>
): Promise<AvailabilityResult<Omit<WeeklyAvailabilityData, 'quickStatus'>>> {
  return apiPatch('/api/me/availability', patch as Record<string, unknown>);
}

export async function getMyQuickStatus(): Promise<AvailabilityResult<{ status: QuickStatus | null; expiresAt: string | null }>> {
  return apiGet('/api/me/quick-availability');
}

export async function patchMyQuickStatus(
  status: QuickStatus,
  expiresAt?: string,
): Promise<AvailabilityResult<{ status: QuickStatus; expiresAt: string }>> {
  return apiPatch('/api/me/quick-availability', { status, ...(expiresAt ? { expiresAt } : {}) });
}

// ── Trip availability ─────────────────────────────────────────────────────────

export interface BestDay { date: string; count: number; }

export async function getTripAvailability(tripId: string): Promise<AvailabilityResult<{ members: MemberAvailability[]; tripId: string; bestDays: BestDay[] }>> {
  return apiGet(`/api/trips/${tripId}/availability`);
}

export async function patchTripAvailability(
  tripId: string,
  patch: Partial<{ weeklyDays: Partial<Record<Weekday, TimeBlock[]>>; openToMeet: boolean }>
): Promise<AvailabilityResult<{ weeklyDays: Partial<Record<Weekday, TimeBlock[]>>; openToMeet: boolean }>> {
  return apiPatch(`/api/trips/${tripId}/availability`, patch as Record<string, unknown>);
}

export async function patchTripOpenDays(
  tripId: string,
  openDays: Record<string, TimeBlock[]>,
): Promise<AvailabilityResult<{ tripId: string; userId: string; openDays: Record<string, TimeBlock[]> }>> {
  return apiPatch(`/api/trips/${tripId}/availability`, { openDays } as Record<string, unknown>);
}

// ── Circle availability ───────────────────────────────────────────────────────

export async function getCircleAvailability(circleId: string): Promise<AvailabilityResult<{ members: MemberAvailability[]; circleId: string }>> {
  return apiGet(`/api/circles/${circleId}/availability`);
}

// ── Availability nudges ───────────────────────────────────────────────────────

export interface AvailabilityNudge {
  id: string;
  senderId: string;
  senderName: string | null;
  senderHandle: string | null;
  senderAvatarUrl: string | null;
  tripId: string;
  tripTitle: string | null;
  destinationCity: string | null;
  nudgeDate: string;
  createdAt: string;
}

export async function getAvailabilityNudges(): Promise<AvailabilityResult<{ nudges: AvailabilityNudge[] }>> {
  return apiGet('/api/me/availability-nudges');
}

// ── Availability Windows — §8 Open-to-Plans / Temporary Intent (TABLE 8) ──────
//
// The §8 AvailabilityWindow domain is DISTINCT from the §6 weekly grid
// (getMyAvailability) and the four-value quick status (getMyQuickStatus): a
// window answers "Do I want social invitations, when, for what, with whom, and
// how far will I travel?" — and it EXPIRES. These wrap the availability router's
// /api/me/availability-windows endpoints (already on main). The endpoints are
// gated behind `open_to_plans_windows_enabled` (seeded OFF); when the flag is
// off, reads answer `{ windows: [], enabled: false }` and writes answer
// `{ ok: true, enabled: false }` and store nothing.
//
// §7 is enforced at BOTH ends: `createMyAvailabilityWindow` always sends
// source:'explicit', and the server ignores any client-supplied source and
// forces 'explicit' too. An answer given through this screen is, by
// construction, an EXPLICIT answer — never an inferred value promoted to a
// public status.

export type WindowType = 'recurring' | 'trip' | 'one_time' | 'derived';
export type IntentType = 'Food' | 'Drinks' | 'Nightlife' | 'Explore' | 'Events' | 'MeetTravelers';
export type GroupPreference = 'solo' | 'one_on_one' | 'small_group' | 'crew_only' | 'large_group' | 'any';
export type VisibilityPolicy = 'public' | 'followers' | 'following' | 'crew' | 'private';
export type WindowSource = 'explicit' | 'plan_derived';
/** TABLE 10 SocialAvailability enum surface. */
export type SocialAvailability = 'open' | 'maybe' | 'crew_only' | 'following_only' | 'not_open';

/** TABLE 8 AvailabilityWindow, as projected by the availability router. */
export interface AvailabilityWindow {
  id: string;
  userId: string;
  type: WindowType;
  startAt: string;
  endAt: string;
  tripId: string | null;
  openToPlans: boolean;
  intents: IntentType[];
  groupPreference: GroupPreference | null;
  maxTravelMinutes: number | null;
  visibility: VisibilityPolicy;
  source: WindowSource;
  socialAvailability: SocialAvailability | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAvailabilityWindowInput {
  type: WindowType;
  startAt: string;
  endAt: string;
  tripId?: string | null;
  openToPlans?: boolean;
  intents?: IntentType[];
  groupPreference?: GroupPreference | null;
  maxTravelMinutes?: number | null;
  visibility?: VisibilityPolicy;
  socialAvailability?: SocialAvailability | null;
  expiresAt?: string | null;
  /** §7: the screen's set action IS the explicit answer. Always 'explicit'. */
  source?: 'explicit';
}

export interface UpdateAvailabilityWindowInput {
  openToPlans?: boolean;
  intents?: IntentType[];
  groupPreference?: GroupPreference | null;
  maxTravelMinutes?: number | null;
  visibility?: VisibilityPolicy;
  socialAvailability?: SocialAvailability | null;
  endAt?: string;
  expiresAt?: string | null;
}

/** GET envelope: `windows` are already §31-filtered (non-expired) server-side. */
export interface AvailabilityWindowsEnvelope {
  windows: AvailabilityWindow[];
  enabled: boolean;
}

/** Mutation envelope: `window` present on success, absent when flag-disabled. */
export interface AvailabilityWindowMutation {
  window?: AvailabilityWindow;
  enabled: boolean;
  ok?: boolean;
  cleared?: boolean;
}

/** Own windows. Non-expired only by default (§31); includeExpired for history. */
export async function getMyAvailabilityWindows(
  opts: { includeExpired?: boolean } = {},
): Promise<AvailabilityResult<AvailabilityWindowsEnvelope>> {
  const q = opts.includeExpired ? '?includeExpired=1' : '';
  return apiGet(`/api/me/availability-windows${q}`);
}

/**
 * Set an EXPLICIT intent window (§7/§8). `source` is pinned to 'explicit' here so
 * the answer can never be mistaken for an inferred one, regardless of caller —
 * the server also forces 'explicit', but pinning it client-side keeps the
 * screen's contract honest and self-evident.
 */
export async function createMyAvailabilityWindow(
  input: CreateAvailabilityWindowInput,
): Promise<AvailabilityResult<AvailabilityWindowMutation>> {
  return apiSend('POST', '/api/me/availability-windows', { ...input, source: 'explicit' } as Record<string, unknown>);
}

/** Update intent / openToPlans / visibility / TTL on an owned window. */
export async function patchMyAvailabilityWindow(
  id: string,
  patch: UpdateAvailabilityWindowInput,
): Promise<AvailabilityResult<AvailabilityWindowMutation>> {
  return apiPatch(`/api/me/availability-windows/${id}`, patch as Record<string, unknown>);
}

/** Explicit clear (§8 "explicit clear action"): delete an owned window. */
export async function deleteMyAvailabilityWindow(
  id: string,
): Promise<AvailabilityResult<AvailabilityWindowMutation>> {
  return apiSend('DELETE', `/api/me/availability-windows/${id}`);
}
