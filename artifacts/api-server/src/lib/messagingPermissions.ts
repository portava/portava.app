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
import { logger as rootLogger } from './logger.js';
import { isUuid } from './followDecisions.js';

const log = rootLogger.child({ lib: 'messagingPermissions' });

export type MessageVerdict = 'allowed' | 'requires_request' | 'denied';

export type MessageDeniedReason =
  | 'self'
  | 'blocked'
  | 'no_one'
  | 'privacy_setting'
  | 'no_requests_allowed'
  /**
   * A read this decision depends on FAILED, so permission is unknown.
   *
   * Deliberately distinct from 'blocked': saying "blocked" when the blocks
   * table was merely unreadable would be a fabrication, and a caller that
   * surfaces the reason to a user would show something untrue. 'unavailable'
   * says what actually happened -- we could not decide -- and the answer is
   * still a denial, because the alternative is delivering a message to someone
   * who may have blocked the sender.
   */
  | 'unavailable';

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
  /**
   * At least one RELATIONSHIP read failed, so `relationship_context` is a floor
   * rather than the truth.
   *
   * The relationship reads are inclusion signals: a failed one yields `data:
   * null`, reads as "no such relationship", and can only ever make the verdict
   * MORE restrictive -- so permission stays safe. What is not safe is the
   * context itself, which callers render to people ("you are not connected to
   * this user"). Stating a fact about someone's relationships on the strength of
   * a read that failed is a fabrication, so the degraded case is labelled and a
   * caller may choose to say nothing instead of saying something false.
   */
  degraded?: boolean;
}

interface MessageSettings {
  message_privacy: string;
  allow_message_requests: boolean;
  allow_trip_member_messages: boolean;
  allow_circle_member_messages: boolean;
}

/**
 * Hard cap on the sender's trip list used for the shared-trip check.
 *
 * The list feeds `.in('trip_id', ids)`. PostgREST caps an unbounded collection
 * at db-max-rows (Supabase ships 1000), so without an explicit limit a
 * well-travelled sender's older trips fell off the end and a genuinely shared
 * trip could be missed -- silently, and more often the more they had travelled.
 * Naming the bound makes the truncation point ours and reportable.
 */
const TRIP_SCAN_CAP = 1000;

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

  // Both ids are interpolated RAW into three PostgREST `.or()` filter strings
  // below. A value carrying `,` `)` or `.` does not fail — it re-parses into a
  // DIFFERENT filter, and the one that matters is the block check, where a
  // filter that silently stops matching waves a sender through to someone who
  // blocked them. Every route caller validates the id first, but this resolver
  // is also reachable from the call gateway and from library code, and a guard
  // that lives only in callers is a guard that a future caller forgets. A
  // non-UUID can never name a real account, so refusing here costs nothing.
  for (const [label, id] of [['senderId', senderId], ['recipientId', recipientId]] as const) {
    if (typeof id !== 'string' || !isUuid(id)) {
      log.error({ label, senderId, recipientId }, 'canMessage: non-UUID participant id; refusing rather than building a filter from it');
      return deny('unavailable', emptyCtx);
    }
  }

  // Block check — sc is the service-role client so it bypasses RLS and can
  // read blocks rows regardless of which user is blocker_id.
  const { data: blockRow, error: blockError } = await sc
    .from('blocks')
    .select('blocker_id')
    .or(`and(blocker_id.eq.${senderId},blocked_id.eq.${recipientId}),and(blocker_id.eq.${recipientId},blocked_id.eq.${senderId})`)
    .limit(1)
    .maybeSingle();
  // `blocks` is an EXCLUSION table: a row means DENY. supabase-js resolves on a
  // database error, so an unreadable table returns `data: null` -- identical to
  // "no block exists" -- and this check would wave the sender straight through
  // to someone who blocked them. Unknown is not permission.
  if (blockError) {
    log.error({ err: blockError, senderId, recipientId }, 'canMessage: blocks read failed; denying rather than assuming no block');
    return deny('unavailable', emptyCtx);
  }
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
    (async (): Promise<{ shared: boolean; degraded: boolean }> => {
      const { data: senderTrips, error: senderTripsErr } = await sc
        .from('trip_members')
        .select('trip_id')
        .eq('user_id', senderId)
        .in('role', ['owner', 'member'])
        .limit(TRIP_SCAN_CAP);
      if (senderTripsErr) return { shared: false, degraded: true };
      const ids = (senderTrips ?? []).map((m: any) => m.trip_id);
      if (ids.length === 0) return { shared: false, degraded: false };
      const { data: shared, error: sharedErr } = await sc
        .from('trip_members')
        .select('trip_id')
        .eq('user_id', recipientId)
        .in('role', ['owner', 'member'])
        .in('trip_id', ids)
        .limit(1)
        .maybeSingle();
      if (sharedErr) return { shared: false, degraded: true };
      // A truncated trip list can only DROP a shared trip, i.e. withhold
      // permission the pair may be entitled to; it can never grant permission
      // they are not. Flagged as degraded rather than silently accepted,
      // because "not trip mates" would be asserted on partial evidence.
      return { shared: Boolean(shared), degraded: ids.length >= TRIP_SCAN_CAP };
    })(),

    // Shared circle: sender is in recipient's circle OR recipient is in sender's circle.
    sc
      .from('circle_memberships')
      .select('user_id')
      .or(`and(user_id.eq.${recipientId},other_id.eq.${senderId}),and(user_id.eq.${senderId},other_id.eq.${recipientId})`)
      .limit(1)
      .maybeSingle(),
  ]);

  // The recipient's own privacy setting decides this. An unreadable
  // user_message_settings row previously fell back to DEFAULT_SETTINGS, whose
  // message_privacy is 'everyone' -- so a recipient who had deliberately
  // restricted their DMs became messageable by anyone, precisely while the
  // database was unhealthy. That default is only safe for a recipient who has
  // never set a preference; it is not safe as an error fallback.
  if ((settingsRes as any).error) {
    log.error(
      { err: (settingsRes as any).error, recipientId },
      'canMessage: user_message_settings read failed; denying rather than defaulting to message_privacy=everyone',
    );
    return deny('unavailable', emptyCtx);
  }

  const settings: MessageSettings =
    settingsRes.data
      ? {
          message_privacy: (settingsRes.data as any).message_privacy ?? 'everyone',
          allow_message_requests: (settingsRes.data as any).allow_message_requests ?? true,
          allow_trip_member_messages: (settingsRes.data as any).allow_trip_member_messages ?? true,
          allow_circle_member_messages: (settingsRes.data as any).allow_circle_member_messages ?? true,
        }
      : DEFAULT_SETTINGS;

  // The relationship reads are INCLUSION signals, so a dropped `.error` reads as
  // "no such relationship" and can only ever make the verdict more restrictive.
  // Permission therefore stays safe -- but the failure produced no signal at
  // all, so a friends-only recipient becoming unreachable to their friends
  // during a bad database minute looked exactly like the privacy setting
  // working. Each failure is now named, and the verdict is marked degraded.
  const relationshipReads: Array<[string, { error?: unknown } | null | undefined]> = [
    ['user_friendships', friendshipRes as any],
    ['user_follows(sender→recipient)', sfRes as any],
    ['user_follows(recipient→sender)', rfRes as any],
    ['circle_memberships', circleRes as any],
  ];
  let degraded = sharedTrip.degraded;
  for (const [name, res] of relationshipReads) {
    if (res && (res as any).error) {
      degraded = true;
      log.error(
        { err: (res as any).error, read: name, senderId, recipientId },
        'canMessage: relationship read failed; treated as "no relationship", which withholds permission the pair may be entitled to',
      );
    }
  }
  if (sharedTrip.degraded) {
    log.error({ senderId, recipientId }, 'canMessage: shared-trip check degraded; treated as "no shared trip"');
  }

  const ctx: RelationshipContext = {
    isFriend: Boolean(friendshipRes.data),
    senderFollowsRecipient: Boolean(sfRes.data),
    recipientFollowsSender: Boolean(rfRes.data),
    sharedTrip: sharedTrip.shared,
    sharedCircle: Boolean(circleRes.data),
  };

  const mark = (v: MessagePermissionVerdict): MessagePermissionVerdict =>
    degraded ? { ...v, degraded: true } : v;

  // Hard deny: no_one.
  if (settings.message_privacy === 'no_one') return mark(deny('no_one', ctx));

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

  if (directlyAllowed) return mark(allow(ctx));

  // Not directly allowed — can a request be sent?
  if (settings.allow_message_requests) return mark(requiresRequest(ctx));

  return mark(deny('privacy_setting', ctx));
}
