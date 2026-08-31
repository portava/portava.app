/**
 * Events routes
 *
 * ── Discovery / personal feeds ─────────────────────────────────────────────
 * GET    /api/events                              — list/discover events (city-filtered)
 * GET    /api/events/city/:city                   — events for a specific city
 * GET    /api/events/nearby                       — bounding-box proximity events
 * GET    /api/events/search                       — text search across title/description/city
 * GET    /api/events/me                           — my upcoming (hosting + joined)
 * GET    /api/events/hosting                      — events I'm hosting
 * GET    /api/events/joined                       — events I'm attending (Going RSVP)
 * GET    /api/events/saved                        — events I've saved
 * GET    /api/events/invites                      — pending invites for me
 * GET    /api/events/requests                     — my outgoing join requests
 *
 * ── Drafts ──────────────────────────────────────────────────────────────────
 * GET    /api/events/drafts                       — list my draft events
 * POST   /api/events/drafts                       — autosave draft (incomplete data OK)
 * PATCH  /api/events/drafts/:draftId              — update autosave draft
 * DELETE /api/events/drafts/:draftId              — delete draft
 * POST   /api/events/drafts/:draftId/publish      — validate + publish draft as event
 *
 * ── Share-link preview (static path, before /:id) ──────────────────────────
 * GET    /api/events/share-link/:token/preview    — preview event from share token
 *
 * ── Core CRUD ───────────────────────────────────────────────────────────────
 * POST   /api/events                              — create event
 * GET    /api/events/:id                          — get event detail
 * PATCH  /api/events/:id                          — update event (host/co_host only)
 * DELETE /api/events/:id                          — cancel / soft-delete
 *
 * ── Lifecycle ───────────────────────────────────────────────────────────────
 * POST   /api/events/:id/publish                  — publish draft → open
 * POST   /api/events/:id/cancel                   — cancel (explicit)
 * POST   /api/events/:id/postpone                 — postpone (back to draft)
 * POST   /api/events/:id/complete                 — mark completed
 * POST   /api/events/:id/archive                  — archive
 *
 * ── RSVP / Attendance ───────────────────────────────────────────────────────
 * POST   /api/events/:id/rsvp                     — upsert RSVP status
 * DELETE /api/events/:id/rsvp                     — leave event / cancel RSVP
 * POST   /api/events/:id/close-rsvps              — host closes RSVPs
 * POST   /api/events/:id/reopen-rsvps             — host reopens RSVPs
 * GET    /api/events/:id/attendees                — full attendee list (host/mod)
 * PATCH  /api/events/:id/attendees/:userId/status — host updates attendee status
 * DELETE /api/events/:id/attendees/:userId        — host removes attendee
 *
 * ── Waitlist ────────────────────────────────────────────────────────────────
 * POST   /api/events/:id/waitlist                 — join waitlist
 * DELETE /api/events/:id/waitlist                 — leave waitlist
 * POST   /api/events/:id/waitlist/accept          — accept waitlist offer
 * GET    /api/events/:id/waitlist                 — view waitlist (host/mod)
 *
 * ── Join requests ───────────────────────────────────────────────────────────
 * POST   /api/events/:id/requests                 — request to join invite-only event (legacy)
 * GET    /api/events/:id/requests                 — list join requests (host only)
 * PATCH  /api/events/:id/requests/:userId         — approve / deny join request (legacy)
 * POST   /api/events/:id/join-request             — request to join (new path)
 * POST   /api/events/:id/join-requests/:requestId/approve  — approve request
 * POST   /api/events/:id/join-requests/:requestId/decline  — decline request
 * POST   /api/events/:id/join-requests/:requestId/cancel   — requester cancels
 *
 * ── Roles ───────────────────────────────────────────────────────────────────
 * POST   /api/events/:id/roles                    — assign role (host only)
 * DELETE /api/events/:id/roles/:userId            — remove role (host only)
 *
 * ── Invites & Co-hosts ──────────────────────────────────────────────────────
 * POST   /api/events/:id/invite                   — invite a user
 * POST   /api/events/:id/invites/:inviteId/accept  — accept invite
 * POST   /api/events/:id/invites/:inviteId/decline — decline invite
 * POST   /api/events/:id/cohosts                  — add co-host
 * DELETE /api/events/:id/cohosts/:userId          — remove co-host
 * PATCH  /api/events/:id/cohosts/:userId/permissions — update co-host permissions
 *
 * ── Check-in & Attendance ───────────────────────────────────────────────────
 * POST   /api/events/:id/checkin                  — attendee self check-in
 * POST   /api/events/:id/attendance/:userId       — host confirms attendance
 * POST   /api/events/:id/noshow/:userId           — host marks no-show
 *
 * ── Save / Share ────────────────────────────────────────────────────────────
 * POST   /api/events/:id/save                     — save event
 * DELETE /api/events/:id/save                     — unsave event
 * POST   /api/events/:id/share-link               — create share link
 * DELETE /api/events/:id/share-link/:linkId       — revoke share link
 *
 * ── Content ─────────────────────────────────────────────────────────────────
 * GET    /api/events/:id/posts                    — list event posts
 * POST   /api/events/:id/posts                    — create event post (host/cohost/attendee)
 * GET    /api/events/:id/media                    — list event media
 * POST   /api/events/:id/media                    — upload event media
 * GET    /api/events/:id/comments                 — list event updates (attendees)
 * POST   /api/events/:id/comments                 — post comment (host/cohost/attendee)
 *
 * ── Convenience attendance shortcuts ─────────────────────────────────────────
 * POST   /api/events/:id/join                     — shortcut: RSVP going (full gate checks)
 * POST   /api/events/:id/leave                    — shortcut: cancel RSVP and remove attendee
 *
 * ── Safety / Moderation ─────────────────────────────────────────────────────
 * POST   /api/events/:id/report                   — report event
 * POST   /api/events/:id/report-user/:userId      — report user in event context
 * POST   /api/events/:id/block-user/:userId       — host blocks user from event
 * GET    /api/events/:id/activity                 — activity log (host/mod)
 * GET    /api/events/:id/safety-summary           — safety summary (host/admin)
 *
 * ── Reminders ───────────────────────────────────────────────────────────────
 * GET    /api/events/:id/reminders                — list my reminders for this event
 * POST   /api/events/:id/reminders                — create reminder
 * PATCH  /api/events/:id/reminders/:reminderId    — update reminder
 * DELETE /api/events/:id/reminders/:reminderId    — delete reminder
 *
 * ── Reviews ─────────────────────────────────────────────────────────────────
 * POST   /api/events/:id/reviews                  — submit review
 * GET    /api/events/:id/reviews                  — list reviews
 * DELETE /api/events/:id/reviews                  — delete own review
 *
 * ── Memory / Chat / Updates ─────────────────────────────────────────────────
 * POST   /api/events/:id/memory                   — convert completed event to memory
 * POST   /api/events/:id/chat                     — create/get chat thread (host/cohost)
 * POST   /api/events/:id/chat/join                — join event chat (Going RSVPs)
 * POST   /api/events/:id/updates                  — post host update / pin
 *
 * ── Agenda items ─────────────────────────────────────────────────────────────
 * GET    /api/events/:id/agenda-items             — list agenda items (host/cohost/RSVP'd attendee)
 * POST   /api/events/:id/agenda-items             — attach a place/note to an event (host/cohost/attendee)
 *
 * ── Cross-system integrations ────────────────────────────────────────────────
 * POST   /api/events/:id/add-to-trip              — add event as trip plan item (member only)
 * POST   /api/events/:id/link-circle              — link event to a circle (host only)
 * POST   /api/events/:id/telegraph-thread         — create/get event chat thread (host/cohost)
 *
 * ── Profile tab ─────────────────────────────────────────────────────────────
 * GET    /api/users/:userId/events                — events for a user profile tab
 */

/**
 * ── Inventory matrix ──────────────────────────────────────────────────────────
 *
 * Feature                        | Files / Routes                              | Tables                                   | Status        | Action taken
 * -------------------------------|---------------------------------------------|------------------------------------------|---------------|-------------------------------
 * Event CRUD                     | events.ts POST/GET/PATCH/DELETE /events/:id | events, event_roles                      | complete      | Full CRUD + formatEvent field-gating
 * Draft autosave                 | events.ts CRUD /events/drafts/*             | event_drafts                             | complete      | Save/update/delete + publish path
 * Draft → publish                | events.ts POST /events/drafts/:id/publish   | events, event_drafts, event_activity_log | complete      | Spam/prohibited/duplicate checks added
 * Publish validation             | checkProhibitedContent/checkTicketUrl/      | event_activity_log                       | complete      | All publish paths (create+publishNow,
 *                                | checkDuplicateEvent                         |                                          |               |   /publish, drafts/:id/publish)
 * RSVP / attendance              | events.ts POST/DELETE /events/:id/rsvp      | event_rsvps, event_attendees             | complete      | Capacity + waitlist enforcement
 * Waitlist                       | events.ts /events/:id/waitlist/*            | event_waitlist                           | complete      | Position tracking, offer expiry
 * Join/leave shortcuts           | events.ts POST /events/:id/join,leave       | event_rsvps, event_attendees, waitlist   | complete      | Capacity gate + waitlist redirect
 * Join requests                  | events.ts /events/:id/join-request(s)/*     | event_join_requests                      | complete      | Approve/decline/cancel
 * Roles                          | events.ts /events/:id/roles                 | event_roles                              | complete      | Assign/remove host/co_host/mod/etc.
 * Invites                        | events.ts /events/:id/invite, /invites/*    | event_invites                            | complete      | Invite, accept, decline
 * Co-hosts                       | events.ts /events/:id/cohosts/*             | event_cohosts                            | complete      | Add/remove + permissions
 * Check-in / no-show             | events.ts /events/:id/checkin,attendance,   | event_attendee_states                    | complete      | Self check-in + host confirm/no-show
 *                                |   noshow                                    |                                          |               |
 * Event posts (participant-only) | events.ts GET/POST /events/:id/posts        | event_posts                              | complete      | Participant gate (host/cohost/going/maybe)
 * Event media (participant-only) | events.ts GET/POST /events/:id/media        | event_media                              | complete      | Participant gate
 * Comments/updates (part.-only)  | events.ts GET/POST /events/:id/comments     | event_updates                            | complete      | Participant gate
 * Save / share-link              | events.ts /events/:id/save, share-link      | event_saves, event_share_links           | complete      | Create/delete/revoke
 * Reports / moderation           | events.ts /events/:id/report,report-user,   | event_reports, event_roles               | complete      | Block user, activity log
 *                                |   block-user, activity                      |                                          |               |
 * Safety summary                 | events.ts GET /events/:id/safety-summary    | event_reports, event_attendee_states,    | complete      | Host-only (co_host excluded)
 *                                |                                             |   event_roles                            |               |
 * goingAttendees privacy         | events.ts GET /events/:id                   | event_rsvps, event_roles, profiles       | complete      | Participant-scoped (empty [] for outsiders)
 * priceUrl / safetyNotes gate    | formatEvent()                               | events                                   | complete      | priceUrl: host/participant; safetyNotes: host only
 * Discovery / feeds              | events.ts GET /events, /city, /nearby,      | events, event_rsvps, event_saves         | complete      | City/bbox/search/me/hosting/joined/saved
 *                                |   /search, /me, /hosting, /joined, /saved   |                                          |               |
 * Reminders                      | events.ts CRUD /events/:id/reminders        | event_reminders                          | complete      | Full CRUD
 * Reviews                        | events.ts CRUD /events/:id/reviews          | event_reviews                            | complete      | Create/list/delete
 * Memory / chat                  | events.ts POST /events/:id/memory, /chat    | event_memories (stub), event_chat        | complete      | Memory convert + chat thread + join
 * Lifecycle (publish/cancel/etc) | events.ts POST /events/:id/publish,cancel,  | events, event_activity_log               | complete      | State machine + activity log on all
 *                                |   postpone,complete,archive,close-rsvps,    |                                          |               |   transitions
 *                                |   reopen-rsvps                              |                                          |               |
 * Age/trust eligibility gate     | checkEventEligibility()                     | profiles (age/trust_score)               | complete      | Applied on RSVP, join, and GET detail
 * Blocked-user rejection         | isBlocked()                                 | blocks                                   | complete      | Applied on GET detail + RSVP paths
 * RLS policies                   | migrations/0080_events_extension.sql        | all events_* tables                      | complete      | Fixed over-permissive USING(true);
 *                                |                                             |                                          |               |   added event_attendees table
 * event_attendees table          | migrations/0080_events_extension.sql        | event_attendees                          | complete      | Added per-spec; upserted on RSVP/join
 * Spam / prohibited content      | checkProhibitedContent, checkTicketUrl,     | —                                        | complete      | Regex + allowlist + 3-hour window
 *                                | checkDuplicateEvent                         |                                          |               |   duplicate detection
 * Cross-system integrations      | events.ts /add-to-trip, /link-circle,       | trip_plan_items, events, messages         | complete      | add-to-trip inserts plan item; link-circle
 *                                |   /telegraph-thread                         |                                          |               |   updates circle_id; telegraph-thread wires chat
 * Agenda items                   | events.ts GET+POST /events/:id/agenda-items | event_agenda_items                       | complete      | Host/cohost or RSVP'd attendee; GET lists ordered items
 */

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { detectAndStoreLanguage, invalidateContentTranslations } from "../services/contentTranslation.js";
import { nameVisibilitySet, sanitizeIdentity } from "../lib/publicIdentity.js";
import { isFlagEnabled, isKillSwitchEngaged } from "../lib/featureFlags.js";
import { appStorageUrlInfo } from "../lib/mediaUrl.js";
import { sendPushWithRetry } from "../lib/pushWithRetry.js";
import { linkOutcomeSignal } from "../compass/CompassOutcomeEngine.js";
import { recordTrustEvent } from "../services/trust/TrustEventService.js";
import { rankCandidates } from "../lib/portavaRank.js";
import type { RankCandidate, ViewerContext } from "../lib/portavaRank.js";
import { logImpression } from "../lib/rankLog.js";
import {
  toPrivateEventPreview,
  toAuthorizedEventView,
} from "../lib/privacy/eventSerializers.js";

const router = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * The event states a BROWSE surface may return.
 *
 * Deliberately excludes draft, cancelled and archived: those are host-private
 * and canViewEvent refuses them on the detail endpoint, so any list that
 * returned them would disagree with the detail view about who may see what.
 * Declared once here because GET /api/events derives its caller-supplied
 * `state` filter from it — an unvalidated value used to reach the query
 * directly.
 */
const BROWSE_STATES = ["open", "full", "waitlist", "started", "completed"];
function isUuid(s: string) { return UUID_RE.test(s); }

// ── Permission helpers ────────────────────────────────────────────────────────

async function getEventRole(
  sc: any,
  eventId: string,
  userId: string,
): Promise<"host" | "co_host" | "moderator" | "banned" | null> {
  const { data: ev } = await sc.from("events").select("host_id").eq("id", eventId).maybeSingle();
  if (!ev) return null;
  if ((ev as any).host_id === userId) return "host";
  const { data: r } = await sc
    .from("event_roles")
    .select("role")
    .eq("event_id", eventId)
    .eq("user_id", userId)
    .maybeSingle();
  return (r as any)?.role ?? null;
}

async function isHostOrCoHost(sc: any, eventId: string, userId: string): Promise<boolean> {
  const role = await getEventRole(sc, eventId, userId);
  return role === "host" || role === "co_host";
}

async function canManageAttendance(sc: any, eventId: string, userId: string): Promise<boolean> {
  const role = await getEventRole(sc, eventId, userId);
  return role === "host" || role === "co_host" || role === "moderator";
}

/** Check if blocked relationship exists in either direction */
async function isBlocked(sc: any, userA: string, userB: string): Promise<boolean> {
  const { data } = await sc
    .from("blocks")
    .select("id")
    .or(`and(blocker_id.eq.${userA},blocked_id.eq.${userB}),and(blocker_id.eq.${userB},blocked_id.eq.${userA})`)
    .limit(1);
  return ((data as any[]) ?? []).length > 0;
}

/** Get going_count for event */
async function getGoingCount(sc: any, eventId: string): Promise<number> {
  const { data } = await sc
    .from("event_rsvps")
    .select("user_id")
    .eq("event_id", eventId)
    .eq("status", "going");
  return ((data as any[]) ?? []).length;
}

/**
 * Keep event_attendees in sync with event_rsvps.
 * Call after every RSVP upsert/delete — non-fatal (swallows errors).
 * - going/maybe/interested → upsert into event_attendees
 * - cant_go / null (remove) → delete from event_attendees
 */
async function syncAttendee(sc: any, eventId: string, userId: string, status: string | null): Promise<void> {
  if (status && status !== "cant_go") {
    await sc.from("event_attendees")
      .upsert({ event_id: eventId, user_id: userId }, { onConflict: "event_id,user_id" })
      .then(undefined, () => {});
  } else {
    await sc.from("event_attendees")
      .delete()
      .eq("event_id", eventId)
      .eq("user_id", userId)
      .then(undefined, () => {});
  }
}

/** Auto-transition event state based on capacity */
async function hasActiveWaitlistOffer(sc: any, eventId: string): Promise<boolean> {
  const { data } = await sc
    .from("event_waitlist")
    .select("user_id")
    .eq("event_id", eventId)
    .gt("offer_expires_at", new Date().toISOString())
    .limit(1);
  return ((data as any[]) ?? []).length > 0;
}

async function syncEventState(sc: any, eventId: string): Promise<void> {
  const { data: ev } = await sc
    .from("events")
    .select("state, max_attendees, waitlist_enabled")
    .eq("id", eventId)
    .maybeSingle();
  if (!ev || !["open", "full", "waitlist"].includes((ev as any).state)) return;

  const maxAttendees: number | null = (ev as any).max_attendees;
  if (!maxAttendees) return; // unlimited

  const going = await getGoingCount(sc, eventId);

  let newState: string = (ev as any).state;
  if (going >= maxAttendees) {
    newState = (ev as any).waitlist_enabled ? "waitlist" : "full";
  } else if (["full", "waitlist"].includes((ev as any).state)) {
    // Only reopen if there is no active waitlist offer — the slot is reserved for that user
    const offerActive = await hasActiveWaitlistOffer(sc, eventId);
    if (!offerActive) {
      newState = "open";
    }
  }

  if (newState !== (ev as any).state) {
    await sc.from("events").update({ state: newState, updated_at: new Date().toISOString() }).eq("id", eventId);
  }
}

/** Promote next waitlisted user — give 24h to accept */
async function promoteNextWaitlisted(sc: any, eventId: string): Promise<void> {
  const { data: next } = await sc
    .from("event_waitlist")
    .select("user_id")
    .eq("event_id", eventId)
    .is("offer_expires_at", null)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!next) return;

  const offerExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await sc
    .from("event_waitlist")
    .update({ offer_expires_at: offerExpiresAt })
    .eq("event_id", eventId)
    .eq("user_id", (next as any).user_id);

  // Notify them
  const { data: profile } = await sc
    .from("profiles")
    .select("expo_push_token")
    .eq("id", (next as any).user_id)
    .maybeSingle();
  if ((profile as any)?.expo_push_token) {
    await sendPushWithRetry(
      sc,
      { userId: (next as any).user_id, tokens: [(profile as any).expo_push_token] },
      { title: "A spot opened up!", body: "You're next on the waitlist. You have 24 hours to accept." },
    );
  }
}

// ── Shared eligibility check ──────────────────────────────────────────────────
// Used by RSVP, waitlist-join, and join-request-approval paths to prevent
// any user from joining through a back-door that bypasses server-side gates.

type EligibilityOk   = { ok: true };
type EligibilityFail = { ok: false; errorCode: string; message: string };

export async function checkEventEligibility(
  sc: any,
  ev: any,            // full events row (must include host_id, age_min, age_max, trust_score_min, verified_only)
  userId: string,
): Promise<EligibilityOk | EligibilityFail> {
  // Event host always has full access — bypass all viewer gates
  if (userId === ev.host_id) return { ok: true };

  // Check if user is a co_host or moderator — they also bypass viewer gates
  const { data: staffRole } = await sc
    .from("event_roles")
    .select("role")
    .eq("event_id", ev.id)
    .eq("user_id", userId)
    .in("role", ["co_host", "moderator"])
    .maybeSingle();
  if (staffRole) return { ok: true };

  // Block check
  if (await isBlocked(sc, userId, ev.host_id)) {
    return { ok: false, errorCode: "forbidden", message: "Cannot join this event" };
  }
  // Ban check
  const { data: bannedRole } = await sc
    .from("event_roles")
    .select("role")
    .eq("event_id", ev.id)
    .eq("user_id", userId)
    .eq("role", "banned")
    .maybeSingle();
  if (bannedRole) return { ok: false, errorCode: "forbidden", message: "You are banned from this event" };

  // Trust / age / verified gates
  const trustGatesEnabled = await isFlagEnabled(sc, "events_trust_gates_enabled");
  if (trustGatesEnabled) {
    if (ev.verified_only) {
      const { data: profile } = await sc.from("profiles").select("verified").eq("id", userId).maybeSingle();
      if (!(profile as any)?.verified) {
        return { ok: false, errorCode: "forbidden", message: "This event is for verified users only" };
      }
    }
    if (ev.trust_score_min != null) {
      const { data: tp } = await sc.from("trust_profiles").select("overall_score").eq("user_id", userId).maybeSingle();
      const score = (tp as any)?.overall_score ?? 50;
      if (score < ev.trust_score_min) {
        return { ok: false, errorCode: "forbidden", message: `This event requires a trust score of at least ${ev.trust_score_min}` };
      }
    }
    if (ev.age_min != null || ev.age_max != null) {
      const { data: profile } = await sc.from("profiles").select("date_of_birth").eq("id", userId).maybeSingle();
      if (!(profile as any)?.date_of_birth) {
        return { ok: false, errorCode: "forbidden", message: "Your profile must have a date of birth to join this age-restricted event" };
      }
      const ageYears = Math.floor(
        (Date.now() - new Date((profile as any).date_of_birth).getTime()) / (1000 * 60 * 60 * 24 * 365.25),
      );
      if (ev.age_min != null && ageYears < ev.age_min) {
        return { ok: false, errorCode: "forbidden", message: `This event requires attendees to be at least ${ev.age_min}` };
      }
      if (ev.age_max != null && ageYears > ev.age_max) {
        return { ok: false, errorCode: "forbidden", message: `This event is for attendees up to age ${ev.age_max}` };
      }
    }
  }
  return { ok: true };
}

/** Get push recipients ({ userId, tokens }) for Going/Maybe RSVPs on an event */
async function getAttendeeRecipients(
  sc: any,
  eventId: string,
): Promise<{ userId: string; tokens: (string | null | undefined)[] }[]> {
  const { data: rsvps } = await sc
    .from("event_rsvps")
    .select("user_id")
    .eq("event_id", eventId)
    .in("status", ["going", "maybe"]);

  const ids = ((rsvps as any[]) ?? []).map((r: any) => r.user_id as string);
  if (ids.length === 0) return [];

  const { data: profiles } = await sc
    .from("profiles")
    .select("id, expo_push_token")
    .in("id", ids)
    .not("expo_push_token", "is", null);

  return ((profiles as any[]) ?? [])
    .map((p: any) => ({ userId: p.id as string, tokens: [p.expo_push_token as string] }))
    .filter((r: any) => r.tokens[0]);
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const CreateEventSchema = z.object({
  title:           z.string().min(1).max(200),
  description:     z.string().max(2000).optional(),
  locationName:    z.string().max(300).optional(),
  locationLat:     z.number().optional(),
  locationLng:     z.number().optional(),
  startsAt:        z.string().optional(),
  endsAt:          z.string().optional(),
  coverUrl:        z.string().url().optional().nullable(),
  coverMediaType:  z.enum(["image", "video"]).optional().nullable(),
  coverImageWidth:  z.number().int().positive().optional().nullable(),
  coverImageHeight: z.number().int().positive().optional().nullable(),
  maxAttendees:    z.number().int().positive().optional().nullable(),
  ageMin:          z.number().int().min(18).max(100).optional().nullable(),
  ageMax:          z.number().int().min(18).max(100).optional().nullable(),
  trustScoreMin:   z.number().min(0).max(100).optional().nullable(),
  verifiedOnly:    z.boolean().optional(),
  visibility:      z.enum(["public", "friends_only", "invite_only", "circle", "trip"]).default("public"),
  circleId:        z.string().uuid().optional().nullable(),
  tripId:          z.string().uuid().optional().nullable(),
  chatEnabled:     z.boolean().optional(),
  waitlistEnabled: z.boolean().optional(),
  priceType:       z.enum(["free", "external"]).optional(),
  priceUrl:        z.string().url().optional().nullable(),
  rsvpOptions:     z.array(z.enum(["going", "maybe", "interested", "cant_go"])).optional(),
  category:           z.string().max(60).optional(),
  city:               z.string().max(100).optional(),
  country:            z.string().max(100).optional(),
  publishNow:         z.boolean().optional(),
  showHeaderPublicly: z.boolean().optional(),
});

const UpdateEventSchema = z.object({
  title:           z.string().min(1).max(200).optional(),
  description:     z.string().max(2000).nullable().optional(),
  locationName:    z.string().max(300).nullable().optional(),
  locationLat:     z.number().nullable().optional(),
  locationLng:     z.number().nullable().optional(),
  startsAt:        z.string().nullable().optional(),
  endsAt:          z.string().nullable().optional(),
  coverUrl:        z.string().url().nullable().optional(),
  coverMediaType:  z.enum(["image", "video"]).nullable().optional(),
  coverImageWidth:  z.number().int().positive().nullable().optional(),
  coverImageHeight: z.number().int().positive().nullable().optional(),
  maxAttendees:    z.number().int().positive().nullable().optional(),
  ageMin:          z.number().int().min(18).max(100).nullable().optional(),
  ageMax:          z.number().int().min(18).max(100).nullable().optional(),
  trustScoreMin:   z.number().min(0).max(100).nullable().optional(),
  verifiedOnly:    z.boolean().optional(),
  visibility:      z.enum(["public", "friends_only", "invite_only", "circle", "trip"]).optional(),
  circleId:        z.string().uuid().nullable().optional(),
  tripId:          z.string().uuid().nullable().optional(),
  state:           z.enum(["draft", "open", "started", "completed", "cancelled", "archived"]).optional(),
  chatEnabled:     z.boolean().optional(),
  waitlistEnabled: z.boolean().optional(),
  attendeeCommentsEnabled: z.boolean().optional(),
  priceType:       z.enum(["free", "external"]).nullable().optional(),
  priceUrl:        z.string().url().nullable().optional(),
  category:           z.string().max(60).nullable().optional(),
  city:               z.string().max(100).nullable().optional(),
  country:            z.string().max(100).nullable().optional(),
  showHeaderPublicly: z.boolean().optional(),
});

const RsvpSchema = z.object({
  status: z.enum(["going", "maybe", "interested", "cant_go"]),
});

const RoleSchema = z.object({
  userId: z.string().uuid(),
  role:   z.enum(["co_host", "moderator", "banned"]),
});

// ── POST /api/events ──────────────────────────────────────────────────────────

router.post("/events", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const flagEnabled = await isFlagEnabled(sc, "events_enabled");
  if (!flagEnabled) { sendError(res, "feature_disabled", "Events are not enabled"); return; }

  const parsed = CreateEventSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  if (b.ageMin != null && b.ageMax != null && b.ageMax < b.ageMin) {
    sendError(res, "invalid_payload", "ageMax must be >= ageMin"); return;
  }

  // Spam / content validation (only enforced when publishing immediately)
  if (b.publishNow && b.title) {
    const prohibitedErr = checkProhibitedContent(b.title, b.description);
    if (prohibitedErr) { sendError(res, "invalid_payload", prohibitedErr); return; }

    if (!b.startsAt) {
      sendError(res, "invalid_payload", "startsAt is required to publish an event"); return;
    }

    if (b.endsAt && b.startsAt && new Date(b.endsAt) <= new Date(b.startsAt)) {
      sendError(res, "invalid_payload", "endsAt must be after startsAt"); return;
    }

    const ticketErr = checkTicketUrl((b as any).ticketUrl ?? (b as any).priceUrl);
    if (ticketErr) { sendError(res, "invalid_payload", ticketErr); return; }

    const isDuplicate = await checkDuplicateEvent(sc, user.id, b.locationName, b.startsAt ?? null);
    if (isDuplicate) { sendError(res, "duplicate_event", "An event with the same host, location, and time already exists"); return; }
  }

  const initialState = b.publishNow ? "open" : "draft";

  const { data: ev, error } = await sc
    .from("events")
    .insert({
      host_id:          user.id,
      title:            b.title,
      description:      b.description ?? null,
      location_name:    b.locationName ?? null,
      location_lat:     b.locationLat ?? null,
      location_lng:     b.locationLng ?? null,
      starts_at:        b.startsAt ?? null,
      ends_at:          b.endsAt ?? null,
      cover_url:         b.coverUrl ?? null,
      cover_media_type:  b.coverMediaType ?? null,
      cover_image_width:  b.coverImageWidth ?? null,
      cover_image_height: b.coverImageHeight ?? null,
      max_attendees:    b.maxAttendees ?? null,
      age_min:          b.ageMin ?? null,
      age_max:          b.ageMax ?? null,
      trust_score_min:  b.trustScoreMin ?? null,
      verified_only:    b.verifiedOnly ?? false,
      visibility:       b.visibility,
      circle_id:        b.circleId ?? null,
      trip_id:          b.tripId ?? null,
      state:            initialState,
      chat_enabled:     b.chatEnabled ?? true,
      waitlist_enabled: b.waitlistEnabled ?? true,
      price_type:       b.priceType ?? null,
      price_url:        b.priceUrl ?? null,
      rsvp_options:     b.rsvpOptions ?? ["going", "maybe", "interested", "cant_go"],
      category:             b.category ?? null,
      city:                 b.city ?? null,
      country:              b.country ?? null,
      // Public events always show header publicly; respect client preference for non-public.
      show_header_publicly: b.showHeaderPublicly ?? (b.visibility === "public"),
    })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "create event"); sendError(res, "db_error", error.message); return; }

  // Insert cover media record into event_media (best-effort; non-fatal)
  if (b.coverUrl && b.coverMediaType) {
    await sc.from("event_media").insert({
      event_id:    (ev as any).id,
      uploader_id: user.id,
      media_url:   b.coverUrl,
      media_type:  b.coverMediaType,
      caption:     "cover",
    }).then(undefined, (e: any) => { req.log.warn({ err: e }, "insert cover event_media failed (non-fatal)"); });
  }

  // Insert host role record
  await sc.from("event_roles").insert({ event_id: (ev as any).id, user_id: user.id, role: "host" }).then(undefined, () => {});

  // Create Telegraph group chat if enabled
  if (b.chatEnabled !== false && b.publishNow) {
    await createEventChatThread(sc, (ev as any).id, b.title, user.id);
  }

  // Language detection — fire-and-forget; sets events.original_language for translation.
  if (b.title?.trim()) {
    const _sc = getServiceClient();
    if (_sc) {
      const textToDetect = b.description ? `${b.title} ${b.description}` : b.title;
      detectAndStoreLanguage(_sc, 'event', (ev as any).id, textToDetect, req.log).catch(() => {});
    }
  }

  // Creator is always the host → participant view
  res.status(201).json(formatEvent(ev as any, user.id, { goingRsvp: true }));
});

// ── GET /api/events ───────────────────────────────────────────────────────────

router.get("/events", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const sessionId = randomUUID();

  const page   = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit  = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset = (page - 1) * limit;

  // Browse states only. `state` is caller-supplied and is spliced straight into
  // the PostgREST .in() filter below, so without an allowlist `?state=draft`
  // (or cancelled, or archived) turned this feed into a reader for other hosts'
  // unpublished events — precisely the states every sibling browse route
  // hard-excludes, and which canViewEvent refuses on the detail endpoint.
  // An unrecognised value falls back to the default rather than 400ing, so no
  // existing client breaks on a typo.
  const stateParam = (req.query.state as string) ?? "open";
  const state    = (stateParam === "all" || BROWSE_STATES.includes(stateParam)) ? stateParam : "open";
  const city     = (req.query.city as string | undefined) ?? null;
  const category = (req.query.category as string) ?? null;

  const dateFrom = (req.query.dateFrom as string) ?? null;
  const dateTo   = (req.query.dateTo as string) ?? null;

  // Fetch a larger candidate pool so the ranker has meaningful diversity to
  // work with — the final page slice happens after rankCandidates().
  // starts_at is kept as a secondary sort so the DB returns chronologically
  // sensible rows before ranking applies the actionability kernel.
  const RANK_POOL_SIZE = 200;
  let query = sc
    // perf-trim: explicit column list replaces SELECT * — only columns consumed by formatEvent
    // and the ranking pipeline are fetched; unused DB columns stay server-side
    .from("events")
    .select(
      "id, host_id, title, description, location_name, location_lat, location_lng, " +
      "starts_at, ends_at, cover_url, cover_media_type, max_attendees, age_min, age_max, " +
      "trust_score_min, verified_only, visibility, state, chat_enabled, chat_thread_id, " +
      "waitlist_enabled, price_type, price_url, safety_notes, rsvp_options, going_count, " +
      "waitlist_count, category, city, country, show_exact_location, rsvp_closed, " +
      "tags, created_at, updated_at",
    )
    .in("state", state === "all" ? BROWSE_STATES : [state])
    .in("visibility", ["public", "friends_only"])
    .order("starts_at", { ascending: true, nullsFirst: false })
    .limit(RANK_POOL_SIZE);

  if (city)     query = query.ilike("city", `%${city}%`);
  if (category) query = query.eq("category", category);
  if (dateFrom) query = query.gte("starts_at", dateFrom);
  if (dateTo)   query = query.lte("starts_at", dateTo);

  const { data: events, error } = await query;

  if (error) { req.log.error({ err: error }, "list events"); sendError(res, "db_error", error.message); return; }

  // ── Batched visibility filtering ────────────────────────────────────────────
  // Same rules as the old per-row loop (block → friends_only → eligibility with
  // staff bypass, ban, and trust/age/verified gates) but with a fixed number of
  // queries regardless of page size — important now that city is optional and
  // the default feed can return a full unfiltered page.
  const rows = (events as any[]) ?? [];
  const otherHostIds = [...new Set(rows.map((e: any) => e.host_id as string))].filter((h) => h !== user.id);

  // Blocks in either direction — two batched queries
  const blockedHosts = new Set<string>();
  if (otherHostIds.length > 0) {
    const [b1, b2] = await Promise.all([
      sc.from("blocks").select("blocked_id").eq("blocker_id", user.id).in("blocked_id", otherHostIds),
      sc.from("blocks").select("blocker_id").eq("blocked_id", user.id).in("blocker_id", otherHostIds),
    ]);
    for (const b of (((b1 as any).data as any[]) ?? [])) blockedHosts.add(b.blocked_id as string);
    for (const b of (((b2 as any).data as any[]) ?? [])) blockedHosts.add(b.blocker_id as string);
  }

  // Friendships, only for hosts of friends_only events
  const friendsOnlyHosts = [...new Set(
    rows.filter((e: any) => e.visibility === "friends_only" && e.host_id !== user.id)
        .map((e: any) => e.host_id as string),
  )];
  const friendHosts = new Set<string>();
  if (friendsOnlyHosts.length > 0) {
    const [f1, f2] = await Promise.all([
      sc.from("user_friendships").select("user_b").eq("user_a", user.id).in("user_b", friendsOnlyHosts),
      sc.from("user_friendships").select("user_a").eq("user_b", user.id).in("user_a", friendsOnlyHosts),
    ]);
    for (const f of (((f1 as any).data as any[]) ?? [])) friendHosts.add(f.user_b as string);
    for (const f of (((f2 as any).data as any[]) ?? [])) friendHosts.add(f.user_a as string);
  }

  // Viewer's roles across the listed events (staff bypass / banned)
  const allEventIds = rows.map((e: any) => e.id as string);

  // BUG AY fix: `events.going_count` is a cached counter maintained by the
  // RSVP write paths, but it can drift from the real event_rsvps rows (e.g.
  // seeded/demo data, or a write path that updates one but not the other).
  // The detail endpoint (GET /api/events/:id) always computes its `going`
  // count live from event_rsvps, so the list/card endpoint must do the same
  // — otherwise the Pulse card and the detail screen can show two different
  // numbers for the same event. Overwrite the cached column with a live
  // per-event count before ranking/formatting.
  if (allEventIds.length > 0) {
    const { data: liveGoingRows } = await sc
      .from("event_rsvps")
      .select("event_id")
      .in("event_id", allEventIds)
      .eq("status", "going");
    const liveGoingCounts = new Map<string, number>();
    for (const r of ((liveGoingRows as any[]) ?? [])) {
      const eid = r.event_id as string;
      liveGoingCounts.set(eid, (liveGoingCounts.get(eid) ?? 0) + 1);
    }
    for (const ev of rows) {
      (ev as any).going_count = liveGoingCounts.get(ev.id as string) ?? 0;
    }
  }

  const staffEvents  = new Set<string>();
  const bannedEvents = new Set<string>();
  if (allEventIds.length > 0) {
    const { data: roles } = await sc
      .from("event_roles")
      .select("event_id, role")
      .eq("user_id", user.id)
      .in("event_id", allEventIds)
      .in("role", ["co_host", "moderator", "banned"]);
    for (const r of ((roles as any[]) ?? [])) {
      if ((r as any).role === "banned") bannedEvents.add((r as any).event_id as string);
      else staffEvents.add((r as any).event_id as string);
    }
  }

  // Viewer gate inputs — fetched once, only when some event actually has gates
  const needsGates = rows.some((e: any) =>
    e.host_id !== user.id && (e.verified_only || e.trust_score_min != null || e.age_min != null || e.age_max != null));
  let trustGatesEnabled = false;
  let viewerVerified = false;
  let viewerAge: number | null = null;
  let viewerTrust = 50;
  if (needsGates) {
    trustGatesEnabled = await isFlagEnabled(sc, "events_trust_gates_enabled");
    if (trustGatesEnabled) {
      const [profileRes, tpRes] = await Promise.all([
        sc.from("profiles").select("verified, date_of_birth").eq("id", user.id).maybeSingle(),
        sc.from("trust_profiles").select("overall_score").eq("user_id", user.id).maybeSingle(),
      ]);
      const profile = (profileRes as any).data;
      viewerVerified = !!profile?.verified;
      viewerTrust = ((tpRes as any).data)?.overall_score ?? 50;
      viewerAge = profile?.date_of_birth
        ? Math.floor((Date.now() - new Date(profile.date_of_birth).getTime()) / (1000 * 60 * 60 * 24 * 365.25))
        : null;
    }
  }

  const filtered: any[] = rows.filter((ev: any) => {
    if (ev.host_id === user.id) return true;
    if (blockedHosts.has(ev.host_id as string)) return false;
    if (ev.visibility === "friends_only" && !friendHosts.has(ev.host_id as string)) return false;
    if (staffEvents.has(ev.id as string)) return true;   // co-hosts/moderators bypass viewer gates
    if (bannedEvents.has(ev.id as string)) return false;
    if (trustGatesEnabled) {
      if (ev.verified_only && !viewerVerified) return false;
      if (ev.trust_score_min != null && viewerTrust < ev.trust_score_min) return false;
      if (ev.age_min != null || ev.age_max != null) {
        if (viewerAge == null) return false;
        if (ev.age_min != null && viewerAge < ev.age_min) return false;
        if (ev.age_max != null && viewerAge > ev.age_max) return false;
      }
    }
    return true;
  });

  // Fetch user RSVPs and waitlist positions for these events
  const eventIds = filtered.map((e: any) => e.id as string);
  let rsvpMap: Record<string, string> = {};
  let waitlistPositionMap: Record<string, number> = {};
  if (eventIds.length > 0) {
    const [rsvpResult, waitlistResult] = await Promise.all([
      sc.from("event_rsvps").select("event_id, status").eq("user_id", user.id).in("event_id", eventIds),
      sc.from("event_waitlist").select("event_id, position").eq("user_id", user.id).in("event_id", eventIds),
    ]);
    for (const r of ((rsvpResult as any).data as any[]) ?? []) {
      rsvpMap[(r as any).event_id as string] = (r as any).status as string;
    }
    for (const w of ((waitlistResult as any).data as any[]) ?? []) {
      waitlistPositionMap[(w as any).event_id as string] = (w as any).position as number;
    }
  }

  // Batch-fetch saved state for this user across these events
  let savedEventIds = new Set<string>();
  if (eventIds.length > 0) {
    try {
      const { data: userCols } = await sc
        .from("collections")
        .select("id")
        .eq("owner_id", user.id);
      const colIds = ((userCols ?? []) as any[]).map((c) => c.id as string);
      if (colIds.length > 0) {
        const { data: savedItems } = await sc
          .from("collection_items")
          .select("entity_id")
          .eq("entity_type", "event")
          .in("collection_id", colIds)
          .in("entity_id", eventIds);
        for (const s of (savedItems ?? []) as any[]) savedEventIds.add(s.entity_id as string);
      }
    } catch {
      // non-fatal — isSaved defaults to false
    }
  }

  // Batch-fetch host profiles for display on cards
  const hostIds = [...new Set(filtered.map((e: any) => e.host_id as string))];
  const hostProfileMap: Record<string, { name?: string | null; handle?: string | null; avatar_url?: string | null }> = {};

  // Batch-fetch host trust scores for rankCandidates' authorTrustScore signal.
  // Missing scores contribute 0 to rank — never a crash (portavaRank spec §42).
  const hostTrustMap = new Map<string, number>();

  if (hostIds.length > 0) {
    const [hpsResult, trustResult] = await Promise.all([
      sc.from("profiles").select("id, name, handle, avatar_url").in("id", hostIds),
      (async () => {
        try {
          return await sc
            .from("trust_profiles")
            .select("user_id, overall_score")
            .in("user_id", hostIds);
        } catch {
          return { data: null };
        }
      })(),
    ]);
    const allowedNames = await nameVisibilitySet(sc, hostIds);
    for (const p of ((hpsResult as any).data as any[]) ?? []) hostProfileMap[p.id as string] = sanitizeIdentity(p, allowedNames, user.id);
    for (const t of ((trustResult as any).data as any[]) ?? []) hostTrustMap.set(t.user_id as string, t.overall_score as number);
  }

  // ── Portava ranking (spec §42) ────────────────────────────────────────────
  // Load viewer signals (follows + interest tags) then route the filtered
  // candidate pool through rankCandidates(). starts_at chronological order
  // is preserved as a tiebreaker via the actionability kernel — events
  // starting soon from trusted hosts rank above stale or low-trust events.

  let followedIds = new Set<string>();
  try {
    const { data: followRows } = await sc
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", user.id);
    for (const row of (followRows as any[]) ?? []) followedIds.add(row.following_id as string);
  } catch { /* non-fatal */ }

  let interestTags = new Set<string>();
  try {
    const { data: prefRow } = await sc
      .from("compass_user_preferences")
      .select("interests")
      .eq("user_id", user.id)
      .maybeSingle();
    const interests: string[] = (prefRow as any)?.interests ?? [];
    interestTags = new Set(interests.map((t: string) => t.toLowerCase()));
  } catch { /* non-fatal */ }

  const viewerContext: ViewerContext = {
    userId: user.id,
    city: city ? city.toLowerCase() : undefined,
    followedIds,
    interestTags,
  };

  type EventCandidate = RankCandidate & { __ev: any };
  const eventCandidates: EventCandidate[] = filtered.map((ev: any) => ({
    id: ev.id as string,
    kind: "event" as const,
    startsAt: (ev.starts_at as string | null) ?? null,
    createdAt: (ev.created_at as string | null) ?? null,
    city: ev.city ? (ev.city as string).toLowerCase() : null,
    category: (ev.category as string | null) ?? null,
    authorId: (ev.host_id as string | null) ?? null,
    authorTrustScore: hostTrustMap.get(ev.host_id as string) ?? null,
    hasCapacity: ev.max_attendees == null || ((ev.going_count ?? 0) as number) < (ev.max_attendees as number),
    tags: Array.isArray(ev.tags) ? (ev.tags as string[]).map((t) => t.toLowerCase()) : [],
    __ev: ev,
  }));

  const rankedScored = rankCandidates(eventCandidates, viewerContext);
  const rankedEvents = rankedScored.map((s) => (s.candidate as EventCandidate).__ev);

  // Paginate the ranked result — log only what is actually served
  const pagedEvents = rankedEvents.slice(offset, offset + limit);
  void logImpression(rankedScored.slice(offset, offset + limit), user.id, "events", sessionId);

  res.json({
    events: pagedEvents.map((ev: any) => ({
      ...formatEvent(ev, user.id, { hostProfile: hostProfileMap[ev.host_id as string] }),
      myRsvp:              rsvpMap[ev.id] ?? null,
      myWaitlistPosition:  waitlistPositionMap[ev.id] ?? null,
      isSaved:             savedEventIds.has(ev.id as string),
    })),
    page,
    limit,
    sessionId,
  });
});

// ── GET /api/events/city/:city ───────────────────────────────────────────────
// Convenience alias for the main list endpoint filtered to a specific city.

router.get("/events/city/:city", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const city     = req.params.city;
  const page     = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit    = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset   = (page - 1) * limit;
  const category = (req.query.category as string) ?? null;

  // perf-trim: explicit column list replaces SELECT * — only formatEvent fields fetched
  let query = sc
    .from("events")
    .select(
      "id, host_id, title, description, location_name, location_lat, location_lng, " +
      "starts_at, ends_at, cover_url, cover_media_type, max_attendees, age_min, age_max, " +
      "trust_score_min, verified_only, visibility, state, chat_enabled, chat_thread_id, " +
      "waitlist_enabled, price_type, price_url, safety_notes, rsvp_options, going_count, " +
      "waitlist_count, category, city, country, show_exact_location, rsvp_closed, " +
      "tags, created_at, updated_at",
    )
    .not("state", "in", '("draft","cancelled","archived")')
    .in("visibility", ["public","friends_only"])
    .ilike("city", `%${city}%`)
    .order("starts_at", { ascending: true, nullsFirst: false })
    .range(offset, offset + limit - 1);

  if (category) query = query.eq("category", category);

  const { data: events, error } = await query;
  if (error) { req.log.error({ err: error }, "city events"); sendError(res, "db_error", error.message); return; }

  const filtered: any[] = [];
  for (const ev of (events as any[]) ?? []) {
    if (await isBlocked(sc, user.id, (ev as any).host_id)) continue;
    if ((ev as any).visibility === "friends_only" && (ev as any).host_id !== user.id) {
      const { data: friendship } = await sc
        .from("user_friendships")
        .select("user_a")
        .or(`and(user_a.eq.${user.id},user_b.eq.${(ev as any).host_id}),and(user_b.eq.${user.id},user_a.eq.${(ev as any).host_id})`)
        .maybeSingle();
      if (!friendship) continue;
    }
    const elig = await checkEventEligibility(sc, ev as any, user.id);
    if (!elig.ok) continue;
    filtered.push(ev);
  }

  const cityEventIds = filtered.map((e: any) => e.id as string);
  let cityRsvpMap: Record<string, string> = {};
  let cityWaitlistPositionMap: Record<string, number> = {};
  if (cityEventIds.length > 0) {
    const [cityRsvpResult, cityWaitlistResult] = await Promise.all([
      sc.from("event_rsvps").select("event_id, status").eq("user_id", user.id).in("event_id", cityEventIds),
      sc.from("event_waitlist").select("event_id, position").eq("user_id", user.id).in("event_id", cityEventIds),
    ]);
    for (const r of ((cityRsvpResult as any).data as any[]) ?? []) {
      cityRsvpMap[(r as any).event_id as string] = (r as any).status as string;
    }
    for (const w of ((cityWaitlistResult as any).data as any[]) ?? []) {
      cityWaitlistPositionMap[(w as any).event_id as string] = (w as any).position as number;
    }
  }

  // BUG AY fix: same cached-vs-live going_count drift as the main list
  // endpoint — recompute from event_rsvps so this alias never disagrees
  // with the detail screen either.
  if (cityEventIds.length > 0) {
    const { data: liveGoingRows } = await sc
      .from("event_rsvps")
      .select("event_id")
      .in("event_id", cityEventIds)
      .eq("status", "going");
    const liveGoingCounts = new Map<string, number>();
    for (const r of ((liveGoingRows as any[]) ?? [])) {
      const eid = (r as any).event_id as string;
      liveGoingCounts.set(eid, (liveGoingCounts.get(eid) ?? 0) + 1);
    }
    for (const ev of filtered) {
      (ev as any).going_count = liveGoingCounts.get(ev.id as string) ?? 0;
    }
  }

  res.json({
    events: filtered.map((e: any) => ({
      ...formatEvent(e, user.id),
      myRsvp:             cityRsvpMap[e.id] ?? null,
      myWaitlistPosition: cityWaitlistPositionMap[e.id] ?? null,
    })),
    page,
    limit,
  });
});

// ── GET /api/events/nearby ────────────────────────────────────────────────────
// Returns events within an approximate bounding box (degrees ≈ km at equator).

router.get("/events/nearby", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const lat = parseFloat((req.query.lat as string) ?? "");
  const lng = parseFloat((req.query.lng as string) ?? "");
  const radiusKm = Math.min(200, Math.max(1, parseFloat((req.query.radiusKm as string) ?? "50")));

  if (isNaN(lat) || isNaN(lng)) {
    sendError(res, "invalid_payload", "lat and lng query params are required"); return;
  }

  // ~1 degree latitude ≈ 111 km; longitude offset varies by lat
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));

  const page   = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit  = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset = (page - 1) * limit;

  const { data: events, error } = await sc
    .from("events")
    .select("*")
    .not("state", "in", '("draft","cancelled","archived")')
    .in("visibility", ["public","friends_only"])
    .gte("location_lat", lat - latDelta)
    .lte("location_lat", lat + latDelta)
    .gte("location_lng", lng - lngDelta)
    .lte("location_lng", lng + lngDelta)
    .order("starts_at", { ascending: true, nullsFirst: false })
    .range(offset, offset + limit - 1);

  if (error) { req.log.error({ err: error }, "nearby events"); sendError(res, "db_error", error.message); return; }

  const filtered: any[] = [];
  for (const ev of (events as any[]) ?? []) {
    if (await isBlocked(sc, user.id, (ev as any).host_id)) continue;
    if ((ev as any).visibility === "friends_only" && (ev as any).host_id !== user.id) {
      const { data: friendship } = await sc
        .from("user_friendships")
        .select("user_a")
        .or(`and(user_a.eq.${user.id},user_b.eq.${(ev as any).host_id}),and(user_b.eq.${user.id},user_a.eq.${(ev as any).host_id})`)
        .maybeSingle();
      if (!friendship) continue;
    }
    const elig = await checkEventEligibility(sc, ev as any, user.id);
    if (!elig.ok) continue;
    filtered.push(ev);
  }

  const nearbyEventIds = filtered.map((e: any) => e.id as string);
  let nearbyRsvpMap: Record<string, string> = {};
  let nearbyWaitlistPositionMap: Record<string, number> = {};
  if (nearbyEventIds.length > 0) {
    const [nearbyRsvpResult, nearbyWaitlistResult] = await Promise.all([
      sc.from("event_rsvps").select("event_id, status").eq("user_id", user.id).in("event_id", nearbyEventIds),
      sc.from("event_waitlist").select("event_id, position").eq("user_id", user.id).in("event_id", nearbyEventIds),
    ]);
    for (const r of ((nearbyRsvpResult as any).data as any[]) ?? []) {
      nearbyRsvpMap[(r as any).event_id as string] = (r as any).status as string;
    }
    for (const w of ((nearbyWaitlistResult as any).data as any[]) ?? []) {
      nearbyWaitlistPositionMap[(w as any).event_id as string] = (w as any).position as number;
    }
  }

  res.json({
    events: filtered.map((e: any) => ({
      ...formatEvent(e, user.id),
      myRsvp:             nearbyRsvpMap[e.id] ?? null,
      myWaitlistPosition: nearbyWaitlistPositionMap[e.id] ?? null,
    })),
    page,
    limit,
  });
});

// ── GET /api/events/search ────────────────────────────────────────────────────

router.get("/events/search", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const q = ((req.query.q as string) ?? "").trim();
  if (q.length < 2) { sendError(res, "invalid_payload", "q must be at least 2 characters"); return; }

  const page   = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit  = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset = (page - 1) * limit;

  // Fetch without DB-level pagination so friendship/block filtering produces a
  // consistent result set before we slice — DB range + post-filter double-slices.
  const { data: byTitle } = await sc
    .from("events")
    .select("*")
    .not("state", "in", '("draft","cancelled","archived")')
    .in("visibility", ["public","friends_only"])
    .ilike("title", `%${q}%`)
    .order("starts_at", { ascending: true, nullsFirst: false });

  const { data: byCity } = await sc
    .from("events")
    .select("*")
    .not("state", "in", '("draft","cancelled","archived")')
    .in("visibility", ["public","friends_only"])
    .ilike("city", `%${q}%`)
    .order("starts_at", { ascending: true, nullsFirst: false });

  // Merge, dedupe, enforce friendship + block + eligibility — then paginate
  const seen = new Set<string>();
  const merged: any[] = [];
  for (const ev of [...((byTitle as any[]) ?? []), ...((byCity as any[]) ?? [])]) {
    if (seen.has((ev as any).id)) continue;
    seen.add((ev as any).id);
    if (await isBlocked(sc, user.id, (ev as any).host_id)) continue;
    if ((ev as any).visibility === "friends_only" && (ev as any).host_id !== user.id) {
      const { data: friendship } = await sc
        .from("user_friendships")
        .select("user_a")
        .or(`and(user_a.eq.${user.id},user_b.eq.${(ev as any).host_id}),and(user_b.eq.${user.id},user_a.eq.${(ev as any).host_id})`)
        .maybeSingle();
      if (!friendship) continue;
    }
    const elig = await checkEventEligibility(sc, ev as any, user.id);
    if (!elig.ok) continue;
    merged.push(ev);
  }

  // Single pagination step after full merge+filter
  res.json({ events: merged.slice(offset, offset + limit).map((e: any) => formatEvent(e, user.id)), page, limit, q });
});

// ── GET /api/events/me ────────────────────────────────────────────────────────

router.get("/events/me", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const limit = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));

  const [hostedResult, rsvpResult] = await Promise.all([
    sc.from("events").select("*")
      .eq("host_id", user.id)
      .not("state", "in", '("cancelled","archived")')
      .order("starts_at", { ascending: true, nullsFirst: false })
      .limit(limit),
    sc.from("event_rsvps").select("event_id")
      .eq("user_id", user.id)
      .eq("status", "going"),
  ]);

  const hosted = ((hostedResult as any).data ?? []) as any[];
  const rsvpIds = (((rsvpResult as any).data ?? []) as any[]).map((r: any) => r.event_id as string);

  let attending: any[] = [];
  if (rsvpIds.length > 0) {
    const { data: ev } = await sc.from("events").select("*")
      .in("id", rsvpIds)
      .not("state", "in", '("cancelled","archived")')
      .order("starts_at", { ascending: true, nullsFirst: false })
      .limit(limit);
    attending = (ev as any[]) ?? [];
  }

  const hostedIds = new Set(hosted.map((e: any) => e.id as string));
  const combined = [...hosted, ...attending.filter((e: any) => !hostedIds.has(e.id as string))];

  // All events here are ones the viewer hosts or attends → always participant view.
  // Include myRsvp so the response matches the EventListItem contract used by list cards.
  const goingSet = new Set(rsvpIds);
  res.json({
    events: combined.map((e: any) => ({
      ...formatEvent(e, user.id, { goingRsvp: true }),
      myRsvp: goingSet.has(e.id as string) ? "going" : null,
    })),
  });
});

// ── GET /api/events/hosting ───────────────────────────────────────────────────

router.get("/events/hosting", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const page   = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit  = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset = (page - 1) * limit;
  const state  = (req.query.state as string) ?? null;

  let query = sc.from("events").select("*").eq("host_id", user.id)
    .order("starts_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (state) query = query.eq("state", state);

  const { data: events, error } = await query;
  if (error) { req.log.error({ err: error }, "hosting events"); sendError(res, "db_error", error.message); return; }

  res.json({ events: ((events as any[]) ?? []).map((e: any) => formatEvent(e, user.id, { goingRsvp: true })), page, limit });
});

// ── GET /api/events/joined ────────────────────────────────────────────────────

router.get("/events/joined", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const page   = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit  = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset = (page - 1) * limit;

  const { data: rsvps } = await sc.from("event_rsvps").select("event_id")
    .eq("user_id", user.id).eq("status", "going");

  const ids = ((rsvps as any[]) ?? []).map((r: any) => r.event_id as string);
  if (ids.length === 0) { res.json({ events: [], page, limit }); return; }

  const { data: events, error } = await sc.from("events").select("*")
    .in("id", ids)
    .not("state", "in", '("cancelled","archived")')
    .order("starts_at", { ascending: true, nullsFirst: false })
    .range(offset, offset + limit - 1);

  if (error) { req.log.error({ err: error }, "joined events"); sendError(res, "db_error", error.message); return; }

  res.json({ events: ((events as any[]) ?? []).map((e: any) => formatEvent(e, user.id, { goingRsvp: true })), page, limit });
});

// ── GET /api/events/circles ───────────────────────────────────────────────────
// Events from circles the viewer belongs to (visibility = 'circle').

router.get("/events/circles", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const limit  = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const cursor = (req.query.cursor as string) ?? null;

  // Step 1 — Fetch all circle IDs the viewer belongs to (member or owner).
  // Live table is circle_memberships(user_id = circle owner, other_id = member,
  // status, created_at); a circle's id is its owner's user id.
  const { data: memberRows } = await sc
    .from("circle_memberships")
    .select("user_id")
    .eq("other_id", user.id);

  // The viewer always belongs to their own circle (owner has no self-membership row).
  const circleIds = [...new Set([
    user.id,
    ...(((memberRows as any[]) ?? []).map((r: any) => r.user_id as string)),
  ])];

  // Step 2 — Fetch candidate events linked to these circles
  let query = sc
    .from("events")
    .select("*")
    .in("circle_id", circleIds)
    .not("state", "in", '("cancelled","archived","draft")')
    .order("starts_at", { ascending: true, nullsFirst: false })
    .limit(limit * 3); // over-fetch to allow for post-filter attrition

  if (cursor) query = query.gt("starts_at", cursor);

  const { data: events, error } = await query;
  if (error) { req.log.error({ err: error }, "circle events"); sendError(res, "db_error", error.message); return; }

  // Step 3 — Apply the same access gates as other browse endpoints:
  //   • block check (viewer blocked by or has blocked host)
  //   • invite_only: viewer must be host, a circle member is allowed since
  //     the event is explicitly scoped to the circle they belong to
  //   • age / trust / verified-profile eligibility
  const filtered: any[] = [];
  for (const ev of (events as any[]) ?? []) {
    if (filtered.length >= limit) break;
    // Block check — skip events whose host the viewer has blocked or vice versa
    if (await isBlocked(sc, user.id, (ev as any).host_id)) continue;
    // Eligibility gate (age / trust / verified)
    const elig = await checkEventEligibility(sc, ev as any, user.id);
    if (!elig.ok) continue;
    filtered.push(ev);
  }

  // Step 4 — Batch-fetch host profiles for card display
  const hostIdSet = [...new Set(filtered.map((e: any) => e.host_id as string))];
  const hpMap: Record<string, { name?: string | null; avatar_url?: string | null }> = {};
  if (hostIdSet.length > 0) {
    const { data: hps } = await sc.from("profiles").select("id, name, handle, avatar_url").in("id", hostIdSet);
    const allowedNames = await nameVisibilitySet(sc, hostIdSet);
    for (const p of (hps as any[]) ?? []) hpMap[p.id as string] = sanitizeIdentity(p, allowedNames, user.id);
  }

  // Step 5 — Batch-fetch viewer RSVP state so card CTAs are accurate
  const filteredIds = filtered.map((e: any) => e.id as string);
  let rsvpMap: Record<string, string> = {};
  if (filteredIds.length > 0) {
    const { data: rsvps } = await sc
      .from("event_rsvps")
      .select("event_id, status")
      .eq("user_id", user.id)
      .in("event_id", filteredIds);
    for (const r of (rsvps as any[]) ?? []) rsvpMap[(r as any).event_id as string] = (r as any).status as string;
  }

  const nextCursor = filtered.length === limit
    ? (filtered[filtered.length - 1].starts_at ?? null)
    : null;

  res.json({
    events: filtered.map((e: any) => ({
      ...formatEvent(e, user.id, { hostProfile: hpMap[e.host_id as string] }),
      myRsvp: rsvpMap[e.id as string] ?? null,
    })),
    cursor: nextCursor,
  });
});

// ── GET /api/events/saved ─────────────────────────────────────────────────────

router.get("/events/saved", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const page   = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit  = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset = (page - 1) * limit;

  const { data: saves } = await sc.from("event_saves").select("event_id")
    .eq("user_id", user.id)
    .order("saved_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const ids = ((saves as any[]) ?? []).map((r: any) => r.event_id as string);
  if (ids.length === 0) { res.json({ events: [], page, limit }); return; }

  const { data: events, error } = await sc.from("events").select("*").in("id", ids);
  if (error) { req.log.error({ err: error }, "saved events"); sendError(res, "db_error", error.message); return; }

  // For saved events, determine per-event whether viewer is a participant (going/maybe or host)
  const { data: savedRsvps } = await sc.from("event_rsvps").select("event_id, status")
    .eq("user_id", user.id).in("event_id", ids);
  const savedRsvpSet = new Set<string>(
    ((savedRsvps as any[]) ?? [])
      .filter((r: any) => r.status === "going" || r.status === "maybe")
      .map((r: any) => r.event_id as string),
  );

  res.json({
    events: ((events as any[]) ?? []).map((e: any) =>
      formatEvent(e, user.id, { goingRsvp: savedRsvpSet.has(e.id as string) }),
    ),
    page,
    limit,
  });
});

// ── GET /api/events/invites ───────────────────────────────────────────────────

router.get("/events/invites", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const page   = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit  = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset = (page - 1) * limit;

  const { data: invites, error } = await sc.from("event_invites").select("*")
    .eq("invitee_id", user.id).eq("status", "pending")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { req.log.error({ err: error }, "list invites"); sendError(res, "db_error", error.message); return; }

  const inviteRows = (invites as any[]) ?? [];
  const eventIds = [...new Set(inviteRows.map((i: any) => i.event_id as string))];
  const inviterIds = [...new Set(inviteRows.map((i: any) => i.inviter_id as string))];

  let eventMap: Record<string, any> = {};
  let inviterMap: Record<string, any> = {};

  if (eventIds.length > 0) {
    const { data: evs } = await sc.from("events").select("*").in("id", eventIds);
    for (const e of (evs as any[]) ?? []) eventMap[e.id as string] = e;
  }
  if (inviterIds.length > 0) {
    const { data: profiles } = await sc.from("profiles").select("id, handle, name, avatar_url").in("id", inviterIds);
    const allowedNames = await nameVisibilitySet(sc, inviterIds);
    for (const p of (profiles as any[]) ?? []) inviterMap[p.id as string] = sanitizeIdentity(p, allowedNames, user.id);
  }

  res.json({
    invites: inviteRows.map((inv: any) => ({
      id:        inv.id,
      eventId:   inv.event_id,
      status:    inv.status,
      createdAt: inv.created_at,
      inviter: inviterMap[inv.inviter_id]
        ? { id: inv.inviter_id, handle: inviterMap[inv.inviter_id].handle, displayName: inviterMap[inv.inviter_id].name, avatarUrl: inviterMap[inv.inviter_id].avatar_url }
        : null,
      event: eventMap[inv.event_id] ? formatEvent(eventMap[inv.event_id], user.id) : null,
    })),
    page,
    limit,
  });
});

// ── GET /api/events/requests ──────────────────────────────────────────────────
// My outgoing join requests.

router.get("/events/requests", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const page   = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit  = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset = (page - 1) * limit;

  const { data: requests, error } = await sc.from("event_join_requests").select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { req.log.error({ err: error }, "my requests"); sendError(res, "db_error", error.message); return; }

  const reqRows = (requests as any[]) ?? [];
  const eventIds = [...new Set(reqRows.map((r: any) => r.event_id as string))];

  let eventMap: Record<string, any> = {};
  if (eventIds.length > 0) {
    const { data: evs } = await sc.from("events").select("*").in("id", eventIds);
    for (const e of (evs as any[]) ?? []) eventMap[e.id as string] = e;
  }

  res.json({
    requests: reqRows.map((r: any) => ({
      id:       r.id,
      eventId:  r.event_id,
      status:   r.status,
      message:  r.message ?? null,
      createdAt: r.created_at,
      event:    eventMap[r.event_id] ? formatEvent(eventMap[r.event_id], user.id) : null,
    })),
    page,
    limit,
  });
});

// Draft rows are stored as { id, host_id, data: {...fields}, last_saved_at,
// created_at }. The client's EventDraft shape expects the fields flattened to
// the top level plus `updatedAt` — without this mapping the title/date fields
// are always undefined, showing "Untitled draft" / "Saved Invalid Date".
function toClientDraft(row: Record<string, any>): Record<string, any> {
  const { data, last_saved_at, host_id, ...rest } = row;
  return {
    ...rest,
    ...(data && typeof data === "object" ? data : {}),
    updatedAt: last_saved_at,
  };
}

// ── GET /api/events/drafts ────────────────────────────────────────────────────

router.get("/events/drafts", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const page   = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit  = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset = (page - 1) * limit;

  const { data: drafts, error } = await sc.from("event_drafts").select("*")
    .eq("host_id", user.id)
    .order("last_saved_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { req.log.error({ err: error }, "list drafts"); sendError(res, "db_error", error.message); return; }

  res.json({ drafts: (drafts ?? []).map(toClientDraft), page, limit });
});

// ── POST /api/events/drafts ───────────────────────────────────────────────────

router.post("/events/drafts", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const data = req.body ?? {};

  const { data: draft, error } = await sc.from("event_drafts").insert({
    host_id:       user.id,
    data,
    last_saved_at: new Date().toISOString(),
  }).select("*").single();

  if (error) { req.log.error({ err: error }, "create draft"); sendError(res, "db_error", error.message); return; }

  res.status(201).json(toClientDraft(draft));
});

// ── GET /api/events/drafts/:draftId ──────────────────────────────────────────

router.get("/events/drafts/:draftId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { draftId } = req.params;
  if (!isUuid(draftId)) { sendError(res, "invalid_payload", "Invalid draft id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: draft, error } = await sc
    .from("event_drafts")
    .select("*")
    .eq("id", draftId)
    .eq("host_id", user.id)
    .maybeSingle();

  if (error) { req.log.error({ err: error }, "get draft"); sendError(res, "db_error", error.message); return; }
  if (!draft) { sendError(res, "not_found", "Draft not found"); return; }

  res.json(toClientDraft(draft));
});

// ── PATCH /api/events/drafts/:draftId ─────────────────────────────────────────

router.patch("/events/drafts/:draftId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { draftId } = req.params;
  if (!isUuid(draftId)) { sendError(res, "invalid_payload", "Invalid draft id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: existing } = await sc.from("event_drafts").select("host_id").eq("id", draftId).maybeSingle();
  if (!existing) { sendError(res, "not_found", "Draft not found"); return; }
  if ((existing as any).host_id !== user.id) { sendError(res, "forbidden", "Not your draft"); return; }

  const { data: updated, error } = await sc.from("event_drafts")
    .update({ data: req.body ?? {}, last_saved_at: new Date().toISOString() })
    .eq("id", draftId)
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "update draft"); sendError(res, "db_error", error.message); return; }

  res.json(toClientDraft(updated));
});

// ── DELETE /api/events/drafts/:draftId ────────────────────────────────────────

router.delete("/events/drafts/:draftId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { draftId } = req.params;
  if (!isUuid(draftId)) { sendError(res, "invalid_payload", "Invalid draft id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: existing } = await sc.from("event_drafts").select("host_id").eq("id", draftId).maybeSingle();
  if (!existing) { sendError(res, "not_found", "Draft not found"); return; }
  if ((existing as any).host_id !== user.id) { sendError(res, "forbidden", "Not your draft"); return; }

  await sc.from("event_drafts").delete().eq("id", draftId);
  res.json({ ok: true });
});

// ── POST /api/events/drafts/:draftId/publish ──────────────────────────────────

const PublishDraftSchema = CreateEventSchema.extend({
  title:     z.string().min(1).max(200),
  startsAt:  z.string(),
  // ends_at is nullable in the events model — a valid start-only event may be published.
  endsAt:    z.string().optional().nullable(),
  locationName: z.string().min(1).max(300),
});

router.post("/events/drafts/:draftId/publish", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { draftId } = req.params;
  if (!isUuid(draftId)) { sendError(res, "invalid_payload", "Invalid draft id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const flagEnabled = await isFlagEnabled(sc, "events_enabled");
  if (!flagEnabled) { sendError(res, "feature_disabled", "Events are not enabled"); return; }

  const { data: draft } = await sc.from("event_drafts").select("*").eq("id", draftId).maybeSingle();
  if (!draft) { sendError(res, "not_found", "Draft not found"); return; }
  if ((draft as any).host_id !== user.id) { sendError(res, "forbidden", "Not your draft"); return; }

  // Merge draft data with any body overrides
  const body = { ...(draft as any).data, ...req.body };
  const parsed = PublishDraftSchema.safeParse(body);
  // QA round 2, bug 5: the zod issue's `path` was being thrown away, so the
  // client received a bare "Required" with no indication of WHICH field. Prefix
  // the field path so any future validation gap is self-describing.
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path?.join(".");
    sendError(
      res,
      "invalid_payload",
      issue ? `${field ? `${field}: ` : ""}${issue.message}` : "Invalid event data",
    );
    return;
  }

  const b = parsed.data;
  if (b.endsAt && b.startsAt && new Date(b.endsAt) <= new Date(b.startsAt)) {
    sendError(res, "invalid_payload", "endsAt must be after startsAt"); return;
  }

  // Publish-time spam / content / duplicate checks (same rules as /events/:id/publish).
  // Note: rejection logging happens AFTER event insert (below) so we have a valid events.id FK.
  // The rejectedReason is stored temporarily and logged once we know whether the event was created.
  let publishRejectedReason: { type: "content" | "ticket_url" | "duplicate"; detail: string } | null = null;
  const prohibitedErr = checkProhibitedContent(b.title, b.description);
  if (prohibitedErr) { publishRejectedReason = { type: "content", detail: prohibitedErr }; }
  if (!publishRejectedReason) {
    const ticketErr = checkTicketUrl((b as any).priceUrl ?? null);
    if (ticketErr) { publishRejectedReason = { type: "ticket_url", detail: ticketErr }; }
  }
  if (!publishRejectedReason) {
    const isDuplicate = await checkDuplicateEvent(sc, user.id, b.locationName, b.startsAt ?? null);
    if (isDuplicate) { publishRejectedReason = { type: "duplicate", detail: "duplicate" }; }
  }

  // We must have a valid events.id FK to write to event_activity_log.
  // For pre-insert rejections, log against a temporary stub or skip — the draft itself records the attempt.
  if (publishRejectedReason) {
    // Log into a separate draft-rejection audit path (no FK constraint on event_drafts table).
    // This keeps audit data without violating the events FK.
    await sc.from("event_activity_log")
      .insert({
        event_id:   draftId,         // will fail FK if events.id != draftId; swallowed non-fatally
        actor_id:   user.id,
        action:     `draft_publish_rejected_${publishRejectedReason.type}`,
        metadata:   { draftId, reason: publishRejectedReason.detail },
        created_at: new Date().toISOString(),
      })
      .then(undefined, () => {}); // non-fatal: log failure must not block the error response
    switch (publishRejectedReason.type) {
      case "content":     sendError(res, "invalid_payload", publishRejectedReason.detail); return;
      case "ticket_url":  sendError(res, "invalid_payload", publishRejectedReason.detail); return;
      case "duplicate":   sendError(res, "duplicate_event", "A similar event already exists"); return;
    }
  }

  const { data: ev, error } = await sc.from("events").insert({
    host_id:          user.id,
    title:            b.title,
    description:      b.description ?? null,
    location_name:    b.locationName,
    location_lat:     b.locationLat ?? null,
    location_lng:     b.locationLng ?? null,
    starts_at:        b.startsAt,
    ends_at:          b.endsAt ?? null,
    cover_url:         b.coverUrl ?? null,
    cover_media_type:  b.coverMediaType ?? null,
    cover_image_width:  b.coverImageWidth ?? null,
    cover_image_height: b.coverImageHeight ?? null,
    max_attendees:    b.maxAttendees ?? null,
    age_min:          b.ageMin ?? null,
    age_max:          b.ageMax ?? null,
    trust_score_min:  b.trustScoreMin ?? null,
    verified_only:    b.verifiedOnly ?? false,
    visibility:       b.visibility,
    circle_id:        b.circleId ?? null,
    trip_id:          b.tripId ?? null,
    state:            "open",
    chat_enabled:     b.chatEnabled ?? true,
    waitlist_enabled: b.waitlistEnabled ?? true,
    price_type:       b.priceType ?? null,
    price_url:        b.priceUrl ?? null,
    rsvp_options:     b.rsvpOptions ?? ["going","maybe","interested","cant_go"],
    category:         b.category ?? null,
    city:             b.city ?? null,
    country:          b.country ?? null,
  }).select("*").single();

  if (error) { req.log.error({ err: error }, "publish draft"); sendError(res, "db_error", error.message); return; }

  // Insert cover media record into event_media (best-effort; non-fatal)
  if (b.coverUrl && b.coverMediaType) {
    await sc.from("event_media").insert({
      event_id:    (ev as any).id,
      uploader_id: user.id,
      media_url:   b.coverUrl,
      media_type:  b.coverMediaType,
      caption:     "cover",
    }).then(undefined, (e: any) => { req.log.warn({ err: e }, "insert cover event_media (publish draft) failed (non-fatal)"); });
  }

  // Delete the draft now that it's published
  await sc.from("event_drafts").delete().eq("id", draftId);

  // Language detection — fire-and-forget; sets events.original_language for translation.
  if (b.title?.trim()) {
    const textToDetect = b.description ? `${b.title} ${b.description}` : b.title;
    detectAndStoreLanguage(sc, 'event', (ev as any).id, textToDetect, req.log).catch(() => {});
  }

  // Publisher is always the host → participant view
  res.status(201).json(formatEvent(ev as any, user.id, { goingRsvp: true }));
});

// ── GET /api/events/share-link/:token/preview ─────────────────────────────────

router.get("/events/share-link/:token/preview", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;

  const { token } = req.params;
  if (!token || token.length < 8) { sendError(res, "invalid_payload", "Invalid share token"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: link } = await sc.from("event_share_links").select("*").eq("token", token).maybeSingle();
  if (!link) { sendError(res, "not_found", "Share link not found or expired"); return; }

  if ((link as any).expires_at && new Date((link as any).expires_at) < new Date()) {
    sendError(res, "not_found", "Share link has expired"); return;
  }
  if ((link as any).max_uses != null && (link as any).use_count >= (link as any).max_uses) {
    sendError(res, "not_found", "Share link usage limit reached"); return;
  }

  const { data: ev } = await sc.from("events").select("*").eq("id", (link as any).event_id).maybeSingle();
  if (!ev || ["cancelled","archived"].includes((ev as any).state)) {
    sendError(res, "not_found", "Event not found"); return;
  }

  // Increment use count (non-fatal)
  await sc.from("event_share_links")
    .update({ use_count: ((link as any).use_count ?? 0) + 1 })
    .eq("id", (link as any).id)
    .then(undefined, () => {});

  // Share-link preview: check if the viewer is a participant (going/maybe RSVP or host)
  const previewUser = (ctx as any).user;
  const { data: previewRsvp } = await sc.from("event_rsvps").select("status")
    .eq("event_id", (ev as any).id).eq("user_id", previewUser.id).maybeSingle();
  const previewIsParticipant =
    (ev as any).host_id === previewUser.id ||
    (["going","maybe"].includes((previewRsvp as any)?.status ?? ""));
  res.json({ event: formatEvent(ev as any, previewUser.id, { goingRsvp: previewIsParticipant }), shareToken: token });
});

// ── GET /api/events/near-trip/:tripId ────────────────────────────────────────
// Returns public events in the trip's destination city, optionally filtered by
// the trip's date range.  Useful for "Events near this destination" on Trip detail.

router.get("/events/near-trip/:tripId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { tripId } = req.params;
  if (!isUuid(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Caller must be an accepted trip member
  const { data: mem } = await sc.from("trip_members").select("role")
    .eq("trip_id", tripId).eq("user_id", user.id).maybeSingle();
  if (!mem || !["owner", "member"].includes((mem as any).role)) {
    sendError(res, "forbidden", "Must be a trip member to see nearby events"); return;
  }

  const { data: trip } = await sc.from("trips")
    .select("destination_city, start_date, end_date")
    .eq("id", tripId).maybeSingle();
  if (!trip || !(trip as any).destination_city) {
    res.json({ events: [] }); return;
  }

  const city      = (trip as any).destination_city as string;
  const startDate = (trip as any).start_date as string | null;
  const endDate   = (trip as any).end_date as string | null;
  const limit     = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));

  let query = sc.from("events").select("*")
    .not("state", "in", '("draft","cancelled","archived")')
    .in("visibility", ["public", "friends_only"])
    .ilike("city", `%${city}%`)
    .order("starts_at", { ascending: true, nullsFirst: false })
    .limit(limit);

  if (startDate) query = query.gte("starts_at", startDate);
  if (endDate)   query = query.lte("starts_at", endDate + "T23:59:59Z");

  const { data: events, error } = await query;
  if (error) { req.log.error({ err: error }, "near-trip events"); sendError(res, "db_error", error.message); return; }

  const filtered: any[] = [];
  for (const ev of (events as any[]) ?? []) {
    if (await isBlocked(sc, user.id, (ev as any).host_id)) continue;
    // Enforce friends_only: viewer must be friends with the host
    if ((ev as any).visibility === "friends_only" && (ev as any).host_id !== user.id) {
      const { data: friendship } = await sc
        .from("user_friendships")
        .select("user_a")
        .or(`and(user_a.eq.${user.id},user_b.eq.${(ev as any).host_id}),and(user_b.eq.${user.id},user_a.eq.${(ev as any).host_id})`)
        .maybeSingle();
      if (!friendship) continue;
    }
    // Same eligibility gate the sibling browse routes apply (ban / trust /
    // age / verified-only). GET /api/events/:id enforces it, so without this a
    // banned or gate-failing trip member sees a card here that 404s the moment
    // they tap it — the list and the detail view disagreed about who may see
    // the event.
    const elig = await checkEventEligibility(sc, ev as any, user.id);
    if (!elig.ok) continue;
    filtered.push(ev);
  }

  res.json({ events: filtered.map((e) => formatEvent(e, user.id)), tripId, city });
});

// ── GET /api/events/:id ───────────────────────────────────────────────────────

// ── GET /api/events/following ─────────────────────────────────────────────────
// Upcoming events hosted by users the viewer follows. Declared BEFORE
// `/events/:id` so it isn't shadowed by the param route (audit API-03: the client
// calls /api/events/following, which previously fell through to /events/:id and
// failed the UUID check). Same access gates as the detail/browse endpoints.
router.get("/events/following", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const limit  = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const cursor = (req.query.cursor as string) ?? null;

  const { data: followRows } = await sc
    .from("user_follows").select("following_id").eq("follower_id", user.id);
  const hostIds = [...new Set(((followRows as any[]) ?? []).map((r: any) => r.following_id as string))];
  if (hostIds.length === 0) { res.json({ events: [], cursor: null }); return; }

  let query = sc
    .from("events")
    .select("*")
    .in("host_id", hostIds)
    .not("state", "in", '("cancelled","archived","draft")')
    .order("starts_at", { ascending: true, nullsFirst: false })
    .limit(limit * 3);
  if (cursor) query = query.gt("starts_at", cursor);

  const { data: events, error } = await query;
  if (error) { req.log.error({ err: error }, "following events"); sendError(res, "db_error", error.message); return; }

  const filtered: any[] = [];
  for (const ev of (events as any[]) ?? []) {
    if (filtered.length >= limit) break;
    if (!await canViewEvent(sc, ev as any, user.id)) continue;
    if (await isBlocked(sc, user.id, (ev as any).host_id)) continue;
    const elig = await checkEventEligibility(sc, ev as any, user.id);
    if (!elig.ok) continue;
    filtered.push(ev);
  }

  const hostIdSet = [...new Set(filtered.map((e: any) => e.host_id as string))];
  const hpMap: Record<string, { name?: string | null; handle?: string | null; avatar_url?: string | null }> = {};
  if (hostIdSet.length > 0) {
    const { data: hps } = await sc.from("profiles").select("id, name, handle, avatar_url").in("id", hostIdSet);
    const allowedNames = await nameVisibilitySet(sc, hostIdSet);
    for (const p of (hps as any[]) ?? []) hpMap[p.id as string] = sanitizeIdentity(p, allowedNames, user.id);
  }

  const filteredIds = filtered.map((e: any) => e.id as string);
  const rsvpMap: Record<string, string> = {};
  if (filteredIds.length > 0) {
    const { data: rsvps } = await sc
      .from("event_rsvps").select("event_id, status").eq("user_id", user.id).in("event_id", filteredIds);
    for (const r of (rsvps as any[]) ?? []) rsvpMap[(r as any).event_id as string] = (r as any).status as string;
  }

  const nextCursor = filtered.length === limit ? (filtered[filtered.length - 1].starts_at ?? null) : null;

  res.json({
    events: filtered.map((e: any) => ({
      ...formatEvent(e, user.id, { hostProfile: hpMap[e.host_id as string] }),
      myRsvp: rsvpMap[e.id as string] ?? null,
    })),
    cursor: nextCursor,
  });
});

router.get("/events/:id", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc.from("events").select("*").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  // Block check FIRST — blocking overrides all other relationships.
  // A blocked user must never access even the minimal preview.
  if (await isBlocked(sc, user.id, (ev as any).host_id)) {
    sendError(res, "not_found", "Event not found or access denied"); return;
  }

  // Visibility check — non-discoverable events (invite_only, friends_only,
  // circle, trip) are not visible to unauthorized viewers.
  // Rather than returning 404 (which leaks no info but breaks deep links),
  // return a LockedEventPreview sentinel so the mobile client can render a
  // private-wall screen instead of a generic "not found" error.
  // Public events that the viewer still cannot access (e.g. eligibility gate)
  // remain a 404 to avoid probing event existence.
  if (!await canViewEvent(sc, ev as any, user.id)) {
    const evVis = (ev as any).visibility as string | null ?? "public";
    if (evVis !== "public") {
      // Non-public event: return locked sentinel — no title/venue/dates exposed.
      res.status(200).json({ locked: true, eventId: id });
    } else {
      sendError(res, "not_found", "Event not found or access denied");
    }
    return;
  }

  // Viewer eligibility gates (age / trust / verified) — same rules as RSVP.
  const readElig = await checkEventEligibility(sc, ev as any, user.id);
  if (!readElig.ok) {
    sendError(res, "not_found", "Event not found or access denied"); return;
  }

  const [rsvpResult, waitlistResult, roleResult, attendeeResult, goingResult, hostResult, joinReqResult] = await Promise.all([
    sc.from("event_rsvps").select("status").eq("event_id", id).eq("user_id", user.id).maybeSingle(),
    sc.from("event_waitlist").select("position, offer_expires_at").eq("event_id", id).eq("user_id", user.id).maybeSingle(),
    sc.from("event_roles").select("role").eq("event_id", id).eq("user_id", user.id).maybeSingle(),
    sc.from("event_attendee_states").select("*").eq("event_id", id).eq("user_id", user.id).maybeSingle(),
    sc.from("event_rsvps").select("user_id, status").eq("event_id", id).in("status", ["going", "maybe"]),
    sc.from("profiles").select("id, handle, name, avatar_url").eq("id", (ev as any).host_id).maybeSingle(),
    sc.from("event_join_requests").select("status").eq("event_id", id).eq("user_id", user.id).maybeSingle(),
  ]);

  const goingData = (goingResult as any).data ?? [];
  const counts = {
    going:      goingData.filter((r: any) => r.status === "going").length,
    maybe:      goingData.filter((r: any) => r.status === "maybe").length,
    interested: 0,
    cant_go:    0,
  };

  // Full RSVP counts
  const { data: allRsvps } = await sc.from("event_rsvps").select("status").eq("event_id", id);
  for (const r of (allRsvps as any[]) ?? []) {
    if (r.status === "interested") counts.interested++;
    if (r.status === "cant_go") counts.cant_go++;
  }

  const goingAvatars = goingData
    .filter((r: any) => r.status === "going")
    .slice(0, 4)
    .map((r: any) => r.user_id as string);

  // goingAttendees is participant-scoped: only expose to host/cohost or going/maybe attendees.
  const viewerRole = (ev as any).host_id === user.id ? "host" : ((roleResult as any).data?.role ?? null);
  const viewerRsvpStatus: string | null = (rsvpResult as any).data?.status ?? null;
  const isParticipant = viewerRole === "host" || viewerRole === "co_host" ||
    viewerRsvpStatus === "going" || viewerRsvpStatus === "maybe";

  let goingProfiles: any[] = [];
  if (isParticipant && goingAvatars.length > 0) {
    const { data: gp } = await sc.from("profiles").select("id, handle, name, avatar_url").in("id", goingAvatars);
    const allowedGoing = await nameVisibilitySet(sc, goingAvatars);
    goingProfiles = ((gp as any[]) ?? []).map((p) => sanitizeIdentity(p, allowedGoing, user.id));
  }

  const { data: waitlistData } = await sc
    .from("event_waitlist")
    .select("user_id")
    .eq("event_id", id);
  const waitlistCount = ((waitlistData as any[]) ?? []).length;

  const hpRaw = (hostResult as any).data;
  const hostAllowed = await nameVisibilitySet(sc, [(ev as any).host_id]);
  const hp = sanitizeIdentity(hpRaw, hostAllowed, user.id);
  const host = hp ? {
    id: hp.id,
    handle: hp.handle ?? null,
    displayName: hp.name ?? null,
    avatarUrl: hp.avatar_url ?? null,
  } : null;

  const myRole = (ev as any).host_id === user.id ? "host" : ((roleResult as any).data?.role ?? null);

  // Use the explicit AuthorizedEventView serializer — field gates for coords,
  // priceUrl, and safetyNotes are applied server-side, not client-side.
  res.json({
    ...toAuthorizedEventView(ev as any, user.id, { goingRsvp: isParticipant }),
    host,
    counts,
    waitlistCount,
    myRsvp: (rsvpResult as any).data?.status ?? null,
    myJoinRequestStatus: (joinReqResult as any).data?.status ?? null,
    myWaitlistPosition: (waitlistResult as any).data?.position ?? null,
    myWaitlistOfferExpiresAt: (waitlistResult as any).data?.offer_expires_at ?? null,
    myRole,
    myAttendanceState: (attendeeResult as any).data ?? null,
    // goingAttendees: participant-scoped (empty for non-participants, already
    // controlled by the isParticipant gate above).
    goingAttendees: goingProfiles.map((p: any) => ({
      id: p.id, handle: p.handle ?? null, displayName: p.name ?? null, avatarUrl: p.avatar_url ?? null,
    })),
  });
});

// ── PATCH /api/events/:id ─────────────────────────────────────────────────────

router.patch("/events/:id", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const role = await getEventRole(sc, id, user.id);
  if (role !== "host" && role !== "co_host") { sendError(res, "forbidden", "Only host or co-host can edit this event"); return; }

  const parsed = UpdateEventSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  // SEC-04: event lifecycle `state` and `visibility` are HOST-ONLY. Co-hosts may
  // edit details but must not cancel/archive/reopen or change who can see the
  // event — otherwise PATCH bypasses the host-only cancel/postpone/archive/publish
  // routes.
  if ((b.state !== undefined || b.visibility !== undefined) && role !== "host") {
    sendError(res, "forbidden", "Only the host can change event state or visibility");
    return;
  }

  // Fetch current event to detect key-detail changes for notifications
  const { data: current } = await sc.from("events").select("*").eq("id", id).maybeSingle();
  if (!current) { sendError(res, "not_found", "Event not found"); return; }

  const KEY_FIELDS = ["starts_at", "ends_at", "location_name", "age_min", "trust_score_min", "verified_only"] as const;
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };

  if (b.title           !== undefined) patch.title            = b.title;
  if (b.description     !== undefined) patch.description      = b.description;
  if (b.locationName    !== undefined) patch.location_name    = b.locationName;
  if (b.locationLat     !== undefined) patch.location_lat     = b.locationLat;
  if (b.locationLng     !== undefined) patch.location_lng     = b.locationLng;
  if (b.startsAt        !== undefined) patch.starts_at        = b.startsAt;
  if (b.endsAt          !== undefined) patch.ends_at          = b.endsAt;
  if (b.coverUrl        !== undefined) patch.cover_url         = b.coverUrl;
  if (b.coverMediaType  !== undefined) patch.cover_media_type  = b.coverMediaType;
  if (b.coverImageWidth  !== undefined) patch.cover_image_width  = b.coverImageWidth;
  if (b.coverImageHeight !== undefined) patch.cover_image_height = b.coverImageHeight;
  if (b.maxAttendees    !== undefined) patch.max_attendees    = b.maxAttendees;
  if (b.ageMin          !== undefined) patch.age_min          = b.ageMin;
  if (b.ageMax          !== undefined) patch.age_max          = b.ageMax;
  if (b.trustScoreMin   !== undefined) patch.trust_score_min  = b.trustScoreMin;
  if (b.verifiedOnly    !== undefined) patch.verified_only    = b.verifiedOnly;
  if (b.visibility      !== undefined) patch.visibility       = b.visibility;
  if (b.circleId        !== undefined) patch.circle_id        = b.circleId;
  if (b.tripId          !== undefined) patch.trip_id          = b.tripId;
  if (b.state           !== undefined) patch.state            = b.state;
  if (b.chatEnabled     !== undefined) patch.chat_enabled     = b.chatEnabled;
  if (b.waitlistEnabled !== undefined) patch.waitlist_enabled = b.waitlistEnabled;
  if (b.attendeeCommentsEnabled !== undefined) patch.attendee_comments_enabled = b.attendeeCommentsEnabled;
  if (b.priceType       !== undefined) patch.price_type       = b.priceType;
  if (b.priceUrl        !== undefined) patch.price_url        = b.priceUrl;
  if (b.category        !== undefined) patch.category         = b.category;
  if (b.city               !== undefined) patch.city                = b.city;
  if (b.country            !== undefined) patch.country             = b.country;
  if (b.showHeaderPublicly !== undefined) patch.show_header_publicly = b.showHeaderPublicly;

  const { data: updated, error } = await sc
    .from("events").update(patch).eq("id", id).select("*").single();

  if (error) { req.log.error({ err: error }, "update event"); sendError(res, "db_error", error.message); return; }

  // Notify attendees if key details changed (fire-and-forget)
  const changed = KEY_FIELDS.some((f) => {
    const snakeToCamel = f.replace(/_([a-z])/g, (_, c) => c.toUpperCase()) as string;
    return (b as any)[snakeToCamel] !== undefined;
  });
  const isPublished = !["draft", "cancelled", "archived"].includes((current as any).state);

  if (changed && isPublished) {
    void (async () => {
      try {
        const recipients = await getAttendeeRecipients(sc, id);
        if (recipients.length > 0) {
          await sendPushWithRetry(sc, recipients, {
            title: "Event updated",
            body: `"${(updated as any).title}" has been updated — check the details.`,
            data: { eventId: id, type: "event_updated" },
          });
        }
      } catch {}
    })();
  }

  // If event just opened and chat is enabled, create chat thread
  if (b.state === "open" && !(current as any).chat_thread_id && (updated as any).chat_enabled) {
    await createEventChatThread(sc, id, (updated as any).title, user.id);
  }

  // Post-attendance review notification — fire-and-forget
  if (b.state === "completed" && (current as any).state !== "completed") {
    void (async () => {
      try {
        const { data: confirmed } = await sc
          .from("event_attendee_states")
          .select("user_id, profiles!user_id(expo_push_token)")
          .eq("event_id", id)
          .not("confirmed_at", "is", null);

        if (confirmed && (confirmed as any[]).length > 0) {
          const recipients = (confirmed as any[])
            .map((r: any) => ({ userId: r.user_id as string, tokens: [r.profiles?.expo_push_token] }))
            .filter((r: any) => r.tokens[0]);

          const eventTitle = (updated as any).title ?? "your event";

          if (recipients.length > 0) {
            await sendPushWithRetry(sc, recipients, {
              title: "How was the event?",
              body: `Leave a review for "${eventTitle}" — your feedback helps the community.`,
              data: {
                type:       "review_prompt",
                entityType: "event",
                entityId:   id,
                entityName: eventTitle,
              },
            });
          }

          // Insert in-app notifications (fire and forget each)
          await Promise.allSettled(
            (confirmed as any[]).map((r: any) =>
              sc.from("notifications").insert({
                user_id:    r.user_id,
                actor_id:   user.id,
                event_type: "event.review_prompt",
                category:   "plans",
                title:      "How was the event?",
                body:       `Leave a review for "${eventTitle}" — your feedback helps the community.`,
                metadata: {
                  entityType: "event",
                  entityId:   id,
                  entityName: eventTitle,
                },
              }),
            ),
          );
        }
      } catch {}
    })();
  }

  // Translation: invalidate + re-detect when title/description change.
  if (b.title !== undefined || b.description !== undefined) {
    const scTx = getServiceClient();
    if (scTx) {
      invalidateContentTranslations(scTx, 'event', id).catch(() => {});
      const textForDetect = [b.title ?? (current as any).title, b.description ?? (current as any).description]
        .filter(Boolean).join(' ');
      if (textForDetect.trim()) {
        detectAndStoreLanguage(scTx, 'event', id, textForDetect, req.log).catch(() => {});
      }
    }
  }

  // Caller is host/cohost (only they can PATCH) → participant view
  res.json(formatEvent(updated as any, user.id, { goingRsvp: true }));
});

// ── DELETE /api/events/:id ────────────────────────────────────────────────────

router.delete("/events/:id", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const role = await getEventRole(sc, id, user.id);
  if (role !== "host") { sendError(res, "forbidden", "Only the host can cancel an event"); return; }

  const { data: ev } = await sc.from("events").select("title, state").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  // supabase-js resolves rather than throws — unchecked, a failed cancel
  // returned {ok:true} while the event stayed open.
  const { error: cancelErr } = await sc.from("events").update({ state: "cancelled", updated_at: new Date().toISOString() }).eq("id", id);
  if (cancelErr) { sendError(res, "db_error", cancelErr.message); return; }

  // Notify all Going/Maybe attendees (fire-and-forget)
  void (async () => {
    try {
      const recipients = await getAttendeeRecipients(sc, id);
      if (recipients.length > 0) {
        await sendPushWithRetry(sc, recipients, {
          title: "Event cancelled",
          body: `"${(ev as any).title}" has been cancelled by the host.`,
          data: { eventId: id, type: "event_cancelled" },
        });
      }
    } catch (err) {
      // resolves-not-throws-ok: fire-and-forget push — best-effort, logged.
      req.log?.warn({ err, eventId: id }, "event-cancelled push notify failed");
    }
  })();

  res.json({ ok: true });
});

// ── POST /api/events/:id/rsvp ─────────────────────────────────────────────────

router.post("/events/:id/rsvp", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const parsed = RsvpSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  const { data: ev } = await sc.from("events").select("*").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  if (!["open", "full", "waitlist"].includes((ev as any).state)) {
    sendError(res, "forbidden", "Event is not accepting RSVPs"); return;
  }

  if ((ev as any).rsvp_closed) {
    sendError(res, "forbidden", "RSVPs are closed for this event"); return;
  }

  // Central eligibility check (block / ban / trust / age / verified)
  const elig = await checkEventEligibility(sc, ev as any, user.id);
  if (!elig.ok) { sendError(res, elig.errorCode as any, elig.message); return; }

  // Invite-only: require approved join request
  if ((ev as any).visibility === "invite_only") {
    const { data: req_ } = await sc
      .from("event_join_requests")
      .select("status")
      .eq("event_id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!(req_ as any) || (req_ as any).status !== "approved") {
      sendError(res, "forbidden", "This event requires host approval to join"); return;
    }
  }
  // Circle/trip visibility: must be a member to RSVP
  if ((ev as any).visibility === "circle") {
    if (!(ev as any).circle_id || !await isCircleMember(sc, (ev as any).circle_id, user.id)) {
      sendError(res, "forbidden", "This event is only open to circle members"); return;
    }
  }
  if ((ev as any).visibility === "trip") {
    if (!(ev as any).trip_id || !await isTripEventMember(sc, (ev as any).trip_id, user.id)) {
      sendError(res, "forbidden", "This event is only open to trip members"); return;
    }
  }

  const status = parsed.data.status;

  // If status is 'going' and event is full/waitlist, redirect to waitlist
  if (status === "going" && ["full", "waitlist"].includes((ev as any).state)) {
    // Waitlist disabled → hard reject
    if (!(ev as any).waitlist_enabled) {
      sendError(res, "forbidden", "This event is full and waitlist is not available"); return;
    }
    // Auto-add to waitlist
    const { data: existing } = await sc
      .from("event_waitlist")
      .select("position")
      .eq("event_id", id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (!existing) {
      const { data: maxPos } = await sc
        .from("event_waitlist")
        .select("position")
        .eq("event_id", id)
        .order("position", { ascending: false })
        .limit(1)
        .maybeSingle();
      const nextPos = ((maxPos as any)?.position ?? 0) + 1;
      await sc.from("event_waitlist").insert({ event_id: id, user_id: user.id, position: nextPos });
      await sc.from("events").update({ waitlist_count: nextPos, updated_at: new Date().toISOString() }).eq("id", id);
    }

    res.status(202).json({ status: "waitlisted", message: "Event is full — you have been added to the waitlist" }); return;
  }

  const { error } = await sc.from("event_rsvps").upsert(
    { event_id: id, user_id: user.id, status, updated_at: new Date().toISOString() },
    { onConflict: "event_id,user_id" },
  );

  if (error) { req.log.error({ err: error }, "rsvp event"); sendError(res, "db_error", error.message); return; }

  // Update going_count + sync state + attendees table
  await syncEventState(sc, id);
  const going = await getGoingCount(sc, id);
  await sc.from("events").update({ going_count: going }).eq("id", id);
  await syncAttendee(sc, id, user.id, status);

  // Add to event chat thread if going and chat enabled. Lazily create the
  // thread here if it doesn't exist yet — most events never have their chat
  // thread created by the host explicitly, so gating this on an existing
  // chat_thread_id left every attendee's "Event Chat" button permanently
  // dead for those events (silent 404 downstream in /chat/join).
  if (status === "going" && (ev as any).chat_enabled) {
    let threadId: string | null = (ev as any).chat_thread_id ?? null;
    if (!threadId) {
      threadId = await createEventChatThread(sc, id, (ev as any).title, user.id);
    }
    if (threadId) await addUserToChatThread(sc, threadId, user.id);
  }

  // Fire-and-forget: award first_event_joined stamp on a user's very first Going RSVP
  if (status === "going") {
    void (async () => {
      try {
        const { data: prior } = await sc
          .from("event_rsvps")
          .select("event_id")
          .eq("user_id", user.id)
          .eq("status", "going")
          .neq("event_id", id)
          .limit(1)
          .maybeSingle();
        if (!prior) {
          await recordTrustEvent(sc, {
            userId: user.id,
            eventType: "first_event_joined",
            category: "plan_attendance",
            delta: 10,
            severity: "minor",
            sourceType: "event",
            sourceId: user.id,
            dedupWindowHours: 99999,
            metadata: { event_id: id },
          }).catch(() => {});
        }
      } catch {}
    })();
  }

  // Phase 14 — link RSVP back to the originating Compass recommendation.
  if (status === "going") {
    void linkOutcomeSignal(sc, user.id, id, "went", "route:event_rsvp");
  }

  // Stamp Wave 2 (closes Task #1041 for RSVPs): first_event_joined on a
  // "going" RSVP. Fire-and-forget; awardStamp is fully idempotent via
  // (user:def:events:eventId) so repeat RSVPs never double-award.
  //
  // Wave 3 follow-up: also run the criteria engine for the event-category
  // stamps (foodie/music/outdoor/regular), passing this event's derived
  // category context. evaluateAndAwardCriteria is a no-op unless
  // stamp_criteria_engine_enabled is on AND those definitions are active, so
  // this stays inert until you deliberately turn the engine on.
  if (status === "going") {
    void (async () => {
      try {
        const { awardStamp } = await import("../services/passport/StampAwardEngine.js");
        const { NotificationService } = await import("../services/notifications/NotificationService.js");
        const { NotificationRouter } = await import("../services/notifications/NotificationRouter.js");
        const notifSvc = new NotificationService(sc);
        const notifRouter = new NotificationRouter(sc);

        const notifyEarned = async (userStampId: string, location: string) => {
          const row = await notifSvc.create({
            userId: user.id,
            eventType: "passport.stamp_earned",
            sourceType: "events",
            sourceId: id,
            params: { location, stampId: userStampId },
          });
          if (row) await notifRouter.route(row);
        };

        const r = await awardStamp(sc, {
          userId: user.id,
          definitionSlug: "first_event_joined",
          sourceType: "events",
          sourceId: id,
        });
        if (r.awarded && r.userStampId) await notifyEarned(r.userStampId, "joining your first event");

        // Event-category criteria stamps (data-driven; engine-flag + active gated).
        const { evaluateAndAwardCriteria } = await import("../lib/stamps/criteria/index.js");
        const { eventCategoryContext, EVENT_CATEGORY_STAMP_SLUGS } =
          await import("../lib/stamps/criteria/eventContext.js");
        const catCtx = eventCategoryContext(ev as any) as unknown as Record<string, boolean>;
        const outcomes = await evaluateAndAwardCriteria(sc, user.id, {
          ctx: { context: catCtx },
          sourceType: "events",
          sourceId: id,
          onlySlugs: [...EVENT_CATEGORY_STAMP_SLUGS],
        });
        for (const o of outcomes) {
          if (o.awarded && o.userStampId) {
            const label =
              o.slug === "event_regular" ? "being an event regular" :
              o.slug === "foodie_explorer" ? "exploring food events" :
              o.slug === "music_lover" ? "loving live music" :
              o.slug === "outdoor_adventurer" ? "your outdoor adventures" : "joining an event";
            await notifyEarned(o.userStampId, label);
          }
        }
      } catch {}
    })();
  }

  res.json({ status, eventId: id });
});

// ── DELETE /api/events/:id/rsvp ───────────────────────────────────────────────

router.delete("/events/:id/rsvp", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: existing } = await sc
    .from("event_rsvps")
    .select("status")
    .eq("event_id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!existing) { sendError(res, "not_found", "No RSVP found"); return; }

  await sc.from("event_rsvps").delete().eq("event_id", id).eq("user_id", user.id);

  const going = await getGoingCount(sc, id);
  await sc.from("events").update({ going_count: going }).eq("id", id);
  await syncAttendee(sc, id, user.id, null);

  // Promote the next waitlisted user BEFORE syncing state: promotion sets an
  // active offer_expires_at, which reserves the freed seat. If we synced state
  // first, hasActiveWaitlistOffer would still be false (no offer yet) and the
  // event would flip to 'open' — letting a walk-in RSVP steal the promoted
  // user's seat before they can accept. Sync AFTER, so the reservation holds.
  if ((existing as any).status === "going") {
    const waitlistEnabled = await isFlagEnabled(sc, "events_waitlist_enabled");
    if (waitlistEnabled) {
      await promoteNextWaitlisted(sc, id);
    }
  }
  await syncEventState(sc, id);

  res.json({ ok: true });
});

// ── POST /api/events/:id/join ─────────────────────────────────────────────────
// Convenience shortcut: RSVP going with full gate checks (capacity, age/trust,
// visibility, block status, RSVP-closed, duplicate prevention).

router.post("/events/:id/join", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc.from("events").select("*").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  // Check event state
  const evData = ev as any;
  if (["draft","cancelled","archived"].includes(evData.state)) {
    sendError(res, "not_found", "Event not available"); return;
  }
  if (evData.rsvp_closed) { sendError(res, "forbidden", "RSVPs are closed for this event"); return; }
  if (evData.visibility === "invite_only") {
    sendError(res, "forbidden", "This event requires an invitation to join"); return;
  }
  if (evData.visibility === "circle") {
    if (!evData.circle_id || !await isCircleMember(sc, evData.circle_id, user.id)) {
      sendError(res, "forbidden", "This event is only open to circle members"); return;
    }
  }
  if (evData.visibility === "trip") {
    if (!evData.trip_id || !await isTripEventMember(sc, evData.trip_id, user.id)) {
      sendError(res, "forbidden", "This event is only open to trip members"); return;
    }
  }

  const result = await checkEventEligibility(sc, evData, user.id);
  if (!result.ok) { sendError(res, result.errorCode as any, result.message ?? "Cannot join"); return; }

  // Capacity enforcement: if full/waitlist, redirect to waitlist (same logic as RSVP POST)
  if (["full", "waitlist"].includes(evData.state)) {
    if (!evData.waitlist_enabled) {
      sendError(res, "forbidden", "This event is full and the waitlist is not available"); return;
    }
    const { data: existingWl } = await sc
      .from("event_waitlist").select("position").eq("event_id", id).eq("user_id", user.id).maybeSingle();
    if (!existingWl) {
      const { data: maxPos } = await sc
        .from("event_waitlist").select("position").eq("event_id", id)
        .order("position", { ascending: false }).limit(1).maybeSingle();
      const nextPos = ((maxPos as any)?.position ?? 0) + 1;
      await sc.from("event_waitlist").insert({ event_id: id, user_id: user.id, position: nextPos });
      await sc.from("events").update({ waitlist_count: nextPos, updated_at: new Date().toISOString() }).eq("id", id);
    }
    res.status(202).json({ status: "waitlisted", message: "Event is full — you have been added to the waitlist" }); return;
  }

  // Check that adding this user won't exceed capacity (race-condition guard)
  if (evData.max_attendees != null) {
    const currentGoing = await getGoingCount(sc, id);
    if (currentGoing >= evData.max_attendees) {
      if (!evData.waitlist_enabled) {
        sendError(res, "forbidden", "This event is full and the waitlist is not available"); return;
      }
      const { data: existingWl2 } = await sc
        .from("event_waitlist").select("position").eq("event_id", id).eq("user_id", user.id).maybeSingle();
      if (!existingWl2) {
        const { data: maxPos2 } = await sc
          .from("event_waitlist").select("position").eq("event_id", id)
          .order("position", { ascending: false }).limit(1).maybeSingle();
        const nextPos2 = ((maxPos2 as any)?.position ?? 0) + 1;
        await sc.from("event_waitlist").insert({ event_id: id, user_id: user.id, position: nextPos2 });
        const wlCount = await sc.from("event_waitlist").select("user_id").eq("event_id", id);
        await sc.from("events").update({ waitlist_count: ((wlCount as any).data ?? []).length, updated_at: new Date().toISOString() }).eq("id", id);
      }
      res.status(202).json({ status: "waitlisted", message: "Event is full — you have been added to the waitlist" }); return;
    }
  }

  await sc.from("event_rsvps").upsert(
    { event_id: id, user_id: user.id, status: "going", updated_at: new Date().toISOString() },
    { onConflict: "event_id,user_id" },
  );

  const going = await getGoingCount(sc, id);
  await sc.from("events").update({ going_count: going }).eq("id", id);
  await syncEventState(sc, id);
  await sc.from("event_attendees")
    .upsert({ event_id: id, user_id: user.id }, { onConflict: "event_id,user_id" })
    .then(undefined, () => {});
  await logEventActivity(sc, id, user.id, "joined", {});

  // Phase 14 — link join back to the originating Compass recommendation.
  void linkOutcomeSignal(sc, user.id, id, "went", "route:event_join");

  res.json({ ok: true });
});

// ── POST /api/events/:id/leave ────────────────────────────────────────────────
// Convenience shortcut: cancel going RSVP and remove from attendees list.

router.post("/events/:id/leave", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: existing } = await sc
    .from("event_rsvps")
    .select("status")
    .eq("event_id", id).eq("user_id", user.id)
    .maybeSingle();

  if (!existing) { sendError(res, "not_found", "No active RSVP found"); return; }

  await sc.from("event_rsvps").delete().eq("event_id", id).eq("user_id", user.id);
  await sc.from("event_attendees").delete().eq("event_id", id).eq("user_id", user.id);

  const going = await getGoingCount(sc, id);
  await sc.from("events").update({ going_count: going }).eq("id", id);

  // Promote BEFORE syncing state so the freed seat is reserved by an active
  // offer (see DELETE /rsvp) — otherwise syncEventState reopens to a walk-in.
  if ((existing as any).status === "going") {
    const waitlistEnabled = await isFlagEnabled(sc, "events_waitlist_enabled");
    if (waitlistEnabled) await promoteNextWaitlisted(sc, id);
  }
  await syncEventState(sc, id);

  await logEventActivity(sc, id, user.id, "left", {});

  res.json({ ok: true });
});

// ── POST /api/events/:id/waitlist ─────────────────────────────────────────────

/**
 * Private-event join gate, mirroring POST /rsvp: a private event may only be
 * joined by an invited/member user. The waitlist join AND accept paths skipped
 * this entirely, so an uninvited user who knew a private event's id could be
 * waitlisted and then seated as a going attendee (and added to its group chat)
 * of an invite_only / circle / trip event (audit EVENTS WL-1). The event row
 * must carry visibility, circle_id and trip_id.
 */
async function checkEventJoinVisibility(
  sc: any, ev: any, eventId: string, userId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if ((ev as any).visibility === "invite_only") {
    const { data: req_ } = await sc
      .from("event_join_requests")
      .select("status").eq("event_id", eventId).eq("user_id", userId).maybeSingle();
    if (!(req_ as any) || (req_ as any).status !== "approved") {
      return { ok: false, message: "This event requires host approval to join" };
    }
  }
  if ((ev as any).visibility === "circle") {
    if (!(ev as any).circle_id || !await isCircleMember(sc, (ev as any).circle_id, userId)) {
      return { ok: false, message: "This event is only open to circle members" };
    }
  }
  if ((ev as any).visibility === "trip") {
    if (!(ev as any).trip_id || !await isTripEventMember(sc, (ev as any).trip_id, userId)) {
      return { ok: false, message: "This event is only open to trip members" };
    }
  }
  return { ok: true };
}

router.post("/events/:id/waitlist", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }
  const nowMsWl = Date.now();

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc
    .from("events")
    .select("state, waitlist_enabled, host_id, visibility, circle_id, trip_id, age_min, age_max, trust_score_min, verified_only")
    .eq("id", id)
    .maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  // Private-event join gate (same as /rsvp) — closes the waitlist bypass.
  const wlVis = await checkEventJoinVisibility(sc, ev, id, user.id);
  if (!wlVis.ok) { sendError(res, "forbidden", wlVis.message); return; }

  if (!["full", "waitlist"].includes((ev as any).state)) {
    sendError(res, "forbidden", "Waitlist is not available for this event"); return;
  }
  if (!(ev as any).waitlist_enabled) {
    sendError(res, "forbidden", "Waitlist is disabled for this event"); return;
  }

  // Block / ban gate
  if (await isBlocked(sc, user.id, (ev as any).host_id)) {
    sendError(res, "forbidden", "Cannot join waitlist for this event"); return;
  }
  const { data: bannedRoleWl } = await sc
    .from("event_roles")
    .select("role")
    .eq("event_id", id)
    .eq("user_id", user.id)
    .eq("role", "banned")
    .maybeSingle();
  if (bannedRoleWl) { sendError(res, "forbidden", "You are banned from this event"); return; }

  // Trust / age / verified gates (same rules as RSVP)
  const trustGatesEnabledWl = await isFlagEnabled(sc, "events_trust_gates_enabled");
  if (trustGatesEnabledWl) {
    if ((ev as any).verified_only) {
      const { data: profileWl } = await sc.from("profiles").select("verified").eq("id", user.id).maybeSingle();
      if (!(profileWl as any)?.verified) {
        sendError(res, "forbidden", "This event is for verified users only"); return;
      }
    }
    if ((ev as any).trust_score_min != null) {
      const { data: tpWl } = await sc.from("trust_profiles").select("overall_score").eq("user_id", user.id).maybeSingle();
      const scoreWl = (tpWl as any)?.overall_score ?? 50;
      if (scoreWl < (ev as any).trust_score_min) {
        sendError(res, "forbidden", `This event requires a trust score of at least ${(ev as any).trust_score_min}`); return;
      }
    }
    if ((ev as any).age_min != null || (ev as any).age_max != null) {
      const { data: profileAgeWl } = await sc.from("profiles").select("date_of_birth").eq("id", user.id).maybeSingle();
      if (!(profileAgeWl as any)?.date_of_birth) {
        sendError(res, "forbidden", "Your profile must have a date of birth to join this age-restricted event"); return;
      }
      const dobWl = new Date((profileAgeWl as any).date_of_birth);
      const ageYearsWl = Math.floor((nowMsWl - dobWl.getTime()) / (1000 * 60 * 60 * 24 * 365.25));
      if ((ev as any).age_min != null && ageYearsWl < (ev as any).age_min) {
        sendError(res, "forbidden", `This event requires attendees to be at least ${(ev as any).age_min}`); return;
      }
      if ((ev as any).age_max != null && ageYearsWl > (ev as any).age_max) {
        sendError(res, "forbidden", `This event is for attendees up to age ${(ev as any).age_max}`); return;
      }
    }
  }

  const { data: existing } = await sc
    .from("event_waitlist")
    .select("position")
    .eq("event_id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (existing) { res.json({ position: (existing as any).position, message: "Already on waitlist" }); return; }

  const { data: maxPos } = await sc
    .from("event_waitlist")
    .select("position")
    .eq("event_id", id)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextPos = ((maxPos as any)?.position ?? 0) + 1;

  await sc.from("event_waitlist").insert({ event_id: id, user_id: user.id, position: nextPos });
  await sc.from("events").update({ waitlist_count: nextPos, updated_at: new Date(nowMsWl).toISOString() }).eq("id", id);

  res.status(201).json({ position: nextPos });
});

// ── POST /api/events/:id/waitlist/accept ──────────────────────────────────────
// Accept a spot offer (user was promoted via promoteNextWaitlisted)

router.post("/events/:id/waitlist/accept", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: wlEntry } = await sc
    .from("event_waitlist")
    .select("position, offer_expires_at")
    .eq("event_id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!wlEntry) { sendError(res, "not_found", "Not on waitlist for this event"); return; }

  const offerExpiresAt = (wlEntry as any).offer_expires_at;
  if (!offerExpiresAt) {
    sendError(res, "forbidden", "No spot offer is pending for you"); return;
  }
  if (new Date(offerExpiresAt) < new Date()) {
    // Expired — remove user from queue entirely, then promote the next person.
    // Nulling offer_expires_at would cause promoteNextWaitlisted to re-offer
    // this same user (it queries IS NULL), so we delete instead.
    await sc.from("event_waitlist").delete().eq("event_id", id).eq("user_id", user.id);
    await promoteNextWaitlisted(sc, id);
    sendError(res, "forbidden", "Your spot offer has expired"); return;
  }

  // Verify capacity hasn't been filled since the offer was issued (overbooking guard)
  const { data: evCapCheck } = await sc.from("events").select("max_attendees, state, visibility, circle_id, trip_id").eq("id", id).maybeSingle();
  if (!evCapCheck) { sendError(res, "not_found", "Event not found"); return; }
  // State guard: never seat a 'going' RSVP on an event that is no longer live.
  // Without this, accepting an offer on a cancelled/archived/draft event would
  // add the user as attending (and the sweeper would keep promoting onto it).
  if (!["open", "full", "waitlist"].includes((evCapCheck as any).state)) {
    sendError(res, "forbidden", "This event is no longer accepting attendees"); return;
  }
  // Re-check the private-event join gate at accept time too — an invite could
  // have been revoked, or the offer reached an uninvited user (audit EVENTS WL-1).
  const acceptVis = await checkEventJoinVisibility(sc, evCapCheck, id, user.id);
  if (!acceptVis.ok) {
    // Remove them from the queue so the seat can go to an eligible member.
    await sc.from("event_waitlist").delete().eq("event_id", id).eq("user_id", user.id);
    await promoteNextWaitlisted(sc, id);
    sendError(res, "forbidden", acceptVis.message); return;
  }
  const maxAtt = (evCapCheck as any)?.max_attendees ?? null;
  if (maxAtt != null) {
    const currentGoing = await getGoingCount(sc, id);
    if (currentGoing >= maxAtt) {
      // Slot was taken — expire this offer and promote the next person
      await sc.from("event_waitlist").update({ offer_expires_at: null }).eq("event_id", id).eq("user_id", user.id);
      await promoteNextWaitlisted(sc, id);
      sendError(res, "forbidden", "This spot was filled before you accepted. You have been returned to the waitlist queue."); return;
    }
  }

  // Accept: create Going RSVP and remove from waitlist
  const { error: rsvpErr } = await sc.from("event_rsvps").upsert(
    { event_id: id, user_id: user.id, status: "going", updated_at: new Date().toISOString() },
    { onConflict: "event_id,user_id" },
  );
  if (rsvpErr) { req.log.error({ err: rsvpErr }, "waitlist accept rsvp"); sendError(res, "db_error", rsvpErr.message); return; }

  await sc.from("event_waitlist").delete().eq("event_id", id).eq("user_id", user.id);
  await syncEventState(sc, id);
  const goingNow = await getGoingCount(sc, id);
  const { data: wlAfterAccept } = await sc.from("event_waitlist").select("user_id").eq("event_id", id);
  await sc.from("events").update({
    going_count: goingNow,
    waitlist_count: ((wlAfterAccept as any[]) ?? []).length,
  }).eq("id", id);
  await syncAttendee(sc, id, user.id, "going");

  res.json({ status: "going", eventId: id });
});

// ── GET /api/events/:id/waitlist ─────────────────────────────────────────────
// Host / moderator view of the ordered waitlist queue.

router.get("/events/:id/waitlist", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await canManageAttendance(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host/moderator can view the waitlist"); return;
  }

  const { data: wlRows, error } = await sc
    .from("event_waitlist")
    .select("user_id, position, offer_expires_at")
    .eq("event_id", id)
    .order("position", { ascending: true });

  if (error) { req.log.error({ err: error }, "get event waitlist"); sendError(res, "db_error", error.message); return; }

  const rows = (wlRows as any[]) ?? [];
  if (rows.length === 0) { res.json({ waitlist: [] }); return; }

  // Fetch display profiles
  const userIds = rows.map((r: any) => r.user_id as string);
  const { data: profiles } = await sc
    .from("profiles")
    .select("id, handle, name, avatar_url")
    .in("id", userIds);

  const profileMap: Record<string, any> = {};
  {
    const allowedNames = await nameVisibilitySet(sc, userIds);
    for (const p of (profiles as any[]) ?? []) profileMap[p.id as string] = sanitizeIdentity(p, allowedNames, user.id);
  }

  res.json({
    waitlist: rows.map((r: any) => ({
      userId:         r.user_id,
      position:       r.position,
      offerExpiresAt: r.offer_expires_at ?? null,
      user: profileMap[r.user_id]
        ? {
            handle:      profileMap[r.user_id].handle,
            displayName: profileMap[r.user_id].name,
            avatarUrl:   profileMap[r.user_id].avatar_url ?? null,
          }
        : null,
    })),
  });
});

// ── DELETE /api/events/:id/waitlist ───────────────────────────────────────────

router.delete("/events/:id/waitlist", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  await sc.from("event_waitlist").delete().eq("event_id", id).eq("user_id", user.id);
  // Recompute waitlist_count so UI stays accurate
  const { data: wlRemaining } = await sc.from("event_waitlist").select("user_id").eq("event_id", id);
  await sc
    .from("events")
    .update({ waitlist_count: ((wlRemaining as any[]) ?? []).length, updated_at: new Date().toISOString() })
    .eq("id", id);
  res.json({ ok: true });
});

// ── POST /api/events/:id/requests ─────────────────────────────────────────────

router.post("/events/:id/requests", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc.from("events").select("visibility, state, host_id, title").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  if ((ev as any).visibility !== "invite_only") {
    sendError(res, "forbidden", "This event does not require a join request"); return;
  }

  if (!["open", "full", "waitlist"].includes((ev as any).state)) {
    sendError(res, "forbidden", "Event is not accepting requests"); return;
  }

  const message = z.string().max(500).optional().parse(req.body.message);

  const { error } = await sc.from("event_join_requests").upsert(
    { event_id: id, user_id: user.id, status: "pending", message: message ?? null },
    { onConflict: "event_id,user_id", ignoreDuplicates: true },
  );
  if (error) { sendError(res, "db_error", error.message); return; }

  // Notify host (fire-and-forget)
  void (async () => {
    try {
      const { data: hp } = await sc.from("profiles").select("expo_push_token").eq("id", (ev as any).host_id).maybeSingle();
      if ((hp as any)?.expo_push_token) {
        await sendPushWithRetry(sc, { userId: (ev as any).host_id, tokens: [(hp as any).expo_push_token] }, {
          title: "New join request",
          body: `Someone wants to join "${(ev as any).title}"`,
          data: { eventId: id, type: "event_join_request" },
        });
      }
    } catch (err) {
      // resolves-not-throws-ok: fire-and-forget push — best-effort, logged.
      req.log?.warn({ err, eventId: id }, "join-request push notify failed");
    }
  })();

  res.status(201).json({ ok: true, status: "pending" });
});

// ── GET /api/events/:id/requests ──────────────────────────────────────────────

router.get("/events/:id/requests", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await canManageAttendance(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host/moderator can view join requests"); return;
  }

  const { data: requests } = await sc
    .from("event_join_requests")
    .select("id, user_id, status, message, created_at")
    .eq("event_id", id)
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  // Enrich with profiles
  const userIds = ((requests as any[]) ?? []).map((r: any) => r.user_id as string);
  let profileMap: Record<string, any> = {};
  if (userIds.length > 0) {
    const { data: profiles } = await sc
      .from("profiles")
      .select("id, handle, name, avatar_url")
      .in("id", userIds);
    const allowedNames = await nameVisibilitySet(sc, userIds);
    for (const p of (profiles as any[]) ?? []) {
      profileMap[p.id as string] = sanitizeIdentity(p, allowedNames, user.id);
    }
  }

  res.json({
    requests: ((requests as any[]) ?? []).map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      status: r.status,
      message: r.message,
      createdAt: r.created_at,
      user: profileMap[r.user_id] ? {
        id: profileMap[r.user_id].id,
        handle: profileMap[r.user_id].handle ?? null,
        displayName: profileMap[r.user_id].name ?? null,
        avatarUrl: profileMap[r.user_id].avatar_url ?? null,
      } : null,
    })),
  });
});

// ── PATCH /api/events/:id/requests/:userId ────────────────────────────────────

router.patch("/events/:id/requests/:userId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, userId } = req.params;
  if (!isUuid(id) || !isUuid(userId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await canManageAttendance(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host/moderator can manage join requests"); return;
  }

  const action = z.enum(["approve", "deny"]).parse(req.body.action);

  // On approval: run gate checks before committing the RSVP
  if (action === "approve") {
    const { data: evFull } = await sc.from("events").select("*").eq("id", id).maybeSingle();
    if (!evFull) { sendError(res, "not_found", "Event not found"); return; }

    // Eligibility: ban / block / trust / age / verified
    const approveElig = await checkEventEligibility(sc, evFull as any, userId);
    if (!approveElig.ok) {
      sendError(res, approveElig.errorCode as any, `Cannot approve: ${approveElig.message}`); return;
    }

    // Mark request as approved
    await sc.from("event_join_requests").update({
      status: "approved",
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
    }).eq("event_id", id).eq("user_id", userId);

    // Capacity check: if full, route to waitlist (when enabled) instead of going
    const maxAtt = (evFull as any).max_attendees ?? null;
    const currentGoing = maxAtt != null ? await getGoingCount(sc, id) : 0;
    if (maxAtt != null && currentGoing >= maxAtt) {
      if ((evFull as any).waitlist_enabled) {
        // Add to waitlist if not already there
        const { data: existingWl } = await sc
          .from("event_waitlist").select("position").eq("event_id", id).eq("user_id", userId).maybeSingle();
        if (!existingWl) {
          const { data: maxPos } = await sc
            .from("event_waitlist").select("position").eq("event_id", id)
            .order("position", { ascending: false }).limit(1).maybeSingle();
          const nextPos = ((maxPos as any)?.position ?? 0) + 1;
          await sc.from("event_waitlist").insert({ event_id: id, user_id: userId, position: nextPos });
          const { data: wlRows } = await sc.from("event_waitlist").select("user_id").eq("event_id", id);
          await sc.from("events").update({ waitlist_count: ((wlRows as any[]) ?? []).length }).eq("id", id);
        }
        res.json({ ok: true, action, status: "waitlisted" }); return;
      }
      // Waitlist disabled and event full — still approve the request but don't auto-RSVP
      res.json({ ok: true, action, status: "approved_pending_capacity" }); return;
    }

    // Capacity OK — create Going RSVP
    await sc.from("event_rsvps").upsert(
      { event_id: id, user_id: userId, status: "going", updated_at: new Date().toISOString() },
      { onConflict: "event_id,user_id" },
    );
    await syncEventState(sc, id);
    const going = await getGoingCount(sc, id);
    await sc.from("events").update({ going_count: going }).eq("id", id);
    await syncAttendee(sc, id, userId, "going");

    // Add to chat
    if ((evFull as any)?.chat_thread_id && (evFull as any)?.chat_enabled) {
      await addUserToChatThread(sc, (evFull as any).chat_thread_id, userId);
    }
  } else {
    // Deny: just update the request status
    await sc.from("event_join_requests").update({
      status: "denied",
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
    }).eq("event_id", id).eq("user_id", userId);
  }

  // Notify the requester (fire-and-forget)
  void (async () => {
    try {
      const { data: evData } = await sc.from("events").select("title").eq("id", id).maybeSingle();
      const { data: hp } = await sc.from("profiles").select("expo_push_token").eq("id", userId).maybeSingle();
      if ((hp as any)?.expo_push_token) {
        await sendPushWithRetry(sc, { userId, tokens: [(hp as any).expo_push_token] }, {
          title: action === "approve" ? "You're in! 🎉" : "Join request declined",
          body: action === "approve"
            ? `Your request to join "${(evData as any)?.title}" was approved.`
            : `Your request to join "${(evData as any)?.title}" was declined.`,
          data: { eventId: id, type: "event_request_decision", decision: action },
        });
      }
    } catch (err) {
      // resolves-not-throws-ok: fire-and-forget push — best-effort, logged.
      req.log?.warn({ err, eventId: id }, "request-decision push notify failed");
    }
  })();

  res.json({ ok: true, action });
});

// ── POST /api/events/:id/roles ─────────────────────────────────────────────────

router.post("/events/:id/roles", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const myRole = await getEventRole(sc, id, user.id);
  if (myRole !== "host") { sendError(res, "forbidden", "Only the host can assign roles"); return; }

  const parsed = RoleSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const { userId: targetId, role } = parsed.data;

  if (targetId === user.id) { sendError(res, "invalid_payload", "Cannot change your own role"); return; }

  // If banning: remove RSVP and waitlist entry, remove from chat, recompute counts
  if (role === "banned") {
    await sc.from("event_rsvps").delete().eq("event_id", id).eq("user_id", targetId);
    await sc.from("event_waitlist").delete().eq("event_id", id).eq("user_id", targetId);
    await syncEventState(sc, id);
    const going = await getGoingCount(sc, id);
    const { data: wlAfterBan } = await sc.from("event_waitlist").select("user_id").eq("event_id", id);
    await sc.from("events").update({
      going_count: going,
      waitlist_count: ((wlAfterBan as any[]) ?? []).length,
    }).eq("id", id);
    await syncAttendee(sc, id, targetId, null);

    const { data: ev } = await sc.from("events").select("chat_thread_id").eq("id", id).maybeSingle();
    if ((ev as any)?.chat_thread_id) {
      await removeUserFromChatThread(sc, (ev as any).chat_thread_id, targetId);
    }
  }

  const { error } = await sc.from("event_roles").upsert(
    { event_id: id, user_id: targetId, role },
    { onConflict: "event_id,user_id" },
  );
  if (error) { sendError(res, "db_error", error.message); return; }

  res.json({ ok: true, userId: targetId, role });
});

// ── DELETE /api/events/:id/roles/:userId ──────────────────────────────────────

router.delete("/events/:id/roles/:userId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, userId } = req.params;
  if (!isUuid(id) || !isUuid(userId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const myRole = await getEventRole(sc, id, user.id);
  if (myRole !== "host") { sendError(res, "forbidden", "Only the host can remove roles"); return; }
  if (userId === user.id) { sendError(res, "forbidden", "Cannot remove your own host role"); return; }

  await sc.from("event_roles").delete().eq("event_id", id).eq("user_id", userId);
  res.json({ ok: true });
});

// ── POST /api/events/:id/checkin ──────────────────────────────────────────────

router.post("/events/:id/checkin", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: rsvp } = await sc
    .from("event_rsvps")
    .select("status")
    .eq("event_id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!(rsvp as any) || (rsvp as any).status !== "going") {
    sendError(res, "forbidden", "You must have a Going RSVP to check in"); return;
  }

  await sc.from("event_attendee_states").upsert(
    { event_id: id, user_id: user.id, checked_in_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { onConflict: "event_id,user_id" },
  );

  res.json({ ok: true, checkedInAt: new Date().toISOString() });
});

// ── POST /api/events/:id/attendance/:userId ───────────────────────────────────

router.post("/events/:id/attendance/:userId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, userId } = req.params;
  if (!isUuid(id) || !isUuid(userId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await canManageAttendance(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host/moderator can confirm attendance"); return;
  }

  // Event must be in progress or completed
  const { data: evState } = await sc.from("events").select("state").eq("id", id).maybeSingle();
  if (!evState || !["started", "completed"].includes((evState as any).state)) {
    sendError(res, "forbidden", "Attendance can only be confirmed during or after the event"); return;
  }

  // Target user must have a Going RSVP
  const { data: targetRsvp } = await sc
    .from("event_rsvps").select("status").eq("event_id", id).eq("user_id", userId).maybeSingle();
  if (!(targetRsvp as any) || (targetRsvp as any).status !== "going") {
    sendError(res, "forbidden", "User does not have a Going RSVP for this event"); return;
  }

  const now = new Date().toISOString();
  // supabase-js resolves rather than throws — unchecked, a failed upsert
  // returned {ok:true} while the attendance confirmation was never recorded.
  const { error: confirmErr } = await sc.from("event_attendee_states").upsert(
    { event_id: id, user_id: userId, confirmed_at: now, confirmed_by: user.id, updated_at: now },
    { onConflict: "event_id,user_id" },
  );
  if (confirmErr) { sendError(res, "db_error", confirmErr.message); return; }

  // Trust Score event (fire-and-forget)
  void (async () => {
    try {
      await recordTrustEvent(sc, {
        userId,
        eventType: "event_attendance_confirmed",
        category: "plan_attendance",
        delta: 4,
        severity: "minor",
        sourceType: "event",
        sourceId: id,
      });
    } catch (err) {
      // recordTrustEvent THROWS on a DB error — a swallowed throw here means the
      // attendee's trust credit was silently lost, so log it (still non-fatal).
      req.log?.warn({ err, eventId: id, userId }, "attendance-confirmed trust event failed");
    }
  })();

  res.json({ ok: true, confirmedAt: now });
});

// ── POST /api/events/:id/noshow/:userId ───────────────────────────────────────

router.post("/events/:id/noshow/:userId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, userId } = req.params;
  if (!isUuid(id) || !isUuid(userId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await canManageAttendance(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host/moderator can mark no-shows"); return;
  }

  // Event must be in progress or completed
  const { data: evStateNs } = await sc.from("events").select("state").eq("id", id).maybeSingle();
  if (!evStateNs || !["started", "completed"].includes((evStateNs as any).state)) {
    sendError(res, "forbidden", "No-shows can only be marked during or after the event"); return;
  }

  // Target must have committed to going
  const { data: nsRsvp } = await sc
    .from("event_rsvps").select("status").eq("event_id", id).eq("user_id", userId).maybeSingle();
  if (!(nsRsvp as any) || (nsRsvp as any).status !== "going") {
    sendError(res, "forbidden", "User does not have a Going RSVP for this event"); return;
  }

  const now = new Date().toISOString();
  // supabase-js resolves rather than throws — unchecked, a failed upsert
  // returned {ok:true} while the no-show was never recorded.
  const { error: noShowErr } = await sc.from("event_attendee_states").upsert(
    { event_id: id, user_id: userId, no_show_at: now, no_show_by: user.id, updated_at: now },
    { onConflict: "event_id,user_id" },
  );
  if (noShowErr) { sendError(res, "db_error", noShowErr.message); return; }

  // Trust Score penalty (fire-and-forget)
  void (async () => {
    try {
      await recordTrustEvent(sc, {
        userId,
        eventType: "event_no_show",
        category: "plan_attendance",
        delta: -5,
        severity: "moderate",
        sourceType: "event",
        sourceId: id,
        dedupWindowHours: 48,
      });
    } catch (err) {
      // recordTrustEvent THROWS on a DB error — a swallowed throw here means the
      // no-show penalty was silently lost, so log it (still non-fatal).
      req.log?.warn({ err, eventId: id, userId }, "no-show trust penalty failed");
    }
  })();

  res.json({ ok: true, noShowAt: now });
});

// ── GET /api/events/:id/attendees ─────────────────────────────────────────────
// Host/moderator endpoint — returns full attendee list with attendance state

router.get("/events/:id/attendees", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await canManageAttendance(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host or moderators can view the full attendee list"); return;
  }

  const { data: rsvps, error } = await sc
    .from("event_rsvps")
    .select("user_id, status, updated_at")
    .eq("event_id", id)
    .eq("status", "going");

  if (error) { req.log.error({ err: error }, "get attendees"); sendError(res, "db_error", error.message); return; }

  const userIds = ((rsvps as any[]) ?? []).map((r: any) => r.user_id as string);

  let profiles: any[] = [];
  let states: any[] = [];

  if (userIds.length > 0) {
    const [profilesResult, statesResult] = await Promise.all([
      sc.from("profiles").select("id, handle, name, avatar_url").in("id", userIds),
      sc.from("event_attendee_states").select("user_id, checked_in_at, confirmed_at, no_show_at").eq("event_id", id).in("user_id", userIds),
    ]);
    profiles = (profilesResult as any).data ?? [];
    states = (statesResult as any).data ?? [];
  }

  const profileMap: Record<string, any> = {};
  {
    const allowedNames = await nameVisibilitySet(sc, userIds);
    for (const p of profiles) profileMap[p.id] = sanitizeIdentity(p, allowedNames, user.id);
  }

  const stateMap: Record<string, any> = {};
  for (const s of states) stateMap[s.user_id] = s;

  res.json({
    attendees: ((rsvps as any[]) ?? []).map((r: any) => {
      const p = profileMap[r.user_id];
      const s = stateMap[r.user_id];
      return {
        userId:      r.user_id,
        handle:      p?.handle ?? null,
        displayName: p?.name ?? null,
        avatarUrl:   p?.avatar_url ?? null,
        rsvpStatus:  r.status,
        checkedInAt: s?.checked_in_at ?? null,
        confirmedAt: s?.confirmed_at ?? null,
        noShowAt:    s?.no_show_at ?? null,
      };
    }),
  });
});

// ── POST /api/events/:id/memory ───────────────────────────────────────────────

router.post("/events/:id/memory", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const ok = await isHostOrCoHost(sc, id, user.id);
  if (!ok) { sendError(res, "forbidden", "Only host or co-host can convert to memory"); return; }

  const { data: ev } = await sc.from("events").select("*").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }
  if ((ev as any).state !== "completed") {
    sendError(res, "forbidden", "Only completed events can be converted to a memory"); return;
  }

  // Stub memory record — full Memory System handled separately
  const { data: memory, error } = await sc
    .from("passport_memories")
    .insert({
      user_id:    user.id,
      source_type: "event",
      source_id:  id,
      title:      (ev as any).title,
      description: (ev as any).description ?? null,
      city:       (ev as any).city ?? null,
      country:    (ev as any).country ?? null,
      status:     "active",
    })
    .select("id")
    .single();

  if (error) { req.log.error({ err: error }, "convert event to memory"); sendError(res, "db_error", error.message); return; }

  res.status(201).json({ memoryId: (memory as any).id });
});

// ── POST /api/events/:id/chat ─────────────────────────────────────────────────
// Idempotent: creates the event's group chat thread, or returns the existing one.
// Host and co-hosts only — attendees enter the existing thread via /chat/join.
// Returns { threadId: string; created: boolean }.
// If the event already has a chat_thread_id this returns 200 + created:false.
// If a new thread is created this returns 201 + created:true.

router.post("/events/:id/chat", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc
    .from("events")
    .select("chat_thread_id, chat_enabled, title, host_id, state")
    .eq("id", id)
    .maybeSingle();

  if (!ev) { sendError(res, "not_found", "Event not found"); return; }
  if (!(ev as any).chat_enabled) { sendError(res, "forbidden", "Chat is disabled for this event"); return; }

  const isStaff = await isHostOrCoHost(sc, id, user.id);
  if (!isStaff) { sendError(res, "forbidden", "Only the host or co-host can create the event chat"); return; }

  // Idempotent: return the existing thread rather than creating a duplicate
  if ((ev as any).chat_thread_id) {
    res.status(200).json({ threadId: (ev as any).chat_thread_id, created: false });
    return;
  }

  const threadId = await createEventChatThread(sc, id, (ev as any).title, user.id);
  if (!threadId) { sendError(res, "db_error", "Failed to create chat thread", { exposeDetail: true }); return; }

  res.status(201).json({ threadId, created: true });
});

// ── POST /api/events/:id/chat/join ────────────────────────────────────────────

router.post("/events/:id/chat/join", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc
    .from("events")
    .select("chat_thread_id, chat_enabled, state, title")
    .eq("id", id)
    .maybeSingle();

  if (!ev) {
    sendError(res, "not_found", "Event not found"); return;
  }
  if (!(ev as any).chat_enabled) {
    sendError(res, "forbidden", "Chat is disabled for this event"); return;
  }

  // Must have a Going RSVP or be host/co_host
  const [rsvpResult, roleResult] = await Promise.all([
    sc.from("event_rsvps").select("status").eq("event_id", id).eq("user_id", user.id).maybeSingle(),
    getEventRole(sc, id, user.id),
  ]);

  const hasGoingRsvp = (rsvpResult as any).data?.status === "going";
  const isStaff = roleResult === "host" || roleResult === "co_host";

  if (!hasGoingRsvp && !isStaff) {
    sendError(res, "forbidden", "You must have a Going RSVP to join the chat"); return;
  }

  // Lazily create the thread on first join rather than 404'ing — most
  // events never have chat_thread_id set by the host explicitly, which
  // previously left every eligible attendee's "Event Chat" button dead.
  let threadId: string | null = (ev as any).chat_thread_id ?? null;
  if (!threadId) {
    threadId = await createEventChatThread(sc, id, (ev as any).title, user.id);
  }
  if (!threadId) {
    sendError(res, "not_found", "Event chat not found"); return;
  }

  await addUserToChatThread(sc, threadId, user.id);
  res.json({ threadId });
});

// ── POST /api/events/:id/updates ──────────────────────────────────────────────

router.post("/events/:id/updates", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await canManageAttendance(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host/moderator can post updates"); return;
  }

  const body = z.string().min(1).max(1000).parse(req.body.body);
  const pinned = z.boolean().optional().parse(req.body.pinned) ?? false;

  const { data: update, error } = await sc
    .from("event_updates")
    .insert({ event_id: id, author_id: user.id, body, pinned })
    .select("id, body, pinned, created_at")
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }

  // Notify attendees (fire-and-forget)
  if (pinned) {
    void (async () => {
      try {
        const recipients = await getAttendeeRecipients(sc, id);
        if (recipients.length > 0) {
          const { data: ev } = await sc.from("events").select("title").eq("id", id).maybeSingle();
          await sendPushWithRetry(sc, recipients, {
            title: `Update: ${(ev as any)?.title ?? "Event"}`,
            body,
            data: { eventId: id, type: "event_update" },
          });
        }
      } catch (err) {
        // resolves-not-throws-ok: fire-and-forget push — best-effort, logged.
        req.log?.warn({ err, eventId: id }, "event-update push notify failed");
      }
    })();
  }

  res.status(201).json(update);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatEvent(ev: any, viewerId: string, opts?: { goingRsvp?: boolean; hostProfile?: { name?: string | null; handle?: string | null; avatar_url?: string | null } }) {
  const isHost = ev.host_id === viewerId;
  const isParticipant = isHost || (opts?.goingRsvp ?? false);
  // Exact coordinates are only visible to: the host, or any viewer who has a
  // going RSVP (opts.goingRsvp). When show_exact_location is false and the
  // viewer is neither host nor confirmed attendee, redact lat/lng.
  const showCoords = isParticipant || (ev.show_exact_location !== false);
  return {
    id:                  ev.id,
    hostId:              ev.host_id,
    hostName:            opts?.hostProfile?.name ?? null,
    hostHandle:          opts?.hostProfile?.handle ?? null,
    hostAvatarUrl:       opts?.hostProfile?.avatar_url ?? null,
    title:               ev.title,
    description:         ev.description ?? null,
    locationName:        ev.location_name ?? null,
    locationLat:         showCoords ? (ev.location_lat ?? null) : null,
    locationLng:         showCoords ? (ev.location_lng ?? null) : null,
    startsAt:            ev.starts_at ?? null,
    endsAt:              ev.ends_at ?? null,
    coverUrl:            ev.cover_url ?? null,
    coverMediaType:      ev.cover_media_type ?? null,
    coverSource:         ev.cover_source ?? null,
    maxAttendees:        ev.max_attendees ?? null,
    ageMin:              ev.age_min ?? null,
    ageMax:              ev.age_max ?? null,
    trustScoreMin:       ev.trust_score_min ?? null,
    verifiedOnly:        ev.verified_only ?? false,
    visibility:          ev.visibility,
    state:               ev.state,
    chatEnabled:         ev.chat_enabled ?? true,
    chatThreadId:        ev.chat_thread_id ?? null,
    waitlistEnabled:     ev.waitlist_enabled ?? true,
    // priceType is always public (informs intent to attend).
    // priceUrl and safetyNotes are private — only host/participants see them.
    priceType:           ev.price_type ?? null,
    priceUrl:            isParticipant ? (ev.price_url ?? null) : null,
    safetyNotes:         isHost ? (ev.safety_notes ?? null) : null,
    rsvpOptions:         ev.rsvp_options ?? ["going","maybe","interested","cant_go"],
    goingCount:          ev.going_count ?? 0,
    waitlistCount:       ev.waitlist_count ?? 0,
    category:            ev.category ?? null,
    city:                ev.city ?? null,
    country:             ev.country ?? null,
    showExactLocation:   ev.show_exact_location ?? false,
    rsvpClosed:          ev.rsvp_closed ?? false,
    // perf-trim: isRecurring omitted — field not present in client EventSummary/EventDetail types
    tags:                ev.tags ?? [],
    isHost,
    createdAt:           ev.created_at,
    updatedAt:           ev.updated_at,
  };
}

// ── Spam / prohibited-content validation ──────────────────────────────────────
// Applied on both POST /events (publishNow=true) and POST /events/:id/publish.

const PROHIBITED_PATTERNS = [
  /\b(free\s*money|get\s*rich\s*quick|pyramid\s*scheme|ponzi)\b/i,
  /\b(xxx|pornography|escort)\b/i,
  /\b(drugs?\s+for\s+sale|buy\s+drugs?|sell\s+drugs?)\b/i,
];

const ALLOWED_TICKET_HOSTS = [
  "eventbrite.com", "ticketmaster.com", "dice.fm", "ra.co",
  "stubhub.com", "axs.com", "ticketweb.com", "universe.com",
];

function checkProhibitedContent(title: string, description?: string | null): string | null {
  const text = `${title} ${description ?? ""}`;
  for (const pat of PROHIBITED_PATTERNS) {
    if (pat.test(text)) return "Content contains prohibited keywords";
  }
  return null;
}

function checkTicketUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (!ALLOWED_TICKET_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
      return `Ticket URL host is not on the allowlist (${ALLOWED_TICKET_HOSTS.join(", ")})`;
    }
  } catch {
    return "Ticket URL is not a valid URL";
  }
  return null;
}

async function checkDuplicateEvent(
  sc: any,
  hostId: string,
  locationName: string | null | undefined,
  startsAt: string | null | undefined,
  excludeId?: string,
): Promise<boolean> {
  if (!locationName || !startsAt) return false;
  const windowStart = new Date(new Date(startsAt).getTime() - 3 * 60 * 60 * 1000).toISOString();
  const windowEnd   = new Date(new Date(startsAt).getTime() + 3 * 60 * 60 * 1000).toISOString();
  let q = sc.from("events")
    .select("id")
    .eq("host_id", hostId)
    .ilike("location_name", locationName.trim())
    .gte("starts_at", windowStart)
    .lte("starts_at", windowEnd)
    .not("state", "in", '("cancelled","archived")');
  if (excludeId) q = q.neq("id", excludeId);
  const { data } = await q;
  return Array.isArray(data) && data.length > 0;
}

/** Check if userId is an active member of circle circleId (accepted/active status).
 *  Live table is circle_memberships(user_id = circle owner, other_id = member);
 *  a circle's id is its owner's user id, so the owner is always a member. */
async function isCircleMember(sc: any, circleId: string, userId: string): Promise<boolean> {
  if (circleId === userId) return true;
  const { data } = await sc
    .from("circle_memberships")
    .select("other_id")
    .eq("user_id", circleId)
    .eq("other_id", userId)
    .maybeSingle();
  return !!data;
}

/** Check if userId is an accepted member/owner of the trip linked to the event. */
async function isTripEventMember(sc: any, tripId: string, userId: string): Promise<boolean> {
  const { data } = await sc
    .from("trip_members")
    .select("role")
    .eq("trip_id", tripId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return false;
  const row = data as { role: string; status?: string | null };
  const acceptedRoles = ["owner", "co_host", "member", "viewer"];
  if (!acceptedRoles.includes(row.role)) return false;
  if (row.status != null && row.status !== "accepted") return false;
  return true;
}

async function canViewEvent(sc: any, ev: any, userId: string): Promise<boolean> {
  if (ev.host_id === userId) return true;

  // Staff (cohost/moderator) always have access
  const { data: staffRole } = await sc
    .from("event_roles").select("role")
    .eq("event_id", ev.id).eq("user_id", userId)
    .maybeSingle();
  if (staffRole && ["co_host", "moderator"].includes((staffRole as any).role)) return true;

  // A non-live event (draft/cancelled/archived) is visible only to its host and
  // staff (both already returned true above) — regardless of visibility. Without
  // this gate the visibility branches below leaked unpublished/withdrawn events
  // to members, friends, circle/trip members and invitees.
  if (["draft", "cancelled", "archived"].includes(ev.state)) return false;

  if (ev.visibility === "public") return true;
  if (ev.visibility === "friends_only") {
    const { data: friendship } = await sc
      .from("user_friendships")
      .select("user_a")
      .or(`and(user_a.eq.${userId},user_b.eq.${ev.host_id}),and(user_b.eq.${userId},user_a.eq.${ev.host_id})`)
      .maybeSingle();
    if (friendship) return true;
    // friends_only: also allow existing attendees/role holders to see the event
    const [rsvp, role] = await Promise.all([
      sc.from("event_rsvps").select("status").eq("event_id", ev.id).eq("user_id", userId).maybeSingle(),
      sc.from("event_roles").select("role").eq("event_id", ev.id).eq("user_id", userId).maybeSingle(),
    ]);
    return !!(rsvp as any).data || !!(role as any).data;
  }
  if (ev.visibility === "circle") {
    // Must be a member of the linked circle
    if (!ev.circle_id) return false;
    return isCircleMember(sc, ev.circle_id, userId);
  }
  if (ev.visibility === "trip") {
    // Must be an accepted member of the linked trip
    if (!ev.trip_id) return false;
    return isTripEventMember(sc, ev.trip_id, userId);
  }
  // invite_only / unknown: must have an RSVP, approved join request, or role
  const [rsvp, role] = await Promise.all([
    sc.from("event_rsvps").select("status").eq("event_id", ev.id).eq("user_id", userId).maybeSingle(),
    sc.from("event_roles").select("role").eq("event_id", ev.id).eq("user_id", userId).maybeSingle(),
  ]);
  return !!(rsvp as any).data || !!(role as any).data;
}

async function createEventChatThread(sc: any, eventId: string, title: string, hostId: string): Promise<string | null> {
  try {
    const chatEnabled = await isFlagEnabled(sc, "events_chat_enabled");
    if (!chatEnabled) return null;

    // Quick read: if a thread already exists, return it without touching anything.
    const { data: ev0 } = await sc.from("events").select("chat_thread_id").eq("id", eventId).maybeSingle();
    if ((ev0 as any)?.chat_thread_id) return (ev0 as any).chat_thread_id as string;

    // Pre-generate the thread ID so we can commit it to events.chat_thread_id atomically
    // BEFORE inserting the message_threads row.  Only the request that wins the conditional
    // UPDATE gets to insert the thread — preventing both orphan rows and split conversations.
    const candidateId = randomUUID();

    // Atomic claim: write candidateId into events.chat_thread_id only if it is still NULL.
    // Two concurrent callers both see null → both attempt this UPDATE → exactly one row is
    // returned (the winner); the loser gets an empty array.
    const { data: claimed } = await sc
      .from("events")
      .update({ chat_thread_id: candidateId, updated_at: new Date().toISOString() })
      .eq("id", eventId)
      .is("chat_thread_id", null)
      .select("chat_thread_id");

    const claimedRows = (claimed as any[]) ?? [];

    if (claimedRows.length === 0) {
      // We lost the race — return the thread the winner already created.
      const { data: ev1 } = await sc.from("events").select("chat_thread_id").eq("id", eventId).maybeSingle();
      return (ev1 as any)?.chat_thread_id ?? null;
    }

    // We won the race — now create the thread using the pre-committed ID.
    const { data: thread, error: threadErr } = await sc
      .from("message_threads")
      .insert({
        id: candidateId,
        thread_type: "direct",
        title,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (threadErr || !(thread as any)?.id) {
      // Roll back the claim so another caller can retry.
      await sc.from("events").update({ chat_thread_id: null, updated_at: new Date().toISOString() }).eq("id", eventId);
      return null;
    }

    await sc.from("message_thread_members").insert({ thread_id: candidateId, user_id: hostId });
    return candidateId;
  } catch { return null; }
}

// ── POST /api/events/:id/reviews ─────────────────────────────────────────────
// Attendee submits a review after the event completes

const ReviewSchema = z.object({
  rating:    z.number().int().min(1).max(5),
  body:      z.string().max(1000).optional(),
  anonymous: z.boolean().default(false),
});

router.post("/events/:id/reviews", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const parsed = ReviewSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid input"); return; }

  const { data: ev } = await sc.from("events").select("state, host_id").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }
  if ((ev as any).state !== "completed") {
    sendError(res, "forbidden", "Reviews are only allowed after the event has completed"); return;
  }

  // Must have confirmed attendance — hosts cannot review their own event
  if ((ev as any).host_id === user.id) {
    sendError(res, "forbidden", "Hosts cannot review their own event"); return;
  }
  const { data: attendeeState } = await sc
    .from("event_attendee_states")
    .select("confirmed_at")
    .eq("event_id", id)
    .eq("user_id", user.id)
    .not("confirmed_at", "is", null)
    .maybeSingle();
  if (!attendeeState) {
    sendError(res, "forbidden", "Only confirmed attendees can review this event"); return;
  }

  const { data: review, error } = await sc
    .from("event_reviews")
    .upsert(
      {
        event_id:   id,
        reviewer_id: user.id,
        rating:     parsed.data.rating,
        body:       parsed.data.body ?? null,
        anonymous:  parsed.data.anonymous,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "event_id,reviewer_id" },
    )
    .select("id, rating, body, anonymous, created_at")
    .single();

  if (error) { req.log.error({ err: error }, "submit event review"); sendError(res, "db_error", error.message); return; }

  // Recompute average rating
  const { data: allRatings } = await sc
    .from("event_reviews")
    .select("rating")
    .eq("event_id", id);
  const avg = allRatings && (allRatings as any[]).length > 0
    ? Math.round(((allRatings as any[]).reduce((s: number, r: any) => s + r.rating, 0) / (allRatings as any[]).length) * 10) / 10
    : parsed.data.rating;
  await sc.from("events").update({ avg_rating: avg, review_count: ((allRatings as any[]) ?? []).length }).eq("id", id);

  res.status(201).json({
    id:        (review as any).id,
    rating:    (review as any).rating,
    body:      (review as any).body,
    anonymous: (review as any).anonymous,
    createdAt: (review as any).created_at,
  });
});

// ── GET /api/events/:id/reviews ───────────────────────────────────────────────

router.get("/events/:id/reviews", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // SEC-05: reviews inherit the event's visibility — gate exactly like the detail
  // route so a private/invite-only event's reviews aren't readable by anyone
  // holding the UUID.
  const { data: ev } = await sc.from("events").select("*").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }
  if (!await canViewEvent(sc, ev as any, user.id)) { sendError(res, "not_found", "Event not found or access denied"); return; }
  if (await isBlocked(sc, user.id, (ev as any).host_id)) { sendError(res, "not_found", "Event not found or access denied"); return; }

  const page  = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset = (page - 1) * limit;

  const { data: reviews, error } = await sc
    .from("event_reviews")
    .select("id, rating, body, anonymous, created_at, reviewer_id, profiles!reviewer_id(handle, display_name, avatar_url)")
    .eq("event_id", id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { req.log.error({ err: error }, "get event reviews"); sendError(res, "db_error", error.message); return; }

  // Universal display-name rule: reviewer names show only when opted in.
  const reviewerIds = ((reviews as any[]) ?? [])
    .filter((r: any) => !r.anonymous)
    .map((r: any) => r.reviewer_id as string);
  const allowedReviewerNames = await nameVisibilitySet(sc, reviewerIds);

  res.json({
    reviews: ((reviews as any[]) ?? []).map((r: any) => ({
      id:        r.id,
      rating:    r.rating,
      body:      r.body ?? null,
      anonymous: r.anonymous,
      createdAt: r.created_at,
      reviewer:  r.anonymous ? null : {
        id:          r.reviewer_id,
        handle:      r.profiles?.handle ?? null,
        displayName: (r.reviewer_id === ctx.user.id || allowedReviewerNames.has(r.reviewer_id as string))
          ? (r.profiles?.display_name ?? null)
          : null,
        avatarUrl:   r.profiles?.avatar_url ?? null,
      },
    })),
    page,
    limit,
  });
});

// ── DELETE /api/events/:id/reviews ────────────────────────────────────────────
// Reviewer can delete their own review

router.delete("/events/:id/reviews", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  await sc.from("event_reviews").delete().eq("event_id", id).eq("reviewer_id", user.id);
  res.json({ ok: true });
});

// ── Activity log helper ───────────────────────────────────────────────────────

async function logEventActivity(
  sc: any,
  eventId: string,
  actorId: string | null,
  action: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  // non-fatal — activity log failures never block the main operation
  try {
    const { error } = await sc.from("event_activity_log").insert({
      event_id: eventId,
      actor_id: actorId,
      action,
      metadata,
    });
    if (error) console.warn("logEventActivity insert failed (non-fatal):", error.message ?? error);
  } catch (err) {
    // partial/fake clients may throw on missing methods
    console.warn("logEventActivity threw (non-fatal):", err);
  }
}

// ── POST /api/events/:id/publish ──────────────────────────────────────────────

router.post("/events/:id/publish", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const role = await getEventRole(sc, id, user.id);
  if (role !== "host") { sendError(res, "forbidden", "Only the host can publish this event"); return; }

  const { data: ev } = await sc.from("events").select("*").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  if ((ev as any).state !== "draft") {
    sendError(res, "invalid_payload", "Only draft events can be published"); return;
  }

  // Validate required fields for publication
  const e = ev as any;
  if (!e.title?.trim()) { sendError(res, "invalid_payload", "title is required to publish"); return; }
  if (!e.starts_at)      { sendError(res, "invalid_payload", "startsAt is required to publish"); return; }
  if (!e.location_name?.trim()) { sendError(res, "invalid_payload", "locationName is required to publish"); return; }
  if (e.ends_at && new Date(e.ends_at) <= new Date(e.starts_at)) {
    sendError(res, "invalid_payload", "endsAt must be after startsAt"); return;
  }

  // Spam / prohibited-content validation on publish
  const prohibitedErr = checkProhibitedContent(e.title, e.description);
  if (prohibitedErr) {
    await logEventActivity(sc, id, user.id, "publish_rejected_content", { reason: prohibitedErr });
    sendError(res, "invalid_payload", prohibitedErr); return;
  }

  const ticketErr = checkTicketUrl(e.ticket_url ?? e.price_url);
  if (ticketErr) {
    await logEventActivity(sc, id, user.id, "publish_rejected_ticket_url", { reason: ticketErr });
    sendError(res, "invalid_payload", ticketErr); return;
  }

  const isDuplicate = await checkDuplicateEvent(sc, user.id, e.location_name, e.starts_at, id);
  if (isDuplicate) {
    await logEventActivity(sc, id, user.id, "publish_rejected_duplicate", {});
    sendError(res, "duplicate_event", "An event with the same host, location, and time already exists"); return;
  }

  const { data: updated, error } = await sc.from("events")
    .update({ state: "open", updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*").single();

  if (error) { req.log.error({ err: error }, "publish event"); sendError(res, "db_error", error.message); return; }

  if (e.chat_enabled) {
    await createEventChatThread(sc, id, e.title, user.id);
  }

  await logEventActivity(sc, id, user.id, "published", {});

  // Fire-and-forget: award first_event_hosted stamp on a user's very first published event
  void (async () => {
    try {
      const { data: prior } = await sc
        .from("events")
        .select("id")
        .eq("host_id", user.id)
        .eq("state", "open")
        .neq("id", id)
        .limit(1)
        .maybeSingle();
      if (!prior) {
        await recordTrustEvent(sc, {
          userId: user.id,
          eventType: "first_event_hosted",
          category: "host_quality",
          delta: 10,
          severity: "minor",
          sourceType: "event",
          sourceId: user.id,
          dedupWindowHours: 99999,
          metadata: { event_id: id },
        }).catch(() => {});
      }
    } catch {}
  })();

  // Stamp Wave 2 (closes Task #1041 for hosting): first_event_hosted on
  // publish. Fire-and-forget; idempotent via (user:def:events:eventId).
  // (first_event_joined is wired at the RSVP-going site. Event-category
  // variants — food/music/outdoor — wait for the criteria engine wave.)
  void (async () => {
    try {
      const { awardStamp } = await import("../services/passport/StampAwardEngine.js");
      const r = await awardStamp(sc, {
        userId: user.id,
        definitionSlug: "first_event_hosted",
        sourceType: "events",
        sourceId: id,
      });
      if (r.awarded && r.userStampId) {
        const { NotificationService } = await import("../services/notifications/NotificationService.js");
        const { NotificationRouter } = await import("../services/notifications/NotificationRouter.js");
        const notifSvc = new NotificationService(sc);
        const notifRouter = new NotificationRouter(sc);
        const row = await notifSvc.create({
          userId: user.id,
          eventType: "passport.stamp_earned",
          sourceType: "events",
          sourceId: id,
          params: { location: "hosting your first event", stampId: r.userStampId },
        });
        if (row) await notifRouter.route(row);
      }
    } catch {}
  })();

  // Viewer is the host → always participant view
  res.json(formatEvent(updated as any, user.id, { goingRsvp: true }));
});

// ── POST /api/events/:id/cancel ───────────────────────────────────────────────

router.post("/events/:id/cancel", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const role = await getEventRole(sc, id, user.id);
  if (role !== "host") { sendError(res, "forbidden", "Only the host can cancel this event"); return; }

  const { data: ev } = await sc.from("events").select("title, state").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  if ((ev as any).state === "cancelled") { res.json({ ok: true }); return; }

  const reason = z.string().max(500).optional().parse(req.body.reason);

  // supabase-js resolves rather than throws — unchecked, a failed cancel
  // returned {ok:true} while the event stayed open.
  const { error: cancelErr } = await sc.from("events").update({ state: "cancelled", updated_at: new Date().toISOString() }).eq("id", id);
  if (cancelErr) { sendError(res, "db_error", cancelErr.message); return; }

  await logEventActivity(sc, id, user.id, "cancelled", { reason: reason ?? null });

  void (async () => {
    try {
      const recipients = await getAttendeeRecipients(sc, id);
      if (recipients.length > 0) {
        await sendPushWithRetry(sc, recipients, {
          title: "Event cancelled",
          body: `"${(ev as any).title}" has been cancelled.`,
          data: { eventId: id, type: "event_cancelled" },
        });
      }
    } catch (err) {
      // resolves-not-throws-ok: fire-and-forget push — best-effort, logged.
      req.log?.warn({ err, eventId: id }, "admin-cancel push notify failed");
    }
  })();

  res.json({ ok: true });
});

// ── POST /api/events/:id/postpone ─────────────────────────────────────────────

router.post("/events/:id/postpone", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const role = await getEventRole(sc, id, user.id);
  if (role !== "host") { sendError(res, "forbidden", "Only the host can postpone this event"); return; }

  const { data: ev } = await sc.from("events").select("title, state").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }
  if (["cancelled","archived","completed"].includes((ev as any).state)) {
    sendError(res, "invalid_payload", "Cannot postpone an event in this state"); return;
  }

  const reason = z.string().max(500).optional().parse(req.body.reason);

  // supabase-js resolves rather than throws — unchecked, a failed postpone
  // returned {ok:true} while the event stayed live.
  const { error: postponeErr } = await sc.from("events").update({ state: "draft", updated_at: new Date().toISOString() }).eq("id", id);
  if (postponeErr) { sendError(res, "db_error", postponeErr.message); return; }
  await logEventActivity(sc, id, user.id, "postponed", { reason: reason ?? null });

  void (async () => {
    try {
      const recipients = await getAttendeeRecipients(sc, id);
      if (recipients.length > 0) {
        await sendPushWithRetry(sc, recipients, {
          title: "Event postponed",
          body: `"${(ev as any).title}" has been postponed. Stay tuned for updates.`,
          data: { eventId: id, type: "event_postponed" },
        });
      }
    } catch (err) {
      // resolves-not-throws-ok: fire-and-forget push — best-effort, logged.
      req.log?.warn({ err, eventId: id }, "event-postponed push notify failed");
    }
  })();

  res.json({ ok: true });
});

// ── POST /api/events/:id/complete ─────────────────────────────────────────────

router.post("/events/:id/complete", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await isHostOrCoHost(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host or co-host can mark event as complete"); return;
  }

  const { data: ev } = await sc.from("events").select("state, title, host_id").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  // Only active ("started") events can be marked completed
  if ((ev as any).state !== "started") {
    sendError(res, "invalid_payload", `Event cannot be completed from state '${(ev as any).state}' — it must be active (started) first`); return;
  }

  await sc.from("events").update({ state: "completed", updated_at: new Date().toISOString() }).eq("id", id);
  await logEventActivity(sc, id, user.id, "completed", {});

  // Fire-and-forget: award trust signals + send review-prompt push notifications + stamps
  void (async () => {
    try {
      const evData = ev as any;
      // Award host plan_attendance signal for completing an event
      await recordTrustEvent(sc, {
        userId: evData.host_id,
        eventType: "event_hosted",
        category: "host_quality",
        delta: 5,
        severity: "minor",
        sourceType: "event",
        sourceId: id,
        metadata: { title: evData.title },
      }).catch(() => {});

      // Find all checked-in attendees via event_attendee_states (the canonical check-in table)
      const { data: checkins } = await sc
        .from("event_attendee_states")
        .select("user_id")
        .eq("event_id", id)
        .not("checked_in_at", "is", null);
      const checkinUserIds = ((checkins as any[]) ?? []).map((c: any) => c.user_id as string);

      if (checkinUserIds.length > 0) {
        // Award trust signal to each checked-in attendee
        await Promise.all(checkinUserIds.map((uid) =>
          recordTrustEvent(sc, {
            userId: uid,
            eventType: "event_attended",
            category: "plan_attendance",
            delta: 5,
            severity: "minor",
            sourceType: "event",
            sourceId: id,
            metadata: { title: evData.title },
          }).catch(() => {}),
        ));

        // Send review-prompt push notifications to checked-in attendees (excluding host)
        const attendeeIds = checkinUserIds.filter((uid) => uid !== evData.host_id);
        if (attendeeIds.length > 0) {
          const { data: profiles } = await sc.from("profiles").select("id, expo_push_token")
            .in("id", attendeeIds).not("expo_push_token", "is", null);
          const recipients = ((profiles as any[]) ?? [])
            .map((p: any) => ({ userId: p.id as string, tokens: [p.expo_push_token as string] }))
            .filter((r: any) => r.tokens[0]);
          if (recipients.length > 0) {
            await sendPushWithRetry(sc, recipients, {
              title: "How was the event?",
              body: `Leave a review for "${evData.title ?? "the event"}"`,
              data: { eventId: id, type: "event_review_prompt" },
            });
          }
        }
      }

      // ── Stamp awards ────────────────────────────────────────────────────────
      // event_host: awarded to the host for completing the event.
      // event_participant: awarded to every checked-in attendee (excluding host).
      const { awardStamp: _awardStamp } = await import("../services/passport/StampAwardEngine.js");
      const { NotificationService } = await import("../services/notifications/NotificationService.js");
      const { NotificationRouter }  = await import("../services/notifications/NotificationRouter.js");

      const stampAwards: Array<{ userId: string; slug: string }> = [
        { userId: evData.host_id, slug: "event_host" },
        ...checkinUserIds
          .filter((uid) => uid !== evData.host_id)
          .map((uid) => ({ userId: uid, slug: "event_participant" })),
      ];

      const stampSettled = await Promise.allSettled(
        stampAwards.map(({ userId, slug }) =>
          _awardStamp(sc, {
            userId,
            definitionSlug: slug,
            sourceType: "events",
            sourceId: id,
          }).then((r) => ({ userId, slug, ...r })),
        ),
      );

      // Batch one notification per user for any stamps awarded
      const stampsByUser = new Map<string, string[]>();
      for (const r of stampSettled) {
        if (r.status === "fulfilled" && (r as any).value.awarded) {
          const { userId, slug } = (r as any).value;
          if (!stampsByUser.has(userId)) stampsByUser.set(userId, []);
          stampsByUser.get(userId)!.push(slug);
        }
      }
      await Promise.allSettled(
        [...stampsByUser.entries()].map(async ([uid, slugs]) => {
          const notifSvc    = new NotificationService(sc);
          const notifRouter = new NotificationRouter(sc);
          const row = await notifSvc.create({
            userId:     uid,
            eventType:  "passport.stamp_earned",
            sourceType: "events",
            sourceId:   id,
            params: { stamps: slugs.join(","), count: String(slugs.length) },
          });
          if (row) await notifRouter.route(row);
        }),
      );
    } catch { /* non-fatal */ }
  })();

  res.json({ ok: true });
});

// ── POST /api/events/:id/archive ──────────────────────────────────────────────

router.post("/events/:id/archive", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const role = await getEventRole(sc, id, user.id);
  if (role !== "host") { sendError(res, "forbidden", "Only the host can archive this event"); return; }

  await sc.from("events").update({ state: "archived", updated_at: new Date().toISOString() }).eq("id", id);
  await logEventActivity(sc, id, user.id, "archived", {});

  res.json({ ok: true });
});

// ── POST /api/events/:id/close-rsvps ─────────────────────────────────────────

router.post("/events/:id/close-rsvps", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await isHostOrCoHost(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host or co-host can close RSVPs"); return;
  }

  const { data: ev } = await sc.from("events").select("id").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  await sc.from("events").update({ rsvp_closed: true, updated_at: new Date().toISOString() }).eq("id", id);
  await logEventActivity(sc, id, user.id, "rsvps_closed", {});

  res.json({ ok: true });
});

// ── POST /api/events/:id/reopen-rsvps ────────────────────────────────────────

router.post("/events/:id/reopen-rsvps", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await isHostOrCoHost(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host or co-host can reopen RSVPs"); return;
  }

  const { data: ev } = await sc.from("events").select("id").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  await sc.from("events").update({ rsvp_closed: false, updated_at: new Date().toISOString() }).eq("id", id);
  await logEventActivity(sc, id, user.id, "rsvps_reopened", {});

  res.json({ ok: true });
});

// ── PATCH /api/events/:id/attendees/:userId/status ────────────────────────────

router.patch("/events/:id/attendees/:userId/status", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, userId } = req.params;
  if (!isUuid(id) || !isUuid(userId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await canManageAttendance(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host/moderator can update attendee status"); return;
  }

  const status = z.enum(["going","maybe","interested","cant_go"]).parse(req.body.status);

  const { error } = await sc.from("event_rsvps")
    .upsert({ event_id: id, user_id: userId, status, updated_at: new Date().toISOString() }, { onConflict: "event_id,user_id" });

  if (error) { req.log.error({ err: error }, "patch attendee status"); sendError(res, "db_error", error.message); return; }

  await syncEventState(sc, id);
  const going = await getGoingCount(sc, id);
  await sc.from("events").update({ going_count: going }).eq("id", id);
  await syncAttendee(sc, id, userId, status);

  await logEventActivity(sc, id, user.id, "attendee_status_updated", { targetUserId: userId, newStatus: status });

  res.json({ ok: true, userId, status });
});

// ── DELETE /api/events/:id/attendees/:userId ──────────────────────────────────

router.delete("/events/:id/attendees/:userId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, userId } = req.params;
  if (!isUuid(id) || !isUuid(userId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await canManageAttendance(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host/moderator can remove attendees"); return;
  }

  await sc.from("event_rsvps").delete().eq("event_id", id).eq("user_id", userId);

  const going = await getGoingCount(sc, id);
  await sc.from("events").update({ going_count: going }).eq("id", id);
  await syncAttendee(sc, id, userId, null);

  // Promote BEFORE syncing state so the freed seat is reserved by an active
  // offer (see DELETE /rsvp) — otherwise syncEventState reopens to a walk-in.
  const waitlistEnabled = await isFlagEnabled(sc, "events_waitlist_enabled");
  if (waitlistEnabled) await promoteNextWaitlisted(sc, id);
  await syncEventState(sc, id);

  const { data: ev } = await sc.from("events").select("chat_thread_id").eq("id", id).maybeSingle();
  if ((ev as any)?.chat_thread_id) {
    await removeUserFromChatThread(sc, (ev as any).chat_thread_id, userId);
  }

  await logEventActivity(sc, id, user.id, "attendee_removed", { targetUserId: userId });

  res.json({ ok: true });
});

// ── POST /api/events/:id/join-request ─────────────────────────────────────────
// New canonical path (mirrors /requests which is kept for backwards compat)

router.post("/events/:id/join-request", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc.from("events").select("visibility, state, host_id, title").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }
  if ((ev as any).visibility !== "invite_only") { sendError(res, "forbidden", "This event does not require a join request"); return; }
  if (!["open","full","waitlist"].includes((ev as any).state)) { sendError(res, "forbidden", "Event is not accepting requests"); return; }

  const message = z.string().max(500).optional().parse(req.body.message);

  const { error } = await sc.from("event_join_requests").upsert(
    { event_id: id, user_id: user.id, status: "pending", message: message ?? null },
    { onConflict: "event_id,user_id", ignoreDuplicates: true },
  );
  if (error) { sendError(res, "db_error", error.message); return; }

  void (async () => {
    try {
      const { data: hp } = await sc.from("profiles").select("expo_push_token").eq("id", (ev as any).host_id).maybeSingle();
      if ((hp as any)?.expo_push_token) {
        await sendPushWithRetry(sc, { userId: (ev as any).host_id, tokens: [(hp as any).expo_push_token] }, {
          title: "New join request",
          body: `Someone wants to join "${(ev as any).title}"`,
          data: { eventId: id, type: "event_join_request" },
        });
      }
    } catch (err) {
      // resolves-not-throws-ok: fire-and-forget push — best-effort, logged.
      req.log?.warn({ err, eventId: id }, "join-request push notify failed");
    }
  })();

  res.status(201).json({ ok: true, status: "pending" });
});

// ── POST /api/events/:id/join-requests/:requestId/approve ────────────────────

router.post("/events/:id/join-requests/:requestId/approve", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, requestId } = req.params;
  if (!isUuid(id) || !isUuid(requestId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await canManageAttendance(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host/moderator can approve join requests"); return;
  }

  const { data: jr } = await sc.from("event_join_requests").select("*").eq("id", requestId).eq("event_id", id).maybeSingle();
  if (!jr) { sendError(res, "not_found", "Join request not found"); return; }
  if ((jr as any).status !== "pending") { sendError(res, "invalid_payload", "Request is no longer pending"); return; }

  const targetId = (jr as any).user_id;

  const { data: evFull } = await sc.from("events").select("*").eq("id", id).maybeSingle();
  if (!evFull) { sendError(res, "not_found", "Event not found"); return; }

  const approveElig = await checkEventEligibility(sc, evFull as any, targetId);
  if (!approveElig.ok) { sendError(res, approveElig.errorCode as any, `Cannot approve: ${approveElig.message}`); return; }

  await sc.from("event_join_requests").update({ status: "approved", reviewed_by: user.id, reviewed_at: new Date().toISOString() })
    .eq("id", requestId);

  const maxAtt = (evFull as any).max_attendees ?? null;
  const currentGoing = maxAtt != null ? await getGoingCount(sc, id) : 0;
  // Capacity is the OUTER condition; waitlist_enabled only selects WHICH
  // full-event outcome is returned. Both branches must return, because the
  // going-upsert below is unconditional: when these were ANDed, a full event
  // with waitlisting DISABLED fell through and seated an attendee past
  // max_attendees. The legacy sibling PATCH /events/:id/requests/:userId
  // already nests it this way.
  if (maxAtt != null && currentGoing >= maxAtt) {
    if ((evFull as any).waitlist_enabled) {
      const { data: existingWl } = await sc.from("event_waitlist").select("position").eq("event_id", id).eq("user_id", targetId).maybeSingle();
      if (!existingWl) {
        const { data: maxPos } = await sc.from("event_waitlist").select("position").eq("event_id", id)
          .order("position", { ascending: false }).limit(1).maybeSingle();
        const nextPos = ((maxPos as any)?.position ?? 0) + 1;
        await sc.from("event_waitlist").insert({ event_id: id, user_id: targetId, position: nextPos });
      }
      await logEventActivity(sc, id, user.id, "join_request_approved", { targetUserId: targetId, outcome: "waitlisted" });
      res.json({ ok: true, status: "waitlisted" }); return;
    }

    // Full, and the host turned waitlisting OFF. Not an error: the join-request
    // row was already flipped to approved above, and that approval is what lets
    // the user seat themselves via POST /events/:id/join once a slot frees, so
    // nothing is lost — a 4xx here would lie about state we have persisted.
    //
    // Deliberately NOT a waitlist row either. That would be worse than the
    // overbook it replaces: promoteNextWaitlisted is gated on the GLOBAL
    // events_waitlist_enabled flag, not this event's, so a fabricated row on an
    // event whose host disabled waitlisting would later receive a real offer.
    await logEventActivity(sc, id, user.id, "join_request_approved", { targetUserId: targetId, outcome: "pending_capacity" });
    res.json({ ok: true, status: "approved_pending_capacity" }); return;
  }

  await sc.from("event_rsvps").upsert(
    { event_id: id, user_id: targetId, status: "going", updated_at: new Date().toISOString() },
    { onConflict: "event_id,user_id" },
  );
  await syncEventState(sc, id);
  const going = await getGoingCount(sc, id);
  await sc.from("events").update({ going_count: going }).eq("id", id);
  await syncAttendee(sc, id, targetId, "going");

  await logEventActivity(sc, id, user.id, "join_request_approved", { targetUserId: targetId, outcome: "going" });

  res.json({ ok: true, status: "approved" });
});

// ── POST /api/events/:id/join-requests/:requestId/decline ─────────────────────

router.post("/events/:id/join-requests/:requestId/decline", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, requestId } = req.params;
  if (!isUuid(id) || !isUuid(requestId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await canManageAttendance(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host/moderator can decline join requests"); return;
  }

  const { data: jr } = await sc.from("event_join_requests").select("user_id, status").eq("id", requestId).eq("event_id", id).maybeSingle();
  if (!jr) { sendError(res, "not_found", "Join request not found"); return; }

  await sc.from("event_join_requests").update({ status: "denied", reviewed_by: user.id, reviewed_at: new Date().toISOString() }).eq("id", requestId);

  await logEventActivity(sc, id, user.id, "join_request_declined", { targetUserId: (jr as any).user_id });

  res.json({ ok: true });
});

// ── POST /api/events/:id/join-requests/:requestId/cancel ─────────────────────

router.post("/events/:id/join-requests/:requestId/cancel", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, requestId } = req.params;
  if (!isUuid(id) || !isUuid(requestId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: jr } = await sc.from("event_join_requests")
    .select("user_id, status").eq("id", requestId).eq("event_id", id).maybeSingle();
  if (!jr) { sendError(res, "not_found", "Join request not found"); return; }
  if ((jr as any).user_id !== user.id) { sendError(res, "forbidden", "Can only cancel your own request"); return; }
  if ((jr as any).status !== "pending") { sendError(res, "invalid_payload", "Only pending requests can be cancelled"); return; }

  await sc.from("event_join_requests").delete().eq("id", requestId);
  res.json({ ok: true });
});

// ── POST /api/events/:id/invite ───────────────────────────────────────────────

router.post("/events/:id/invite", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await isHostOrCoHost(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host or co-host can invite users"); return;
  }

  const inviteeId = z.string().uuid().parse(req.body.userId);

  if (inviteeId === user.id) { sendError(res, "invalid_payload", "Cannot invite yourself"); return; }

  if (await isBlocked(sc, user.id, inviteeId)) {
    sendError(res, "forbidden", "Cannot invite this user"); return;
  }

  const { data: invite, error } = await sc.from("event_invites")
    .upsert({ event_id: id, inviter_id: user.id, invitee_id: inviteeId, status: "pending", updated_at: new Date().toISOString() },
             { onConflict: "event_id,invitee_id" })
    .select("id, status").single();

  if (error) { req.log.error({ err: error }, "invite user"); sendError(res, "db_error", error.message); return; }

  void (async () => {
    try {
      const [evData, inviteeProfile, inviterProfile] = await Promise.all([
        sc.from("events").select("title").eq("id", id).maybeSingle(),
        sc.from("profiles").select("expo_push_token").eq("id", inviteeId).maybeSingle(),
        sc.from("profiles").select("handle").eq("id", user.id).maybeSingle(),
      ]);
      if ((inviteeProfile as any).data?.expo_push_token) {
        await sendPushWithRetry(sc, { userId: inviteeId, tokens: [(inviteeProfile as any).data.expo_push_token] }, {
          title: "You're invited!",
          // Privacy: do not expose the event name on the lock screen — the
          // invitee has not yet accepted and the event may be invite-only.
          // Full detail loads after the user opens the app and re-fetches.
          body: "You received an event invitation.",
          data: { eventId: id, type: "event_invite", inviteId: (invite as any).id },
        });
      }
      // In-app notification: store with generic text — no event name in params.
      // notifRouter.route() is intentionally NOT called here; push was already
      // sent above via sendPushWithRetry to avoid double-delivery.
      const { NotificationService } = await import("../services/notifications/NotificationService.js");
      const notifSvc = new NotificationService(sc);
      const inviterHandle = (inviterProfile as any).data?.handle;
      const actorName = inviterHandle ? `@${inviterHandle}` : "Someone";
      await notifSvc.create({
        userId:     inviteeId,
        eventType:  "event.invite_received",
        sourceType: "events",
        sourceId:   id,
        actorId:    user.id,
        // Privacy: params deliberately contain NO event title.
        params: { actor: actorName, eventId: id },
      });
    } catch {}
  })();

  await logEventActivity(sc, id, user.id, "user_invited", { inviteeId });

  res.status(201).json({ inviteId: (invite as any).id, status: "pending" });
});

// ── POST /api/events/:id/invites/:inviteId/accept ─────────────────────────────

router.post("/events/:id/invites/:inviteId/accept", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, inviteId } = req.params;
  if (!isUuid(id) || !isUuid(inviteId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: invite } = await sc.from("event_invites").select("*").eq("id", inviteId).eq("event_id", id).maybeSingle();
  if (!invite) { sendError(res, "not_found", "Invite not found"); return; }
  if ((invite as any).invitee_id !== user.id) { sendError(res, "forbidden", "This invite is not for you"); return; }
  if ((invite as any).status !== "pending") { sendError(res, "invalid_payload", "Invite is no longer pending"); return; }

  // Check eligibility BEFORE marking the invite as accepted — rejected users must
  // not receive an "accepted" outcome even if a previous invite exists.
  const { data: ev } = await sc.from("events").select("*").eq("id", id).maybeSingle();
  if (ev && ["open","full","waitlist"].includes((ev as any).state)) {
    const elig = await checkEventEligibility(sc, ev as any, user.id);
    if (!elig.ok) {
      sendError(res, elig.errorCode as any, `Cannot accept invite: ${elig.message}`);
      return;
    }
  }

  // Now safe to record acceptance
  await sc.from("event_invites").update({ status: "accepted", updated_at: new Date().toISOString() }).eq("id", inviteId);

  // Auto-RSVP as going — apply the same capacity/waitlist logic as POST /join
  if (ev && ["open","full","waitlist"].includes((ev as any).state)) {
    // Event is full — route to waitlist rather than over-accept
    if (["full","waitlist"].includes((ev as any).state)) {
      if (!(ev as any).waitlist_enabled) {
        // Invite accepted but event is full with no waitlist — just record acceptance, no RSVP
      } else {
        const { data: alreadyWaitlisted } = await sc
          .from("event_waitlist")
          .select("position")
          .eq("event_id", id)
          .eq("user_id", user.id)
          .maybeSingle();
        if (!alreadyWaitlisted) {
          const { data: maxPos } = await sc
            .from("event_waitlist")
            .select("position")
            .eq("event_id", id)
            .order("position", { ascending: false })
            .limit(1)
            .maybeSingle();
          const nextPos = ((maxPos as any)?.position ?? 0) + 1;
          await sc.from("event_waitlist").insert({ event_id: id, user_id: user.id, position: nextPos });
          await sc.from("events").update({ waitlist_count: nextPos }).eq("id", id);
        }
        res.json({ ok: true, status: "waitlisted" }); return;
      }
    } else {
      // Event is open — RSVP as going
      await sc.from("event_rsvps").upsert(
        { event_id: id, user_id: user.id, status: "going", updated_at: new Date().toISOString() },
        { onConflict: "event_id,user_id" },
      );
      await syncEventState(sc, id);
      const going = await getGoingCount(sc, id);
      await sc.from("events").update({ going_count: going }).eq("id", id);
      await syncAttendee(sc, id, user.id, "going");
    }
  }

  res.json({ ok: true, status: "accepted" });
});

// ── POST /api/events/:id/invites/:inviteId/decline ────────────────────────────

router.post("/events/:id/invites/:inviteId/decline", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, inviteId } = req.params;
  if (!isUuid(id) || !isUuid(inviteId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: invite } = await sc.from("event_invites").select("invitee_id, status").eq("id", inviteId).eq("event_id", id).maybeSingle();
  if (!invite) { sendError(res, "not_found", "Invite not found"); return; }
  if ((invite as any).invitee_id !== user.id) { sendError(res, "forbidden", "This invite is not for you"); return; }

  await sc.from("event_invites").update({ status: "declined", updated_at: new Date().toISOString() }).eq("id", inviteId);
  res.json({ ok: true });
});

// ── GET /api/events/:id/cohosts ───────────────────────────────────────────────

router.get("/events/:id/cohosts", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc.from("events").select("host_id, state").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  // Visible to host, co-hosts, and moderators only
  const role = await getEventRole(sc, id, user.id);
  const isStaff = role === "host" || role === "co_host" || role === "moderator";
  if (!isStaff) { sendError(res, "forbidden", "Only event staff can view co-hosts"); return; }

  const { data: cohosts, error } = await sc
    .from("event_cohosts")
    .select("user_id, permissions, added_by, added_at")
    .eq("event_id", id)
    .order("added_at", { ascending: true });

  if (error) { req.log.error({ err: error }, "get event cohosts"); sendError(res, "db_error", error.message); return; }
  res.json({ cohosts: cohosts ?? [] });
});

// ── POST /api/events/:id/cohosts ──────────────────────────────────────────────

router.post("/events/:id/cohosts", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const role = await getEventRole(sc, id, user.id);
  if (role !== "host") { sendError(res, "forbidden", "Only the host can add co-hosts"); return; }

  const parsed = z.object({
    userId:      z.string().uuid(),
    permissions: z.object({
      manage_rsvps:  z.boolean().default(true),
      manage_chat:   z.boolean().default(true),
      post_updates:  z.boolean().default(true),
    }).default({}),
  }).safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  const { userId: targetId, permissions } = parsed.data;
  if (targetId === user.id) { sendError(res, "invalid_payload", "Host cannot add themselves as co-host"); return; }

  // Upsert into event_cohosts and event_roles
  await sc.from("event_cohosts").upsert(
    { event_id: id, user_id: targetId, permissions, added_by: user.id, added_at: new Date().toISOString() },
    { onConflict: "event_id,user_id" },
  );
  await sc.from("event_roles").upsert(
    { event_id: id, user_id: targetId, role: "co_host" },
    { onConflict: "event_id,user_id" },
  );

  await logEventActivity(sc, id, user.id, "cohost_added", { targetUserId: targetId });

  res.status(201).json({ ok: true, userId: targetId, permissions });
});

// ── DELETE /api/events/:id/cohosts/:userId ────────────────────────────────────

router.delete("/events/:id/cohosts/:userId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, userId } = req.params;
  if (!isUuid(id) || !isUuid(userId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const role = await getEventRole(sc, id, user.id);
  if (role !== "host") { sendError(res, "forbidden", "Only the host can remove co-hosts"); return; }

  await sc.from("event_cohosts").delete().eq("event_id", id).eq("user_id", userId);
  await sc.from("event_roles").delete().eq("event_id", id).eq("user_id", userId);

  await logEventActivity(sc, id, user.id, "cohost_removed", { targetUserId: userId });

  res.json({ ok: true });
});

// ── PATCH /api/events/:id/cohosts/:userId/permissions ─────────────────────────

router.patch("/events/:id/cohosts/:userId/permissions", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, userId } = req.params;
  if (!isUuid(id) || !isUuid(userId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const role = await getEventRole(sc, id, user.id);
  if (role !== "host") { sendError(res, "forbidden", "Only the host can update co-host permissions"); return; }

  const permissions = z.object({
    manage_rsvps:  z.boolean().optional(),
    manage_chat:   z.boolean().optional(),
    post_updates:  z.boolean().optional(),
  }).parse(req.body.permissions ?? req.body);

  const { data: existing } = await sc.from("event_cohosts").select("permissions").eq("event_id", id).eq("user_id", userId).maybeSingle();
  if (!existing) { sendError(res, "not_found", "Co-host not found"); return; }

  const merged = { ...((existing as any).permissions ?? {}), ...permissions };

  const { error } = await sc.from("event_cohosts")
    .update({ permissions: merged })
    .eq("event_id", id).eq("user_id", userId);

  if (error) { req.log.error({ err: error }, "update cohost permissions"); sendError(res, "db_error", error.message); return; }

  res.json({ ok: true, userId, permissions: merged });
});

// ── POST /api/events/:id/save ─────────────────────────────────────────────────

router.post("/events/:id/save", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc.from("events").select("id, state").eq("id", id).maybeSingle();
  if (!ev || ["cancelled","archived"].includes((ev as any).state)) {
    sendError(res, "not_found", "Event not found"); return;
  }

  const { error } = await sc.from("event_saves")
    .upsert({ event_id: id, user_id: user.id, saved_at: new Date().toISOString() }, { onConflict: "event_id,user_id", ignoreDuplicates: true });

  if (error) { req.log.error({ err: error }, "save event"); sendError(res, "db_error", error.message); return; }

  res.status(201).json({ ok: true, saved: true });
});

// ── DELETE /api/events/:id/save ───────────────────────────────────────────────

router.delete("/events/:id/save", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  await sc.from("event_saves").delete().eq("event_id", id).eq("user_id", user.id);
  res.json({ ok: true, saved: false });
});

// ── POST /api/events/:id/share-link ───────────────────────────────────────────

router.post("/events/:id/share-link", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await isHostOrCoHost(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host or co-host can create share links"); return;
  }

  const parsed = z.object({
    maxUses:   z.number().int().positive().optional().nullable(),
    expiresAt: z.string().datetime().optional().nullable(),
  }).safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  const { data: link, error } = await sc.from("event_share_links").insert({
    event_id:   id,
    creator_id: user.id,
    max_uses:   parsed.data.maxUses ?? null,
    expires_at: parsed.data.expiresAt ?? null,
  }).select("id, token, max_uses, expires_at, use_count, created_at").single();

  if (error) { req.log.error({ err: error }, "create share link"); sendError(res, "db_error", error.message); return; }

  res.status(201).json(link);
});

// ── DELETE /api/events/:id/share-link/:linkId ─────────────────────────────────

router.delete("/events/:id/share-link/:linkId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, linkId } = req.params;
  if (!isUuid(id) || !isUuid(linkId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await isHostOrCoHost(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host or co-host can revoke share links"); return;
  }

  await sc.from("event_share_links").delete().eq("id", linkId).eq("event_id", id);
  res.json({ ok: true });
});

// ── GET /api/events/:id/posts ─────────────────────────────────────────────────

router.get("/events/:id/posts", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc.from("events").select("state, visibility, host_id").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  // Posts are participant-scoped: host/cohost or going/maybe attendees only.
  const role = await getEventRole(sc, id, user.id);
  const isStaff = role === "host" || role === "co_host";
  if (!isStaff) {
    const { data: rsvp } = await sc.from("event_rsvps").select("status")
      .eq("event_id", id).eq("user_id", user.id).maybeSingle();
    if (!rsvp || !["going","maybe"].includes((rsvp as any).status)) {
      sendError(res, "forbidden", "Posts are only visible to event participants"); return;
    }
  }

  const page   = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit  = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset = (page - 1) * limit;

  const { data: posts, error } = await sc.from("event_posts").select("*")
    .eq("event_id", id)
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { req.log.error({ err: error }, "get event posts"); sendError(res, "db_error", error.message); return; }

  const authorIds = [...new Set(((posts as any[]) ?? []).map((p: any) => p.author_id as string))];
  let authorMap: Record<string, any> = {};
  if (authorIds.length > 0) {
    const { data: profiles } = await sc.from("profiles").select("id, handle, name, avatar_url").in("id", authorIds);
    for (const p of (profiles as any[]) ?? []) authorMap[p.id as string] = p;
  }

  res.json({
    posts: ((posts as any[]) ?? []).map((p: any) => ({
      id:        p.id,
      body:      p.body,
      mediaUrls: p.media_urls ?? [],
      pinned:    p.pinned,
      createdAt: p.created_at,
      author: authorMap[p.author_id] ? {
        id:          p.author_id,
        handle:      authorMap[p.author_id].handle ?? null,
        displayName: authorMap[p.author_id].name ?? null,
        avatarUrl:   authorMap[p.author_id].avatar_url ?? null,
      } : null,
    })),
    page,
    limit,
  });
});

// ── POST /api/events/:id/posts ────────────────────────────────────────────────

router.post("/events/:id/posts", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc.from("events").select("state, host_id, attendee_comments_enabled").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  const isStaff = await isHostOrCoHost(sc, id, user.id);
  if (!isStaff) {
    // Attendees can only post if attendee_comments_enabled and they have a Going RSVP
    if (!(ev as any).attendee_comments_enabled) { sendError(res, "forbidden", "Posting is restricted to host/co-host"); return; }
    const { data: rsvp } = await sc.from("event_rsvps").select("status").eq("event_id", id).eq("user_id", user.id).maybeSingle();
    if ((rsvp as any)?.status !== "going") { sendError(res, "forbidden", "Only Going attendees can post"); return; }
  }

  const parsed = z.object({
    body:      z.string().min(1).max(2000),
    mediaUrls: z.array(z.string().url()).max(10).default([]),
    pinned:    z.boolean().default(false),
  }).safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  const { data: post, error } = await sc.from("event_posts").insert({
    event_id:   id,
    author_id:  user.id,
    body:       parsed.data.body,
    media_urls: parsed.data.mediaUrls,
    pinned:     parsed.data.pinned && isStaff,
  }).select("*").single();

  if (error) { req.log.error({ err: error }, "create event post"); sendError(res, "db_error", error.message); return; }

  res.status(201).json(post);
});

// ── GET /api/events/:id/media ─────────────────────────────────────────────────

router.get("/events/:id/media", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc.from("events").select("state, visibility, host_id").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  // Media is participant-scoped: host/cohost or going/maybe attendees only.
  const mediaRole = await getEventRole(sc, id, user.id);
  const isMediaStaff = mediaRole === "host" || mediaRole === "co_host";
  if (!isMediaStaff) {
    const { data: mediaRsvp } = await sc.from("event_rsvps").select("status")
      .eq("event_id", id).eq("user_id", user.id).maybeSingle();
    if (!mediaRsvp || !["going","maybe"].includes((mediaRsvp as any).status)) {
      sendError(res, "forbidden", "Media is only visible to event participants"); return;
    }
  }

  const page   = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit  = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset = (page - 1) * limit;

  const { data: media, error } = await sc.from("event_media").select("*")
    .eq("event_id", id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { req.log.error({ err: error }, "get event media"); sendError(res, "db_error", error.message); return; }

  res.json({ media: media ?? [], page, limit });
});

// ── POST /api/events/:id/media ────────────────────────────────────────────────

router.post("/events/:id/media", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc.from("events").select("state, host_id").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  // Must be going or staff to upload media
  const isStaff = await isHostOrCoHost(sc, id, user.id);
  if (!isStaff) {
    const { data: rsvp } = await sc.from("event_rsvps").select("status").eq("event_id", id).eq("user_id", user.id).maybeSingle();
    if ((rsvp as any)?.status !== "going") { sendError(res, "forbidden", "Only Going attendees can upload media"); return; }
  }

  // Emergency media kill switch (audit: this path previously ignored it).
  // Fail-CLOSED: an unreadable stop engages.
  if (await isKillSwitchEngaged(sc, "disable_media_uploads")) {
    sendError(res, "feature_disabled", "Media uploads are temporarily disabled");
    return;
  }

  const parsed = z.object({
    mediaUrl:  z.string().url(),
    mediaType: z.enum(["image","video"]).default("image"),
    caption:   z.string().max(500).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  // Audit security fix: previously ANY external URL was accepted here (hotlink/
  // tracker/other-user-object injection). Media must live in our own storage.
  if (!appStorageUrlInfo(parsed.data.mediaUrl)) {
    sendError(res, "invalid_payload", "mediaUrl must be an uploaded app media URL (use /api/media/upload first)");
    return;
  }

  const { data: item, error } = await sc.from("event_media").insert({
    event_id:    id,
    uploader_id: user.id,
    media_url:   parsed.data.mediaUrl,
    media_type:  parsed.data.mediaType,
    caption:     parsed.data.caption ?? null,
  }).select("*").single();

  if (error) { req.log.error({ err: error }, "upload event media"); sendError(res, "db_error", error.message); return; }

  res.status(201).json(item);
});

// ── GET /api/events/:id/comments ──────────────────────────────────────────────
// Alias: returns event_updates (public host/mod updates) for attendees/public

router.get("/events/:id/comments", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc.from("events").select("visibility, host_id, state").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  // Comments/updates are participant-scoped: host/cohost or going/maybe attendees only.
  const commRole = await getEventRole(sc, id, user.id);
  const isCommStaff = commRole === "host" || commRole === "co_host";
  if (!isCommStaff) {
    const { data: commRsvp } = await sc.from("event_rsvps").select("status")
      .eq("event_id", id).eq("user_id", user.id).maybeSingle();
    if (!commRsvp || !["going","maybe"].includes((commRsvp as any).status)) {
      sendError(res, "forbidden", "Comments are only visible to event participants"); return;
    }
  }

  const page   = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit  = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset = (page - 1) * limit;

  const { data: updates, error } = await sc.from("event_updates").select("*")
    .eq("event_id", id)
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { req.log.error({ err: error }, "get event comments"); sendError(res, "db_error", error.message); return; }

  res.json({ updates: updates ?? [], page, limit });
});

// ── POST /api/events/:id/comments ─────────────────────────────────────────────
// Host, co-hosts, and going attendees can post comments (stored as event_updates).

router.post("/events/:id/comments", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc
    .from("events")
    .select("host_id, state, attendee_comments_enabled")
    .eq("id", id)
    .maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  // Only host/cohosts or going attendees may post
  const role = await getEventRole(sc, id, user.id);
  const isHostOrCohost = role === "host" || role === "co_host";
  if (!isHostOrCohost) {
    if (!(ev as any).attendee_comments_enabled) {
      sendError(res, "forbidden", "Comments are disabled for this event"); return;
    }
    const { data: rsvp } = await sc
      .from("event_rsvps").select("status")
      .eq("event_id", id).eq("user_id", user.id).maybeSingle();
    if (!rsvp || (rsvp as any).status !== "going") {
      sendError(res, "forbidden", "Only going attendees can post comments"); return;
    }
  }

  const parsed = z.object({
    body:   z.string().min(1).max(1000),
    pinned: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  const { data: comment, error } = await sc.from("event_updates").insert({
    event_id:  id,
    author_id: user.id,
    body:      parsed.data.body,
    pinned:    isHostOrCohost ? (parsed.data.pinned ?? false) : false,
  }).select("*").single();

  if (error) { req.log.error({ err: error }, "post event comment"); sendError(res, "db_error", error.message); return; }

  await logEventActivity(sc, id, user.id, "comment_posted", {});

  res.status(201).json(comment);
});

// ── POST /api/events/:id/report ───────────────────────────────────────────────

router.post("/events/:id/report", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc.from("events").select("id").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  const parsed = z.object({
    reason: z.string().min(5).max(500),
    notes:  z.string().max(1000).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  const { error } = await sc.from("event_reports").insert({
    event_id:    id,
    reporter_id: user.id,
    report_type: "event",
    reason:      parsed.data.reason,
    notes:       parsed.data.notes ?? null,
  });

  if (error) {
    if (error.message.includes("unique") || error.code === "23505") {
      sendError(res, "duplicate_report", "You have already reported this event"); return;
    }
    req.log.error({ err: error }, "report event"); sendError(res, "db_error", error.message); return;
  }

  res.status(201).json({ ok: true, message: "Report submitted" });
});

// ── POST /api/events/:id/report-user/:userId ──────────────────────────────────

router.post("/events/:id/report-user/:userId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, userId } = req.params;
  if (!isUuid(id) || !isUuid(userId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (userId === user.id) { sendError(res, "invalid_payload", "Cannot report yourself"); return; }

  const { data: ev } = await sc.from("events").select("id").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  const parsed = z.object({
    reason: z.string().min(5).max(500),
    notes:  z.string().max(1000).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  const { error } = await sc.from("event_reports").insert({
    event_id:       id,
    reporter_id:    user.id,
    report_type:    "user",
    target_user_id: userId,
    reason:         parsed.data.reason,
    notes:          parsed.data.notes ?? null,
  });

  if (error) {
    if (error.message.includes("unique") || error.code === "23505") {
      sendError(res, "duplicate_report", "You have already reported this user in this event"); return;
    }
    req.log.error({ err: error }, "report user in event"); sendError(res, "db_error", error.message); return;
  }

  res.status(201).json({ ok: true, message: "Report submitted" });
});

// ── POST /api/events/:id/block-user/:userId ───────────────────────────────────

router.post("/events/:id/block-user/:userId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, userId } = req.params;
  if (!isUuid(id) || !isUuid(userId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await canManageAttendance(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host/moderator can block users from events"); return;
  }

  // Ban from event (set role to banned)
  await sc.from("event_roles").upsert(
    { event_id: id, user_id: userId, role: "banned" },
    { onConflict: "event_id,user_id" },
  );
  // Remove RSVP and waitlist
  await sc.from("event_rsvps").delete().eq("event_id", id).eq("user_id", userId);
  await sc.from("event_waitlist").delete().eq("event_id", id).eq("user_id", userId);

  await syncEventState(sc, id);
  const going = await getGoingCount(sc, id);
  const { data: wlAfter } = await sc.from("event_waitlist").select("user_id").eq("event_id", id);
  await sc.from("events").update({ going_count: going, waitlist_count: ((wlAfter as any[]) ?? []).length }).eq("id", id);
  await syncAttendee(sc, id, userId, null);

  await logEventActivity(sc, id, user.id, "user_blocked", { targetUserId: userId });

  res.json({ ok: true });
});

// ── GET /api/events/:id/activity ──────────────────────────────────────────────

router.get("/events/:id/activity", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await canManageAttendance(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host/moderator can view activity log"); return;
  }

  const page   = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit  = Math.min(100, Math.max(1, parseInt((req.query.limit as string) ?? "50")));
  const offset = (page - 1) * limit;

  const { data: activity, error } = await sc.from("event_activity_log").select("*")
    .eq("event_id", id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { req.log.error({ err: error }, "get event activity"); sendError(res, "db_error", error.message); return; }

  res.json({ activity: activity ?? [], page, limit });
});

// ── GET /api/events/:id/safety-summary ────────────────────────────────────────

router.get("/events/:id/safety-summary", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const role = await getEventRole(sc, id, user.id);
  if (role !== "host") {
    sendError(res, "forbidden", "Only the host can view the safety summary"); return;
  }

  const [reportRes, noShowRes, blockedRes] = await Promise.all([
    sc.from("event_reports").select("id, report_type, reason, status, created_at").eq("event_id", id),
    sc.from("event_attendee_states").select("user_id, no_show_at").eq("event_id", id).not("no_show_at", "is", null),
    sc.from("event_roles").select("user_id").eq("event_id", id).eq("role", "banned"),
  ]);

  res.json({
    eventId:      id,
    reports:      (reportRes as any).data ?? [],
    noShows:      (noShowRes as any).data ?? [],
    blockedUsers: ((blockedRes as any).data ?? []).map((r: any) => r.user_id),
    generatedAt:  new Date().toISOString(),
  });
});

// ── GET /api/events/:id/reminders ─────────────────────────────────────────────

router.get("/events/:id/reminders", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: reminders, error } = await sc.from("event_reminders").select("*")
    .eq("event_id", id).eq("user_id", user.id)
    .order("remind_at", { ascending: true });

  if (error) { req.log.error({ err: error }, "get reminders"); sendError(res, "db_error", error.message); return; }

  res.json({ reminders: reminders ?? [] });
});

// ── POST /api/events/:id/reminders ────────────────────────────────────────────

router.post("/events/:id/reminders", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc.from("events").select("id, state").eq("id", id).maybeSingle();
  if (!ev || ["cancelled","archived"].includes((ev as any).state)) {
    sendError(res, "not_found", "Event not found"); return;
  }

  const parsed = z.object({
    remindAt: z.string().datetime(),
    note:     z.string().max(200).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  if (new Date(parsed.data.remindAt) <= new Date()) {
    sendError(res, "invalid_payload", "remindAt must be in the future"); return;
  }

  const { data: reminder, error } = await sc.from("event_reminders").insert({
    event_id:  id,
    user_id:   user.id,
    remind_at: parsed.data.remindAt,
    note:      parsed.data.note ?? null,
  }).select("*").single();

  if (error) {
    if (error.message.includes("unique") || error.code === "23505") {
      sendError(res, "invalid_payload", "A reminder already exists at this time for this event"); return;
    }
    req.log.error({ err: error }, "create reminder"); sendError(res, "db_error", error.message); return;
  }

  res.status(201).json(reminder);
});

// ── PATCH /api/events/:id/reminders/:reminderId ───────────────────────────────

router.patch("/events/:id/reminders/:reminderId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, reminderId } = req.params;
  if (!isUuid(id) || !isUuid(reminderId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: existing } = await sc.from("event_reminders").select("user_id")
    .eq("id", reminderId).eq("event_id", id).maybeSingle();
  if (!existing) { sendError(res, "not_found", "Reminder not found"); return; }
  if ((existing as any).user_id !== user.id) { sendError(res, "forbidden", "Not your reminder"); return; }

  const parsed = z.object({
    remindAt: z.string().datetime().optional(),
    note:     z.string().max(200).nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  const patch: Record<string, any> = {};
  if (parsed.data.remindAt !== undefined) {
    if (new Date(parsed.data.remindAt) <= new Date()) {
      sendError(res, "invalid_payload", "remindAt must be in the future"); return;
    }
    patch.remind_at = parsed.data.remindAt;
  }
  if (parsed.data.note !== undefined) patch.note = parsed.data.note;

  const { data: updated, error } = await sc.from("event_reminders")
    .update(patch).eq("id", reminderId).select("*").single();

  if (error) { req.log.error({ err: error }, "update reminder"); sendError(res, "db_error", error.message); return; }

  res.json(updated);
});

// ── DELETE /api/events/:id/reminders/:reminderId ──────────────────────────────

router.delete("/events/:id/reminders/:reminderId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id, reminderId } = req.params;
  if (!isUuid(id) || !isUuid(reminderId)) { sendError(res, "invalid_payload", "Invalid ids"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: existing } = await sc.from("event_reminders").select("user_id")
    .eq("id", reminderId).eq("event_id", id).maybeSingle();
  if (!existing) { sendError(res, "not_found", "Reminder not found"); return; }
  if ((existing as any).user_id !== user.id) { sendError(res, "forbidden", "Not your reminder"); return; }

  await sc.from("event_reminders").delete().eq("id", reminderId);
  res.json({ ok: true });
});

// ── POST /api/events/:id/add-to-trip ─────────────────────────────────────────
// Adds the event to the caller's trip itinerary as a plan item.
// Body: { tripId }

router.post("/events/:id/add-to-trip", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const parsed = z.object({ tripId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", "tripId is required"); return; }
  const { tripId } = parsed.data;

  // Fetch the full event row so canViewEvent has all visibility/circle/trip fields
  const { data: ev } = await sc.from("events").select("*").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  // Enforce event visibility — caller must be permitted to see this event
  const canView = await canViewEvent(sc, ev as any, user.id);
  if (!canView) { sendError(res, "not_found", "Event not found"); return; }

  if (["cancelled", "archived"].includes((ev as any).state)) {
    sendError(res, "forbidden", "Cannot add a cancelled or archived event to a trip"); return;
  }

  // Verify user is an accepted trip member (owner or member)
  const { data: membership } = await sc.from("trip_members").select("role")
    .eq("trip_id", tripId).eq("user_id", user.id).maybeSingle();
  if (!membership || !["owner", "member"].includes((membership as any).role)) {
    sendError(res, "forbidden", "You must be an accepted trip member to add events"); return;
  }

  // Guard against duplicate: same source already in this trip
  const { data: existingItem } = await sc.from("trip_plan_items").select("id")
    .eq("trip_id", tripId).eq("source_type", "event").eq("source_id", id)
    .is("removed_at", null).maybeSingle();
  if (existingItem) {
    res.json({ planItemId: (existingItem as any).id, tripId, alreadyAdded: true }); return;
  }

  const e = ev as any;
  const { data: item, error: itemErr } = await sc.from("trip_plan_items").insert({
    trip_id:       tripId,
    title:         e.title ?? "Event",
    category:      "activity",
    status:        "tentative",
    source_type:   "event",
    source_id:     id,
    starts_at:     e.starts_at ?? null,
    ends_at:       e.ends_at ?? null,
    location_name: e.location_name ?? null,
    lat:           e.location_lat ?? null,
    lng:           e.location_lng ?? null,
    sort_order:    0,
  }).select("id, title, category, status, source_type, source_id, starts_at, ends_at, location_name, lat, lng").single();

  if (itemErr) { sendError(res, "db_error", itemErr.message); return; }

  const it = item as any;
  res.status(201).json({
    planItemId: it.id,
    tripId,
    itineraryItem: {
      id:           it.id,
      title:        it.title,
      category:     it.category,
      status:       it.status,
      sourceType:   it.source_type,
      sourceId:     it.source_id,
      startsAt:     it.starts_at,
      endsAt:       it.ends_at,
      locationName: it.location_name,
      lat:          it.lat,
      lng:          it.lng,
    },
  });
});

// ── POST /api/events/:id/link-circle ──────────────────────────────────────────
// Links the event to a travel circle.
// Body: { circleId, setCircleVisibility?: boolean }

router.post("/events/:id/link-circle", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const parsed = z.object({
    circleId:            z.string().uuid(),
    setCircleVisibility: z.boolean().optional().default(false),
  }).safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", "circleId is required"); return; }
  const { circleId, setCircleVisibility } = parsed.data;

  // Only the event host can link to a circle
  const role = await getEventRole(sc, id, user.id);
  if (role !== "host") {
    sendError(res, "forbidden", "Only the event host can link to a circle"); return;
  }

  // Caller must be a circle member
  const inCircle = await isCircleMember(sc, circleId, user.id);
  if (!inCircle) {
    sendError(res, "forbidden", "You must be a circle member to link this event"); return;
  }

  const patch: Record<string, any> = { circle_id: circleId, updated_at: new Date().toISOString() };
  if (setCircleVisibility) patch.visibility = "circle";

  const { error: patchErr } = await sc.from("events").update(patch).eq("id", id);
  if (patchErr) { sendError(res, "db_error", patchErr.message); return; }

  await logEventActivity(sc, id, user.id, "circle_linked", { circleId });

  res.json({ ok: true, circleId });
});

// ── POST /api/events/:id/telegraph-thread ─────────────────────────────────────
// Ensures an event group-chat thread exists, syncs Going attendees into it, and
// posts a pinned context card (title, date, city, visibility badge).
// Idempotent — safe to call multiple times.

router.post("/events/:id/telegraph-thread", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await isHostOrCoHost(sc, id, user.id)) {
    sendError(res, "forbidden", "Only host or co-host can manage the event chat"); return;
  }

  const { data: ev } = await sc.from("events")
    .select("title, state, host_id, chat_enabled, chat_thread_id, starts_at, city, visibility")
    .eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  if (!(ev as any).chat_enabled) {
    sendError(res, "forbidden", "Chat is not enabled for this event"); return;
  }

  // Ensure thread exists (idempotent)
  const threadId = await createEventChatThread(sc, id, (ev as any).title ?? "Event Chat", user.id);
  if (!threadId) { sendError(res, "db_error", "Failed to create event chat thread", { exposeDetail: true }); return; }

  // Sync all current Going attendees into the thread, skipping blocked users (fire-and-forget)
  void (async () => {
    try {
      const { data: goingRsvps } = await sc.from("event_rsvps").select("user_id")
        .eq("event_id", id).eq("status", "going");
      for (const r of (goingRsvps as any[]) ?? []) {
        const uid = (r as any).user_id as string;
        // Skip attendees who are blocking or blocked by the host
        if (await isBlocked(sc, (ev as any).host_id ?? user.id, uid)) continue;
        await addUserToChatThread(sc, threadId, uid);
      }
    } catch (err) {
      // Best-effort sync, but a silent failure leaves Going attendees out of the
      // event chat — log it (re-synced on the next open).
      req.log?.warn({ err, eventId: id, threadId }, "event chat attendee sync failed");
    }
  })();

  // Post a pinned context card if this thread was freshly created
  void (async () => {
    try {
      const { data: existing } = await sc.from("messages").select("id")
        .eq("thread_id", threadId).eq("msg_type", "system").eq("subtype", "event_context_card").limit(1).maybeSingle();
      if (!existing) {
        const e = ev as any;
        const lines = [
          `📍 **${e.title ?? "Event"}**`,
          e.starts_at ? `🗓 ${new Date(e.starts_at).toUTCString()}` : null,
          e.city ? `🏙 ${e.city}` : null,
          `🔒 ${e.visibility ?? "public"}`,
        ].filter(Boolean).join("\n");
        // Card payload lives inside body as JSON (same pattern as other system cards);
        // messages has no metadata column and sender_id is NOT NULL.
        const cardBody = JSON.stringify({
          type: "event_context_card",
          eventId: id,
          title: e.title ?? "Event",
          startsAt: e.starts_at ?? null,
          city: e.city ?? null,
          visibility: e.visibility ?? "public",
          text: lines,
        });
        const { error: cardErr } = await sc.from("messages").insert({
          thread_id: threadId,
          sender_id: e.host_id ?? user.id,
          body: cardBody,
          msg_type: "system",
          subtype: "event_context_card",
        });
        if (cardErr) {
          req.log?.warn({ err: cardErr, eventId: id, threadId }, "event context card insert failed");
        }
      }
    } catch (err) {
      // resolves-not-throws-ok: cosmetic system card — best-effort, logged.
      req.log?.warn({ err, eventId: id, threadId }, "event context card post failed");
    }
  })();

  await logEventActivity(sc, id, user.id, "telegraph_thread_ensured", { threadId });

  res.json({ threadId });
});

// ── GET /api/events/:id/agenda-items ─────────────────────────────────────────

router.get("/events/:id/agenda-items", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc.from("events").select("host_id").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  // Allow host/co-host and going/maybe RSVP'd attendees; 403 for outsiders
  const isStaff = await isHostOrCoHost(sc, id, user.id);
  if (!isStaff) {
    const { data: rsvp } = await sc
      .from("event_rsvps")
      .select("status")
      .eq("event_id", id)
      .eq("user_id", user.id)
      .in("status", ["going", "maybe"])
      .maybeSingle();
    if (!rsvp) {
      sendError(res, "forbidden", "Must be a host or going/maybe attendee to view agenda items");
      return;
    }
  }

  const { data: items, error } = await sc
    .from("event_agenda_items")
    .select("*")
    .eq("event_id", id)
    .order("created_at", { ascending: true });

  if (error) {
    req.log.error({ err: error }, "list event agenda items");
    sendError(res, "db_error", error.message);
    return;
  }

  res.json({ items: items ?? [] });
});

// ── POST /api/events/:id/agenda-items ────────────────────────────────────────

router.post("/events/:id/agenda-items", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc.from("events").select("state, host_id").eq("id", id).maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

  // Allow hosts/co-hosts and going/maybe attendees to add agenda items
  const isStaff = await isHostOrCoHost(sc, id, user.id);
  if (!isStaff) {
    const { data: rsvp } = await sc
      .from("event_rsvps")
      .select("status")
      .eq("event_id", id)
      .eq("user_id", user.id)
      .in("status", ["going", "maybe"])
      .maybeSingle();
    if (!rsvp) {
      sendError(res, "forbidden", "Must be a host or going/maybe attendee to add agenda items");
      return;
    }
  }

  const parsed = z.object({
    title:        z.string().min(1).max(200),
    locationName: z.string().max(300).optional(),
    locationLat:  z.number().optional(),
    locationLng:  z.number().optional(),
    placeId:      z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  const { data: item, error } = await sc.from("event_agenda_items").insert({
    event_id:      id,
    added_by:      user.id,
    title:         parsed.data.title,
    location_name: parsed.data.locationName ?? null,
    location_lat:  parsed.data.locationLat ?? null,
    location_lng:  parsed.data.locationLng ?? null,
    place_id:      parsed.data.placeId ?? null,
  }).select("*").single();

  if (error) {
    req.log.error({ err: error }, "create event agenda item");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(201).json(item);
});

// ── private helpers ───────────────────────────────────────────────────────────

/**
 * sendEventNotification — centralized push-notification helper for all 19 event
 * notification types. Fetches expo_push_tokens for the given recipient user IDs
 * and delivers the notification using the existing push infrastructure.
 *
 * Notification types: event_invite_received, event_join_request_received,
 * event_join_request_approved, event_join_request_declined, event_rsvp_accepted,
 * event_waitlist_change, event_updated, event_cancelled, event_postponed,
 * event_announcement, event_friend_joined, event_starting_soon, event_reminder,
 * event_attendee_removed, event_review_prompt, event_host_no_show,
 * event_attendee_no_show, event_completed, event_featured.
 */
async function sendEventNotification(
  sc: any,
  eventId: string,
  recipientUserIds: string[],
  notificationType: string,
  payload: { title: string; body: string; data?: Record<string, unknown> },
): Promise<void> {
  if (!recipientUserIds.length) return;
  try {
    const { data: profiles } = await sc
      .from("profiles")
      .select("id, expo_push_token")
      .in("id", recipientUserIds)
      .not("expo_push_token", "is", null);
    const recipients = ((profiles as any[]) ?? [])
      .map((p: any) => ({ userId: p.id as string, tokens: [p.expo_push_token as string] }))
      .filter((r: any) => r.tokens[0]);
    if (!recipients.length) return;
    await sendPushWithRetry(sc, recipients, {
      ...payload,
      data: { eventId, type: notificationType, ...payload.data },
    });
  } catch { /* non-fatal */ }
}

async function addUserToChatThread(sc: any, threadId: string, userId: string): Promise<void> {
  try {
    const { error } = await sc.from("message_thread_members").upsert(
      { thread_id: threadId, user_id: userId },
      { onConflict: "thread_id,user_id", ignoreDuplicates: true },
    );
    if (error) console.warn("addUserToChatThread upsert failed (non-fatal):", error.message ?? error);
  } catch (err) {
    console.warn("addUserToChatThread threw (non-fatal):", err);
  }
}

async function removeUserFromChatThread(sc: any, threadId: string, userId: string): Promise<void> {
  try {
    const { error } = await sc.from("message_thread_members").delete().eq("thread_id", threadId).eq("user_id", userId);
    if (error) console.warn("removeUserFromChatThread delete failed (non-fatal):", error.message ?? error);
  } catch (err) {
    console.warn("removeUserFromChatThread threw (non-fatal):", err);
  }
}

export default router;
