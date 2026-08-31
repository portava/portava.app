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
import { z } from "zod";
import { logger as rootLogger } from "../lib/logger.js";

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

async function verifyThreadMember(
  client: any,
  threadId: string,
  userId: string,
): Promise<boolean> {
  const { data } = await client
    .from("message_thread_members")
    .select("user_id, left_at")
    .eq("thread_id", threadId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return false;
  return (data as any).left_at === null;
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
  const isMember = await verifyThreadMember(client, threadId, user.id);
  if (!isMember) {
    sendError(res, "forbidden", "You are not an active member of this thread");
    return;
  }

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
            await client.from("telegraph_chat_suggestions").insert(rows);
          }
        }
      }
    }
  }

  // Return current active (non-expired, non-dismissed) suggestions for this user+thread
  const { data: suggestions } = await client
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

    const isMember = await verifyThreadMember(client, threadId, user.id);
    if (!isMember) {
      sendError(res, "forbidden", "Not a thread member");
      return;
    }

    // Fetch suggestion data before updating so we can write the preference event
    const { data: suggestion } = await client
      .from("telegraph_chat_suggestions")
      .select("category, intent_type")
      .eq("id", suggestionId)
      .eq("user_id", user.id)
      .eq("thread_id", threadId)
      .maybeSingle();

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

    const isMember = await verifyThreadMember(client, threadId, user.id);
    if (!isMember) {
      sendError(res, "forbidden", "Not a thread member");
      return;
    }

    const parsed = AddToPlanSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
      return;
    }
    const { tripId, title, dayDate, startsAt } = parsed.data;

    // Verify the acting user is an accepted member of the chosen trip
    const { data: membership } = await client
      .from("trip_members")
      .select("role")
      .eq("trip_id", tripId)
      .eq("user_id", user.id)
      .in("role", ["owner", "member"])
      .maybeSingle();
    if (!membership) {
      sendError(res, "forbidden", "You are not an accepted member of that trip");
      return;
    }

    // Load suggestion for title/context
    const { data: suggestion } = await client
      .from("telegraph_chat_suggestions")
      .select("id, title, location_context, time_context")
      .eq("id", suggestionId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!suggestion) {
      sendError(res, "not_found", "Suggestion not found");
      return;
    }

    const itemTitle = title ?? (suggestion as any).title ?? "Telegraph suggestion";

    const { data: planItem, error: planErr } = await client
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

    // Mark suggestion as acted
    await client
      .from("telegraph_chat_suggestions")
      .update({ status: "acted", acted_on_at: new Date().toISOString() })
      .eq("id", suggestionId)
      .eq("user_id", user.id);

    res.status(200).json({ ok: true, planItem });
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

    const isMember = await verifyThreadMember(client, threadId, user.id);
    if (!isMember) {
      sendError(res, "forbidden", "Not a thread member");
      return;
    }

    const { data: suggestion } = await client
      .from("telegraph_chat_suggestions")
      .select("id, title, location_context, time_context, trip_id, circle_id")
      .eq("id", suggestionId)
      .eq("user_id", user.id)
      .maybeSingle();
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

    // Mark as acted
    await client
      .from("telegraph_chat_suggestions")
      .update({ status: "acted", acted_on_at: new Date().toISOString() })
      .eq("id", suggestionId)
      .eq("user_id", user.id);

    res.status(200).json({ ok: true, prefill });
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

    const isMember = await verifyThreadMember(client, threadId, user.id);
    if (!isMember) {
      sendError(res, "forbidden", "Not a thread member");
      return;
    }

    // Never write server-readable plaintext into an end-to-end encrypted thread.
    // A direct thread can be e2ee and telegraph suggestions surface in DMs, so a
    // poll body (JSON plaintext) would violate the E2EE invariant (audit MSG-3).
    // Mirror the messaging media/text handlers' e2ee_thread refusal.
    const { data: threadMeta } = await client
      .from("message_threads")
      .select("is_e2ee")
      .eq("id", threadId)
      .maybeSingle();
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

    const { data: suggestion } = await client
      .from("telegraph_chat_suggestions")
      .select("id, title")
      .eq("id", suggestionId)
      .eq("user_id", user.id)
      .maybeSingle();
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

    // Mark suggestion as acted
    await client
      .from("telegraph_chat_suggestions")
      .update({ status: "acted", acted_on_at: new Date().toISOString() })
      .eq("id", suggestionId)
      .eq("user_id", user.id);

    res.status(200).json({ ok: true, messageId: (msg as any).id, options });
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
