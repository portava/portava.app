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

// ── GET /api/threads/:threadId/trip-context ──────────────────────────────────

/** How many plan items one trip-context read will scan. */
export const TRIP_CONTEXT_SCAN_LIMIT = 400;

/**
 * The plan-item fields this surface returns. Deliberately NOT `lat` / `lng`.
 *
 * `trip_plan_items.lat` carries a comment saying it is "Public-safe latitude …
 * Always null when location_is_private=true", and that is a rule about the
 * TRIPS surface. This is a CONVERSATION surface: a crew thread answers "what
 * are we doing today", and no answer to that question needs coordinates. Not
 * selecting them is stronger than stripping them, because there is then no
 * branch that could stop stripping.
 */
const TRIP_CONTEXT_COLUMNS =
  "id, trip_id, title, category, status, day_date, starts_at, ends_at, location_name, city, country, sort_order, removed_at";

interface TripContextItem {
  id: string;
  title: string;
  category: string;
  status: string;
  dayDate: string | null;
  startsAt: string | null;
  endsAt: string | null;
  locationName: string | null;
  city: string | null;
  country: string | null;
}

function toContextItem(r: any): TripContextItem {
  return {
    id: String(r.id),
    title: (r.title as string) ?? "Plan item",
    category: (r.category as string) ?? "activity",
    status: (r.status as string) ?? "tentative",
    dayDate: (r.day_date as string) ?? null,
    startsAt: (r.starts_at as string) ?? null,
    endsAt: (r.ends_at as string) ?? null,
    locationName: (r.location_name as string) ?? null,
    city: (r.city as string) ?? null,
    country: (r.country as string) ?? null,
  };
}

/** The instant an item is ordered by: its start, else the start of its day. */
function itemInstant(r: any): number | null {
  const starts = typeof r.starts_at === "string" ? Date.parse(r.starts_at) : NaN;
  if (!Number.isNaN(starts)) return starts;
  if (typeof r.day_date === "string" && r.day_date.length >= 10) {
    const d = Date.parse(`${r.day_date.slice(0, 10)}T00:00:00.000Z`);
    return Number.isNaN(d) ? null : d;
  }
  return null;
}

/**
 * §20 Trips — "crew threads, shared Trip cards, **today/next context**,
 * membership authorization, Trip Kernel commands".
 *
 * census-telegraph T262 scored this two of five and named today/next context as
 * one of the three missing. This is that context, read from `trip_plan_items`
 * — Trips' own canonical table — and written by nothing here.
 *
 * ── THE SECOND GATE, AND WHY IT IS NOT REDUNDANT ────────────────────────────
 * Thread membership is checked first, as everywhere else in this file. Then
 * ACCEPTED TRIP membership is checked again, against `trip_members`. That is
 * not belt-and-braces: census-telegraph T319 records that the trip-membership
 * write and the thread-membership write are NOT one transaction, so between a
 * removal and the next `syncTripChatMembers` run a removed member is still on
 * the thread roster. Reading the trip's plan through the thread in that window
 * would be exactly the divergence T319 measures, arriving through a new door.
 *
 * ── "TODAY" IS UTC, AND THIS SAYS SO ────────────────────────────────────────
 * §30A.14 asks for destination/user timezone semantics and census T423 records
 * that Telegraph does not have them. This endpoint therefore states its own
 * frame in the response (`dayFrame: "UTC"`) rather than implying a local one it
 * cannot compute. A traveller two hours ahead of UTC sees the right items on
 * the wrong side of midnight, and the field is how a client knows that.
 */
router.get(
  "/threads/:threadId/trip-context",
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

    const tripId = loaded.ctx.tripId;
    if (loaded.ctx.threadType !== "trip" || !tripId) {
      // NOT APPLICABLE is a different answer from "the plan is empty", and a
      // client that cannot tell them apart will render "nothing planned today"
      // over a direct message.
      res.status(200).json({
        threadId,
        applicable: false,
        tripId: null,
        reason:
          "This conversation is not a trip crew thread, so it has no trip plan to show. " +
          "§20's today/next context is a Trips integration and belongs to threads a trip owns.",
        today: [],
        next: null,
      });
      return;
    }

    // The second gate — see the header.
    const { data: membership, error: mErr } = await client
      .from("trip_members")
      .select("user_id, status")
      .eq("trip_id", tripId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (mErr) {
      log.error({ threadId, tripId, message: mErr.message }, "trip membership read failed");
      sendError(res, "db_error", "Could not verify your membership of this trip");
      return;
    }
    if (!membership || (membership as any).status !== "accepted") {
      sendError(res, "forbidden", "You are not an accepted member of this trip");
      return;
    }

    const { data, error } = await client
      .from("trip_plan_items")
      .select(TRIP_CONTEXT_COLUMNS)
      .eq("trip_id", tripId)
      .is("removed_at", null)
      .limit(TRIP_CONTEXT_SCAN_LIMIT);
    if (error) {
      // An unreadable plan is not an empty day. Answering `today: []` here
      // would tell a crew they have nothing on.
      log.error({ threadId, tripId, message: error.message }, "trip plan read failed");
      sendError(res, "db_error", "Could not read this trip's plan");
      return;
    }

    const rows = ((data as any[]) ?? []).filter((r) => r.removed_at == null);
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);

    const withInstant = rows
      .map((r) => ({ row: r, at: itemInstant(r) }))
      .sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER));

    const isToday = (e: { row: any; at: number | null }) => {
      if (typeof e.row.day_date === "string" && e.row.day_date.length >= 10) {
        return e.row.day_date.slice(0, 10) === todayKey;
      }
      return e.at !== null && new Date(e.at).toISOString().slice(0, 10) === todayKey;
    };

    const today = withInstant.filter(isToday).map((e) => toContextItem(e.row));
    const next =
      withInstant
        .filter((e) => !isToday(e) && e.at !== null && e.at > now.getTime())
        .map((e) => toContextItem(e.row))[0] ?? null;

    res.status(200).json({
      threadId,
      applicable: true,
      tripId,
      generatedAt: now.toISOString(),
      today,
      next,
      /** §30A.14 / census T423 — stated, not implied. See the header. */
      dayFrame: "UTC",
      /**
       * Stated in the response because it is a guarantee and not an accident:
       * this surface does not select `lat` / `lng` from `trip_plan_items`, so
       * there is no branch that could stop stripping them.
       */
      coordinatesReturned: false,
      scanned: rows.length,
      truncated: rows.length >= TRIP_CONTEXT_SCAN_LIMIT,
    });
  }),
);

export default router;
