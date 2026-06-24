/**
 * Rent a Buddy — Admin API helpers
 *
 * Pattern mirrors trustAdmin.ts: fetch helpers that send the Supabase
 * Bearer token and hit /api/rent-a-buddy/admin/* endpoints.
 */
import { supabase } from '../lib/supabase';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function freshToken(): Promise<string | null> {
  try {
    const { data: refreshed } = await supabase.auth.refreshSession();
    const s = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
    return s?.access_token ?? null;
  } catch { return null; }
}

async function adminGet<T>(path: string): Promise<{ ok: boolean; data?: T; error?: string }> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 403) return { ok: false, error: 'forbidden' };
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, error: (b as any)?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: await res.json() as T };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Network error' };
  }
}

async function adminPost<T>(
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 403) return { ok: false, error: 'forbidden' };
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, error: (b as any)?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: await res.json() as T };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Network error' };
  }
}

async function adminPatch<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 403) return { ok: false, error: 'forbidden' };
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, error: (b as any)?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: await res.json() as T };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Network error' };
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AdminApplication {
  id: string;
  userId: string;
  status: 'pending' | 'under_review' | 'approved' | 'rejected';
  city: string;
  country: string | null;
  categories: string[];
  languages: string[];
  motivation: string | null;
  socialLinks: Record<string, string>;
  policyAccepted: boolean;
  reviewNotes: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminBuddy {
  id: string;
  userId: string;
  displayName: string | null;
  city: string;
  country: string | null;
  categories: string[];
  status: string;
  adminStatus: string;
  buddyLevel: string | null;
  featured: boolean;
  averageRating: number | null;
  reviewCount: number;
  completedBookings: number;
  verified: boolean;
  riskHold: boolean;
  createdAt: string;
}

export interface AdminBooking {
  id: string;
  buddyId: string;
  travelerId: string;
  city: string;
  category: string;
  bookingDate: string;
  status: string;
  paymentMode: string | null;
  totalUsd: number;
  cashBalanceUsd: number;
  cashBalanceConfirmedByBuddy: boolean | null;
  cashBalanceConfirmedByTraveler: boolean | null;
  safetyStatus: string | null;
  telegraphThreadId: string | null;
  createdAt: string;
}

export interface AdminPolicyFlag {
  id: string;
  bookingId: string | null;
  flaggedUserId: string | null;
  reporterUserId: string | null;
  sourceType: string;
  category: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  matchedTextExcerpt: string | null;
  status: 'open' | 'resolved' | 'dismissed';
  adminNotes: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface AdminAnalytics {
  bookingsByCity: Array<{ city: string; count: number }>;
  bookingsByCategory: Array<{ category: string; count: number }>;
  bookingsByStatus: Array<{ status: string; count: number }>;
  totalBookings: number;
  totalRevenue: number;
  openFlags: number;
  activeBuddies: number;
  pendingApplications: number;
}

// ── Applications ───────────────────────────────────────────────────────────────

export async function listAdminApplications(
  status?: string,
  page = 1,
): Promise<{ applications: AdminApplication[]; total: number }> {
  const qs = new URLSearchParams({ page: String(page) });
  if (status) qs.set('status', status);
  const res = await adminGet<{ applications: AdminApplication[]; total: number }>(
    `/api/rent-a-buddy/admin/applications?${qs}`,
  );
  if (!res.ok && res.error === 'forbidden') throw new Error('forbidden');
  return res.ok && res.data ? res.data : { applications: [], total: 0 };
}

export async function reviewApplication(
  appId: string,
  status: 'approved' | 'rejected' | 'under_review',
  reviewNotes?: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await adminPatch(`/api/rent-a-buddy/admin/applications/${appId}`, {
    status,
    reviewNotes: reviewNotes ?? null,
  });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function limitApplication(appId: string): Promise<{ ok: boolean }> {
  const res = await adminPatch(`/api/rent-a-buddy/admin/applications/${appId}`, {
    adminStatus: 'limited',
  });
  return res.ok ? { ok: true } : { ok: false };
}

// ── Buddies ────────────────────────────────────────────────────────────────────

export async function listAdminBuddies(
  params: { city?: string; status?: string; category?: string; page?: number } = {},
): Promise<{ buddies: AdminBuddy[]; total: number }> {
  const qs = new URLSearchParams({ page: String(params.page ?? 1) });
  if (params.city) qs.set('city', params.city);
  if (params.status) qs.set('status', params.status);
  if (params.category) qs.set('category', params.category);
  const res = await adminGet<{ buddies: AdminBuddy[]; total: number }>(
    `/api/rent-a-buddy/admin/buddies?${qs}`,
  );
  if (!res.ok && res.error === 'forbidden') throw new Error('forbidden');
  return res.ok && res.data ? res.data : { buddies: [], total: 0 };
}

// ── Bookings ───────────────────────────────────────────────────────────────────

export async function listAdminBookings(
  params: { status?: string; city?: string; page?: number } = {},
): Promise<{ bookings: AdminBooking[]; total: number }> {
  const qs = new URLSearchParams({ page: String(params.page ?? 1) });
  if (params.status) qs.set('status', params.status);
  if (params.city) qs.set('city', params.city);
  const res = await adminGet<{ bookings: AdminBooking[]; total: number }>(
    `/api/rent-a-buddy/admin/bookings?${qs}`,
  );
  if (!res.ok && res.error === 'forbidden') throw new Error('forbidden');
  return res.ok && res.data ? res.data : { bookings: [], total: 0 };
}

// ── Safety flags ───────────────────────────────────────────────────────────────

export async function listAdminFlags(
  status = 'open',
  page = 1,
): Promise<{ flags: AdminPolicyFlag[]; total: number }> {
  const res = await adminGet<{ flags: AdminPolicyFlag[]; total: number }>(
    `/api/rent-a-buddy/admin/safety/flags?status=${status}&page=${page}`,
  );
  if (!res.ok && res.error === 'forbidden') throw new Error('forbidden');
  return res.ok && res.data ? res.data : { flags: [], total: 0 };
}

export async function confirmFlag(
  flagId: string,
  notes?: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await adminPost(
    `/api/rent-a-buddy/admin/safety/flags/${flagId}/confirm`,
    { notes: notes ?? null },
  );
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function dismissFlag(
  flagId: string,
  notes?: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await adminPost(
    `/api/rent-a-buddy/admin/safety/flags/${flagId}/dismiss`,
    { notes: notes ?? null },
  );
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function escalateFlag(
  flagId: string,
  notes?: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await adminPost(
    `/api/rent-a-buddy/admin/safety/flags/${flagId}/escalate`,
    { notes: notes ?? null },
  );
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

// ── Analytics ──────────────────────────────────────────────────────────────────

export async function fetchAdminAnalytics(
  days = 30,
): Promise<AdminAnalytics | null> {
  const res = await adminGet<AdminAnalytics>(
    `/api/rent-a-buddy/admin/analytics?days=${days}`,
  );
  if (!res.ok && res.error === 'forbidden') throw new Error('forbidden');
  return res.ok && res.data ? res.data : null;
}
