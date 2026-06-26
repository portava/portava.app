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
  approvedCategories?: string[],
): Promise<{ ok: boolean; error?: string }> {
  const res = await adminPatch(`/api/rent-a-buddy/admin/applications/${appId}`, {
    status,
    reviewNotes: reviewNotes ?? null,
    ...(approvedCategories !== undefined ? { approvedCategories } : {}),
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
  params: { city?: string; status?: string; category?: string; level?: string; page?: number } = {},
): Promise<{ buddies: AdminBuddy[]; total: number }> {
  const qs = new URLSearchParams({ page: String(params.page ?? 1) });
  if (params.city) qs.set('city', params.city);
  if (params.status) qs.set('status', params.status);
  if (params.category) qs.set('category', params.category);
  if (params.level) qs.set('level', params.level);
  const res = await adminGet<{ buddies: AdminBuddy[]; total: number }>(
    `/api/rent-a-buddy/admin/buddies?${qs}`,
  );
  if (!res.ok && res.error === 'forbidden') throw new Error('forbidden');
  return res.ok && res.data ? res.data : { buddies: [], total: 0 };
}

// ── Bookings ───────────────────────────────────────────────────────────────────

export async function listAdminBookings(
  params: { status?: string; city?: string; category?: string; paymentMode?: string; dateFrom?: string; dateTo?: string; page?: number } = {},
): Promise<{ bookings: AdminBooking[]; total: number }> {
  const qs = new URLSearchParams({ page: String(params.page ?? 1) });
  if (params.status) qs.set('status', params.status);
  if (params.city) qs.set('city', params.city);
  if (params.category) qs.set('category', params.category);
  if (params.paymentMode) qs.set('paymentMode', params.paymentMode);
  if (params.dateFrom) qs.set('dateFrom', params.dateFrom);
  if (params.dateTo) qs.set('dateTo', params.dateTo);
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

export async function suspendApplication(appId: string): Promise<{ ok: boolean }> {
  const res = await adminPatch(`/api/rent-a-buddy/admin/applications/${appId}`, {
    adminStatus: 'suspended',
  });
  return res.ok ? { ok: true } : { ok: false };
}

export async function setBuddyLevel(buddyId: string, level: 'standard' | 'pro' | 'elite'): Promise<{ ok: boolean }> {
  const res = await adminPatch(`/api/rent-a-buddy/admin/buddies/${buddyId}/level`, { level });
  return res.ok ? { ok: true } : { ok: false };
}

export async function updateBuddyCategories(buddyId: string, categories: string[]): Promise<{ ok: boolean }> {
  const res = await adminPatch(`/api/rent-a-buddy/admin/buddies/${buddyId}/categories`, { categories });
  return res.ok ? { ok: true } : { ok: false };
}

// ── Compliance: support reports ────────────────────────────────────────────────

export interface AdminSupportReport {
  id: string;
  booking_id: string;
  reporter_id: string;
  category: string;
  details: string | null;
  status: 'open' | 'in_review' | 'resolved' | 'closed' | 'escalated';
  admin_notes: string | null;
  template_id: string | null;
  created_at: string;
}

export async function getAdminSupportReports(
  status?: string,
): Promise<AdminSupportReport[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await adminGet<{ reports: AdminSupportReport[] }>(`/api/rent-a-buddy/admin/support/reports${qs}`);
  return res.ok && res.data ? res.data.reports : [];
}

export async function updateSupportReport(
  reportId: string,
  updates: { status?: string; adminNotes?: string },
): Promise<{ ok: boolean; error?: string }> {
  const res = await adminPatch(`/api/rent-a-buddy/admin/support/reports/${reportId}`, updates as Record<string, unknown>);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function getAdminResponseTemplates(): Promise<Array<{ id: string; category: string; title: string; body: string }>> {
  const res = await adminGet<{ templates: Array<{ id: string; category: string; title: string; body: string }> }>('/api/rent-a-buddy/admin/support/templates');
  return res.ok && res.data ? res.data.templates : [];
}

// ── Compliance: risk review ────────────────────────────────────────────────────

export interface AdminRiskBuddy {
  id: string;
  user_id: string;
  display_name: string | null;
  city: string;
  risk_review_status: 'normal' | 'watch' | 'limited' | 'under_review' | 'suspended';
  risk_review_note: string | null;
  nightlife_admin_approved: boolean;
}

export async function getAdminRiskReview(status?: string): Promise<AdminRiskBuddy[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await adminGet<{ profiles: AdminRiskBuddy[] }>(`/api/rent-a-buddy/admin/risk-review${qs}`);
  return res.ok && res.data ? res.data.profiles : [];
}

export async function updateRiskStatus(
  userId: string,
  status: 'normal' | 'watch' | 'limited' | 'under_review' | 'suspended',
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await adminPost(`/api/rent-a-buddy/admin/users/${userId}/risk-status`, { status, note: note ?? null });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function approveNightlife(buddyId: string, approved: boolean, note?: string): Promise<{ ok: boolean; error?: string }> {
  const res = await adminPost(`/api/rent-a-buddy/admin/buddies/${buddyId}/nightlife-approve`, { approved, note: note ?? null });
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export async function updateUserVerification(
  userId: string,
  fields: { phoneVerified?: boolean; idVerified?: boolean; ageVerified?: boolean; dateOfBirth?: string | null; note?: string },
): Promise<{ ok: boolean; error?: string }> {
  const res = await adminPatch(`/api/rent-a-buddy/admin/users/${userId}/verification`, fields as Record<string, unknown>);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

// ── Compliance: launch controls ────────────────────────────────────────────────

export interface LaunchControl {
  id: string;
  country_code: string | null;
  city: string | null;
  category: string | null;
  enabled: boolean;
  waitlist_only: boolean;
  min_age: number;
  nightlife_min_age: number;
  require_id_verification: boolean;
  require_phone_verification: boolean;
  full_payment_required: boolean;
  min_deposit_pct: number;
  notes: string | null;
  updated_at: string;
}

export async function getLaunchControls(): Promise<LaunchControl[]> {
  const res = await adminGet<{ controls: LaunchControl[] }>('/api/rent-a-buddy/admin/launch-controls');
  return res.ok && res.data ? res.data.controls : [];
}

export async function createLaunchControl(
  data: Partial<LaunchControl>,
): Promise<{ ok: boolean; control?: LaunchControl; error?: string }> {
  const res = await adminPost<{ control: LaunchControl }>('/api/rent-a-buddy/admin/launch-controls', data as Record<string, unknown>);
  return res.ok ? { ok: true, control: res.data?.control } : { ok: false, error: res.error };
}

export async function updateLaunchControl(
  controlId: string,
  data: Partial<LaunchControl>,
): Promise<{ ok: boolean; error?: string }> {
  const res = await adminPatch(`/api/rent-a-buddy/admin/launch-controls/${controlId}`, data as Record<string, unknown>);
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
