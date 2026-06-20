/**
 * Pure decision logic for friend requests and related actions.
 * No I/O — import and unit-test without any DB or HTTP setup.
 */

export type FriendStatus = 'none' | 'outgoing_pending' | 'incoming_pending' | 'friends' | 'self';

export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** Caller wants to send a friend request. */
export function decideSendRequest(
  requesterId: string,
  recipientId: string,
): { ok: true } | { ok: false; reason: string } {
  if (requesterId === recipientId)
    return { ok: false, reason: 'You cannot send a friend request to yourself' };
  return { ok: true };
}

/** Caller wants to accept a request. Only the recipient may accept. */
export function decideAcceptRequest(
  callerId: string,
  recipientId: string,
): { ok: true } | { ok: false; reason: string } {
  if (callerId !== recipientId)
    return { ok: false, reason: 'Only the recipient can accept this request' };
  return { ok: true };
}

/** Caller wants to decline a request. Only the recipient may decline. */
export function decideDeclineRequest(
  callerId: string,
  recipientId: string,
): { ok: true } | { ok: false; reason: string } {
  if (callerId !== recipientId)
    return { ok: false, reason: 'Only the recipient can decline this request' };
  return { ok: true };
}

/** Caller wants to cancel an outgoing request. Only the requester may cancel. */
export function decideCancelRequest(
  callerId: string,
  requesterId: string,
): { ok: true } | { ok: false; reason: string } {
  if (callerId !== requesterId)
    return { ok: false, reason: 'Only the requester can cancel this request' };
  return { ok: true };
}

/**
 * Produce the normalized (user_a, user_b) pair for user_friendships.
 * Deterministic: the same pair in any order always gives the same row key.
 */
export function normalizedFriendshipPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
