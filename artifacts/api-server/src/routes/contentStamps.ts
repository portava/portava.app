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

    // Per-entity access control. 'post' and 'media' have full guard parity
    // with their legacy like endpoints. All other types are not yet supported
    // via this unified route — fail closed until explicit guards are added.
    if (entityType === "post") {
      const ok = await verifyPostStampAccess(sc, client, user.id, entityId, res);
      if (!ok) return;
    } else if (entityType === "media") {
      const ok = await verifyMediaStampAccess(sc, user.id, entityId, res);
      if (!ok) return;
    } else {
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
