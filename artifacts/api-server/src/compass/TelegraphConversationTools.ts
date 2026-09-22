/**
 * Telegraph §18.3 — the Compass tool boundary, as eight tools.
 *
 * §18.3 names exactly eight accessors:
 *   getConversationContext()  getSharedPlans()  getParticipantAvailability()
 *   getSharedPlaces()  suggestMeetingPoint()  createPlanDraft()
 *   findSafePublicMeetup()  searchAuthorizedConversationContent()
 * followed by the sentence that decides what they may return: "Compass sees
 * only data authorized to the conversational context. It cannot reveal one
 * participant's private Memory/preferences to another, impersonate
 * participants, or silently create canonical plans from uncertain prose."
 *
 * census-telegraph T244-T251 measured six of the eight as absent from the tool
 * set and two as present-under-another-name-and-surface: `getConversationContext`
 * was `GET /telegraph-chat/suggestions?message=<text>` over ONE message, and
 * `createPlanDraft` was `create_meetup_draft` inside `routes/telegraphCommands.ts`.
 * The privacy posture of both was right; the accessors the spec names did not
 * exist. These are the accessors.
 *
 * ONE GATE, CALLED BY ALL EIGHT
 * =============================
 * Every tool below starts at `gateConversation`, which does three things in
 * order and refuses at the first failure:
 *   1. ACTIVE MEMBERSHIP of the caller, read fail-closed. An unreadable
 *      membership row refuses; it never reads as "no restriction".
 *   2. `resolvePrivacyVerdict` — the existing Telegraph opt-out and
 *      trip/circle-membership resolver, unchanged and not reimplemented.
 *   3. The §14 capability set, so a tool cannot offer an action the
 *      conversation refuses (a plan draft in a thread whose `canCreatePlan`
 *      is false is not a draft, it is a suggestion the user cannot take).
 *
 * The gate returns a refusal OBJECT rather than throwing, because
 * `executeCompassTool` turns a throw into "Tool execution failed" — which is
 * indistinguishable from a bug and tells the model nothing. A refusal that says
 * `authorized: false` with a reason lets the model say the true thing.
 *
 * WHAT THESE TOOLS STRUCTURALLY CANNOT RETURN
 * ===========================================
 *   - Coordinates or live location. No tool selects a coordinate column, and
 *     `executeCompassTool` runs every result through `sanitizeToolResult`
 *     afterwards as defence in depth.
 *   - Another participant's private preferences or Memories. Availability is
 *     read through `projectPublicWindows`, which returns only EXPLICIT,
 *     non-expired windows whose own visibility policy admits this viewer — so
 *     the participant's own setting, not this tool, decides.
 *   - A canonical write. `telegraph_create_plan_draft` returns
 *     `requiresConfirmation: true` and a draft; it writes nothing, and the
 *     confirm path is the existing `POST /telegraph/commands/:id/confirm`
 *     which re-verifies trip membership at execution.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { logger as rootLogger } from "../lib/logger.js";
import { getNearbyVenues, type NearbyVenue } from "../lib/venuesService.js";
import { resolvePrivacyVerdict, type TelegraphChatPrivacyVerdict } from "../services/telegraphChatSuggestions.js";
import { resolveConversationCapabilities } from "../domain/telegraph/policies/conversationCapabilityPolicy.js";
import type { ConversationCapabilities } from "../domain/telegraph/contracts/conversationCapabilities.js";
import { searchConversations } from "../services/telegraphSearch.js";
import {
  historyBoundEnabled,
  membershipSelect,
  visibleFromOf,
  withinWindow,
} from "../services/groupChatHistoryBound.js";
import { projectPublicWindows, type ViewerRelationship } from "../services/passport/OpenToPlansService.js";

const log = rootLogger.child({ mod: "telegraphCompassTools" });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** §18.3's eight names, in the spec's order, mapped to the tool names used here. */
export const TELEGRAPH_TOOL_SPEC_NAMES: Readonly<Record<string, string>> = {
  "getConversationContext()": "telegraph_get_conversation_context",
  "getSharedPlans()": "telegraph_get_shared_plans",
  "getParticipantAvailability()": "telegraph_get_participant_availability",
  "getSharedPlaces()": "telegraph_get_shared_places",
  "suggestMeetingPoint()": "telegraph_suggest_meeting_point",
  "createPlanDraft()": "telegraph_create_plan_draft",
  "findSafePublicMeetup()": "telegraph_find_safe_public_meetup",
  "searchAuthorizedConversationContent()": "telegraph_search_conversation",
};

export interface TelegraphToolRefusal {
  authorized: false;
  reason: string;
  /** True when the refusal is "we could not check", not "you may not". */
  degraded?: boolean;
}

interface Gate {
  authorized: true;
  conversationId: string;
  verdict: TelegraphChatPrivacyVerdict;
  capabilities: ConversationCapabilities;
  memberIds: string[];
  /**
   * The caller's Telegraph §14.3 history bound for this conversation, or null
   * when it is unbounded (flag off, pre-2400 membership row, or a §14.1
   * canViewPreMembershipHistory grant). Every tool below that reads `messages`
   * applies it; see the gate's own comment for why it belongs here and not in
   * each tool.
   */
  visibleFrom: string | null;
}

function refuse(reason: string, degraded = false): TelegraphToolRefusal {
  return degraded ? { authorized: false, reason, degraded: true } : { authorized: false, reason };
}

function conversationIdOf(args: Record<string, unknown>): string | null {
  const raw = String(args["conversationId"] ?? args["threadId"] ?? "").trim();
  return UUID_RE.test(raw) ? raw : null;
}

/**
 * The one authorization path for all eight tools. See the header.
 *
 * The roster read is NOT "who else is here, best effort": several tools below
 * project other participants' data, and a roster that silently came back empty
 * because the table was unreadable would make those tools return an honest-
 * looking empty result over an unchecked set. It refuses instead.
 */
export async function gateConversation(
  sc: SupabaseClient,
  userId: string,
  args: Record<string, unknown>,
): Promise<Gate | TelegraphToolRefusal> {
  const conversationId = conversationIdOf(args);
  if (!conversationId) return refuse("conversation_id_required");

  // §14.3, read ONCE for all eight tools. Compass answers on behalf of ONE
  // participant, so "data authorized to the conversational context" is
  // authorized to THAT participant's window — a member added to a trip thread
  // yesterday must not be able to ask Compass what was shared last month and
  // get an answer. Two tools below read `messages` directly, and putting the
  // bound in the gate is what stops the third one written later from forgetting
  // it: a tool that reads messages has to take `gate.visibleFrom` from the same
  // object it already takes `conversationId` from.
  //
  // FALSE ON ERROR is the lane's polarity (lib/featureFlags.isFlagEnabled): an
  // unreadable `feature_flags` leaves Compass's reach exactly what it is today
  // rather than blanking every answer. The MEMBERSHIP read below keeps this
  // file's own refuse-on-unreadable posture.
  const boundOn = await historyBoundEnabled(sc);

  const { data: mine, error: mineErr } = await sc
    .from("message_thread_members")
    // Conditional, so a build carrying this code never names a column a
    // database that has not run 2400 would reject with 42703.
    .select(membershipSelect("user_id, left_at", boundOn))
    .eq("thread_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (mineErr) {
    log.warn({ err: mineErr, conversationId }, "telegraph tool gate: membership unreadable");
    return refuse("membership_unavailable", true);
  }
  if (!mine || (mine as any).left_at != null) return refuse("not_a_participant");

  const { data: roster, error: rosterErr } = await sc
    .from("message_thread_members")
    .select("user_id")
    .eq("thread_id", conversationId)
    .is("left_at", null);
  if (rosterErr) {
    log.warn({ err: rosterErr, conversationId }, "telegraph tool gate: roster unreadable");
    return refuse("participants_unavailable", true);
  }

  const verdict = await resolvePrivacyVerdict(sc, userId, conversationId);
  if (!verdict.canShowRecommendation) return refuse(verdict.reason);

  const caps = await resolveConversationCapabilities(sc, { viewerId: userId, conversationId });
  if (caps.degraded) return refuse("capabilities_unavailable", true);

  return {
    authorized: true,
    conversationId,
    verdict,
    capabilities: caps.capabilities,
    memberIds: ((roster as any[]) ?? []).map((r) => String(r.user_id)),
    visibleFrom: visibleFromOf(mine as any, boundOn),
  };
}

/* ───────────────────────── 1. getConversationContext ──────────────────────── */

export async function telegraphGetConversationContext(
  sc: SupabaseClient,
  userId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const gate = await gateConversation(sc, userId, args);
  if (gate.authorized !== true) return gate;

  // Recent STRUCTURED objects only. The spec's boundary sentence forbids
  // Compass from reading one participant's private content to another, and the
  // safest reading of "conversation context" is the set of objects the
  // participants deliberately put into the conversation — not the prose.
  let recentQ = sc
    .from("messages")
    .select("id, subtype, created_at")
    .eq("thread_id", gate.conversationId)
    .is("deleted_at", null)
    .not("subtype", "is", null)
    .order("created_at", { ascending: false })
    .limit(10);
  // §14.3. `recentObjectKinds` is a list of what was put into the conversation
  // and WHEN it stopped being put there; from before the caller's window it is
  // pre-membership history in summary form. Bounded in the QUERY so the limit
  // is spent on rows the caller may see, and re-checked in `withinWindow`
  // because `gte` and the filter must agree on the boundary instant across the
  // two ISO spellings Postgres and Node produce.
  if (gate.visibleFrom) recentQ = recentQ.gte("created_at", gate.visibleFrom);
  const { data: recent, error } = await recentQ;
  if (error) log.warn({ err: error }, "conversation context: recent objects unreadable");

  return {
    authorized: true,
    conversationId: gate.conversationId,
    conversationType: gate.verdict.threadType,
    participantCount: gate.memberIds.length,
    // What the conversation may do — so the model never proposes an action the
    // conversation would refuse.
    capabilities: gate.capabilities,
    tripContextAvailable: gate.verdict.canUseTripContext,
    circleContextAvailable: gate.verdict.canUseCircleContext,
    availabilityContextAvailable: gate.verdict.canUseAvailability,
    destination: gate.verdict.tripDestination,
    recentObjectKinds: ((recent as any[]) ?? [])
      .filter((r) => withinWindow(r.created_at, gate.visibleFrom))
      .map((r) => String(r.subtype)),
    note: "Approximate context only. No coordinates, no live location, no message prose.",
  };
}

/* ──────────────────────────── 2. getSharedPlans ───────────────────────────── */

export async function telegraphGetSharedPlans(
  sc: SupabaseClient,
  userId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const gate = await gateConversation(sc, userId, args);
  if (gate.authorized !== true) return gate;

  const { data: meetups, error } = await sc
    .from("meetups")
    .select("id, title, location_name, approximate_date, time_block, status, starts_at")
    .eq("chat_thread_id", gate.conversationId)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    log.warn({ err: error, conversationId: gate.conversationId }, "shared plans unreadable");
    return refuse("plans_unavailable", true);
  }

  const plans = ((meetups as any[]) ?? []).map((m) => ({
    id: String(m.id),
    title: String(m.title ?? ""),
    // `location_name` is a human place NAME, capped at 300 chars by a CHECK —
    // never a coordinate. It is the only location field this tool returns.
    where: (m.location_name ?? null) as string | null,
    date: (m.approximate_date ?? null) as string | null,
    timeBlock: (m.time_block ?? null) as string | null,
    status: String(m.status ?? "draft"),
    startsAt: (m.starts_at ?? null) as string | null,
  }));

  return { authorized: true, conversationId: gate.conversationId, plans, count: plans.length };
}

/* ───────────────────── 3. getParticipantAvailability ──────────────────────── */

export async function telegraphGetParticipantAvailability(
  sc: SupabaseClient,
  userId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const gate = await gateConversation(sc, userId, args);
  if (gate.authorized !== true) return gate;

  // The viewer relationship handed to the projection is the MOST RESTRICTIVE
  // one this conversation justifies. A trip or circle thread with confirmed
  // membership is 'crew'; anything else is 'public'. It never widens: the
  // window's own visibility policy decides, and this only tells it who is
  // asking.
  const relationship: ViewerRelationship =
    (gate.verdict.canUseTripContext || gate.verdict.canUseCircleContext) ? "crew" : "public";

  const others = gate.memberIds.filter((id) => id !== userId).slice(0, 25);
  const out: Array<{ userId: string; windows: Array<Record<string, unknown>> }> = [];
  let unreadable = 0;
  for (const other of others) {
    try {
      const windows = await projectPublicWindows(sc, other, relationship);
      out.push({
        userId: other,
        windows: windows.map((w) => ({
          startAt: w.startAt,
          endAt: w.endAt,
          intents: w.intents,
          groupPreference: w.groupPreference,
          // Deliberately NOT returned: tripId, maxTravelMinutes, source.
          // The first is a different object's identity, the second is a
          // distance signal, the third would say whether the window was
          // inferred — which is a fact about how the app watches them.
        })),
      });
    } catch (err) {
      unreadable += 1;
      log.warn({ err, other }, "participant availability projection failed");
    }
  }

  const sharing = out.filter((p) => p.windows.length > 0);
  return {
    authorized: true,
    conversationId: gate.conversationId,
    participantsChecked: others.length,
    participantsSharing: sharing.length,
    availability: sharing,
    unreadable,
    // §18.3's honest-empty rule, said in the result so the model repeats it
    // rather than inventing a reason.
    note: sharing.length === 0
      ? "No participant is sharing availability with this conversation. That is a choice, not an absence of plans — do not speculate why."
      : "Explicit, non-expired availability only, as each participant's own visibility policy permits.",
  };
}

/* ──────────────────────────── 4. getSharedPlaces ──────────────────────────── */

export async function telegraphGetSharedPlaces(
  sc: SupabaseClient,
  userId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const gate = await gateConversation(sc, userId, args);
  if (gate.authorized !== true) return gate;

  let placesQ = sc
    .from("messages")
    .select("id, body, subtype, created_at")
    .eq("thread_id", gate.conversationId)
    .is("deleted_at", null)
    .in("subtype", ["discovery_card", "hidden_gem", "meeting_point", "compass_card"])
    .order("created_at", { ascending: false })
    .limit(25);
  // §14.3. This tool returns a card's TITLE and its safe summary text — the
  // content of a message — so a pre-membership card here is the disclosure
  // §14.3 forbids, arriving through the model instead of through the thread
  // read. The messageId it returns is also a handle the caller could carry to
  // another endpoint. Same two-layer shape as every other windowed read in this
  // tree: bounded in the query, re-checked per row.
  if (gate.visibleFrom) placesQ = placesQ.gte("created_at", gate.visibleFrom);
  const { data: rows, error } = await placesQ;
  if (error) {
    log.warn({ err: error, conversationId: gate.conversationId }, "shared places unreadable");
    return refuse("places_unavailable", true);
  }

  const { indexableText } = await import("../domain/telegraph/contracts/conversationSearch.js");
  const places = ((rows as any[]) ?? [])
    .filter((r) => withinWindow(r.created_at, gate.visibleFrom))
    .map((r) => {
      const { objectTitle, text } = indexableText(r.body, r.subtype);
      return objectTitle === null ? null : {
        messageId: String(r.id),
        kind: String(r.subtype),
        title: objectTitle,
        // The SAFE fields only — the same allowlist §21's index uses, so a
        // coordinate cannot reach the model through a card body here either.
        summary: text,
        sharedAt: String(r.created_at),
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  return { authorized: true, conversationId: gate.conversationId, places, count: places.length };
}

/* ────────────────────────── 5. suggestMeetingPoint ────────────────────────── */

/**
 * A meeting point is a SUGGESTION over the conversation's shared destination.
 *
 * It does not use anyone's location. There is no midpoint computation here and
 * there deliberately never will be one on this path: a midpoint between two
 * participants is a location inference about both of them, derived from data
 * neither shared with the conversation, and §15.1's purpose binding forbids
 * exactly that reuse.
 */
export async function telegraphSuggestMeetingPoint(
  sc: SupabaseClient,
  userId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const gate = await gateConversation(sc, userId, args);
  if (gate.authorized !== true) return gate;

  const destination = gate.verdict.tripDestination ?? (typeof args["near"] === "string" ? String(args["near"]) : null);
  if (!destination) {
    return {
      authorized: true,
      conversationId: gate.conversationId,
      suggestions: [],
      note: "This conversation has no shared destination, and no participant location is used to infer one. Ask where they want to meet.",
    };
  }

  const venues = await getNearbyVenues(destination);
  return {
    authorized: true,
    conversationId: gate.conversationId,
    near: destination,
    suggestions: venues.slice(0, 5).map(publicVenue),
    note: "Suggestions from the conversation's shared destination only. No participant's location was read.",
  };
}

function publicVenue(v: NearbyVenue) {
  return { name: v.name, category: v.cuisine, approximateDistanceM: v.distanceM, priceLevel: v.priceLevel };
}

/* ─────────────────────────── 6. createPlanDraft ───────────────────────────── */

/**
 * A DRAFT. It writes nothing.
 *
 * §18.3's boundary sentence forbids Compass from "silently creat[ing] canonical
 * plans from uncertain prose", and the enforcement is that this function has no
 * write in it at all — not a write behind a check. `requiresConfirmation` is a
 * literal, and the capability set is consulted first so a draft is never
 * offered in a conversation that would refuse the plan.
 */
export async function telegraphCreatePlanDraft(
  sc: SupabaseClient,
  userId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const gate = await gateConversation(sc, userId, args);
  if (gate.authorized !== true) return gate;

  if (!gate.capabilities.canCreatePlan) {
    return refuse("plan_creation_not_permitted_in_this_conversation");
  }

  const title = String(args["title"] ?? "").trim().slice(0, 200);
  if (title === "") return refuse("title_required");

  return {
    authorized: true,
    conversationId: gate.conversationId,
    draft: {
      title,
      where: typeof args["where"] === "string" ? String(args["where"]).slice(0, 300) : null,
      when: typeof args["when"] === "string" ? String(args["when"]).slice(0, 100) : null,
    },
    requiresConfirmation: true,
    confirmVia: "POST /telegraph/commands/:commandId/confirm",
    note: "Nothing has been created. Present this as a proposal; the participant must confirm it, and the server re-verifies membership at that point.",
  };
}

/* ───────────────────────── 7. findSafePublicMeetup ────────────────────────── */

/**
 * Safety-filtered meeting places.
 *
 * "Safe" here means a narrow, checkable thing and the result says so: a PUBLIC,
 * STAFFED category of venue, drawn from the conversation's shared destination.
 * It is not a claim about crime, lighting or the hour, because this repository
 * holds no source for any of those and inventing one would be the most
 * dangerous possible kind of confident answer.
 */
const PUBLIC_STAFFED_CATEGORIES = [
  "cafe", "coffee", "restaurant", "bakery", "hotel", "museum", "library",
  "bookshop", "bookstore", "mall", "supermarket", "pharmacy",
];

export async function telegraphFindSafePublicMeetup(
  sc: SupabaseClient,
  userId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const gate = await gateConversation(sc, userId, args);
  if (gate.authorized !== true) return gate;

  const destination = gate.verdict.tripDestination ?? (typeof args["near"] === "string" ? String(args["near"]) : null);
  if (!destination) {
    return {
      authorized: true,
      conversationId: gate.conversationId,
      suggestions: [],
      note: "This conversation has no shared destination, and no participant location is used to infer one.",
    };
  }

  const venues = await getNearbyVenues(destination);
  const publicStaffed = venues.filter((v) => {
    const hay = `${v.name} ${v.cuisine ?? ""}`.toLowerCase();
    return PUBLIC_STAFFED_CATEGORIES.some((c) => hay.includes(c));
  });

  return {
    authorized: true,
    conversationId: gate.conversationId,
    near: destination,
    suggestions: publicStaffed.slice(0, 5).map(publicVenue),
    safetyBasis: "public_staffed_category_only",
    note: publicStaffed.length === 0
      ? "No public, staffed venue was found for this destination. Say so; do not substitute an unverified one."
      : "Filtered to public, staffed venue categories. This is NOT a claim about crime, lighting or opening hours — the app has no source for those.",
  };
}

/* ────────────────── 8. searchAuthorizedConversationContent ────────────────── */

export async function telegraphSearchConversation(
  sc: SupabaseClient,
  userId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const gate = await gateConversation(sc, userId, args);
  if (gate.authorized !== true) return gate;

  const query = String(args["query"] ?? "").trim().slice(0, 120);
  if (query.length < 2) return refuse("query_too_short");

  // The SAME service the user-facing §21 route uses: one scope resolver, one
  // set of exclusions. A second search path for Compass is how the two would
  // come to disagree about what a participant may see.
  const result = await searchConversations(sc, userId, query, {
    conversationId: gate.conversationId,
    preferStructured: true,
    limit: 20,
  });

  return {
    authorized: true,
    conversationId: gate.conversationId,
    query: result.query,
    counts: result.counts,
    hits: result.hits.map((h) => ({
      messageId: h.messageId,
      kind: h.bucket,
      title: h.objectTitle,
      snippet: h.snippet,
      createdAt: h.createdAt,
    })),
    degraded: result.degraded,
  };
}

/* ─────────────────────────── definitions + dispatch ───────────────────────── */

const CONVERSATION_ARG = {
  conversationId: {
    type: "string" as const,
    description: "The Telegraph conversation (thread) id the user is currently in.",
  },
};

export const TELEGRAPH_COMPASS_TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "telegraph_get_conversation_context",
      description:
        "Telegraph §18.3 getConversationContext. What this conversation is, how many participants, what it is allowed to do, and which kinds of shared objects are in it. Returns no message text and no location.",
      parameters: { type: "object" as const, properties: { ...CONVERSATION_ARG }, required: ["conversationId"], additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "telegraph_get_shared_plans",
      description:
        "Telegraph §18.3 getSharedPlans. Meetups and plans attached to this conversation, with their place NAME, date and status. Never coordinates.",
      parameters: { type: "object" as const, properties: { ...CONVERSATION_ARG }, required: ["conversationId"], additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "telegraph_get_participant_availability",
      description:
        "Telegraph §18.3 getParticipantAvailability. Explicit, non-expired availability windows the other participants have chosen to share with someone in this viewer's position. A participant who is not sharing simply does not appear — never speculate why.",
      parameters: { type: "object" as const, properties: { ...CONVERSATION_ARG }, required: ["conversationId"], additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "telegraph_get_shared_places",
      description:
        "Telegraph §18.3 getSharedPlaces. Place cards participants have shared into this conversation, by title and safe summary only.",
      parameters: { type: "object" as const, properties: { ...CONVERSATION_ARG }, required: ["conversationId"], additionalProperties: false },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "telegraph_suggest_meeting_point",
      description:
        "Telegraph §18.3 suggestMeetingPoint. Candidate places to meet, drawn from the conversation's shared destination. Uses no participant's location and computes no midpoint.",
      parameters: {
        type: "object" as const,
        properties: { ...CONVERSATION_ARG, near: { type: "string" as const, description: "Optional city or area, when the conversation has no shared destination." } },
        required: ["conversationId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "telegraph_create_plan_draft",
      description:
        "Telegraph §18.3 createPlanDraft. Produces a DRAFT only. Nothing is written; the participant must confirm. Refuses when this conversation may not create plans.",
      parameters: {
        type: "object" as const,
        properties: {
          ...CONVERSATION_ARG,
          title: { type: "string" as const, description: "Short title for the proposed plan." },
          where: { type: "string" as const, description: "Optional place name." },
          when: { type: "string" as const, description: "Optional human time description." },
        },
        required: ["conversationId", "title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "telegraph_find_safe_public_meetup",
      description:
        "Telegraph §18.3 findSafePublicMeetup. Public, staffed venue categories near the conversation's shared destination. This is not a claim about crime, lighting or opening hours.",
      parameters: {
        type: "object" as const,
        properties: { ...CONVERSATION_ARG, near: { type: "string" as const, description: "Optional city or area." } },
        required: ["conversationId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "telegraph_search_conversation",
      description:
        "Telegraph §18.3 searchAuthorizedConversationContent. Searches only what this participant is authorized to see in this conversation, excludes deleted content, and prefers structured plans and places over prose.",
      parameters: {
        type: "object" as const,
        properties: { ...CONVERSATION_ARG, query: { type: "string" as const, description: "What to look for." } },
        required: ["conversationId", "query"],
        additionalProperties: false,
      },
    },
  },
];

export const TELEGRAPH_COMPASS_TOOL_NAMES: ReadonlySet<string> = new Set(
  TELEGRAPH_COMPASS_TOOL_DEFINITIONS.map((t) => t.function.name),
);

/**
 * Dispatch one Telegraph conversation tool. Returns `undefined` when `name` is
 * not one of ours, so the caller's own switch keeps its `default` branch.
 */
export async function executeTelegraphConversationTool(
  sc: SupabaseClient,
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown | undefined> {
  switch (name) {
    case "telegraph_get_conversation_context":     return telegraphGetConversationContext(sc, userId, args);
    case "telegraph_get_shared_plans":             return telegraphGetSharedPlans(sc, userId, args);
    case "telegraph_get_participant_availability": return telegraphGetParticipantAvailability(sc, userId, args);
    case "telegraph_get_shared_places":            return telegraphGetSharedPlaces(sc, userId, args);
    case "telegraph_suggest_meeting_point":        return telegraphSuggestMeetingPoint(sc, userId, args);
    case "telegraph_create_plan_draft":            return telegraphCreatePlanDraft(sc, userId, args);
    case "telegraph_find_safe_public_meetup":      return telegraphFindSafePublicMeetup(sc, userId, args);
    case "telegraph_search_conversation":          return telegraphSearchConversation(sc, userId, args);
    default:                                       return undefined;
  }
}
