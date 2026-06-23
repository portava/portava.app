"use strict";
/**
 * Pure decision logic for friend requests and related actions.
 * No I/O — import and unit-test without any DB or HTTP setup.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isUuid = isUuid;
exports.decideSendRequest = decideSendRequest;
exports.decideAcceptRequest = decideAcceptRequest;
exports.decideDeclineRequest = decideDeclineRequest;
exports.decideCancelRequest = decideCancelRequest;
exports.normalizedFriendshipPair = normalizedFriendshipPair;
function isUuid(s) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
/** Caller wants to send a friend request. */
function decideSendRequest(requesterId, recipientId) {
    if (requesterId === recipientId)
        return { ok: false, reason: 'You cannot send a friend request to yourself' };
    return { ok: true };
}
/** Caller wants to accept a request. Only the recipient may accept. */
function decideAcceptRequest(callerId, recipientId) {
    if (callerId !== recipientId)
        return { ok: false, reason: 'Only the recipient can accept this request' };
    return { ok: true };
}
/** Caller wants to decline a request. Only the recipient may decline. */
function decideDeclineRequest(callerId, recipientId) {
    if (callerId !== recipientId)
        return { ok: false, reason: 'Only the recipient can decline this request' };
    return { ok: true };
}
/** Caller wants to cancel an outgoing request. Only the requester may cancel. */
function decideCancelRequest(callerId, requesterId) {
    if (callerId !== requesterId)
        return { ok: false, reason: 'Only the requester can cancel this request' };
    return { ok: true };
}
/**
 * Produce the normalized (user_a, user_b) pair for user_friendships.
 * Deterministic: the same pair in any order always gives the same row key.
 */
function normalizedFriendshipPair(a, b) {
    return a < b ? [a, b] : [b, a];
}
