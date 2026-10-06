/**
 * GET /api/users/:targetUserId/interaction-context
 *
 * Returns the full set of interaction permissions that the authenticated viewer
 * has against the target user. This is the single canonical permission gate:
 * every social action (follow, friend, message, tag, invite, book, report…)
 * must consult this endpoint before proceeding.
 *
 * Query params:
 *   sourceType — optional context type (e.g. "event", "trip", "deep_link")
 *   sourceId   — optional context ID (e.g. event UUID)
 *
 * SAFETY: Block wins over every other signal. Paid boosts NEVER override safety.
 *
 * Extended response fields (beyond InteractionPermissions):
 *   iBlocked            — viewer is the blocker (derived from relationshipLabel)
 *   theyBlockedMe       — target blocked the viewer (derived from relationshipLabel)
 *   iMuted              — viewer has muted target (queried from user_mutes)
 *   iRestricted         — viewer has restricted target (queried from user_restrictions)
 *   context.isFriend          — derived from relationshipLabel
 *   context.areMutualFollowers — derived from relationshipLabel
 */

import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import { isUuid } from "../lib/followDecisions";
import { resolveInteractionPermissions } from "../services/interactionPermissions";
import { getServiceClient } from "../lib/supabase";
import { isTableAbsentError } from "../lib/tableAbsence";

const router = Router();

/**
 * Silences an ABSENT TABLE only (lib/tableAbsence: 42P01 / PGRST205); re-throws
 * every other error. Used so Phase 2 tables (user_mutes, user_restrictions)
 * degrade gracefully when migration 0063 hasn't been applied yet — an absent
 * table holds no mute, so `false` is then true.
 *
 * It used to silence PGRST204 (a missing COLUMN) and any message containing
 * "does not exist" (42703 column, 42883 operator/function), so a table that
 * EXISTS and could not be read answered iMuted / iRestricted `false` — an
 * unread mute reported as "not muted". And it did NOT recognise PGRST205, the
 * code PostgREST actually sends for an absent table once its schema cache is
 * loaded, so the genuinely-absent case it was written for 500'd instead.
 * Census-trust §31 measured this file with the two #574 fixed; it is their
 * sibling.
 */
async function safeQuerySingle<T>(
  result: Promise<{ data: T | null; error: any }>,
): Promise<T | null> {
  const { data, error } = await result;
  if (error) {
    if (isTableAbsentError(error)) {
      return null; // table not migrated yet — no row can exist
    }
    throw new Error(`DB query failed: ${error.message ?? error.code ?? ""}`);
  }
  return data ?? null;
}

router.get("/users/:targetUserId/interaction-context", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { targetUserId } = req.params;
  if (!isUuid(targetUserId)) {
    sendError(res, "invalid_payload", "Invalid target user id");
    return;
  }

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not ready");
    return;
  }

  const sourceType = (req.query.sourceType as string | undefined) ?? null;
  const sourceId   = (req.query.sourceId   as string | undefined) ?? null;

  try {
    const [permissions, muteRow, restrictRow] = await Promise.all([
      resolveInteractionPermissions(sc, user.id, targetUserId, {
        sourceType,
        sourceId,
      }),

      // iMuted — fail-open when user_mutes doesn't exist yet
      safeQuerySingle<{ muter_id: string }>(
        (
          sc
            .from("user_mutes")
            .select("muter_id")
            .eq("muter_id", user.id)
            .eq("muted_id", targetUserId)
            .maybeSingle() as unknown as Promise<{
            data: { muter_id: string } | null;
            error: any;
          }>
        ),
      ),

      // iRestricted — fail-open when user_restrictions doesn't exist yet
      safeQuerySingle<{ restrictor_id: string }>(
        (
          sc
            .from("user_restrictions")
            .select("restrictor_id")
            .eq("restrictor_id", user.id)
            .eq("restricted_id", targetUserId)
            .maybeSingle() as unknown as Promise<{
            data: { restrictor_id: string } | null;
            error: any;
          }>
        ),
      ),
    ]);

    const label = permissions.relationshipLabel;

    // Derive boolean shortcut fields that mobile clients rely on directly.
    // The permission engine already has the ground truth; we expose it here so
    // consumers don't have to re-parse reasonCodes or the label string.
    const iBlocked           = label === "blocked"       || label === "mutual_block";
    const theyBlockedMe      = label === "blocks_you"    || label === "mutual_block";
    const isFriend           = label === "friend";
    const areMutualFollowers = label === "mutual_follow" || label === "friend";
    const iMuted             = muteRow     !== null;
    const iRestricted        = restrictRow !== null;

    res.status(200).json({
      ...permissions,
      iBlocked,
      theyBlockedMe,
      iMuted,
      iRestricted,
      context: {
        ...permissions.context,
        isFriend,
        areMutualFollowers,
      },
    });
  } catch (err) {
    req.log.error({ err }, "interaction-context resolver failed");
    sendError(res, "db_error", "Failed to resolve interaction permissions", { exposeDetail: true });
  }
});

export default router;
