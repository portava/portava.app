/**
 * Events routes
 *
 * POST   /api/events                              — create event
 * GET    /api/events                              — list/discover events (paginated)
 * GET    /api/events/:id                          — get event detail
 * PATCH  /api/events/:id                          — update event (host/co_host only)
 * DELETE /api/events/:id                          — cancel / soft-delete
 *
 * POST   /api/events/:id/rsvp                     — upsert RSVP status
 * DELETE /api/events/:id/rsvp                     — leave event / cancel RSVP
 *
 * POST   /api/events/:id/waitlist                 — join waitlist
 * DELETE /api/events/:id/waitlist                 — leave waitlist
 *
 * POST   /api/events/:id/requests                 — request to join invite-only event
 * GET    /api/events/:id/requests                 — list join requests (host only)
 * PATCH  /api/events/:id/requests/:userId         — approve / deny join request
 *
 * POST   /api/events/:id/roles                    — assign role (host only)
 * DELETE /api/events/:id/roles/:userId            — remove role (host only)
 *
 * POST   /api/events/:id/checkin                  — attendee self check-in
 * POST   /api/events/:id/attendance/:userId       — host confirms attendance
 * POST   /api/events/:id/noshow/:userId           — host marks no-show
 *
 * POST   /api/events/:id/memory                   — convert completed event to shared memory
 * POST   /api/events/:id/chat/join                — join event Telegraph group chat
 * POST   /api/events/:id/updates                  — post host update / pin
 *
 * GET    /api/users/:userId/events                — events for a user profile tab
 */

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { sendPushNotification } from "../lib/push.js";
import { recordTrustEvent } from "../services/trust/TrustEventService.js";

const router = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;
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
    await sendPushNotification(
      [(profile as any).expo_push_token],
      { title: "A spot opened up!", body: "You're next on the waitlist. You have 24 hours to accept." },
    );
  }
}

// ── Shared eligibility check ──────────────────────────────────────────────────
// Used by RSVP, waitlist-join, and join-request-approval paths to prevent
// any user from joining through a back-door that bypasses server-side gates.

type EligibilityOk   = { ok: true };
type EligibilityFail = { ok: false; errorCode: string; message: string };

async function checkEventEligibility(
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
      const { data: profile } = await sc.from("profiles").select("is_verified").eq("id", userId).maybeSingle();
      if (!(profile as any)?.is_verified) {
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

/** Get push tokens for Going/Maybe RSVPs on an event */
async function getAttendeeTokens(sc: any, eventId: string): Promise<string[]> {
  const { data: rsvps } = await sc
    .from("event_rsvps")
    .select("user_id")
    .eq("event_id", eventId)
    .in("status", ["going", "maybe"]);

  const ids = ((rsvps as any[]) ?? []).map((r: any) => r.user_id as string);
  if (ids.length === 0) return [];

  const { data: profiles } = await sc
    .from("profiles")
    .select("expo_push_token")
    .in("id", ids)
    .not("expo_push_token", "is", null);

  return ((profiles as any[]) ?? [])
    .map((p: any) => p.expo_push_token as string)
    .filter(Boolean);
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
  maxAttendees:    z.number().int().positive().optional().nullable(),
  ageMin:          z.number().int().min(13).max(100).optional().nullable(),
  ageMax:          z.number().int().min(13).max(100).optional().nullable(),
  trustScoreMin:   z.number().min(0).max(100).optional().nullable(),
  verifiedOnly:    z.boolean().optional(),
  visibility:      z.enum(["public", "friends_only", "invite_only"]).default("public"),
  chatEnabled:     z.boolean().optional(),
  waitlistEnabled: z.boolean().optional(),
  priceType:       z.enum(["free", "external"]).optional(),
  priceUrl:        z.string().url().optional().nullable(),
  rsvpOptions:     z.array(z.enum(["going", "maybe", "interested", "cant_go"])).optional(),
  category:        z.string().max(60).optional(),
  city:            z.string().max(100).optional(),
  country:         z.string().max(100).optional(),
  publishNow:      z.boolean().optional(),
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
  maxAttendees:    z.number().int().positive().nullable().optional(),
  ageMin:          z.number().int().min(13).max(100).nullable().optional(),
  ageMax:          z.number().int().min(13).max(100).nullable().optional(),
  trustScoreMin:   z.number().min(0).max(100).nullable().optional(),
  verifiedOnly:    z.boolean().optional(),
  visibility:      z.enum(["public", "friends_only", "invite_only"]).optional(),
  state:           z.enum(["draft", "open", "started", "completed", "cancelled", "archived"]).optional(),
  chatEnabled:     z.boolean().optional(),
  waitlistEnabled: z.boolean().optional(),
  attendeeCommentsEnabled: z.boolean().optional(),
  priceType:       z.enum(["free", "external"]).nullable().optional(),
  priceUrl:        z.string().url().nullable().optional(),
  category:        z.string().max(60).nullable().optional(),
  city:            z.string().max(100).nullable().optional(),
  country:         z.string().max(100).nullable().optional(),
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
      cover_url:        b.coverUrl ?? null,
      max_attendees:    b.maxAttendees ?? null,
      age_min:          b.ageMin ?? null,
      age_max:          b.ageMax ?? null,
      trust_score_min:  b.trustScoreMin ?? null,
      verified_only:    b.verifiedOnly ?? false,
      visibility:       b.visibility,
      state:            initialState,
      chat_enabled:     b.chatEnabled ?? true,
      waitlist_enabled: b.waitlistEnabled ?? true,
      price_type:       b.priceType ?? null,
      price_url:        b.priceUrl ?? null,
      rsvp_options:     b.rsvpOptions ?? ["going", "maybe", "interested", "cant_go"],
      category:         b.category ?? null,
      city:             b.city ?? null,
      country:          b.country ?? null,
    })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "create event"); sendError(res, "db_error", error.message); return; }

  // Insert host role record
  await sc.from("event_roles").insert({ event_id: (ev as any).id, user_id: user.id, role: "host" }).then(undefined, () => {});

  // Create Telegraph group chat if enabled
  if (b.chatEnabled !== false && b.publishNow) {
    await createEventChatThread(sc, (ev as any).id, b.title, user.id);
  }

  res.status(201).json(formatEvent(ev as any, user.id));
});

// ── GET /api/events ───────────────────────────────────────────────────────────

router.get("/events", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const page   = Math.max(1, parseInt((req.query.page as string) ?? "1"));
  const limit  = Math.min(50, Math.max(1, parseInt((req.query.limit as string) ?? "20")));
  const offset = (page - 1) * limit;

  const state    = (req.query.state as string) ?? "open";
  const city     = (req.query.city as string) ?? null;
  const category = (req.query.category as string) ?? null;
  const dateFrom = (req.query.dateFrom as string) ?? null;
  const dateTo   = (req.query.dateTo as string) ?? null;

  let query = sc
    .from("events")
    .select("*")
    .in("state", state === "all" ? ["open","full","waitlist","started","completed"] : [state])
    .in("visibility", ["public", "friends_only"])
    .order("starts_at", { ascending: true, nullsFirst: false })
    .range(offset, offset + limit - 1);

  if (city)     query = query.ilike("city", `%${city}%`);
  if (category) query = query.eq("category", category);
  if (dateFrom) query = query.gte("starts_at", dateFrom);
  if (dateTo)   query = query.lte("starts_at", dateTo);

  const { data: events, error } = await query;

  if (error) { req.log.error({ err: error }, "list events"); sendError(res, "db_error", error.message); return; }

  // Filter out blocked, friends_only without friendship, and events viewer can't access
  const filtered: any[] = [];
  for (const ev of (events as any[]) ?? []) {
    const blocked = await isBlocked(sc, user.id, (ev as any).host_id);
    if (blocked) continue;
    if ((ev as any).visibility === "friends_only" && (ev as any).host_id !== user.id) {
      const { data: friendship } = await sc
        .from("user_friendships")
        .select("user_a")
        .or(`and(user_a.eq.${user.id},user_b.eq.${(ev as any).host_id}),and(user_b.eq.${user.id},user_a.eq.${(ev as any).host_id})`)
        .maybeSingle();
      if (!friendship) continue;
    }
    // Viewer eligibility gates (age / trust / verified) — hide ineligible events
    const listingElig = await checkEventEligibility(sc, ev as any, user.id);
    if (!listingElig.ok) continue;
    filtered.push(ev);
  }

  // Fetch user RSVPs for these events
  const eventIds = filtered.map((e: any) => e.id as string);
  let rsvpMap: Record<string, string> = {};
  if (eventIds.length > 0) {
    const { data: rsvps } = await sc
      .from("event_rsvps")
      .select("event_id, status")
      .eq("user_id", user.id)
      .in("event_id", eventIds);
    for (const r of (rsvps as any[]) ?? []) {
      rsvpMap[(r as any).event_id as string] = (r as any).status as string;
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

  res.json({
    events: filtered.map((ev: any) => ({
      ...formatEvent(ev, user.id),
      myRsvp:  rsvpMap[ev.id] ?? null,
      isSaved: savedEventIds.has(ev.id as string),
    })),
    page,
    limit,
  });
});

// ── GET /api/events/:id ───────────────────────────────────────────────────────

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

  // Visibility check
  if (!await canViewEvent(sc, ev as any, user.id)) {
    sendError(res, "not_found", "Event not found or access denied"); return;
  }

  // Block check
  if (await isBlocked(sc, user.id, (ev as any).host_id)) {
    sendError(res, "not_found", "Event not found or access denied"); return;
  }

  // Viewer eligibility gates (age / trust / verified) — same rules as RSVP
  const readElig = await checkEventEligibility(sc, ev as any, user.id);
  if (!readElig.ok) {
    sendError(res, "not_found", "Event not found or access denied"); return;
  }

  const [rsvpResult, waitlistResult, roleResult, attendeeResult, goingResult, hostResult] = await Promise.all([
    sc.from("event_rsvps").select("status").eq("event_id", id).eq("user_id", user.id).maybeSingle(),
    sc.from("event_waitlist").select("position, offer_expires_at").eq("event_id", id).eq("user_id", user.id).maybeSingle(),
    sc.from("event_roles").select("role").eq("event_id", id).eq("user_id", user.id).maybeSingle(),
    sc.from("event_attendee_states").select("*").eq("event_id", id).eq("user_id", user.id).maybeSingle(),
    sc.from("event_rsvps").select("user_id, status").eq("event_id", id).in("status", ["going", "maybe"]),
    sc.from("profiles").select("id, handle, name, avatar_url").eq("id", (ev as any).host_id).maybeSingle(),
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

  let goingProfiles: any[] = [];
  if (goingAvatars.length > 0) {
    const { data: gp } = await sc.from("profiles").select("id, handle, name, avatar_url").in("id", goingAvatars);
    goingProfiles = (gp as any[]) ?? [];
  }

  const { data: waitlistData } = await sc
    .from("event_waitlist")
    .select("user_id")
    .eq("event_id", id);
  const waitlistCount = ((waitlistData as any[]) ?? []).length;

  const hp = (hostResult as any).data;
  const host = hp ? {
    id: hp.id,
    handle: hp.handle ?? null,
    displayName: hp.name ?? null,
    avatarUrl: hp.avatar_url ?? null,
  } : null;

  const myRole = (ev as any).host_id === user.id ? "host" : ((roleResult as any).data?.role ?? null);

  res.json({
    ...formatEvent(ev as any, user.id),
    host,
    counts,
    waitlistCount,
    myRsvp: (rsvpResult as any).data?.status ?? null,
    myWaitlistPosition: (waitlistResult as any).data?.position ?? null,
    myWaitlistOfferExpiresAt: (waitlistResult as any).data?.offer_expires_at ?? null,
    myRole,
    myAttendanceState: (attendeeResult as any).data ?? null,
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

  const ok = await isHostOrCoHost(sc, id, user.id);
  if (!ok) { sendError(res, "forbidden", "Only host or co-host can edit this event"); return; }

  const parsed = UpdateEventSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

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
  if (b.coverUrl        !== undefined) patch.cover_url        = b.coverUrl;
  if (b.maxAttendees    !== undefined) patch.max_attendees    = b.maxAttendees;
  if (b.ageMin          !== undefined) patch.age_min          = b.ageMin;
  if (b.ageMax          !== undefined) patch.age_max          = b.ageMax;
  if (b.trustScoreMin   !== undefined) patch.trust_score_min  = b.trustScoreMin;
  if (b.verifiedOnly    !== undefined) patch.verified_only    = b.verifiedOnly;
  if (b.visibility      !== undefined) patch.visibility       = b.visibility;
  if (b.state           !== undefined) patch.state            = b.state;
  if (b.chatEnabled     !== undefined) patch.chat_enabled     = b.chatEnabled;
  if (b.waitlistEnabled !== undefined) patch.waitlist_enabled = b.waitlistEnabled;
  if (b.attendeeCommentsEnabled !== undefined) patch.attendee_comments_enabled = b.attendeeCommentsEnabled;
  if (b.priceType       !== undefined) patch.price_type       = b.priceType;
  if (b.priceUrl        !== undefined) patch.price_url        = b.priceUrl;
  if (b.category        !== undefined) patch.category         = b.category;
  if (b.city            !== undefined) patch.city             = b.city;
  if (b.country         !== undefined) patch.country          = b.country;

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
        const tokens = await getAttendeeTokens(sc, id);
        if (tokens.length > 0) {
          await sendPushNotification(tokens, {
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
          const tokens: string[] = (confirmed as any[])
            .map((r: any) => r.profiles?.expo_push_token)
            .filter(Boolean);

          const eventTitle = (updated as any).title ?? "your event";

          if (tokens.length > 0) {
            await sendPushNotification(tokens, {
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
                user_id:           r.user_id,
                actor_id:          user.id,
                notification_type: "review_prompt",
                content: {
                  entityType: "event",
                  entityId:   id,
                  entityName: eventTitle,
                },
                read: false,
              }),
            ),
          );
        }
      } catch {}
    })();
  }

  res.json(formatEvent(updated as any, user.id));
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

  await sc.from("events").update({ state: "cancelled", updated_at: new Date().toISOString() }).eq("id", id);

  // Notify all Going/Maybe attendees (fire-and-forget)
  void (async () => {
    try {
      const tokens = await getAttendeeTokens(sc, id);
      if (tokens.length > 0) {
        await sendPushNotification(tokens, {
          title: "Event cancelled",
          body: `"${(ev as any).title}" has been cancelled by the host.`,
          data: { eventId: id, type: "event_cancelled" },
        });
      }
    } catch {}
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

  // Update going_count + sync state
  await syncEventState(sc, id);
  const going = await getGoingCount(sc, id);
  await sc.from("events").update({ going_count: going }).eq("id", id);

  // Add to event chat thread if going and chat enabled
  if (status === "going" && (ev as any).chat_thread_id && (ev as any).chat_enabled) {
    await addUserToChatThread(sc, (ev as any).chat_thread_id, user.id);
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

  // Sync state and maybe promote waitlisted user
  await syncEventState(sc, id);
  const going = await getGoingCount(sc, id);
  await sc.from("events").update({ going_count: going }).eq("id", id);

  if ((existing as any).status === "going") {
    const waitlistEnabled = await isFlagEnabled(sc, "events_waitlist_enabled");
    if (waitlistEnabled) {
      await promoteNextWaitlisted(sc, id);
    }
  }

  res.json({ ok: true });
});

// ── POST /api/events/:id/waitlist ─────────────────────────────────────────────

router.post("/events/:id/waitlist", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: ev } = await sc
    .from("events")
    .select("state, waitlist_enabled, host_id, age_min, age_max, trust_score_min, verified_only")
    .eq("id", id)
    .maybeSingle();
  if (!ev) { sendError(res, "not_found", "Event not found"); return; }

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
      const { data: profileWl } = await sc.from("profiles").select("is_verified").eq("id", user.id).maybeSingle();
      if (!(profileWl as any)?.is_verified) {
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
      const ageYearsWl = Math.floor((Date.now() - dobWl.getTime()) / (1000 * 60 * 60 * 24 * 365.25));
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
  await sc.from("events").update({ waitlist_count: nextPos, updated_at: new Date().toISOString() }).eq("id", id);

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
  const { data: evCapCheck } = await sc.from("events").select("max_attendees").eq("id", id).maybeSingle();
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
  for (const p of (profiles as any[]) ?? []) profileMap[p.id as string] = p;

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
        await sendPushNotification([(hp as any).expo_push_token], {
          title: "New join request",
          body: `Someone wants to join "${(ev as any).title}"`,
          data: { eventId: id, type: "event_join_request" },
        });
      }
    } catch {}
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
    for (const p of (profiles as any[]) ?? []) {
      profileMap[p.id as string] = p;
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
        await sendPushNotification([(hp as any).expo_push_token], {
          title: action === "approve" ? "You're in! 🎉" : "Join request declined",
          body: action === "approve"
            ? `Your request to join "${(evData as any)?.title}" was approved.`
            : `Your request to join "${(evData as any)?.title}" was declined.`,
          data: { eventId: id, type: "event_request_decision", decision: action },
        });
      }
    } catch {}
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
  await sc.from("event_attendee_states").upsert(
    { event_id: id, user_id: userId, confirmed_at: now, confirmed_by: user.id, updated_at: now },
    { onConflict: "event_id,user_id" },
  );

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
    } catch {}
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
  await sc.from("event_attendee_states").upsert(
    { event_id: id, user_id: userId, no_show_at: now, no_show_by: user.id, updated_at: now },
    { onConflict: "event_id,user_id" },
  );

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
    } catch {}
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
  for (const p of profiles) profileMap[p.id] = p;

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
  if (!threadId) { sendError(res, "db_error", "Failed to create chat thread"); return; }

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
    .select("chat_thread_id, chat_enabled, state")
    .eq("id", id)
    .maybeSingle();

  if (!ev || !(ev as any).chat_thread_id) {
    sendError(res, "not_found", "Event chat not found"); return;
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

  await addUserToChatThread(sc, (ev as any).chat_thread_id, user.id);
  res.json({ threadId: (ev as any).chat_thread_id });
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
        const tokens = await getAttendeeTokens(sc, id);
        if (tokens.length > 0) {
          const { data: ev } = await sc.from("events").select("title").eq("id", id).maybeSingle();
          await sendPushNotification(tokens, {
            title: `Update: ${(ev as any)?.title ?? "Event"}`,
            body,
            data: { eventId: id, type: "event_update" },
          });
        }
      } catch {}
    })();
  }

  res.status(201).json(update);
});

// ── GET /api/users/:userId/events ─────────────────────────────────────────────

router.get("/users/:userId/events", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const { userId } = req.params;
  if (!isUuid(userId)) { sendError(res, "invalid_payload", "Invalid userId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const isOwnProfile = userId === user.id;

  // Events hosted by this user
  let query = sc
    .from("events")
    .select("*")
    .eq("host_id", userId)
    .order("starts_at", { ascending: false })
    .limit(20);

  if (!isOwnProfile) {
    query = query.not("state", "in", '("draft","cancelled","archived")');
  }

  const { data: hostedEvents } = await query;

  // Events they RSVPd to (Going only)
  const { data: rsvps } = await sc
    .from("event_rsvps")
    .select("event_id")
    .eq("user_id", userId)
    .eq("status", "going");

  const rsvpIds = ((rsvps as any[]) ?? []).map((r: any) => r.event_id as string);
  let attendedEvents: any[] = [];
  if (rsvpIds.length > 0) {
    const { data: ev } = await sc
      .from("events")
      .select("*")
      .in("id", rsvpIds)
      .not("state", "in", '("draft","cancelled")')
      .order("starts_at", { ascending: false })
      .limit(20);
    attendedEvents = (ev as any[]) ?? [];
  }

  res.json({
    hosted: ((hostedEvents as any[]) ?? []).map((e: any) => formatEvent(e, user.id)),
    attending: attendedEvents.map((e: any) => formatEvent(e, user.id)),
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatEvent(ev: any, viewerId: string) {
  return {
    id:               ev.id,
    hostId:           ev.host_id,
    title:            ev.title,
    description:      ev.description ?? null,
    locationName:     ev.location_name ?? null,
    locationLat:      ev.location_lat ?? null,
    locationLng:      ev.location_lng ?? null,
    startsAt:         ev.starts_at ?? null,
    endsAt:           ev.ends_at ?? null,
    coverUrl:         ev.cover_url ?? null,
    maxAttendees:     ev.max_attendees ?? null,
    ageMin:           ev.age_min ?? null,
    ageMax:           ev.age_max ?? null,
    trustScoreMin:    ev.trust_score_min ?? null,
    verifiedOnly:     ev.verified_only ?? false,
    visibility:       ev.visibility,
    state:            ev.state,
    chatEnabled:      ev.chat_enabled ?? true,
    chatThreadId:     ev.chat_thread_id ?? null,
    waitlistEnabled:  ev.waitlist_enabled ?? true,
    priceType:        ev.price_type ?? null,
    priceUrl:         ev.price_url ?? null,
    rsvpOptions:      ev.rsvp_options ?? ["going","maybe","interested","cant_go"],
    goingCount:       ev.going_count ?? 0,
    waitlistCount:    ev.waitlist_count ?? 0,
    category:         ev.category ?? null,
    city:             ev.city ?? null,
    country:          ev.country ?? null,
    isHost:           ev.host_id === viewerId,
    createdAt:        ev.created_at,
    updatedAt:        ev.updated_at,
  };
}

async function canViewEvent(sc: any, ev: any, userId: string): Promise<boolean> {
  if (ev.host_id === userId) return true;
  if (ev.visibility === "public") return !["draft", "cancelled", "archived"].includes(ev.state) || ev.host_id === userId;
  if (ev.visibility === "friends_only") {
    const { data: friendship } = await sc
      .from("user_friendships")
      .select("user_a")
      .or(`and(user_a.eq.${userId},user_b.eq.${ev.host_id}),and(user_b.eq.${userId},user_a.eq.${ev.host_id})`)
      .maybeSingle();
    if (friendship) return true;
  }
  // Invite-only: must have an RSVP, join request, or role
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
        type: "group",
        name: title,
        created_by: hostId,
        metadata: { event_id: eventId, type: "event_chat" },
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

  const { id } = req.params;
  if (!isUuid(id)) { sendError(res, "invalid_payload", "Invalid event id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

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
        displayName: r.profiles?.display_name ?? null,
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

// ── private helpers ───────────────────────────────────────────────────────────

async function addUserToChatThread(sc: any, threadId: string, userId: string): Promise<void> {
  try {
    await sc.from("message_thread_members").upsert(
      { thread_id: threadId, user_id: userId },
      { onConflict: "thread_id,user_id", ignoreDuplicates: true },
    );
  } catch {}
}

async function removeUserFromChatThread(sc: any, threadId: string, userId: string): Promise<void> {
  try {
    await sc.from("message_thread_members").delete().eq("thread_id", threadId).eq("user_id", userId);
  } catch {}
}

export default router;
