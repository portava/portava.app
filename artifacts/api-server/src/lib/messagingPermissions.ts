/**
 * canMessage — messaging permission resolver.
 *
 * Accepts (supabaseServiceClient, senderId, recipientId) and returns a
 * MessagePermissionVerdict describing whether the sender may open a direct
 * thread, must send a message request first, or is blocked entirely.
 *
 * HARD RULES:
 *   - Cannot message self → denied.
 *   - Blocked in EITHER direction → denied. (Enforced below against the `blocks`
 *     table via the service-role client; the stale "TODO: plug in block table"
 *     that used to sit on this line was wrong — the check has been live since
 *     the mutual-block query was added.)
 *   - recipient.message_privacy = 'no_one' → denied.
 *   - 'friends' → allowed only if mutual friendship exists.
 *   - 'followers' → allowed only if the recipient follows the sender.
 *   - 'following' → allowed only if the sender follows the recipient.
 *   - 'trip_members' → allowed if allow_trip_member_messages=true AND shared trip.
 *   - 'everyone' → directly allowed.
 *   - Trip/circle overrides are checked independently and can elevate to direct.
 *   - If not directly allowed and allow_message_requests=true → requires_request.
 *   - Otherwise → denied.
 *
 * Follow alone does NOT grant direct messaging unless message_privacy='following'
 * or 'everyone'.  No private posts, trips, location, or circle data is exposed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type MessageVerdict = 'allowed' | 'requires_request' | 'denied';

export type MessageDeniedReason =
  | 'self'
  | 'blocked'
  | 'no_one'
  | 'privacy_setting'
  | 'no_requests_allowed';

export interface RelationshipContext {
  isFriend: boolean;
  senderFollowsRecipient: boolean;
  recipientFollowsSender: boolean;
  sharedTrip: boolean;
  sharedCircle: boolean;
}

export interface MessagePermissionVerdict {
  allowed: boolean;
  verdict: MessageVerdict;
  reason?: MessageDeniedReason;
  relationship_context: RelationshipContext;
}

interface MessageSettings {
  message_privacy: string;
  allow_message_requests: boolean;
  allow_trip_member_messages: boolean;
  allow_circle_member_messages: boolean;
}

const DEFAULT_SETTINGS: MessageSettings = {
  message_privacy: 'everyone',
  allow_message_requests: true,
  allow_trip_member_messages: true,
  allow_circle_member_messages: true,
};

function deny(
  reason: MessageDeniedReason,
  ctx: RelationshipContext,
): MessagePermissionVerdict {
  return { allowed: false, verdict: 'denied', reason, relationship_context: ctx };
}

function allow(ctx: RelationshipContext): MessagePermissionVerdict {
  return { allowed: true, verdict: 'allowed', relationship_context: ctx };
}

function requiresRequest(ctx: RelationshipContext): MessagePermissionVerdict {
  return { allowed: false, verdict: 'requires_request', relationship_context: ctx };
}

export async function canMessage(
  sc: SupabaseClient,
  senderId: string,
  recipientId: string,
): Promise<MessagePermissionVerdict> {
  const emptyCtx: RelationshipContext = {
    isFriend: false,
    senderFollowsRecipient: false,
    recipientFollowsSender: false,
    sharedTrip: false,
    sharedCircle: false,
  };

  if (senderId === recipientId) return deny('self', emptyCtx);

  // Block check — sc is the service-role client so it bypasses RLS and can
  // read blocks rows regardless of which user is blocker_id.
  const { data: blockRow } = await sc
    .from('blocks')
    .select('blocker_id')
    .or(`and(blocker_id.eq.${senderId},blocked_id.eq.${recipientId}),and(blocker_id.eq.${recipientId},blocked_id.eq.${senderId})`)
    .limit(1)
    .maybeSingle();
  if (blockRow) return deny('blocked', emptyCtx);

  // Fetch all relationship data in parallel.
  // Trip check uses a two-step query (wrapped in an async closure) so it can
  // run in parallel with the rest while keeping the steps sequential internally.
  // This replaces the earlier `shared_trip_members` RPC which is not guaranteed
  // to exist at migration time.
  const [settingsRes, friendshipRes, sfRes, rfRes, sharedTrip, circleRes] = await Promise.all([
    // Recipient's message settings (or null → use defaults).
    // NOTE: caller must pass a service-role client; user-scoped client cannot
    // read another user's settings due to RLS policy ums_select_own.
    sc
      .from('user_message_settings')
      .select('message_privacy, allow_message_requests, allow_trip_member_messages, allow_circle_member_messages')
      .eq('user_id', recipientId)
      .maybeSingle(),

    // Mutual friendship (normalized pair).
    sc
      .from('user_friendships')
      .select('user_a')
      .or(
        `and(user_a.eq.${senderId < recipientId ? senderId : recipientId},user_b.eq.${senderId < recipientId ? recipientId : senderId})`,
      )
      .maybeSingle(),

    // Does sender follow recipient?
    sc
      .from('user_follows')
      .select('follower_id')
      .eq('follower_id', senderId)
      .eq('following_id', recipientId)
      .maybeSingle(),

    // Does recipient follow sender?
    sc
      .from('user_follows')
      .select('follower_id')
      .eq('follower_id', recipientId)
      .eq('following_id', senderId)
      .maybeSingle(),

    // Shared accepted trip membership — direct two-step query, no RPC needed.
    (async (): Promise<boolean> => {
      const { data: senderTrips } = await sc
        .from('trip_members')
        .select('trip_id')
        .eq('user_id', senderId)
        .in('role', ['owner', 'member']);
      const ids = (senderTrips ?? []).map((m: any) => m.trip_id);
      if (ids.length === 0) return false;
      const { data: shared } = await sc
        .from('trip_members')
        .select('trip_id')
        .eq('user_id', recipientId)
        .in('role', ['owner', 'member'])
        .in('trip_id', ids)
        .limit(1)
        .maybeSingle();
      return Boolean(shared);
    })(),

    // Shared circle: sender is in recipient's circle OR recipient is in sender's circle.
    sc
      .from('circle_memberships')
      .select('user_id')
      .or(`and(user_id.eq.${recipientId},other_id.eq.${senderId}),and(user_id.eq.${senderId},other_id.eq.${recipientId})`)
      .limit(1)
      .maybeSingle(),
  ]);

  const settings: MessageSettings =
    settingsRes.data
      ? {
          message_privacy: (settingsRes.data as any).message_privacy ?? 'everyone',
          allow_message_requests: (settingsRes.data as any).allow_message_requests ?? true,
          allow_trip_member_messages: (settingsRes.data as any).allow_trip_member_messages ?? true,
          allow_circle_member_messages: (settingsRes.data as any).allow_circle_member_messages ?? true,
        }
      : DEFAULT_SETTINGS;

  const ctx: RelationshipContext = {
    isFriend: Boolean(friendshipRes.data),
    senderFollowsRecipient: Boolean(sfRes.data),
    recipientFollowsSender: Boolean(rfRes.data),
    sharedTrip,
    sharedCircle: Boolean(circleRes.data),
  };

  // Hard deny: no_one.
  if (settings.message_privacy === 'no_one') return deny('no_one', ctx);

  // Evaluate primary privacy setting.
  let directlyAllowed = false;
  switch (settings.message_privacy) {
    case 'everyone':
      directlyAllowed = true;
      break;
    case 'friends':
      directlyAllowed = ctx.isFriend;
      break;
    case 'followers':
      // "followers": recipient only accepts messages from their own followers.
      // A follower of the recipient is someone whose following_id = recipient.id
      // → sender follows recipient = senderFollowsRecipient.
      directlyAllowed = ctx.senderFollowsRecipient;
      break;
    case 'following':
      // "following": recipient only accepts messages from people they follow.
      // The recipient follows the sender = recipientFollowsSender.
      directlyAllowed = ctx.recipientFollowsSender;
      break;
    case 'trip_members':
      directlyAllowed = settings.allow_trip_member_messages && ctx.sharedTrip;
      break;
    default:
      directlyAllowed = false;
  }

  // Trip/circle overrides — can elevate to direct even if primary setting denies.
  if (!directlyAllowed && settings.allow_trip_member_messages && ctx.sharedTrip) {
    directlyAllowed = true;
  }
  if (!directlyAllowed && settings.allow_circle_member_messages && ctx.sharedCircle) {
    directlyAllowed = true;
  }

  if (directlyAllowed) return allow(ctx);

  // Not directly allowed — can a request be sent?
  if (settings.allow_message_requests) return requiresRequest(ctx);

  return deny('privacy_setting', ctx);
}
