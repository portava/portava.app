/**
 * SafeReturnPrivacyGuard
 *
 * Guards exact GPS from leaking through Safe Return API responses.
 * All public API shapes must go through stripGPS before sending.
 *
 * Also provides requireSafeReturnRecipient — an Express middleware that
 * verifies a caller is an authorized live-share recipient.
 */
import type { Request, Response, NextFunction } from "express";
import { requireUser, sendError } from "../../lib/http";
import { getServiceClient } from "../../lib/supabase";

// ── GPS stripping ─────────────────────────────────────────────────────────────

/** Fields that must never appear in public Safe Return API responses. */
const GPS_FIELDS = ["lat", "lng", "latitude", "longitude", "coords", "coordinates"] as const;

/**
 * Deeply remove GPS fields from an object.  Safe to call on null/undefined.
 * Returns a new object (does not mutate the original).
 */
export function stripGPS<T extends Record<string, any>>(obj: T): Omit<T, typeof GPS_FIELDS[number]> {
  if (!obj || typeof obj !== "object") return obj;
  const result: any = Array.isArray(obj) ? [] : {};
  for (const key of Object.keys(obj)) {
    if ((GPS_FIELDS as readonly string[]).includes(key)) continue;
    const val = obj[key];
    result[key] = val && typeof val === "object" ? stripGPS(val) : val;
  }
  return result;
}

/**
 * Public-safe session shape: strip GPS and internal metadata.
 * Call this before every session response.
 */
export function toPublicSession(session: Record<string, any>): Record<string, any> {
  return stripGPS({
    id:                   session.id,
    status:               session.status,
    escalationLevel:      session.escalationLevel,
    timerStartAt:         session.timerStartAt,
    timerEndAt:           session.timerEndAt,
    trustedCircleEnabled: session.trustedCircleEnabled,
    liveShareEnabled:     session.liveShareEnabled,
    notifyHostEnabled:    session.notifyHostEnabled,
    notifyTripCrewEnabled:session.notifyTripCrewEnabled,
    planItemId:           session.planItemId,
    tripId:               session.tripId,
    triggerReason:        session.triggerReason,
    emergencyNote:        session.emergencyNote,
    closedAt:             session.closedAt,
    createdAt:            session.createdAt,
    updatedAt:            session.updatedAt,
    // Deliberately excluded: userId (implied by auth), lastSafeConfirmationAt (internal)
  });
}

/**
 * Public-safe contact shape: strip phone/email unless the caller is the owner.
 */
export function toPublicContact(contact: Record<string, any>, isOwner: boolean): Record<string, any> {
  const base: Record<string, any> = {
    id:                     contact.id,
    sessionId:              contact.sessionId,
    contactUserId:          contact.contactUserId,
    contactName:            contact.contactName,
    contactMethod:          contact.contactMethod,
    canReceiveLiveLocation: contact.canReceiveLiveLocation,
    notifiedAt:             contact.notifiedAt,
    acknowledgedAt:         contact.acknowledgedAt,
  };
  // Only expose phone/email to the session owner
  if (isOwner) {
    base.contactPhone = contact.contactPhone;
    base.contactEmail = contact.contactEmail;
  }
  return base;
}

// ── requireSafeReturnRecipient middleware ─────────────────────────────────────

/**
 * Express middleware that verifies the authenticated user is an authorized
 * recipient of the live share identified by req.params.shareId.
 *
 * On success: attaches { shareId, callerUserId, db } to req.safeReturnRecipient.
 * On failure: sends the appropriate error response and calls next() without
 * setting the attachment (route should guard on its absence).
 *
 * Use on: GET /api/safe-return/live-share/:shareId
 */
export async function requireSafeReturnRecipient(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = await requireUser(req, res);
  if (!auth) return; // requireUser already sent the error

  const shareId = req.params.shareId;
  if (!shareId) {
    sendError(res, "invalid_payload", "shareId is required");
    return;
  }

  const db = getServiceClient() ?? (auth as any).client;
  if (!db) {
    sendError(res, "server_not_configured");
    return;
  }

  const { data: share } = await db
    .from("safe_return_live_shares")
    .select("id, user_id, recipient_user_id, recipient_contact_id, status, expires_at")
    .eq("id", shareId)
    .maybeSingle();

  if (!share) {
    sendError(res, "not_found", "Live share not found");
    return;
  }

  const s = share as any;

  // Hard expiry check
  if (s.expires_at && new Date(s.expires_at) < new Date()) {
    sendError(res, "not_found", "Live share has expired");
    return;
  }

  if (s.status !== "active") {
    sendError(res, "not_found", "Live share is no longer active");
    return;
  }

  // Strict recipient-only check — the sharer accesses their own share data
  // through the session endpoints, not this recipient-view endpoint.
  if (s.recipient_user_id !== auth.user.id) {
    sendError(res, "forbidden", "You are not an authorized recipient of this share");
    return;
  }

  // Attach to request for route handler
  (req as any).safeReturnRecipient = {
    shareId,
    callerUserId: auth.user.id,
    db,
    share: s,
  };

  next();
}
