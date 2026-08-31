/**
 * Messaging routes
 *
 * GET  /api/me/message-settings
 * PATCH /api/me/message-settings
 * GET  /api/me/language-settings
 * PATCH /api/me/language-settings
 * GET  /api/users/:userId/message-permission
 * POST /api/users/:userId/message-request
 * GET  /api/me/message-requests
 * POST /api/message-requests/:requestId/accept
 * POST /api/message-requests/:requestId/decline
 * POST /api/message-requests/:requestId/cancel
 * POST /api/users/:userId/open-thread
 * GET  /api/me/threads
 * GET  /api/threads/:threadId/messages
 * POST /api/threads/:threadId/messages
 * POST /api/messages/:messageId/translate/retry
 *
 * Privacy guarantee: no private posts, trips, live location, exact GPS,
 * circle memberships, or trip memberships are exposed through any of these
 * endpoints. Thread access is gated ONLY by message_thread_members rows.
 */

import { Router } from 'express';
import { isBlockedBetween } from '../lib/blockGuard.js';
import { z } from 'zod';
import { requireUser, sendError } from '../lib/http';
import { canMessage } from '../lib/messagingPermissions';
import { nameVisibilitySet, sanitizeIdentity, resolveHandle, presentedName } from '../lib/publicIdentity';
import { getServiceClient } from '../lib/supabase';
import { resolveInteractionPermissions } from '../services/interactionPermissions.js';
import { isKillSwitchEngaged } from '../lib/featureFlags.js';
import { appStorageUrlInfo } from '../lib/mediaUrl.js';
import { isUuid } from '../lib/followDecisions';
import {
  translateMessageForThread,
  markTranslationsPending,
  buildDisplayFields,
  retranslateForUser,
  type TranslationStatusValue,
} from '../services/messageTranslation';
import { shouldRetranslateOnLanguageChange } from '../lib/retranslateGate';
import {
  syncTripChatMembers,
  syncCircleChatMembers,
} from '../services/groupChatSync';
import { publishToThread, publishToUsers } from '../lib/telegraphEvents';
import { invalidate as invalidateCompassCache } from '../compass/CompassCacheEngine.js';
import { recordTrustEvent } from '../services/trust/TrustEventService.js';
import { getRestrictionState, DegradedPermissionCheckError } from '../services/trust/TrustRestrictionService.js';
import { processTagging } from '../services/tagging/TaggingService.js';
import { enrichSpans } from '../lib/enrichSpans';
import { circleThreadTitle } from '../lib/displayName';
import { NotificationService } from '../services/notifications/NotificationService.js';
import { NotificationRouter } from '../services/notifications/NotificationRouter.js';

const router = Router();

const PROFILE_PUBLIC = 'id, handle, name, display_name, username, full_name, avatar_url';

const MESSAGE_PRIVACY_VALUES = [
  'everyone',
  'followers',
  'following',
  'friends',
  'trip_members',
  'no_one',
] as const;

const LANGUAGE_CODES = [
  'en', 'es', 'fr', 'de', 'ja', 'ko', 'zh', 'pt', 'it', 'ru',
  'ar', 'th', 'vi', 'id', 'tl', 'sv', 'nl', 'pl', 'tr', 'hi',
] as const;

const MessageSettingsPatchSchema = z.object({
  message_privacy: z.enum(MESSAGE_PRIVACY_VALUES).optional(),
  allow_message_requests: z.boolean().optional(),
  allow_trip_member_messages: z.boolean().optional(),
  allow_circle_member_messages: z.boolean().optional(),
});

const LanguageSettingsPatchSchema = z.object({
  preferred_message_language: z.enum(LANGUAGE_CODES).optional(),
  preferred_language: z.enum(LANGUAGE_CODES).nullable().optional(),
  auto_translate_messages: z.boolean().optional(),
  show_original_messages: z.boolean().optional(),
});

/* ---------------------------------------------------------------------------
 * GET /api/me/message-settings
 * ---------------------------------------------------------------------------
 */
router.get('/me/message-settings', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { data, error } = await client
    .from('user_message_settings')
    .select('message_privacy, allow_message_requests, allow_trip_member_messages, allow_circle_member_messages, updated_at')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, 'message settings select failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json(
    data ?? {
      message_privacy: 'everyone',
      allow_message_requests: true,
      allow_trip_member_messages: true,
      allow_circle_member_messages: true,
      updated_at: null,
    },
  );
});

/* ---------------------------------------------------------------------------
 * PATCH /api/me/message-settings
 * ---------------------------------------------------------------------------
 */
router.patch('/me/message-settings', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = MessageSettingsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues.map((i) => i.message).join('; '));
    return;
  }

  const patch = { ...parsed.data, user_id: user.id, updated_at: new Date().toISOString() };

  const { data, error } = await client
    .from('user_message_settings')
    .upsert(patch, { onConflict: 'user_id' })
    .select('message_privacy, allow_message_requests, allow_trip_member_messages, allow_circle_member_messages, updated_at')
    .single();

  if (error) {
    req.log.error({ err: error }, 'message settings upsert failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json(data);
});

/* ---------------------------------------------------------------------------
 * GET /api/me/language-settings
 * ---------------------------------------------------------------------------
 * Returns the current user's translation / language preferences.
 */
router.get('/me/language-settings', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { data, error } = await client
    .from('profiles')
    .select('preferred_message_language, preferred_language, auto_translate_messages, show_original_messages, translation_updated_at')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, 'language settings select failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json(
    data ?? {
      preferred_message_language: 'en',
      preferred_language: null,
      auto_translate_messages: true,
      show_original_messages: false,
      translation_updated_at: null,
    },
  );
});

/* ---------------------------------------------------------------------------
 * PATCH /api/me/language-settings
 * ---------------------------------------------------------------------------
 */
router.patch('/me/language-settings', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = LanguageSettingsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues.map((i) => i.message).join('; '));
    return;
  }

  const patch: Record<string, unknown> = { ...parsed.data, translation_updated_at: new Date().toISOString() };

  // Capture the current preferred_language before updating so we can detect a change.
  const { data: before } = await client
    .from('profiles')
    .select('preferred_language')
    .eq('id', user.id)
    .single();

  const { data, error } = await client
    .from('profiles')
    .update(patch)
    .eq('id', user.id)
    .select('preferred_message_language, preferred_language, auto_translate_messages, show_original_messages, translation_updated_at')
    .single();

  if (error) {
    req.log.error({ err: error }, 'language settings update failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  // Fire-and-forget re-translation sweep when the translation target changes.
  const newLang = (data as any).preferred_language as string | null;
  const oldLang = (before as any)?.preferred_language as string | null;
  // Gated on auto_translate_messages. Ungated, changing the display language
  // fired a sweep of up to 200 messages at the translation provider for users
  // who had never asked for message translation at all.
  if (newLang && shouldRetranslateOnLanguageChange({
    newLanguage: newLang,
    oldLanguage: oldLang,
    autoTranslateMessages: (data as any).auto_translate_messages,
  })) {
    const sc = getServiceClient();
    if (sc) {
      retranslateForUser(sc, user.id, newLang, req.log).catch(() => {});
    }
  }

  res.status(200).json(data);
});

/* ---------------------------------------------------------------------------
 * GET /api/users/:userId/message-permission
 * ---------------------------------------------------------------------------
 */
router.get('/users/:userId/message-permission', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const targetId = req.params.userId;
  if (!isUuid(targetId)) {
    sendError(res, 'invalid_payload', 'Invalid user id');
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const verdict = await canMessage(sc, user.id, targetId);

  res.status(200).json({
    verdict: verdict.verdict,
    allowed: verdict.allowed,
    reason: verdict.reason ?? null,
    relationship_context: verdict.relationship_context,
  });
});

/* ---------------------------------------------------------------------------
 * POST /api/users/:userId/open-thread
 * ---------------------------------------------------------------------------
 */
router.post('/users/:userId/open-thread', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const recipientId = req.params.userId;
  if (!isUuid(recipientId)) { sendError(res, 'invalid_payload', 'Invalid user id'); return; }
  if (recipientId === user.id) { sendError(res, 'invalid_payload', 'Cannot open a thread with yourself'); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // Phase 4 permission engine gate — primary authorization check (fail-closed)
  try {
    const msgPerms = await resolveInteractionPermissions(sc, user.id, recipientId);
    if (!msgPerms.canMessage) {
      if (msgPerms.canSendMessageRequest) {
        sendError(res, 'forbidden', 'This user requires a message request first. Use POST /api/users/:userId/message-request.');
      } else {
        sendError(res, 'forbidden', 'Cannot message this user');
      }
      return;
    }
  } catch (err) {
    req.log.error({ err }, 'permission engine failed for open-thread');
    sendError(res, 'db_error', 'Permission check failed');
    return;
  }

  const { data: myMemberships } = await sc
    .from('message_thread_members')
    .select('thread_id')
    .eq('user_id', user.id);

  const myThreadIds = (myMemberships ?? []).map((m: any) => m.thread_id);

  let existingThreadId: string | null = null;
  if (myThreadIds.length > 0) {
    const { data: allMembers } = await sc
      .from('message_thread_members')
      .select('thread_id, user_id')
      .in('thread_id', myThreadIds);

    const membersByThread: Record<string, string[]> = {};
    for (const m of (allMembers ?? []) as any[]) {
      if (!membersByThread[m.thread_id]) membersByThread[m.thread_id] = [];
      membersByThread[m.thread_id].push(m.user_id);
    }

    const candidateIds: string[] = [];
    for (const [threadId, members] of Object.entries(membersByThread)) {
      if (members.length === 2 && members.includes(user.id) && members.includes(recipientId)) {
        candidateIds.push(threadId);
      }
    }

    // Only reuse true DM threads. Trip/circle group threads can also have exactly
    // two members — matching those would hijack a group chat as the DM. The DM
    // create path below relies on the DB default thread_type='direct', so accept
    // 'direct' (or NULL for legacy rows).
    if (candidateIds.length > 0) {
      const { data: candidateThreads } = await sc
        .from('message_threads')
        .select('id, thread_type')
        .in('id', candidateIds);
      const direct = ((candidateThreads ?? []) as any[]).find(
        (t) => t.thread_type === 'direct' || t.thread_type == null,
      );
      if (direct) existingThreadId = direct.id;
    }
  }

  if (existingThreadId) {
    // Reusing a thread one (or both) parties previously left: reset left_at so
    // the conversation is usable again for both sides.
    await sc
      .from('message_thread_members')
      .update({ left_at: null })
      .eq('thread_id', existingThreadId)
      .in('user_id', [user.id, recipientId]);

    res.status(200).json({ threadId: existingThreadId, created: false });
    return;
  }

  const now = new Date().toISOString();
  const { data: thread, error: tErr } = await sc
    .from('message_threads')
    .insert({ created_at: now, updated_at: now })
    .select('id')
    .single();

  if (tErr || !thread) {
    req.log.error({ err: tErr }, 'thread creation failed');
    sendError(res, 'db_error', tErr?.message ?? 'Failed to create thread');
    return;
  }

  const threadId = (thread as any).id;
  const { error: memErr } = await sc.from('message_thread_members').insert([
    { thread_id: threadId, user_id: user.id, joined_at: now },
    { thread_id: threadId, user_id: recipientId, joined_at: now },
  ]);
  if (memErr) {
    // Membership is the ONLY gate on the thread: a thread with no member rows is
    // permanently unreadable (every read/send 403s "Not a member"), the dedupe
    // above requires members.length===2 so it is never reused, and no trigger
    // repairs it. supabase-js resolves rather than throws on a write error, so
    // this must be checked explicitly. Roll the just-created thread back.
    req.log.error({ err: memErr, threadId }, 'thread members insert failed — rolling back orphan thread');
    await sc.from('message_threads').delete().eq('id', threadId);
    sendError(res, 'db_error', memErr.message ?? 'Failed to add thread members');
    return;
  }

  res.status(201).json({ threadId, created: true });
});

/* ---------------------------------------------------------------------------
 * GET /api/users/:userId/outgoing-request
 * Returns whether the current user has a pending message request to :userId.
 * ---------------------------------------------------------------------------
 */
router.get('/users/:userId/outgoing-request', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const recipientId = req.params.userId;
  if (!isUuid(recipientId)) { sendError(res, 'invalid_payload', 'Invalid user id'); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const { data, error } = await sc
    .from('message_requests')
    .select('id, status')
    .eq('sender_id', user.id)
    .eq('recipient_id', recipientId)
    .eq('status', 'pending')
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, 'outgoing-request check failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ pending: data !== null, requestId: (data as any)?.id ?? null });
});

/* ---------------------------------------------------------------------------
 * POST /api/users/:userId/message-request
 * ---------------------------------------------------------------------------
 */
router.post('/users/:userId/message-request', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const recipientId = req.params.userId;
  if (!isUuid(recipientId)) { sendError(res, 'invalid_payload', 'Invalid user id'); return; }
  if (recipientId === user.id) { sendError(res, 'invalid_payload', 'You cannot send a message request to yourself'); return; }

  const { data: profile } = await client.from('profiles').select('id').eq('id', recipientId).maybeSingle();
  if (!profile) { sendError(res, 'not_found', 'User not found'); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // Emergency stop: disable_unknown_message_requests — fail-CLOSED on DB error
  if (await isKillSwitchEngaged(sc, 'disable_unknown_message_requests')) {
    sendError(res, 'feature_disabled', 'New message requests are temporarily disabled');
    return;
  }

  // Phase 4 permission engine gate — deny when blocked or suspended.
  // resolveInteractionPermissions' own trust-restriction check is
  // fail-CLOSED and throws DegradedPermissionCheckError when the check
  // itself couldn't run (not when it ran and found a restriction) — that
  // must show the same retryable "try again" message TrustRestrictionService's
  // direct callers show, never the generic 500 below, which is for every
  // OTHER reason this permission engine can fail (e.g. the blocks check).
  try {
    const reqPerms = await resolveInteractionPermissions(sc, user.id, recipientId);
    if (!reqPerms.canMessage && !reqPerms.canSendMessageRequest) {
      sendError(res, 'forbidden', 'Cannot send a message request to this user');
      return;
    }
  } catch (err) {
    if (err instanceof DegradedPermissionCheckError && err.degradedReason === 'fail_closed') {
      sendError(
        res,
        'degraded_unavailable',
        'We could not verify your permissions right now. Please try again shortly.',
      );
      return;
    }
    req.log.error({ err }, 'permission engine failed for message-request');
    sendError(res, 'db_error', 'Permission check failed');
    return;
  }

  // Trust Engine: check if sender is restricted from messaging.
  // canMessage=false means either a real restriction or a degraded read that
  // failed CLOSED (the check itself could not be performed) — those must
  // show different messages. A fail-OPEN degraded read never reaches here:
  // canMessage is true in that case, same as a clean allowed read.
  const senderRestrictions = await getRestrictionState(sc, user.id);
  if (!senderRestrictions.canMessage) {
    if (senderRestrictions.degradedReason === 'fail_closed') {
      sendError(
        res,
        'degraded_unavailable',
        'We could not verify your permissions right now. Please try again shortly.',
      );
      return;
    }
    sendError(res, 'forbidden', 'Your account is currently restricted from sending messages.');
    return;
  }

  const verdict = await canMessage(sc, user.id, recipientId);
  if (verdict.verdict === 'denied') {
    sendError(res, 'forbidden', `Cannot message this user: ${verdict.reason ?? 'denied'}`);
    return;
  }

  const { data: existing } = await sc
    .from('message_requests')
    .select('id, status')
    .eq('sender_id', user.id)
    .eq('recipient_id', recipientId)
    .maybeSingle();

  if (existing) {
    const ex = existing as any;
    if (ex.status === 'pending') {
      res.status(200).json({ requestId: ex.id, status: 'pending', idempotent: true });
      return;
    }
    if (ex.status === 'accepted') {
      res.status(200).json({ requestId: ex.id, status: 'accepted' });
      return;
    }
  }

  const previewText = typeof req.body?.previewText === 'string'
    ? req.body.previewText.slice(0, 280)
    : null;

  const { data: newReq, error } = await sc
    .from('message_requests')
    .insert({ sender_id: user.id, recipient_id: recipientId, preview_text: previewText })
    .select('id')
    .single();

  if (error) {
    req.log.error({ err: error }, 'message_requests insert failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(201).json({ requestId: (newReq as any).id, status: 'pending' });

  // Realtime: notify the recipient a new message request arrived.
  void publishToUsers([recipientId], {
    type: 'request.created',
    payload: { requestId: (newReq as any).id, senderId: user.id },
  });
});

/* ---------------------------------------------------------------------------
 * GET /api/me/message-requests
 * ---------------------------------------------------------------------------
 */
router.get('/me/message-requests', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const { data, error } = await sc
    .from('message_requests')
    .select('id, sender_id, preview_text, created_at')
    .eq('recipient_id', user.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) {
    req.log.error({ err: error }, 'message_requests query failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  const senderIds = [...new Set((data ?? []).map((r: any) => r.sender_id))];
  let profileMap: Record<string, any> = {};
  let locationMap: Record<string, string | null> = {};
  if (senderIds.length > 0) {
    const { data: profiles } = await sc
      .from('profiles')
      .select('id, handle, name, username, full_name, avatar_url, default_language')
      .in('id', senderIds);
    for (const p of profiles ?? []) profileMap[(p as any).id] = p;

    const { data: locations } = await sc
      .from('user_location_state')
      .select('user_id, city')
      .in('user_id', senderIds);
    for (const l of locations ?? []) locationMap[(l as any).user_id] = (l as any).city ?? null;
  }

  const requests = (data ?? []).map((r: any) => {
    const p = profileMap[r.sender_id];
    return {
      requestId: r.id,
      previewText: r.preview_text ?? null,
      createdAt: r.created_at,
      sender: p
        ? {
            id: p.id,
            handle: resolveHandle(p),
            name: p.name ?? p.full_name ?? null,
            avatarUrl: p.avatar_url ?? null,
            city: locationMap[p.id] ?? null,
            language: p.default_language ?? null,
          }
        : null,
    };
  });

  res.status(200).json({ requests });
});

/* ---------------------------------------------------------------------------
 * POST /api/message-requests/:requestId/accept
 * ---------------------------------------------------------------------------
 */
router.post('/message-requests/:requestId/accept', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { requestId } = req.params;
  if (!isUuid(requestId)) { sendError(res, 'invalid_payload', 'Invalid request id'); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const { data: mr } = await sc
    .from('message_requests')
    .select('id, sender_id, recipient_id, status, preview_text')
    .eq('id', requestId)
    .maybeSingle();

  if (!mr) { sendError(res, 'not_found', 'Message request not found'); return; }
  const req_ = mr as any;
  if (req_.recipient_id !== user.id) { sendError(res, 'forbidden', 'Only the recipient can accept this request'); return; }
  if (req_.status !== 'pending') { sendError(res, 'invalid_payload', `Request is already ${req_.status}`); return; }

  const now = new Date().toISOString();

  // Compare-and-swap the status transition FIRST so a double-submit (or two
  // concurrent accepts) can only win once. Only the request that flips
  // pending → accepted proceeds with thread creation / preview message.
  const { data: casRows, error: casErr } = await sc
    .from('message_requests')
    .update({ status: 'accepted', responded_at: now })
    .eq('id', requestId)
    .eq('status', 'pending')
    .select('id');

  if (casErr) {
    req.log.error({ err: casErr }, 'message_requests accept update failed');
    sendError(res, 'db_error', casErr.message);
    return;
  }

  if (!casRows || (casRows as any[]).length === 0) {
    // Lost the race — another submit already transitioned this request.
    const { data: current } = await sc
      .from('message_requests')
      .select('status')
      .eq('id', requestId)
      .maybeSingle();
    sendError(res, 'invalid_payload', `Request is already ${(current as any)?.status ?? 'accepted'}`);
    return;
  }

  const { data: senderMemberships } = await sc
    .from('message_thread_members')
    .select('thread_id')
    .eq('user_id', req_.sender_id);

  const senderThreadIds = (senderMemberships ?? []).map((m: any) => m.thread_id);

  let existingDirectThreadId: string | null = null;
  if (senderThreadIds.length > 0) {
    const { data: allMembers } = await sc
      .from('message_thread_members')
      .select('thread_id, user_id')
      .in('thread_id', senderThreadIds);

    const membersByThread: Record<string, string[]> = {};
    for (const m of (allMembers ?? []) as any[]) {
      if (!membersByThread[m.thread_id]) membersByThread[m.thread_id] = [];
      membersByThread[m.thread_id].push(m.user_id);
    }

    const candidateIds: string[] = [];
    for (const [tid, members] of Object.entries(membersByThread)) {
      if (
        members.length === 2 &&
        members.includes(req_.sender_id) &&
        members.includes(req_.recipient_id)
      ) {
        candidateIds.push(tid);
      }
    }

    // Only reuse true DM threads — trip/circle group threads can also have
    // exactly two members. DM threads carry thread_type='direct' (DB default)
    // or NULL on legacy rows.
    if (candidateIds.length > 0) {
      const { data: candidateThreads } = await sc
        .from('message_threads')
        .select('id, thread_type')
        .in('id', candidateIds);
      const direct = ((candidateThreads ?? []) as any[]).find(
        (t) => t.thread_type === 'direct' || t.thread_type == null,
      );
      if (direct) existingDirectThreadId = direct.id;
    }
  }

  let threadId: string;

  if (existingDirectThreadId) {
    threadId = existingDirectThreadId;
    // Reusing a thread one (or both) parties previously left: reset left_at so
    // the conversation is usable again for both sides.
    await sc
      .from('message_thread_members')
      .update({ left_at: null })
      .eq('thread_id', threadId)
      .in('user_id', [req_.sender_id, req_.recipient_id]);
  } else {
    const { data: thread, error: tErr } = await sc
      .from('message_threads')
      .insert({ created_at: now, updated_at: now })
      .select('id')
      .single();

    if (tErr || !thread) {
      req.log.error({ err: tErr }, 'thread creation failed');
      sendError(res, 'db_error', tErr?.message ?? 'Failed to create thread');
      return;
    }

    threadId = (thread as any).id;

    const { error: memErr } = await sc.from('message_thread_members').insert([
      { thread_id: threadId, user_id: req_.sender_id, joined_at: now },
      { thread_id: threadId, user_id: req_.recipient_id, joined_at: now },
    ]);
    if (memErr) {
      // A thread with no member rows is permanently unreadable and never reused
      // or repaired. supabase-js resolves rather than throws on a write error,
      // so check it and roll the just-created thread back.
      req.log.error({ err: memErr, threadId }, 'thread members insert failed — rolling back orphan thread');
      await sc.from('message_threads').delete().eq('id', threadId);
      sendError(res, 'db_error', memErr.message ?? 'Failed to add thread members');
      return;
    }
  }

  res.status(200).json({ status: 'accepted', threadId, requestId });

  // Feed connection event into Trust Engine for both parties (fire-and-forget; flag-gated)
  void recordTrustEvent(sc, {
    userId: user.id,
    eventType: "telegraph_connection_accepted",
    category: "communication",
    delta: 1,
    severity: "minor",
    sourceType: "message_request",
    sourceId: requestId,
    dedupWindowHours: 72,
  });
  void recordTrustEvent(sc, {
    userId: req_.sender_id,
    eventType: "telegraph_connection_accepted",
    category: "communication",
    delta: 1,
    severity: "minor",
    sourceType: "message_request",
    sourceId: requestId,
    dedupWindowHours: 72,
  });

  // Realtime: notify the original sender that their request was accepted and a
  // thread now exists. Members of the (possibly new) thread get a thread.updated.
  void publishToUsers([req_.sender_id], {
    type: 'request.accepted',
    threadId,
    payload: { requestId, threadId, byUserId: user.id },
  });
  void publishToThread(sc, threadId, { type: 'thread.updated', payload: { threadId } });

  // After response: if there is a preview message, insert it as a real message and translate.
  // Only run if the preview_text was not already inserted (new thread creation path or no messages yet).
  const previewBody = typeof req_.preview_text === 'string' ? req_.preview_text.trim() : '';
  // Never persist server-readable plaintext into an e2ee thread. A message
  // request can be accepted into a reused existing direct thread that is e2ee;
  // inserting the plaintext preview_text there would break the E2EE invariant
  // (audit MSG-3). Skip the preview insert for e2ee threads.
  const { data: acceptThreadMeta } = await sc
    .from('message_threads')
    .select('is_e2ee')
    .eq('id', threadId)
    .maybeSingle();
  const threadIsE2ee = (acceptThreadMeta as any)?.is_e2ee === true;
  if (previewBody && !threadIsE2ee) {
    const { data: senderProfile } = await sc
      .from('profiles')
      .select('preferred_language, preferred_message_language')
      .eq('id', req_.sender_id)
      .maybeSingle();
    const senderLanguage = (senderProfile as any)?.preferred_language ?? (senderProfile as any)?.preferred_message_language ?? 'en';

    const { data: previewMsg } = await sc
      .from('messages')
      .insert({ thread_id: threadId, sender_id: req_.sender_id, body: previewBody, created_at: now })
      .select('id')
      .single();

    await sc
      .from('message_threads')
      .update({ last_message_at: now, updated_at: now })
      .eq('id', threadId);

    if (previewMsg) {
      translateMessageForThread(sc, {
        messageId: (previewMsg as any).id,
        body: previewBody,
        senderId: req_.sender_id,
        threadId,
        senderPreferredLanguage: senderLanguage,
        logger: req.log,
      }).catch(() => {});
    }
  }
});

/* ---------------------------------------------------------------------------
 * POST /api/message-requests/:requestId/decline
 * ---------------------------------------------------------------------------
 */
router.post('/message-requests/:requestId/decline', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { requestId } = req.params;
  if (!isUuid(requestId)) { sendError(res, 'invalid_payload', 'Invalid request id'); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const { data: mr } = await sc
    .from('message_requests')
    .select('id, sender_id, recipient_id, status')
    .eq('id', requestId)
    .maybeSingle();

  if (!mr) { sendError(res, 'not_found', 'Message request not found'); return; }
  const req_ = mr as any;
  if (req_.recipient_id !== user.id) { sendError(res, 'forbidden', 'Only the recipient can decline this request'); return; }
  if (req_.status !== 'pending') { sendError(res, 'invalid_payload', `Request is already ${req_.status}`); return; }

  const now = new Date().toISOString();
  await sc.from('message_requests').update({ status: 'declined', responded_at: now }).eq('id', requestId);

  res.status(200).json({ status: 'declined', requestId });

  // Realtime: notify the original sender their request was declined.
  if (req_.sender_id) {
    void publishToUsers([req_.sender_id], {
      type: 'request.declined',
      payload: { requestId },
    });
  }
});

/* ---------------------------------------------------------------------------
 * POST /api/message-requests/:requestId/cancel
 * ---------------------------------------------------------------------------
 */
router.post('/message-requests/:requestId/cancel', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { requestId } = req.params;
  if (!isUuid(requestId)) { sendError(res, 'invalid_payload', 'Invalid request id'); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const { data: mr } = await sc
    .from('message_requests')
    .select('id, sender_id, status')
    .eq('id', requestId)
    .maybeSingle();

  if (!mr) { sendError(res, 'not_found', 'Message request not found'); return; }
  const req_ = mr as any;
  if (req_.sender_id !== user.id) { sendError(res, 'forbidden', 'Only the sender can cancel this request'); return; }
  if (req_.status !== 'pending') { sendError(res, 'invalid_payload', `Request is already ${req_.status}`); return; }

  await sc.from('message_requests').update({ status: 'cancelled' }).eq('id', requestId);

  res.status(200).json({ status: 'cancelled', requestId });
});

/* ---------------------------------------------------------------------------
 * GET /api/me/unread-counts
 * ---------------------------------------------------------------------------
 * Returns { messages: number; notifications: number; meetups: number; newHighlights: number }
 *   messages       — threads with at least one unread message not sent by the caller
 *   notifications  — pending inbox items (friend requests, circle invites, trip
 *                    invites, message requests) created after the caller last
 *                    viewed their Inbox (profiles.notifications_inbox_viewed_at).
 *   newHighlights  — active highlights from circle members posted since the
 *                    caller last opened the highlights viewer
 *                    (profiles.highlights_last_viewed_at).
 */
router.get('/me/unread-counts', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // ── Run messages query and notifications queries in parallel ──────────────
  const [membershipsResult, profileResult] = await Promise.all([
    sc
      .from('message_thread_members')
      .select('thread_id, last_read_at')
      .eq('user_id', user.id)
      .is('left_at', null),
    sc
      .from('profiles')
      .select('notifications_inbox_viewed_at, highlights_last_viewed_at')
      .eq('id', user.id)
      .maybeSingle(),
  ]);

  let { data: memberships, error: mErr } = membershipsResult;

  // Migration 0016 adds last_read_at to message_thread_members. If it hasn't
  // been applied yet (pg error 42703 = undefined column), fall back to a query
  // without it — every thread is treated as potentially unread.
  if (mErr && (mErr as any).code === '42703') {
    const fallback = await sc
      .from('message_thread_members')
      .select('thread_id')
      .eq('user_id', user.id)
      .is('left_at', null);
    if (fallback.error) {
      req.log.error({ err: fallback.error }, 'unread-counts membership query failed');
      sendError(res, 'db_error', fallback.error.message);
      return;
    }
    memberships = (fallback.data ?? []).map((r) => ({ ...r, last_read_at: null }));
    mErr = null;
  }

  if (mErr) {
    req.log.error({ err: mErr }, 'unread-counts membership query failed');
    sendError(res, 'db_error', mErr.message);
    return;
  }

  const inboxViewedAt: string | null = (profileResult.data as any)?.notifications_inbox_viewed_at ?? null;
  const highlightsViewedAt: string | null = (profileResult.data as any)?.highlights_last_viewed_at ?? null;

  // ── Message unread count ──────────────────────────────────────────────────
  const threadIds = (memberships ?? []).map((m: any) => m.thread_id as string);
  let messageCount = 0;

  if (threadIds.length > 0) {
    const readAtByThread: Record<string, string | null> = {};
    for (const m of memberships ?? []) {
      // last_read_at may be absent if migration 0016 is pending; default null
      readAtByThread[(m as any).thread_id] = (m as any).last_read_at ?? null;
    }

    const { data: threads, error: tErr } = await sc
      .from('message_threads')
      .select('id, last_message_at')
      .in('id', threadIds)
      .not('last_message_at', 'is', null);

    if (tErr) {
      req.log.error({ err: tErr }, 'unread-counts thread query failed');
      sendError(res, 'db_error', tErr.message);
      return;
    }

    const potentiallyUnreadThreadIds = (threads ?? [])
      .filter((t: any) => {
        const lastReadAt = readAtByThread[t.id];
        if (!lastReadAt) return true;
        return new Date(t.last_message_at) > new Date(lastReadAt);
      })
      .map((t: any) => t.id as string);

    if (potentiallyUnreadThreadIds.length > 0) {
      const { data: lastMsgs, error: lmErr } = await sc
        .from('messages')
        .select('thread_id, sender_id, created_at')
        .in('thread_id', potentiallyUnreadThreadIds)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });

      if (lmErr) {
        req.log.error({ err: lmErr }, 'unread-counts messages query failed');
        sendError(res, 'db_error', lmErr.message);
        return;
      }

      const lastMsgByThread: Record<string, any> = {};
      for (const m of lastMsgs ?? []) {
        if (!lastMsgByThread[(m as any).thread_id]) {
          lastMsgByThread[(m as any).thread_id] = m;
        }
      }

      for (const threadId of potentiallyUnreadThreadIds) {
        const lm = lastMsgByThread[threadId];
        if (!lm) continue;
        if ((lm as any).sender_id === user.id) continue;
        const lastReadAt = readAtByThread[threadId];
        if (!lastReadAt || new Date((lm as any).created_at) > new Date(lastReadAt)) {
          messageCount++;
        }
      }
    }
  }

  // ── Notification unread count ─────────────────────────────────────────────
  // Count pending inbox items created after the user last viewed the Inbox.
  // Covers: friend requests, circle invites, trip invites, message requests.
  function pendingSince(table: string, filterCol: string) {
    let q = (sc as any).from(table).select('id', { count: 'exact', head: true })
      .eq(filterCol, user.id).eq('status', 'pending');
    if (inboxViewedAt) q = q.gt('created_at', inboxViewedAt);
    return q as Promise<{ count: number | null; error: any }>;
  }

  let tiQ = (sc as any).from('trip_members').select('user_id', { count: 'exact', head: true })
    .eq('user_id', user.id).eq('role', 'invited');
  if (inboxViewedAt) tiQ = tiQ.gt('created_at', inboxViewedAt);

  // availability nudge count
  let anQ = (sc as any).from('availability_nudges')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', user.id);
  if (inboxViewedAt) anQ = anQ.gt('created_at', inboxViewedAt);

  // Upcoming confirmed meetups where user RSVP'd going/maybe — runs in parallel
  const meetupCountPromise = (async (): Promise<number> => {
    const now = new Date().toISOString();
    const { data: upcoming } = await sc
      .from('meetups')
      .select('id')
      .eq('status', 'confirmed')
      .gt('starts_at', now);
    const ids = (upcoming ?? []).map((m: any) => m.id as string);
    if (ids.length === 0) return 0;
    const { count } = await (sc as any)
      .from('meetup_invites')
      .select('meetup_id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .in('status', ['going', 'maybe'])
      .in('meetup_id', ids);
    return count ?? 0;
  })();

  const [frResult, ciResult, tiResult, mrResult, anResult] = await Promise.all([
    pendingSince('friend_requests', 'recipient_id'),
    pendingSince('circle_invites', 'recipient_id'),
    tiQ as Promise<{ count: number | null; error: any }>,
    pendingSince('message_requests', 'recipient_id'),
    anQ as Promise<{ count: number | null; error: any }>,
  ]);

  const meetups = await meetupCountPromise.catch(() => 0);

  const notifCount =
    (frResult.count ?? 0) +
    (ciResult.count ?? 0) +
    (tiResult.count ?? 0) +
    (mrResult.count ?? 0) +
    (anResult.count ?? 0);

  // ── New highlights count ──────────────────────────────────────────────────
  // Count active highlights from users in the caller's circle that were posted
  // after the caller last opened the highlights viewer. Blocks are excluded.
  let newHighlights = 0;
  try {
    const now = new Date().toISOString();

    // 1. Get IDs of users blocked in either direction.
    const [blockedByMe, blockingMe] = await Promise.all([
      sc.from('blocks').select('blocked_id').eq('blocker_id', user.id),
      sc.from('blocks').select('blocker_id').eq('blocked_id', user.id),
    ]);
    const blockedSet = new Set<string>([
      ...((blockedByMe.data ?? []).map((r: any) => r.blocked_id as string)),
      ...((blockingMe.data ?? []).map((r: any) => r.blocker_id as string)),
    ]);

    // 2. Get IDs of users in the caller's circle.
    const { data: circleRows } = await sc
      .from('circle_memberships')
      .select('other_id')
      .eq('user_id', user.id);
    const circleIds = (circleRows ?? [])
      .map((r: any) => r.other_id as string)
      .filter((id: string) => !blockedSet.has(id));

    if (circleIds.length > 0) {
      // 3. Count active highlights from circle members posted after last view.
      let q = (sc as any)
        .from('highlights')
        .select('id', { count: 'exact', head: true })
        .in('owner_id', circleIds)
        .is('deleted_at', null)
        .gt('expires_at', now)
        .in('visibility', ['public', 'travelers_nearby', 'circle_only']);
      if (highlightsViewedAt) {
        q = q.gt('created_at', highlightsViewedAt);
      }
      const { count: hCount } = await q;
      newHighlights = hCount ?? 0;
    }
  } catch (e) {
    req.log.warn({ err: e }, 'unread-counts newHighlights query failed — defaulting to 0');
  }

  res.status(200).json({ messages: messageCount, notifications: notifCount, meetups, newHighlights });
});

/* ---------------------------------------------------------------------------
 * POST /api/me/messaging/inbox-viewed
 * ---------------------------------------------------------------------------
 * Records that the current user has viewed their Inbox by setting
 * profiles.notifications_inbox_viewed_at = now(). The unread-counts endpoint
 * uses this timestamp to compute the notification badge count.
 * (Renamed from /me/notifications/read-all, which shadowed the real
 * mark-all-read handler in notifications.ts.)
 */
router.post('/me/messaging/inbox-viewed', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const now = new Date().toISOString();
  const { error } = await sc
    .from('profiles')
    .update({ notifications_inbox_viewed_at: now })
    .eq('id', user.id);

  if (error) {
    req.log.error({ err: error }, 'mark notifications read failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ ok: true, viewedAt: now });
});

/* ---------------------------------------------------------------------------
 * POST /api/me/highlights/mark-viewed
 * ---------------------------------------------------------------------------
 * Records that the current user has opened the highlights viewer by setting
 * profiles.highlights_last_viewed_at = now(). The unread-counts endpoint
 * uses this timestamp to compute the newHighlights badge count.
 */
router.post('/me/highlights/mark-viewed', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const now = new Date().toISOString();
  const { error } = await sc
    .from('profiles')
    .update({ highlights_last_viewed_at: now })
    .eq('id', user.id);

  if (error) {
    req.log.error({ err: error }, 'mark highlights viewed failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ ok: true, viewedAt: now });
});

/* ---------------------------------------------------------------------------
 * POST /api/threads/:threadId/read
 * ---------------------------------------------------------------------------
 * Marks the thread as read for the current user by updating last_read_at.
 * Idempotent — safe to call on every thread open.
 */
router.post('/threads/:threadId/read', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { threadId } = req.params;
  if (!isUuid(threadId)) { sendError(res, 'invalid_payload', 'Invalid thread id'); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const now = new Date().toISOString();
  const { error } = await sc
    .from('message_thread_members')
    .update({ last_read_at: now })
    .eq('thread_id', threadId)
    .eq('user_id', user.id);

  if (error) {
    req.log.error({ err: error }, 'mark thread read failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ ok: true, threadId, lastReadAt: now });

  // Realtime: let other members update read receipts for this user.
  void publishToThread(
    sc,
    threadId,
    { type: 'read.updated', payload: { userId: user.id, lastReadAt: now } },
    { excludeUserId: user.id },
  );
});

/* ---------------------------------------------------------------------------
 * POST /api/threads/:threadId/e2ee
 * ---------------------------------------------------------------------------
 * Mark a 1:1 thread end-to-end encrypted.
 *
 * ORDERING IS ENFORCED HERE, NOT TRUSTED.
 *
 * An MLS Welcome must already exist in the thread before it can be flagged.
 * The send handler refuses a plaintext body on an E2EE thread, and the Welcome
 * IS a plaintext system message — so flipping the flag first makes the Welcome
 * permanently undeliverable and strands a thread that nobody, including its
 * members, can ever read.
 *
 * The client sequences this correctly, but the client is not the only possible
 * caller and a retry or a crash between steps could invert it. Checking the
 * precondition server-side makes the wrong order impossible rather than merely
 * tested.
 *
 * Idempotent, direct threads only, members only. Never un-sets the flag: going
 * back to plaintext on a thread users were shown a lock on is not a transition
 * this endpoint should be able to make.
 */
router.post('/threads/:threadId/e2ee', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { threadId } = req.params;
  if (!isUuid(threadId)) { sendError(res, 'invalid_payload', 'Invalid thread id'); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // Membership — thread access is gated only by message_thread_members.
  const { data: member } = await sc
    .from('message_thread_members')
    .select('user_id')
    .eq('thread_id', threadId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!member) { sendError(res, 'not_found', 'Thread not found'); return; }

  const { data: thread } = await sc
    .from('message_threads')
    .select('id, thread_type, is_e2ee')
    .eq('id', threadId)
    .maybeSingle();
  if (!thread) { sendError(res, 'not_found', 'Thread not found'); return; }

  // Already encrypted — idempotent success so a retry is safe.
  if ((thread as any).is_e2ee === true) {
    res.status(200).json({ ok: true, threadId, isE2ee: true });
    return;
  }

  if ((thread as any).thread_type !== 'direct') {
    sendError(res, 'invalid_payload', 'Only 1:1 threads can be end-to-end encrypted');
    return;
  }

  // THE PRECONDITION. No Welcome, no flag.
  const { data: welcome } = await sc
    .from('messages')
    .select('id')
    .eq('thread_id', threadId)
    .eq('msg_type', 'system')
    .eq('subtype', 'e2ee_welcome')
    .limit(1)
    .maybeSingle();

  if (!welcome) {
    sendError(
      res,
      'invalid_payload',
      'Cannot enable encryption before the key-exchange message has been delivered',
    );
    return;
  }

  const { error } = await sc
    .from('message_threads')
    .update({ is_e2ee: true })
    .eq('id', threadId);

  if (error) {
    req.log.error({ err: error }, 'mark thread e2ee failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ ok: true, threadId, isE2ee: true });
});

/* ---------------------------------------------------------------------------
 * GET /api/me/threads
 * ---------------------------------------------------------------------------
 */
router.get('/me/threads', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { data: memberships, error: mErr } = await client
    .from('message_thread_members')
    .select('thread_id, muted_at, archived_at, left_at, last_read_at')
    .eq('user_id', user.id)
    .is('left_at', null);

  if (mErr) {
    req.log.error({ err: mErr }, 'thread membership query failed');
    sendError(res, 'db_error', mErr.message);
    return;
  }

  const threadIds = (memberships ?? []).map((m: any) => m.thread_id);
  if (threadIds.length === 0) {
    res.status(200).json({ threads: [] });
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const [threadsRes, lastMsgRes, allMembersRes] = await Promise.all([
    sc
      .from('message_threads')
      .select('id, thread_type, trip_id, circle_owner_id, title, created_at, updated_at, last_message_at, status')
      .in('id', threadIds)
      .order('last_message_at', { ascending: false, nullsFirst: false }),

    sc
      .from('messages')
      .select('id, thread_id, body, sender_id, created_at, deleted_at, original_language, msg_type, subtype')
      .in('thread_id', threadIds)
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),

    sc
      .from('message_thread_members')
      .select('user_id, thread_id')
      .in('thread_id', threadIds),
  ]);

  // Universal display-name rule: member names show only when opted in.
  // Profiles are fetched as a separate batched query (not an embedded FK
  // join) so a schema/alias drift on the join can't silently return every
  // member with no profile at all — it would surface as a hard fetch error
  // for the offending profile ids instead.
  {
    const memberRows = ((allMembersRes as any).data ?? []) as any[];
    const memberUserIds = Array.from(new Set(memberRows.map((m: any) => m.user_id).filter(Boolean)));
    let profilesById: Record<string, any> = {};
    if (memberUserIds.length > 0) {
      const { data: profileRows } = await sc
        .from('profiles')
        .select(PROFILE_PUBLIC)
        .in('id', memberUserIds);
      for (const p of (profileRows ?? []) as any[]) profilesById[p.id] = p;
    }
    const allowedMemberNames = await nameVisibilitySet(sc, memberUserIds);
    for (const m of memberRows) {
      const p = profilesById[m.user_id];
      m.profile = p ? sanitizeIdentity(p, allowedMemberNames, user.id) : null;
    }
  }

  // Last message per thread.
  const lastMsgByThread: Record<string, any> = {};
  for (const m of (lastMsgRes.data ?? []) as any[]) {
    if (!lastMsgByThread[m.thread_id]) lastMsgByThread[m.thread_id] = m;
  }

  // Fetch translations for last messages (for recipient preview).
  const lastMsgIds = Object.values(lastMsgByThread)
    .filter((m) => m.sender_id !== user.id)
    .map((m) => m.id)
    .filter(Boolean);

  let translationsByMsgId: Record<string, any> = {};
  if (lastMsgIds.length > 0) {
    const { data: tRows } = await sc
      .from('message_translations')
      .select('message_id, translated_body, status, source_language')
      .in('message_id', lastMsgIds)
      .eq('recipient_id', user.id);

    for (const t of tRows ?? []) {
      translationsByMsgId[(t as any).message_id] = t;
    }
  }

  const membersByThread: Record<string, any[]> = {};
  for (const m of (allMembersRes.data ?? []) as any[]) {
    if (m.user_id === user.id) continue;
    if (!membersByThread[m.thread_id]) membersByThread[m.thread_id] = [];
    const p = m.profile ?? {};
    membersByThread[m.thread_id].push({
      id: p.id,
      handle: resolveHandle(p),
      name: p.display_name ?? p.name ?? p.full_name ?? null,
      avatarUrl: p.avatar_url ?? null,
    });
  }

  const membershipMap: Record<string, any> = {};
  for (const m of memberships ?? []) membershipMap[(m as any).thread_id] = m;

  // Group all messages by thread for unread counts.
  const msgsByThread: Record<string, any[]> = {};
  for (const m of (lastMsgRes.data ?? []) as any[]) {
    if (!msgsByThread[m.thread_id]) msgsByThread[m.thread_id] = [];
    msgsByThread[m.thread_id].push(m);
  }

  // Fetch trip cities for trip-type threads.
  const tripIds = (threadsRes.data ?? [])
    .filter((t: any) => t.thread_type === 'trip' && t.trip_id)
    .map((t: any) => t.trip_id as string);

  const tripCityMap: Record<string, string | null> = {};
  if (tripIds.length > 0) {
    const { data: tripRows } = await sc
      .from('trips')
      .select('id, destination_city')
      .in('id', tripIds);
    for (const tr of tripRows ?? []) {
      tripCityMap[(tr as any).id] = (tr as any).destination_city ?? null;
    }
  }

  // Fetch bookingId for rent_buddy_booking threads so inbox can pass contextId on navigation
  const rentBuddyThreadIds = (threadsRes.data ?? [])
    .filter((t: any) => t.thread_type === 'rent_buddy_booking')
    .map((t: any) => t.id as string);

  const bookingIdByThread: Record<string, string> = {};
  if (rentBuddyThreadIds.length > 0) {
    const { data: bookingRows } = await sc
      .from('rent_buddy_bookings')
      .select('id, telegraph_thread_id')
      .in('telegraph_thread_id', rentBuddyThreadIds);
    for (const bk of bookingRows ?? []) {
      if ((bk as any).telegraph_thread_id) {
        bookingIdByThread[(bk as any).telegraph_thread_id] = (bk as any).id;
      }
    }
  }

  const threads = (threadsRes.data ?? []).map((t: any) => {
    const lm = lastMsgByThread[t.id];
    const mem = membershipMap[t.id] ?? {};
    const lastReadAt: string | null = mem.last_read_at ?? null;

    // Unread count: messages newer than last_read_at not sent by the user.
    const threadMsgs = msgsByThread[t.id] ?? [];
    let unreadCount = 0;
    if (lastReadAt) {
      const lastReadTs = new Date(lastReadAt).getTime();
      unreadCount = threadMsgs.filter(
        (m) => m.sender_id !== user.id && new Date(m.created_at).getTime() > lastReadTs
      ).length;
    } else {
      unreadCount = threadMsgs.filter((m) => m.sender_id !== user.id).length;
    }

    let lastMessagePreview: any = null;
    if (lm) {
      let displayBody = lm.body?.slice(0, 80) ?? '';
      if (lm.sender_id !== user.id) {
        const tRow = translationsByMsgId[lm.id];
        if (tRow?.status === 'translated' && tRow.translated_body) {
          displayBody = tRow.translated_body.slice(0, 80);
        }
      }
      lastMessagePreview = {
        body: lm.body?.slice(0, 80) ?? '',
        displayBody,
        senderId: lm.sender_id,
        createdAt: lm.created_at,
        msgType: lm.msg_type ?? 'text',
        subtype: lm.subtype ?? null,
      };
    }

    const isAiLastMessage = lm?.msg_type === 'ai_recommendation';
    const tripCity = t.thread_type === 'trip' && t.trip_id ? (tripCityMap[t.trip_id] ?? null) : null;

    return {
      id: t.id,
      threadType: (t.thread_type ?? 'direct') as 'direct' | 'trip' | 'circle' | 'rent_buddy_booking',
      tripId: t.trip_id ?? null,
      circleOwnerId: t.circle_owner_id ?? null,
      title: t.title ?? null,
      status: t.status,
      lastMessageAt: t.last_message_at ?? null,
      createdAt: t.created_at,
      mutedAt: mem.muted_at ?? null,
      archivedAt: mem.archived_at ?? null,
      otherMembers: membersByThread[t.id] ?? [],
      lastMessagePreview,
      unreadCount,
      tripCity,
      isAiLastMessage,
      bookingId: bookingIdByThread[t.id] ?? null,
    };
  });

  res.status(200).json({ threads });
});

/* ---------------------------------------------------------------------------
 * GET /api/threads/:threadId/messages
 * ---------------------------------------------------------------------------
 * Thread members only. Paginated. Extended with translation display fields.
 */
router.get('/threads/:threadId/messages', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { threadId } = req.params;
  if (!isUuid(threadId)) { sendError(res, 'invalid_payload', 'Invalid thread id'); return; }

  const { data: membership } = await client
    .from('message_thread_members')
    .select('user_id, left_at')
    .eq('thread_id', threadId)
    .eq('user_id', user.id)
    .is('left_at', null)
    .maybeSingle();

  if (!membership) { sendError(res, 'forbidden', 'Not a member of this thread'); return; }
  if ((membership as any).left_at !== null) { sendError(res, 'forbidden', 'You no longer have access to this thread'); return; }

  const before = req.query.before as string | undefined;
  const limit = Math.min(Number(req.query.limit ?? 50), 100);

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  let query = sc
    .from('messages')
    .select(`id, thread_id, sender_id, body, deleted_at, created_at, edited_at, original_language, msg_type, subtype, media_url, media_type, media_thumbnail_url, media_duration_seconds, profile:profiles!messages_sender_id_fkey(${PROFILE_PUBLIC})`)
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (before) query = query.lt('created_at', before);

  const { data, error } = await query;
  if (error) {
    req.log.error({ err: error }, 'messages query failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  const rows = (data ?? []) as any[];

  // Universal display-name rule: sender names show only when opted in.
  {
    const allowedSenderNames = await nameVisibilitySet(sc, rows.map((r: any) => r.sender_id));
    for (const r of rows) {
      if (r.profile) r.profile = sanitizeIdentity(r.profile, allowedSenderNames, user.id);
    }
  }

  // Fetch translations for messages where current user is recipient (sender_id != user.id).
  const incomingMsgIds = rows
    .filter((m) => m.sender_id !== user.id && !m.deleted_at)
    .map((m) => m.id);

  let translationMap: Record<string, any> = {};
  if (incomingMsgIds.length > 0) {
    const { data: tRows } = await sc
      .from('message_translations')
      .select('message_id, source_language, target_language, translated_body, status')
      .in('message_id', incomingMsgIds)
      .eq('recipient_id', user.id);

    for (const t of tRows ?? []) {
      translationMap[(t as any).message_id] = t;
    }
  }

  // Enrich non-deleted messages with positioned @mention + #hashtag spans
  const nonDeletedMsgItems = rows
    .filter((m) => !m.deleted_at)
    .map((m) => ({ id: m.id as string, content: (m.body ?? '') as string }));
  const msgSpansMap = nonDeletedMsgItems.length > 0
    ? await enrichSpans(sc, 'message', nonDeletedMsgItems, user.id)
    : {};

  // Fetch reply_to_id values and quoted context.
  // Wrapped in try/catch: silently skipped if migration 0057 is not yet applied.
  let replyToIdMap: Record<string, string | null> = {};
  let replyContextMap: Record<string, { body: string; senderName: string | null }> = {};
  try {
    const allIds = rows.map((m) => m.id as string);
    if (allIds.length > 0) {
      const { data: replyIdRows, error: replyIdErr } = await sc
        .from('messages')
        .select('id, reply_to_id')
        .in('id', allIds);
      if (!replyIdErr && replyIdRows) {
        for (const r of replyIdRows as any[]) {
          if (r.reply_to_id) replyToIdMap[r.id] = r.reply_to_id;
        }
        const replyIds = Object.values(replyToIdMap).filter(Boolean) as string[];
        if (replyIds.length > 0) {
          const { data: quotedRows } = await sc
            .from('messages')
            .select(`id, body, sender_id, profile:profiles!messages_sender_id_fkey(name, handle, username, full_name)`)
            .in('id', replyIds);
          // Universal display-name rule: quoted sender shows @handle unless opted in.
          const qAllowed = await nameVisibilitySet(sc, ((quotedRows as any[]) ?? []).map((q: any) => q.sender_id));
          for (const qr of quotedRows as any[] ?? []) {
            const nameOk = qr.sender_id === user.id || qAllowed.has(qr.sender_id as string);
            const qHandle = resolveHandle(qr.profile);
            replyContextMap[qr.id] = {
              body: qr.body ?? '',
              senderName: nameOk
                ? (qr.profile?.name ?? qr.profile?.full_name ?? null)
                : (qHandle ? `@${qHandle}` : null),
            };
          }
        }
      }
    }
  } catch { /* migration 0057 not applied — reply context unavailable */ }

  const messages = rows.map((m) => {
    const p = m.profile ?? {};
    const isDeleted = Boolean(m.deleted_at);
    const tRow = translationMap[m.id] ?? null;
    const spans = !isDeleted ? ((msgSpansMap as any)[m.id] ?? { tags: [], hashtagUsages: [] }) : null;

    const display = buildDisplayFields(
      {
        body: isDeleted ? null : m.body,
        deleted: isDeleted,
        senderId: m.sender_id,
        originalLanguage: m.original_language,
      },
      user.id,
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
      senderHandle: resolveHandle(p),
      senderName: p.name ?? p.full_name ?? null,
      senderAvatarUrl: p.avatar_url ?? null,
      body: isDeleted ? null : m.body,
      deleted: isDeleted,
      createdAt: m.created_at,
      editedAt: m.edited_at ?? null,
      // Translation display fields
      displayBody: display.displayBody,
      originalBody: display.originalBody,
      originalLanguage: display.originalLanguage,
      translated: display.translated,
      translationStatus: display.translationStatus,
      translationLabel: display.translationLabel,
      canShowOriginal: display.canShowOriginal,
      msgType: (m.msg_type as string) ?? 'text',
      subtype: (m.subtype as string | null) ?? null,
      // Rich-text span metadata (absent for deleted messages)
      ...(spans ? { tags: spans.tags, hashtagUsages: spans.hashtagUsages } : {}),
      // Reply threading (populated after migration 0057_reply_to_messages.sql)
      replyToId: replyToIdMap[m.id] ?? null,
      replyToBody: replyToIdMap[m.id] ? (replyContextMap[replyToIdMap[m.id]!]?.body ?? null) : null,
      replyToSenderName: replyToIdMap[m.id] ? (replyContextMap[replyToIdMap[m.id]!]?.senderName ?? null) : null,
      // Media fields (migration 0152_messages_media.sql)
      mediaUrl: (m as any).media_url ?? null,
      mediaType: (m as any).media_type ?? null,
      mediaThumbnailUrl: (m as any).media_thumbnail_url ?? null,
      mediaDurationSeconds: (m as any).media_duration_seconds ?? null,
    };
  });

  res.status(200).json({ messages, threadId });
});

/* ---------------------------------------------------------------------------
 * POST /api/threads/:threadId/messages
 * ---------------------------------------------------------------------------
 * Thread members only. Saves message, then runs translation pipeline.
 */
router.post('/threads/:threadId/messages', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { threadId } = req.params;
  if (!isUuid(threadId)) { sendError(res, 'invalid_payload', 'Invalid thread id'); return; }

  const bodyRaw = typeof req.body?.body === 'string' ? req.body.body.trim() : null;
  // E-2: ciphertext is accepted for E2EE threads (body must be null in that case).
  const ciphertext = typeof req.body?.ciphertext === 'string' ? req.body.ciphertext.trim() : null;
  if (!bodyRaw && !ciphertext) { sendError(res, 'invalid_payload', 'body is required'); return; }
  if (bodyRaw && bodyRaw.length > 4000) { sendError(res, 'invalid_payload', 'body must be 4000 characters or fewer'); return; }
  if (ciphertext && ciphertext.length > 65536) { sendError(res, 'invalid_payload', 'ciphertext too large'); return; }
  // body assignment deferred — E2EE threads force body=null (resolved after is_e2ee check below)
  let body = bodyRaw;

  // Emergency kill switch: disable_messaging — fail-CLOSED on DB error
  const flagSc = getServiceClient();
  if (flagSc && await isKillSwitchEngaged(flagSc, 'disable_messaging')) {
    sendError(res, 'feature_disabled', 'Messaging is temporarily disabled');
    return;
  }

  const msgTypeRaw = typeof req.body?.msgType === 'string' ? req.body.msgType : 'text';
  const msgType = msgTypeRaw === 'system' ? 'system' : 'text';
  const subtype = typeof req.body?.subtype === 'string' ? req.body.subtype : null;
  // Optional client-generated id used to correlate optimistic sends with the
  // server message (echoed in the response and in the realtime event).
  const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.slice(0, 64) : null;

  const { data: membership } = await client
    .from('message_thread_members')
    .select('user_id, left_at')
    .eq('thread_id', threadId)
    .eq('user_id', user.id)
    .is('left_at', null)
    .maybeSingle();

  if (!membership) { sendError(res, 'forbidden', 'Not a member of this thread'); return; }
  if ((membership as any).left_at !== null) { sendError(res, 'forbidden', 'You no longer have access to this thread'); return; }

  // Block guard for 1:1 threads. Blocking (blocks.ts) tears down follow/friend
  // edges and pending message-requests but never closes an EXISTING thread, so
  // without this a blocked user could keep DMing through a pre-existing thread.
  // Applies to a thread with exactly one other active member; group threads are
  // governed by group membership, not pairwise blocks. Fail-closed via
  // isBlockedBetween (a blocks-table error is treated as blocked).
  {
    const blockSc = getServiceClient() ?? client;
    const { data: otherMembers } = await client
      .from('message_thread_members')
      .select('user_id')
      .eq('thread_id', threadId)
      .is('left_at', null)
      .neq('user_id', user.id);
    const others = ((otherMembers as any[]) ?? []).map((m) => m.user_id as string);
    if (others.length === 1 && others[0] && await isBlockedBetween(blockSc, user.id, others[0])) {
      sendError(res, 'forbidden', 'You cannot message this user'); return;
    }
  }

  // E-2: check thread E2EE flag.
  const { data: threadMeta } = await client
    .from('message_threads')
    .select('is_e2ee')
    .eq('id', threadId)
    .maybeSingle();
  const isE2ee = (threadMeta as any)?.is_e2ee === true;

  if (isE2ee) {
    // E2EE thread: ciphertext required, body must be absent.
    if (!ciphertext) { sendError(res, 'invalid_payload', 'E2EE thread requires ciphertext; plaintext body not accepted'); return; }
    body = null; // server NEVER stores plaintext for E2EE messages
  } else {
    if (!body) { sendError(res, 'invalid_payload', 'body is required'); return; }
  }

  // Use the authenticated client (= service client in production, fake in tests).
  const sc = client;

  // Fetch sender's language preference (for detection fallback).
  const { data: senderProfile } = await sc
    .from('profiles')
    .select('preferred_language, preferred_message_language')
    .eq('id', user.id)
    .maybeSingle();
  const senderLanguage = (senderProfile as any)?.preferred_language ?? (senderProfile as any)?.preferred_message_language ?? 'en';

  const now = new Date().toISOString();

  const replyToIdRaw = typeof req.body?.replyToId === 'string' ? req.body.replyToId.trim() : null;
  const replyToId = replyToIdRaw && isUuid(replyToIdRaw) ? replyToIdRaw : null;

  // Validate reply reference belongs to the same thread (prevents cross-thread metadata exposure).
  if (replyToId) {
    const { data: refMsg } = await sc
      .from('messages')
      .select('id')
      .eq('id', replyToId)
      .eq('thread_id', threadId)
      .maybeSingle();
    if (!refMsg) {
      sendError(res, 'invalid_payload', 'Referenced message does not belong to this thread');
      return;
    }
  }

  const { data: msg, error: msgErr } = await sc
    .from('messages')
    .insert({
      thread_id: threadId,
      sender_id: user.id,
      // E-2: body is null for E2EE messages; ciphertext carries the opaque blob.
      body: isE2ee ? null : body,
      ciphertext: isE2ee ? ciphertext : null,
      created_at: now,
      msg_type: msgType,
      subtype,
    })
    .select('id, thread_id, sender_id, body, ciphertext, created_at, msg_type, subtype')
    .single();

  if (msgErr || !msg) {
    req.log.error({ err: msgErr }, 'message insert failed');
    sendError(res, 'db_error', msgErr?.message ?? 'Failed to insert message');
    return;
  }

  // Off-app solicitation detection for buddy booking threads (non-blocking fire-and-forget).
  // E-2: skip for E2EE threads — server cannot read ciphertext.
  // Scans the message body for off-app payment solicitation phrases. On match:
  //   1. Logs a buddy_booking_events row (event=off_app_solicitation_warning, admin_only).
  //   2. After OFF_APP_SUSPENSION_THRESHOLD cumulative offenses for the buddy, suspends
  //      the buddy profile and logs an auto-suspension event for admin review.
  // Normal travel phrases do not trigger (patterns require explicit off-platform wording).
  const OFF_APP_PATTERNS = [
    /\boff[-\s]?app\b/i, /\bpay\s+outside\b/i, /\bcash\s+only\b.*\boutside\b/i,
    /\bvenmo\s+me\b/i, /\bpaypal\s+me\b/i, /\bcashapp\b/i, /\bzelle\s+me\b/i,
    /\bbank\s+transfer\s+only\b/i, /\bno\s+app\s+payment\b/i,
    /\bpay\s+me\s+directly\b/i, /\bcontact\s+me\s+outside\b/i,
    /\bmy\s+whatsapp\b/i, /\bmy\s+telegram\b/i, /\binstagram\s+dm\b/i,
  ];
  if (!isE2ee && body && OFF_APP_PATTERNS.some((p) => p.test(body))) {
    void (async () => {
      try {
        const svcClient = getServiceClient();
        if (!svcClient) return;
        const { data: booking } = await svcClient
          .from('rent_buddy_bookings')
          .select('id, buddy_id')
          .eq('telegraph_thread_id', threadId)
          .maybeSingle();
        if (!booking) return;
        const bookingId = (booking as any).id as string;
        const buddyProfileId = (booking as any).buddy_id as string;
        // Only attribute the offense when the sender IS the buddy account.
        // A traveler can write off-app phrases without triggering buddy suspension.
        const { data: buddySenderProfile } = await svcClient
          .from('rent_buddy_profiles')
          .select('id, user_id')
          .eq('id', buddyProfileId)
          .maybeSingle();
        if (!buddySenderProfile || (buddySenderProfile as any).user_id !== user.id) return;
        await svcClient.from('buddy_booking_events').insert({
          booking_id: bookingId,
          actor_user_id: user.id,
          event: 'off_app_solicitation_warning',
          metadata: { message_id: (msg as any).id, thread_id: threadId, excerpt: body.slice(0, 120), visibility: 'admin_only' },
        });
        const { data: buddyBookings } = await svcClient
          .from('rent_buddy_bookings')
          .select('id')
          .eq('buddy_id', buddyProfileId);
        const buddyBookingIds = (buddyBookings ?? []).map((r: any) => r.id as string);
        if (buddyBookingIds.length > 0) {
          const { count: priorCount } = await svcClient
            .from('buddy_booking_events')
            .select('id', { count: 'exact' })
            .eq('event', 'off_app_solicitation_warning')
            .in('booking_id', buddyBookingIds);
          const threshold = Number(process.env['OFF_APP_SUSPENSION_THRESHOLD'] ?? '3');
          if ((priorCount ?? 0) >= threshold) {
            // SAFETY enforcement: supabase-js resolves rather than throws on a DB
            // error, so these results must be checked — a silently failed update
            // here leaves a repeat off-app solicitor ACTIVE with no trace.
            const { error: suspErr } = await svcClient
              .from('rent_buddy_profiles')
              .update({ status: 'suspended', admin_status: 'under_review', updated_at: new Date().toISOString() })
              .eq('id', buddyProfileId);
            if (suspErr) {
              req.log.error({ err: suspErr, buddyProfileId, priorCount },
                'off-app auto-suspension UPDATE failed — repeat offender remains active');
            }
            const { error: evErr } = await svcClient.from('buddy_booking_events').insert({
              booking_id: bookingId,
              actor_user_id: user.id,
              event: 'buddy_auto_suspended',
              metadata: { reason: 'repeated_off_app_solicitation', offense_count: priorCount, visibility: 'admin_only' },
            });
            if (evErr) {
              req.log.error({ err: evErr, buddyProfileId },
                'buddy_auto_suspended event insert failed — suspension unaudited');
            }
          }
        }
      } catch (err) {
        req.log.error({ err }, 'off-app solicitation post-processing threw');
      }
    })();
  }

  // Bump thread last_message_at.
  await sc
    .from('message_threads')
    .update({ last_message_at: now, updated_at: now })
    .eq('id', threadId);

  const m = msg as any;

  // Write-time tagging: extract @mentions, enforce permissions, write rows, dispatch
  // notifications via NotificationService (privacy guard + dedup) + NotificationRouter.
  // Non-fatal — must not block the message write.
  // body is null for E2EE threads (server never sees plaintext) — skip tagging entirely.
  if (body && body.trim().length > 0) {
    try {
      const taggedIds = await processTagging({
        db: sc,
        authorId: user.id,
        sourceType: 'message',
        sourceId: m.id,
        content: body,
        logger: req.log,
      });
      if (taggedIds.length > 0) {
        const { data: taggerProfile } = await sc
          .from('profiles')
          .select('handle, username')
          .eq('id', user.id)
          .single();
        const taggerHandle = resolveHandle(taggerProfile as any) ?? 'someone';
        const notifSvc    = new NotificationService(sc);
        const notifRouter  = new NotificationRouter(sc);
        await Promise.allSettled(
          taggedIds.map(async (taggedId) => {
            const row = await notifSvc.create({
              userId: taggedId,
              eventType: 'pulse.user_tagged',
              actorId: user.id,
              sourceType: 'message',
              sourceId: m.id,
              params: { taggerHandle, context: `@${taggerHandle} mentioned you in a message.` },
            });
            if (row) await notifRouter.route(row);
          }),
        );
      }
    } catch (err) {
      req.log.warn({ err }, 'message tagging side-effect failed (non-fatal)');
    }
  }

  // Respond after tagging side-effects; translation and realtime dispatch remain background.
  res.status(201).json({
    id: m.id,
    threadId: m.thread_id,
    senderId: m.sender_id,
    body: m.body,
    deleted: false,
    createdAt: m.created_at,
    editedAt: null,
    displayBody: m.body,
    originalBody: m.body,
    originalLanguage: null,
    translated: false,
    translationStatus: null,
    translationLabel: null,
    canShowOriginal: false,
    msgType: m.msg_type ?? 'text',
    subtype: m.subtype ?? null,
    clientId,
    replyToId: replyToId ?? null,
  });

  // Fire-and-forget: set reply_to_id if provided (requires migration 0057_reply_to_messages.sql).
  if (replyToId) {
    void (Promise.resolve(sc.from('messages').update({ reply_to_id: replyToId }).eq('id', m.id)).catch(() => {}));
  }

  // Realtime: notify other active members a new message landed, and bump the
  // thread for inbox ordering. Fire-and-forget — delivery must never affect the
  // write path (clients keep polling as a fallback).
  void publishToThread(
    sc,
    threadId,
    {
      type: 'message.created',
      payload: {
        messageId: m.id,
        senderId: m.sender_id,
        msgType: m.msg_type ?? 'text',
        subtype: m.subtype ?? null,
        createdAt: m.created_at,
        clientId,
      },
    },
    { excludeUserId: user.id },
  );
  void publishToThread(sc, threadId, {
    type: 'thread.updated',
    payload: { lastMessageAt: now },
  });

  // Fire-and-forget: translate in background (does not block the response).
  translateMessageForThread(sc, {
    messageId: m.id,
    body,
    senderId: user.id,
    threadId,
    senderPreferredLanguage: senderLanguage,
    logger: req.log,
  }).catch(() => {
    // Outer safety net — translateMessageForThread already catches internally.
  });
});

/* ---------------------------------------------------------------------------
 * POST /api/threads/:threadId/media
 * ---------------------------------------------------------------------------
 * Create a media message in a thread.
 * The client has already uploaded the file via POST /api/media/upload and
 * passes back the returned URL.  This route inserts the message row with
 * the media fields (migration 0152_messages_media.sql) and returns the
 * full message object.
 */
router.post('/threads/:threadId/media', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { threadId } = req.params;
  if (!isUuid(threadId)) { sendError(res, 'invalid_payload', 'Invalid thread id'); return; }

  const mediaUrl = typeof req.body?.mediaUrl === 'string' ? req.body.mediaUrl.trim() : '';
  if (!mediaUrl) { sendError(res, 'invalid_payload', 'mediaUrl is required'); return; }

  const mediaTypeRaw = typeof req.body?.mediaType === 'string' ? req.body.mediaType : null;
  if (mediaTypeRaw !== 'image' && mediaTypeRaw !== 'video') {
    sendError(res, 'invalid_payload', "mediaType must be 'image' or 'video'");
    return;
  }

  const thumbnailUrl = typeof req.body?.thumbnailUrl === 'string' ? req.body.thumbnailUrl.trim() : null;
  const durationSecondsRaw = req.body?.durationSeconds;
  const durationSeconds =
    typeof durationSecondsRaw === 'number' && Number.isFinite(durationSecondsRaw) && durationSecondsRaw >= 0
      ? Math.round(durationSecondsRaw)
      : null;

  // Optional caption
  const body = typeof req.body?.body === 'string' ? req.body.body.trim().slice(0, 4000) : null;

  const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.slice(0, 64) : null;

  // Emergency kill switches (media one previously ignored here — audit).
  // Fail-CLOSED: an unreadable stop engages.
  const flagSc = getServiceClient();
  if (flagSc && await isKillSwitchEngaged(flagSc, 'disable_messaging')) {
    sendError(res, 'feature_disabled', 'Messaging is temporarily disabled');
    return;
  }
  if (flagSc && await isKillSwitchEngaged(flagSc, 'disable_media_uploads')) {
    sendError(res, 'feature_disabled', 'Media uploads are temporarily disabled');
    return;
  }

  // Audit security fix: previously ANY external URL was accepted (hotlink/
  // tracker/other-user-object injection). Media must live in our own storage.
  if (!appStorageUrlInfo(mediaUrl)) {
    sendError(res, 'invalid_payload', 'mediaUrl must be an uploaded app media URL (use /api/media/upload first)');
    return;
  }
  if (thumbnailUrl && !appStorageUrlInfo(thumbnailUrl)) {
    sendError(res, 'invalid_payload', 'thumbnailUrl must be an uploaded app media URL');
    return;
  }

  // Verify thread membership
  const { data: membership } = await client
    .from('message_thread_members')
    .select('user_id, left_at')
    .eq('thread_id', threadId)
    .eq('user_id', user.id)
    .is('left_at', null)
    .maybeSingle();

  if (!membership) { sendError(res, 'forbidden', 'Not a member of this thread'); return; }
  if ((membership as any).left_at !== null) { sendError(res, 'forbidden', 'You no longer have access to this thread'); return; }

  // Block guard for 1:1 threads — same as the text-send handler (audit MSG-1).
  // Without it a blocked user could keep sending photos/videos through a
  // pre-existing thread, since blocking never closes an existing thread.
  // Fail-closed via isBlockedBetween.
  {
    const blockSc = getServiceClient() ?? client;
    const { data: otherMembers } = await client
      .from('message_thread_members')
      .select('user_id')
      .eq('thread_id', threadId)
      .is('left_at', null)
      .neq('user_id', user.id);
    const others = ((otherMembers as any[]) ?? []).map((m) => m.user_id as string);
    if (others.length === 1 && others[0] && await isBlockedBetween(blockSc, user.id, others[0])) {
      sendError(res, 'forbidden', 'You cannot message this user'); return;
    }
  }

  // Finding #14 fix: E2EE threads must never accept plaintext media messages.
  // This endpoint has no attachment-encryption path yet, so fail closed —
  // same posture as the text handler's ciphertext-required guard above.
  const { data: threadMetaForMedia } = await client
    .from('message_threads')
    .select('is_e2ee')
    .eq('id', threadId)
    .maybeSingle();
  if ((threadMetaForMedia as any)?.is_e2ee === true) {
    sendError(res, 'e2ee_thread', 'Media messages are not supported on end-to-end encrypted threads');
    return;
  }

  const sc = client;
  const now = new Date().toISOString();

  const { data: msg, error: msgErr } = await sc
    .from('messages')
    .insert({
      thread_id: threadId,
      sender_id: user.id,
      body: body ?? '',
      created_at: now,
      msg_type: 'media',
      media_url: mediaUrl,
      media_type: mediaTypeRaw,
      media_thumbnail_url: thumbnailUrl,
      media_duration_seconds: durationSeconds,
    })
    .select('id, thread_id, sender_id, body, created_at, msg_type, media_url, media_type, media_thumbnail_url, media_duration_seconds')
    .single();

  if (msgErr || !msg) {
    req.log.error({ err: msgErr }, 'media message insert failed');
    sendError(res, 'db_error', msgErr?.message ?? 'Failed to insert media message');
    return;
  }

  // Update thread last_message_at (best-effort)
  try {
    await sc
      .from('message_threads')
      .update({ last_message_at: now })
      .eq('id', threadId);
  } catch { /* non-fatal */ }

  // Publish real-time event to thread members
  try {
    await publishToThread(sc, threadId, {
      type: 'message.created',
      payload: {
        id: msg.id,
        threadId: msg.thread_id,
        senderId: msg.sender_id,
        body: msg.body ?? '',
        msgType: 'media',
        mediaUrl: (msg as any).media_url,
        mediaType: (msg as any).media_type,
        mediaThumbnailUrl: (msg as any).media_thumbnail_url ?? null,
        mediaDurationSeconds: (msg as any).media_duration_seconds ?? null,
        createdAt: msg.created_at,
        clientId,
      },
    });
  } catch (err) {
    req.log.warn({ err }, 'media message realtime publish failed (non-fatal)');
  }

  res.status(201).json({
    id: msg.id,
    threadId: msg.thread_id,
    senderId: msg.sender_id,
    body: msg.body ?? '',
    deleted: false,
    createdAt: msg.created_at,
    editedAt: null,
    displayBody: msg.body ?? '',
    originalBody: msg.body ?? '',
    originalLanguage: null,
    translated: false,
    translationStatus: null,
    translationLabel: null,
    canShowOriginal: false,
    msgType: 'media',
    subtype: null,
    clientId,
    replyToId: null,
    mediaUrl: (msg as any).media_url,
    mediaType: (msg as any).media_type,
    mediaThumbnailUrl: (msg as any).media_thumbnail_url ?? null,
    mediaDurationSeconds: (msg as any).media_duration_seconds ?? null,
  });
});

/* ---------------------------------------------------------------------------
 * POST /api/messages/:messageId/translate/retry
 * ---------------------------------------------------------------------------
 * Re-triggers translation for a message where status = 'failed'.
 * Only the thread members can trigger this.
 */
router.post('/messages/:messageId/translate/retry', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const { messageId } = req.params;
  if (!isUuid(messageId)) { sendError(res, 'invalid_payload', 'Invalid message id'); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // Fetch message + verify membership.
  const { data: msgRow } = await sc
    .from('messages')
    .select('id, thread_id, sender_id, body, deleted_at, original_language')
    .eq('id', messageId)
    .maybeSingle();

  if (!msgRow) { sendError(res, 'not_found', 'Message not found'); return; }
  const m = msgRow as any;
  if (m.deleted_at) { sendError(res, 'invalid_payload', 'Cannot retry translation on a deleted message'); return; }

  // E-2: refuse translation for E2EE threads — server cannot read ciphertext.
  const { data: threadMetaForTranslate } = await sc
    .from('message_threads')
    .select('is_e2ee')
    .eq('id', m.thread_id)
    .maybeSingle();
  if ((threadMetaForTranslate as any)?.is_e2ee === true) {
    sendError(res, 'e2ee_thread', 'Translation is unavailable for end-to-end encrypted messages');
    return;
  }

  const { data: mem } = await client
    .from('message_thread_members')
    .select('user_id')
    .eq('thread_id', m.thread_id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!mem) { sendError(res, 'forbidden', 'Not a member of this thread'); return; }

  // Check this user has a failed translation row.
  const { data: tRow } = await sc
    .from('message_translations')
    .select('id, status')
    .eq('message_id', messageId)
    .eq('recipient_id', user.id)
    .maybeSingle();

  if (!tRow || (tRow as any).status === 'translated' || (tRow as any).status === 'skipped') {
    sendError(res, 'invalid_payload', 'No failed translation to retry');
    return;
  }

  res.status(202).json({ status: 'retry_queued', messageId });

  // Reset to pending and re-run.
  await markTranslationsPending(sc, messageId);

  const { data: senderProfile } = await sc
    .from('profiles')
    .select('preferred_language, preferred_message_language')
    .eq('id', m.sender_id)
    .maybeSingle();
  const senderLanguage = (senderProfile as any)?.preferred_language ?? (senderProfile as any)?.preferred_message_language ?? 'en';

  translateMessageForThread(sc, {
    messageId,
    body: m.body,
    senderId: m.sender_id,
    threadId: m.thread_id,
    senderPreferredLanguage: senderLanguage,
    logger: req.log,
  }).catch(() => {});
});

/* ---------------------------------------------------------------------------
 * PATCH /api/threads/:threadId/messages/:messageId
 * ---------------------------------------------------------------------------
 * Sender only. Updates message body, sets edited_at, invalidates + regenerates
 * translations.
 */
router.patch('/threads/:threadId/messages/:messageId', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const { threadId, messageId } = req.params;
  if (!isUuid(threadId)) { sendError(res, 'invalid_payload', 'Invalid thread id'); return; }
  if (!isUuid(messageId)) { sendError(res, 'invalid_payload', 'Invalid message id'); return; }

  const newBody = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!newBody) { sendError(res, 'invalid_payload', 'body is required'); return; }
  if (newBody.length > 4000) { sendError(res, 'invalid_payload', 'body must be 4000 characters or fewer'); return; }

  // Verify thread membership.
  const { data: mem } = await client
    .from('message_thread_members')
    .select('user_id')
    .eq('thread_id', threadId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!mem) { sendError(res, 'forbidden', 'Not a member of this thread'); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // Fetch message — must exist, belong to this thread, not deleted, and be owned by caller.
  const { data: msgRow } = await sc
    .from('messages')
    .select('id, thread_id, sender_id, body, deleted_at')
    .eq('id', messageId)
    .eq('thread_id', threadId)
    .maybeSingle();

  if (!msgRow) { sendError(res, 'not_found', 'Message not found'); return; }
  const m = msgRow as any;
  if (m.deleted_at) { sendError(res, 'invalid_payload', 'Cannot edit a deleted message'); return; }
  if (m.sender_id !== user.id) { sendError(res, 'forbidden', 'Only the sender can edit this message'); return; }

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
    threadId,
    senderId: user.id,
    body: newBody,
    deleted: false,
    editedAt: now,
  });

  // Realtime: notify other members the message body changed.
  void publishToThread(
    sc,
    threadId,
    { type: 'message.updated', payload: { messageId, editedAt: now } },
    { excludeUserId: user.id },
  );

  // Invalidate existing translations and regenerate for updated body.
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
    threadId,
    senderPreferredLanguage: senderLanguage,
    logger: req.log,
  }).catch(() => {});
});

/* ---------------------------------------------------------------------------
 * GET /api/trips/:tripId/chat
 * ---------------------------------------------------------------------------
 * Returns the group chat thread for a trip (creates it on first call).
 * Caller must be an accepted trip member (role = owner or member).
 * Also syncs current accepted members into the thread.
 */
router.get('/trips/:tripId/chat', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const { tripId } = req.params;
  if (!isUuid(tripId)) { sendError(res, 'invalid_payload', 'Invalid trip id'); return; }

  // Verify caller is an accepted trip member.
  const { data: tripMembership } = await sc
    .from('trip_members')
    .select('role')
    .eq('trip_id', tripId)
    .eq('user_id', user.id)
    .in('role', ['owner', 'member'])
    .maybeSingle();

  if (!tripMembership) {
    sendError(res, 'forbidden', 'You must be an accepted trip member to access the trip chat');
    return;
  }

  // Get trip metadata for response.
  const { data: trip } = await sc
    .from('trips')
    .select('id, title, destination_city')
    .eq('id', tripId)
    .maybeSingle();

  if (!trip) { sendError(res, 'not_found', 'Trip not found'); return; }

  try {
    const threadId = await syncTripChatMembers(sc, tripId);
    const threadTitle = (trip as any).title ?? (trip as any).destination_city ?? 'Trip Chat';

    res.status(200).json({
      threadId,
      threadType: 'trip',
      title: threadTitle,
      tripId,
      circleOwnerId: null,
    });
  } catch (e) {
    req.log.error({ err: e }, 'syncTripChatMembers failed in GET /trips/:tripId/chat');
    sendError(res, 'db_error', 'Failed to open trip chat');
  }
});

/* ---------------------------------------------------------------------------
 * GET /api/circles/:circleOwnerId/chat
 * ---------------------------------------------------------------------------
 * Returns the group chat thread for a trusted circle (creates it on first call).
 * Caller must be the circle owner OR an accepted circle member.
 * Also syncs current circle members into the thread.
 */
router.get('/circles/:circleOwnerId/chat', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const { circleOwnerId } = req.params;
  if (!isUuid(circleOwnerId)) { sendError(res, 'invalid_payload', 'Invalid circle owner id'); return; }

  // Verify caller is the owner or an accepted member of this circle.
  const isOwner = user.id === circleOwnerId;
  if (!isOwner) {
    const { data: circleMembership } = await sc
      .from('circle_memberships')
      .select('other_id')
      .eq('user_id', circleOwnerId)
      .eq('other_id', user.id)
      .maybeSingle();

    if (!circleMembership) {
      sendError(res, 'forbidden', 'You must be a member of this circle to access the circle chat');
      return;
    }
  }

  // Get owner profile for title.
  const { data: ownerProfile } = await sc
    .from('profiles')
    .select('id, name, handle, username, full_name')
    .eq('id', circleOwnerId)
    .maybeSingle();

  if (!ownerProfile) { sendError(res, 'not_found', 'Circle owner not found'); return; }

  try {
    const threadId = await syncCircleChatMembers(sc, circleOwnerId);
    const displayName = (ownerProfile as any).name ?? (ownerProfile as any).full_name
      ?? resolveHandle(ownerProfile as any) ?? 'Circle';
    const threadTitle = circleThreadTitle(displayName);

    res.status(200).json({
      threadId,
      threadType: 'circle',
      title: threadTitle,
      tripId: null,
      circleOwnerId,
    });
  } catch (e) {
    req.log.error({ err: e }, 'syncCircleChatMembers failed in GET /circles/:circleOwnerId/chat');
    sendError(res, 'db_error', 'Failed to open circle chat');
  }
});

// ── Mute / unmute thread ──────────────────────────────────────────────────────

/**
 * PATCH /api/threads/:threadId/mute
 * Body: { muted: boolean }
 * Toggles muted_at on message_thread_members for the caller.
 */
router.patch('/threads/:threadId/mute', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }
  const { threadId } = req.params;
  const muted = req.body?.muted === true;
  const now = new Date().toISOString();

  const { data: member } = await sc
    .from('message_thread_members')
    .select('user_id')
    .eq('thread_id', threadId)
    .eq('user_id', user.id)
    .is('left_at', null)
    .maybeSingle();

  if (!member) { sendError(res, 'forbidden', 'Not a member of this thread'); return; }

  const { error } = await sc
    .from('message_thread_members')
    .update({ muted_at: muted ? now : null })
    .eq('thread_id', threadId)
    .eq('user_id', user.id);

  if (error) { req.log.error({ err: error }, 'mute thread failed'); sendError(res, 'db_error', error.message); return; }

  res.status(200).json({ ok: true, muted });
});

// ── Leave thread ──────────────────────────────────────────────────────────────

/**
 * POST /api/threads/:threadId/leave
 * Sets left_at for the current user in message_thread_members.
 */
router.post('/threads/:threadId/leave', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }
  const { threadId } = req.params;
  const now = new Date().toISOString();

  const { error } = await sc
    .from('message_thread_members')
    .update({ left_at: now })
    .eq('thread_id', threadId)
    .eq('user_id', user.id)
    .is('left_at', null);

  if (error) { req.log.error({ err: error }, 'leave thread failed'); sendError(res, 'db_error', error.message); return; }

  // Invalidate compass cache before response so feed reflects membership change
  await invalidateCompassCache(sc, user.id, "group_leave");

  res.status(200).json({ ok: true });

  // Realtime: notify remaining members that someone left.
  void publishToThread(
    sc,
    threadId,
    { type: 'member.left', payload: { userId: user.id } },
    { excludeUserId: user.id },
  );
});

// ── Report thread ─────────────────────────────────────────────────────────────

/**
 * POST /api/threads/:threadId/report
 * Body: { reason: string }
 * Records a user report against a conversation in the unified reports table.
 */
router.post('/threads/:threadId/report', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }
  const { threadId } = req.params;
  if (!isUuid(threadId)) { sendError(res, 'invalid_payload', 'Invalid thread id'); return; }
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 200) : '';
  if (!reason) { sendError(res, 'invalid_payload', 'reason is required'); return; }

  const { error } = await sc
    .from('reports')
    .insert({
      reporter_id: user.id,
      target_type: 'thread',
      target_id: threadId,
      reason_code: 'other',
      reason_detail: reason,
      severity: 'normal',
    });

  if (error) {
    req.log.warn({ err: error }, 'thread report insert failed');
    sendError(res, 'db_error', 'Could not file report');
    return;
  }

  // Compass: reporter's cache should no longer surface content from this thread
  await invalidateCompassCache(sc, user.id, "thread_report");

  res.status(201).json({ ok: true });
});

// ── Report message ────────────────────────────────────────────────────────────

/**
 * POST /api/threads/:threadId/messages/:messageId/save
 * Saves a message to the caller's personal collection (requires migration 0057).
 */
router.post('/threads/:threadId/messages/:messageId/save', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { threadId, messageId } = req.params;
  if (!isUuid(threadId) || !isUuid(messageId)) { sendError(res, 'invalid_payload', 'Invalid id'); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const { data: membership } = await sc
    .from('message_thread_members').select('user_id')
    .eq('thread_id', threadId).eq('user_id', user.id).is('left_at', null).maybeSingle();
  if (!membership) { sendError(res, 'forbidden', 'Not a member of this thread'); return; }

  // Verify message belongs to this thread (prevents cross-thread saves).
  const { data: msgRow } = await sc
    .from('messages')
    .select('id')
    .eq('id', messageId)
    .eq('thread_id', threadId)
    .maybeSingle();
  if (!msgRow) { sendError(res, 'not_found', 'Message not found in this thread'); return; }

  const now = new Date().toISOString();
  const { error } = await sc.from('saved_messages').upsert(
    { user_id: user.id, message_id: messageId, saved_at: now },
    { onConflict: 'user_id,message_id' },
  );

  if (error) {
    req.log.warn({ err: error }, 'saved_messages upsert failed (migration 0057 may not be applied)');
    res.json({ ok: false, reason: 'unavailable' });
    return;
  }
  res.status(201).json({ ok: true, savedAt: now });
});

/**
 * POST /api/messages/:messageId/report
 * Body: { reason: string }
 * Records a user report against a message in the unified reports table.
 */
router.post('/messages/:messageId/report', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }
  const { messageId } = req.params;
  if (!isUuid(messageId)) { sendError(res, 'invalid_payload', 'Invalid message id'); return; }
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 200) : '';
  if (!reason) { sendError(res, 'invalid_payload', 'reason is required'); return; }

  const { error } = await sc
    .from('reports')
    .insert({
      reporter_id: user.id,
      target_type: 'message',
      target_id: messageId,
      reason_code: 'other',
      reason_detail: reason,
      severity: 'normal',
    });

  if (error) {
    req.log.warn({ err: error }, 'message report insert failed');
    sendError(res, 'db_error', 'Could not file report');
    return;
  }

  // Compass: reporter's cache should no longer surface content from this message author
  await invalidateCompassCache(sc, user.id, "message_report");

  res.status(201).json({ ok: true });
});

export default router;
