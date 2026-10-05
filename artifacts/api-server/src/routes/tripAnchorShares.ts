/**
 * Trips §14.1 private anchors — the owner's per-anchor grants (census-trips
 * TR256; owner decision 2026-10-04: "Owner-only by default. The owner can share
 * an individual anchor with selected trip members; trip membership or
 * organizer status alone does not grant access.").
 *
 *   GET    /trips/:tripId/anchors/:itemId/shares            who it is shared with
 *   POST   /trips/:tripId/anchors/:itemId/shares            { memberId } → grant
 *   DELETE /trips/:tripId/anchors/:itemId/shares/:memberId  revoke
 *
 * All three answer to the anchor's OWNER (the plan item's creator) and to
 * nobody else — not the trip owner, not a co-host. The member must be an
 * accepted member of the same trip, and never the owner.
 *
 * GATING. Granting needs `trip_private_anchor_sharing_enabled` (seeded FALSE by
 * migration 3970): OFF, absent or unreadable answers 404 feature_disabled and
 * writes nothing. Listing and REVOKING work with the flag off — a person must
 * always be able to see and take back what they gave, and a retraction is never
 * refused (the same rule census-telegraph §42 applies to unsend).
 *
 * Every read binds its error: an unreadable membership, item or grant list is
 * 503 degraded_unavailable, never "not found" and never "shared with nobody".
 * A write's result is read back before the answer claims it.
 */
import { Router, type Request, type Response } from "express";

import { requireUser, requireTripMember, sendError, TripAccessUnavailableError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { isAbsentTableError } from "../lib/absentTableError.js";
import { ownsShareableAnchor, PRIVATE_ANCHOR_SHARE_MAX } from "../domain/trips/policies/privateAnchorAccess.js";
import { anchorSharingOn, readAnchorGrantees } from "../server/trips/privateAnchorShares.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNREADABLE = "We could not check this place's sharing right now. Please try again shortly.";

type Sc = NonNullable<ReturnType<typeof getServiceClient>>;

/** The anchor as the ownership rule needs it, or why it could not be read. */
async function readAnchor(sc: Sc, itemId: string) {
  const { data, error } = await sc
    .from("trip_plan_items")
    .select("id, trip_id, creator_id, location_is_private, removed_at")
    .eq("id", itemId)
    .maybeSingle();
  if (error) return { ok: false as const };
  return { ok: true as const, item: (data ?? null) as { trip_id: string; creator_id: string | null; location_is_private: boolean | null; removed_at: string | null } | null };
}

/**
 * The common gate: a signed-in, accepted member of the trip who OWNS this
 * private anchor. Returns the service client, or null after answering.
 */
async function ownerGate(req: Request, res: Response): Promise<{ sc: Sc; userId: string; tripId: string; itemId: string } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { tripId, itemId } = req.params as { tripId: string; itemId: string };
  if (!UUID_RE.test(tripId) || !UUID_RE.test(itemId)) { sendError(res, "invalid_payload", "Invalid id"); return null; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return null; }
  try {
    const membership = await requireTripMember(sc, tripId, auth.user.id);
    if (!membership) { sendError(res, "forbidden", "Not a trip member"); return null; }
  } catch (e) {
    if (e instanceof TripAccessUnavailableError) { sendError(res, "degraded_unavailable", UNREADABLE); return null; }
    throw e;
  }
  const anchor = await readAnchor(sc, itemId);
  if (!anchor.ok) { sendError(res, "degraded_unavailable", UNREADABLE); return null; }
  const own = ownsShareableAnchor(auth.user.id, tripId, anchor.item);
  if (!own.ok) { sendError(res, own.code, own.message); return null; }
  return { sc, userId: auth.user.id, tripId, itemId };
}

async function answerGrantees(res: Response, sc: Sc, itemId: string, status = 200): Promise<void> {
  const read = await readAnchorGrantees(sc, itemId);
  if (!read.ok) { sendError(res, "degraded_unavailable", UNREADABLE); return; }
  const sharingEnabled = await anchorSharingOn(sc);
  res.status(status).json({ ok: true, sharingEnabled, memberIds: read.memberIds });
}

router.get("/trips/:tripId/anchors/:itemId/shares", asyncHandler(async (req, res) => {
  const g = await ownerGate(req, res);
  if (!g) return;
  await answerGrantees(res, g.sc, g.itemId);
}));

router.post("/trips/:tripId/anchors/:itemId/shares", asyncHandler(async (req, res) => {
  const g = await ownerGate(req, res);
  if (!g) return;
  if (!(await anchorSharingOn(g.sc))) { sendError(res, "feature_disabled", "Sharing private places is not available yet"); return; }

  const memberId = typeof req.body?.memberId === "string" ? req.body.memberId : "";
  if (!UUID_RE.test(memberId)) { sendError(res, "invalid_payload", "memberId must be a trip member's id"); return; }
  if (memberId === g.userId) { sendError(res, "invalid_payload", "You can already see your own place"); return; }
  try {
    const member = await requireTripMember(g.sc, g.tripId, memberId);
    if (!member) { sendError(res, "invalid_payload", "That person is not a member of this trip"); return; }
  } catch (e) {
    if (e instanceof TripAccessUnavailableError) { sendError(res, "degraded_unavailable", UNREADABLE); return; }
    throw e;
  }

  const current = await readAnchorGrantees(g.sc, g.itemId);
  if (!current.ok) { sendError(res, "degraded_unavailable", UNREADABLE); return; }
  if (current.tableAbsent) { sendError(res, "degraded_unavailable", "Sharing private places is not available on this server yet"); return; }
  if (!current.memberIds.includes(memberId) && current.memberIds.length >= PRIVATE_ANCHOR_SHARE_MAX) {
    sendError(res, "invalid_payload", `A private place can be shared with at most ${PRIVATE_ANCHOR_SHARE_MAX} people`);
    return;
  }

  const { error } = await g.sc
    .from("trip_private_anchor_shares")
    .upsert(
      { plan_item_id: g.itemId, trip_id: g.tripId, owner_id: g.userId, member_id: memberId },
      { onConflict: "plan_item_id,member_id", ignoreDuplicates: true },
    );
  if (error) {
    req.log?.warn?.({ err: error, tripId: g.tripId, itemId: g.itemId }, "private anchor grant refused");
    sendError(res, "degraded_unavailable", "We could not share this place right now. Please try again shortly.");
    return;
  }
  // The answer is the grant list READ BACK, not the request echoed.
  await answerGrantees(res, g.sc, g.itemId, 201);
}));

/**
 * The revoke gate (census-trips §81.3): the caller created the item, and the
 * item belongs to this trip. NOTHING ELSE can refuse a retraction — not the
 * item having been made public or removed, not the caller having left the trip,
 * not the sharing flag. Wave 1 used the grant gate here, so a grant on an item
 * made public, removed, or owned by someone who had left could not be taken back.
 */
async function revokeGate(req: Request, res: Response): Promise<{ sc: Sc; userId: string; tripId: string; itemId: string } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { tripId, itemId } = req.params as { tripId: string; itemId: string };
  if (!UUID_RE.test(tripId) || !UUID_RE.test(itemId)) { sendError(res, "invalid_payload", "Invalid id"); return null; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return null; }
  const anchor = await readAnchor(sc, itemId);
  if (!anchor.ok) { sendError(res, "degraded_unavailable", UNREADABLE); return null; }
  if (!anchor.item || anchor.item.trip_id !== tripId) { sendError(res, "not_found", "That place is not on this trip"); return null; }
  if (anchor.item.creator_id !== auth.user.id) { sendError(res, "forbidden", "Only the person who added a private place can stop sharing it"); return null; }
  return { sc, userId: auth.user.id, tripId, itemId };
}

router.delete("/trips/:tripId/anchors/:itemId/shares/:memberId", asyncHandler(async (req, res) => {
  const g = await revokeGate(req, res);
  if (!g) return;
  const memberId = String(req.params.memberId ?? "");
  if (!UUID_RE.test(memberId)) { sendError(res, "invalid_payload", "Invalid member id"); return; }
  const { error } = await g.sc
    .from("trip_private_anchor_shares")
    .delete()
    .eq("plan_item_id", g.itemId)
    .eq("member_id", memberId);
  if (error && !isAbsentTableError(error)) {
    req.log?.warn?.({ err: error, tripId: g.tripId, itemId: g.itemId }, "private anchor revoke refused");
    sendError(res, "degraded_unavailable", "We could not stop sharing this place right now. Please try again shortly.");
    return;
  }
  await answerGrantees(res, g.sc, g.itemId);
}));

export default router;
