/**
 * Telegraph §3 Shared Context Rail + §2.2 conversation header.
 *
 *   GET /api/threads/:threadId/shared-context
 *        §3.4's `TelegraphSharedContextProjection` for the calling member,
 *        plus §11.2's rail mode and collapsed summary.
 *
 *   GET /api/threads/:threadId/conversation-header
 *        §2.2's header contract: "User / Crew name · availability · safe
 *        presence". The name half already existed client-side; the two halves
 *        that did not are what this returns.
 *
 * ── AUTHORIZATION ───────────────────────────────────────────────────────────
 * Active thread membership is verified on every call, from
 * `message_thread_members` with `left_at IS NULL`, and a failed read is a 500
 * — never an empty rail, which would read to the caller as "you share nothing
 * with this person" and is a different (and wrong) statement.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 * No read of `messages`. §3.2 forbids inferring mutuality from chat, and the
 * projection service refuses any candidate that does not come from one of five
 * canonical tables; this route never gives it the chance, because it never
 * opens the message table at all.
 *
 * Safe presence is read ONLY for the thread's own canonical context (a trip
 * thread's trip, a circle thread's circle) and only through
 * `canViewCirclePresenceBatch`, the existing consent guard. `needs_help` is
 * never selected and never returned — `routes/circle.ts:1-14` states that rule
 * and this route obeys it.
 */
import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logger as rootLogger } from "../lib/logger.js";
import {
  buildSharedContextProjection,
  railModeFor,
  collapsedSummary,
} from "../services/telegraph/sharedContext.js";
import {
  projectPublicWindows,
  type ViewerRelationship,
} from "../services/passport/OpenToPlansService.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { canViewCirclePresenceBatch } from "../lib/circleAccessGuard.js";

const log = rootLogger.child({ route: "telegraphSharedContext" });
const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;
const OPEN_TO_PLANS_FLAG = "open_to_plans_windows_enabled";

/** Cap on how many other members a group rail resolves against. */
export const MAX_RAIL_PARTICIPANTS = 50;

interface ThreadContext {
  threadId: string;
  threadType: string;
  tripId: string | null;
  circleOwnerId: string | null;
  /** Every currently-active member, viewer included. */
  participantIds: string[];
}

type LoadResult =
  | { ok: true; ctx: ThreadContext }
  | {
      ok: false;
      code: "not_found" | "forbidden" | "db_error";
      message: string;
    };

/**
 * Active membership + thread shape, in two reads whose errors are both
 * observed. A dropped error here would turn a database blip into "you are not
 * a member", which is the wrong refusal and the wrong status code.
 */
async function loadThreadContext(
  client: SupabaseClient,
  threadId: string,
  viewerId: string,
): Promise<LoadResult> {
  const { data: membership, error: mErr } = await client
    .from("message_thread_members")
    .select("user_id, left_at")
    .eq("thread_id", threadId)
    .eq("user_id", viewerId)
    .maybeSingle();
  if (mErr)
    return {
      ok: false,
      code: "db_error",
      message: mErr.message ?? "membership read failed",
    };
  if (!membership || (membership as any).left_at !== null) {
    return {
      ok: false,
      code: "forbidden",
      message: "Not an active member of this thread",
    };
  }

  const { data: thread, error: tErr } = await client
    .from("message_threads")
    .select("id, thread_type, trip_id, circle_owner_id")
    .eq("id", threadId)
    .maybeSingle();
  if (tErr)
    return {
      ok: false,
      code: "db_error",
      message: tErr.message ?? "thread read failed",
    };
  if (!thread)
    return { ok: false, code: "not_found", message: "Thread not found" };

  const { data: members, error: allErr } = await client
    .from("message_thread_members")
    .select("user_id, left_at")
    .eq("thread_id", threadId)
    .is("left_at", null)
    .limit(MAX_RAIL_PARTICIPANTS + 1);
  if (allErr)
    return {
      ok: false,
      code: "db_error",
      message: allErr.message ?? "members read failed",
    };

  const participantIds = [
    ...new Set(
      ((members ?? []) as any[])
        .map((m) => m.user_id as string)
        .filter(Boolean),
    ),
  ].slice(0, MAX_RAIL_PARTICIPANTS);
  if (!participantIds.includes(viewerId)) participantIds.push(viewerId);

  return {
    ok: true,
    ctx: {
      threadId,
      threadType: (thread as any).thread_type ?? "direct",
      tripId: (thread as any).trip_id ?? null,
      circleOwnerId: (thread as any).circle_owner_id ?? null,
      participantIds,
    },
  };
}

// ── GET /api/threads/:threadId/shared-context ────────────────────────────────

router.get(
  "/threads/:threadId/shared-context",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId } = req.params;

    if (!UUID.test(threadId)) {
      sendError(res, "invalid_payload", "Invalid threadId");
      return;
    }

    const loaded = await loadThreadContext(client, threadId, user.id);
    if (!loaded.ok) {
      sendError(res, loaded.code, loaded.message);
      return;
    }

    const result = await buildSharedContextProjection(client, {
      conversationId: threadId,
      viewerId: user.id,
      participantIds: loaded.ctx.participantIds,
    });

    if (result.problems.length > 0) {
      log.warn(
        { threadId, problems: result.problems },
        "shared-context resolved with failed reads",
      );
    }

    res.status(200).json({
      sharedContext: result.projection,
      railMode: railModeFor(result.projection),
      collapsedSummary: collapsedSummary(result.projection),
      // A rail built on a failed read is INCOMPLETE, and says so, rather than
      // presenting an empty rail as the truthful answer "nothing is shared".
      incomplete: result.problems.length > 0,
      refusedCount: result.refusals.length,
    });
  }),
);

// ── GET /api/threads/:threadId/conversation-header ───────────────────────────

interface HeaderParticipant {
  userId: string;
  /**
   * §4's hard rule: AVAILABLE is not ONLINE, not NEARBY and not SHARING
   * LOCATION. These three fields are read from three different stores with
   * three different consents and are never merged into one flag.
   */
  availability: {
    enabled: boolean;
    state: string | null;
    intents: string[];
    expiresAt: string | null;
  };
  safePresence: {
    /** Coarse, consented, never coordinates. */
    label: string | null;
    venue: string | null;
    checkedIn: boolean;
    stale: boolean;
  } | null;
}

router.get(
  "/threads/:threadId/conversation-header",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId } = req.params;

    if (!UUID.test(threadId)) {
      sendError(res, "invalid_payload", "Invalid threadId");
      return;
    }

    const loaded = await loadThreadContext(client, threadId, user.id);
    if (!loaded.ok) {
      sendError(res, loaded.code, loaded.message);
      return;
    }
    const ctx = loaded.ctx;
    const others = ctx.participantIds.filter((p) => p !== user.id);

    // ── availability (§4, the AVAILABLE axis) ──────────────────────────────────
    const windowsEnabled = await isFlagEnabled(client, OPEN_TO_PLANS_FLAG);
    const relationship: ViewerRelationship =
      ctx.threadType === "trip" || ctx.threadType === "circle"
        ? "crew"
        : "follower";

    const participants: HeaderParticipant[] = [];
    for (const other of others) {
      let state: string | null = null;
      let intents: string[] = [];
      let expiresAt: string | null = null;
      if (windowsEnabled) {
        // §4.3 "Availability expires automatically and revokes across Telegraph,
        // Discovery and Compass" — expiry is re-evaluated HERE, on the read, by
        // the same predicate Passport uses. A stalled sweep cannot leave a stale
        // window rendering as current on this surface.
        const windows = await projectPublicWindows(client, other, relationship);
        const active = windows[0] ?? null;
        if (active) {
          state =
            active.socialAvailability ??
            (active.openToPlans ? "open" : "not_open");
          intents = active.intents ?? [];
          expiresAt = active.expiresAt ?? active.endAt ?? null;
        }
      }
      participants.push({
        userId: other,
        availability: { enabled: windowsEnabled, state, intents, expiresAt },
        safePresence: null,
      });
    }

    // ── safe presence (§2.2, the SAFE PRESENCE axis) ───────────────────────────
    // Only inside the thread's own canonical context, only through the existing
    // consent guard, and never `needs_help`.
    const contextType: "trip" | "event" | null = ctx.tripId ? "trip" : null;
    const contextId = ctx.tripId;
    if (contextType && contextId && others.length > 0) {
      const access = await canViewCirclePresenceBatch(
        client,
        user.id,
        others,
        contextType,
        contextId,
      );
      const visible = others.filter((o) => access.get(o)?.allowed === true);
      if (visible.length > 0) {
        const { data: presence, error: pErr } = await client
          .from("circle_presence")
          .select(
            "user_id, status_label, approximate_label, venue_label, checked_in, is_stale",
          )
          .eq("context_type", contextType)
          .eq("context_id", contextId)
          .in("user_id", visible);
        if (pErr) {
          log.warn(
            { threadId, message: pErr.message },
            "circle_presence read failed; header omits safe presence",
          );
        } else {
          const byUser = new Map<string, any>();
          for (const row of (presence ?? []) as any[])
            byUser.set(row.user_id as string, row);
          for (const p of participants) {
            const row = byUser.get(p.userId);
            if (!row) continue;
            p.safePresence = {
              label: row.status_label ?? row.approximate_label ?? null,
              venue: row.venue_label ?? null,
              checkedIn: Boolean(row.checked_in),
              stale: Boolean(row.is_stale),
            };
          }
        }
      }
    }

    res.status(200).json({
      threadId,
      threadType: ctx.threadType,
      participants,
      availabilityEnabled: windowsEnabled,
    });
  }),
);

export default router;
