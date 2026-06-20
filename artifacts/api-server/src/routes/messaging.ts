/**
 * Messaging routes
 *
 * GET  /api/me/message-settings
 * PATCH /api/me/message-settings
 * GET  /api/users/:userId/message-permission
 * POST /api/users/:userId/message-request
 * GET  /api/me/message-requests
 * POST /api/message-requests/:requestId/accept
 * POST /api/message-requests/:requestId/decline
 * POST /api/message-requests/:requestId/cancel
 * GET  /api/me/threads
 * GET  /api/threads/:threadId/messages
 * POST /api/threads/:threadId/messages
 *
 * Privacy guarantee: no private posts, trips, live location, exact GPS,
 * circle memberships, or trip memberships are exposed through any of these
 * endpoints. Thread access is gated ONLY by message_thread_members rows.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireUser, sendError } from '../lib/http';
import { canMessage } from '../lib/messagingPermissions';
import { getServiceClient } from '../lib/supabase';
import { isUuid } from '../lib/followDecisions';

const router = Router();

const PROFILE_PUBLIC = 'id, handle, name, avatar_url';

const MESSAGE_PRIVACY_VALUES = [
  'everyone',
  'followers',
  'following',
  'friends',
  'trip_members',
  'no_one',
] as const;

const MessageSettingsPatchSchema = z.object({
  message_privacy: z.enum(MESSAGE_PRIVACY_VALUES).optional(),
  allow_message_requests: z.boolean().optional(),
  allow_trip_member_messages: z.boolean().optional(),
  allow_circle_member_messages: z.boolean().optional(),
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

  // If no row exists, return defaults.
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
 * GET /api/users/:userId/message-permission
 * ---------------------------------------------------------------------------
 * Returns the verdict for the current user messaging the given user.
 * Safe for public consumption — no internal fields are leaked.
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

  // Must use service client: recipient's user_message_settings are RLS-restricted
  // to the row owner only — a user-scoped client cannot read another user's settings.
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
 * Opens (or finds) a 1-on-1 direct thread between the caller and the target.
 * Only valid when verdict = 'allowed'. If verdict = 'requires_request', the
 * caller must use POST /api/users/:userId/message-request instead.
 *
 * Idempotent: if a thread already exists, returns it.
 */
router.post('/users/:userId/open-thread', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const recipientId = req.params.userId;
  if (!isUuid(recipientId)) { sendError(res, 'invalid_payload', 'Invalid user id'); return; }
  if (recipientId === user.id) { sendError(res, 'invalid_payload', 'Cannot open a thread with yourself'); return; }

  // Service client required: canMessage reads recipient settings (RLS-restricted to owner).
  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // Check permission: must be 'allowed' (direct messaging).
  const verdict = await canMessage(sc, user.id, recipientId);
  if (verdict.verdict === 'denied') {
    sendError(res, 'forbidden', `Cannot message this user: ${verdict.reason ?? 'denied'}`);
    return;
  }
  if (verdict.verdict === 'requires_request') {
    sendError(res, 'forbidden', 'This user requires a message request first. Use POST /api/users/:userId/message-request.');
    return;
  }

  // Look for an existing STRICTLY 1:1 direct thread (exactly 2 members: caller + recipient).
  const { data: myMemberships } = await sc
    .from('message_thread_members')
    .select('thread_id')
    .eq('user_id', user.id);

  const myThreadIds = (myMemberships ?? []).map((m: any) => m.thread_id);

  let existingThreadId: string | null = null;
  if (myThreadIds.length > 0) {
    // Fetch all members of threads the caller belongs to, then filter for
    // threads that have EXACTLY caller + recipient and no other members.
    const { data: allMembers } = await sc
      .from('message_thread_members')
      .select('thread_id, user_id')
      .in('thread_id', myThreadIds);

    const membersByThread: Record<string, string[]> = {};
    for (const m of (allMembers ?? []) as any[]) {
      if (!membersByThread[m.thread_id]) membersByThread[m.thread_id] = [];
      membersByThread[m.thread_id].push(m.user_id);
    }

    for (const [threadId, members] of Object.entries(membersByThread)) {
      if (
        members.length === 2 &&
        members.includes(user.id) &&
        members.includes(recipientId)
      ) {
        existingThreadId = threadId;
        break;
      }
    }
  }

  if (existingThreadId) {
    res.status(200).json({ threadId: existingThreadId, created: false });
    return;
  }

  // No existing 1:1 thread — create one.
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
  await sc.from('message_thread_members').insert([
    { thread_id: threadId, user_id: user.id, joined_at: now },
    { thread_id: threadId, user_id: recipientId, joined_at: now },
  ]);

  res.status(201).json({ threadId, created: true });
});

/* ---------------------------------------------------------------------------
 * POST /api/users/:userId/message-request
 * ---------------------------------------------------------------------------
 * Creates a message request from the current user to the target user.
 * Idempotent on duplicate pending (returns existing request).
 * Validates via canMessage resolver — must be 'requires_request' verdict.
 */
router.post('/users/:userId/message-request', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const recipientId = req.params.userId;
  if (!isUuid(recipientId)) {
    sendError(res, 'invalid_payload', 'Invalid user id');
    return;
  }
  if (recipientId === user.id) {
    sendError(res, 'invalid_payload', 'You cannot send a message request to yourself');
    return;
  }

  // Check recipient exists (user-scoped client is fine for public profiles).
  const { data: profile } = await client.from('profiles').select('id').eq('id', recipientId).maybeSingle();
  if (!profile) {
    sendError(res, 'not_found', 'User not found');
    return;
  }

  // Service client required: canMessage reads recipient settings (RLS-restricted to owner).
  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  // Evaluate permission — must be requires_request (not denied, not allowed).
  const verdict = await canMessage(sc, user.id, recipientId);
  if (verdict.verdict === 'denied') {
    sendError(res, 'forbidden', `Cannot message this user: ${verdict.reason ?? 'denied'}`);
    return;
  }

  // Idempotent on pending.
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
      // A thread already exists — look it up.
      res.status(200).json({ requestId: ex.id, status: 'accepted' });
      return;
    }
    // Declined/cancelled → create a fresh request.
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
});

/* ---------------------------------------------------------------------------
 * GET /api/me/message-requests
 * ---------------------------------------------------------------------------
 * Incoming pending message requests for the current user (for Request Inbox).
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
  if (senderIds.length > 0) {
    const { data: profiles } = await sc.from('profiles').select(PROFILE_PUBLIC).in('id', senderIds);
    for (const p of profiles ?? []) profileMap[(p as any).id] = p;
  }

  const requests = (data ?? []).map((r: any) => {
    const p = profileMap[r.sender_id];
    return {
      requestId: r.id,
      previewText: r.preview_text ?? null,
      createdAt: r.created_at,
      sender: p
        ? { id: p.id, handle: p.handle, name: p.name, avatarUrl: p.avatar_url ?? null }
        : null,
    };
  });

  res.status(200).json({ requests });
});

/* ---------------------------------------------------------------------------
 * POST /api/message-requests/:requestId/accept
 * ---------------------------------------------------------------------------
 * Recipient only. Creates a message_threads + two message_thread_members rows.
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
    .select('id, sender_id, recipient_id, status')
    .eq('id', requestId)
    .maybeSingle();

  if (!mr) { sendError(res, 'not_found', 'Message request not found'); return; }
  const req_ = mr as any;
  if (req_.recipient_id !== user.id) { sendError(res, 'forbidden', 'Only the recipient can accept this request'); return; }
  if (req_.status !== 'pending') { sendError(res, 'invalid_payload', `Request is already ${req_.status}`); return; }

  const now = new Date().toISOString();

  // Detect an existing 1:1 thread between sender and recipient — accept is idempotent.
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

    for (const [tid, members] of Object.entries(membersByThread)) {
      if (
        members.length === 2 &&
        members.includes(req_.sender_id) &&
        members.includes(req_.recipient_id)
      ) {
        existingDirectThreadId = tid;
        break;
      }
    }
  }

  let threadId: string;

  if (existingDirectThreadId) {
    // Reuse the existing 1:1 direct thread — no duplicate creation.
    threadId = existingDirectThreadId;
  } else {
    // Create a new 1:1 thread and add both parties.
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

    await sc.from('message_thread_members').insert([
      { thread_id: threadId, user_id: req_.sender_id, joined_at: now },
      { thread_id: threadId, user_id: req_.recipient_id, joined_at: now },
    ]);
  }

  // Mark request accepted.
  await sc
    .from('message_requests')
    .update({ status: 'accepted', responded_at: now })
    .eq('id', requestId);

  res.status(200).json({ status: 'accepted', threadId, requestId });
});

/* ---------------------------------------------------------------------------
 * POST /api/message-requests/:requestId/decline
 * ---------------------------------------------------------------------------
 * Recipient only. Leaves no thread.
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
    .select('id, recipient_id, status')
    .eq('id', requestId)
    .maybeSingle();

  if (!mr) { sendError(res, 'not_found', 'Message request not found'); return; }
  const req_ = mr as any;
  if (req_.recipient_id !== user.id) { sendError(res, 'forbidden', 'Only the recipient can decline this request'); return; }
  if (req_.status !== 'pending') { sendError(res, 'invalid_payload', `Request is already ${req_.status}`); return; }

  const now = new Date().toISOString();
  await sc.from('message_requests').update({ status: 'declined', responded_at: now }).eq('id', requestId);

  res.status(200).json({ status: 'declined', requestId });
});

/* ---------------------------------------------------------------------------
 * POST /api/message-requests/:requestId/cancel
 * ---------------------------------------------------------------------------
 * Sender only.
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
 * GET /api/me/threads
 * ---------------------------------------------------------------------------
 * Lists threads the current user is a member of, with last-message preview.
 */
router.get('/me/threads', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { data: memberships, error: mErr } = await client
    .from('message_thread_members')
    .select('thread_id, muted_at, archived_at')
    .eq('user_id', user.id);

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

  // Fetch threads + last message + other members.
  const [threadsRes, lastMsgRes, allMembersRes] = await Promise.all([
    sc
      .from('message_threads')
      .select('id, created_at, updated_at, last_message_at, status')
      .in('id', threadIds)
      .order('last_message_at', { ascending: false, nullsFirst: false }),

    // Last message per thread (most recent non-deleted).
    sc
      .from('messages')
      .select('thread_id, body, sender_id, created_at, deleted_at')
      .in('thread_id', threadIds)
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),

    sc
      .from('message_thread_members')
      .select(`user_id, profile:profiles!message_thread_members_user_id_fkey(${PROFILE_PUBLIC})`)
      .in('thread_id', threadIds),
  ]);

  // Last message per thread (first occurrence after ordering by desc).
  const lastMsgByThread: Record<string, any> = {};
  for (const m of (lastMsgRes.data ?? []) as any[]) {
    if (!lastMsgByThread[m.thread_id]) lastMsgByThread[m.thread_id] = m;
  }

  // Other members per thread (excluding current user).
  const membersByThread: Record<string, any[]> = {};
  for (const m of (allMembersRes.data ?? []) as any[]) {
    if (m.user_id === user.id) continue;
    if (!membersByThread[m.thread_id]) membersByThread[m.thread_id] = [];
    const p = m.profile ?? {};
    membersByThread[m.thread_id].push({
      id: p.id,
      handle: p.handle,
      name: p.name,
      avatarUrl: p.avatar_url ?? null,
    });
  }

  const membershipMap: Record<string, any> = {};
  for (const m of memberships ?? []) membershipMap[(m as any).thread_id] = m;

  const threads = (threadsRes.data ?? []).map((t: any) => {
    const lm = lastMsgByThread[t.id];
    const mem = membershipMap[t.id] ?? {};
    return {
      id: t.id,
      status: t.status,
      lastMessageAt: t.last_message_at ?? null,
      createdAt: t.created_at,
      mutedAt: mem.muted_at ?? null,
      archivedAt: mem.archived_at ?? null,
      otherMembers: membersByThread[t.id] ?? [],
      lastMessagePreview: lm
        ? { body: lm.body.slice(0, 80), senderId: lm.sender_id, createdAt: lm.created_at }
        : null,
    };
  });

  res.status(200).json({ threads });
});

/* ---------------------------------------------------------------------------
 * GET /api/threads/:threadId/messages
 * ---------------------------------------------------------------------------
 * Thread members only. Paginated (cursor = before ISO timestamp, limit 50).
 * Deleted messages rendered as tombstone.
 */
router.get('/threads/:threadId/messages', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { threadId } = req.params;
  if (!isUuid(threadId)) { sendError(res, 'invalid_payload', 'Invalid thread id'); return; }

  // Guard: must be a member.
  const { data: membership } = await client
    .from('message_thread_members')
    .select('user_id')
    .eq('thread_id', threadId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!membership) { sendError(res, 'forbidden', 'Not a member of this thread'); return; }

  const before = req.query.before as string | undefined;
  const limit = Math.min(Number(req.query.limit ?? 50), 100);

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  let query = sc
    .from('messages')
    .select(`id, thread_id, sender_id, body, deleted_at, created_at, edited_at, profile:profiles!messages_sender_id_fkey(${PROFILE_PUBLIC})`)
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

  const messages = ((data ?? []) as any[]).map((m) => {
    const p = m.profile ?? {};
    return {
      id: m.id,
      threadId: m.thread_id,
      senderId: m.sender_id,
      senderHandle: p.handle ?? null,
      senderName: p.name ?? null,
      senderAvatarUrl: p.avatar_url ?? null,
      body: m.deleted_at ? null : m.body,
      deleted: Boolean(m.deleted_at),
      createdAt: m.created_at,
      editedAt: m.edited_at ?? null,
    };
  });

  res.status(200).json({ messages, threadId });
});

/* ---------------------------------------------------------------------------
 * POST /api/threads/:threadId/messages
 * ---------------------------------------------------------------------------
 * Thread members only. Creates a message and bumps last_message_at.
 */
router.post('/threads/:threadId/messages', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { threadId } = req.params;
  if (!isUuid(threadId)) { sendError(res, 'invalid_payload', 'Invalid thread id'); return; }

  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!body) { sendError(res, 'invalid_payload', 'body is required'); return; }
  if (body.length > 4000) { sendError(res, 'invalid_payload', 'body must be 4000 characters or fewer'); return; }

  // Guard: must be a member.
  const { data: membership } = await client
    .from('message_thread_members')
    .select('user_id')
    .eq('thread_id', threadId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!membership) { sendError(res, 'forbidden', 'Not a member of this thread'); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const now = new Date().toISOString();

  const { data: msg, error: msgErr } = await sc
    .from('messages')
    .insert({ thread_id: threadId, sender_id: user.id, body, created_at: now })
    .select('id, thread_id, sender_id, body, created_at')
    .single();

  if (msgErr || !msg) {
    req.log.error({ err: msgErr }, 'message insert failed');
    sendError(res, 'db_error', msgErr?.message ?? 'Failed to insert message');
    return;
  }

  // Bump thread last_message_at.
  await sc
    .from('message_threads')
    .update({ last_message_at: now, updated_at: now })
    .eq('id', threadId);

  const m = msg as any;
  res.status(201).json({
    id: m.id,
    threadId: m.thread_id,
    senderId: m.sender_id,
    body: m.body,
    deleted: false,
    createdAt: m.created_at,
    editedAt: null,
  });
});

export default router;
