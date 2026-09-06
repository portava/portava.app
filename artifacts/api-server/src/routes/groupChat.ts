/**
 * Group chat routes — trip and circle threads.
 *
 * GET  /api/trips/:tripId/chat           — resolve or create trip thread, return thread + messages
 * GET  /api/circles/:circleId/chat       — resolve or create circle thread, return thread + messages
 * PATCH /api/messages/:messageId         — edit own message (any thread type)
 * DELETE /api/messages/:messageId        — soft-delete own message (any thread type)
 * POST /api/trips/:tripId/chat/sync      — admin/dev repair: force membership sync
 * POST /api/circles/:circleId/chat/sync  — admin/dev repair: force membership sync
 *
 * Privacy guarantees:
 * - No GPS, live location, private posts, or service-role fields are exposed.
 * - Access is gated ONLY on accepted trip/circle membership + thread membership.
 * - left_at is checked on all group-thread reads and sends.
 */

import { Router } from 'express';
import { requireUser, sendError, isAcceptedTripMember } from '../lib/http';
import { isUuid } from '../lib/followDecisions';
import { syncTripChatMembers, syncCircleChatMembers } from '../lib/chatSync';
import {
  translateMessageForThread,
  buildDisplayFields,
  markTranslationsPending,
  type TranslationStatusValue,
} from '../services/messageTranslation';
import { nameVisibilitySet } from '../lib/publicIdentity';
import { asyncHandler } from '../lib/asyncHandler';

const router = Router();

const PROFILE_PUBLIC = 'id, handle, name, avatar_url';
const INITIAL_MSG_LIMIT = 50;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function isAcceptedCircleMember(
  sc: any,
  circleOwnerId: string,
  userId: string,
): Promise<boolean> {
  if (userId === circleOwnerId) return true;
  const { data } = await sc
    .from('circle_memberships')
    .select('other_id')
    .eq('user_id', circleOwnerId)
    .eq('other_id', userId)
    .maybeSingle();
  return Boolean(data);
}

async function isActiveThreadMember(
  sc: any,
  threadId: string,
  userId: string,
): Promise<{ active: boolean; left: boolean }> {
  const { data } = await sc
    .from('message_thread_members')
    .select('user_id, left_at')
    .eq('thread_id', threadId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!data) return { active: false, left: false };
  const left = (data as any).left_at !== null;
  return { active: !left, left };
}

async function fetchMessagesForThread(
  sc: any,
  threadId: string,
  userId: string,
): Promise<any[]> {
  const { data } = await sc
    .from('messages')
    .select(`id, thread_id, sender_id, body, deleted_at, created_at, edited_at, original_language, profile:profiles!messages_sender_id_fkey(${PROFILE_PUBLIC})`)
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false })
    .limit(INITIAL_MSG_LIMIT);

  const rows = (data ?? []) as any[];

  const incomingIds = rows
    .filter((m) => m.sender_id !== userId && !m.deleted_at)
    .map((m) => m.id);

  let translationMap: Record<string, any> = {};
  if (incomingIds.length > 0) {
    const { data: tRows } = await sc
      .from('message_translations')
      .select('message_id, source_language, target_language, translated_body, status')
      .in('message_id', incomingIds)
      .eq('recipient_id', userId);
    for (const t of tRows ?? []) translationMap[(t as any).message_id] = t;
  }

  // Universal display-name rule: sender real names default to hidden (@handle)
  // unless the sender has opted in. Viewer always sees their own name.
  const senderIds = [...new Set(rows.map((m) => m.sender_id as string))];
  const allowedNames = await nameVisibilitySet(sc, senderIds);

  return rows.map((m) => {
    const p = m.profile ?? {};
    const isDeleted = Boolean(m.deleted_at);
    const nameAllowed = m.sender_id === userId || allowedNames.has(m.sender_id);
    const tRow = translationMap[m.id] ?? null;

    const display = buildDisplayFields(
      {
        body: isDeleted ? null : m.body,
        deleted: isDeleted,
        senderId: m.sender_id,
        originalLanguage: m.original_language,
      },
      userId,
      tRow
        ? {
            source_language: tRow.source_language,
            target_language: tRow.target_language,
            translated_body: tRow.translated_body,
            status: tRow.status as TranslationStatusValue,
          }
        : null,
    );

    return {
      id: m.id,
      threadId: m.thread_id,
      senderId: m.sender_id,
      senderHandle: p.handle ?? null,
      senderName: nameAllowed ? (p.name ?? null) : null,
      senderAvatarUrl: p.avatar_url ?? null,
      body: isDeleted ? null : m.body,
      deleted: isDeleted,
      createdAt: m.created_at,
      editedAt: m.edited_at ?? null,
      displayBody: display.displayBody,
      originalBody: display.originalBody,
      originalLanguage: display.originalLanguage,
      translated: display.translated,
      translationStatus: display.translationStatus,
      translationLabel: display.translationLabel,
      canShowOriginal: display.canShowOriginal,
    };
  });
}

// ── GET /api/trips/:tripId/chat ───────────────────────────────────────────────

router.get('/trips/:tripId/chat', asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const { tripId } = req.params;
  if (!isUuid(tripId)) { sendError(res, 'invalid_payload', 'Invalid tripId'); return; }

  const isMember = await isAcceptedTripMember(sc, tripId, user.id);
  if (!isMember) {
    const { data: invited } = await sc
      .from('trip_members')
      .select('role')
      .eq('trip_id', tripId)
      .eq('user_id', user.id)
      .eq('role', 'invited')
      .maybeSingle();
    if (invited) {
      res.status(403).json({
        error: 'pending_invite',
        message: 'Accept the invite to join this chat.',
      });
    } else {
      res.status(403).json({
        error: 'not_member',
        message: 'You must be an accepted trip member to access this chat.',
      });
    }
    return;
  }

  const threadId = await syncTripChatMembers(tripId, sc);
  if (!threadId) { sendError(res, 'db_error', 'Failed to resolve trip chat thread', { exposeDetail: true }); return; }

  const { active, left } = await isActiveThreadMember(sc, threadId, user.id);

  const { data: threadRow } = await sc
    .from('message_threads')
    .select('id, thread_type, trip_id, title, status, last_message_at, created_at')
    .eq('id', threadId)
    .maybeSingle();

  const messages = active ? await fetchMessagesForThread(sc, threadId, user.id) : [];

  res.status(200).json({
    thread: {
      id: threadId,
      threadType: 'trip',
      tripId,
      title: (threadRow as any)?.title ?? 'Trip Chat',
      status: (threadRow as any)?.status ?? 'active',
      lastMessageAt: (threadRow as any)?.last_message_at ?? null,
      createdAt: (threadRow as any)?.created_at ?? null,
      memberAccess: left ? 'removed' : 'active',
    },
    messages: [...messages].reverse(),
  });
}));

// ── GET /api/circles/:circleId/chat ──────────────────────────────────────────
// :circleId is the circle owner's user ID.

router.get('/circles/:circleId/chat', asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const { circleId: circleOwnerId } = req.params;
  if (!isUuid(circleOwnerId)) { sendError(res, 'invalid_payload', 'Invalid circleId'); return; }

  const isMember = await isAcceptedCircleMember(sc, circleOwnerId, user.id);
  if (!isMember) {
    const { data: invited } = await sc
      .from('circle_invites')
      .select('id')
      .eq('owner_id', circleOwnerId)
      .eq('recipient_id', user.id)
      .eq('status', 'pending')
      .maybeSingle();
    if (invited) {
      res.status(403).json({
        error: 'pending_invite',
        message: 'Accept the invite to join this chat.',
      });
    } else {
      res.status(403).json({
        error: 'not_member',
        message: 'You must be an accepted circle member to access this chat.',
      });
    }
    return;
  }

  const threadId = await syncCircleChatMembers(circleOwnerId, sc);
  if (!threadId) { sendError(res, 'db_error', 'Failed to resolve circle chat thread', { exposeDetail: true }); return; }

  const { active, left } = await isActiveThreadMember(sc, threadId, user.id);

  const { data: threadRow } = await sc
    .from('message_threads')
    .select('id, thread_type, circle_owner_id, title, status, last_message_at, created_at')
    .eq('id', threadId)
    .maybeSingle();

  const messages = active ? await fetchMessagesForThread(sc, threadId, user.id) : [];

  res.status(200).json({
    thread: {
      id: threadId,
      threadType: 'circle',
      circleOwnerId,
      title: (threadRow as any)?.title ?? 'Trusted Circle',
      status: (threadRow as any)?.status ?? 'active',
      lastMessageAt: (threadRow as any)?.last_message_at ?? null,
      createdAt: (threadRow as any)?.created_at ?? null,
      memberAccess: left ? 'removed' : 'active',
    },
    messages: [...messages].reverse(),
  });
}));

// ── PATCH /api/messages/:messageId — edit own message ────────────────────────

router.patch('/messages/:messageId', asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const { messageId } = req.params;
  if (!isUuid(messageId)) { sendError(res, 'invalid_payload', 'Invalid messageId'); return; }

  const newBody = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!newBody) { sendError(res, 'invalid_payload', 'body is required'); return; }
  if (newBody.length > 4000) { sendError(res, 'invalid_payload', 'body must be 4000 characters or fewer'); return; }

  const { data: msgRow } = await sc
    .from('messages')
    .select('id, thread_id, sender_id, body, deleted_at')
    .eq('id', messageId)
    .maybeSingle();

  if (!msgRow) { sendError(res, 'not_found', 'Message not found'); return; }
  const m = msgRow as any;
  if (m.deleted_at) { sendError(res, 'invalid_payload', 'Cannot edit a deleted message'); return; }
  if (m.sender_id !== user.id) { sendError(res, 'forbidden', 'Only the sender can edit this message'); return; }

  const { active } = await isActiveThreadMember(sc, m.thread_id, user.id);
  if (!active) { sendError(res, 'forbidden', 'You no longer have access to this thread'); return; }

  const now = new Date().toISOString();
  const { error: updateErr } = await sc
    .from('messages')
    .update({ body: newBody, edited_at: now })
    .eq('id', messageId);

  if (updateErr) {
    req.log.error({ err: updateErr }, 'message edit failed');
    sendError(res, 'db_error', updateErr.message);
    return;
  }

  res.status(200).json({
    id: messageId,
    threadId: m.thread_id,
    senderId: user.id,
    body: newBody,
    deleted: false,
    editedAt: now,
  });

  await markTranslationsPending(sc, messageId);

  const { data: senderProfile } = await sc
    .from('profiles')
    .select('preferred_language, preferred_message_language')
    .eq('id', user.id)
    .maybeSingle();
  const senderLanguage = (senderProfile as any)?.preferred_language ?? (senderProfile as any)?.preferred_message_language ?? 'en';

  translateMessageForThread(sc, {
    messageId,
    body: newBody,
    senderId: user.id,
    threadId: m.thread_id,
    senderPreferredLanguage: senderLanguage,
    logger: req.log,
  }).catch(() => {});
}));

// ── DELETE /api/messages/:messageId — soft-delete own message ────────────────

router.delete('/messages/:messageId', asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const { messageId } = req.params;
  if (!isUuid(messageId)) { sendError(res, 'invalid_payload', 'Invalid messageId'); return; }

  const { data: msgRow } = await sc
    .from('messages')
    .select('id, thread_id, sender_id, deleted_at')
    .eq('id', messageId)
    .maybeSingle();

  if (!msgRow) { sendError(res, 'not_found', 'Message not found'); return; }
  const m = msgRow as any;
  if (m.deleted_at) { sendError(res, 'invalid_payload', 'Message is already deleted'); return; }
  if (m.sender_id !== user.id) { sendError(res, 'forbidden', 'Only the sender can delete this message'); return; }

  const { active } = await isActiveThreadMember(sc, m.thread_id, user.id);
  if (!active) { sendError(res, 'forbidden', 'You no longer have access to this thread'); return; }

  const now = new Date().toISOString();
  const { error } = await sc
    .from('messages')
    // body: '' not null. messages.body is `text NOT NULL` (verified on production),
    // so `body: null` raised 23502 and this handler returned db_error to the
    // caller — deleting your own group-chat message failed outright. The empty
    // string still redacts the content, which is the point of the write; readers
    // never surface it either way, because they substitute
    // `body: isDeleted ? null : m.body` off deleted_at.
    // Media must be cleared too. Unsend previously wrote only `deleted_at` and
    // `body: ''`, leaving media_url/media_thumbnail_url intact — and the DM
    // reader (GET /threads/:threadId/messages) emitted those fields
    // unconditionally, so unsending a photo removed the caption and kept
    // serving the picture. Clearing them here is the write half of that fix;
    // the reader also refuses to project media for a tombstoned row.
    .update({
      deleted_at: now,
      body: '',
      media_url: null,
      media_type: null,
      media_thumbnail_url: null,
      media_duration_seconds: null,
    })
    .eq('id', messageId);

  if (error) {
    req.log.error({ err: error }, 'message delete failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ id: messageId, deleted: true });
}));

// ── POST /api/trips/:tripId/chat/sync — owner-only repair endpoint ────────────
// Only the trip owner may force a membership re-sync (e.g. after a bulk-remove).

router.post('/trips/:tripId/chat/sync', asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const { tripId } = req.params;
  if (!isUuid(tripId)) { sendError(res, 'invalid_payload', 'Invalid tripId'); return; }

  const { data: ownerRow } = await sc
    .from('trip_members')
    .select('role')
    .eq('trip_id', tripId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!ownerRow || (ownerRow as any).role !== 'owner') {
    sendError(res, 'forbidden', 'Only the trip owner can trigger sync'); return;
  }

  const threadId = await syncTripChatMembers(tripId, sc);
  if (!threadId) { sendError(res, 'db_error', 'Sync failed', { exposeDetail: true }); return; }

  res.status(200).json({ status: 'synced', threadId });
}));

// ── POST /api/circles/:circleId/chat/sync — owner-only repair endpoint ────────
// Only the circle owner may force a membership re-sync.

router.post('/circles/:circleId/chat/sync', asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const { circleId: circleOwnerId } = req.params;
  if (!isUuid(circleOwnerId)) { sendError(res, 'invalid_payload', 'Invalid circleId'); return; }

  if (user.id !== circleOwnerId) {
    sendError(res, 'forbidden', 'Only the circle owner can trigger sync'); return;
  }

  const threadId = await syncCircleChatMembers(circleOwnerId, sc);
  if (!threadId) { sendError(res, 'db_error', 'Sync failed', { exposeDetail: true }); return; }

  res.status(200).json({ status: 'synced', threadId });
}));

export default router;
