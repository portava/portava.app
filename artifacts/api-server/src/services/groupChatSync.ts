/**
 * Group chat membership sync helpers.
 *
 * These functions are called (fire-and-forget) whenever a user's membership
 * in a trip or circle changes:
 *
 *   syncTripChatMembers(sc, tripId)
 *     — Called after a user accepts a trip invite.
 *       Finds or creates the trip's group-chat thread and reconciles the
 *       message_thread_members table with the current accepted trip members
 *       (role IN ('owner', 'member')).
 *
 *   syncCircleChatMembers(sc, circleOwnerId)
 *     — Called after a user accepts a circle invite.
 *       Finds or creates the circle-owner's group-chat thread and reconciles
 *       message_thread_members with the circle's current members.
 *
 * Both functions are idempotent and race-safe: concurrent calls converge to
 * the same state because they use ON CONFLICT upserts and a single unique
 * partial index per trip / circle owner.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { circleThreadTitle } from '../lib/displayName';
// Telegraph §13.2 member.joined — census T185 measured this sync as silent to
// open clients.
import { publishToThread } from '../lib/telegraphEvents.js';

// ---------------------------------------------------------------------------
// Trip group chat sync
// ---------------------------------------------------------------------------

/**
 * Ensure a 'trip' type thread exists for tripId, then reconcile its membership
 * to exactly the set of accepted trip members (role IN ('owner', 'member')).
 *
 * Returns the thread's UUID.
 */
export async function syncTripChatMembers(
  sc: SupabaseClient,
  tripId: string,
): Promise<string> {
  const now = new Date().toISOString();

  // ── A DURABLE TITLE MUST NOT COME FROM A READ THAT NEVER HAPPENED ─────────
  // census T344/T363, §17.8 item 2, §18.4. supabase-js RESOLVES on a database
  // failure, so a dropped error arrived here as `data: null`, `?? 'Trip Chat'`
  // read that as "the trip has no title", and the INSERT below stamped the
  // guess onto the thread row. §18.4: "a durable wrong title is the worst of
  // the three consequences in this class, because unlike a 404 it does not go
  // away when the outage does."
  //
  // The error is bound here and JUDGED in the create branch only, deliberately.
  // This read runs on every call, but the title is used on exactly one of
  // them — the call that creates the thread. Throwing on an unreadable `trips`
  // when the thread already exists would turn a cosmetic outage into a failed
  // sync for every healthy trip chat in the system, which is a worse answer
  // than the defect. So the refusal is placed where the durability is.
  const { data: trip, error: tripErr } = await sc
    .from('trips')
    .select('id, title, destination_city')
    .eq('id', tripId)
    .maybeSingle();

  const threadTitle = (trip as any)?.title ?? (trip as any)?.destination_city ?? 'Trip Chat';

  // Find or create the trip's group thread (unique index on trip_id WHERE thread_type='trip').
  let threadId: string;

  // An unreadable message_threads is NOT "this trip has no thread yet". Reading
  // it that way sends us into the INSERT below, which either trips the unique
  // partial index (a 500 for a trip whose chat exists and is healthy) or — if
  // that index is ever absent — creates a SECOND thread for the trip and then
  // upserts every accepted member into it, splitting the crew off from their
  // own message history. Fail closed: throw, exactly as every write failure in
  // this function already does, so the caller retries against a live database.
  const { data: existing, error: existingErr } = await sc
    .from('message_threads')
    .select('id')
    .eq('thread_type', 'trip')
    .eq('trip_id', tripId)
    .maybeSingle();

  if (existingErr) {
    throw new Error(`syncTripChatMembers: thread lookup failed for trip ${tripId}: ${existingErr.message}`);
  }

  if (existing) {
    threadId = (existing as any).id as string;
  } else {
    // The title read above is only load-bearing HERE. Refuse rather than write
    // the guess; throwing is what every other write failure in this function
    // already does, so the caller retries against a live database.
    if (tripErr) {
      throw new Error(
        `syncTripChatMembers: trip read failed for trip ${tripId}: ${tripErr.message} ` +
          `— refusing to create a thread whose DURABLE title would be a generic guess`,
      );
    }
    const { data: created, error: createErr } = await sc
      .from('message_threads')
      .insert({
        thread_type: 'trip',
        trip_id: tripId,
        title: threadTitle,
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();

    if (createErr) {
      // Lost a race — another request created it first; fetch the winner.
      const { data: raceWinner, error: raceErr } = await sc
        .from('message_threads')
        .select('id')
        .eq('thread_type', 'trip')
        .eq('trip_id', tripId)
        .maybeSingle();
      // Both outcomes throw, but they are not the same fault: `!raceWinner`
      // means the insert failed for a reason that was never a race, while
      // `raceErr` means the table went away between the two statements. Naming
      // the read error stops the second being reported as the first.
      if (raceErr) {
        throw new Error(`syncTripChatMembers: thread lookup after insert conflict failed for trip ${tripId}: ${raceErr.message} (insert: ${createErr.message})`);
      }
      if (!raceWinner) throw new Error(`syncTripChatMembers: cannot find or create thread for trip ${tripId}: ${createErr.message}`);
      threadId = (raceWinner as any).id as string;
    } else {
      threadId = (created as any).id as string;
    }
  }

  // Get accepted trip members (owner + member, not invited).
  //
  // ── AN UNREADABLE ROSTER IS NOT AN EMPTY ROSTER ────────────────────────────
  // census T344/T363. This is the input to the removal step below. With the
  // error dropped it was also the input to `acceptedIds.size === 0`, and that
  // early return is the only reason this file did not do what `lib/chatSync.ts`
  // did — evict the whole crew. It is an accident, not a guard: it cannot tell
  // "this trip has no accepted members" from "the table is unreadable", and it
  // answers BOTH by handing the caller a thread id, which says the roster was
  // reconciled. `routes/messaging.ts:3248` then serves the trip chat on that
  // id. Refusing is the only answer supported by a read that did not happen.
  const { data: tripMembers, error: tripMembersErr } = await sc
    .from('trip_members')
    .select('user_id')
    .eq('trip_id', tripId)
    .in('role', ['owner', 'member']);

  if (tripMembersErr) {
    throw new Error(
      `syncTripChatMembers: accepted-member read from trip_members failed for trip ${tripId}: ` +
        `${tripMembersErr.message} — refusing to reconcile a roster this read could not see`,
    );
  }

  const acceptedIds = new Set(((tripMembers ?? []) as any[]).map((m) => m.user_id as string));

  // A genuinely empty accepted set. Distinct from the refusal above: the read
  // succeeded and the trip really has nobody left to reconcile.
  if (acceptedIds.size === 0) return threadId;

  // Telegraph §13.2 `member.joined`. Who was ALREADY here is read before the
  // upsert, because after it everyone looks like a member and the event would
  // fire for the whole crew on every sync. census T185 measured the absence:
  // "a trip-membership sync is silent to open clients", so a crew-mate
  // appearing in a thread was something you found out by scrolling.
  //
  // An unreadable roster means no event rather than an event for everyone: a
  // burst of false "X joined" lines is worse than a missing one, and the
  // client's next poll shows the real roster either way.
  const { data: priorMembers, error: priorErr } = await sc
    .from('message_thread_members')
    .select('user_id')
    .eq('thread_id', threadId)
    .is('left_at', null);
  const priorIds = priorErr
    ? null
    : new Set(((priorMembers ?? []) as any[]).map((m) => m.user_id as string));

  // Upsert all accepted members as active (left_at = null).
  const upsertRows = [...acceptedIds].map((userId) => ({
    thread_id: threadId,
    user_id: userId,
    role: 'member',
    joined_at: now,
    left_at: null,
  }));

  const { error: upsertErr } = await sc.from('message_thread_members').upsert(upsertRows, {
    onConflict: 'thread_id,user_id',
    ignoreDuplicates: false,
  });
  if (upsertErr) throw new Error(`syncTripChatMembers: member upsert failed for trip ${tripId}: ${upsertErr.message}`);

  if (priorIds !== null) {
    const newcomers = [...acceptedIds].filter((id) => !priorIds.has(id));
    for (const userId of newcomers) {
      void publishToThread(sc, threadId, {
        type: 'member.joined',
        payload: { userId, source: 'trip_sync', tripId, joinedAt: now },
      });
    }
  }

  // Mark any thread members no longer in the accepted set as left.
  //
  // Dropped, this read failed in the other direction from the roster read
  // above: an unreadable `message_thread_members` produced an empty `toRemove`,
  // so a member the trip had removed kept access to the crew thread and nothing
  // anywhere said so. Removal that silently does not happen is the same defect
  // as removal that wrongly does.
  const { data: activeMembers, error: activeMembersErr } = await sc
    .from('message_thread_members')
    .select('user_id')
    .eq('thread_id', threadId)
    .is('left_at', null);

  if (activeMembersErr) {
    throw new Error(
      `syncTripChatMembers: active-member read from message_thread_members failed for trip ${tripId}: ` +
        `${activeMembersErr.message} — refusing rather than reporting nobody to remove`,
    );
  }

  const toRemove = ((activeMembers ?? []) as any[])
    .map((m) => m.user_id as string)
    .filter((id) => !acceptedIds.has(id));

  if (toRemove.length > 0) {
    const { error: removeErr } = await sc
      .from('message_thread_members')
      .update({ left_at: now })
      .eq('thread_id', threadId)
      .in('user_id', toRemove);
    if (removeErr) throw new Error(`syncTripChatMembers: member removal failed for trip ${tripId}: ${removeErr.message}`);
  }

  return threadId;
}

// ---------------------------------------------------------------------------
// Circle group chat sync
// ---------------------------------------------------------------------------

/**
 * Ensure a 'circle' type thread exists for circleOwnerId, then reconcile its
 * membership to the owner plus all circle_memberships members.
 *
 * Returns the thread's UUID.
 */
export async function syncCircleChatMembers(
  sc: SupabaseClient,
  circleOwnerId: string,
): Promise<string> {
  const now = new Date().toISOString();

  // Same rule as the trip branch, same reason, same placement: an unreadable
  // `profiles` would name the owner's own circle after the fallback `'Circle'`
  // permanently, and the title is load-bearing only in the create branch.
  const { data: ownerProfile, error: ownerProfileErr } = await sc
    .from('profiles')
    .select('id, name, handle')
    .eq('id', circleOwnerId)
    .maybeSingle();

  const displayName = (ownerProfile as any)?.name ?? (ownerProfile as any)?.handle ?? 'Circle';
  const threadTitle = circleThreadTitle(displayName);

  // Find or create the circle's group thread (unique index on circle_owner_id WHERE thread_type='circle').
  let threadId: string;

  // Same reasoning as the trip branch: an unreadable table must not be read as
  // "this circle has no thread", which would create a duplicate circle thread
  // and move the owner's whole circle into it.
  const { data: existing, error: existingErr } = await sc
    .from('message_threads')
    .select('id')
    .eq('thread_type', 'circle')
    .eq('circle_owner_id', circleOwnerId)
    .maybeSingle();

  if (existingErr) {
    throw new Error(`syncCircleChatMembers: thread lookup failed for circle ${circleOwnerId}: ${existingErr.message}`);
  }

  if (existing) {
    threadId = (existing as any).id as string;
  } else {
    if (ownerProfileErr) {
      throw new Error(
        `syncCircleChatMembers: owner profile read failed for circle ${circleOwnerId}: ` +
          `${ownerProfileErr.message} — refusing to create a thread whose DURABLE title would be a generic guess`,
      );
    }
    const { data: created, error: createErr } = await sc
      .from('message_threads')
      .insert({
        thread_type: 'circle',
        circle_owner_id: circleOwnerId,
        title: threadTitle,
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();

    if (createErr) {
      const { data: raceWinner, error: raceErr } = await sc
        .from('message_threads')
        .select('id')
        .eq('thread_type', 'circle')
        .eq('circle_owner_id', circleOwnerId)
        .maybeSingle();
      if (raceErr) {
        throw new Error(`syncCircleChatMembers: thread lookup after insert conflict failed for circle ${circleOwnerId}: ${raceErr.message} (insert: ${createErr.message})`);
      }
      if (!raceWinner) throw new Error(`syncCircleChatMembers: cannot find or create thread for circle ${circleOwnerId}: ${createErr.message}`);
      threadId = (raceWinner as any).id as string;
    } else {
      threadId = (created as any).id as string;
    }
  }

  // Get circle members: owner + all accepted circle_memberships.
  //
  // The trip branch's accidental `size === 0` shield does not exist here: the
  // owner is always in the set, so an unreadable `circle_memberships` produced
  // a set of exactly one and the removal step below evicted EVERY OTHER MEMBER
  // from the circle chat. census T344/T363.
  const { data: circleMembers, error: circleMembersErr } = await sc
    .from('circle_memberships')
    .select('other_id')
    .eq('user_id', circleOwnerId);

  if (circleMembersErr) {
    throw new Error(
      `syncCircleChatMembers: member read from circle_memberships failed for circle ${circleOwnerId}: ` +
        `${circleMembersErr.message} — refusing to reconcile a circle down to its owner alone`,
    );
  }

  const memberIds = new Set<string>([
    circleOwnerId,
    ...((circleMembers ?? []) as any[]).map((m) => m.other_id as string),
  ]);

  // Telegraph §13.2 `member.joined` — same rule as the trip branch above: the
  // prior roster is read BEFORE the upsert, and an unreadable roster means no
  // event rather than an event for every member.
  const { data: priorCircleMembers, error: priorCircleErr } = await sc
    .from('message_thread_members')
    .select('user_id')
    .eq('thread_id', threadId)
    .is('left_at', null);
  const priorCircleIds = priorCircleErr
    ? null
    : new Set(((priorCircleMembers ?? []) as any[]).map((m) => m.user_id as string));

  // Upsert all current members as active.
  const upsertRows = [...memberIds].map((userId) => ({
    thread_id: threadId,
    user_id: userId,
    role: 'member',
    joined_at: now,
    left_at: null,
  }));

  const { error: upsertErr } = await sc.from('message_thread_members').upsert(upsertRows, {
    onConflict: 'thread_id,user_id',
    ignoreDuplicates: false,
  });
  if (upsertErr) throw new Error(`syncCircleChatMembers: member upsert failed for circle ${circleOwnerId}: ${upsertErr.message}`);

  if (priorCircleIds !== null) {
    const newcomers = [...memberIds].filter((id) => !priorCircleIds.has(id));
    for (const userId of newcomers) {
      void publishToThread(sc, threadId, {
        type: 'member.joined',
        payload: { userId, source: 'circle_sync', circleOwnerId, joinedAt: now },
      });
    }
  }

  // Mark any thread members no longer in the circle as left. Bound for the same
  // reason as the trip branch's active-member read.
  const { data: activeMembers, error: activeMembersErr } = await sc
    .from('message_thread_members')
    .select('user_id')
    .eq('thread_id', threadId)
    .is('left_at', null);

  if (activeMembersErr) {
    throw new Error(
      `syncCircleChatMembers: active-member read from message_thread_members failed for circle ${circleOwnerId}: ` +
        `${activeMembersErr.message} — refusing rather than reporting nobody to remove`,
    );
  }

  const toRemove = ((activeMembers ?? []) as any[])
    .map((m) => m.user_id as string)
    .filter((id) => !memberIds.has(id));

  if (toRemove.length > 0) {
    const { error: removeErr } = await sc
      .from('message_thread_members')
      .update({ left_at: now })
      .eq('thread_id', threadId)
      .in('user_id', toRemove);
    if (removeErr) throw new Error(`syncCircleChatMembers: member removal failed for circle ${circleOwnerId}: ${removeErr.message}`);
  }

  return threadId;
}
