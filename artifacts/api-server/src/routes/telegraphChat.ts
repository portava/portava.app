/**
 * Telegraph Chat Suggestion routes.
 *
 * GET  /api/threads/:threadId/telegraph/suggestions
 *   Returns active, non-expired suggestions for the authed user in a thread.
 *   Accepts optional ?message=<text> to run live intent detection and persist
 *   new suggestions.
 *
 * POST /api/threads/:threadId/telegraph/suggestions/:id/dismiss
 * POST /api/threads/:threadId/telegraph/suggestions/:id/add-to-plan
 * POST /api/threads/:threadId/telegraph/suggestions/:id/create-meetup
 * POST /api/threads/:threadId/telegraph/suggestions/:id/start-poll
 *
 * PATCH /api/me/telegraph-chat-settings
 *   { show_telegraph_dm?, show_telegraph_trip?, show_telegraph_circle? }
 *
 * Privacy guarantees:
 *   - Thread membership is verified on every call.
 *   - TelegraphChatPrivacyVerdict gates all suggestion generation.
 *   - No GPS or live location is ever returned.
 *   - Trip/circle context is only used when the caller is a confirmed member.
 */

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { logger as rootLogger } from "../lib/logger.js";
import {
  tripKernelClient,
  readCommandEnvelope,
  executeTripCommand,
  sendKernelRejection,
  setTripVersionHeader,
} from "../domain/trips/commands/tripKernel.js";

const chatLogger = rootLogger.child({ route: "telegraphChat" });
import { requireUser, sendError } from "../lib/http.js";
import { detectIntent } from "../services/telegraphIntent.js";
import {
  resolvePrivacyVerdict,
  buildSuggestions,
  checkRateLimit,
  checkCooldown,
  checkCategoryDeclineCooldown,
} from "../services/telegraphChatSuggestions.js";

const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * The answer a membership check may give, as three outcomes rather than two.
 *
 * census-telegraph §20.7: this helper used to discard the read's error and
 * return a bare boolean. supabase-js RESOLVES on a database error rather than
 * throwing, so an unreadable `message_thread_members` produced
 * `{ data: null, error }`, the `!data` branch fired, and every caller told the
 * traveller *"You are not an active member of this thread"* — a positive,
 * specific statement about their relationship to their own conversation, made
 * from a read that never happened.
 *
 * That is not the T344/T363 defect: it denies rather than admits, and a refusal
 * is not a plausible empty state. It is still false, and it is false in the one
 * direction that matters to somebody who needs the conversation — a 403 tells
 * the client the answer is SETTLED and there is nothing to retry, so the app
 * will not recover when the table does.
 *
 * `unreadable` is the third outcome, and it is the same posture the six reads
 * this file already fixed take (`degraded_unavailable`, the only code
 * `lib/http.ts` marks retryable). §20.7 declined to make this change on the
 * grounds that it alters the contract of live routes; it is made here because
 * the alternative contract — "we assert you are not a member" — is a claim the
 * server is not entitled to, and because the same file already accepted exactly
 * this contract change for its other six reads.
 */
type ThreadMembership = "member" | "not_member" | "unreadable";

async function verifyThreadMember(
  client: any,
  threadId: string,
  userId: string,
): Promise<ThreadMembership> {
  const { data, error } = await client
    .from("message_thread_members")
    .select("user_id, left_at")
    .eq("thread_id", threadId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    chatLogger.error({ threadId, userId, message: (error as any).message }, "thread membership read failed");
    return "unreadable";
  }
  if (!data) return "not_member";
  return (data as any).left_at === null ? "member" : "not_member";
}

/**
 * The refusal every caller of `verifyThreadMember` sends, in one place so the
 * two outcomes cannot drift apart at five call sites. Returns true when it
 * refused, so the caller reads as one line.
 */
function refuseUnlessMember(res: any, membership: ThreadMembership, deniedMessage: string): boolean {
  if (membership === "member") return false;
  if (membership === "unreadable") {
    sendError(
      res,
      "degraded_unavailable",
      "We could not check your membership of this conversation just now. Please try again shortly.",
    );
    return true;
  }
  sendError(res, "forbidden", deniedMessage);
  return true;
}

/**
 * Retire a suggestion after its action succeeded.
 *
 * The action's primary side effect (plan item, prefill, poll message) has
 * already been committed by the time this runs, so a failure here must NOT turn
 * into a refusal: the caller would retry and duplicate that side effect. It must
 * also not be swallowed — an un-retired card stays on screen and invites exactly
 * that duplicate. So the failure is logged and reported to the caller as
 * `suggestionRetired: false` alongside the successful primary result.
 *
 * This is the one silent write in this file that `refuseUnlessMember`'s
 * `degraded_unavailable` posture does NOT fit: everything else here fails before
 * it has changed anything, and may honestly ask the client to retry. This one
 * cannot.
 */
async function markSuggestionActed(
  client: any,
  suggestionId: string,
  userId: string,
): Promise<boolean> {
  const { error } = await client
    .from("telegraph_chat_suggestions")
    .update({ status: "acted", acted_on_at: new Date().toISOString() })
    .eq("id", suggestionId)
    .eq("user_id", userId);
  if (error) {
    chatLogger.error({ err: error, suggestionId, userId }, "suggestion acted-status update failed");
    return false;
  }
  return true;
}

// ── GET /api/threads/:threadId/telegraph/suggestions ─────────────────────────

router.get("/threads/:threadId/telegraph/suggestions", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const { threadId } = req.params;

  if (!UUID.test(threadId)) {
    sendError(res, "invalid_payload", "Invalid threadId");
    return;
  }

  // Verify active membership
  const membership = await verifyThreadMember(client, threadId, user.id);
  if (refuseUnlessMember(res, membership, "You are not an active member of this thread")) return;

  // Optionally run intent detection on a new message body
  const messageText = typeof req.query.message === "string" ? req.query.message : null;

  if (messageText && messageText.trim().length >= 6) {
    const intent = detectIntent(messageText);
    if (intent) {
      const verdict = await resolvePrivacyVerdict(client, user.id, threadId);
      if (verdict.canShowRecommendation) {
        const withinLimit = await checkRateLimit(client, user.id, threadId);
        const notInCooldown = await checkCooldown(
          client,
          user.id,
          threadId,
          intent.intent,
        );
        if (withinLimit && notInCooldown) {
          const allCards = buildSuggestions(user.id, threadId, intent, verdict);
          // Filter out categories the user has declined within the last 24 hours
          const cards: typeof allCards = [];
          for (const card of allCards) {
            const categoryOk = await checkCategoryDeclineCooldown(client, user.id, card.category);
            if (categoryOk) cards.push(card);
          }
          if (cards.length > 0) {
            const rows = cards.map((c) => ({
              thread_id: threadId,
              user_id: user.id,
              trip_id: verdict.tripId ?? null,
              circle_id: verdict.circleOwnerId ?? null,
              intent_type: c.intent_type,
              title: c.title,
              reason: c.reason,
              category: c.category,
              action_type: c.action_type,
              location_context: c.location_context ?? null,
              time_context: c.time_context ?? null,
              status: "shown",
            }));
            // The generated cards are only ever surfaced by re-reading this
            // table below. A discarded insert error therefore renders as an
            // empty suggestion list — indistinguishable from "nothing to
            // suggest" — so the write must be checked and surfaced.
            const { error: insertErr } = await client
              .from("telegraph_chat_suggestions")
              .insert(rows);
            if (insertErr) {
              chatLogger.error(
                { err: insertErr, threadId, userId: user.id, count: rows.length },
                "telegraph suggestion insert failed",
              );
              sendError(res, "db_error", "Failed to store Telegraph suggestions", {
                exposeDetail: true,
              });
              return;
            }
          }
        }
      }
    }
  }

  // Return current active (non-expired, non-dismissed) suggestions for this user+thread
  const { data: suggestions, error: suggestionsErr } = await client
    .from("telegraph_chat_suggestions")
    .select(
      "id, intent_type, title, reason, category, action_type, location_context, time_context, created_at, expires_at",
    )
    .eq("user_id", user.id)
    .eq("thread_id", threadId)
    .eq("status", "shown")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(2);

  if (suggestionsErr) {
    chatLogger.error({ err: suggestionsErr, threadId, userId: user.id },
      "telegraph suggestions read failed — refusing rather than answering that there are none");
    sendError(res, "degraded_unavailable",
      "We could not load Telegraph suggestions right now. Please try again shortly.");
    return;
  }
  res.status(200).json({ suggestions: suggestions ?? [] });
});

// ── POST .../dismiss ──────────────────────────────────────────────────────────

router.post(
  "/threads/:threadId/telegraph/suggestions/:suggestionId/dismiss",
  async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId, suggestionId } = req.params;

    if (!UUID.test(threadId) || !UUID.test(suggestionId)) {
      sendError(res, "invalid_payload", "Invalid ID");
      return;
    }

    const membership = await verifyThreadMember(client, threadId, user.id);
    if (refuseUnlessMember(res, membership, "Not a thread member")) return;

    // Fetch suggestion data before updating so we can write the preference event.
    // The event is best-effort (see the warn below), so a failed READ does not
    // refuse the dismiss — but it must not be indistinguishable from "there was
    // no such suggestion", which is what discarding the error made it.
    const { data: suggestion, error: suggestionErr } = await client
      .from("telegraph_chat_suggestions")
      .select("category, intent_type")
      .eq("id", suggestionId)
      .eq("user_id", user.id)
      .eq("thread_id", threadId)
      .maybeSingle();
    if (suggestionErr) {
      chatLogger.error({ err: suggestionErr, suggestionId, threadId },
        "dismiss preference read failed — no preference event will be written, and that is a failure, not an absent suggestion");
    }

    // The UPDATE below is scoped by (id, user_id, thread_id) and matches zero
    // rows when the suggestion does not exist or belongs to someone else — no
    // error, so the handler used to answer `ok: true` for a dismissal that
    // never happened. Every sibling action already 404s here; so does this one.
    //
    // `!suggestionErr &&` is load-bearing, and it is what the branch above buys:
    // a FAILED read ALSO leaves `suggestion` null, and 404-ing on that would
    // trade one false report ("dismissed") for another ("no such suggestion"),
    // both made from a read that never happened. An unreadable suggestion is not
    // an absent one, so the dismiss proceeds and answers for its own write —
    // which is the posture main chose for this handler deliberately.
    if (!suggestionErr && !suggestion) {
      sendError(res, "not_found", "Suggestion not found");
      return;
    }

    const { error } = await client
      .from("telegraph_chat_suggestions")
      .update({ status: "dismissed", dismissed_at: new Date().toISOString() })
      .eq("id", suggestionId)
      .eq("user_id", user.id)
      .eq("thread_id", threadId);

    if (error) {
      sendError(res, "db_error", "Failed to dismiss suggestion", { exposeDetail: true });
      return;
    }

    // Write preference event so the learning system can down-rank this category
    // and the 24-hour cooldown suppresses the same category from resurfacing (best-effort).
    if (suggestion) {
      const { error: evtError } = await client.from("user_preference_events").insert({
        user_id:           user.id,
        recommendation_id: suggestionId,
        category:          (suggestion as any).category ?? "unknown",
        signal:            "dismiss",
        created_at:        new Date().toISOString(),
      });
      if (evtError) chatLogger.warn({ err: evtError, suggestionId }, "dismiss preference event insert failed (best-effort)");
    }

    res.status(200).json({ ok: true });
  },
);

// ── POST .../add-to-plan ──────────────────────────────────────────────────────

const AddToPlanSchema = z.object({
  tripId: z.string().regex(UUID, "tripId must be a valid UUID"),
  title: z.string().max(200).optional(),
  dayDate: z.string().optional(),
  startsAt: z.string().optional(),
});

router.post(
  "/threads/:threadId/telegraph/suggestions/:suggestionId/add-to-plan",
  async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId, suggestionId } = req.params;

    if (!UUID.test(threadId) || !UUID.test(suggestionId)) {
      sendError(res, "invalid_payload", "Invalid ID");
      return;
    }

    const membership = await verifyThreadMember(client, threadId, user.id);
    if (refuseUnlessMember(res, membership, "Not a thread member")) return;

    const parsed = AddToPlanSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
      return;
    }
    const { tripId, title, dayDate, startsAt } = parsed.data;

    // Verify the acting user is an accepted member of the chosen trip.
    // §20.7 again: an unreadable `trip_members` used to answer "You are not an
    // accepted member of that trip" from a read that never happened.
    const { data: tripMembership, error: tripMembershipErr } = await client
      .from("trip_members")
      .select("role")
      .eq("trip_id", tripId)
      .eq("user_id", user.id)
      .in("role", ["owner", "member"])
      .maybeSingle();
    if (tripMembershipErr) {
      chatLogger.error(
        { threadId, tripId, userId: user.id, message: (tripMembershipErr as any).message },
        "trip membership read failed",
      );
      sendError(
        res,
        "degraded_unavailable",
        "We could not check your membership of that trip just now. Please try again shortly.",
      );
      return;
    }
    if (!tripMembership) {
      sendError(res, "forbidden", "You are not an accepted member of that trip");
      return;
    }

    // Load suggestion for title/context
    const { data: suggestion, error: suggestionErr } = await client
      .from("telegraph_chat_suggestions")
      .select("id, title, location_context, time_context")
      .eq("id", suggestionId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (suggestionErr) {
      chatLogger.error({ err: suggestionErr, suggestionId, threadId },
        "suggestion read failed on the add-to-trip path — refusing rather than reporting the suggestion as nonexistent");
      sendError(res, "degraded_unavailable",
        "We could not open that suggestion right now. Please try again shortly.");
      return;
    }
    if (!suggestion) {
      sendError(res, "not_found", "Suggestion not found");
      return;
    }

    const itemTitle = title ?? (suggestion as any).title ?? "Telegraph suggestion";

    // Trip Kernel path (§4.1 ADD_PLAN, capability crew). The thread-member and
    // trip-member checks above are the authorization; the kernel re-checks
    // crew. The direct insert names eight columns and leaves category, status,
    // sort_order, visibility, lock_type and location_is_private at their table
    // defaults; the kernel's defaults are the same values, and
    // location_is_private is sent explicitly so the row matches under a 2500
    // function too. Off => the insert below.
    const kernel = await tripKernelClient();
    let kernelPlanItem: { id: string; title: string } | null = null;
    if (kernel) {
      const env = readCommandEnvelope(req);
      if (!env.ok) { sendError(res, "invalid_payload", env.message); return; }
      const r = await executeTripCommand(kernel, {
        commandId: randomUUID(),
        tripId,
        actorUserId: user.id,   // always from token
        expectedTripVersion: env.expectedTripVersion,
        idempotencyKey: env.idempotencyKey,
        type: "ADD_PLAN",
        payload: {
          title: itemTitle,
          source_type: "telegraph",
          source_id: suggestionId,
          day_date: dayDate ?? null,
          starts_at: startsAt ?? null,
          notes: (suggestion as any).location_context ?? null,
          location_is_private: true,
        },
      });
      if (!r.ok) { sendKernelRejection(res, r, req.log); return; }
      setTripVersionHeader(res, r.version);
      kernelPlanItem = { id: r.result.id, title: r.result.title };
    }

    // trip-kernel:legacy-path — flag-off twin of ADD_PLAN above.
    const { data: planItem, error: planErr } = kernelPlanItem
      ? { data: kernelPlanItem, error: null }
      : await client
      .from("trip_plan_items")
      .insert({
        trip_id: tripId,
        creator_id: user.id,
        title: itemTitle,
        source_type: "telegraph",
        source_id: suggestionId,
        day_date: dayDate ?? null,
        starts_at: startsAt ?? null,
        notes: (suggestion as any).location_context ?? null,
      })
      .select("id, title")
      .single();

    if (planErr) {
      sendError(res, "db_error", "Failed to add to plan", { exposeDetail: true });
      return;
    }

    const retired = await markSuggestionActed(client, suggestionId, user.id);

    res.status(200).json({ ok: true, planItem, suggestionRetired: retired });
  },
);

// ── POST .../create-meetup ────────────────────────────────────────────────────

router.post(
  "/threads/:threadId/telegraph/suggestions/:suggestionId/create-meetup",
  async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId, suggestionId } = req.params;

    if (!UUID.test(threadId) || !UUID.test(suggestionId)) {
      sendError(res, "invalid_payload", "Invalid ID");
      return;
    }

    const membership = await verifyThreadMember(client, threadId, user.id);
    if (refuseUnlessMember(res, membership, "Not a thread member")) return;

    const { data: suggestion, error: suggestionErr } = await client
      .from("telegraph_chat_suggestions")
      .select("id, title, location_context, time_context, trip_id, circle_id")
      .eq("id", suggestionId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (suggestionErr) {
      chatLogger.error({ err: suggestionErr, suggestionId, threadId },
        "suggestion read failed on the meetup prefill path — refusing rather than reporting the suggestion as nonexistent");
      sendError(res, "degraded_unavailable",
        "We could not open that suggestion right now. Please try again shortly.");
      return;
    }
    if (!suggestion) {
      sendError(res, "not_found", "Suggestion not found");
      return;
    }

    // Return prefill data — actual meetup created by the meetup endpoint after user confirms
    const prefill = {
      title: (suggestion as any).title ?? "",
      location: (suggestion as any).location_context ?? "",
      suggestedTime: (suggestion as any).time_context ?? null,
      tripId: (suggestion as any).trip_id ?? null,
      threadId,
    };

    const retired = await markSuggestionActed(client, suggestionId, user.id);

    res.status(200).json({ ok: true, prefill, suggestionRetired: retired });
  },
);

// ── POST .../start-poll ───────────────────────────────────────────────────────

const StartPollSchema = z.object({
  options: z
    .array(z.string().max(100))
    .min(2)
    .max(6)
    .default(["Morning", "Afternoon", "Evening"]),
  question: z.string().max(200).optional(),
});

router.post(
  "/threads/:threadId/telegraph/suggestions/:suggestionId/start-poll",
  async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId, suggestionId } = req.params;

    if (!UUID.test(threadId) || !UUID.test(suggestionId)) {
      sendError(res, "invalid_payload", "Invalid ID");
      return;
    }

    const membership = await verifyThreadMember(client, threadId, user.id);
    if (refuseUnlessMember(res, membership, "Not a thread member")) return;

    // Never write server-readable plaintext into an end-to-end encrypted thread.
    // A direct thread can be e2ee and telegraph suggestions surface in DMs, so a
    // poll body (JSON plaintext) would violate the E2EE invariant (audit MSG-3).
    // Mirror the messaging media/text handlers' e2ee_thread refusal.
    const { data: threadMeta, error: threadMetaErr } = await client
      .from("message_threads")
      .select("is_e2ee")
      .eq("id", threadId)
      .maybeSingle();
    if (threadMetaErr) {
      // An unreadable flag read as `is_e2ee: false` and let a plaintext poll
      // body through the one gate that exists to stop it. Same refusal as
      // routes/messaging.ts on the media path, which binds this identical read.
      chatLogger.error({ err: threadMetaErr, threadId },
        "thread E2EE flag read failed on the poll path — refusing rather than admitting plaintext into an E2EE thread");
      sendError(res, "degraded_unavailable",
        "We could not verify this conversation right now. Please try again shortly.");
      return;
    }
    if ((threadMeta as any)?.is_e2ee === true) {
      sendError(res, "e2ee_thread", "Polls are not supported on end-to-end encrypted threads");
      return;
    }

    const parsed = StartPollSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
      return;
    }

    const { options, question } = parsed.data;

    const { data: suggestion, error: suggestionErr } = await client
      .from("telegraph_chat_suggestions")
      .select("id, title")
      .eq("id", suggestionId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (suggestionErr) {
      chatLogger.error({ err: suggestionErr, suggestionId, threadId },
        "suggestion read failed on the poll path — refusing rather than reporting the suggestion as nonexistent");
      sendError(res, "degraded_unavailable",
        "We could not open that suggestion right now. Please try again shortly.");
      return;
    }
    if (!suggestion) {
      sendError(res, "not_found", "Suggestion not found");
      return;
    }

    // Post a poll message into the thread as a system card (body is JSON-encoded)
    const pollBody = JSON.stringify({
      type: "time_poll",
      question: question ?? `When works for everyone? (${(suggestion as any).title})`,
      options,
      votes: {},
      createdBy: user.id,
    });

    const { data: msg, error: msgErr } = await client
      .from("messages")
      .insert({
        thread_id: threadId,
        sender_id: user.id,
        body: pollBody,
      })
      .select("id")
      .single();

    if (msgErr) {
      sendError(res, "db_error", "Failed to create poll", { exposeDetail: true });
      return;
    }

    const retired = await markSuggestionActed(client, suggestionId, user.id);

    res.status(200).json({ ok: true, messageId: (msg as any).id, options, suggestionRetired: retired });
  },
);

router.get("/me/telegraph-chat-settings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const { data, error } = await client
    .from("profiles")
    .select("show_telegraph_dm, show_telegraph_trip, show_telegraph_circle")
    .eq("id", user.id)
    .maybeSingle();
  if (error || !data) {
    sendError(res, "db_error", "Failed to load Telegraph settings", { exposeDetail: true });
    return;
  }
  res.status(200).json({ ok: true, settings: data });
});

// ── PATCH /api/me/telegraph-chat-settings ────────────────────────────────────

const SettingsSchema = z.object({
  show_telegraph_dm: z.boolean().optional(),
  show_telegraph_trip: z.boolean().optional(),
  show_telegraph_circle: z.boolean().optional(),
});

router.patch("/me/telegraph-chat-settings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = SettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  if (Object.keys(parsed.data).length === 0) {
    sendError(res, "invalid_payload", "At least one setting is required");
    return;
  }

  const { error } = await client
    .from("profiles")
    .update(parsed.data)
    .eq("id", user.id);

  if (error) {
    sendError(res, "db_error", "Failed to update Telegraph settings", { exposeDetail: true });
    return;
  }

  res.status(200).json({ ok: true, settings: parsed.data });
});

export default router;
