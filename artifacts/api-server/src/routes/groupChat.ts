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
  senderLanguageFrom,
  type TranslationStatusValue,
} from '../services/messageTranslation';
import { nameVisibilitySet } from '../lib/publicIdentity';
import { asyncHandler } from '../lib/asyncHandler';
// Telegraph §13.2 message.deleted — census T182 measured the delete as silent.
import { publishToThread } from '../lib/telegraphEvents';
import {
  applyHistoryWindow,
  historyBoundEnabled,
  visibleFromOf,
  withinWindow,
} from '../services/groupChatHistoryBound.js';

const router = Router();

const PROFILE_PUBLIC = 'id, handle, name, avatar_url';
const INITIAL_MSG_LIMIT = 50;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * ── AN UNREADABLE AUTHORIZATION TABLE IS NOT A SETTLED REFUSAL ───────────────
 * census §20.7, executed for `routes/telegraphChat.ts` and
 * `routes/telegraphStream.ts` by §22.3 and for this file here.
 *
 * supabase-js RESOLVES on a database failure, so `const { data } = await …`
 * arrived as `data: null` — byte-identical to a genuine non-member — and both
 * helpers below answered `false`. The route then told a traveller, by name,
 * that they are not in their own conversation. That is SAFE (it denies rather
 * than admits) and FALSE (the server did not perform the check), and a 403 is
 * the refusal a client acts on by GIVING UP: it will not recover when the table
 * does.
 *
 * Both helpers now return three outcomes rather than a boolean, and the third
 * one — `unreadable` — is refused with `degraded_unavailable`, this codebase's
 * own code for "the check was NOT PERFORMED" and the only code `lib/http.ts`
 * marks retryable. A genuine non-member still gets the same 403 with the same
 * words, which every case in `src/test/telegraphMembershipHonesty.test.ts`
 * asserts beside its outage case.
 */
type CircleMembership = 'member' | 'not_member' | 'unreadable';

async function isAcceptedCircleMember(
  sc: any,
  circleOwnerId: string,
  userId: string,
): Promise<CircleMembership> {
  if (userId === circleOwnerId) return 'member';
  const { data, error } = await sc
    .from('circle_memberships')
    .select('other_id')
    .eq('user_id', circleOwnerId)
    .eq('other_id', userId)
    .maybeSingle();
  if (error) return 'unreadable';
  return data ? 'member' : 'not_member';
}

async function isActiveThreadMember(
  sc: any,
  threadId: string,
  userId: string,
): Promise<{ active: boolean; left: boolean; unreadable: boolean; visibleFrom: string | null }> {
  // §14.3. The membership read is where the caller's history bound lives, so it
  // is read here rather than a second time inside the message read.
  //
  // WHY THIS FILE IS BOUND AT ALL, given that both of its chat reads are
  // currently SHADOWED: routes/index.ts registers messagingRouter (line 201)
  // before groupChatRouter (line 204), and routes/messaging.ts serves both
  // `GET /trips/:tripId/chat` (:3630) and `GET /circles/:circleOwnerId/chat`
  // (:3699), so Express never reaches the handlers below for those two paths.
  // A full-history read of message BODIES that is unreachable only because of
  // a mount ORDER is one router registration away from being reachable, and
  // §14.3 is not a rule this file should be exempt from for a reason that is
  // not written down anywhere near it. The bound costs one column and one
  // filter and makes the exemption unnecessary.
  //
  // FALSE ON ERROR for the flag (lib/featureFlags.isFlagEnabled), refuse on an
  // unreadable membership: unchanged from before, each in its own direction.
  const boundOn = await historyBoundEnabled(sc);
  // TWO LITERAL SELECT LISTS, NOT ONE COMPUTED ONE. The flag gate is unchanged —
  // a database without 2400 is still never asked for `visible_from_at` — but the
  // column list is now a string LITERAL on each branch instead of a call result.
  // `check:write-path-columns` resolves select lists statically and counted the
  // computed form as an UNRESOLVABLE SITE, i.e. a blind spot where it could no
  // longer verify these columns against the live schema. The remedy the check
  // itself prefers is to make the site resolvable rather than to widen its
  // allowlist, and that is what this is. `membershipSelect` still exists and is
  // still the single definition of what the bound adds; it is exercised by its
  // own unit tests and by the callers whose select lists are already static.
  const membershipQuery = boundOn
    ? sc.from('message_thread_members').select('user_id, left_at, visible_from_at')
    : sc.from('message_thread_members').select('user_id, left_at');
  const { data, error } = await membershipQuery
    .eq('thread_id', threadId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return { active: false, left: false, unreadable: true, visibleFrom: null };
  if (!data) return { active: false, left: false, unreadable: false, visibleFrom: null };
  const left = (data as any).left_at !== null;
  return { active: !left, left, unreadable: false, visibleFrom: visibleFromOf(data as any, boundOn) };
}

/** The one refusal both unreadable outcomes send, so the five call sites cannot drift apart. */
function refuseUnreadable(req: any, res: any, table: string, ctx: Record<string, unknown>): void {
  req.log.error({ ...ctx }, `${table} read failed — refusing rather than asserting the caller is not a member`);
  sendError(res, 'degraded_unavailable', 'We could not check your access to this chat right now. Please try again shortly.');
}

/**
 * What a group thread's message read established.
 *
 * census T344 ("no plausible empty inbox/**context**") and T363 ("no plausible
 * empty **state**"). This function used to return a bare `any[]`, and `(data ??
 * [])` on a DROPPED error meant an unreadable `messages` rendered a trip or
 * circle chat as A CONVERSATION WITH NO MESSAGES — the same payload a brand-new
 * thread produces, to a member looking at a thread full of history. No section
 * of the census had named this site; it is the same defect §14 fixed in
 * `GET /me/threads` and §17.8 item 2 named two other instances of in this file.
 *
 * An array cannot say "I could not read", so the return type says it instead
 * and both callers answer §18.2's `degraded_unavailable`.
 */
type ThreadMessagesRead =
  | { readonly ok: true; readonly messages: any[] }
  | { readonly ok: false; readonly error: any };

async function fetchMessagesForThread(
  sc: any,
  threadId: string,
  userId: string,
  visibleFrom: string | null,
): Promise<ThreadMessagesRead> {
  let q = sc
    .from('messages')
    .select(`id, thread_id, sender_id, body, deleted_at, created_at, edited_at, original_language, profile:profiles!messages_sender_id_fkey(${PROFILE_PUBLIC})`)
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false })
    .limit(INITIAL_MSG_LIMIT);
  // §14.3. In the QUERY as well as in the filter below: `INITIAL_MSG_LIMIT`
  // takes the NEWEST rows, so a caller whose window opens late would otherwise
  // spend their whole page budget on rows the filter then removes and be shown
  // a short conversation. Bounding the query spends the budget on rows they may
  // see. `visibleFrom` is null (a no-op) while the flag is off.
  // Q6 belongs in the QUERY here for the very reason this comment already
  // gives: `INITIAL_MSG_LIMIT` takes the NEWEST rows. Bounding with a plain
  // `.gte` would spend the page budget correctly but would also drop the
  // caller's own earlier messages before JavaScript could admit them, so the
  // relaxed clause — `created_at >= bound OR sender_id = caller` — goes here.
  q = applyHistoryWindow(q, visibleFrom, userId);

  const { data, error: msgsErr } = await q;

  if (msgsErr) return { ok: false, error: msgsErr };

  // The second layer, and it is not redundant with the `gte` above: the two
  // values are ISO-8601 from either Postgres (`+00:00`) or Node (`Z`), and
  // `withinWindow` compares INSTANTS where PostgREST compares timestamps — this
  // is the one place both spellings of the boundary instant are guaranteed to
  // agree, and it is also what holds if a future edit drops the `gte`.
  const rows = ((data ?? []) as any[]).filter((m) =>
    withinWindow(m.created_at, visibleFrom, { senderId: m.sender_id, viewerId: userId }));

  const incomingIds = rows
    .filter((m) => m.sender_id !== userId && !m.deleted_at)
    .map((m) => m.id);

  let translationMap: Record<string, any> = {};
  if (incomingIds.length > 0) {
    const { data: tRows, error: tErr } = await sc
      .from('message_translations')
      .select('message_id, source_language, target_language, translated_body, status')
      .in('message_id', incomingIds)
      .eq('recipient_id', userId);

    if (tErr) {
      /*
        census T344/T363. This is the read §14 fixed in `routes/messaging.ts`
        and did not fix here — the same query in the other reader, reached by
        GET /trips/:tripId/chat and GET /circles/:circleId/chat. With the error
        dropped, an unreadable `message_translations` is indistinguishable from
        "no translation exists": every incoming message renders as its original
        with `translationStatus: null`, which is exactly the payload a
        same-language thread produces. §18 already has a word for "we did not
        translate this" — `failed` — and it already reaches the client with a
        retry affordance. The message is still delivered; only the claim about
        translation changes.
      */
      for (const id of incomingIds) {
        const row = rows.find((m) => m.id === id);
        translationMap[id] = {
          message_id: id,
          source_language: (row?.original_language as string | null) ?? 'und',
          target_language: 'und',
          translated_body: null,
          status: 'failed' as TranslationStatusValue,
        };
      }
    }
    for (const t of tRows ?? []) translationMap[(t as any).message_id] = t;
  }

  // Universal display-name rule: sender real names default to hidden (@handle)
  // unless the sender has opted in. Viewer always sees their own name.
  const senderIds = [...new Set(rows.map((m) => m.sender_id as string))];
  const allowedNames = await nameVisibilitySet(sc, senderIds);

  const messages = rows.map((m) => {
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

  return { ok: true, messages };
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
    // §20.7. The two answers below are NOT interchangeable: `pending_invite`
    // is an instruction the caller can act on, `not_member` is a dead end. The
    // read that decides between them dropped its error, so an unreadable
    // `trip_members` sent a person holding a live invite to the dead end.
    const { data: invited, error: invitedErr } = await sc
      .from('trip_members')
      .select('role')
      .eq('trip_id', tripId)
      .eq('user_id', user.id)
      .eq('role', 'invited')
      .maybeSingle();
    if (invitedErr) {
      refuseUnreadable(req, res, 'trip_members', { err: invitedErr, tripId, userId: user.id });
      return;
    }
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

  const { active, left, unreadable, visibleFrom } = await isActiveThreadMember(sc, threadId, user.id);
  if (unreadable) {
    refuseUnreadable(req, res, 'message_thread_members', { threadId, userId: user.id });
    return;
  }

  // ── AN UNREADABLE THREAD IS NOT AN ACTIVE THREAD ──────────────────────────
  // census T344/T363, §17.8 item 2. supabase-js RESOLVES on a database failure,
  // so a dropped error arrived as `data: null` and every `??` below then
  // ASSERTED a default: `title: 'Trip Chat'` and — the one that matters —
  // `status: 'active'`. A thread the trip owner CLOSED or archived read back as
  // active, to a member who is entitled to believe the number on the screen.
  // `createdAt: null` and `lastMessageAt: null` are the same shape on two more
  // fields.
  //
  // §18.2's posture, copied rather than reinvented: bind the error, log it, and
  // answer `degraded_unavailable` — this codebase's own code for "the check was
  // NOT PERFORMED" and the only code marked retryable in lib/http.ts
  // RETRYABLE_CODES.
  const { data: threadRow, error: threadRowErr } = await sc
    .from('message_threads')
    .select('id, thread_type, trip_id, title, status, last_message_at, created_at')
    .eq('id', threadId)
    .maybeSingle();

  if (threadRowErr) {
    req.log.error({ err: threadRowErr, threadId, tripId },
      'trip chat: message_threads read failed — refusing rather than reporting the thread as active');
    sendError(res, 'degraded_unavailable', 'We could not open this chat right now. Please try again shortly.');
    return;
  }

  const read = active
    ? await fetchMessagesForThread(sc, threadId, user.id, visibleFrom)
    : ({ ok: true, messages: [] } as const);
  if (!read.ok) {
    req.log.error({ err: (read as any).error, threadId, tripId },
      'trip chat: messages read failed — refusing rather than rendering an empty conversation');
    sendError(res, 'degraded_unavailable', 'We could not load this chat right now. Please try again shortly.');
    return;
  }
  const messages = read.messages;

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

  const circleMembership = await isAcceptedCircleMember(sc, circleOwnerId, user.id);
  if (circleMembership === 'unreadable') {
    refuseUnreadable(req, res, 'circle_memberships', { circleOwnerId, userId: user.id });
    return;
  }
  if (circleMembership === 'not_member') {
    // §20.7, the circle half of the same two-answer decision.
    const { data: invited, error: invitedErr } = await sc
      .from('circle_invites')
      .select('id')
      .eq('owner_id', circleOwnerId)
      .eq('recipient_id', user.id)
      .eq('status', 'pending')
      .maybeSingle();
    if (invitedErr) {
      refuseUnreadable(req, res, 'circle_invites', { err: invitedErr, circleOwnerId, userId: user.id });
      return;
    }
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

  const { active, left, unreadable, visibleFrom } = await isActiveThreadMember(sc, threadId, user.id);
  if (unreadable) {
    refuseUnreadable(req, res, 'message_thread_members', { threadId, userId: user.id });
    return;
  }

  // The circle half of the same defect, and the same posture. `'Trusted Circle'`
  // is a cosmetic lie; `status: 'active'` on a thread the owner closed is not.
  const { data: threadRow, error: threadRowErr } = await sc
    .from('message_threads')
    .select('id, thread_type, circle_owner_id, title, status, last_message_at, created_at')
    .eq('id', threadId)
    .maybeSingle();

  if (threadRowErr) {
    req.log.error({ err: threadRowErr, threadId, circleOwnerId },
      'circle chat: message_threads read failed — refusing rather than reporting the thread as active');
    sendError(res, 'degraded_unavailable', 'We could not open this chat right now. Please try again shortly.');
    return;
  }

  const read = active
    ? await fetchMessagesForThread(sc, threadId, user.id, visibleFrom)
    : ({ ok: true, messages: [] } as const);
  if (!read.ok) {
    req.log.error({ err: (read as any).error, threadId, circleOwnerId },
      'circle chat: messages read failed — refusing rather than rendering an empty conversation');
    sendError(res, 'degraded_unavailable', 'We could not load this chat right now. Please try again shortly.');
    return;
  }
  const messages = read.messages;

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

  const { data: msgRow, error: msgErr } = await sc
    .from('messages')
    .select('id, thread_id, sender_id, body, deleted_at')
    .eq('id', messageId)
    .maybeSingle();

  // T344/T363, §17.8. supabase-js RESOLVES on a database failure, so a dropped
  // error arrived here as `data: null` — indistinguishable from a message that does not exist — and
  // this route answered a confident 404. A 404 is the one refusal a caller acts
  // on by GIVING UP; an outage is not a deletion. `degraded_unavailable` is this
  // codebase's own code for "the check was NOT PERFORMED" and the only code
  // marked retryable (lib/http.ts RETRYABLE_CODES). A genuinely absent message
  // still gets the 404 it deserves, one line below.
  if (msgErr) {
    req.log.error({ err: msgErr, messageId },
      'messages read failed on group-chat edit — refusing rather than reporting the message as nonexistent');
    sendError(res, 'degraded_unavailable', 'We could not read that message right now. Please try again shortly.');
    return;
  }
  if (!msgRow) { sendError(res, 'not_found', 'Message not found'); return; }
  const m = msgRow as any;
  if (m.deleted_at) { sendError(res, 'invalid_payload', 'Cannot edit a deleted message'); return; }
  if (m.sender_id !== user.id) { sendError(res, 'forbidden', 'Only the sender can edit this message'); return; }

  const { active, unreadable } = await isActiveThreadMember(sc, m.thread_id, user.id);
  if (unreadable) {
    refuseUnreadable(req, res, 'message_thread_members', { threadId: m.thread_id, userId: user.id });
    return;
  }
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

  const { data: senderProfile, error: senderProfileErr } = await sc
    .from('profiles')
    .select('preferred_language, preferred_message_language')
    .eq('id', user.id)
    .maybeSingle();
  // T344/T363 — the error is BOUND. supabase-js RESOLVES on a database
  // failure, so the old `?? 'en'` turned an unreadable `profiles` into a
  // durable stored claim that this sender had chosen English. One shared
  // interpreter now decides what the read actually established.
  const senderLanguage = senderLanguageFrom(senderProfile, senderProfileErr);

  translateMessageForThread(sc, {
    messageId,
    body: newBody,
    senderId: user.id,
    threadId: m.thread_id,
    senderPreferredLanguage: senderLanguage.preferredLanguage,
    senderPreferenceUnreadable: senderLanguage.unreadable,
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

  const { data: msgRow, error: msgErr } = await sc
    .from('messages')
    .select('id, thread_id, sender_id, deleted_at')
    .eq('id', messageId)
    .maybeSingle();

  // T344/T363, §17.8. supabase-js RESOLVES on a database failure, so a dropped
  // error arrived here as `data: null` — indistinguishable from a message that does not exist — and
  // this route answered a confident 404. A 404 is the one refusal a caller acts
  // on by GIVING UP; an outage is not a deletion. `degraded_unavailable` is this
  // codebase's own code for "the check was NOT PERFORMED" and the only code
  // marked retryable (lib/http.ts RETRYABLE_CODES). A genuinely absent message
  // still gets the 404 it deserves, one line below.
  if (msgErr) {
    req.log.error({ err: msgErr, messageId },
      'messages read failed on group-chat delete — refusing rather than reporting the message as nonexistent');
    sendError(res, 'degraded_unavailable', 'We could not delete that message right now. Please try again shortly.');
    return;
  }
  if (!msgRow) { sendError(res, 'not_found', 'Message not found'); return; }
  const m = msgRow as any;
  if (m.deleted_at) { sendError(res, 'invalid_payload', 'Message is already deleted'); return; }
  if (m.sender_id !== user.id) { sendError(res, 'forbidden', 'Only the sender can delete this message'); return; }

  const { active, unreadable } = await isActiveThreadMember(sc, m.thread_id, user.id);
  if (unreadable) {
    refuseUnreadable(req, res, 'message_thread_members', { threadId: m.thread_id, userId: user.id });
    return;
  }
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
    .update({ deleted_at: now, body: '' })
    .eq('id', messageId);

  if (error) {
    req.log.error({ err: error }, 'message delete failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ id: messageId, deleted: true });

  // Telegraph §13.2 `message.deleted`. Published AFTER the 201/200, like every
  // other Telegraph event, so realtime can never fail a write — the bus
  // swallows and counts its own failures and the client's poll self-heals.
  // census T182 measured the absence: without this, a delete reached other
  // clients only on their next poll, so a message the sender had just retracted
  // stayed on everyone else's screen for the length of a polling interval.
  //
  // The payload carries the ID and not the body, because there is no body left:
  // the row above redacted it in place. A consumer wanting the old text is
  // asking for exactly the thing the delete removed.
  void publishToThread(sc, m.thread_id, {
    type: 'message.deleted',
    payload: { messageId, deletedAt: now, senderId: user.id },
  }, { excludeUserId: user.id });
}));

// ── POST /api/trips/:tripId/chat/sync — owner-only repair endpoint ────────────
// Only the trip owner may force a membership re-sync (e.g. after a bulk-remove).

router.post('/trips/:tripId/chat/sync', asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const { tripId } = req.params;
  if (!isUuid(tripId)) { sendError(res, 'invalid_payload', 'Invalid tripId'); return; }

  // §20.7. An unreadable `trip_members` used to tell the trip's own owner that
  // only the owner may do this.
  const { data: ownerRow, error: ownerRowErr } = await sc
    .from('trip_members')
    .select('role')
    .eq('trip_id', tripId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (ownerRowErr) {
    refuseUnreadable(req, res, 'trip_members', { err: ownerRowErr, tripId, userId: user.id });
    return;
  }
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
