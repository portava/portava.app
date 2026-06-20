/**
 * Requests service — unified inbox for social requests (friend, circle, trip invites).
 * All reads go through the API server → service-role + user JWT verification.
 * Follows the same apiGet/freshToken pattern as friends.ts.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';

export type RequestType = 'friend_request' | 'circle_invite' | 'trip_invite';
export type RequestDirection = 'incoming' | 'outgoing';

export interface Actor {
  id: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface InboxItem {
  id: string;
  type: RequestType;
  direction: RequestDirection;
  status: string;
  actor: Actor | null;
  targetName: string | null;
  createdAt: string;
}

export type RequestErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_payload'
  | 'db_error'
  | 'network_unreachable'
  | 'config_error';

export interface RequestResult<T> {
  ok: boolean;
  data: T | null;
  errorKind?: RequestErrorKind;
  message?: string;
}

function apiBase(): string { return process.env.EXPO_PUBLIC_API_BASE_URL ?? ''; }

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

function mapApiError<T>(status: number, body: any): RequestResult<T> {
  const code = (body?.error as RequestErrorKind) ?? 'db_error';
  const known: RequestErrorKind[] = ['unauthenticated', 'forbidden', 'not_found', 'invalid_payload', 'db_error'];
  return { ok: false, data: null, errorKind: known.includes(code) ? code : 'db_error', message: body?.message ?? `API ${status}` };
}

function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.message.includes('Network request failed') || e.message.includes('fetch');
}

async function apiGet<T>(path: string): Promise<RequestResult<T>> {
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

export async function getMyRequests(): Promise<RequestResult<{ items: InboxItem[] }>> {
  return apiGet('/api/me/requests');
}

export async function getRequestCount(): Promise<RequestResult<{ count: number }>> {
  return apiGet('/api/me/requests/count');
}
