/**
 * Chat membership sync — the single source of truth for group thread membership.
 *
 * syncTripChatMembers(tripId, sc)
 *   • Ensures a 'trip' thread exists for the trip (create if absent, idempotent).
 *   • Reads currently-accepted members from trip_members (role owner | member).
 *   • Upserts them as thread members (left_at = NULL, role mirrors trip role).
 *   • Sets left_at = now() for any thread members no longer in the accepted set.
 *
 * syncCircleChatMembers(circleOwnerId, sc)
 *   • Ensures a 'circle' thread exists for the circle owner (create if absent).
 *   • Reads accepted members from circle_memberships (user_id = circle owner, other_id = member).
 *   • Upserts circle owner + accepted members as thread members.
 *   • Sets left_at = now() for members no longer in the accepted set.
 *
 * Both functions return the resolved threadId.
 *
 * Privacy: these functions read ONLY trip_members / circle_memberships and
 * message_thread_members. They never read live location, private posts, or GPS.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function syncTripChatMembers(
  tripId: string,
  sc: SupabaseClient,
): Promise<string | null> {
  const now = new Date().toISOString();

  // 1. Resolve or create the trip thread (idempotent).
  const { data: existing } = await sc
    .from('message_threads')
    .select('id, title')
    .eq('trip_id', tripId)
    .eq('thread_type', 'trip')
    .maybeSingle();

  let threadId: string;

  if (existing) {
    threadId = (existing as any).id;
  } else {
    const { data: trip } = await sc
      .from('trips')
      .select('title, destination_city')
      .eq('id', tripId)
      .maybeSingle();

    const title = trip
      ? `${(trip as any).title}${(trip as any).destination_city ? ` · ${(trip as any).destination_city}` : ''}`
      : 'Trip Chat';

    const { data: created, error: cErr } = await sc
      .from('message_threads')
      .insert({
        thread_type: 'trip',
        trip_id: tripId,
        title,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();

    if (cErr || !created) return null;
    threadId = (created as any).id;
  }

  // 2. Read currently-accepted trip members.
  const { data: acceptedRows } = await sc
    .from('trip_members')
    .select('user_id, role')
    .eq('trip_id', tripId)
    .in('role', ['owner', 'member']);

  const accepted = (acceptedRows ?? []) as Array<{ user_id: string; role: string }>;
  const acceptedIds = new Set(accepted.map((r) => r.user_id));

  // 3. Read current thread members (including those who already left).
  const { data: currentMembers } = await sc
    .from('message_thread_members')
    .select('user_id, left_at, role')
    .eq('thread_id', threadId);

  const currentById = new Map(
    ((currentMembers ?? []) as any[]).map((m) => [m.user_id, m]),
  );

  // 4. Upsert accepted members (restore if they had left_at set).
  for (const { user_id, role } of accepted) {
    const existing = currentById.get(user_id);
    if (!existing) {
      const { error: insErr } = await sc.from('message_thread_members').insert({
        thread_id: threadId,
        user_id,
        role,
        joined_at: now,
        left_at: null,
      });
      if (insErr) {
        console.error(`syncTripChatMembers: member insert failed for trip ${tripId}: ${insErr.message}`);
        return null;
      }
    } else if (existing.left_at !== null || existing.role !== role) {
      const { error: updErr } = await sc
        .from('message_thread_members')
        .update({ left_at: null, role })
        .eq('thread_id', threadId)
        .eq('user_id', user_id);
      if (updErr) {
        console.error(`syncTripChatMembers: member restore failed for trip ${tripId}: ${updErr.message}`);
        return null;
      }
    }
  }

  // 5. Set left_at for members no longer accepted.
  for (const [user_id, m] of currentById.entries()) {
    if (!acceptedIds.has(user_id) && m.left_at === null) {
      const { error: leaveErr } = await sc
        .from('message_thread_members')
        .update({ left_at: now })
        .eq('thread_id', threadId)
        .eq('user_id', user_id);
      if (leaveErr) {
        console.error(`syncTripChatMembers: member removal failed for trip ${tripId}: ${leaveErr.message}`);
        return null;
      }
    }
  }

  return threadId;
}

export async function syncCircleChatMembers(
  circleOwnerId: string,
  sc: SupabaseClient,
): Promise<string | null> {
  const now = new Date().toISOString();

  // 1. Resolve or create the circle thread.
  const { data: existing } = await sc
    .from('message_threads')
    .select('id')
    .eq('circle_owner_id', circleOwnerId)
    .eq('thread_type', 'circle')
    .maybeSingle();

  let threadId: string;

  if (existing) {
    threadId = (existing as any).id;
  } else {
    const { data: ownerProfile } = await sc
      .from('profiles')
      .select('name, handle')
      .eq('id', circleOwnerId)
      .maybeSingle();

    const title = ownerProfile
      ? `${(ownerProfile as any).name ?? (ownerProfile as any).handle ?? 'Circle'}'s Trusted Circle`
      : 'Trusted Circle';

    const { data: created, error: cErr } = await sc
      .from('message_threads')
      .insert({
        thread_type: 'circle',
        circle_owner_id: circleOwnerId,
        title,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();

    if (cErr || !created) return null;
    threadId = (created as any).id;
  }

  // 2. Read accepted circle members (owner + members of owner's circle).
  const { data: memberRows } = await sc
    .from('circle_memberships')
    .select('other_id')
    .eq('user_id', circleOwnerId);

  const memberIds = ((memberRows ?? []) as any[]).map((r) => r.other_id);

  const acceptedSet = new Set([circleOwnerId, ...memberIds]);
  const allAccepted = [
    { user_id: circleOwnerId, role: 'owner' },
    ...memberIds.map((id) => ({ user_id: id, role: 'member' })),
  ];

  // 3. Read current thread members.
  const { data: currentMembers } = await sc
    .from('message_thread_members')
    .select('user_id, left_at, role')
    .eq('thread_id', threadId);

  const currentById = new Map(
    ((currentMembers ?? []) as any[]).map((m) => [m.user_id, m]),
  );

  // 4. Upsert accepted members.
  for (const { user_id, role } of allAccepted) {
    const ex = currentById.get(user_id);
    if (!ex) {
      const { error: insErr } = await sc.from('message_thread_members').insert({
        thread_id: threadId,
        user_id,
        role,
        joined_at: now,
        left_at: null,
      });
      if (insErr) {
        console.error(`syncCircleChatMembers: member insert failed for circle ${circleOwnerId}: ${insErr.message}`);
        return null;
      }
    } else if (ex.left_at !== null || ex.role !== role) {
      const { error: updErr } = await sc
        .from('message_thread_members')
        .update({ left_at: null, role })
        .eq('thread_id', threadId)
        .eq('user_id', user_id);
      if (updErr) {
        console.error(`syncCircleChatMembers: member restore failed for circle ${circleOwnerId}: ${updErr.message}`);
        return null;
      }
    }
  }

  // 5. Remove members no longer in the accepted set.
  for (const [user_id, m] of currentById.entries()) {
    if (!acceptedSet.has(user_id) && m.left_at === null) {
      const { error: leaveErr } = await sc
        .from('message_thread_members')
        .update({ left_at: now })
        .eq('thread_id', threadId)
        .eq('user_id', user_id);
      if (leaveErr) {
        console.error(`syncCircleChatMembers: member removal failed for circle ${circleOwnerId}: ${leaveErr.message}`);
        return null;
      }
    }
  }

  return threadId;
}
