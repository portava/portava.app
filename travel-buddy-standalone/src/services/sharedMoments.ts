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
export function inviteToSharedMoment(id: string, userId: string): Promise<boolean> {
  return request<{ ok: boolean }>(`/api/shared-moments/${encodeURIComponent(id)}/invites`, { method: 'POST', body: JSON.stringify({ userId }) }).then((v) => v?.ok === true);
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