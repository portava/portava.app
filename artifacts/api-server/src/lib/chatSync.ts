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
// Telegraph §13.2 `member.joined` — census T185 measured both sync paths as
// silent to open clients.
import { publishToThread } from './telegraphEvents.js';

export async function syncTripChatMembers(
  tripId: string,
  sc: SupabaseClient,
): Promise<string | null> {
  const now = new Date().toISOString();

  // 1. Resolve or create the trip thread (idempotent).
  //
  // The read must be checked: supabase-js resolves a failed read as
  // `{ data: null }`, which is indistinguishable here from "no thread yet". Read
  // that way, the else-branch INSERTs a second 'trip' thread for a trip that
  // already has one — and this function then upserts every accepted member into
  // the new row, so the crew's chat history stays on the orphaned thread. Fail
  // closed with the null this function already uses for "could not sync".
  const { data: existing, error: existingErr } = await sc
    .from('message_threads')
    .select('id, title')
    .eq('trip_id', tripId)
    .eq('thread_type', 'trip')
    .maybeSingle();

  if (existingErr) {
    console.error(`syncTripChatMembers: thread lookup failed for trip ${tripId}: ${existingErr.message}`);
    return null;
  }

  let threadId: string;

  if (existing) {
    threadId = (existing as any).id;
  } else {
    // ── A DURABLE TITLE MUST NOT COME FROM A READ THAT NEVER HAPPENED ────────
    // census T344/T363, §17.8 item 2, §18.4. supabase-js RESOLVES on a database
    // failure, so a dropped error arrived here as `data: null` — which this
    // branch read as "the trip has no title" and wrote `'Trip Chat'` onto a row
    // it is about to INSERT. That is the worst consequence in this class and
    // §18.4 says why: unlike a 404, it does not go away when the outage does.
    // The thread keeps the generic title for the life of the trip, nothing
    // logs, and no later healthy sync revisits it — the create branch runs
    // once.
    //
    // Refuse with the `null` this function already uses for "could not sync",
    // which every caller already handles. A trip row that is genuinely absent
    // is a different world and still gets the generic title below.
    const { data: trip, error: tripErr } = await sc
      .from('trips')
      .select('title, destination_city')
      .eq('id', tripId)
      .maybeSingle();

    if (tripErr) {
      console.error(
        `syncTripChatMembers: trip read failed for trip ${tripId}: ${tripErr.message} ` +
          `— refusing to create a thread whose DURABLE title would be a generic guess`,
      );
      return null;
    }

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
  //
  // ── AN UNREADABLE ROSTER IS NOT AN EMPTY ROSTER ────────────────────────────
  // census T344/T363. This read is the INPUT to step 5, which sets
  // `left_at = now()` for every thread member not in the accepted set. With the
  // error dropped, supabase-js resolved an unreadable `trip_members` as
  // `data: null`, `?? []` made it "this trip has no accepted members", and step
  // 5 evicted THE ENTIRE CREW — owner included — from their own chat. That is
  // not a plausible empty read; it is a destructive write driven by a read that
  // never happened.
  //
  // And it does not heal. Step 4 clears `left_at` only when the trip ROLE
  // CHANGED, deliberately (see its comment): a member with `left_at` set is
  // presumed to have left of their own accord. So every subsequent HEALTHY sync
  // reads an evicted crew and leaves it evicted, and each member is answered
  // 403 "Not a member of this thread" on a conversation they never left.
  //
  // Refusing with `null` — the value this function already uses for "could not
  // sync", which every caller already handles — is the only answer the evidence
  // supports: we do not know who belongs in this thread, so we change nothing.
  const { data: acceptedRows, error: acceptedErr } = await sc
    .from('trip_members')
    .select('user_id, role')
    .eq('trip_id', tripId)
    .in('role', ['owner', 'member']);

  if (acceptedErr) {
    console.error(
      `syncTripChatMembers: accepted-member read failed for trip ${tripId}: ${acceptedErr.message} ` +
        `— refusing to reconcile rather than evicting a crew this read could not see`,
    );
    return null;
  }

  const accepted = (acceptedRows ?? []) as Array<{ user_id: string; role: string }>;
  const acceptedIds = new Set(accepted.map((r) => r.user_id));

  // 3. Read current thread members (including those who already left).
  //
  // Dropped, this read fails in BOTH directions at once: an unreadable roster
  // looks like a thread with no members, so step 4 re-INSERTS every accepted
  // member (a duplicate row, or a unique-violation for the whole sync) and step
  // 5 removes nobody, so a member the trip really removed keeps thread access
  // with nothing said. Same refusal as above.
  const { data: currentMembers, error: currentErr } = await sc
    .from('message_thread_members')
    .select('user_id, left_at, role')
    .eq('thread_id', threadId);

  if (currentErr) {
    console.error(
      `syncTripChatMembers: thread roster read failed for trip ${tripId}: ${currentErr.message} ` +
        `— refusing to reconcile against a roster this read could not see`,
    );
    return null;
  }

  const currentById = new Map(
    ((currentMembers ?? []) as any[]).map((m) => [m.user_id, m]),
  );

  // 4. Upsert accepted members (restore if they had left_at set).
  //
  // Telegraph §13.2 `member.joined` (census T185): this loop already KNOWS who
  // is new — `currentById` is the roster as it was before any write — so the
  // event is emitted exactly where the newcomer is created, and only for a row
  // whose insert SUCCEEDED. There are two sync implementations in this tree
  // (this one and `services/groupChatSync.ts`, reached from different routes),
  // and both emit, because an event that fires on one of two paths is worse
  // than one that fires on neither: a client would learn to trust it.
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
      void publishToThread(sc, threadId, {
        type: 'member.joined',
        payload: { userId: user_id, source: 'trip_sync', tripId, joinedAt: now },
      });
    } else if (existing.role !== role) {
      // Only restore (clear left_at) when the trip role actually changed.
      // A member whose role is unchanged but who has left_at set chose to leave
      // the chat themselves — do NOT force-rejoin them on every sync.
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
  // Same failure mode as the trip branch above — an unreadable message_threads
  // must not be mistaken for "this circle has no thread yet".
  const { data: existing, error: existingErr } = await sc
    .from('message_threads')
    .select('id')
    .eq('circle_owner_id', circleOwnerId)
    .eq('thread_type', 'circle')
    .maybeSingle();

  if (existingErr) {
    console.error(`syncCircleChatMembers: thread lookup failed for circle ${circleOwnerId}: ${existingErr.message}`);
    return null;
  }

  let threadId: string;

  if (existing) {
    threadId = (existing as any).id;
  } else {
    // Same rule as the trip branch, same reason: this title is INSERTed and
    // never revisited, so an unreadable `profiles` would name the owner's own
    // circle `'Trusted Circle'` permanently. §17.8 item 2 named the two `trips`
    // reads; these two `profiles` reads are the same defect in the circle half
    // of the same two functions, and closing one group without the other would
    // leave the class open by exactly the shape it was closed for.
    const { data: ownerProfile, error: ownerProfileErr } = await sc
      .from('profiles')
      .select('name, handle')
      .eq('id', circleOwnerId)
      .maybeSingle();

    if (ownerProfileErr) {
      console.error(
        `syncCircleChatMembers: owner profile read failed for circle ${circleOwnerId}: ` +
          `${ownerProfileErr.message} — refusing to create a thread whose DURABLE title would be a generic guess`,
      );
      return null;
    }

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
  //
  // Same rule as the trip branch: this is the input to step 5, and an
  // unreadable `circle_memberships` read as an empty circle evicts every member
  // but the owner. The circle branch does restore on the next healthy sync
  // (step 4 here clears `left_at`, which the trip branch does not) — but a
  // recoverable eviction is still an eviction, and between the two syncs every
  // member is told they are not in a circle chat they never left.
  const { data: memberRows, error: memberErr } = await sc
    .from('circle_memberships')
    .select('other_id')
    .eq('user_id', circleOwnerId);

  if (memberErr) {
    console.error(
      `syncCircleChatMembers: circle member read failed for circle ${circleOwnerId}: ${memberErr.message} ` +
        `— refusing to reconcile rather than evicting members this read could not see`,
    );
    return null;
  }

  const memberIds = ((memberRows ?? []) as any[]).map((r) => r.other_id);

  const acceptedSet = new Set([circleOwnerId, ...memberIds]);
  const allAccepted = [
    { user_id: circleOwnerId, role: 'owner' },
    ...memberIds.map((id) => ({ user_id: id, role: 'member' })),
  ];

  // 3. Read current thread members. Refused for the same reason as the trip
  // branch's step 3.
  const { data: currentMembers, error: currentErr } = await sc
    .from('message_thread_members')
    .select('user_id, left_at, role')
    .eq('thread_id', threadId);

  if (currentErr) {
    console.error(
      `syncCircleChatMembers: thread roster read failed for circle ${circleOwnerId}: ${currentErr.message} ` +
        `— refusing to reconcile against a roster this read could not see`,
    );
    return null;
  }

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
      // Telegraph §13.2 `member.joined` — see the trip branch above.
      void publishToThread(sc, threadId, {
        type: 'member.joined',
        payload: { userId: user_id, source: 'circle_sync', circleOwnerId, joinedAt: now },
      });
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
