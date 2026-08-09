/**
 * Admin Users — API service layer.
 *
 * Thin typed wrappers over the user-lookup and moderation-action endpoints in
 * artifacts/api-server/src/routes/admin.ts. Every action call requires the
 * caller to have already gathered a reason (or explicitly chosen to send
 * none) — this module does not prompt; screens own the confirmation UX.
 */
import { adminGet, adminPost, type AdminApiResult } from './adminApi.ts';

export type { AdminApiResult };

// ── Types ────────────────────────────────────────────────────────────────────

export interface AdminProfile {
  id: string;
  handle: string | null;
  username: string | null;
  name: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  cover_photo_url?: string | null;
  home_city?: string | null;
  home_country?: string | null;
  role: string | null;
  verified: boolean | null;
  verification_status?: string | null;
  account_status: string | null;
  created_at: string;
  spoken_languages?: string[] | null;
  interests?: string[] | null;
}

export interface AccountStateRow {
  state: string;
  reason: string | null;
  expires_at: string | null;
  set_by?: string | null;
  created_at: string;
}

export interface ModerationActionRow {
  id: string;
  action_type: string;
  reason: string | null;
  performed_by: string | null;
  created_at: string;
}

export interface UserReportRow {
  id: string;
  target_type: string;
  target_id?: string;
  reason_code: string;
  severity: string;
  status: string;
  created_at: string;
}

export interface TrustRestrictionRow {
  id: string;
  restriction_type: string;
  reason: string | null;
  lifted_at: string | null;
  created_at: string;
}

export interface UserLookupResult {
  profile: AdminProfile;
  accountStates: AccountStateRow[];
  openReports: number;
  onboardingStatus: { completed: boolean; completedAt: string | null } | null;
}

export interface UserSummary {
  profile: AdminProfile;
  accountStates: AccountStateRow[];
  moderationActions: ModerationActionRow[];
  reportsReceived: UserReportRow[];
  reportsFiled: UserReportRow[];
  trustRestrictions: TrustRestrictionRow[];
  blockCount: number;
  muteCount: number;
  restrictCount: number;
}

/** GET /admin/users?email=... or ?handle=... */
export function lookupUser(query: { email?: string; handle?: string }): Promise<AdminApiResult<UserLookupResult>> {
  const params = new URLSearchParams();
  if (query.email) params.set('email', query.email.trim());
  if (query.handle) params.set('handle', query.handle.trim());
  return adminGet<UserLookupResult>(`/api/admin/users?${params}`);
}

/** GET /admin/users/:userId/summary */
export function fetchUserSummary(userId: string): Promise<AdminApiResult<UserSummary>> {
  return adminGet<UserSummary>(`/api/admin/users/${userId}/summary`);
}

// ── Moderation actions ───────────────────────────────────────────────────────
//
// Every action mirrors its route's response shape 1:1 so callers don't need
// to guess the ack field name. `reason` is optional server-side for warn and
// restore, required in practice everywhere else (the screen enforces this).

function action<T extends Record<string, unknown>>(
  userId: string,
  slug: string,
  reason: string | null,
  extra?: Record<string, unknown>,
): Promise<AdminApiResult<T>> {
  return adminPost<T>(`/api/admin/users/${userId}/${slug}`, { reason, ...extra });
}

export const warnUser = (userId: string, reason: string | null) =>
  action<{ action: ModerationActionRow }>(userId, 'warn', reason);

export const restrictUser = (userId: string, reason: string) =>
  action<{ ok: true; restricted: true }>(userId, 'restrict', reason);

export const suspendUser = (userId: string, reason: string, expiresAt?: string | null) =>
  action<{ ok: true; suspended: true }>(userId, 'suspend', reason, expiresAt ? { expires_at: expiresAt } : undefined);

export const banUser = (userId: string, reason: string) =>
  action<{ ok: true; banned: true }>(userId, 'ban', reason);

export const restoreUser = (userId: string, reason: string | null) =>
  action<{ ok: true; restored: true }>(userId, 'restore', reason);

export const restrictBio = (userId: string, reason: string) =>
  action<{ ok: true; bioRestricted: true }>(userId, 'restrict-bio', reason);

export const restrictMessaging = (userId: string, reason: string) =>
  action<{ ok: true; messagingRestricted: true }>(userId, 'restrict-messaging', reason);

export const restrictVisibility = (userId: string, reason: string) =>
  action<{ ok: true; visibilityRestricted: true }>(userId, 'restrict-visibility', reason);

export const hidePosts = (userId: string, reason: string) =>
  action<{ ok: true; postsHidden: true }>(userId, 'hide-posts', reason);
