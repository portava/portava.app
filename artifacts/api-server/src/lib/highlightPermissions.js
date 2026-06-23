"use strict";
/**
 * Highlight permission helpers.
 * Pure functions — no DB calls. Blocks are checked separately at the route level
 * using the `is_blocked` DB function.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isHighlightActive = isHighlightActive;
exports.canViewHighlight = canViewHighlight;
exports.canEngageHighlight = canEngageHighlight;
/** Is the highlight currently active (not expired and not deleted)? */
function isHighlightActive(h) {
    if (h.deleted_at != null)
        return false;
    return new Date(h.expires_at) > new Date();
}
/**
 * Can `viewerId` view this highlight?
 *
 * Rules (blocks are NOT checked here — callers must exclude blocked users before calling):
 *   - Expired or deleted → never
 *   - Owner → always
 *   - public | travelers_nearby → any authenticated user
 *   - circle_only → viewerId must be in the owner's follower set (checked by caller)
 *   - trip_only → viewerId must share a trip with the owner (checked by caller)
 *   - private → owner only
 *
 * @param viewerFollowsOwner  Pass true when the viewer follows the owner (circle check).
 * @param sharesTrip          Pass true when the viewer and owner share a trip.
 */
function canViewHighlight(viewerId, h, opts) {
    if (opts === void 0) { opts = {}; }
    if (!isHighlightActive(h))
        return false;
    if (viewerId === h.owner_id)
        return true;
    switch (h.visibility) {
        case "public":
        case "travelers_nearby":
            return true;
        case "circle_only":
            return opts.viewerFollowsOwner === true;
        case "trip_only":
            return opts.sharesTrip === true;
        case "private":
            return false;
        default:
            return false;
    }
}
/**
 * Can `userId` perform the given engagement action on a highlight?
 * Blocks are NOT checked here.
 */
function canEngageHighlight(userId, h, action, viewerCanView) {
    if (!viewerCanView)
        return false;
    if (action === "report")
        return userId !== h.owner_id;
    return true;
}
