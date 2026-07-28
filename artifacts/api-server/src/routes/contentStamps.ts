/**
 * Content Stamps — unified stamp API replacing per-entity like endpoints.
 *
 *   POST   /api/stamps                          — stamp an entity
 *   DELETE /api/stamps/:entityType/:entityId    — remove a stamp
 *
 * Both endpoints require authentication and return { stampCount, isStamped }.
 * Stamps fire a "liked" outcome signal into the Compass personalization
 * pipeline (same weight as the strongest prior positive signal).
 *
 * Access control for POST /stamps (post entity type):
 *   1. Post must exist and be status=active.
 *   2. No block between caller and post author in either direction.
 *   3. private visibility → 403; trip_only → caller must be accepted member.
 *
 * DELETE /stamps allows idempotent removal regardless of current entity
 * visibility — same contract as the deprecated unlike endpoints.
 */

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError, isAcceptedTripMember } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { linkOutcomeSignal } from "../compass/CompassOutcomeEngine.js";
import {
  stampEntity,
  unstampEntity,
  STAMPABLE_TYPES,
  type StampableEntityType,
} from "../services/stamps/ContentStampService.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const stampBodySchema = z.object({
  entityType: z.enum(STAMPABLE_TYPES as unknown as [string, ...string[]]),
  entityId: z.string().regex(UUID_RE, "entityId must be a valid UUID"),
});

const router = Router();

// ── Per-entity access guard ────────────────────────────────────────────────────

/**
 * Verify the caller is allowed to stamp a post entity.
 * Sends an error response and returns false on any violation.
 *
 * Checks (in order):
 *  1. Post exists and is active.
 *  2. No block between caller and post author (either direction).
 *  3. Visibility: private → 403; trip_only → accepted member only.
 */
async function verifyPostStampAccess(
  sc: NonNullable<ReturnType<typeof getServiceClient>>,
  userClient: any,
  userId: string,
  postId: string,
  res: any,
): Promise<boolean> {
  // 1. Existence + active status
  const { data: post, error: postErr } = await sc
    .from("posts")
    .select("id, author_id, visibility, trip_id")
    .eq("id", postId)
    .eq("status", "active")
    .maybeSingle();
  if (postErr) { sendError(res, "db_error", postErr.message); return false; }
  if (!post) { sendError(res, "not_found", "Post not found"); return false; }

  const p = post as {
    id: string;
    author_id: string;
    visibility: string;
    trip_id: string | null;
  };

  // 2. Block check (both directions). Skip when the viewer is the author
  //    (self-stamp is allowed; there is nothing to block against).
  if (p.author_id !== userId) {
    const { count: blockCount, error: blockErr } = await sc
      .from("blocks")
      .select("id", { count: "exact", head: true })
      .or(
        `and(blocker_id.eq.${userId},blocked_id.eq.${p.author_id}),` +
        `and(blocker_id.eq.${p.author_id},blocked_id.eq.${userId})`,
      );
    if (blockErr || (blockCount ?? 0) > 0) {
      sendError(res, "blocked_user", "Cannot stamp this post");
      return false;
    }
  }

  // 3. Visibility
  if (p.visibility === "private") {
    sendError(res, "forbidden", "Cannot stamp a private post");
    return false;
  }
  if (p.visibility === "trip_only") {
    if (!p.trip_id || !(await isAcceptedTripMember(userClient, p.trip_id, userId))) {
      sendError(res, "forbidden", "Only accepted trip members can stamp this post");
      return false;
    }
  }

  return true;
}

/**
 * Verify the caller is allowed to stamp a media entity.
 * Mirrors the verifyMediaAccess guard in mediaFeed.ts — existence + block +
 * visibility + self-stamp.  Sends an error response and returns false on any violation.
 */
async function verifyMediaStampAccess(
  sc: NonNullable<ReturnType<typeof getServiceClient>>,
  userId: string,
  mediaId: string,
  res: any,
): Promise<boolean> {
  // ── Try posts first (most media items are Watch-feed posts) ─────────────────
  const { data: postRow } = await sc
    .from("posts")
    .select("id, author_id, status, visibility, trip_id")
    .eq("id", mediaId)
    .maybeSingle();

  if (postRow && (postRow as any).status === "active") {
    const authorId: string = (postRow as any).author_id;
    const visibility: string = (postRow as any).visibility ?? "public";
    const tripId: string | null = (postRow as any).trip_id ?? null;

    // Self-stamp guard — authors cannot stamp their own media (preserve legacy behavior).
    if (authorId === userId) {
      sendError(res, "forbidden", "Cannot stamp your own content");
      return false;
    }

    // Block check (both directions) — fail-closed on error.
    const { count: blockCount, error: blockErr } = await sc
      .from("blocks")
      .select("blocker_id", { count: "exact", head: true })
      .or(
        `and(blocker_id.eq.${userId},blocked_id.eq.${authorId}),` +
        `and(blocker_id.eq.${authorId},blocked_id.eq.${userId})`,
      );
    if (blockErr || (blockCount ?? 0) > 0) {
      sendError(res, "not_found", "Media item not found");
      return false;
    }

    // Visibility — private/friends posts require a follow relationship.
    if (visibility === "private" || visibility === "friends") {
      const { data: followRow } = await sc
        .from("user_follows")
        .select("follower_id")
        .eq("follower_id", userId)
        .eq("following_id", authorId)
        .maybeSingle();
      if (!followRow) {
        sendError(res, "not_found", "Media item not found");
        return false;
      }
    }

    // trip_only media requires accepted trip membership.
    if (visibility === "trip_only") {
      if (!tripId || !(await isAcceptedTripMember(sc, tripId, userId))) {
        sendError(res, "not_found", "Media item not found");
        return false;
      }
    }

    return true;
  }

  // ── Fallback: hidden gems ────────────────────────────────────────────────────
  const { data: gemRow } = await sc
    .from("hidden_gems")
    .select("id, submitted_by, status")
    .eq("id", mediaId)
    .maybeSingle();

  if (gemRow && (gemRow as any).status === "active") {
    const submittedBy: string | null = (gemRow as any).submitted_by as string | null;
    if (submittedBy && submittedBy !== userId) {
      const { count: blockCount, error: blockErr } = await sc
        .from("blocks")
        .select("blocker_id", { count: "exact", head: true })
        .or(
          `and(blocker_id.eq.${userId},blocked_id.eq.${submittedBy}),` +
          `and(blocker_id.eq.${submittedBy},blocked_id.eq.${userId})`,
        );
      if (blockErr || (blockCount ?? 0) > 0) {
        sendError(res, "not_found", "Media item not found");
        return false;
      }
    }
    return true;
  }

  sendError(res, "not_found", "Media item not found");
  return false;
}

/** Shared block check — returns true if no block exists in either direction. */
async function noBlock(
  sc: NonNullable<ReturnType<typeof getServiceClient>>,
  viewerId: string,
  ownerId: string,
): Promise<boolean> {
  const { count, error } = await sc
    .from("blocks")
    .select("blocker_id", { count: "exact", head: true })
    .or(
      `and(blocker_id.eq.${viewerId},blocked_id.eq.${ownerId}),` +
      `and(blocker_id.eq.${ownerId},blocked_id.eq.${viewerId})`,
    );
  return !error && (count ?? 0) === 0;
}

/** gem → hidden_gems.submitted_by */
async function verifyGemStampAccess(
  sc: NonNullable<ReturnType<typeof getServiceClient>>,
  viewerId: string, entityId: string, res: any,
): Promise<boolean> {
  const { data, error } = await sc.from("hidden_gems").select("id, submitted_by").eq("id", entityId).maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return false; }
  if (!data) { sendError(res, "not_found", "Gem not found"); return false; }
  const owner = (data as any).submitted_by as string | null;
  if (owner && owner !== viewerId && !(await noBlock(sc, viewerId, owner))) {
    sendError(res, "not_found", "Gem not found"); return false;
  }
  return true;
}

/**
 * event — mirrors the full canViewEvent access model from events.ts so that a
 * user who can view an event can also stamp it (and no-one else can).
 *
 * Visibility model (from events.ts / canViewEvent):
 *  - "public"       → anyone; event must not be draft/cancelled/archived
 *  - "friends_only" → viewer is host, has a co_host/moderator role, has a
 *                     user_friendships row with the host, OR has any RSVP/role
 *  - "circle"       → viewer must be in circle_memberships for the event's circle_id
 *  - "trip"         → viewer must be a trip_members row with accepted/null status +
 *                     an accepted role (isTripEventMember semantics)
 *  - "invite_only" / unknown → viewer must have an RSVP or role row
 *
 * Block check always applies. Host always passes.
 */
async function verifyEventStampAccess(
  sc: NonNullable<ReturnType<typeof getServiceClient>>,
  viewerId: string, entityId: string, res: any,
): Promise<boolean> {
  const { data, error } = await sc
    .from("events")
    .select("id, host_id, state, visibility, circle_id, trip_id")
    .eq("id", entityId)
    .maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return false; }
  if (!data) { sendError(res, "not_found", "Event not found"); return false; }

  const ev = data as {
    id: string; host_id: string | null; state: string | null; visibility: string | null;
    circle_id: string | null; trip_id: string | null;
  };

  const hostId = ev.host_id ?? null;
  const vis    = ev.visibility ?? "public";

  // Block check applies for all visibility levels (both directions).
  if (hostId && hostId !== viewerId && !(await noBlock(sc, viewerId, hostId))) {
    sendError(res, "not_found", "Event not found"); return false;
  }

  // Host always has access.
  if (hostId === viewerId) return true;

  // Staff (co_host / moderator) always have access — mirrors canViewEvent.
  const { data: staffRole } = await sc
    .from("event_roles").select("role")
    .eq("event_id", entityId).eq("user_id", viewerId).maybeSingle();
  if (staffRole && ["co_host", "moderator"].includes((staffRole as any).role)) return true;

  if (vis === "public") {
    // Non-active states cannot be stamped.
    const blockedStates = ["draft", "cancelled", "archived"];
    if (ev.state && blockedStates.includes(ev.state)) {
      sendError(res, "not_found", "Event not found"); return false;
    }
    return true;
  }

  if (vis === "friends_only") {
    // Viewer must have a user_friendships row with the host (either direction).
    const { data: friendship } = await sc
      .from("user_friendships").select("user_a")
      .or(`and(user_a.eq.${viewerId},user_b.eq.${hostId ?? ""}),and(user_b.eq.${viewerId},user_a.eq.${hostId ?? ""})`)
      .maybeSingle();
    if (friendship) return true;
    // Existing attendees / role holders also qualify.
    const [rsvp, role] = await Promise.all([
      sc.from("event_rsvps").select("status").eq("event_id", entityId).eq("user_id", viewerId).maybeSingle(),
      sc.from("event_roles").select("role").eq("event_id", entityId).eq("user_id", viewerId).maybeSingle(),
    ]);
    if ((rsvp as any).data || (role as any).data) return true;
    sendError(res, "not_found", "Event not found"); return false;
  }

  if (vis === "circle") {
    if (!ev.circle_id) { sendError(res, "not_found", "Event not found"); return false; }
    const { data: member } = await sc
      .from("circle_memberships").select("other_id")
      .eq("user_id", ev.circle_id).eq("other_id", viewerId).maybeSingle();
    if (member) return true;
    sendError(res, "not_found", "Event not found"); return false;
  }

  if (vis === "trip") {
    // Mirror isTripEventMember: role must be in accepted list; null status = accepted (legacy).
    if (!ev.trip_id) { sendError(res, "not_found", "Event not found"); return false; }
    const { data: member } = await sc
      .from("trip_members").select("role, status")
      .eq("trip_id", ev.trip_id).eq("user_id", viewerId).maybeSingle();
    if (member) {
      const m = member as { role: string; status?: string | null };
      const acceptedRoles = ["owner", "co_host", "member", "viewer"];
      if (acceptedRoles.includes(m.role) && (m.status == null || m.status === "accepted")) {
        return true;
      }
    }
    sendError(res, "not_found", "Event not found"); return false;
  }

  // invite_only / unknown: RSVP or role row is sufficient.
  const [rsvp, role] = await Promise.all([
    sc.from("event_rsvps").select("status").eq("event_id", entityId).eq("user_id", viewerId).maybeSingle(),
    sc.from("event_roles").select("role").eq("event_id", entityId).eq("user_id", viewerId).maybeSingle(),
  ]);
  if ((rsvp as any).data || (role as any).data) return true;
  sendError(res, "not_found", "Event not found"); return false;
}

/**
 * trip — checks existence, block, and visibility.
 *
 * Visibility model (from trips.ts):
 *  - "public"   → anyone allowed (+ block check with owner)
 *  - "private"  → owner or trip_members only
 *  - "buddies"  → trip_members only
 *  - "invite"   → trip_members only
 *
 * Any other / unknown value is treated as non-public → members only.
 */
async function verifyTripStampAccess(
  sc: NonNullable<ReturnType<typeof getServiceClient>>,
  viewerId: string, entityId: string, res: any,
): Promise<boolean> {
  const { data, error } = await sc
    .from("trips")
    .select("id, owner_id, visibility")
    .eq("id", entityId)
    .maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return false; }
  if (!data) { sendError(res, "not_found", "Trip not found"); return false; }

  const trip = data as { id: string; owner_id: string | null; visibility: string | null };
  const ownerId = trip.owner_id ?? null;
  const vis = trip.visibility ?? "private";

  if (ownerId && ownerId !== viewerId && !(await noBlock(sc, viewerId, ownerId))) {
    sendError(res, "not_found", "Trip not found"); return false;
  }

  if (vis === "public") return true;

  // Owner always has access.
  if (ownerId && ownerId === viewerId) return true;

  // Non-public trips require trip membership. Legacy rows have null status which
  // is treated as accepted (same semantics as requireTripMember / isTripEventMember).
  const { data: member } = await sc
    .from("trip_members").select("user_id, status")
    .eq("trip_id", entityId).eq("user_id", viewerId).maybeSingle();
  if (member) {
    const s = (member as { status?: string | null }).status;
    if (s == null || s === "accepted") return true;
  }

  sendError(res, "not_found", "Trip not found"); return false;
}

/**
 * profile — checks existence, block, and privacy flag.
 *
 * Privacy model:
 *  - is_private = false → public; anyone with no block can stamp
 *  - is_private = true  → viewer must follow the profile owner
 */
async function verifyProfileStampAccess(
  sc: NonNullable<ReturnType<typeof getServiceClient>>,
  viewerId: string, entityId: string, res: any,
): Promise<boolean> {
  const { data, error } = await sc
    .from("profiles").select("id, is_private")
    .eq("id", entityId).maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return false; }
  if (!data) { sendError(res, "not_found", "Profile not found"); return false; }

  const isPrivate = Boolean((data as any).is_private);

  // Self-stamp allowed even on private profiles.
  if (entityId === viewerId) return true;

  // Block check (both directions).
  if (!(await noBlock(sc, viewerId, entityId))) {
    sendError(res, "not_found", "Profile not found"); return false;
  }

  if (isPrivate) {
    // Viewer must follow the profile owner.
    const { data: follow } = await sc
      .from("user_follows").select("follower_id")
      .eq("follower_id", viewerId).eq("following_id", entityId).maybeSingle();
    if (!follow) { sendError(res, "not_found", "Profile not found"); return false; }
  }

  return true;
}

/**
 * buddy_profile — callers pass the buddy's user UUID as entityId (not the
 * rent_buddy_profiles.id surrogate key).  Look up by user_id to match.
 * Block check uses the same entityId since it IS the owner's user UUID.
 */
async function verifyBuddyProfileStampAccess(
  sc: NonNullable<ReturnType<typeof getServiceClient>>,
  viewerId: string, entityId: string, res: any,
): Promise<boolean> {
  const { data, error } = await sc.from("rent_buddy_profiles").select("user_id").eq("user_id", entityId).maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return false; }
  if (!data) { sendError(res, "not_found", "Buddy profile not found"); return false; }
  // entityId IS the owner's user UUID — skip block check for self-stamps,
  // otherwise verify no block in either direction.
  if (entityId !== viewerId && !(await noBlock(sc, viewerId, entityId))) {
    sendError(res, "not_found", "Buddy profile not found"); return false;
  }
  return true;
}

/**
 * memory — enforces the full visibility model from memories.ts canViewMemory:
 *
 *  - owner always allowed
 *  - state must be "published"
 *  - "only_me"    → deny for non-owner
 *  - "public"     → allow (+ block check)
 *  - "friends_only" → mutual follow required
 *  - "trip_crew"  → accepted trip member required
 *  - "circle_only" → circle membership required
 *  - "custom"     → must be in allowed_user_ids, not in hidden_user_ids
 */
async function verifyMemoryStampAccess(
  sc: NonNullable<ReturnType<typeof getServiceClient>>,
  viewerId: string, entityId: string, res: any,
): Promise<boolean> {
  const { data, error } = await sc
    .from("memories")
    .select("id, owner_id, state, visibility, trip_id, allowed_user_ids, hidden_user_ids")
    .eq("id", entityId)
    .maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return false; }
  if (!data) { sendError(res, "not_found", "Memory not found"); return false; }

  const mem = data as {
    id: string; owner_id: string | null; state: string | null;
    visibility: string | null; trip_id: string | null;
    allowed_user_ids: string[] | null; hidden_user_ids: string[] | null;
  };

  // Owner can always stamp their own memory.
  if (mem.owner_id === viewerId) return true;

  // Must be published.
  if (mem.state !== "published") {
    sendError(res, "not_found", "Memory not found"); return false;
  }

  // Block check (both directions) for non-owner viewers.
  const ownerId = mem.owner_id ?? "";
  if (ownerId && !(await noBlock(sc, viewerId, ownerId))) {
    sendError(res, "not_found", "Memory not found"); return false;
  }

  const vis = mem.visibility ?? "only_me";

  if (vis === "only_me") { sendError(res, "not_found", "Memory not found"); return false; }
  if (vis === "public")  return true;

  if (vis === "custom") {
    const allowed: string[] = mem.allowed_user_ids ?? [];
    const hidden: string[] = mem.hidden_user_ids ?? [];
    if (hidden.includes(viewerId)) { sendError(res, "not_found", "Memory not found"); return false; }
    if (allowed.includes(viewerId)) return true;
    sendError(res, "not_found", "Memory not found"); return false;
  }

  if (vis === "friends_only") {
    // Both must follow each other (mutual friendship).
    const [{ data: fwd }, { data: rev }] = await Promise.all([
      sc.from("user_follows").select("following_id")
        .eq("follower_id", ownerId).eq("following_id", viewerId).maybeSingle(),
      sc.from("user_follows").select("follower_id")
        .eq("follower_id", viewerId).eq("following_id", ownerId).maybeSingle(),
    ]);
    if (!fwd || !rev) { sendError(res, "not_found", "Memory not found"); return false; }
    return true;
  }

  if (vis === "trip_crew") {
    if (!mem.trip_id) { sendError(res, "not_found", "Memory not found"); return false; }
    const { data: member } = await sc
      .from("trip_members").select("user_id")
      .eq("trip_id", mem.trip_id).eq("user_id", viewerId).maybeSingle();
    if (!member) { sendError(res, "not_found", "Memory not found"); return false; }
    return true;
  }

  if (vis === "circle_only") {
    const { data: circle } = await sc
      .from("circle_memberships").select("other_id")
      .eq("user_id", ownerId).eq("other_id", viewerId).maybeSingle();
    if (!circle) { sendError(res, "not_found", "Memory not found"); return false; }
    return true;
  }

  // Unknown visibility → deny.
  sendError(res, "not_found", "Memory not found"); return false;
}

// ── POST /api/stamps ──────────────────────────────────────────────────────────
// Stamp an entity. Idempotent — re-stamping the same entity is a silent 200.

router.post(
  "/stamps",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user, client } = auth;

    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured", "Service client unavailable");
      return;
    }

    const parsed = stampBodySchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(
        res,
        "invalid_payload",
        parsed.error.issues[0]?.message ?? "Invalid payload",
      );
      return;
    }
    const { entityType, entityId } = parsed.data as {
      entityType: StampableEntityType;
      entityId: string;
    };

    // Per-entity access control. Each supported type has a guard proportional
    // to its privacy model. Types with no user owner (place, hotel, restaurant,
    // destination, guide) are public-readable — no block check needed.
    if (entityType === "post") {
      const ok = await verifyPostStampAccess(sc, client, user.id, entityId, res);
      if (!ok) return;
    } else if (entityType === "media") {
      const ok = await verifyMediaStampAccess(sc, user.id, entityId, res);
      if (!ok) return;
    } else if (entityType === "gem") {
      const ok = await verifyGemStampAccess(sc, user.id, entityId, res);
      if (!ok) return;
    } else if (entityType === "event") {
      const ok = await verifyEventStampAccess(sc, user.id, entityId, res);
      if (!ok) return;
    } else if (entityType === "trip") {
      const ok = await verifyTripStampAccess(sc, user.id, entityId, res);
      if (!ok) return;
    } else if (entityType === "profile") {
      const ok = await verifyProfileStampAccess(sc, user.id, entityId, res);
      if (!ok) return;
    } else if (entityType === "buddy_profile") {
      const ok = await verifyBuddyProfileStampAccess(sc, user.id, entityId, res);
      if (!ok) return;
    } else if (entityType === "memory") {
      const ok = await verifyMemoryStampAccess(sc, user.id, entityId, res);
      if (!ok) return;
    } else if (
      entityType === "place" ||
      entityType === "guide" ||
      entityType === "hotel" ||
      entityType === "restaurant" ||
      entityType === "destination"
    ) {
      // Public/canonical entities — no user-owner block check needed.
      // Existence is validated implicitly: a stampEntity upsert on a
      // non-existent UUID still succeeds (no FK on entity_id) and is
      // harmless (orphaned stamps are invisible in feed/profile queries).
    } else {
      // Exhaustive guard: STAMPABLE_TYPES drives the zod schema so this
      // branch can only be reached if a type is added to the enum but not
      // wired here — fail closed to surface the gap quickly in tests.
      sendError(res, "invalid_payload", `Stamping ${entityType} entities is not yet supported via this endpoint`);
      return;
    }

    try {
      const result = await stampEntity(sc, user.id, entityType, entityId);

      // Route stamp event into the Compass personalization pipeline.
      // Same outcome stage ("liked") as the strongest prior positive signal.
      void linkOutcomeSignal(sc, user.id, entityId, "liked", "route:content_stamp");

      res.status(200).json(result);
    } catch (err: any) {
      req.log.error({ err }, "content_stamp insert failed");
      sendError(res, "db_error", err?.message ?? "Failed to stamp");
    }
  }),
);

// ── DELETE /api/stamps/:entityType/:entityId ──────────────────────────────────
// Remove a stamp. Idempotent — removing a non-existent stamp is a silent 200.
// No entity-existence check: the original unlike endpoints allowed removal
// even when the entity was no longer accessible.

router.delete(
  "/stamps/:entityType/:entityId",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured", "Service client unavailable");
      return;
    }

    const { entityType, entityId } = req.params;

    if (!(STAMPABLE_TYPES as readonly string[]).includes(entityType)) {
      sendError(res, "invalid_payload", `Unknown entity type: ${entityType}`);
      return;
    }
    if (!UUID_RE.test(entityId)) {
      sendError(res, "invalid_payload", "entityId must be a valid UUID");
      return;
    }

    try {
      const result = await unstampEntity(
        sc,
        user.id,
        entityType as StampableEntityType,
        entityId,
      );
      res.status(200).json(result);
    } catch (err: any) {
      req.log.error({ err }, "content_stamp delete failed");
      sendError(res, "db_error", err?.message ?? "Failed to remove stamp");
    }
  }),
);

export default router;
