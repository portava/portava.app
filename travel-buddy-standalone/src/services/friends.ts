/**
 * Friends service — typed client over the API server for friend requests,
 * friendships, circle invites, and profile-by-handle lookup.
 *
 * All writes go through the API server (service-role + user JWT verification).
 * The client never writes directly to friend_requests or user_friendships.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { freshToken as freshApiToken } from './apiToken.ts';

export type FriendStatus = 'none' | 'outgoing_pending' | 'incoming_pending' | 'friends' | 'self';

export interface FriendUser {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
  followsYou?: boolean;
  youFollow?: boolean;
}

export interface FriendStatusResult {
  userId: string;
  status: FriendStatus;
  requestId?: string;
}

export interface FriendRequest {
  requestId: string;
  status: string;
  createdAt: string;
  user: FriendUser | null;
}

export interface FriendRow extends FriendUser {
  since: string;
}

export type FriendErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_payload'
  | 'db_error'
  | 'network_unreachable'
  | 'config_error';

export interface FriendResult<T> {
  ok: boolean;
  data: T | null;
  errorKind?: FriendErrorKind;
  message?: string;
}

function apiBase(): string { return process.env.EXPO_PUBLIC_API_BASE_URL ?? ''; }

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

function mapApiError<T>(status: number, body: any): FriendResult<T> {
  const code = (body?.error as FriendErrorKind) ?? 'db_error';
  const known: FriendErrorKind[] = ['unauthenticated', 'forbidden', 'not_found', 'invalid_payload', 'db_error'];
  return { ok: false, data: null, errorKind: known.includes(code) ? code : 'db_error', message: body?.message ?? `API ${status}` };
}

function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.message.includes('Network request failed') || e.message.includes('fetch');
}

async function apiPost<T>(path: string, body?: unknown): Promise<FriendResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return mapApiError<T>(res.status, await res.json().catch(() => ({})));
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

async function apiGet<T>(path: string): Promise<FriendResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: null };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return mapApiError<T>(res.status, await res.json().catch(() => ({})));
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

// ── Friend requests ──────────────────────────────────────────────────────────

export async function getFriendStatus(userId: string): Promise<FriendResult<FriendStatusResult>> {
  return apiGet(`/api/users/${userId}/friend-status`);
}

export async function sendFriendRequest(userId: string): Promise<FriendResult<{ requestId: string; status: string }>> {
  return apiPost(`/api/users/${userId}/friend-request`);
}

export async function acceptFriendRequest(requestId: string): Promise<FriendResult<{ status: string }>> {
  return apiPost(`/api/friend-requests/${requestId}/accept`);
}

export async function declineFriendRequest(requestId: string): Promise<FriendResult<{ status: string }>> {
  return apiPost(`/api/friend-requests/${requestId}/decline`);
}

export async function cancelFriendRequest(requestId: string): Promise<FriendResult<{ status: string }>> {
  return apiPost(`/api/friend-requests/${requestId}/cancel`);
}

export async function getIncomingFriendRequests(): Promise<FriendResult<{ requests: FriendRequest[] }>> {
  return apiGet('/api/me/friend-requests/incoming');
}

export async function getOutgoingFriendRequests(): Promise<FriendResult<{ requests: FriendRequest[] }>> {
  return apiGet('/api/me/friend-requests/outgoing');
}

export async function getMyFriends(): Promise<FriendResult<{ friends: FriendRow[] }>> {
  return apiGet('/api/me/friends');
}

export async function getTripMembers(tripId: string): Promise<FriendResult<{ members: FriendUser[]; invited?: FriendUser[] }>> {
  return apiGet(`/api/trips/${encodeURIComponent(tripId)}/members`);
}

export async function getCircleMembers(circleOwnerId: string): Promise<FriendResult<{ members: FriendUser[] }>> {
  return apiGet(`/api/circles/${encodeURIComponent(circleOwnerId)}/members`);
}

export interface InvitableUsersResult {
  groupMembers: FriendUser[];
  otherFollowers: FriendUser[];
}

export async function getTripInvitableUsers(tripId: string): Promise<FriendResult<InvitableUsersResult>> {
  return apiGet(`/api/trips/${encodeURIComponent(tripId)}/invitable-users`);
}

export async function getCircleInvitableUsers(circleOwnerId: string): Promise<FriendResult<InvitableUsersResult>> {
  return apiGet(`/api/circles/${encodeURIComponent(circleOwnerId)}/invitable-users`);
}

// ── Profile lookup ───────────────────────────────────────────────────────────

export async function getProfileByHandle(handle: string): Promise<FriendResult<any>> {
  return apiGet(`/api/users/by-handle/${encodeURIComponent(handle)}`);
}

export async function getProfileById(userId: string): Promise<FriendResult<any>> {
  return apiGet(`/api/users/${userId}`);
}

// ── Circle invites ───────────────────────────────────────────────────────────

export async function sendCircleInvite(recipientId: string): Promise<FriendResult<{ inviteId: string; status: string }>> {
  return apiPost('/api/circle-invites', { recipientId });
}

export async function acceptCircleInvite(inviteId: string): Promise<FriendResult<{ status: string }>> {
  return apiPost(`/api/circle-invites/${inviteId}/accept`);
}

export async function declineCircleInvite(inviteId: string): Promise<FriendResult<{ status: string }>> {
  return apiPost(`/api/circle-invites/${inviteId}/decline`);
}

// ── Trip invites ─────────────────────────────────────────────────────────────

export async function sendTripInvite(tripId: string, userId: string): Promise<FriendResult<{ status: string }>> {
  return apiPost(`/api/trips/${tripId}/invite`, { userId });
}

export async function acceptTripInvite(tripId: string): Promise<FriendResult<{ status: string }>> {
  return apiPost(`/api/trips/${tripId}/accept-invite`);
}

export async function declineTripInvite(tripId: string): Promise<FriendResult<{ status: string }>> {
  return apiPost(`/api/trips/${tripId}/decline-invite`);
}
