/**
 * Meetup routes
 *
 * POST   /api/meetups                            — create meetup
 * GET    /api/meetups/:meetupId                  — get meetup + invite counts
 * PATCH  /api/meetups/:meetupId                  — update (creator only)
 * DELETE /api/meetups/:meetupId                  — cancel (creator only)
 * POST   /api/meetups/:meetupId/invites          — invite users (creator only)
 * POST   /api/meetups/:meetupId/rsvp             — RSVP Going/Maybe/Declined
 * POST   /api/meetups/:meetupId/time-options     — add time slot (creator only)
 * POST   /api/meetups/:meetupId/time-options/:optionId/vote — vote yes/maybe/no
 * POST   /api/meetups/:meetupId/confirm-time     — confirm winning time (creator only)
 * POST   /api/meetups/:meetupId/add-to-trip-plan — add as trip plan item (idempotent)
 *
 * HARD RULES:
 *  - No lat/lng on meetups — text location_name only
 *  - creator_id always set from JWT
 *  - Visibility enforcement on every GET
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, isAcceptedTripMember, sendError, canEditPlan } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { enrichSpans } from "../lib/enrichSpans.js";
import { sendPushWithRetry } from "../lib/pushWithRetry.js";
import {
  getAgeEligibilityReason,
  formatAgeLimitLabel,
  validateAgeRange,
} from "../lib/ageEligibility.js";
import { nameVisibilitySet, nameVisibleFor } from "../lib/publicIdentity.js";
import { truncateDisplayName } from "../lib/displayName.js";

const router = Router();
const UUID = /^[0-9a-f-]{36}$/i;

// ── Frequent-invitee cache (per user, 1 h TTL) ────────────────────────────────
const FREQ_TTL_MS = 60 * 60 * 1_000;
interface FreqCacheEntry { data: FrequentInvitee[]; cachedAt: number; }
interface FrequentInvitee { id: string; handle: string; name: string; avatarUrl: string | null; count: number; }
const freqCache = new Map<string, FreqCacheEntry>();
function freqCacheFresh(e: FreqCacheEntry) { return Date.now() - e.cachedAt < FREQ_TTL_MS; }

// ── Visibility helper ─────────────────────────────────────────────────────────

async function canAccessMeetup(
  client: any,
  meetupId: string,
  userId: string,
): Promise<{ ok: boolean; meetup?: any }> {
  const { data: meetup } = await client
    .from("meetups")
    .select("*")
    .eq("id", meetupId)
    .maybeSingle();

  if (!meetup) return { ok: false };

  // Creator always has access
  if ((meetup as any).creator_id === userId) return { ok: true, meetup };

  // Direct invitee
  const { data: invite } = await client
    .from("meetup_invites")
    .select("id")
    .eq("meetup_id", meetupId)
    .eq("user_id", userId)
    .maybeSingle();
  if (invite) return { ok: true, meetup };

  // Trip-scoped
  if ((meetup as any).visibility === "trip" && (meetup as any).trip_id) {
    const ok = await isAcceptedTripMember(client, (meetup as any).trip_id, userId);
    if (ok) return { ok: true, meetup };
  }

  // Circle-scoped
  if ((meetup as any).visibility === "circle" && (meetup as any).circle_owner_id) {
    const ownerId = (meetup as any).circle_owner_id;
    if (userId === ownerId) return { ok: true, meetup };
    const { data: mem } = await client
      .from("circle_memberships")
      .select("other_id")
      .eq("user_id", ownerId)
      .eq("other_id", userId)
      .maybeSingle();
    if (mem) return { ok: true, meetup };
  }

  // Friends-scoped: any accepted friend of the creator can see
  if ((meetup as any).visibility === "friends") {
    const creatorId = (meetup as any).creator_id;
    const { data: friendship } = await client
      .from("user_friendships")
      .select("user_a")
      .or(
        `and(user_a.eq.${userId},user_b.eq.${creatorId}),` +
        `and(user_b.eq.${userId},user_a.eq.${creatorId})`,
      )
      .maybeSingle();
    if (friendship) return { ok: true, meetup };
  }

  return { ok: false };
}

// ── POST /api/meetups ─────────────────────────────────────────────────────────

const CreateMeetupSchema = z.object({
  title:        z.string().min(1).max(200),
  description:  z.string().max(1000).optional(),
  locationName: z.string().max(300).optional(),
  approximateDate: z.string().optional(), // YYYY-MM-DD
  timeBlock:    z.enum(["morning","afternoon","evening","late"]).optional(),
  startsAt:     z.string().optional(),    // ISO datetime when exact time is set
  tripId:       z.string().regex(UUID).optional(),
  circleOwnerId: z.string().regex(UUID).optional(),
  visibility:   z.enum(["invitees","trip","circle","friends"]).default("invitees"),
  inviteeIds:   z.array(z.string().regex(UUID)).optional(),
  ageLimitEnabled: z.boolean().optional(),
  minAge:       z.number().int().nullable().optional(),
  maxAge:       z.number().int().nullable().optional(),
});

router.post("/meetups", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  // Emergency flag: disable_new_event_creation — fail-open on DB error
  const flagSc = getServiceClient();
  if (flagSc && await isFlagEnabled(flagSc, 'disable_new_event_creation')) {
    sendError(res, 'feature_disabled', 'New event creation is temporarily disabled');
    return;
  }

  const parsed = CreateMeetupSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  // Gate on trip/circle membership when scope provided
  if (b.tripId) {
    const ok = await isAcceptedTripMember(client, b.tripId, user.id);
    if (!ok) { sendError(res, "not_member", "Must be accepted trip member to create a trip meetup"); return; }
  }
  if (b.circleOwnerId) {
    const isOwner = user.id === b.circleOwnerId;
    if (!isOwner) {
      const { data: mem } = await client
        .from("circle_memberships")
        .select("other_id")
        .eq("user_id", b.circleOwnerId)
        .eq("other_id", user.id)
        .maybeSingle();
      if (!mem) { sendError(res, "forbidden", "Must be circle member to create a circle meetup"); return; }
    }
  }

  // Validate age limit range when provided
  if (b.ageLimitEnabled) {
    const rangeErr = validateAgeRange(b.minAge, b.maxAge);
    if (rangeErr) { sendError(res, "invalid_payload", rangeErr); return; }
    if ((b.minAge == null) && (b.maxAge == null)) {
      sendError(res, "invalid_payload", "At least one of minAge or maxAge must be set when ageLimitEnabled is true");
      return;
    }
  }

  const { data: meetup, error } = await client
    .from("meetups")
    .insert({
      creator_id:        user.id,
      title:             b.title,
      description:       b.description ?? null,
      location_name:     b.locationName ?? null,
      approximate_date:  b.approximateDate ?? null,
      time_block:        b.startsAt ? null : (b.timeBlock ?? null),
      starts_at:         b.startsAt ?? null,
      trip_id:           b.tripId ?? null,
      circle_owner_id:   b.circleOwnerId ?? null,
      visibility:        b.visibility,
      status:            "active",
      age_limit_enabled: b.ageLimitEnabled ?? false,
      min_age:           b.ageLimitEnabled ? (b.minAge ?? null) : null,
      max_age:           b.ageLimitEnabled ? (b.maxAge ?? null) : null,
    })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "create meetup"); sendError(res, "db_error", error.message); return; }

  const meetupId = (meetup as any).id;

  // Bulk-invite if provided — apply same scope eligibility as /invites endpoint
  let inviteErrors: string[] = [];
  if (b.inviteeIds && b.inviteeIds.length > 0) {
    let candidateIds = b.inviteeIds.filter((id) => id !== user.id);

    // Trip-scoped: only accepted trip members may be invited
    if (b.tripId && candidateIds.length > 0) {
      const { data: tripMemberRows } = await client
        .from("trip_members")
        .select("user_id")
        .eq("trip_id", b.tripId)
        .in("role", ["owner", "member"])
        .in("user_id", candidateIds);
      const eligible = new Set((tripMemberRows ?? []).map((r: any) => r.user_id as string));
      candidateIds = candidateIds.filter((id) => eligible.has(id));
    }

    // Circle-scoped: only circle members (+ owner) may be invited
    if (b.circleOwnerId && !b.tripId && candidateIds.length > 0) {
      const { data: circleMemberRows } = await client
        .from("circle_memberships")
        .select("other_id")
        .eq("user_id", b.circleOwnerId)
        .in("other_id", candidateIds);
      const eligible = new Set([
        b.circleOwnerId,
        ...((circleMemberRows ?? []).map((r: any) => r.other_id as string)),
      ]);
      candidateIds = candidateIds.filter((id) => eligible.has(id));
    }

    // Plain meetup: only mutual friends of the creator may be invited
    if (!b.tripId && !b.circleOwnerId && candidateIds.length > 0) {
      const orParts = candidateIds.flatMap((id) => [
        `and(user_a.eq.${user.id},user_b.eq.${id})`,
        `and(user_b.eq.${user.id},user_a.eq.${id})`,
      ]).join(",");
      const { data: friendships } = await client
        .from("user_friendships")
        .select("user_a, user_b")
        .or(orParts);
      const friendSet = new Set(
        (friendships ?? [])
          .flatMap((f: any) => [f.user_a as string, f.user_b as string])
          .filter((id) => id !== user.id),
      );
      candidateIds = candidateIds.filter((id) => friendSet.has(id));
    }

    const inviteRows = candidateIds.map((uid) => ({ meetup_id: meetupId, user_id: uid }));
    if (inviteRows.length > 0) {
      const { error: iErr } = await client
        .from("meetup_invites")
        .insert(inviteRows);
      if (iErr) inviteErrors.push(iErr.message);
      else {
        await createMeetupInboxItems(client, meetupId, (meetup as any).title, inviteRows.map((r) => r.user_id), user.id);
      }
    }
  }

  // Post system message to chat thread if scoped to trip or circle
  if ((b.tripId || b.circleOwnerId) && !inviteErrors.length) {
    await postMeetupSystemMessage(client, meetupId, (meetup as any).title, b.tripId ?? null, b.circleOwnerId ?? null, user.id, {
      locationName: b.locationName ?? null,
      approximateDate: b.approximateDate ?? null,
      timeBlock: b.timeBlock ?? null,
    });
  }

  // Audit log: age limit set on creation (fire-and-forget)
  if (b.ageLimitEnabled) {
    const auditSc = getServiceClient();
    if (auditSc) {
      void (async () => {
        const { error: auditError } = await auditSc.from("age_limit_audit_log").insert({
          actor_user_id: user.id,
          target_type:   "meetup",
          target_id:     meetupId,
          action:        "age_limit_set",
          new_min_age:   b.minAge ?? null,
          new_max_age:   b.maxAge ?? null,
        });
        if (auditError) req.log.warn({ err: auditError }, "age limit audit insert failed (best-effort)");
      })();
    }
  }

  res.status(201).json({ ...(meetup as any), inviteErrors });
});

// ── GET /api/meetups/:meetupId ────────────────────────────────────────────────

router.get("/meetups/:meetupId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { meetupId } = req.params;
  if (!UUID.test(meetupId)) { sendError(res, "invalid_payload", "Invalid meetupId"); return; }

  const access = await canAccessMeetup(client, meetupId, user.id);
  if (!access.ok) { sendError(res, "not_found", "Meetup not found or access denied"); return; }

  const meetup = access.meetup!;

  // Fetch invite counts
  const { data: invites } = await client
    .from("meetup_invites")
    .select("user_id, status")
    .eq("meetup_id", meetupId);

  const counts = { going: 0, maybe: 0, declined: 0, pending: 0 };
  const goingIds: string[] = [];
  for (const inv of invites ?? []) {
    const s = (inv as any).status;
    if (s === "going") { counts.going++; if (goingIds.length < 4) goingIds.push((inv as any).user_id as string); }
    else if (s === "maybe") counts.maybe++;
    else if (s === "declined") counts.declined++;
    else counts.pending++;
  }

  // Fetch time options + vote counts
  const { data: options } = await client
    .from("meetup_time_options")
    .select("*")
    .eq("meetup_id", meetupId)
    .order("proposed_date", { ascending: true });

  const optionIds = (options ?? []).map((o: any) => o.id as string);
  let voteMap: Record<string, { yes: number; maybe: number; no: number; myVote: string | null }> = {};
  if (optionIds.length > 0) {
    const { data: votes } = await client
      .from("meetup_time_votes")
      .select("option_id, user_id, vote")
      .in("option_id", optionIds);

    for (const opt of options ?? []) {
      voteMap[(opt as any).id] = { yes: 0, maybe: 0, no: 0, myVote: null };
    }
    for (const v of votes ?? []) {
      const bucket = voteMap[(v as any).option_id];
      if (bucket) {
        const vote = (v as any).vote as string;
        if (vote === "yes") bucket.yes++;
        else if (vote === "maybe") bucket.maybe++;
        else if (vote === "no") bucket.no++;
        if ((v as any).user_id === user.id) bucket.myVote = vote;
      }
    }
  }

  // Own RSVP
  const { data: myInvite } = await client
    .from("meetup_invites")
    .select("status")
    .eq("meetup_id", meetupId)
    .eq("user_id", user.id)
    .maybeSingle();

  const isCreator = meetup.creator_id === user.id;

  // Fetch creator profile + going attendee profiles in parallel
  let creator: { id: string; handle: string | null; displayName: string | null; avatarUrl: string | null } | null = null;
  let goingAttendees: Array<{ id: string; handle: string | null; displayName: string | null; avatarUrl: string | null }> = [];
  const sc = getServiceClient();
  if (sc) {
    const [creatorResult, goingResult] = await Promise.all([
      sc.from("profiles").select("id, handle, name, avatar_url").eq("id", meetup.creator_id).maybeSingle(),
      goingIds.length > 0
        ? sc.from("profiles").select("id, handle, name, avatar_url").in("id", goingIds)
        : Promise.resolve({ data: [] }),
    ]);
    // Universal display-name rule: names default to hidden (@handle) unless the
    // subject opted in. Viewer always sees their own name.
    const allowedNames = await nameVisibilitySet(sc, [meetup.creator_id, ...goingIds]);
    if (creatorResult.data) {
      const cp = creatorResult.data as any;
      const cpAllowed = cp.id === user.id || allowedNames.has(cp.id);
      creator = { id: cp.id, handle: (cp.handle as string | null) ?? null, displayName: cpAllowed ? (cp.name ?? null) : null, avatarUrl: cp.avatar_url ?? null };
    }
    goingAttendees = ((goingResult as any).data ?? []).map((p: any) => ({
      id:          p.id as string,
      handle:      (p.handle as string | null) ?? null,
      displayName: (p.id === user.id || allowedNames.has(p.id)) ? ((p.name as string | null) ?? null) : null,
      avatarUrl:   (p.avatar_url as string | null) ?? null,
    }));
  }

  // Enrich meetup description with positioned @mention + #hashtag spans
  const descContent = meetup.description ?? '';
  const descSpans = (sc && descContent)
    ? (await enrichSpans(sc, 'meetup', [{ id: meetup.id, content: descContent }], user.id))[meetup.id]
    : { tags: [], hashtagUsages: [] };

  res.json({
    id:              meetup.id,
    creatorId:       meetup.creator_id,
    title:           meetup.title,
    description:     meetup.description ?? null,
    descriptionTags:     descSpans?.tags ?? [],
    descriptionHashtags: descSpans?.hashtagUsages ?? [],
    locationName:    meetup.location_name ?? null,
    approximateDate: meetup.approximate_date ?? null,
    timeBlock:       meetup.time_block ?? null,
    startsAt:        meetup.starts_at ?? null,
    endsAt:          meetup.ends_at ?? null,
    status:          meetup.status,
    tripId:          meetup.trip_id ?? null,
    circleOwnerId:   meetup.circle_owner_id ?? null,
    visibility:      meetup.visibility,
    chatThreadId:    meetup.chat_thread_id ?? null,
    chatMessageId:   meetup.chat_message_id ?? null,
    createdAt:       meetup.created_at,
    updatedAt:       meetup.updated_at,
    ageLimitEnabled: meetup.age_limit_enabled ?? false,
    minAge:          meetup.min_age ?? null,
    maxAge:          meetup.max_age ?? null,
    ageLimitLabel:   formatAgeLimitLabel(meetup.age_limit_enabled ?? false, meetup.min_age, meetup.max_age),
    counts,
    myRsvp:          (myInvite as any)?.status ?? null,
    isCreator,
    creator,
    goingAttendees,
    totalGoing:      counts.going,
    timeOptions:     (options ?? []).map((o: any) => ({
      id:            o.id,
      proposedDate:  o.proposed_date,
      proposedTime:  o.proposed_time ?? null,
      timeBlock:     o.time_block ?? null,
      label:         o.label ?? null,
      confirmed:     o.confirmed ?? false,
      votes:         voteMap[o.id] ?? { yes: 0, maybe: 0, no: 0, myVote: null },
    })),
  });
});

// ── PATCH /api/meetups/:meetupId ─────────────────────────────────────────────

const UpdateMeetupSchema = z.object({
  title:           z.string().min(1).max(200).optional(),
  description:     z.string().max(1000).nullable().optional(),
  locationName:    z.string().max(300).nullable().optional(),
  approximateDate: z.string().nullable().optional(),
  timeBlock:       z.enum(["morning","afternoon","evening","late"]).nullable().optional(),
  startsAt:        z.string().nullable().optional(),
  status:          z.enum(["draft","active","confirmed","cancelled"]).optional(),
  ageLimitEnabled: z.boolean().optional(),
  minAge:          z.number().int().nullable().optional(),
  maxAge:          z.number().int().nullable().optional(),
});

router.patch("/meetups/:meetupId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { meetupId } = req.params;
  if (!UUID.test(meetupId)) { sendError(res, "invalid_payload", "Invalid meetupId"); return; }

  const { data: meetup } = await client.from("meetups").select("creator_id").eq("id", meetupId).maybeSingle();
  if (!meetup) { sendError(res, "not_found", "Meetup not found"); return; }
  if ((meetup as any).creator_id !== user.id) { sendError(res, "forbidden", "Only the creator can edit this meetup"); return; }

  const parsed = UpdateMeetupSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  // Validate age limit range when provided
  if (b.ageLimitEnabled) {
    const rangeErr = validateAgeRange(b.minAge, b.maxAge);
    if (rangeErr) { sendError(res, "invalid_payload", rangeErr); return; }
    if ((b.minAge == null) && (b.maxAge == null)) {
      sendError(res, "invalid_payload", "At least one of minAge or maxAge must be set when ageLimitEnabled is true");
      return;
    }
  }

  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (b.title           !== undefined) patch.title            = b.title;
  if (b.description     !== undefined) patch.description      = b.description;
  if (b.locationName    !== undefined) patch.location_name    = b.locationName;
  if (b.approximateDate !== undefined) patch.approximate_date = b.approximateDate;
  if (b.timeBlock       !== undefined) patch.time_block       = b.timeBlock;
  if (b.startsAt        !== undefined) patch.starts_at        = b.startsAt;
  if (b.status          !== undefined) patch.status           = b.status;
  if (b.ageLimitEnabled !== undefined) {
    patch.age_limit_enabled = b.ageLimitEnabled;
    patch.min_age = b.ageLimitEnabled ? (b.minAge ?? null) : null;
    patch.max_age = b.ageLimitEnabled ? (b.maxAge ?? null) : null;
  }

  const { data: updated, error } = await client
    .from("meetups").update(patch).eq("id", meetupId).select("*").single();

  if (error) { req.log.error({ err: error }, "update meetup"); sendError(res, "db_error", error.message); return; }

  // Audit log: age limit updated (fire-and-forget)
  if (b.ageLimitEnabled !== undefined) {
    const auditSc = getServiceClient();
    if (auditSc) {
      void (async () => {
        const { error: auditError } = await auditSc.from("age_limit_audit_log").insert({
          actor_user_id: user.id,
          target_type:   "meetup",
          target_id:     meetupId,
          action:        b.ageLimitEnabled ? "age_limit_updated" : "age_limit_removed",
          new_min_age:   b.ageLimitEnabled ? (b.minAge ?? null) : null,
          new_max_age:   b.ageLimitEnabled ? (b.maxAge ?? null) : null,
        });
        if (auditError) req.log.warn({ err: auditError }, "age limit audit insert failed (best-effort)");
      })();
    }
  }

  res.json(toCamelMeetup(updated));
});

// ── DELETE /api/meetups/:meetupId ────────────────────────────────────────────

router.delete("/meetups/:meetupId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { meetupId } = req.params;
  if (!UUID.test(meetupId)) { sendError(res, "invalid_payload", "Invalid meetupId"); return; }

  const { data: meetup } = await client
    .from("meetups")
    .select("creator_id, title, trip_id, circle_owner_id")
    .eq("id", meetupId)
    .maybeSingle();
  if (!meetup) { sendError(res, "not_found", "Meetup not found"); return; }
  if ((meetup as any).creator_id !== user.id) { sendError(res, "forbidden", "Only the creator can cancel this meetup"); return; }

  const now = new Date().toISOString();
  const { error: cancelErr } = await client.from("meetups").update({ status: "cancelled", updated_at: now }).eq("id", meetupId);
  if (cancelErr) { req.log.error({ err: cancelErr }, "cancel meetup"); sendError(res, "db_error", cancelErr.message); return; }
  const { error: inviteCancelErr } = await client.from("meetup_invites").update({ status: "cancelled", updated_at: now }).eq("meetup_id", meetupId).eq("status", "pending");
  if (inviteCancelErr) { req.log.error({ err: inviteCancelErr }, "cancel meetup invites"); sendError(res, "db_error", inviteCancelErr.message); return; }

  // Post a system message to the linked chat thread (best-effort)
  postCancelSystemMessage(
    client,
    meetupId,
    (meetup as any).title as string,
    (meetup as any).trip_id as string | null,
    (meetup as any).circle_owner_id as string | null,
    user.id,
  ).catch(() => {});

  res.status(200).json({ status: "cancelled", meetupId });
});

// ── POST /api/meetups/:meetupId/invites ──────────────────────────────────────

const InviteSchema = z.object({
  userIds: z.array(z.string().regex(UUID)).min(1).max(50),
});

router.post("/meetups/:meetupId/invites", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { meetupId } = req.params;
  if (!UUID.test(meetupId)) { sendError(res, "invalid_payload", "Invalid meetupId"); return; }

  const { data: meetup } = await client
    .from("meetups")
    .select("creator_id, title, status, trip_id, circle_owner_id, visibility, age_limit_enabled, min_age, max_age")
    .eq("id", meetupId)
    .maybeSingle();
  if (!meetup) { sendError(res, "not_found", "Meetup not found"); return; }
  if ((meetup as any).creator_id !== user.id) { sendError(res, "forbidden", "Only the creator can invite users"); return; }
  if ((meetup as any).status === "cancelled") { sendError(res, "invalid_payload", "Cannot invite to a cancelled meetup"); return; }

  const parsed = InviteSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  let candidateIds = parsed.data.userIds.filter((id) => id !== user.id);
  if (candidateIds.length === 0) { res.json({ invited: [], skipped: [], ineligible: [] }); return; }

  // ── Enforce scope-based invite eligibility ────────────────────────────────
  let ineligible: string[] = [];
  const tripId = (meetup as any).trip_id as string | null;
  const circleOwnerId = (meetup as any).circle_owner_id as string | null;

  if (tripId) {
    // Only accepted trip members may be invited to a trip-scoped meetup
    const { data: tripMembers } = await client
      .from("trip_members")
      .select("user_id")
      .eq("trip_id", tripId)
      .in("role", ["owner", "member"])
      .in("user_id", candidateIds);
    const eligibleSet = new Set((tripMembers ?? []).map((r: any) => r.user_id as string));
    ineligible = candidateIds.filter((id) => !eligibleSet.has(id));
    candidateIds = candidateIds.filter((id) => eligibleSet.has(id));
  } else if (circleOwnerId) {
    // Only circle members (+ owner) may be invited to a circle-scoped meetup
    const { data: circleMembers } = await client
      .from("circle_memberships")
      .select("other_id")
      .eq("user_id", circleOwnerId)
      .in("other_id", candidateIds);
    const eligibleSet = new Set([
      circleOwnerId,
      ...((circleMembers ?? []).map((r: any) => r.other_id as string)),
    ]);
    ineligible = candidateIds.filter((id) => !eligibleSet.has(id));
    candidateIds = candidateIds.filter((id) => eligibleSet.has(id));
  } else {
    // Plain meetup (no trip/circle scope): only mutual friends of the creator may be invited
    const creatorId = (meetup as any).creator_id as string;
    if (candidateIds.length > 0) {
      const orParts = candidateIds.flatMap((id) => [
        `and(user_a.eq.${creatorId},user_b.eq.${id})`,
        `and(user_b.eq.${creatorId},user_a.eq.${id})`,
      ]).join(",");
      const { data: friendships } = await client
        .from("user_friendships")
        .select("user_a, user_b")
        .or(orParts);
      const friendSet = new Set(
        (friendships ?? [])
          .flatMap((f: any) => [f.user_a as string, f.user_b as string])
          .filter((id) => id !== creatorId),
      );
      ineligible = candidateIds.filter((id) => !friendSet.has(id));
      candidateIds = candidateIds.filter((id) => friendSet.has(id));
    }
  }

  if (candidateIds.length === 0 && ineligible.length > 0) {
    sendError(res, "forbidden", "None of the provided users are eligible to be invited (scope restriction)");
    return;
  }

  // Check for existing invites
  const { data: existing } = await client
    .from("meetup_invites").select("user_id").eq("meetup_id", meetupId).in("user_id", candidateIds);
  const alreadyInvited = new Set((existing ?? []).map((r: any) => r.user_id as string));
  const toInvite = candidateIds.filter((id) => !alreadyInvited.has(id));

  // ── Age pre-check: filter out age-ineligible invitees when meetup has age limit ──
  let ageIneligible: string[] = [];
  if ((meetup as any).age_limit_enabled && toInvite.length > 0) {
    const sc = getServiceClient();
    if (sc) {
      const { data: profiles } = await sc
        .from("profiles")
        .select("id, date_of_birth")
        .in("id", toInvite);
      const dobByUser: Record<string, string | null> = {};
      for (const row of profiles ?? []) {
        dobByUser[(row as any).id] = (row as any).date_of_birth ?? null;
      }
      const eligible: string[] = [];
      for (const uid of toInvite) {
        const dob = dobByUser[uid] ?? null;
        const result = getAgeEligibilityReason(dob, true, (meetup as any).min_age, (meetup as any).max_age);
        if (result.eligible) {
          eligible.push(uid);
        } else {
          ageIneligible.push(uid);
        }
      }
      toInvite.splice(0, toInvite.length, ...eligible);
    }
  }

  if (toInvite.length > 0) {
    const { error: inviteInsertErr } = await client.from("meetup_invites").insert(toInvite.map((uid) => ({ meetup_id: meetupId, user_id: uid })));
    if (inviteInsertErr) { req.log.error({ err: inviteInsertErr }, "insert meetup invites"); sendError(res, "db_error", inviteInsertErr.message); return; }
    await createMeetupInboxItems(client, meetupId, (meetup as any).title, toInvite, user.id);
  }

  res.json({ invited: toInvite, skipped: [...alreadyInvited], ineligible, ageIneligible });
});

// ── POST /api/meetups/:meetupId/rsvp ─────────────────────────────────────────

const RsvpSchema = z.object({
  status: z.enum(["going","maybe","declined"]),
});

router.post("/meetups/:meetupId/rsvp", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { meetupId } = req.params;
  if (!UUID.test(meetupId)) { sendError(res, "invalid_payload", "Invalid meetupId"); return; }

  const access = await canAccessMeetup(client, meetupId, user.id);
  if (!access.ok) { sendError(res, "not_found", "Meetup not found or access denied"); return; }
  const meetupRow = access.meetup as any;
  if (meetupRow.status === "cancelled") { sendError(res, "invalid_payload", "Cannot RSVP to a cancelled meetup"); return; }

  // Age eligibility check — only enforced when the invitee is trying to RSVP going/maybe
  const parsed = RsvpSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  if (meetupRow.age_limit_enabled && parsed.data.status !== "declined") {
    const sc = getServiceClient();
    if (sc) {
      const { data: profileRow } = await sc
        .from("profiles")
        .select("date_of_birth")
        .eq("id", user.id)
        .maybeSingle();
      const dob = (profileRow as any)?.date_of_birth ?? null;
      const eligibility = getAgeEligibilityReason(dob, true, meetupRow.min_age, meetupRow.max_age);
      if (!eligibility.eligible) {
        // Write audit log (best-effort)
        void (async () => {
          const { error: auditError } = await sc.from("age_limit_audit_log").insert({
            actor_user_id: user.id,
            target_type:   "meetup",
            target_id:     meetupId,
            action:        "rsvp_blocked",
            reason:        eligibility.reason,
          });
          if (auditError) req.log.warn({ err: auditError }, "age limit audit insert failed (best-effort)");
        })();
        res.status(403).json({
          error: "age_not_eligible",
          reason: eligibility.reason,
          message: eligibility.publicMessage,
        });
        return;
      }
    }
  }

  const now = new Date().toISOString();
  const { data, error } = await client
    .from("meetup_invites")
    .upsert({ meetup_id: meetupId, user_id: user.id, status: parsed.data.status, updated_at: now }, { onConflict: "meetup_id,user_id" })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "rsvp meetup"); sendError(res, "db_error", error.message); return; }

  // Get updated counts
  const { data: invites } = await client
    .from("meetup_invites").select("status").eq("meetup_id", meetupId);
  const counts = { going: 0, maybe: 0, declined: 0, pending: 0 };
  for (const inv of invites ?? []) {
    const s = (inv as any).status;
    if (s === "going") counts.going++;
    else if (s === "maybe") counts.maybe++;
    else if (s === "declined") counts.declined++;
    else counts.pending++;
  }

  res.json({ status: (data as any).status, meetupId, counts });
});

// ── POST /api/meetups/:meetupId/time-options ─────────────────────────────────

const TimeOptionSchema = z.object({
  proposedDate:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
  proposedTime:  z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Must be HH:MM or HH:MM:SS").optional(),
  timeBlock:     z.enum(["morning","afternoon","evening","late"]).optional(),
  label:         z.string().max(200).optional(),
});

router.post("/meetups/:meetupId/time-options", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { meetupId } = req.params;
  if (!UUID.test(meetupId)) { sendError(res, "invalid_payload", "Invalid meetupId"); return; }

  const { data: meetup } = await client.from("meetups").select("creator_id, status").eq("id", meetupId).maybeSingle();
  if (!meetup) { sendError(res, "not_found", "Meetup not found"); return; }
  if ((meetup as any).creator_id !== user.id) { sendError(res, "forbidden", "Only the creator can add time options"); return; }
  if ((meetup as any).status === "cancelled") { sendError(res, "invalid_payload", "Cannot add options to cancelled meetup"); return; }

  const parsed = TimeOptionSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  // Enforce server-side max of 5 time options per meetup
  const { count: existingCount } = await client
    .from("meetup_time_options")
    .select("*", { count: "exact", head: true })
    .eq("meetup_id", meetupId);
  if ((existingCount ?? 0) >= 5) {
    sendError(res, "invalid_payload", "Maximum 5 time options allowed per meetup");
    return;
  }

  const { data: option, error } = await client
    .from("meetup_time_options")
    .insert({
      meetup_id:     meetupId,
      proposed_date: b.proposedDate,
      proposed_time: b.proposedTime ?? null,
      time_block:    b.proposedTime ? null : (b.timeBlock ?? null),
      label:         b.label ?? null,
    })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "add time option"); sendError(res, "db_error", error.message); return; }

  res.status(201).json({
    id:           (option as any).id,
    meetupId,
    proposedDate: (option as any).proposed_date,
    proposedTime: (option as any).proposed_time ?? null,
    timeBlock:    (option as any).time_block ?? null,
    label:        (option as any).label ?? null,
    confirmed:    false,
    votes:        { yes: 0, maybe: 0, no: 0, myVote: null },
  });
});

// ── POST /api/meetups/:meetupId/time-options/:optionId/vote ──────────────────

const VoteSchema = z.object({
  vote: z.enum(["yes","maybe","no"]),
});

router.post("/meetups/:meetupId/time-options/:optionId/vote", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { meetupId, optionId } = req.params;
  if (!UUID.test(meetupId) || !UUID.test(optionId)) { sendError(res, "invalid_payload", "Invalid ID"); return; }

  const access = await canAccessMeetup(client, meetupId, user.id);
  if (!access.ok) { sendError(res, "not_found", "Meetup not found or access denied"); return; }

  const { data: option } = await client
    .from("meetup_time_options").select("id, meetup_id").eq("id", optionId).eq("meetup_id", meetupId).maybeSingle();
  if (!option) { sendError(res, "not_found", "Time option not found"); return; }

  const parsed = VoteSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  const { error } = await client
    .from("meetup_time_votes")
    .upsert({ option_id: optionId, user_id: user.id, vote: parsed.data.vote, voted_at: new Date().toISOString() }, { onConflict: "option_id,user_id" });

  if (error) { req.log.error({ err: error }, "vote time option"); sendError(res, "db_error", error.message); return; }

  // Return updated counts for this option
  const { data: votes } = await client
    .from("meetup_time_votes").select("user_id, vote").eq("option_id", optionId);

  const counts = { yes: 0, maybe: 0, no: 0, myVote: parsed.data.vote };
  for (const v of votes ?? []) {
    const vt = (v as any).vote;
    if (vt === "yes") counts.yes++;
    else if (vt === "maybe") counts.maybe++;
    else counts.no++;
  }

  res.json({ optionId, votes: counts });
});

// ── POST /api/meetups/:meetupId/confirm-time ─────────────────────────────────

const ConfirmTimeSchema = z.object({
  optionId: z.string().regex(UUID),
});

router.post("/meetups/:meetupId/confirm-time", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { meetupId } = req.params;
  if (!UUID.test(meetupId)) { sendError(res, "invalid_payload", "Invalid meetupId"); return; }

  const { data: meetup } = await client.from("meetups").select("creator_id, status, title, trip_id, circle_owner_id, location_name").eq("id", meetupId).maybeSingle();
  if (!meetup) { sendError(res, "not_found", "Meetup not found"); return; }
  if ((meetup as any).creator_id !== user.id) { sendError(res, "forbidden", "Only the creator can confirm the time"); return; }
  if ((meetup as any).status === "cancelled") { sendError(res, "invalid_payload", "Meetup is cancelled"); return; }

  const parsed = ConfirmTimeSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  const { data: option } = await client
    .from("meetup_time_options").select("*").eq("id", parsed.data.optionId).eq("meetup_id", meetupId).maybeSingle();
  if (!option) { sendError(res, "not_found", "Time option not found in this meetup"); return; }

  // Build starts_at: exact proposed_time takes priority over time_block
  const date = (option as any).proposed_date as string;
  const proposedTime = (option as any).proposed_time as string | null;
  const block = (option as any).time_block as string | null;
  let startsAt: string;
  if (proposedTime) {
    // proposedTime is HH:MM:SS from Postgres TIME column; normalise to HH:MM:00
    const [h = "00", m = "00"] = proposedTime.split(":");
    startsAt = `${date}T${h.padStart(2, "0")}:${m.padStart(2, "0")}:00`;
  } else {
    const blockHour: Record<string, number> = { morning: 9, afternoon: 13, evening: 18, late: 22 };
    const hour = block ? (blockHour[block] ?? 18) : 18;
    startsAt = `${date}T${String(hour).padStart(2, "0")}:00:00`;
  }

  const now = new Date().toISOString();
  // Clear any previously confirmed options for this meetup first (single winner)
  const { error: clearErr } = await client.from("meetup_time_options").update({ confirmed: false }).eq("meetup_id", meetupId).eq("confirmed", true);
  if (clearErr) { req.log.error({ err: clearErr }, "clear confirmed time options"); sendError(res, "db_error", clearErr.message); return; }
  const { error: confirmOptErr } = await client.from("meetup_time_options").update({ confirmed: true }).eq("id", parsed.data.optionId);
  if (confirmOptErr) { req.log.error({ err: confirmOptErr }, "confirm time option"); sendError(res, "db_error", confirmOptErr.message); return; }
  const { data: updated, error } = await client
    .from("meetups")
    .update({ starts_at: startsAt, status: "confirmed", updated_at: now })
    .eq("id", meetupId)
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "confirm time"); sendError(res, "db_error", error.message); return; }

  // Notify invitees via the trip/circle chat thread (best-effort)
  await postConfirmTimeSystemMessage(
    client,
    meetupId,
    (meetup as any).title as string,
    (meetup as any).trip_id as string | null,
    (meetup as any).circle_owner_id as string | null,
    user.id,
    startsAt,
    (meetup as any).location_name as string | null,
  ).catch(() => {});

  // Push-notify all Going/Maybe RSVPs (excluding the confirmer). Best-effort:
  // a push failure must never fail the confirm-time response.
  pushMeetupTimeConfirmed(
    meetupId,
    (meetup as any).title as string,
    user.id,
    startsAt,
  ).catch((err) => req.log.warn({ err }, "confirm-time push dispatch"));

  res.json({ startsAt, status: "confirmed", meetupId, meetup: toCamelMeetup(updated) });
});

// ── POST /api/meetups/:meetupId/add-to-trip-plan ─────────────────────────────

const AddToPlanSchema = z.object({
  tripId: z.string().regex(UUID, "tripId must be a valid UUID"),
  lockType: z.enum(["fixed", "flexible", "optional"]).default("flexible"),
});

router.post("/meetups/:meetupId/add-to-trip-plan", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { meetupId } = req.params;
  if (!UUID.test(meetupId)) { sendError(res, "invalid_payload", "Invalid meetupId"); return; }

  const parsed = AddToPlanSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const { tripId, lockType } = parsed.data;

  // Caller must have plan-edit permission on the target trip
  const canEdit = await canEditPlan(client, tripId, user.id);
  if (canEdit === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!canEdit) { sendError(res, "forbidden", "You do not have permission to add items to this trip's plan"); return; }

  const { data: meetup } = await client
    .from("meetups").select("id, title, starts_at, location_name, status, trip_id, visibility").eq("id", meetupId).maybeSingle();
  if (!meetup) { sendError(res, "not_found", "Meetup not found"); return; }

  // Enforce meetup-trip identity: a trip-scoped meetup may only be added to its own trip
  if ((meetup as any).trip_id && (meetup as any).trip_id !== tripId) {
    sendError(res, "forbidden", "This meetup is scoped to a different trip");
    return;
  }

  // Idempotent: skip if already added
  const { data: existing } = await client
    .from("trip_plan_items")
    .select("id")
    .eq("trip_id", tripId)
    .eq("source_type", "meetup")
    .eq("source_id", meetupId)
    .is("removed_at", null)
    .maybeSingle();

  if (existing) {
    res.status(200).json({ message: "already_added", planItemId: (existing as any).id, idempotent: true });
    return;
  }

  const { data: item, error } = await client
    .from("trip_plan_items")
    .insert({
      trip_id:       tripId,
      creator_id:    user.id,
      title:         (meetup as any).title,
      category:      "meeting_point",
      status:        "tentative",
      source_type:   "meetup",
      source_id:     meetupId,
      starts_at:     (meetup as any).starts_at ?? null,
      location_name: (meetup as any).location_name ?? null,
      sort_order:    0,
      visibility:    "members",
      lock_type:     lockType,
    })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "add meetup to trip plan"); sendError(res, "db_error", error.message); return; }

  res.status(201).json({ planItemId: (item as any).id, tripId, meetupId });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function toCamelMeetup(m: any) {
  return {
    id:              m.id,
    creatorId:       m.creator_id,
    title:           m.title,
    description:     m.description ?? null,
    locationName:    m.location_name ?? null,
    approximateDate: m.approximate_date ?? null,
    timeBlock:       m.time_block ?? null,
    startsAt:        m.starts_at ?? null,
    endsAt:          m.ends_at ?? null,
    status:          m.status,
    tripId:          m.trip_id ?? null,
    circleOwnerId:   m.circle_owner_id ?? null,
    visibility:      m.visibility,
    chatThreadId:    m.chat_thread_id ?? null,
    chatMessageId:   m.chat_message_id ?? null,
    createdAt:       m.created_at,
    updatedAt:       m.updated_at,
    ageLimitEnabled: m.age_limit_enabled ?? false,
    minAge:          m.min_age ?? null,
    maxAge:          m.max_age ?? null,
    ageLimitLabel:   formatAgeLimitLabel(m.age_limit_enabled ?? false, m.min_age, m.max_age),
  };
}

// Push-notify every Going/Maybe RSVP (excluding the confirmer) that the meetup
// time was locked in. Best-effort: never throws — all errors are logged by the
// caller. Users without an expo_push_token are silently skipped by sendPushNotification.
async function pushMeetupTimeConfirmed(
  meetupId: string,
  meetupTitle: string,
  confirmerId: string,
  startsAt: string,
): Promise<void> {
  const sc = getServiceClient();
  if (!sc) return;

  // RSVPs to notify: Going + Maybe, excluding the confirmer themselves.
  const { data: invites } = await sc
    .from("meetup_invites")
    .select("user_id, status")
    .eq("meetup_id", meetupId)
    .in("status", ["going", "maybe"]);

  const recipientIds = Array.from(
    new Set(
      (invites ?? [])
        .map((r: any) => r.user_id as string)
        .filter((id) => id && id !== confirmerId),
    ),
  );
  if (recipientIds.length === 0) return;

  const [{ data: tokenRows }, { data: confirmerProfile }] = await Promise.all([
    sc.from("profiles").select("id, expo_push_token").in("id", recipientIds),
    sc.from("profiles").select("name, handle").eq("id", confirmerId).maybeSingle(),
  ]);

  // Universal display-name rule: only interpolate the confirmer's real name
  // when they opted in; otherwise fall back to their @handle.
  const confirmerNameAllowed = await nameVisibleFor(sc, confirmerId);
  const confirmerHandle = (confirmerProfile as any)?.handle;
  const confirmerName = truncateDisplayName(
    (confirmerNameAllowed ? (confirmerProfile as any)?.name : null) ??
    (confirmerHandle ? `@${confirmerHandle}` : null) ??
    "The organizer");

  const when = formatMeetupWhen(startsAt);

  const recipients = (tokenRows ?? []).map((r: any) => ({
    userId: r.id as string,
    tokens: [r.expo_push_token as string | null],
  }));

  await sendPushWithRetry(sc, recipients, {
    title: `${confirmerName} confirmed a meetup time`,
    body: `${meetupTitle} — ${when}`,
    data: { screen: "meetup", meetupId },
  });
}

// Format a meetup starts_at (local naive ISO like "2026-06-25T18:00:00") into a
// short human-readable "Thu, Jun 25 · 6:00 PM" label for the push body.
function formatMeetupWhen(startsAt: string): string {
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return startsAt;
  const datePart = d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const timePart = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${datePart} · ${timePart}`;
}

async function postCancelSystemMessage(
  client: any,
  meetupId: string,
  title: string,
  tripId: string | null,
  circleOwnerId: string | null,
  creatorId: string,
): Promise<void> {
  let threadId: string | null = null;
  if (tripId) {
    const { data: thread } = await client
      .from("message_threads").select("id").eq("trip_id", tripId).eq("thread_type", "trip").maybeSingle();
    threadId = (thread as any)?.id ?? null;
  } else if (circleOwnerId) {
    const { data: thread } = await client
      .from("message_threads").select("id").eq("circle_owner_id", circleOwnerId).eq("thread_type", "circle").maybeSingle();
    threadId = (thread as any)?.id ?? null;
  }
  if (!threadId) return;

  const { data: profile } = await client
    .from("profiles").select("id, name, handle").eq("id", creatorId).maybeSingle();
  // Universal display-name rule: only use the creator's real name in the message
  // text when they opted in; otherwise fall back to their @handle.
  const nameAllowed = await nameVisibleFor(client, creatorId);
  const cHandle = (profile as any)?.handle;
  const creatorName: string = truncateDisplayName((nameAllowed ? (profile as any)?.name : null) ?? (cHandle ? `@${cHandle}` : null) ?? "Someone");
  const text = `${creatorName} cancelled the meetup: ${title}`;
  const body = JSON.stringify({ type: "meetup_cancelled", meetupId, title, creatorName, text });

  const { error: msgErr } = await client.from("messages").insert({
    thread_id: threadId,
    sender_id: creatorId,
    body,
    msg_type: "system",
    subtype: "meetup_cancelled",
  });
  // Best-effort: the cancel itself already succeeded — only log delivery failure.
  if (msgErr) console.warn("meetup cancel system message insert failed (best-effort):", msgErr.message ?? msgErr);
}

async function createMeetupInboxItems(
  client: any,
  meetupId: string,
  title: string,
  userIds: string[],
  creatorId: string,
): Promise<void> {
  // Insert a row into meetup_invites (already done by caller).
  // We also want to create a request inbox item — however, that table is
  // not generalised yet. We store the meetup invite itself and the mobile app
  // reads pending meetup_invites from GET /api/me/meetup-invites.
  // No separate inbox table row required — the count endpoint is extended.
  void meetupId; void title; void userIds; void creatorId;
}

async function postConfirmTimeSystemMessage(
  client: any,
  meetupId: string,
  title: string,
  tripId: string | null,
  circleOwnerId: string | null,
  creatorId: string,
  startsAt: string,
  locationName: string | null = null,
): Promise<void> {
  let threadId: string | null = null;
  if (tripId) {
    const { data: thread } = await client
      .from("message_threads")
      .select("id")
      .eq("trip_id", tripId)
      .eq("thread_type", "trip")
      .maybeSingle();
    threadId = (thread as any)?.id ?? null;
  } else if (circleOwnerId) {
    const { data: thread } = await client
      .from("message_threads")
      .select("id")
      .eq("circle_owner_id", circleOwnerId)
      .eq("thread_type", "circle")
      .maybeSingle();
    threadId = (thread as any)?.id ?? null;
  }
  if (!threadId) return;

  // Fetch creator's display name for the human-readable message
  const { data: profile } = await client
    .from("profiles")
    .select("id, name, handle")
    .eq("id", creatorId)
    .maybeSingle();
  // Universal display-name rule: only use the creator's real name when opted in.
  const nameAllowed = await nameVisibleFor(client, creatorId);
  const cHandle = (profile as any)?.handle;
  const creatorName: string = truncateDisplayName((nameAllowed ? (profile as any)?.name : null) ?? (cHandle ? `@${cHandle}` : null) ?? "Someone");

  const confirmedDate = new Date(startsAt).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
  const confirmedTime = new Date(startsAt).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit",
  });

  // Build human-readable text: "Andre confirmed the meetup: Dinner — Fri, Jun 20 at 6:00 PM — Ximending"
  const parts: string[] = [`${title} — ${confirmedDate} at ${confirmedTime}`];
  if (locationName) parts.push(locationName);
  const text = `${creatorName} confirmed the meetup: ${parts.join(" — ")}`;

  const body = JSON.stringify({
    type: "meetup_confirmed",
    meetupId,
    title,
    startsAt,
    locationName: locationName ?? undefined,
    creatorName,
    text,
  });

  const { error: confirmMsgErr } = await client
    .from("messages")
    .insert({ thread_id: threadId, sender_id: creatorId, body, msg_type: "system", subtype: "meetup_confirmed" });
  // Best-effort: the confirm itself already succeeded — only log delivery failure.
  if (confirmMsgErr) console.warn("meetup confirm system message insert failed (best-effort):", confirmMsgErr.message ?? confirmMsgErr);
}

async function postMeetupSystemMessage(
  client: any,
  meetupId: string,
  title: string,
  tripId: string | null,
  circleOwnerId: string | null,
  creatorId: string,
  extras: {
    locationName?: string | null;
    approximateDate?: string | null;
    timeBlock?: string | null;
  } = {},
): Promise<void> {
  // Resolve the chat thread
  let threadId: string | null = null;
  if (tripId) {
    const { data: thread } = await client
      .from("message_threads")
      .select("id")
      .eq("trip_id", tripId)
      .eq("thread_type", "trip")
      .maybeSingle();
    threadId = (thread as any)?.id ?? null;
  } else if (circleOwnerId) {
    const { data: thread } = await client
      .from("message_threads")
      .select("id")
      .eq("circle_owner_id", circleOwnerId)
      .eq("thread_type", "circle")
      .maybeSingle();
    threadId = (thread as any)?.id ?? null;
  }

  if (!threadId) return;

  // Fetch creator display name for the card
  const { data: profile } = await client
    .from("profiles")
    .select("id, name, handle")
    .eq("id", creatorId)
    .maybeSingle();
  // Universal display-name rule: only use the creator's real name when opted in;
  // otherwise fall back to their @handle.
  const nameAllowed = await nameVisibleFor(client, creatorId);
  const cHandle = (profile as any)?.handle;
  const plannedByName = (nameAllowed ? (profile as any)?.name : null) ?? (cHandle ? `@${cHandle}` : null) ?? null;

  const body = JSON.stringify({
    type: "meetup_card",
    meetupId,
    title,
    ...(extras.locationName   ? { locationName: extras.locationName }     : {}),
    ...(extras.approximateDate ? { approximateDate: extras.approximateDate } : {}),
    ...(extras.timeBlock       ? { timeBlock: extras.timeBlock }           : {}),
    ...(plannedByName          ? { plannedByName }                         : {}),
  });

  const { data: msg } = await client
    .from("messages")
    .insert({ thread_id: threadId, sender_id: creatorId, body, msg_type: "system", subtype: "meetup" })
    .select("id")
    .single();

  if (msg) {
    const { error: linkErr } = await client
      .from("meetups")
      .update({ chat_thread_id: threadId, chat_message_id: (msg as any).id })
      .eq("id", meetupId);
    // Best-effort backlink: the card is posted — only log a failed pointer write.
    if (linkErr) console.warn("meetup chat backlink update failed (best-effort):", linkErr.message ?? linkErr);
  }
}

// ── GET /api/me/meetups ───────────────────────────────────────────────────────
// All meetups where the caller is creator or invitee.
// ?filter=upcoming  — exclude cancelled (default)
// ?filter=past      — confirmed+past or cancelled only
// ?filter=all       — no status filter

router.get("/me/meetups", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const filter = (req.query.filter as string | undefined) ?? "upcoming";

  // Step 1: find meetup_ids where user is an invitee
  const { data: inviteRows, error: invErr } = await client
    .from("meetup_invites")
    .select("meetup_id, status")
    .eq("user_id", user.id);

  if (invErr) { sendError(res, "db_error", invErr.message); return; }

  const inviteStatusMap = new Map<string, string>();
  for (const row of inviteRows ?? []) {
    inviteStatusMap.set((row as any).meetup_id as string, (row as any).status as string);
  }
  const invitedIds = Array.from(inviteStatusMap.keys());

  // Step 2: fetch all relevant meetups
  let query: any;
  if (invitedIds.length > 0) {
    query = client
      .from("meetups")
      .select("*")
      .or(`creator_id.eq.${user.id},id.in.(${invitedIds.join(",")})`);
  } else {
    query = client.from("meetups").select("*").eq("creator_id", user.id);
  }

  const today = new Date().toISOString().split("T")[0];
  if (filter === "upcoming") {
    query = query.neq("status", "cancelled");
  } else if (filter === "past") {
    query = query.or(
      `status.eq.cancelled,and(status.eq.confirmed,approximate_date.lt.${today})`
    );
  }

  query = query.order("created_at", { ascending: false });

  const { data: meetups, error: mErr } = await query;
  if (mErr) { req.log.error({ err: mErr }, "get me/meetups"); sendError(res, "db_error", mErr.message); return; }

  const meetupList = meetups ?? [];
  if (meetupList.length === 0) { res.json({ meetups: [] }); return; }

  // Step 3: batch-fetch all invite rows for these meetups (counts + my RSVP)
  const meetupIds = meetupList.map((m: any) => m.id as string);
  const { data: allInvites } = await client
    .from("meetup_invites")
    .select("meetup_id, user_id, status")
    .in("meetup_id", meetupIds);

  const countMap: Record<string, { going: number; maybe: number; declined: number; pending: number }> = {};
  const myRsvpMap: Record<string, string> = {};
  for (const inv of allInvites ?? []) {
    const mid = (inv as any).meetup_id as string;
    if (!countMap[mid]) countMap[mid] = { going: 0, maybe: 0, declined: 0, pending: 0 };
    const s = (inv as any).status as string;
    if (s === "going") countMap[mid].going++;
    else if (s === "maybe") countMap[mid].maybe++;
    else if (s === "declined") countMap[mid].declined++;
    else countMap[mid].pending++;
    if ((inv as any).user_id === user.id) myRsvpMap[mid] = s;
  }

  const result = meetupList.map((m: any) => ({
    ...toCamelMeetup(m),
    isCreator:  m.creator_id === user.id,
    myRsvp:     myRsvpMap[m.id] ?? null,
    counts:     countMap[m.id] ?? { going: 0, maybe: 0, declined: 0, pending: 0 },
  }));

  res.json({ meetups: result });
});

// ── GET /api/me/meetup-invites ────────────────────────────────────────────────
// Pending meetup invites for the inbox badge + inbox list

router.get("/me/meetup-invites", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  // Fetch pending invites AND accepted invites whose meetup has since been confirmed
  const { data: invites } = await client
    .from("meetup_invites")
    .select("id, meetup_id, status, invited_at")
    .eq("user_id", user.id)
    .in("status", ["pending", "going", "maybe"])
    .order("invited_at", { ascending: false });

  if (!invites || invites.length === 0) { res.json({ invites: [] }); return; }

  const meetupIds = (invites as any[]).map((i) => i.meetup_id as string);
  const { data: meetups } = await client
    .from("meetups")
    .select("id, title, location_name, approximate_date, time_block, starts_at, creator_id, status")
    .in("id", meetupIds)
    .neq("status", "cancelled");

  const meetupMap: Record<string, any> = {};
  for (const m of meetups ?? []) meetupMap[m.id] = m;

  const creatorIds = [...new Set((meetups ?? []).map((m: any) => m.creator_id as string))];
  const { data: profiles } = await client.from("profiles").select("id, handle, name, avatar_url").in("id", creatorIds);
  // Universal display-name rule: creator real names default to hidden (@handle).
  const allowedNames = await nameVisibilitySet(client, creatorIds);
  const profileMap: Record<string, any> = {};
  for (const p of profiles ?? []) {
    const allowed = p.id === user.id || allowedNames.has(p.id);
    profileMap[p.id] = { ...p, name: allowed ? p.name : null };
  }

  const result = (invites as any[])
    .filter((i) => {
      const m = meetupMap[i.meetup_id];
      if (!m || m.status === "cancelled") return false;
      if (i.status === "pending") return true;
      // going / maybe → surface as confirmation notification only when meetup is confirmed
      return (i.status === "going" || i.status === "maybe") && m.status === "confirmed";
    })
    .map((i) => {
      const m = meetupMap[i.meetup_id];
      const creator = m ? profileMap[m.creator_id] : null;
      const kind: "invite" | "confirmation" = i.status === "pending" ? "invite" : "confirmation";
      return {
        inviteId:        i.id,
        meetupId:        i.meetup_id,
        status:          i.status,
        invitedAt:       i.invited_at,
        kind,
        meetup: m ? {
          id:              m.id,
          title:           m.title,
          locationName:    m.location_name ?? null,
          approximateDate: m.approximate_date ?? null,
          timeBlock:       m.time_block ?? null,
          startsAt:        m.starts_at ?? null,
          status:          m.status,
        } : null,
        creator: creator ? { id: creator.id, handle: creator.handle, name: creator.name, avatarUrl: creator.avatar_url ?? null } : null,
      };
    });

  res.json({ invites: result });
});

// ── GET /me/frequent-invitees ─────────────────────────────────────────────────
// Returns the top 3 users the caller has most often invited to their meetups.
// Result is cached per user for 1 hour (memory, resets on server restart).

router.get("/me/frequent-invitees", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const cached = freqCache.get(user.id);
  if (cached && freqCacheFresh(cached)) {
    res.json({ invitees: cached.data });
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Step 1: get all meetup IDs the caller created
  const { data: meetupRows, error: meetupErr } = await sc
    .from("meetups")
    .select("id")
    .eq("creator_id", user.id);

  if (meetupErr) { sendError(res, "db_error", meetupErr.message); return; }
  if (!meetupRows || meetupRows.length === 0) {
    res.json({ invitees: [] });
    return;
  }

  const meetupIds = meetupRows.map((r: any) => r.id as string);

  // Step 2: get all invite rows for those meetups (excluding the caller)
  const { data: inviteRows, error: invErr } = await sc
    .from("meetup_invites")
    .select("user_id")
    .in("meetup_id", meetupIds)
    .neq("user_id", user.id);

  if (invErr) { sendError(res, "db_error", invErr.message); return; }
  if (!inviteRows || inviteRows.length === 0) {
    freqCache.set(user.id, { data: [], cachedAt: Date.now() });
    res.json({ invitees: [] });
    return;
  }

  // Step 3: aggregate counts in JS — top 3
  const countMap = new Map<string, number>();
  for (const r of inviteRows) {
    const uid = (r as any).user_id as string;
    countMap.set(uid, (countMap.get(uid) ?? 0) + 1);
  }

  const top3 = [...countMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, count]) => ({ id, count }));

  // Step 4: fetch profiles for those 3
  const { data: profiles, error: profErr } = await sc
    .from("profiles")
    .select("id, handle, name, avatar_url")
    .in("id", top3.map((e) => e.id));

  if (profErr) { sendError(res, "db_error", profErr.message); return; }

  // Universal display-name rule: invitee real names default to hidden (@handle).
  const allowedNames = await nameVisibilitySet(sc, top3.map((e) => e.id));

  const profileMap = new Map((profiles ?? []).map((p: any) => [p.id as string, p]));

  const invitees: FrequentInvitee[] = top3
    .map(({ id, count }) => {
      const p = profileMap.get(id);
      if (!p) return null;
      const allowed = p.id === user.id || allowedNames.has(p.id);
      return {
        id: p.id as string,
        handle: p.handle as string,
        name: (allowed ? p.name : null) as string,
        avatarUrl: (p.avatar_url as string | null) ?? null,
        count,
      };
    })
    .filter((x): x is FrequentInvitee => x !== null);

  freqCache.set(user.id, { data: invitees, cachedAt: Date.now() });
  res.json({ invitees });
});

export default router;
