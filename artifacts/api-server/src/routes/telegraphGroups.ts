/**
 * Telegraph group conversations — formation (§14.3) and, below it, large-group
 * controls (§30A.12).
 *
 *   POST /api/threads/:threadId/add-people
 *        Add people to a DM. Creates a NEW `group` conversation of the DM's two
 *        people plus the added ones; never exposes the DM's history; optionally
 *        carries explicitly selected Plans / Places forward as new share
 *        messages. services/telegraph/groupFormation.ts holds every rule; this
 *        file only parses and answers. Flag telegraph_dm_group_formation_enabled
 *        (3660), seeded OFF.
 */
import { Router } from "express";
import { z } from "zod";

import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { formGroupFromDirect, MAX_ADDED_PEOPLE, MAX_CARRY_FORWARD, MAX_GROUP_TITLE } from "../services/telegraph/groupFormation.js";

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `.strict()` on the carried item: a selection that names a message, a cursor
 * or a transcript is REFUSED at the door, not silently stripped — the plan
 * would refuse it too, but a parser that dropped the field would hide the
 * attempt.
 */
const AddPeopleSchema = z
  .object({
    userIds: z.array(z.string().regex(UUID)).min(1).max(MAX_ADDED_PEOPLE),
    carryForward: z
      .array(z.object({ kind: z.enum(["PLAN", "PLACE"]), objectId: z.string().min(1).max(200) }).strict())
      .max(MAX_CARRY_FORWARD)
      .optional(),
    title: z.string().max(MAX_GROUP_TITLE).nullish(),
  })
  .strict();

router.post(
  "/threads/:threadId/add-people",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId } = req.params;
    if (!UUID.test(threadId)) {
      sendError(res, "invalid_payload", "Invalid threadId");
      return;
    }
    const parsed = AddPeopleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }

    const outcome = await formGroupFromDirect(client, getServiceClient(), {
      actorId: user.id,
      sourceThreadId: threadId,
      addedUserIds: parsed.data.userIds,
      carryForward: parsed.data.carryForward ?? [],
      title: parsed.data.title ?? null,
    });
    if (!outcome.ok) {
      if (outcome.code === "db_error") req.log?.error?.({ threadId }, "group formation write failed");
      sendError(res, outcome.code, outcome.message);
      return;
    }
    res.status(201).json({
      threadId: outcome.threadId,
      threadType: "group",
      memberUserIds: outcome.memberUserIds,
      carriedForward: outcome.carriedForward,
      // §14.3, stated on the wire: the new conversation starts empty of the DM.
      historyFrom: "formation",
      ...(outcome.inboxOrderStale ? { inboxOrderStale: true } : {}),
    });
  }),
);

export default router;
