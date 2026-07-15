/**
 * Trust Admin — API service layer
 *
 * Thin fetch wrappers over /api/admin/trust/* routes.
 * All calls require an authenticated admin user.
 */
import { supabase } from '../lib/supabase';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
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

function trustUrl(...parts: string[]) {
  return `${apiBase()}/api/admin/trust/${parts.join('/')}`;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TrustReview {
  id: string;
  user_id: string;
  review_type: string;
  status: string;
  source_event_id: string | null;
  metadata: Record<string, unknown>;
  notes: string | null;
  created_at: string;
}

export interface TrustEvent {
  id: string;
  event_type: string;
  category: string;
  delta: number;
  severity: string;
  status: string;
  source_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface TrustCap {
  id: string;
  category: string;
  ceilingScore: number;
  reasonCode: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface TrustRestriction {
  id: string;
  restriction_type: string;
  reason: string;
  expires_at: string | null;
  created_at: string;
  lifted_at: string | null;
}

export interface TrustProfile {
  userId: string;
  overall_score: number;
  public_level: string;
  categories: Record<string, number>;
  capsApplied: string[];
}

export interface TrustUserDetail {
  userId: string;
  profile: TrustProfile | null;
  caps: TrustCap[];
  restrictions: TrustRestriction[];
  events: TrustEvent[];
  openReviews: TrustReview[];
}

export type TrustSettingKey =
  | 'weight_plan_attendance' | 'weight_host_quality' | 'weight_communication'
  | 'weight_respect_safety' | 'weight_location_honesty' | 'weight_content_quality'
  | 'weight_community_value' | 'weight_guide_accuracy' | 'weight_passport_auth'
  | 'decay_half_life_days'
  | 'level_building_trust' | 'level_reliable' | 'level_trusted'
  | 'level_highly_trusted' | 'level_city_trusted'
  | 'daily_cap_plan_attend' | 'daily_cap_guide_verify' | 'daily_cap_gem_save'
  | 'weekly_cap_plan_attend' | 'weekly_cap_guide_verify' | 'weekly_cap_gem_save'
  | 'gaming_checkin_cluster_limit' | 'gaming_mutual_rate_threshold' | 'gaming_rapid_jump_points';

// ── Review queue ───────────────────────────────────────────────────────────────

export async function fetchReviews(opts?: {
  page?: number;
  limit?: number;
  type?: string;
  status?: string;
}): Promise<{ reviews: TrustReview[]; total: number; page: number }> {
  const params = new URLSearchParams();
  if (opts?.page)   params.set('page',   String(opts.page));
  if (opts?.limit)  params.set('limit',  String(opts.limit));
  if (opts?.type)   params.set('type',   opts.type);
  if (opts?.status) params.set('status', opts.status);

  const url = `${trustUrl('reviews')}?${params}`;
  const res = await authedFetch(url);
  if (!res.ok) throw new Error(`fetchReviews failed: ${res.status}`);
  return res.json();
}

// ── User trust detail ──────────────────────────────────────────────────────────

export async function fetchUserTrustDetail(userId: string): Promise<TrustUserDetail> {
  const res = await authedFetch(trustUrl('users', userId));
  if (!res.ok) throw new Error(`fetchUserTrustDetail failed: ${res.status}`);
  return res.json();
}

// ── Event actions ──────────────────────────────────────────────────────────────

export async function confirmTrustEvent(eventId: string, reason: string): Promise<{ ok: boolean }> {
  const res = await authedFetch(trustUrl('events', eventId, 'confirm'), {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.message ?? `confirm failed: ${res.status}`);
  }
  return res.json();
}

export async function dismissTrustEvent(eventId: string, reason: string): Promise<{ ok: boolean }> {
  const res = await authedFetch(trustUrl('events', eventId, 'dismiss'), {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.message ?? `dismiss failed: ${res.status}`);
  }
  return res.json();
}

// ── Restrictions ──────────────────────────────────────────────────────────────

export async function applyTrustRestriction(
  userId: string,
  restrictionType: string,
  reason: string,
  expiresAt?: string | null,
): Promise<{ ok: boolean; restrictionId: string }> {
  const res = await authedFetch(trustUrl('users', userId, 'restrict'), {
    method: 'POST',
    body: JSON.stringify({ restrictionType, reason, expiresAt: expiresAt ?? null }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.message ?? `restrict failed: ${res.status}`);
  }
  return res.json();
}

export async function liftTrustRestriction(
  restrictionId: string,
  targetUser: string,
  reason: string,
): Promise<{ ok: boolean }> {
  const res = await authedFetch(trustUrl('restrictions', restrictionId, 'remove'), {
    method: 'POST',
    body: JSON.stringify({ targetUser, reason }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.message ?? `lift restriction failed: ${res.status}`);
  }
  return res.json();
}

// ── Cap override ───────────────────────────────────────────────────────────────

export async function liftTrustCap(
  userId: string,
  capId: string,
  reason: string,
): Promise<{ ok: boolean }> {
  const res = await authedFetch(trustUrl('users', userId, 'cap', 'override'), {
    method: 'POST',
    body: JSON.stringify({ capId, reason }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.message ?? `cap override failed: ${res.status}`);
  }
  return res.json();
}

// ── Gaming flags ───────────────────────────────────────────────────────────────

export async function fetchGamingFlags(limit = 50): Promise<{ flags: TrustReview[]; total: number }> {
  const res = await authedFetch(`${trustUrl('gaming-flags')}?limit=${limit}`);
  if (!res.ok) throw new Error(`fetchGamingFlags failed: ${res.status}`);
  return res.json();
}

export async function markGamingFlagReviewed(
  reviewId: string,
  notes?: string,
): Promise<{ ok: boolean }> {
  const res = await authedFetch(trustUrl('gaming-flags', reviewId, 'mark-reviewed'), {
    method: 'POST',
    body: JSON.stringify({ notes }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.message ?? `mark-reviewed failed: ${res.status}`);
  }
  return res.json();
}

// ── Trust settings ─────────────────────────────────────────────────────────────

export async function fetchTrustSettings(): Promise<{ settings: Record<string, number> }> {
  const res = await authedFetch(trustUrl('settings'));
  if (!res.ok) throw new Error(`fetchTrustSettings failed: ${res.status}`);
  return res.json();
}

export async function updateTrustSetting(
  key: TrustSettingKey,
  value: number,
): Promise<{ settings: Record<string, number>; updated: { key: string; value: number } }> {
  const res = await authedFetch(trustUrl('settings', key), {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any)?.message ?? `updateTrustSetting failed: ${res.status}`);
  }
  return res.json();
}
