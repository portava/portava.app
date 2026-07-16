/**
 * Availability service — typed wrappers over /api/me/availability,
 * /api/me/quick-availability, /api/trips/:tripId/availability,
 * and /api/circles/:circleId/availability.
 *
 * No GPS fields, no service-role leakage.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';
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
