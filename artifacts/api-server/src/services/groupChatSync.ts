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

  const { data: trip } = await sc
    .from('trips')
    .select('id, title, destination_city')
    .eq('id', tripId)
    .maybeSingle();

  const threadTitle = (trip as any)?.title ?? (trip as any)?.destination_city ?? 'Trip Chat';

  // Find or create the trip's group thread (unique index on trip_id WHERE thread_type='trip').
  let threadId: string;

  const { data: existing } = await sc
    .from('message_threads')
    .select('id')
    .eq('thread_type', 'trip')
    .eq('trip_id', tripId)
    .maybeSingle();

  if (existing) {
    threadId = (existing as any).id as string;
  } else {
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
      const { data: raceWinner } = await sc
        .from('message_threads')
        .select('id')
        .eq('thread_type', 'trip')
        .eq('trip_id', tripId)
        .maybeSingle();
      if (!raceWinner) throw new Error(`syncTripChatMembers: cannot find or create thread for trip ${tripId}: ${createErr.message}`);
      threadId = (raceWinner as any).id as string;
    } else {
      threadId = (created as any).id as string;
    }
  }

  // Get accepted trip members (owner + member, not invited).
  const { data: tripMembers } = await sc
    .from('trip_members')
    .select('user_id')
    .eq('trip_id', tripId)
    .in('role', ['owner', 'member']);

  const acceptedIds = new Set(((tripMembers ?? []) as any[]).map((m) => m.user_id as string));

  if (acceptedIds.size === 0) return threadId;

  // Upsert all accepted members as active (left_at = null).
  const upsertRows = [...acceptedIds].map((userId) => ({
    thread_id: threadId,
    user_id: userId,
    role: 'member',
    joined_at: now,
    left_at: null,
  }));

  await sc.from('message_thread_members').upsert(upsertRows, {
    onConflict: 'thread_id,user_id',
    ignoreDuplicates: false,
  });

  // Mark any thread members no longer in the accepted set as left.
  const { data: activeMembers } = await sc
    .from('message_thread_members')
    .select('user_id')
    .eq('thread_id', threadId)
    .is('left_at', null);

  const toRemove = ((activeMembers ?? []) as any[])
    .map((m) => m.user_id as string)
    .filter((id) => !acceptedIds.has(id));

  if (toRemove.length > 0) {
    await sc
      .from('message_thread_members')
      .update({ left_at: now })
      .eq('thread_id', threadId)
      .in('user_id', toRemove);
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

  const { data: ownerProfile } = await sc
    .from('profiles')
    .select('id, name, handle')
    .eq('id', circleOwnerId)
    .maybeSingle();

  const displayName = (ownerProfile as any)?.name ?? (ownerProfile as any)?.handle ?? 'Circle';
  const threadTitle = circleThreadTitle(displayName);

  // Find or create the circle's group thread (unique index on circle_owner_id WHERE thread_type='circle').
  let threadId: string;

  const { data: existing } = await sc
    .from('message_threads')
    .select('id')
    .eq('thread_type', 'circle')
    .eq('circle_owner_id', circleOwnerId)
    .maybeSingle();

  if (existing) {
    threadId = (existing as any).id as string;
  } else {
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
      const { data: raceWinner } = await sc
        .from('message_threads')
        .select('id')
        .eq('thread_type', 'circle')
        .eq('circle_owner_id', circleOwnerId)
        .maybeSingle();
      if (!raceWinner) throw new Error(`syncCircleChatMembers: cannot find or create thread for circle ${circleOwnerId}: ${createErr.message}`);
      threadId = (raceWinner as any).id as string;
    } else {
      threadId = (created as any).id as string;
    }
  }

  // Get circle members: owner + all accepted circle_memberships.
  const { data: circleMembers } = await sc
    .from('circle_memberships')
    .select('member_id')
    .eq('owner_id', circleOwnerId);

  const memberIds = new Set<string>([
    circleOwnerId,
    ...((circleMembers ?? []) as any[]).map((m) => m.member_id as string),
  ]);

  // Upsert all current members as active.
  const upsertRows = [...memberIds].map((userId) => ({
    thread_id: threadId,
    user_id: userId,
    role: 'member',
    joined_at: now,
    left_at: null,
  }));

  await sc.from('message_thread_members').upsert(upsertRows, {
    onConflict: 'thread_id,user_id',
    ignoreDuplicates: false,
  });

  // Mark any thread members no longer in the circle as left.
  const { data: activeMembers } = await sc
    .from('message_thread_members')
    .select('user_id')
    .eq('thread_id', threadId)
    .is('left_at', null);

  const toRemove = ((activeMembers ?? []) as any[])
    .map((m) => m.user_id as string)
    .filter((id) => !memberIds.has(id));

  if (toRemove.length > 0) {
    await sc
      .from('message_thread_members')
      .update({ left_at: now })
      .eq('thread_id', threadId)
      .in('user_id', toRemove);
  }

  return threadId;
}
