/**
 * Calls service — typed client for the canonical Portava call APIs (§10).
 * Mirrors the availability.ts service pattern. All authorization happens
 * server-side; these wrappers just carry the session token.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

export type CallType = 'voice' | 'video' | 'group_voice';
export type CallContextType = 'telegraph_dm' | 'rent_a_buddy' | 'trip_crew' | 'event';
export type CallStatus = 'ringing' | 'active' | 'ended' | 'missed' | 'declined' | 'canceled' | 'failed';

export interface CallSessionDto {
  id: string;
  callType: CallType;
  contextType: CallContextType;
  contextId: string;
  threadId: string | null;
  startedBy: string;
  status: CallStatus;
  startedAt: string;
  connectedAt: string | null;
  endedAt: string | null;
}

export interface CallJoinGrant {
  session: CallSessionDto;
  /** LiveKit connection details — short-TTL, single-purpose. */
  livekitUrl: string;
  token: string;
}

export interface CallResult<T = null> {
  ok: boolean;
  data: T | null;
  /** Stable deny reason (callee_calls_disabled, blocked, …) or message. */
  error?: string;
}

function apiBase(): string { return process.env.EXPO_PUBLIC_API_BASE_URL ?? ''; }

async function api<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<CallResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, error: 'Backend not configured' };
  const token = await freshApiToken();
  if (!token) return { ok: false, data: null, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, data: null, error: (json as any)?.reason ?? (json as any)?.message ?? `API ${res.status}` };
    return { ok: true, data: json as T };
  } catch (e) {
    return { ok: false, data: null, error: e instanceof Error ? e.message : 'Network error' };
  }
}

/** Start a direct call in a thread. Server enforces the full permission matrix. */
export async function startCall(input: {
  threadId: string;
  calleeId: string;
  contextType: Extract<CallContextType, 'telegraph_dm' | 'rent_a_buddy'>;
  callType: Extract<CallType, 'voice' | 'video'>;
}): Promise<CallResult<CallJoinGrant>> {
  return api('/api/calls', 'POST', input);
}

/** Start (or get) the group room for a trip crew / event. */
export async function startGroupCall(input: {
  contextType: Extract<CallContextType, 'trip_crew' | 'event'>;
  contextId: string;
}): Promise<CallResult<CallJoinGrant>> {
  return api('/api/calls', 'POST', { ...input, callType: 'group_voice' });
}

export async function acceptCall(callId: string, opts?: { asVideo?: boolean }): Promise<CallResult<CallJoinGrant>> {
  return api(`/api/calls/${encodeURIComponent(callId)}/accept`, 'POST', opts ?? {});
}

export async function declineCall(callId: string): Promise<CallResult<{ status: CallStatus }>> {
  return api(`/api/calls/${encodeURIComponent(callId)}/decline`, 'POST');
}

export async function endCall(callId: string): Promise<CallResult<{ status: CallStatus }>> {
  return api(`/api/calls/${encodeURIComponent(callId)}/end`, 'POST');
}

export async function joinCall(callId: string): Promise<CallResult<CallJoinGrant>> {
  return api(`/api/calls/${encodeURIComponent(callId)}/join`, 'POST');
}

export async function leaveCall(callId: string): Promise<CallResult<{ status: CallStatus }>> {
  return api(`/api/calls/${encodeURIComponent(callId)}/leave`, 'POST');
}

/** Participant row + privacy-safe identity for the in-room list. */
export interface CallParticipantDto {
  userId: string;
  role: string;
  status: string;
  joinedAt: string | null;
  leftAt: string | null;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
}

/** One call with its participant list (drives the group in-room UI). */
export async function getCall(callId: string): Promise<CallResult<{ session: CallSessionDto; participants: CallParticipantDto[] }>> {
  return api(`/api/calls/${encodeURIComponent(callId)}`, 'GET');
}

/** The live crew room for a trip, if any (members only). */
export async function getCrewCall(tripId: string): Promise<CallResult<{ session: CallSessionDto | null; participantCount: number }>> {
  return api(`/api/calls/group/trip_crew/${encodeURIComponent(tripId)}`, 'GET');
}

/** Privacy-safe caller identity attached to a restored ringing session. */
export interface CallCallerIdentity {
  id: string;
  name: string | null;
  avatarUrl: string | null;
  handle: string | null;
}

/** The viewer's currently open call, if any (rejoin/minimized-pill restore). */
export async function getActiveCall(): Promise<CallResult<{ session: CallSessionDto | null; caller?: CallCallerIdentity | null }>> {
  return api('/api/calls/active', 'GET');
}
