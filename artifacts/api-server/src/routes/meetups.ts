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
import { requireUser, isAcceptedTripMember, sendError } from "../lib/http.js";

const router = Router();
const UUID = /^[0-9a-f-]{36}$/i;

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
      .select("member_id")
      .eq("owner_id", ownerId)
      .eq("member_id", userId)
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
  tripId:       z.string().regex(UUID).optional(),
  circleOwnerId: z.string().regex(UUID).optional(),
  visibility:   z.enum(["invitees","trip","circle","friends"]).default("invitees"),
  inviteeIds:   z.array(z.string().regex(UUID)).optional(),
});

router.post("/meetups", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

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
        .select("member_id")
        .eq("owner_id", b.circleOwnerId)
        .eq("member_id", user.id)
        .maybeSingle();
      if (!mem) { sendError(res, "forbidden", "Must be circle member to create a circle meetup"); return; }
    }
  }

  const { data: meetup, error } = await client
    .from("meetups")
    .insert({
      creator_id:       user.id,
      title:            b.title,
      description:      b.description ?? null,
      location_name:    b.locationName ?? null,
      approximate_date: b.approximateDate ?? null,
      time_block:       b.timeBlock ?? null,
      trip_id:          b.tripId ?? null,
      circle_owner_id:  b.circleOwnerId ?? null,
      visibility:       b.visibility,
      status:           "active",
    })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "create meetup"); sendError(res, "db_error", error.message); return; }

  const meetupId = (meetup as any).id;

  // Bulk-invite if provided
  let inviteErrors: string[] = [];
  if (b.inviteeIds && b.inviteeIds.length > 0) {
    const inviteRows = b.inviteeIds
      .filter((id) => id !== user.id)
      .map((uid) => ({ meetup_id: meetupId, user_id: uid }));
    if (inviteRows.length > 0) {
      const { error: iErr } = await client
        .from("meetup_invites")
        .insert(inviteRows);
      if (iErr) inviteErrors.push(iErr.message);
      else {
        // Create inbox items for each invitee
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
  for (const inv of invites ?? []) {
    const s = (inv as any).status;
    if (s === "going") counts.going++;
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

  res.json({
    id:              meetup.id,
    creatorId:       meetup.creator_id,
    title:           meetup.title,
    description:     meetup.description ?? null,
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
    counts,
    myRsvp:          (myInvite as any)?.status ?? null,
    isCreator,
    timeOptions:     (options ?? []).map((o: any) => ({
      id:            o.id,
      proposedDate:  o.proposed_date,
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
  status:          z.enum(["draft","active","confirmed","cancelled"]).optional(),
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

  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (b.title           !== undefined) patch.title            = b.title;
  if (b.description     !== undefined) patch.description      = b.description;
  if (b.locationName    !== undefined) patch.location_name    = b.locationName;
  if (b.approximateDate !== undefined) patch.approximate_date = b.approximateDate;
  if (b.timeBlock       !== undefined) patch.time_block       = b.timeBlock;
  if (b.status          !== undefined) patch.status           = b.status;

  const { data: updated, error } = await client
    .from("meetups").update(patch).eq("id", meetupId).select("*").single();

  if (error) { req.log.error({ err: error }, "update meetup"); sendError(res, "db_error", error.message); return; }

  res.json(toCamelMeetup(updated));
});

// ── DELETE /api/meetups/:meetupId ────────────────────────────────────────────

router.delete("/meetups/:meetupId", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { meetupId } = req.params;
  if (!UUID.test(meetupId)) { sendError(res, "invalid_payload", "Invalid meetupId"); return; }

  const { data: meetup } = await client.from("meetups").select("creator_id").eq("id", meetupId).maybeSingle();
  if (!meetup) { sendError(res, "not_found", "Meetup not found"); return; }
  if ((meetup as any).creator_id !== user.id) { sendError(res, "forbidden", "Only the creator can cancel this meetup"); return; }

  const now = new Date().toISOString();
  await client.from("meetups").update({ status: "cancelled", updated_at: now }).eq("id", meetupId);
  // Mark all pending invites as cancelled
  await client.from("meetup_invites").update({ status: "cancelled", updated_at: now }).eq("meetup_id", meetupId).eq("status", "pending");

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
    .select("creator_id, title, status, trip_id, circle_owner_id, visibility")
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
      .select("member_id")
      .eq("owner_id", circleOwnerId)
      .in("member_id", candidateIds);
    const eligibleSet = new Set([
      circleOwnerId,
      ...((circleMembers ?? []).map((r: any) => r.member_id as string)),
    ]);
    ineligible = candidateIds.filter((id) => !eligibleSet.has(id));
    candidateIds = candidateIds.filter((id) => eligibleSet.has(id));
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

  if (toInvite.length > 0) {
    await client.from("meetup_invites").insert(toInvite.map((uid) => ({ meetup_id: meetupId, user_id: uid })));
    await createMeetupInboxItems(client, meetupId, (meetup as any).title, toInvite, user.id);
  }

  res.json({ invited: toInvite, skipped: [...alreadyInvited], ineligible });
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
  if ((access.meetup as any).status === "cancelled") { sendError(res, "invalid_payload", "Cannot RSVP to a cancelled meetup"); return; }

  const parsed = RsvpSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

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
  proposedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
  timeBlock:    z.enum(["morning","afternoon","evening","late"]).optional(),
  label:        z.string().max(200).optional(),
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

  const { data: option, error } = await client
    .from("meetup_time_options")
    .insert({ meetup_id: meetupId, proposed_date: b.proposedDate, time_block: b.timeBlock ?? null, label: b.label ?? null })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "add time option"); sendError(res, "db_error", error.message); return; }

  res.status(201).json({
    id: (option as any).id,
    meetupId,
    proposedDate: (option as any).proposed_date,
    timeBlock: (option as any).time_block ?? null,
    label: (option as any).label ?? null,
    confirmed: false,
    votes: { yes: 0, maybe: 0, no: 0, myVote: null },
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

  const { data: meetup } = await client.from("meetups").select("creator_id, status").eq("id", meetupId).maybeSingle();
  if (!meetup) { sendError(res, "not_found", "Meetup not found"); return; }
  if ((meetup as any).creator_id !== user.id) { sendError(res, "forbidden", "Only the creator can confirm the time"); return; }
  if ((meetup as any).status === "cancelled") { sendError(res, "invalid_payload", "Meetup is cancelled"); return; }

  const parsed = ConfirmTimeSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  const { data: option } = await client
    .from("meetup_time_options").select("*").eq("id", parsed.data.optionId).eq("meetup_id", meetupId).maybeSingle();
  if (!option) { sendError(res, "not_found", "Time option not found in this meetup"); return; }

  // Build starts_at from proposed_date + time_block
  const date = (option as any).proposed_date;
  const block = (option as any).time_block;
  const blockHour: Record<string, number> = { morning: 9, afternoon: 13, evening: 18, late: 22 };
  const hour = block ? (blockHour[block] ?? 18) : 18;
  const startsAt = `${date}T${String(hour).padStart(2, "0")}:00:00`;

  const now = new Date().toISOString();
  // Clear any previously confirmed options for this meetup first (single winner)
  await client.from("meetup_time_options").update({ confirmed: false }).eq("meetup_id", meetupId).eq("confirmed", true);
  await client.from("meetup_time_options").update({ confirmed: true }).eq("id", parsed.data.optionId);
  const { data: updated, error } = await client
    .from("meetups")
    .update({ starts_at: startsAt, status: "confirmed", updated_at: now })
    .eq("id", meetupId)
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "confirm time"); sendError(res, "db_error", error.message); return; }

  res.json({ startsAt, status: "confirmed", meetupId, meetup: toCamelMeetup(updated) });
});

// ── POST /api/meetups/:meetupId/add-to-trip-plan ─────────────────────────────

const AddToPlanSchema = z.object({
  tripId: z.string().regex(UUID, "tripId must be a valid UUID"),
});

router.post("/meetups/:meetupId/add-to-trip-plan", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { meetupId } = req.params;
  if (!UUID.test(meetupId)) { sendError(res, "invalid_payload", "Invalid meetupId"); return; }

  const parsed = AddToPlanSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const { tripId } = parsed.data;

  // Must be trip owner or member
  const { data: membership } = await client
    .from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", user.id).in("role", ["owner", "member"]).maybeSingle();
  if (!membership) { sendError(res, "not_member", "Not an accepted trip member"); return; }

  // Only owner/admin adds to plan
  if ((membership as any).role !== "owner") {
    const { data: ownerRow } = await client
      .from("trip_members").select("user_id").eq("trip_id", tripId).eq("role", "owner").maybeSingle();
    if ((ownerRow as any)?.user_id !== user.id) {
      sendError(res, "forbidden", "Only the trip owner can add meetups to the plan");
      return;
    }
  }

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
  };
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
    .select("name, handle")
    .eq("id", creatorId)
    .maybeSingle();
  const plannedByName = (profile as any)?.name ?? (profile as any)?.handle ?? null;

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
    await client
      .from("meetups")
      .update({ chat_thread_id: threadId, chat_message_id: (msg as any).id })
      .eq("id", meetupId);
  }
}

// ── GET /api/me/meetup-invites ────────────────────────────────────────────────
// Pending meetup invites for the inbox badge + inbox list

router.get("/me/meetup-invites", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { data: invites } = await client
    .from("meetup_invites")
    .select("id, meetup_id, status, invited_at")
    .eq("user_id", user.id)
    .eq("status", "pending")
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
  const profileMap: Record<string, any> = {};
  for (const p of profiles ?? []) profileMap[p.id] = p;

  const result = (invites as any[])
    .filter((i) => meetupMap[i.meetup_id] && meetupMap[i.meetup_id].status !== "cancelled")
    .map((i) => {
      const m = meetupMap[i.meetup_id];
      const creator = m ? profileMap[m.creator_id] : null;
      return {
        inviteId:        i.id,
        meetupId:        i.meetup_id,
        status:          i.status,
        invitedAt:       i.invited_at,
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

export default router;
