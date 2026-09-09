/**
 * Telegraph Chat Suggestions — privacy resolver + suggestion builder.
 *
 * TelegraphChatPrivacyVerdict determines what context is safe to use for
 * a given (userId, threadId) pair. The suggestion builder assembles up to
 * 2 suggestion cards per tray using only the gated context.
 *
 * Hard rules (mirrors product spec):
 *   - No exact GPS or live location returned in any suggestion
 *   - Trip context only available if user is an accepted trip member
 *   - Circle context only available if user is an accepted circle member
 *   - Non-members get canShowRecommendation: false
 *   - An UNREADABLE `profiles` row (a resolved PostgREST error, not an absent
 *     row) gets canShowRecommendation: false and reason
 *     "telegraph_settings_unavailable" — the opt-out defaults to ON, so a read
 *     failure must not be allowed to look like consent.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../lib/logger.js";
import type { IntentResult } from "./telegraphIntent.js";

export interface TelegraphChatPrivacyVerdict {
  canUseTripContext: boolean;
  canUseCircleContext: boolean;
  canUseAvailability: boolean;
  canShowRecommendation: boolean;
  reason: string;
  tripId: string | null;
  circleOwnerId: string | null;
  tripDestination: string | null;
  threadType: "direct" | "trip" | "circle";
}

export interface SuggestionCard {
  id: string;
  intent_type: string;
  title: string;
  reason: string;
  category: string;
  action_type: "add_to_plan" | "create_meetup" | "start_time_poll" | "view_place";
  location_context: string | null;
  time_context: string | null;
}

const CATEGORY_FOR_INTENT: Record<string, string> = {
  food: "food",
  nightlife: "nightlife",
  beach: "beach",
  attraction: "attraction",
  transport: "transport",
  find_place: "activity",
  suggest_activity: "activity",
  create_meetup: "meetup",
  add_to_plan: "plan",
  time_poll: "poll",
  availability_match: "availability",
  general_plan: "activity",
};

const ACTION_FOR_INTENT: Record<
  string,
  "add_to_plan" | "create_meetup" | "start_time_poll" | "view_place"
> = {
  food: "view_place",
  nightlife: "view_place",
  beach: "view_place",
  attraction: "view_place",
  transport: "view_place",
  find_place: "view_place",
  suggest_activity: "view_place",
  create_meetup: "create_meetup",
  add_to_plan: "add_to_plan",
  time_poll: "start_time_poll",
  availability_match: "start_time_poll",
  general_plan: "add_to_plan",
};

/**
 * Resolve what context is safe to use for generating suggestions.
 */
export async function resolvePrivacyVerdict(
  client: SupabaseClient,
  userId: string,
  threadId: string,
): Promise<TelegraphChatPrivacyVerdict> {
  // Load thread metadata
  const { data: thread } = await client
    .from("message_threads")
    .select("id, thread_type, trip_id, circle_owner_id")
    .eq("id", threadId)
    .maybeSingle();

  if (!thread) {
    return {
      canUseTripContext: false,
      canUseCircleContext: false,
      canUseAvailability: false,
      canShowRecommendation: false,
      reason: "thread_not_found",
      tripId: null,
      circleOwnerId: null,
      tripDestination: null,
      threadType: "direct",
    };
  }

  const threadType = (thread as any).thread_type ?? "direct";
  const tripId = (thread as any).trip_id ?? null;
  const circleOwnerId = (thread as any).circle_owner_id ?? null;

  // Trip context: only if user is accepted trip member
  let canUseTripContext = false;
  let tripDestination: string | null = null;
  if (threadType === "trip" && tripId) {
    const { data: membership } = await client
      .from("trip_members")
      .select("role")
      .eq("trip_id", tripId)
      .eq("user_id", userId)
      .in("role", ["owner", "member"])
      .maybeSingle();
    canUseTripContext = Boolean(membership);

    if (canUseTripContext) {
      const { data: trip } = await client
        .from("trips")
        .select("destination_city, destination_country")
        .eq("id", tripId)
        .maybeSingle();
      tripDestination =
        (trip as any)?.destination_city ??
        (trip as any)?.destination_country ??
        null;
    }
  }

  // Circle context: only if user is accepted circle member
  let canUseCircleContext = false;
  if (threadType === "circle" && circleOwnerId) {
    if (userId === circleOwnerId) {
      canUseCircleContext = true;
    } else {
      const { data: cm } = await client
        .from("circle_memberships")
        .select("other_id")
        .eq("user_id", circleOwnerId)
        .eq("other_id", userId)
        .maybeSingle();
      canUseCircleContext = Boolean(cm);
    }
  }

  // ── The user's own telegraph opt-out (FAIL-CLOSED on an unreadable read) ──
  //
  // `show_telegraph_*` are OPT-OUTS: the product default is on, so the test is
  // `!== false` and an ABSENT column or row correctly means "enabled". That is
  // right for a user who has never touched the setting, and it was wrong for a
  // user who has: supabase-js RESOLVES on a database error, so a failed read
  // arrives as `profile === null`, `undefined !== false` is true, and a user who
  // set `show_telegraph_dm = false` had suggestions generated into their chat —
  // and persisted, since routes/telegraphChat.ts inserts the shown cards.
  //
  // An opt-out we could not read is not an opt-out we may ignore. On a read
  // error the verdict withholds, and it says so in `reason` with a value
  // distinct from "telegraph_disabled": a caller (or a log reader) must be able
  // to tell "this user turned it off" apart from "we could not find out".
  const { data: profile, error: profileErr } = await client
    .from("profiles")
    .select("show_telegraph_dm, show_telegraph_trip, show_telegraph_circle")
    .eq("id", userId)
    .maybeSingle();

  const settingKey =
    threadType === "trip"
      ? "show_telegraph_trip"
      : threadType === "circle"
        ? "show_telegraph_circle"
        : "show_telegraph_dm";

  if (profileErr) {
    logger.error(
      { err: profileErr, userId, threadId, threadType },
      "telegraphChatSuggestions: could not read the viewer's show_telegraph_* opt-outs — " +
        "suppressing suggestions rather than assuming consent",
    );
  }
  const telegraphEnabled = !profileErr && (profile as any)?.[settingKey] !== false;

  // Non-members of trip/circle chats cannot see suggestions
  if (threadType === "trip" && !canUseTripContext) {
    return {
      canUseTripContext: false,
      canUseCircleContext: false,
      canUseAvailability: false,
      canShowRecommendation: false,
      reason: "not_trip_member",
      tripId,
      circleOwnerId,
      tripDestination: null,
      threadType,
    };
  }
  if (threadType === "circle" && !canUseCircleContext) {
    return {
      canUseTripContext: false,
      canUseCircleContext: false,
      canUseAvailability: false,
      canShowRecommendation: false,
      reason: "not_circle_member",
      tripId,
      circleOwnerId,
      tripDestination: null,
      threadType,
    };
  }

  return {
    canUseTripContext,
    canUseCircleContext,
    canShowRecommendation: telegraphEnabled,
    canUseAvailability: false, // availability feature gated in future
    reason: profileErr
      ? "telegraph_settings_unavailable"
      : telegraphEnabled
        ? "ok"
        : "telegraph_disabled",
    tripId,
    circleOwnerId,
    tripDestination,
    threadType,
  };
}

/**
 * Build up to 2 suggestion cards for a given intent + privacy verdict.
 * Returns empty array if verdict blocks suggestions.
 */
export function buildSuggestions(
  userId: string,
  threadId: string,
  intent: IntentResult,
  verdict: TelegraphChatPrivacyVerdict,
): SuggestionCard[] {
  if (!verdict.canShowRecommendation) return [];

  const intentType = intent.intent;
  const category = CATEGORY_FOR_INTENT[intentType] ?? "activity";
  const actionType = ACTION_FOR_INTENT[intentType] ?? "view_place";
  const dest = verdict.tripDestination ?? "your destination";

  const cards: Omit<SuggestionCard, "id">[] = [];

  // Primary card based on intent
  const primary = buildPrimaryCard(intentType, category, actionType, dest, verdict);
  if (primary) cards.push(primary);

  // Secondary card — complementary action when applicable
  const secondary = buildSecondaryCard(intentType, dest, verdict);
  if (secondary && cards.length < 2) cards.push(secondary);

  return cards.map((c) => ({
    ...c,
    id: `${threadId}_${userId}_${intentType}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  }));
}

function buildPrimaryCard(
  intentType: string,
  category: string,
  actionType: "add_to_plan" | "create_meetup" | "start_time_poll" | "view_place",
  dest: string,
  verdict: TelegraphChatPrivacyVerdict,
): Omit<SuggestionCard, "id"> | null {
  switch (intentType) {
    case "food":
      return {
        intent_type: intentType,
        title: `Find great food in ${dest}`,
        reason: "Telegraph detected food planning in your conversation.",
        category,
        action_type: "view_place",
        location_context: dest !== "your destination" ? dest : null,
        time_context: null,
      };
    case "nightlife":
      return {
        intent_type: intentType,
        title: `Nightlife spots near ${dest}`,
        reason: "Telegraph noticed you're planning a night out.",
        category,
        action_type: "view_place",
        location_context: dest !== "your destination" ? dest : null,
        time_context: "Evening",
      };
    case "beach":
      return {
        intent_type: intentType,
        title: `Best beaches near ${dest}`,
        reason: "Telegraph detected beach planning in your chat.",
        category,
        action_type: "view_place",
        location_context: dest !== "your destination" ? dest : null,
        time_context: null,
      };
    case "attraction":
      return {
        intent_type: intentType,
        title: `Things to do in ${dest}`,
        reason: "Telegraph noticed you're looking for activities.",
        category,
        action_type: "view_place",
        location_context: dest !== "your destination" ? dest : null,
        time_context: null,
      };
    case "transport":
      return {
        intent_type: intentType,
        title: `Getting around ${dest}`,
        reason: "Telegraph detected a transport question in your chat.",
        category,
        action_type: "view_place",
        location_context: null,
        time_context: null,
      };
    case "create_meetup":
      return {
        intent_type: intentType,
        title: "Schedule a meetup",
        reason: "Telegraph detected meetup planning in your conversation.",
        category: "meetup",
        action_type: "create_meetup",
        location_context: verdict.tripDestination ?? null,
        time_context: null,
      };
    case "time_poll":
    case "availability_match":
      return {
        intent_type: intentType,
        title: "Start a time poll",
        reason: "Telegraph detected availability discussion — find the best time for everyone.",
        category: "poll",
        action_type: "start_time_poll",
        location_context: null,
        time_context: null,
      };
    case "add_to_plan":
      return {
        intent_type: intentType,
        title: "Add idea to your trip plan",
        reason: "Telegraph noticed you might want to save something to your itinerary.",
        category: "plan",
        action_type: "add_to_plan",
        location_context: verdict.tripDestination ?? null,
        time_context: null,
      };
    case "find_place":
    case "suggest_activity":
    case "general_plan":
    default:
      return {
        intent_type: intentType,
        title: `Activity ideas for ${dest}`,
        reason: "Telegraph detected travel planning in your conversation.",
        category: "activity",
        action_type: "view_place",
        location_context: dest !== "your destination" ? dest : null,
        time_context: null,
      };
  }
}

function buildSecondaryCard(
  intentType: string,
  dest: string,
  verdict: TelegraphChatPrivacyVerdict,
): Omit<SuggestionCard, "id"> | null {
  // Only add secondary card when trip context is available (more meaningful)
  if (!verdict.canUseTripContext && !verdict.canUseCircleContext) return null;

  if (intentType === "food" || intentType === "nightlife" || intentType === "attraction") {
    return {
      intent_type: "create_meetup",
      title: "Turn it into a meetup",
      reason: "Lock in a time and invite your travel crew.",
      category: "meetup",
      action_type: "create_meetup",
      location_context: verdict.tripDestination ?? null,
      time_context: null,
    };
  }
  if (intentType === "create_meetup") {
    return {
      intent_type: "time_poll",
      title: "Start a time poll first",
      reason: "Not sure when? Let everyone vote on the best time.",
      category: "poll",
      action_type: "start_time_poll",
      location_context: null,
      time_context: null,
    };
  }
  return null;
}

/**
 * Check rate limits: max 3 suggestions shown per thread per hour.
 * Returns true if a new suggestion can be shown.
 *
 * ── AN UNCOUNTABLE LIMIT IS A REACHED LIMIT ─────────────────────────────────
 * supabase-js RESOLVES on a DB error, so `const { count } = await …` produced
 * `count: undefined` — coerced by `?? 0` to ZERO — for both "no suggestions in
 * the last hour" and "telegraph_chat_suggestions could not be read". Zero is
 * the maximally permissive count: the cap could never be reached while the
 * table was unreadable, and every detected intent inserted another suggestion
 * row into that same table.
 *
 * An uncountable cap therefore answers "not within limit". The whole effect is
 * that ONE suggestion card is not shown on ONE message — the thread, its
 * messages and every other part of the response are untouched (shape 2 of
 * lib/exclusionSet.ts). Nothing is disclosed, denied or written.
 */
export async function checkRateLimit(
  client: SupabaseClient,
  userId: string,
  threadId: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error } = await client
    .from("telegraph_chat_suggestions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .gte("created_at", cutoff);
  if (error) return false; // cap unknown — do not show
  return (count ?? 0) < 3;
}

/**
 * Check cooldown: has this intent already been shown/dismissed in the last
 * 30 minutes for this (user, thread)?  Prevents instant re-surfacing.
 *
 * Returns true when it is safe to show. TWO ways this used to clear a cooldown
 * that was actually in force, both of them the same defect wearing different
 * clothes:
 *
 *   1. A DB error. supabase-js RESOLVES rather than throwing, so the failed
 *      read arrived as `{ data: null, error }` and `!data` said "no cooldown".
 *   2. `.maybeSingle()` RAISES on more than one row. Showing the same intent
 *      twice inside the window — which is exactly what a cooldown bug looks
 *      like — produced two rows, maybeSingle turned that into an error, and
 *      case 1 then cleared the cooldown. The STRONGEST evidence of a cooldown
 *      was read as its absence. `checkCategoryDeclineCooldown` below already
 *      documents this trap and uses `.limit(1)`; so does this now.
 *
 * An unknown cooldown answers "in cooldown" — one suggestion card is withheld
 * from one response and nothing else changes.
 */
export async function checkCooldown(
  client: SupabaseClient,
  userId: string,
  threadId: string,
  intentType: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from("telegraph_chat_suggestions")
    .select("id, status")
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .eq("intent_type", intentType)
    .gte("created_at", cutoff)
    .limit(1);
  if (error) return false; // cooldown state unknown — do not show
  return !data || (data as any[]).length === 0; // true = no cooldown, safe to show
}

/**
 * Check 24-hour decline cooldown: has the user dismissed a suggestion in this
 * category within the last 24 hours?  Returns true when safe to show (no
 * recent decline), false when the category should be suppressed.
 *
 * Uses limit(1) instead of maybeSingle() so multiple matching rows don't
 * collapse to data=null and accidentally clear the cooldown.
 */
export async function checkCategoryDeclineCooldown(
  client: SupabaseClient,
  userId: string,
  category: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from("user_preference_events")
    .select("user_id")
    .eq("user_id", userId)
    .eq("category", category)
    .eq("signal", "dismiss")
    .gte("created_at", cutoff)
    .limit(1);
  // The dismissal IS the user's stated preference, and this read is the only
  // place it is honoured. supabase-js RESOLVES on a DB error, so a dropped
  // `.error` made "user_preference_events could not be read" identical to "the
  // user has not declined anything" — and re-surfaced a category they
  // explicitly dismissed. An unreadable preference resolves the
  // privacy-preserving way: assume the decline stands and suppress the card.
  if (error) return false; // decline history unknown — respect the stricter answer
  return !data || (data as any[]).length === 0; // true = no recent decline, safe to show
}
