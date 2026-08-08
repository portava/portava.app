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
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

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
    city: string | null;
    language: string | null;
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
  threadType: 'direct' | 'trip' | 'circle' | 'rent_buddy_booking';
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
    msgType?: string;
    subtype?: string | null;
  } | null;
  unreadCount?: number;
  tripCity?: string | null;
  isAiLastMessage?: boolean;
  /**
   * True when the thread is end-to-end encrypted.
   *
   * Declared ahead of use, deliberately: E2EE threads cannot carry a plaintext
   * card payload — POST /api/threads/:id/messages rejects a `body` on a thread
   * with `is_e2ee = true` (artifacts/api-server/src/routes/messaging.ts:1616-1666).
   * A recipient picker that lists every thread will therefore offer an E2EE
   * thread happily and only fail *after* the user taps Send.
   *
   * `GET /api/me/threads` does not populate this field today, so it reads as
   * `undefined` → falsy → every thread is treated as plaintext, which is the
   * current behaviour exactly. Nothing reads it yet; it exists so the picker
   * can filter on `thread.isE2ee === true` the moment the list endpoint starts
   * returning it, without a second type change.
   */
  isE2ee?: boolean;
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
  /** Client-generated id for optimistic-send correlation (set locally; echoed by the server). */
  clientId?: string | null;
  /** Local delivery state for optimistic UI. Absent for messages loaded from the server. */
  deliveryStatus?: 'sending' | 'sent' | 'failed';
  /** Saved @mention annotations — whitelist for RichText rendering. */
  tags?: Array<{ type: 'user'; id: string; matchToken: string; startChar: number; endChar: number; isBlocked?: boolean; isDeleted?: boolean }>;
  /** Saved #hashtag annotations — whitelist for RichText rendering. */
  hashtagUsages?: Array<{ slug: string; hashtagId: string; startChar: number; endChar: number; isBlocked?: boolean }>;
  /** Reply threading — populated after migration 0057_reply_to_messages.sql is applied. */
  replyToId?: string | null;
  replyToBody?: string | null;
  replyToSenderName?: string | null;
  /** Media fields — null for text-only messages (migration 0152_messages_media.sql). */
  mediaUrl?: string | null;
  mediaType?: 'image' | 'video' | null;
  mediaThumbnailUrl?: string | null;
  mediaDurationSeconds?: number | null;
  /** Local-only upload state for optimistic media messages. */
  uploadState?: 'uploading' | 'failed' | null;
  /** 0–1 upload progress fraction (local only). */
  uploadProgress?: number;
}

export type MsgErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_payload'
  | 'db_error'
  | 'network_unreachable'
  | 'config_error';

import { buildOutgoingPayload } from '../lib/e2ee/threadCrypto.ts';
import { realCryptoPort } from '../lib/e2ee/realPort.ts';

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
  return freshApiToken();
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

export async function getOutgoingRequestStatus(
  userId: string,
): Promise<MsgResult<{ pending: boolean; requestId: string | null }>> {
  return apiGet(`/api/users/${userId}/outgoing-request`);
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

export async function getUnreadCounts(): Promise<MsgResult<{ messages: number; notifications: number; meetups: number; newHighlights: number }>> {
  return apiGet('/api/me/unread-counts');
}

export async function markNotificationsRead(): Promise<MsgResult<{ ok: boolean; viewedAt: string }>> {
  return apiPost('/api/me/messaging/inbox-viewed');
}

export async function markHighlightsViewed(): Promise<MsgResult<{ ok: boolean; viewedAt: string }>> {
  return apiPost('/api/me/highlights/mark-viewed');
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
  opts?: {
    msgType?: string;
    subtype?: string;
    clientId?: string;
    replyToId?: string;
    /**
     * True for threads with `is_e2ee`. When set, the body is encrypted and the
     * request carries `ciphertext` with NO `body`.
     *
     * If encryption cannot happen this THROWS E2eeSendBlockedError rather than
     * posting plaintext. That is deliberate and is the whole contract: a
     * message that quietly goes out in the clear on a thread the user has been
     * shown a lock on is worse than a visible failure. Callers must surface the
     * error; they must not catch it and retry without the flag.
     */
    isE2ee?: boolean;
  },
): Promise<MsgResult<Message>> {
  const { isE2ee, ...rest } = opts ?? {};
  const payload = await buildOutgoingPayload(realCryptoPort, threadId, body, isE2ee === true);
  return apiPost(`/api/threads/${threadId}/messages`, { ...payload, ...rest });
}

export async function saveMessage(
  threadId: string,
  messageId: string,
): Promise<MsgResult<{ ok: boolean; savedAt: string }>> {
  return apiPost(`/api/threads/${threadId}/messages/${messageId}/save`, {});
}

/**
 * Relay a transient typing indicator to the other thread members. Best-effort —
 * a failed call is silently ignored (typing is non-critical presence).
 */
export async function sendTyping(
  threadId: string,
  typing: boolean,
): Promise<void> {
  await apiPost(`/api/threads/${threadId}/typing`, { typing }).catch(() => undefined);
}

export async function muteThread(
  threadId: string,
  muted: boolean,
): Promise<MsgResult<{ ok: boolean; muted: boolean }>> {
  return apiPatch(`/api/threads/${threadId}/mute`, { muted });
}

export async function leaveThread(
  threadId: string,
): Promise<MsgResult<{ ok: boolean }>> {
  return apiPost(`/api/threads/${threadId}/leave`);
}

export async function sendDiscoveryCard(
  threadId: string,
  payload: {
    sourceId: string;
    sourceType: string;
    title: string;
    category: string;
    city: string;
    blurb?: string;
    imageUrl?: string;
    priceLevel?: string;
    caption?: string;
  },
): Promise<MsgResult<Message>> {
  return sendMessage(threadId, JSON.stringify(payload), { msgType: 'system', subtype: 'discovery_card' });
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

export async function reportThread(
  threadId: string,
  reason: string,
): Promise<MsgResult<{ ok: boolean }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/threads/${threadId}/report`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) return mapApiError(res.status, await res.json().catch(() => ({})));
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

export async function reportMessage(
  messageId: string,
  reason: string,
): Promise<MsgResult<{ ok: boolean }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/messages/${messageId}/report`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) return mapApiError(res.status, await res.json().catch(() => ({})));
    return { ok: true, data: await res.json() };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

/**
 * Get (or create) a direct Telegraph thread with another user.
 * Uses POST /api/users/:userId/open-thread — permission-engine gated.
 * Returns { threadId, created } on success.
 */
export async function openDirectThread(
  userId: string,
): Promise<MsgResult<{ threadId: string; created: boolean }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: null, errorKind: 'config_error' };
  const token = await freshToken();
  if (!token) return { ok: false, data: null, errorKind: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}/api/users/${encodeURIComponent(userId)}/open-thread`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return mapApiError(res.status, body);
    return { ok: true, data: body };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, data: null, errorKind: 'network_unreachable' };
    return { ok: false, data: null, errorKind: 'db_error', message: e instanceof Error ? e.message : 'Unknown' };
  }
}

// ── Media messages ────────────────────────────────────────────────────────────

/**
 * Create a media message in a thread.
 * The caller must first upload the media via uploadMedia() and pass back the result URL.
 * This route creates the message row with the media fields.
 */
export async function sendMediaMessage(
  threadId: string,
  opts: {
    mediaUrl: string;
    mediaType: 'image' | 'video';
    thumbnailUrl?: string | null;
    durationSeconds?: number | null;
    body?: string;
    clientId?: string;
  },
): Promise<MsgResult<Message>> {
  return apiPost(`/api/threads/${threadId}/media`, opts);
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
