/**
 * Messaging service — typed client over the API server.
 *
 * Covers:
 *   - Message settings (GET/PATCH)
 *   - Message permission (GET verdict)
 *   - Message requests (send, accept, decline, cancel, list incoming)
 *   - Threads (list)
 *   - Messages (list paginated, send)
 *
 * All writes go through the API server (service-role + JWT verification).
 * No private posts, trip data, live location, or GPS are accessible here.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';

export type MessageVerdict = 'allowed' | 'requires_request' | 'denied';

export interface MessageSettings {
  message_privacy: 'everyone' | 'followers' | 'following' | 'friends' | 'trip_members' | 'no_one';
  allow_message_requests: boolean;
  allow_trip_member_messages: boolean;
  allow_circle_member_messages: boolean;
  updated_at: string | null;
}

export interface MessagePermissionResult {
  verdict: MessageVerdict;
  allowed: boolean;
  reason: string | null;
  relationship_context: {
    isFriend: boolean;
    senderFollowsRecipient: boolean;
    recipientFollowsSender: boolean;
    sharedTrip: boolean;
    sharedCircle: boolean;
  };
}

export interface MessageRequest {
  requestId: string;
  previewText: string | null;
  createdAt: string;
  sender: {
    id: string;
    handle: string;
    name: string;
    avatarUrl: string | null;
  } | null;
}

export interface ThreadOtherMember {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
}

export interface ThreadSummary {
  id: string;
  status: string;
  lastMessageAt: string | null;
  createdAt: string;
  mutedAt: string | null;
  archivedAt: string | null;
  otherMembers: ThreadOtherMember[];
  lastMessagePreview: {
    body: string;
    senderId: string;
    createdAt: string;
  } | null;
}

export interface Message {
  id: string;
  threadId: string;
  senderId: string;
  senderHandle: string | null;
  senderName: string | null;
  senderAvatarUrl: string | null;
  body: string | null;
  deleted: boolean;
  createdAt: string;
  editedAt: string | null;
}

export type MsgErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_payload'
  | 'db_error'
  | 'network_unreachable'
  | 'config_error';

export interface MsgResult<T> {
  ok: boolean;
  data: T | null;
  errorKind?: MsgErrorKind;
  message?: string;
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

function mapApiError<T>(status: number, body: any): MsgResult<T> {
  const code = (body?.error as MsgErrorKind) ?? 'db_error';
  const known: MsgErrorKind[] = ['unauthenticated', 'forbidden', 'not_found', 'invalid_payload', 'db_error'];
  return {
    ok: false,
    data: null,
    errorKind: known.includes(code) ? code : 'db_error',
    message: body?.message ?? `API ${status}`,
  };
}

function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.message.includes('Network request failed') || e.message.includes('fetch');
}

async function apiGet<T>(path: string): Promise<MsgResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: true, data: null };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return mapApiError<T>(res.status, await res.json().catch(() => ({})));
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

async function apiPost<T>(path: string, body?: unknown): Promise<MsgResult<T>> {
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

async function apiPatch<T>(path: string, body: unknown): Promise<MsgResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return mapApiError<T>(res.status, await res.json().catch(() => ({})));
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

// ── Message settings ──────────────────────────────────────────────────────────

export async function getMyMessageSettings(): Promise<MsgResult<MessageSettings>> {
  return apiGet('/api/me/message-settings');
}

export async function updateMyMessageSettings(
  patch: Partial<Omit<MessageSettings, 'updated_at'>>,
): Promise<MsgResult<MessageSettings>> {
  return apiPatch('/api/me/message-settings', patch);
}

// ── Permission check ──────────────────────────────────────────────────────────

export async function getMessagePermission(
  userId: string,
): Promise<MsgResult<MessagePermissionResult>> {
  return apiGet(`/api/users/${userId}/message-permission`);
}

// ── Message requests ──────────────────────────────────────────────────────────

export async function sendMessageRequest(
  userId: string,
  previewText?: string,
): Promise<MsgResult<{ requestId: string; status: string }>> {
  return apiPost(`/api/users/${userId}/message-request`, previewText ? { previewText } : undefined);
}

export async function getIncomingMessageRequests(): Promise<MsgResult<{ requests: MessageRequest[] }>> {
  return apiGet('/api/me/message-requests');
}

export async function acceptMessageRequest(
  requestId: string,
): Promise<MsgResult<{ status: string; threadId: string }>> {
  return apiPost(`/api/message-requests/${requestId}/accept`);
}

export async function declineMessageRequest(
  requestId: string,
): Promise<MsgResult<{ status: string }>> {
  return apiPost(`/api/message-requests/${requestId}/decline`);
}

export async function cancelMessageRequest(
  requestId: string,
): Promise<MsgResult<{ status: string }>> {
  return apiPost(`/api/message-requests/${requestId}/cancel`);
}

// ── Threads ───────────────────────────────────────────────────────────────────

export async function getMyThreads(): Promise<MsgResult<{ threads: ThreadSummary[] }>> {
  return apiGet('/api/me/threads');
}

// ── Messages ──────────────────────────────────────────────────────────────────

export async function getThreadMessages(
  threadId: string,
  before?: string,
): Promise<MsgResult<{ messages: Message[]; threadId: string }>> {
  const qs = before ? `?before=${encodeURIComponent(before)}` : '';
  return apiGet(`/api/threads/${threadId}/messages${qs}`);
}

export async function sendMessage(
  threadId: string,
  body: string,
): Promise<MsgResult<Message>> {
  return apiPost(`/api/threads/${threadId}/messages`, { body });
}
