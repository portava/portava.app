import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken } from './apiToken.ts';

function apiBase(): string { return process.env.EXPO_PUBLIC_API_BASE_URL ?? ''; }

export type MomentRole = 'owner' | 'manager' | 'member';
export interface SharedMoment {
  id: string; title: string; description: string | null;
  placeDayId: string | null; placeId: string | null; tripId: string | null;
  joinPolicy: 'invite_only' | 'approval_required'; status: 'active' | 'archived';
  createdAt: string; updatedAt: string; role: MomentRole | null;
}
export interface SharedMomentDetail {
  moment: SharedMoment;
  members: Array<{ userId: string; role: MomentRole }>;
  chat: { available: boolean; reason: string | null };
}
export interface SharedMomentFeedItem {
  id: string; contributorId: string; caption: string | null; postId: string | null;
  mediaAssetId: string | null; mediaUrl: string | null; thumbnailUrl: string | null; createdAt: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  const token = await freshToken();
  if (!token) return null;
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch { return null; }
}

export function listSharedMoments(placeDayId?: string): Promise<{ moments: SharedMoment[] } | null> {
  const query = placeDayId ? `?${new URLSearchParams({ placeDayId })}` : '';
  return request(`/api/shared-moments${query}`);
}
export function getSharedMoment(id: string): Promise<SharedMomentDetail | null> {
  return request(`/api/shared-moments/${encodeURIComponent(id)}`);
}
export function createSharedMoment(input: { title: string; description?: string; placeDayId?: string; placeId?: string; tripId?: string; joinPolicy?: 'invite_only' | 'approval_required' }): Promise<{ moment: SharedMoment } | null> {
  return request('/api/shared-moments', { method: 'POST', body: JSON.stringify(input) });
}
export function inviteToSharedMoment(id: string, userId: string, originMediaId?: string | null): Promise<boolean> {
  // originMediaId: the media item the invite was sent from (§44 Invite sent); the server attributes it only when the invite lands.
  return request<{ ok: boolean }>(`/api/shared-moments/${encodeURIComponent(id)}/invites`, { method: 'POST', body: JSON.stringify(originMediaId ? { userId, originMediaId } : { userId }) }).then((v) => v?.ok === true);
}
export function respondToSharedMomentInvite(id: string, response: 'accept' | 'decline'): Promise<boolean> {
  return request<{ ok: boolean }>(`/api/shared-moments/${encodeURIComponent(id)}/respond`, { method: 'POST', body: JSON.stringify({ response }) }).then((v) => v?.ok === true);
}
export function requestToJoinSharedMoment(id: string): Promise<boolean> {
  return request<{ ok: boolean }>(`/api/shared-moments/${encodeURIComponent(id)}/request`, { method: 'POST' }).then((v) => v?.ok === true);
}
export function respondToSharedMomentJoinRequest(id: string, userId: string, response: 'accept' | 'decline'): Promise<boolean> {
  return request<{ ok: boolean }>(`/api/shared-moments/${encodeURIComponent(id)}/requests/${encodeURIComponent(userId)}/respond`, { method: 'POST', body: JSON.stringify({ response }) }).then((v) => v?.ok === true);
}
export function leaveSharedMoment(id: string): Promise<boolean> {
  return request<{ ok: boolean }>(`/api/shared-moments/${encodeURIComponent(id)}/leave`, { method: 'POST' }).then((v) => v?.ok === true);
}
export function archiveSharedMoment(id: string): Promise<boolean> {
  return request<{ moment: SharedMoment }>(`/api/shared-moments/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'archived' }) }).then(Boolean);
}
export function addSharedMomentContribution(id: string, input: { postId?: string; mediaAssetId?: string; caption?: string }): Promise<boolean> {
  return request<{ contribution: unknown }>(`/api/shared-moments/${encodeURIComponent(id)}/contributions`, { method: 'POST', body: JSON.stringify(input) }).then(Boolean);
}
export function approveSharedMomentContribution(id: string, contributionId: string): Promise<boolean> {
  return request<{ ok: boolean }>(`/api/shared-moments/${encodeURIComponent(id)}/contributions/${encodeURIComponent(contributionId)}/approve`, { method: 'POST' }).then((v) => v?.ok === true);
}
export function removeSharedMomentContribution(id: string, contributionId: string): Promise<boolean> {
  return request<{ ok: boolean }>(`/api/shared-moments/${encodeURIComponent(id)}/contributions/${encodeURIComponent(contributionId)}`, { method: 'DELETE' }).then((v) => v?.ok === true);
}
export function getSharedMomentFeed(id: string, cursor?: string): Promise<{ items: SharedMomentFeedItem[]; nextCursor: string | null } | null> {
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
  return request(`/api/shared-moments/${encodeURIComponent(id)}/feed${query}`);
}
// ════════════════════════════════════════════════════════════════════════════
// Testing mode WP-07 (HM-F17, HM-F18): participation reads with a TYPED result.
// Appended at the foot so no cited line above moves.
//
// `request()` above answers null for every failure. The participation screens
// must tell "you are not a member — here is your invitation" from "the network
// dropped", and must never render an unreadable list as an empty one (DV-83),
// so these reads keep the server's refusal code.
// ════════════════════════════════════════════════════════════════════════════

export type MomentReadCode = 'not_member' | 'not_found' | 'forbidden' | 'degraded_unavailable' | 'unauthorized' | 'unavailable' | 'network' | 'server';
export type MomentRead<T> = { ok: true; data: T } | { ok: false; code: MomentReadCode; message: string };

const MOMENT_READ_FALLBACK: Record<MomentReadCode, string> = {
  not_member: 'Join this Moment to view it.',
  not_found: 'This Moment is unavailable.',
  forbidden: 'You cannot do that in this Moment.',
  degraded_unavailable: 'This could not be loaded right now. Please try again.',
  unauthorized: 'Please sign in again.',
  unavailable: 'Shared Moments are not available on this build.',
  network: 'You appear to be offline. Check your connection and try again.',
  server: 'Something went wrong. Please try again.',
};

async function momentRead<T>(path: string, pick: (body: any) => T | null, init?: RequestInit): Promise<MomentRead<T>> {
  const failWith = (code: MomentReadCode, message?: unknown): MomentRead<T> =>
    ({ ok: false, code, message: typeof message === 'string' && message ? message : MOMENT_READ_FALLBACK[code] });
  if (!isSupabaseConfigured || !apiBase()) return failWith('unavailable');
  const token = await freshToken();
  if (!token) return failWith('unauthorized');
  try {
    const res = await fetch(`${apiBase()}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init?.headers } });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const code = body?.error;
      const known: MomentReadCode | null = code === 'not_member' || code === 'not_found' || code === 'forbidden' || code === 'degraded_unavailable' ? code : null;
      return failWith(known ?? (res.status === 401 ? 'unauthorized' : res.status === 404 ? 'not_found' : 'server'), body?.message);
    }
    const data = body === null ? null : pick(body);
    return data === null ? failWith('server', 'The server answered in a shape this app does not understand.') : { ok: true, data };
  } catch {
    return failWith('network');
  }
}

const momentPath = (id: string) => `/api/shared-moments/${encodeURIComponent(id)}`;

/** Member view. A non-member gets `not_member` and should be shown the preview. */
export function loadSharedMoment(id: string): Promise<MomentRead<SharedMomentDetail>> {
  return momentRead(momentPath(id), (b) => (b?.moment ? b as SharedMomentDetail : null));
}

/** Approved contributions, as the member feed serves them. */
export function loadSharedMomentFeed(id: string, cursor?: string): Promise<MomentRead<{ items: SharedMomentFeedItem[]; nextCursor: string | null }>> {
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
  return momentRead(`${momentPath(id)}/feed${query}`, (b) => (Array.isArray(b?.items) ? { items: b.items, nextCursor: b.nextCursor ?? null } : null));
}

export interface SharedMomentPreview {
  moment: Pick<SharedMoment, 'id' | 'title' | 'description' | 'placeId' | 'placeDayId' | 'tripId' | 'joinPolicy' | 'status'>;
  /** The caller's membership status: invited, requested, accepted, declined, left… or null. */
  myStatus: string | null;
  myRole: MomentRole | null;
}

/** What a non-member may see in order to act (invitee, requester, suggestion holder, open door). */
export function getSharedMomentPreview(id: string): Promise<MomentRead<SharedMomentPreview>> {
  return momentRead(`${momentPath(id)}/preview`, (b) => (b?.moment ? b as SharedMomentPreview : null));
}

export interface SharedMomentInvite { moment: SharedMomentPreview['moment']; invitedBy: string | null; invitedAt: string | null }
export function listMySharedMomentInvites(): Promise<MomentRead<SharedMomentInvite[]>> {
  return momentRead('/api/me/shared-moment-invites', (b) => (Array.isArray(b?.invites) ? b.invites : null));
}

export interface SharedMomentJoinRequest { userId: string; handle: string | null; name: string | null; avatarUrl: string | null; requestedAt: string | null }
export function listSharedMomentJoinRequests(id: string): Promise<MomentRead<SharedMomentJoinRequest[]>> {
  return momentRead(`${momentPath(id)}/requests`, (b) => (Array.isArray(b?.requests) ? b.requests : null));
}

export interface PendingSharedMomentContribution {
  id: string; contributorId: string; postId: string | null; mediaAssetId: string | null;
  caption: string | null; mediaUrl: string | null; thumbnailUrl: string | null; createdAt: string; mine: boolean;
}
/** Pending review. Owner/manager: every pending one; a member: only their own. */
export function listPendingSharedMomentContributions(id: string): Promise<MomentRead<PendingSharedMomentContribution[]>> {
  return momentRead(`${momentPath(id)}/contributions`, (b) => (Array.isArray(b?.contributions) ? b.contributions : null));
}

export interface ContributablePost { id: string; caption: string | null; mediaUrl: string | null; thumbnailUrl: string | null; createdAt: string; contributed: boolean }
/** The caller's OWN posts at this Moment's place (or on its trip). */
export function listContributablePosts(id: string): Promise<MomentRead<ContributablePost[]>> {
  return momentRead(`${momentPath(id)}/contributable-posts`, (b) => (Array.isArray(b?.posts) ? b.posts : null));
}

export interface SharedMomentSuggestion { id: string; momentId: string; kind: 'compass' | 'clustering' | string; reason: string | null; label: string; createdAt: string }
/** Offered suggestions. Empty (and labeled) when both suggestion capabilities are off. */
export function listSharedMomentSuggestions(): Promise<MomentRead<SharedMomentSuggestion[]>> {
  return momentRead('/api/shared-moments/suggestions/mine', (b) => (Array.isArray(b?.suggestions) ? b.suggestions : null));
}

export function dismissSharedMomentSuggestion(suggestionId: string): Promise<MomentRead<{ ok: true }>> {
  return momentRead(`/api/shared-moments/suggestions/${encodeURIComponent(suggestionId)}/dismiss`,
    (b) => (b?.ok === true ? { ok: true as const } : null), { method: 'POST' });
}
