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
 *
 *   GET    /api/threads/:threadId/controls
 *   PUT    /api/threads/:threadId/controls                    (host)
 *   POST   /api/threads/:threadId/moderation/:userId/mute     (host)
 *   DELETE /api/threads/:threadId/moderation/:userId/mute     (host)
 *   POST   /api/threads/:threadId/moderation/:userId/remove   (host; `group` only)
 *        §30A.12 large-group controls. The ENFORCEMENT is not here: it is gate
 *        5b of the shared send guard and of the two inline doors
 *        (domain/telegraph/policies/groupControlsPolicy.ts). These routes only
 *        let a host set what that gate reads. Flag telegraph_group_controls_enabled
 *        (3661), seeded OFF.
 *
 *   GET    /api/users/:userId/telegraph-relationship
 *        §30A.1's relationship between the caller and one person: state +
 *        in-force origins, derived from existing data
 *        (services/telegraph/telegraphRelationship.ts). An INPUT for
 *        ConversationPolicy, never a permission by itself. Flag
 *        telegraph_relationship_context_enabled (3662), seeded OFF.
 */
import { Router } from "express";
import { z } from "zod";

import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { readFlagState } from "../lib/featureFlags.js";
import { readTelegraphRelationship } from "../services/telegraph/telegraphRelationship.js";
import { formGroupFromDirect, MAX_ADDED_PEOPLE, MAX_CARRY_FORWARD, MAX_GROUP_TITLE } from "../services/telegraph/groupFormation.js";
import {
  AUDIENCE_POLICIES,
  GROUP_CONTROLLED_THREAD_TYPES,
  NO_CONTROLS,
  SLOW_MODE_MAX_SECONDS,
  controlsFromRow,
  groupControlsState,
  isConversationHost,
  type GroupThreadRef,
} from "../domain/telegraph/policies/groupControlsPolicy.js";

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

// ── §30A.12 group controls ───────────────────────────────────────────────────

/** The longest timed mute a host may set: thirty days. Longer is "until lifted". */
export const MAX_MUTE_MINUTES = 30 * 24 * 60;

type ControlGate =
  | { ok: true; sc: any; thread: GroupThreadRef; isHost: boolean }
  | { ok: false };

/**
 * Flag, membership, conversation class and host status, in that order. Answers
 * the request itself when it refuses. A non-member learns nothing (404).
 */
async function controlGate(req: any, res: any, needHost: boolean): Promise<ControlGate & { userId?: string }> {
  const auth = await requireUser(req, res);
  if (!auth) return { ok: false };
  const { client, user } = auth;
  const { threadId } = req.params;
  if (!UUID.test(threadId)) {
    sendError(res, "invalid_payload", "Invalid threadId");
    return { ok: false };
  }
  const state = await groupControlsState(getServiceClient() ?? client);
  if (state === "unknown") {
    sendError(res, "degraded_unavailable", "We could not check this conversation's settings right now. Please try again shortly.");
    return { ok: false };
  }
  if (state === "off") {
    sendError(res, "feature_disabled", "Group controls are not available yet");
    return { ok: false };
  }
  const { data: mem, error: memErr } = await client
    .from("message_thread_members")
    .select("user_id, left_at")
    .eq("thread_id", threadId)
    .eq("user_id", user.id)
    .is("left_at", null)
    .maybeSingle();
  if (memErr) {
    sendError(res, "degraded_unavailable", "We could not verify this conversation right now. Please try again shortly.");
    return { ok: false };
  }
  if (!mem) {
    sendError(res, "not_found", "Conversation not found");
    return { ok: false };
  }
  const { data: thread, error: tErr } = await client
    .from("message_threads")
    .select("id, thread_type, trip_id, circle_owner_id")
    .eq("id", threadId)
    .maybeSingle();
  if (tErr || !thread) {
    sendError(res, "degraded_unavailable", "We could not verify this conversation right now. Please try again shortly.");
    return { ok: false };
  }
  const ref = thread as GroupThreadRef;
  if (!GROUP_CONTROLLED_THREAD_TYPES.includes(ref.thread_type ?? "direct")) {
    sendError(res, "conflict", "This conversation has no host controls");
    return { ok: false };
  }
  const host = await isConversationHost(client, ref, user.id);
  if (host === null) {
    sendError(res, "degraded_unavailable", "We could not verify this conversation right now. Please try again shortly.");
    return { ok: false };
  }
  if (needHost && !host) {
    sendError(res, "forbidden", "Only a host can change this", { reason: "TELEGRAPH_AUTH_NOT_THREAD_ADMIN" });
    return { ok: false };
  }
  return { ok: true, sc: client, thread: ref, isHost: host, userId: user.id };
}

/**
 * The target of a moderation action: an ACTIVE member, not the actor, and not
 * a host (hosts do not moderate each other here). Answers and returns false when
 * it refuses.
 */
async function moderationTarget(res: any, sc: any, thread: GroupThreadRef, actorId: string, targetId: string): Promise<boolean> {
  if (!UUID.test(targetId)) {
    sendError(res, "invalid_payload", "Invalid userId");
    return false;
  }
  if (targetId === actorId) {
    sendError(res, "invalid_payload", "You cannot moderate yourself");
    return false;
  }
  const { data: target, error } = await sc
    .from("message_thread_members")
    .select("user_id, left_at")
    .eq("thread_id", thread.id)
    .eq("user_id", targetId)
    .is("left_at", null)
    .maybeSingle();
  if (error) {
    sendError(res, "degraded_unavailable", "We could not verify this conversation right now. Please try again shortly.");
    return false;
  }
  if (!target) {
    sendError(res, "not_found", "That person is not in this conversation");
    return false;
  }
  const targetIsHost = await isConversationHost(sc, thread, targetId);
  if (targetIsHost === null) {
    sendError(res, "degraded_unavailable", "We could not verify this conversation right now. Please try again shortly.");
    return false;
  }
  if (targetIsHost) {
    sendError(res, "conflict", "Hosts cannot be muted or removed");
    return false;
  }
  return true;
}

router.get(
  "/threads/:threadId/controls",
  asyncHandler(async (req: any, res: any) => {
    const g = await controlGate(req, res, false);
    if (!g.ok) return;
    const [{ data: ctl, error: ctlErr }, { data: mute, error: muteErr }] = await Promise.all([
      g.sc.from("telegraph_thread_controls")
        .select("slow_mode_seconds, posting_policy, media_policy, link_policy")
        .eq("thread_id", g.thread.id)
        .maybeSingle(),
      g.sc.from("telegraph_thread_member_mutes")
        .select("muted_until")
        .eq("thread_id", g.thread.id)
        .eq("user_id", g.userId)
        .maybeSingle(),
    ]);
    if (ctlErr || muteErr) {
      sendError(res, "degraded_unavailable", "We could not read this conversation's settings right now. Please try again shortly.");
      return;
    }
    res.status(200).json({
      threadId: g.thread.id,
      controls: controlsFromRow(ctl as Record<string, unknown> | null) ?? NO_CONTROLS,
      isHost: g.isHost,
      // The caller's OWN mute only. Who else is muted is a host's business.
      mutedUntil: mute ? ((mute as { muted_until?: string | null }).muted_until ?? "indefinite") : null,
    });
  }),
);

const ControlsSchema = z
  .object({
    slowModeSeconds: z.number().int().min(0).max(SLOW_MODE_MAX_SECONDS).optional(),
    postingPolicy: z.enum(AUDIENCE_POLICIES).optional(),
    mediaPolicy: z.enum(AUDIENCE_POLICIES).optional(),
    linkPolicy: z.enum(AUDIENCE_POLICIES).optional(),
  })
  .strict();

router.put(
  "/threads/:threadId/controls",
  asyncHandler(async (req: any, res: any) => {
    const parsed = ControlsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }
    const g = await controlGate(req, res, true);
    if (!g.ok) return;
    const { data: existing, error: readErr } = await g.sc
      .from("telegraph_thread_controls")
      .select("slow_mode_seconds, posting_policy, media_policy, link_policy")
      .eq("thread_id", g.thread.id)
      .maybeSingle();
    if (readErr) {
      sendError(res, "degraded_unavailable", "We could not read this conversation's settings right now. Please try again shortly.");
      return;
    }
    const cur = controlsFromRow(existing as Record<string, unknown> | null) ?? NO_CONTROLS;
    const next = {
      thread_id: g.thread.id,
      slow_mode_seconds: parsed.data.slowModeSeconds ?? cur.slowModeSeconds,
      posting_policy: parsed.data.postingPolicy ?? cur.postingPolicy,
      media_policy: parsed.data.mediaPolicy ?? cur.mediaPolicy,
      link_policy: parsed.data.linkPolicy ?? cur.linkPolicy,
      updated_at: new Date().toISOString(),
    };
    const { error: writeErr } = existing
      ? await g.sc.from("telegraph_thread_controls").update(next).eq("thread_id", g.thread.id)
      : await g.sc.from("telegraph_thread_controls").insert(next);
    if (writeErr) {
      req.log?.error?.({ threadId: g.thread.id }, "group controls write failed");
      sendError(res, "db_error", "Failed to save these settings");
      return;
    }
    res.status(200).json({ threadId: g.thread.id, controls: controlsFromRow(next) });
  }),
);

const MuteSchema = z.object({ minutes: z.number().int().min(1).max(MAX_MUTE_MINUTES).nullish() }).strict();

router.post(
  "/threads/:threadId/moderation/:userId/mute",
  asyncHandler(async (req: any, res: any) => {
    const parsed = MuteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }
    const g = await controlGate(req, res, true);
    if (!g.ok) return;
    const targetId = String(req.params.userId);
    if (!(await moderationTarget(res, g.sc, g.thread, g.userId!, targetId))) return;
    const mutedUntil = parsed.data.minutes ? new Date(Date.now() + parsed.data.minutes * 60_000).toISOString() : null;
    const row = { thread_id: g.thread.id, user_id: targetId, muted_by: g.userId, muted_until: mutedUntil };
    const { data: existing, error: readErr } = await g.sc
      .from("telegraph_thread_member_mutes")
      .select("user_id")
      .eq("thread_id", g.thread.id)
      .eq("user_id", targetId)
      .maybeSingle();
    if (readErr) {
      sendError(res, "degraded_unavailable", "We could not verify this conversation right now. Please try again shortly.");
      return;
    }
    const { error: writeErr } = existing
      ? await g.sc.from("telegraph_thread_member_mutes").update({ muted_by: g.userId, muted_until: mutedUntil }).eq("thread_id", g.thread.id).eq("user_id", targetId)
      : await g.sc.from("telegraph_thread_member_mutes").insert(row);
    if (writeErr) {
      sendError(res, "db_error", "Failed to mute this member");
      return;
    }
    res.status(200).json({ threadId: g.thread.id, userId: targetId, mutedUntil: mutedUntil ?? "indefinite" });
  }),
);

router.delete(
  "/threads/:threadId/moderation/:userId/mute",
  asyncHandler(async (req: any, res: any) => {
    const g = await controlGate(req, res, true);
    if (!g.ok) return;
    const targetId = String(req.params.userId);
    if (!UUID.test(targetId)) {
      sendError(res, "invalid_payload", "Invalid userId");
      return;
    }
    const { error } = await g.sc
      .from("telegraph_thread_member_mutes")
      .delete()
      .eq("thread_id", g.thread.id)
      .eq("user_id", targetId);
    if (error) {
      sendError(res, "db_error", "Failed to lift this mute");
      return;
    }
    res.status(200).json({ threadId: g.thread.id, userId: targetId, mutedUntil: null });
  }),
);

router.post(
  "/threads/:threadId/moderation/:userId/remove",
  asyncHandler(async (req: any, res: any) => {
    const g = await controlGate(req, res, true);
    if (!g.ok) return;
    // A trip's or a circle's roster belongs to the trip or the circle: removing
    // someone from its chat here would be undone by the next sync, and would
    // claim a removal that did not happen. Only a `group` owns its roster.
    if ((g.thread.thread_type ?? "direct") !== "group") {
      sendError(res, "conflict", "Remove this person from the trip or circle itself; its conversation follows that roster");
      return;
    }
    const targetId = String(req.params.userId);
    if (!(await moderationTarget(res, g.sc, g.thread, g.userId!, targetId))) return;
    const now = new Date().toISOString();
    const { error } = await g.sc
      .from("message_thread_members")
      .update({ left_at: now })
      .eq("thread_id", g.thread.id)
      .eq("user_id", targetId)
      .is("left_at", null);
    if (error) {
      sendError(res, "db_error", "Failed to remove this member");
      return;
    }
    res.status(200).json({ threadId: g.thread.id, userId: targetId, removedAt: now });
  }),
);

// ── §30A.1 relationship context ──────────────────────────────────────────────

router.get(
  "/users/:userId/telegraph-relationship",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const otherId = String(req.params.userId);
    if (!UUID.test(otherId) || otherId === user.id) {
      sendError(res, "invalid_payload", "Invalid user id");
      return;
    }
    const sc = getServiceClient() ?? client;
    const flag = await readFlagState(sc, "telegraph_relationship_context_enabled");
    if (flag === "unknown") {
      sendError(res, "degraded_unavailable", "We could not check this right now. Please try again shortly.");
      return;
    }
    if (flag !== "on") {
      sendError(res, "feature_disabled", "Relationship context is not available yet");
      return;
    }
    const read = await readTelegraphRelationship(sc, user.id, otherId);
    if (read.degraded) {
      // Never a floor: a relationship built from a failed read would be published as a fact.
      sendError(res, "degraded_unavailable", "We could not check this right now. Please try again shortly.");
      return;
    }
    res.status(200).json({ userId: otherId, ...read.relationship });
  }),
);

export default router;
