/**
 * Messaging service — typed client over the API server.
 *
 * Covers:
 *   - Message settings (GET/PATCH)
 *   - Language settings (GET/PATCH)
 *   - Message permission (GET verdict)
 *   - Message requests (send, accept, decline, cancel, list incoming)
 *   - Threads (list, open group chat)
 *   - Messages (list paginated, send, retry translation)
 *
 * All writes go through the API server (service-role + JWT verification).
 * No private posts, trip data, live location, or GPS are accessible here.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';

export type MessageVerdict = 'allowed' | 'requires_request' | 'denied';

export type TranslationStatusValue = 'pending' | 'translated' | 'failed' | 'skipped';

export interface MessageSettings {
  message_privacy: 'everyone' | 'followers' | 'following' | 'friends' | 'trip_members' | 'no_one';
  allow_message_requests: boolean;
  allow_trip_member_messages: boolean;
  allow_circle_member_messages: boolean;
  updated_at: string | null;
}

export interface LanguageSettings {
  preferred_message_language: string;
  preferred_language: string | null;
  auto_translate_messages: boolean;
  show_original_messages: boolean;
  translation_updated_at: string | null;
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
  threadType: 'direct' | 'trip' | 'circle';
  tripId: string | null;
  circleOwnerId: string | null;
  title: string | null;
  status: string;
  lastMessageAt: string | null;
  createdAt: string;
  mutedAt: string | null;
  archivedAt: string | null;
  otherMembers: ThreadOtherMember[];
  lastMessagePreview: {
    body: string;
    displayBody: string;
    senderId: string;
    createdAt: string;
  } | null;
}

export interface GroupChatResult {
  threadId: string;
  threadType: 'trip' | 'circle';
  title: string | null;
  tripId: string | null;
  circleOwnerId: string | null;
}

export interface GroupThread {
  id: string;
  threadType: 'trip' | 'circle';
  tripId?: string | null;
  circleOwnerId?: string | null;
  title: string;
  status: string;
  lastMessageAt: string | null;
  createdAt: string | null;
  memberAccess: 'active' | 'removed';
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
  displayBody: string | null;
  originalBody: string | null;
  originalLanguage: string | null;
  translated: boolean;
  translationStatus: TranslationStatusValue | null;
  translationLabel: string | null;
  canShowOriginal: boolean;
  msgType: string;
  subtype: string | null;
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

// ── Language settings ─────────────────────────────────────────────────────────

export async function getMyLanguageSettings(): Promise<MsgResult<LanguageSettings>> {
  return apiGet('/api/me/language-settings');
}

export async function updateMyLanguageSettings(
  patch: Partial<Omit<LanguageSettings, 'translation_updated_at'>>,
): Promise<MsgResult<LanguageSettings>> {
  return apiPatch('/api/me/language-settings', patch);
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

export async function getUnreadCounts(): Promise<MsgResult<{ messages: number; notifications: number; meetups: number }>> {
  return apiGet('/api/me/unread-counts');
}

export async function markNotificationsRead(): Promise<MsgResult<{ ok: boolean; viewedAt: string }>> {
  return apiPost('/api/me/notifications/read-all');
}

export async function markThreadRead(
  threadId: string,
): Promise<MsgResult<{ ok: boolean; threadId: string; lastReadAt: string }>> {
  return apiPost(`/api/threads/${threadId}/read`);
}

// ── Group chat ────────────────────────────────────────────────────────────────

/**
 * Get (or create) the group chat thread for a trip.
 * The caller must be an accepted trip member (owner or member role).
 */
export async function openTripChat(
  tripId: string,
): Promise<MsgResult<GroupChatResult>> {
  return apiGet(`/api/trips/${tripId}/chat`);
}

export async function openCircleChat(
  circleOwnerId: string,
): Promise<MsgResult<GroupChatResult>> {
  return apiGet(`/api/circles/${circleOwnerId}/chat`);
}

export async function getTripChat(
  tripId: string,
): Promise<MsgResult<{ thread: GroupThread; messages: Message[] }>> {
  return apiGet(`/api/trips/${tripId}/chat`);
}

export async function getCircleChat(
  circleOwnerId: string,
): Promise<MsgResult<{ thread: GroupThread; messages: Message[] }>> {
  return apiGet(`/api/circles/${circleOwnerId}/chat`);
}

export async function syncTripChat(
  tripId: string,
): Promise<MsgResult<{ status: string; threadId: string }>> {
  return apiPost(`/api/trips/${tripId}/chat/sync`);
}

export async function syncCircleChat(
  circleOwnerId: string,
): Promise<MsgResult<{ status: string; threadId: string }>> {
  return apiPost(`/api/circles/${circleOwnerId}/chat/sync`);
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
  opts?: { msgType?: string; subtype?: string },
): Promise<MsgResult<Message>> {
  return apiPost(`/api/threads/${threadId}/messages`, { body, ...opts });
}

export async function retryTranslation(
  messageId: string,
): Promise<MsgResult<{ status: string; messageId: string }>> {
  return apiPost(`/api/messages/${messageId}/translate/retry`);
}

export async function editMessage(
  messageId: string,
  body: string,
): Promise<MsgResult<{ id: string; threadId: string; body: string; editedAt: string }>> {
  return apiPatch(`/api/messages/${messageId}`, { body });
}

export async function deleteMessage(
  messageId: string,
): Promise<MsgResult<{ id: string; deleted: boolean }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/messages/${messageId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return mapApiError(res.status, await res.json().catch(() => ({})));
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}
