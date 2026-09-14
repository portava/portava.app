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
  projectAcknowledgements,
  projectCommitment,
  projectCoordinationSession,
  projectDecision,
  sessionStateNow,
  threadIsCoordinating,
  validateCoordinationMessage,
  type AnnouncementInputMessage,
  type ConversationCommitment,
  type ConversationDecision,
  type CoordinatedPlan,
  type CoordinationSession,
  type ThreadCoordination,
} from "../services/telegraph/coordination.js";
import type { CoordinationState } from "../services/telegraph/vocabulary.js";
import { parseKindEnvelope } from "../services/telegraph/messageKinds.js";
import { projectSafetyMode, type SafetyInputRow } from "../services/telegraph/safetyMode.js";
import {
  SEMANTIC_LAYERS,
  partitionViolations,
  projectSemanticLayers,
  type LayerInputRow,
} from "../services/telegraph/layers.js";
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

/**
 * A `messages` row read back as a §6.2 ANNOUNCEMENT, or null.
 *
 * Null for every reason a caller must not be able to tell apart: no row, a row
 * in another thread (the query already binds `thread_id`, and this is the
 * second guard), a tombstone, a message that is not an announcement, an
 * envelope that does not parse, or a row outside this member's §14.3 window.
 * They all answer 404, because "that message exists but you cannot see it" is
 * itself a disclosure.
 */
function readAnnouncementRow(
  row: any,
  visibleFrom: string | null,
): AnnouncementInputMessage | null {
  if (!row) return null;
  if (row.deleted_at != null) return null;
  if (!withinWindow(row.created_at, visibleFrom)) return null;
  const env = parseKindEnvelope(row.msg_type, row.body);
  if (!env || env.kind !== "ANNOUNCEMENT") return null;
  const payload = env.payload as { title?: unknown; requiresAcknowledgement?: unknown };
  return {
    id: String(row.id),
    sender_id: String(row.sender_id),
    created_at: String(row.created_at),
    title: typeof payload.title === "string" ? payload.title : "",
    requiresAcknowledgement: payload.requiresAcknowledgement === true,
  };
}

/**
 * A `messages` row read back as a §8.1 action PROPOSAL, or null.
 *
 * Two carriers, one meaning: `ACTION_PROPOSAL` is the §8 coordination kind and
 * `ACTION` is §6.2's message kind. Both say "somebody proposed an action and
 * nobody has answered", so both are answerable — refusing one of them would
 * make whether a proposal can be confirmed depend on which route posted it.
 *
 * Null for every reason a caller must not be able to tell apart, exactly as
 * `readAnnouncementRow` is: no row, wrong thread, tombstone, wrong kind,
 * unparseable envelope, or outside this member's §14.3 window.
 */
function readActionProposalRow(row: any, visibleFrom: string | null): { id: string } | null {
  if (!row) return null;
  if (row.deleted_at != null) return null;
  if (!withinWindow(row.created_at, visibleFrom)) return null;
  const coord = parseCoordinationEnvelope(row.msg_type, row.body);
  if (coord && coord.kind === "ACTION_PROPOSAL") return { id: String(row.id) };
  const env = parseKindEnvelope(row.msg_type, row.body);
  if (env && env.kind === "ACTION") return { id: String(row.id) };
  return null;
}

type SessionRead =
  | { kind: "ok"; state: CoordinationState; session: CoordinationSession }
  | { kind: "not_found" }
  | { kind: "db_error"; message: string };

/**
 * The session named by a transition, and the state a new transition must be
 * legal from.
 *
 * Reads the session message and every transition already posted against it,
 * bound to this thread and to this member's §14.3 window, and folds them with
 * the SAME projection the read path uses. Two rules computed by one function is
 * the point: a route that re-derived legality would be a second state machine.
 */
async function readSessionForTransition(
  client: SupabaseClient,
  threadId: string,
  sessionId: string,
  visibleFrom: string | null,
): Promise<SessionRead> {
  const { data: sessionRow, error: sErr } = await client
    .from("messages")
    .select(COORD_COLUMNS)
    .eq("id", sessionId)
    .eq("thread_id", threadId)
    .maybeSingle();
  if (sErr) return { kind: "db_error", message: sErr.message ?? "session read failed" };
  const row = sessionRow as any;
  if (!row || row.deleted_at != null || !withinWindow(row.created_at, visibleFrom)) {
    return { kind: "not_found" };
  }
  const env = parseCoordinationEnvelope(row.msg_type, row.body);
  if (!env || env.kind !== "COORDINATION_SESSION") return { kind: "not_found" };

  let q = client
    .from("messages")
    .select(COORD_COLUMNS)
    .eq("thread_id", threadId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(COORDINATION_SCAN_LIMIT);
  if (visibleFrom) q = q.gte("created_at", visibleFrom);
  const { data, error } = await q;
  if (error) return { kind: "db_error", message: error.message ?? "transition read failed" };

  const transitions = ((data as any[]) ?? [])
    .filter((r) => withinWindow(r.created_at, visibleFrom))
    .map((r) => {
      const e = parseCoordinationEnvelope(r.msg_type, r.body);
      return e && e.kind === "COORDINATION_TRANSITION"
        ? { id: String(r.id), sender_id: String(r.sender_id), created_at: String(r.created_at), payload: e.payload }
        : null;
    })
    .filter((r): r is any => r !== null);

  const input = {
    id: String(row.id),
    sender_id: String(row.sender_id),
    created_at: String(row.created_at),
    payload: env.payload,
  };
  // A transition's legality is judged against what has been DECLARED, not
  // against the clock: the derived state is deliberately not passed here, so
  // posting one cannot be blocked or unblocked by time passing between the
  // read and the write.
  const session = projectCoordinationSession(input, transitions, null);
  return { kind: "ok", state: sessionStateNow(input, transitions, null), session };
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

    // §19: an ACKNOWLEDGEMENT must name an ANNOUNCEMENT this member can
    // actually see, in THIS thread, that ASKED to be acknowledged. Without
    // this check the kind would be a free-text pointer: a client could
    // acknowledge a message id from another conversation, or manufacture an
    // acknowledgement of a notice nobody was asked to acknowledge, and the
    // projection would faithfully report it.
    if (validated.kind === "ACKNOWLEDGEMENT") {
      const targetId = String((validated.envelope as any).payload.announcementMessageId);
      const gate = await memberWindow(client, threadId, user.id);
      if (!gate.ok) {
        sendError(res, gate.code, gate.message);
        return;
      }
      const { data: target, error: targetErr } = await client
        .from("messages")
        .select("id, thread_id, sender_id, created_at, deleted_at, msg_type, body")
        .eq("id", targetId)
        .eq("thread_id", threadId)
        .maybeSingle();
      if (targetErr) {
        log.error({ threadId, targetId, message: targetErr.message }, "announcement read failed");
        sendError(res, "db_error", "Could not read the announcement");
        return;
      }
      const announcement = readAnnouncementRow(target, gate.visibleFrom);
      if (!announcement) {
        sendError(res, "not_found", "No such announcement in this conversation");
        return;
      }
      if (!announcement.requiresAcknowledgement) {
        sendError(
          res,
          "invalid_payload",
          "That announcement did not ask to be acknowledged. Acknowledgement is for operational " +
            "changes that need a person to confirm they saw them (§19); a notice that did not ask " +
            "for one is answered by reading it.",
        );
        return;
      }
    }

    // §9: a COORDINATION_TRANSITION must name a session IN THIS THREAD and must
    // be an arrow §9's diagram actually has. Refusing at post time is what
    // makes the state machine a rule rather than a suggestion — a projection
    // that merely marked the row `applied: false` after the fact would let a
    // client show CANCELLED -> ACTIVE optimistically and be contradicted on the
    // next read.
    if (validated.kind === "COORDINATION_TRANSITION") {
      const payload = (validated.envelope as any).payload as { sessionId: string; to: string };
      const gate = await memberWindow(client, threadId, user.id);
      if (!gate.ok) {
        sendError(res, gate.code, gate.message);
        return;
      }
      const session = await readSessionForTransition(client, threadId, payload.sessionId, gate.visibleFrom);
      if (session.kind === "db_error") {
        log.error({ threadId, message: session.message }, "session read failed");
        sendError(res, "db_error", "Could not read that coordination session");
        return;
      }
      if (session.kind === "not_found") {
        sendError(res, "not_found", "No such coordination session in this conversation");
        return;
      }
      const from = session.state;
      if (!legalNextStates(from).includes(payload.to as any)) {
        sendError(
          res,
          "invalid_payload",
          `This session is ${from}. §9 allows ${from} -> ` +
            `${legalNextStates(from).join(", ") || "nothing (it is terminal)"}, not ${payload.to}.`,
        );
        return;
      }
    }

    // §8.2: an ACTION_RESPONSE must name an action proposal this member can
    // actually see, IN THIS THREAD. Without this the kind would be a free-text
    // pointer and §2.3's PLAN layer could be emptied by answering a message id
    // from another conversation — the same hole the ACKNOWLEDGEMENT check
    // above closes, and it is closed the same way.
    if (validated.kind === "ACTION_RESPONSE") {
      const targetId = String((validated.envelope as any).payload.actionMessageId);
      const gate = await memberWindow(client, threadId, user.id);
      if (!gate.ok) {
        sendError(res, gate.code, gate.message);
        return;
      }
      const { data: target, error: targetErr } = await client
        .from("messages")
        .select("id, thread_id, sender_id, created_at, deleted_at, msg_type, body")
        .eq("id", targetId)
        .eq("thread_id", threadId)
        .maybeSingle();
      if (targetErr) {
        log.error({ threadId, targetId, message: targetErr.message }, "action proposal read failed");
        sendError(res, "db_error", "Could not read the action");
        return;
      }
      if (!readActionProposalRow(target, gate.visibleFrom)) {
        sendError(res, "not_found", "No such action proposal in this conversation");
        return;
      }
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

    // §8's CoordinationSession. The newest open session wins; a thread that
    // held two evenings' sessions shows the one still running rather than the
    // first one ever opened.
    const transitionRows = parsedRows.filter((r) => r.kind === "COORDINATION_TRANSITION");
    const sessions = parsedRows
      .filter((r) => r.kind === "COORDINATION_SESSION")
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .map((r) => projectCoordinationSession(r, transitionRows, state));
    const session: CoordinationSession | null =
      sessions.find((sn) => sn.endedAt === null) ?? sessions[0] ?? null;

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
      session,
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

// ── GET /api/threads/:threadId/announcements ─────────────────────────────────

/**
 * §19's acknowledgement state, per announcement in this thread.
 *
 * WHY IT IS A SEPARATE ROUTE from the coordination view: an announcement is a
 * §6.2 message kind, not a §8/§9 object, and folding it into
 * `ThreadCoordination` would say a thread with an unacknowledged notice is
 * "coordinating", which it is not.
 *
 * `outstanding` is computed from the thread's ACTIVE roster, read here rather
 * than inferred, and it is NULL when that read fails — a degraded roster must
 * not render as "everybody has acknowledged".
 */
router.get(
  "/threads/:threadId/announcements",
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
      log.error({ threadId, message: error.message }, "announcement read failed");
      sendError(res, "db_error", "Could not read this conversation's announcements");
      return;
    }

    const rows = ((data as any[]) ?? []).filter((r) => withinWindow(r.created_at, gate.visibleFrom));

    const announcements: AnnouncementInputMessage[] = [];
    const acknowledgements: Array<{ id: string; sender_id: string; created_at: string; payload: unknown }> = [];
    for (const r of rows) {
      const ann = readAnnouncementRow(r, gate.visibleFrom);
      if (ann) {
        announcements.push(ann);
        continue;
      }
      const env = parseCoordinationEnvelope(r.msg_type, r.body);
      if (env && env.kind === "ACKNOWLEDGEMENT") {
        acknowledgements.push({
          id: r.id as string,
          sender_id: r.sender_id as string,
          created_at: r.created_at as string,
          payload: env.payload,
        });
      }
    }

    // The roster. A failed read leaves it undefined so `outstanding` is null.
    let memberIds: string[] | undefined;
    const { data: members, error: memberErr } = await client
      .from("message_thread_members")
      .select("user_id, left_at")
      .eq("thread_id", threadId)
      .is("left_at", null);
    if (memberErr) {
      log.warn({ threadId, message: memberErr.message }, "roster read failed; outstanding omitted");
    } else {
      memberIds = ((members as any[]) ?? []).map((m) => String(m.user_id));
    }

    res.status(200).json({
      threadId,
      announcements: projectAcknowledgements(
        [...announcements].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
        acknowledgements,
        memberIds,
      ),
      /**
       * §19, stated in the response: an acknowledgement is something a person
       * PRESSED. `message_thread_members.last_read_at` is not read on this
       * path and cannot become one.
       */
      derivedFrom: "ACKNOWLEDGEMENT_MESSAGES_ONLY",
      rosterKnown: memberIds !== undefined,
      scanned: rows.length,
    });
  }),
);

// ── GET /api/threads/:threadId/layers ────────────────────────────────────────

/**
 * §2.3 — the conversation's three semantic LAYERS for this viewer.
 *
 * census-telegraph T11 records that ACTION and ANNOUNCEMENT are a genuinely
 * different class of stream item and that this is still not a layer:
 * "unresolved actions are interleaved with conversation rather than
 * separated". This route is the separation, decided on the server so two
 * clients cannot disagree about what is still open.
 *
 * The response PARTITIONS the thread: an id in `plan` or `now` is not in
 * `talk`, and a PLAN item that has been resolved is back in `talk` where it
 * belongs as history. `partitionViolations` is asserted here rather than only
 * in the test, because the guarantee is what the caller is being sold.
 *
 * PER VIEWER, and it says so in the response. An announcement waiting on an
 * acknowledgement is open for the people who have not pressed the button and
 * closed for those who have; there is no viewer-independent answer, and
 * pretending otherwise would put a resolved item back in somebody's layer.
 */
router.get(
  "/threads/:threadId/layers",
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
      log.error({ threadId, message: error.message }, "layers read failed");
      sendError(res, "db_error", "Could not read this conversation's layers");
      return;
    }

    const rows = ((data as any[]) ?? []).filter((r) => withinWindow(r.created_at, gate.visibleFrom));

    const projection = projectSemanticLayers({
      threadId,
      viewerId: user.id,
      rows: rows as LayerInputRow[],
      nowMs: Date.now(),
    });

    const violations = partitionViolations(projection);
    if (violations.length > 0) {
      // Unreachable by construction; served as a 500 rather than as a response
      // that quietly breaks the one promise this surface makes.
      log.error({ threadId, violations }, "semantic layers are not a partition");
      sendError(res, "db_error", "Could not compute this conversation's layers");
      return;
    }

    res.status(200).json({
      threadId: projection.threadId,
      generatedAt: projection.generatedAt,
      layers: SEMANTIC_LAYERS,
      plan: projection.plan,
      now: projection.now,
      talk: projection.talk,
      /**
       * §2.3 stated in the response, not only in this file: the three
       * collections are disjoint and their union is every message scanned, so
       * a client that renders PLAN above the stream is not double-drawing.
       */
      partitioned: true,
      /** §19: PLAN is answered per person, so this answer is about one. */
      viewerId: projection.viewerId,
      scanned: rows.length,
      truncated: rows.length >= COORDINATION_SCAN_LIMIT,
    });
  }),
);

// ── GET /api/me/commitments ──────────────────────────────────────────────────

/** How many of the caller's threads one cross-thread query will join across. */
export const COMMITMENTS_MAX_THREADS = 200;
/** How many commitment-shaped rows that query will scan. */
export const COMMITMENTS_SCAN_LIMIT = 1000;
/** How far back "what have I agreed to" looks by default. */
export const COMMITMENTS_DEFAULT_DAYS = 90;

/**
 * §8's ConversationCommitment, listed ACROSS the caller's conversations.
 *
 * census-telegraph T84: the per-thread projection answers who agreed to what,
 * by when and whether it was completed, and "stays W for a reason worth
 * stating: a projection over one thread's messages is not a queryable store,
 * so 'what have I agreed to this week' cannot be answered across threads. The
 * spec's Object row implies something a surface can list."
 *
 * This is that list, and it is built from the SAME projection the thread view
 * uses (`projectCommitment`) rather than from a second rule — a cross-thread
 * answer that disagreed with the thread it came from would be worse than no
 * cross-thread answer at all.
 *
 * ── WHY THIS IS NOT A NEW STORE ─────────────────────────────────────────────
 * Appendix A forbids duplicating canonical structures. A commitment is still
 * exactly the messages that carry it; what was missing was a QUERY, and a
 * query is a route, not a table. The cost is that the scan is bounded — the
 * caller's threads, commitment-shaped rows only, a time window — and every
 * bound is reported in the response so a truncated answer cannot be mistaken
 * for a complete one.
 *
 * ── AUTHORIZATION ───────────────────────────────────────────────────────────
 * Threads come from the caller's OWN active memberships, so a commitment in a
 * conversation they are not in cannot be reached, and each thread's §14.3
 * window is applied to its own rows — a member added last week does not learn
 * what the group promised each other last month.
 */
router.get(
  "/me/commitments",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;

    const includeCompleted = String(req.query.includeCompleted ?? "") === "true";
    const scope = String(req.query.scope ?? "mine") === "all" ? "all" : "mine";
    const daysRaw = Number.parseInt(String(req.query.days ?? ""), 10);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 365 ? daysRaw : COMMITMENTS_DEFAULT_DAYS;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const boundOn = await historyBoundEnabled(client);
    const { data: memberships, error: memberErr } = await client
      .from("message_thread_members")
      .select(membershipSelect("thread_id, user_id, left_at", boundOn))
      .eq("user_id", user.id)
      .is("left_at", null)
      .limit(COMMITMENTS_MAX_THREADS);
    if (memberErr) {
      // An unreadable membership list is not "you have agreed to nothing".
      // That answer is indistinguishable from a real empty one and is wrong in
      // the direction that makes somebody miss a promise they made.
      log.error({ userId: user.id, message: memberErr.message }, "commitment membership read failed");
      sendError(res, "db_error", "Could not read your conversations");
      return;
    }

    const windowByThread = new Map<string, string | null>();
    for (const m of ((memberships as any[]) ?? [])) {
      windowByThread.set(String(m.thread_id), visibleFromOf(m as any, boundOn));
    }
    const threadIds = [...windowByThread.keys()];
    if (threadIds.length === 0) {
      res.status(200).json({
        commitments: [],
        scope,
        includeCompleted,
        windowDays: days,
        threadsScanned: 0,
        scanned: 0,
        truncated: false,
      });
      return;
    }

    const { data, error } = await client
      .from("messages")
      .select(COORD_COLUMNS + ", thread_id")
      .in("thread_id", threadIds)
      .in("msg_type", ["commitment", "commitment_response"])
      .is("deleted_at", null)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(COMMITMENTS_SCAN_LIMIT);
    if (error) {
      log.error({ userId: user.id, message: error.message }, "commitment read failed");
      sendError(res, "db_error", "Could not read your commitments");
      return;
    }

    const rows = ((data as any[]) ?? []).filter((r) =>
      withinWindow(r.created_at, windowByThread.get(String(r.thread_id)) ?? null),
    );

    const parsedRows = rows
      .map((r) => {
        const env = parseCoordinationEnvelope(r.msg_type, r.body);
        return env ? { ...r, kind: env.kind, payload: env.payload } : null;
      })
      .filter((r): r is any => r !== null);

    const nowMs = Date.now();
    const out: any[] = [];
    for (const c of parsedRows.filter((r) => r.kind === "COMMITMENT")) {
      // Responses are matched WITHIN the commitment's own thread. A
      // commitment id is only unique inside a conversation, and letting a
      // response from another thread count would let anyone in any of the
      // caller's threads mark someone else's promise complete.
      const responses = parsedRows.filter(
        (r) => r.kind === "COMMITMENT_RESPONSE" && r.thread_id === c.thread_id,
      );
      const projected = projectCommitment(c, responses, nowMs);
      if (!projected) continue;

      const agreed = projected.agreedBy.find((a) => a.userId === user.id);
      const declined = projected.declinedBy.find((a) => a.userId === user.id);
      const askedOf: string[] = Array.isArray(c.payload?.askedOf) ? c.payload.askedOf : [];
      const askedOfViewer = askedOf.includes(user.id);
      const viewerResponse = agreed ? "AGREED" : declined ? "DECLINED" : null;

      // "mine" is what T84's sentence asks for — what the CALLER agreed to, plus
      // what was explicitly asked of them and is still unanswered. `scope=all`
      // is the thread-wide view for a surface that wants it, and it is opt-in
      // rather than the default so this route cannot become a way to watch what
      // other people have promised.
      if (scope === "mine" && viewerResponse !== "AGREED" && !askedOfViewer) continue;
      if (!includeCompleted && projected.completedBy !== null) continue;

      out.push({
        ...projected,
        threadId: String(c.thread_id),
        createdAt: c.created_at,
        askedOfViewer,
        viewerResponse,
        viewerRespondedAt: agreed?.at ?? declined?.at ?? null,
      });
    }

    // Soonest due first; a commitment with no deadline sorts last, because a
    // promise with a date is the one that can be late.
    out.sort((a, b) => {
      const da = a.byWhen ? Date.parse(a.byWhen) : Number.MAX_SAFE_INTEGER;
      const db = b.byWhen ? Date.parse(b.byWhen) : Number.MAX_SAFE_INTEGER;
      if (da !== db) return da - db;
      return String(a.commitmentId) < String(b.commitmentId) ? -1 : 1;
    });

    res.status(200).json({
      commitments: out,
      scope,
      includeCompleted,
      windowDays: days,
      threadsScanned: threadIds.length,
      scanned: rows.length,
      /**
       * Every bound this answer was computed under, stated: a truncated list
       * must not be readable as "that is everything you owe".
       */
      truncated: rows.length >= COMMITMENTS_SCAN_LIMIT || threadIds.length >= COMMITMENTS_MAX_THREADS,
    });
  }),
);

// ── GET /api/threads/:threadId/safety-mode ───────────────────────────────────

/**
 * §15.2 — the conversation's safety mode, NORMAL / SAFETY_ATTENTION /
 * SAFETY_EVENT, with §15.2's own promotion list.
 *
 * WHY IT IS NOT FOLDED INTO THE COORDINATION VIEW: a thread in
 * SAFETY_ATTENTION is not "coordinating", and returning it under
 * `ThreadCoordination` would make `coordinating` true for a conversation with
 * no plan in it — the same reason `GET /threads/:id/announcements` is its own
 * route.
 *
 * The signals are the thread's own §6.2 SAFETY messages and §9.1 NEED_HELP
 * quick states, membership-gated and §14.3-bounded like every other read here.
 * A member who joined after a help request was raised and cleared does not
 * learn that it happened.
 */
router.get(
  "/threads/:threadId/safety-mode",
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
      // An unreadable thread is NOT a calm one. Answering NORMAL here would be
      // the single worst failure this route could have.
      log.error({ threadId, message: error.message }, "safety mode read failed");
      sendError(res, "db_error", "Could not read this conversation's safety state");
      return;
    }

    const rows = ((data as any[]) ?? []).filter((r) => withinWindow(r.created_at, gate.visibleFrom));

    const projection = projectSafetyMode({
      threadId,
      rows: rows as SafetyInputRow[],
      nowMs: Date.now(),
    });

    res.status(200).json({
      ...projection,
      /**
       * §15.2 stated in the response: this mode is derived from what people
       * SAID in this conversation. It is not Safe Return, it does not read a
       * Safe Return session, and a thread can be NORMAL while its members have
       * one running.
       */
      derivedFrom: "THREAD_SAFETY_SIGNALS_ONLY",
      scanned: rows.length,
    });
  }),
);

export default router;
