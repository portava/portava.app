/**
 * Telegraph §8 + §9 — the coordination surface.
 *
 *   POST /api/threads/:threadId/coordination
 *        Post a §9.1 quick state, a §8 decision, a vote, a rendezvous, a
 *        commitment, a commitment response, or a §8.1 action proposal.
 *
 *   GET  /api/threads/:threadId/coordination
 *        The thread's live coordination view: §9's derived state for the plan
 *        it is coordinating around, the latest declared status per member,
 *        arrival counts, and the §8 decision / commitment / rendezvous
 *        projections.
 *
 * ── WHAT IS DERIVED AND WHAT IS DECLARED ────────────────────────────────────
 * §9.1's closing rule — "User-declared status must remain distinguishable from
 * system-derived ETA or location-derived estimates" — is the shape of this
 * whole route. Everything under `quickStates` is what a person SAID, carries
 * `provenance: "USER_DECLARED"`, and is never mixed with `state`, which is
 * DERIVED from the plan's own timeline and is labelled as such in the
 * response. There is no field that could hold either.
 *
 * ── AUTHORIZATION ───────────────────────────────────────────────────────────
 * Writes go through `lib/telegraphThreadWrite.ts`, the same four gates as the
 * ordinary send path. Reads require active membership and inherit §14.3's
 * history bound, so a member added yesterday does not get yesterday's
 * decisions.
 */
import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logger as rootLogger } from "../lib/logger.js";
import { guardTelegraphThreadWrite } from "../lib/telegraphThreadWrite.js";
import { publishToThread } from "../lib/telegraphEvents.js";
import {
  COORDINATION_ACTIONS,
  COORDINATION_KINDS,
  derivedCoordinationState,
  latestQuickStates,
  leaveByFor,
  legalNextStates,
  parseCoordinationEnvelope,
  projectCommitment,
  projectDecision,
  threadIsCoordinating,
  validateCoordinationMessage,
  type ConversationCommitment,
  type ConversationDecision,
  type CoordinatedPlan,
  type ThreadCoordination,
} from "../services/telegraph/coordination.js";
import {
  historyBoundEnabled,
  membershipSelect,
  visibleFromOf,
  withinWindow,
} from "../services/groupChatHistoryBound.js";

const log = rootLogger.child({ route: "telegraphCoordination" });
const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;

/** How many recent rows the coordination view reads. */
export const COORDINATION_SCAN_LIMIT = 400;

const PostSchema = z.object({
  kind: z.string().min(1).max(40),
  payload: z.unknown(),
});

type MemberGate =
  | { ok: true; visibleFrom: string | null }
  | { ok: false; code: "forbidden" | "db_error"; message: string };

async function memberWindow(
  client: SupabaseClient,
  threadId: string,
  userId: string,
): Promise<MemberGate> {
  const boundOn = await historyBoundEnabled(client);
  const { data, error } = await client
    .from("message_thread_members")
    .select(membershipSelect("user_id, left_at", boundOn))
    .eq("thread_id", threadId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { ok: false, code: "db_error", message: error.message ?? "membership read failed" };
  if (!data || (data as any).left_at !== null) {
    return { ok: false, code: "forbidden", message: "Not an active member of this thread" };
  }
  return { ok: true, visibleFrom: visibleFromOf(data as any, boundOn) };
}

// ── POST /api/threads/:threadId/coordination ─────────────────────────────────

router.post(
  "/threads/:threadId/coordination",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId } = req.params;

    if (!UUID.test(threadId)) {
      sendError(res, "invalid_payload", "Invalid threadId");
      return;
    }
    const parsed = PostSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }

    const validated = validateCoordinationMessage(parsed.data.kind, parsed.data.payload);
    if (!validated.ok) {
      sendError(res, "invalid_payload", validated.error);
      return;
    }

    const guard = await guardTelegraphThreadWrite(client, threadId, user.id);
    if (!guard.ok) {
      sendError(res, guard.code, guard.message);
      return;
    }

    const now = new Date().toISOString();
    const { data: msg, error: msgErr } = await client
      .from("messages")
      .insert({
        thread_id: threadId,
        sender_id: user.id,
        body: JSON.stringify(validated.envelope),
        created_at: now,
        msg_type: validated.msgType,
        subtype: validated.subtype,
      })
      .select("id, thread_id, sender_id, created_at, msg_type, subtype")
      .single();

    if (msgErr || !msg) {
      log.error({ err: msgErr, threadId, kind: parsed.data.kind }, "coordination insert failed");
      sendError(res, "db_error", msgErr?.message ?? "Failed to post");
      return;
    }

    const { error: bumpErr } = await client
      .from("message_threads")
      .update({ last_message_at: now, updated_at: now })
      .eq("id", threadId);
    if (bumpErr) {
      log.warn({ err: bumpErr, threadId }, "thread bump after coordination post failed (message was written)");
    }

    const m = msg as any;
    res.status(201).json({
      id: m.id,
      threadId: m.thread_id,
      senderId: m.sender_id,
      createdAt: m.created_at,
      msgType: m.msg_type,
      subtype: m.subtype,
      kind: validated.kind,
    });

    void publishToThread(client, threadId, {
      type: "message.created",
      payload: {
        messageId: m.id,
        senderId: m.sender_id,
        msgType: m.msg_type,
        subtype: m.subtype,
        createdAt: m.created_at,
      },
    });
  }),
);

/** What a client may post here, and which §8.1 actions this route carries. */
router.get(
  "/telegraph/coordination-kinds",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    res.status(200).json({
      kinds: COORDINATION_KINDS,
      actions: COORDINATION_ACTIONS,
      /**
       * The other seven §8.1 actions are not missing: each is owned by a
       * canonical surface and goes through it. Naming them here keeps a
       * reader from concluding this route is the whole of §8.1.
       */
      actionsOwnedElsewhere: {
        ADD_TO_TRIP: "the trip wishlist picker",
        CREATE_PLAN: "the meetup creation sheet",
        JOIN_PLAN: "meetup RSVP",
        LEAVE_PLAN: "meetup RSVP",
        VOTE: "meetup time-option votes, and DECISION/VOTE here for free-form questions",
        SHARE_PLACE: "POST /threads/:id/share (§5)",
        CHECK_IN_SAFE: "the §6.2 SAFETY message kind",
      },
    });
  }),
);

// ── GET /api/threads/:threadId/coordination ──────────────────────────────────

const COORD_COLUMNS = "id, sender_id, created_at, deleted_at, msg_type, subtype, body";

router.get(
  "/threads/:threadId/coordination",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId } = req.params;

    if (!UUID.test(threadId)) {
      sendError(res, "invalid_payload", "Invalid threadId");
      return;
    }

    const gate = await memberWindow(client, threadId, user.id);
    if (!gate.ok) {
      sendError(res, gate.code, gate.message);
      return;
    }

    let q = client
      .from("messages")
      .select(COORD_COLUMNS)
      .eq("thread_id", threadId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(COORDINATION_SCAN_LIMIT);
    if (gate.visibleFrom) q = q.gte("created_at", gate.visibleFrom);

    const { data, error } = await q;
    if (error) {
      log.error({ threadId, message: error.message }, "coordination read failed");
      sendError(res, "db_error", "Could not read this conversation's coordination state");
      return;
    }

    const rows = ((data as any[]) ?? []).filter((r) => withinWindow(r.created_at, gate.visibleFrom));

    const parsedRows = rows
      .map((r) => {
        const env = parseCoordinationEnvelope(r.msg_type, r.body);
        return env ? { ...r, kind: env.kind, payload: env.payload } : null;
      })
      .filter((r): r is any => r !== null);

    const quickRows = parsedRows.filter((r) => r.kind === "COORDINATION");
    const quickStates = latestQuickStates(quickRows);

    const decisionRows = parsedRows.filter((r) => r.kind === "DECISION");
    const voteRows = parsedRows.filter((r) => r.kind === "VOTE");
    const commitmentRows = parsedRows.filter((r) => r.kind === "COMMITMENT");
    const responseRows = parsedRows.filter((r) => r.kind === "COMMITMENT_RESPONSE");
    const rendezvousRows = parsedRows.filter((r) => r.kind === "RENDEZVOUS");

    const nowDate = new Date();
    const nowMs = nowDate.getTime();

    const decisions: ConversationDecision[] = [];
    for (const d of decisionRows) {
      const projected = projectDecision(d, voteRows, nowMs);
      if (projected) decisions.push(projected);
    }
    const commitments: ConversationCommitment[] = [];
    for (const c of commitmentRows) {
      const projected = projectCommitment(c, responseRows, nowMs);
      if (projected) commitments.push(projected);
    }

    // The plan the thread is coordinating around: the soonest meetup whose
    // chat thread this is. A thread with no plan has no coordination state,
    // which is different from having one that is PREPARING.
    let plan: CoordinatedPlan | null = null;
    const { data: meetups, error: mErr } = await client
      .from("meetups")
      .select("id, title, starts_at, ends_at, status")
      .eq("chat_thread_id", threadId)
      .limit(20);
    if (mErr) {
      log.warn({ threadId, message: mErr.message }, "meetup read failed; coordination state omitted");
    } else {
      const candidates = ((meetups as any[]) ?? [])
        .filter((m) => m.starts_at)
        .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
      const chosen =
        candidates.find((m) => Date.parse(m.ends_at ?? m.starts_at) >= nowMs) ??
        candidates[candidates.length - 1] ??
        null;
      if (chosen) {
        plan = {
          objectId: chosen.id as string,
          title: (chosen.title as string) ?? "Plan",
          startsAt: (chosen.starts_at as string) ?? null,
          endsAt: (chosen.ends_at as string) ?? null,
          status: (chosen.status as string) ?? null,
        };
      }
    }

    const state = plan ? derivedCoordinationState(plan, nowMs) : null;

    const view: ThreadCoordination = {
      threadId,
      generatedAt: nowDate.toISOString(),
      plan: plan ? { ...plan, leaveByAt: leaveByFor(plan) } : null,
      state,
      coordinating: threadIsCoordinating(state),
      legalNext: state ? legalNextStates(state) : [],
      quickStates,
      arrivedCount: quickStates.filter((q2) => q2.state === "ARRIVED").length,
      onMyWayCount: quickStates.filter((q2) => q2.state === "ON_MY_WAY").length,
      decisions,
      commitments,
      rendezvous: rendezvousRows.map((r) => ({
        messageId: r.id as string,
        setBy: r.sender_id as string,
        at: r.created_at as string,
        payload: r.payload,
      })),
    };

    res.status(200).json({
      coordination: view,
      /**
       * §9.1, stated in the response rather than only in a comment: every
       * entry in `quickStates` is what a person SAID. `state` is DERIVED from
       * the plan's timeline. The two never merge.
       */
      stateProvenance: "DERIVED_FROM_PLAN_TIMELINE",
      scanned: rows.length,
    });
  }),
);

export default router;
