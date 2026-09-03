/**
 * Availability routes
 *
 * GET/PATCH /api/me/availability         — own weekly grid + open_to_meet
 * GET/PATCH /api/me/quick-availability   — quick status (expires_at)
 * GET/PATCH /api/trips/:tripId/availability  — trip-scoped windows for accepted members
 * GET       /api/circles/:circleId/availability — circle member quick statuses
 *
 * HARD RULES:
 *  - user_id always resolved from JWT — never from body
 *  - No GPS / exact location exposed
 *  - Read gates: friend / circle / trip membership per visibility
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, isAcceptedTripMember, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import { sendPushWithRetry } from "../lib/pushWithRetry.js";
import { nameVisibilitySet, nameVisibleFor } from "../lib/publicIdentity.js";
import { truncateDisplayName } from "../lib/displayName.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import {
  WINDOW_TYPES,
  INTENT_TYPES,
  GROUP_PREFERENCES,
  VISIBILITY_POLICIES,
  SOCIAL_AVAILABILITY,
  createWindow,
  listWindows,
  updateWindow,
  clearWindow,
} from "../services/passport/OpenToPlansService.js";

const router = Router();

/**
 * Passport spec §8 Open-to-Plans / Temporary Intent capability flag. Seeded OFF
 * by migration 2260. With it off the window routes below answer an
 * explicitly-disabled envelope and store nothing; the §6 grid / quick-status
 * routes above are NOT gated by it.
 */
const OPEN_TO_PLANS_FLAG = "open_to_plans_windows_enabled";

const WEEKDAYS = ["mon","tue","wed","thu","fri","sat","sun"] as const;
const BLOCKS   = ["morning","afternoon","evening","late"] as const;

const WeeklyDaysSchema = z.record(
  z.enum(WEEKDAYS),
  z.array(z.enum(BLOCKS)),
).optional();

const PatchAvailabilitySchema = z.object({
  weeklyDays:  WeeklyDaysSchema,
  openToMeet:  z.boolean().optional(),
  strictMode:  z.boolean().optional(),
});

const QuickStatusSchema = z.object({
  status:    z.enum(["free_now","busy","open_to_plans","free_tonight"]),
  expiresAt: z.string().optional(), // ISO string
});

// ── GET /api/me/availability ─────────────────────────────────────────────────

router.get("/me/availability", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { data, error } = await client
    .from("user_availability")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) { req.log.error({ err: error }, "get availability"); sendError(res, "db_error", error.message); return; }

  // Also fetch quick status
  const { data: qs } = await client
    .from("quick_availability_status")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  const quickStatus = qs && (qs as any).expires_at > new Date().toISOString()
    ? { status: (qs as any).status, expiresAt: (qs as any).expires_at }
    : null;

  if (!data) {
    res.json({ weeklyDays: {}, openToMeet: false, strictMode: false, quickStatus });
    return;
  }

  res.json({
    weeklyDays:  (data as any).weekly_days ?? {},
    openToMeet:  (data as any).open_to_meet ?? false,
    strictMode:  (data as any).strict_mode ?? false,
    quickStatus,
  });
});

// ── PATCH /api/me/availability ───────────────────────────────────────────────

router.patch("/me/availability", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const parsed = PatchAvailabilitySchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  const now = new Date().toISOString();
  const upsertRow: Record<string, any> = {
    user_id:    user.id,
    updated_at: now,
  };
  if (b.weeklyDays !== undefined) upsertRow.weekly_days = b.weeklyDays;
  if (b.openToMeet !== undefined) upsertRow.open_to_meet = b.openToMeet;
  if (b.strictMode !== undefined) upsertRow.strict_mode = b.strictMode;

  const { data, error } = await client
    .from("user_availability")
    .upsert(upsertRow, { onConflict: "user_id" })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "patch availability"); sendError(res, "db_error", error.message); return; }

  res.json({
    weeklyDays: (data as any).weekly_days ?? {},
    openToMeet: (data as any).open_to_meet ?? false,
    strictMode: (data as any).strict_mode ?? false,
  });
});

// ── GET /api/me/quick-availability ──────────────────────────────────────────

router.get("/me/quick-availability", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { data } = await client
    .from("quick_availability_status")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!data || (data as any).expires_at <= new Date().toISOString()) {
    res.json({ status: null, expiresAt: null });
    return;
  }

  res.json({ status: (data as any).status, expiresAt: (data as any).expires_at });
});

// ── PATCH /api/me/quick-availability ────────────────────────────────────────

router.patch("/me/quick-availability", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const parsed = QuickStatusSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  // Default expiry: free_now/free_tonight = 4h, open_to_plans = 24h, busy = 8h
  const defaultHours: Record<string, number> = {
    free_now: 4, free_tonight: 6, open_to_plans: 24, busy: 8,
  };
  const nowMs = Date.now();
  const expiresAt = b.expiresAt ?? new Date(nowMs + (defaultHours[b.status] ?? 8) * 3_600_000).toISOString();

  const { data, error } = await client
    .from("quick_availability_status")
    .upsert({ user_id: user.id, status: b.status, expires_at: expiresAt, updated_at: new Date(nowMs).toISOString() }, { onConflict: "user_id" })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "patch quick-availability"); sendError(res, "db_error", error.message); return; }

  res.json({ status: (data as any).status, expiresAt: (data as any).expires_at });
});

// ── GET /api/trips/:tripId/availability ─────────────────────────────────────
// Returns trip-scoped windows + quick statuses for all accepted trip members.
// Reads from trip_availability (trip-scoped) with fallback to user_availability.

router.get("/trips/:tripId/availability", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const member = await isAcceptedTripMember(client, tripId, user.id);
  if (!member) { sendError(res, "not_member", "You must be an accepted trip member to view availability"); return; }

  // Get all accepted members
  const { data: members } = await client
    .from("trip_members")
    .select("user_id")
    .eq("trip_id", tripId)
    .in("role", ["owner", "member"]);

  const memberIds = (members ?? []).map((m: any) => m.user_id as string);

  const [{ data: tripAvRows }, { data: globalAvRows }, { data: qsRows }, { data: profiles }, { data: tripRow }] = await Promise.all([
    client.from("trip_availability").select("user_id, open_days").eq("trip_id", tripId).in("user_id", memberIds),
    client.from("user_availability").select("user_id, weekly_days, open_to_meet").in("user_id", memberIds),
    client.from("quick_availability_status").select("user_id, status, expires_at").in("user_id", memberIds),
    client.from("profiles").select("id, handle, name, avatar_url").in("id", memberIds),
    client.from("trips").select("start_date, end_date").eq("id", tripId).maybeSingle(),
  ]);

  const now = new Date().toISOString();

  // Trip-scoped windows take priority over global weekly grid
  const tripAvMap: Record<string, any> = {};
  for (const r of tripAvRows ?? []) tripAvMap[(r as any).user_id] = r;

  const globalAvMap: Record<string, any> = {};
  for (const r of globalAvRows ?? []) globalAvMap[(r as any).user_id] = r;

  const qsMap: Record<string, any> = {};
  for (const r of qsRows ?? []) {
    if ((r as any).expires_at > now) qsMap[(r as any).user_id] = r;
  }

  const allowedNames = await nameVisibilitySet(getServiceClient() ?? client, memberIds);
  const profileMap: Record<string, any> = {};
  for (const p of profiles ?? []) profileMap[(p as any).id] = p;

  const result = memberIds.map((uid) => {
    const ta = tripAvMap[uid];
    const ga = globalAvMap[uid];
    const qs = qsMap[uid];
    const p = profileMap[uid];
    const nameAllowed = uid === user.id || allowedNames.has(uid);
    return {
      userId: uid,
      handle: p?.handle ?? null,
      name: nameAllowed ? (p?.name ?? null) : null,
      avatarUrl: p?.avatar_url ?? null,
      // trip-scoped open_days takes priority; fall back to global weekly_days
      openDays: ta?.open_days ?? null,
      weeklyDays: ga?.weekly_days ?? {},
      openToMeet: ga?.open_to_meet ?? false,
      quickStatus: qs ? { status: qs.status, expiresAt: qs.expires_at } : null,
    };
  });

  // ── bestDays computation ───────────────────────────────────────────────────
  // Generate the same day list the client grid shows, then count free members
  // per day using the same getCellStatus logic (openDays priority, weeklyDays fallback).
  const WDAY_IDX = ["sun","mon","tue","wed","thu","fri","sat"];
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  const rawStart = (tripRow as any)?.start_date ? new Date((tripRow as any).start_date + "T00:00:00") : todayDate;
  const startDay = rawStart >= todayDate ? rawStart : todayDate;
  const rawEnd = (tripRow as any)?.end_date
    ? new Date((tripRow as any).end_date + "T00:00:00")
    : new Date(startDay.getTime() + 13 * 86_400_000);
  const maxEnd = new Date(startDay.getTime() + 29 * 86_400_000);
  const endDay = rawEnd < maxEnd ? rawEnd : maxEnd;

  const tripDays: string[] = [];
  const cur = new Date(startDay);
  while (cur <= endDay) { tripDays.push(cur.toISOString().slice(0, 10)); cur.setDate(cur.getDate() + 1); }

  function isFreeOnDate(uid: string, date: string): boolean {
    const openDays: Record<string, string[]> | null = tripAvMap[uid]?.open_days ?? null;
    const weeklyDays: Record<string, string[]> = globalAvMap[uid]?.weekly_days ?? {};
    if (openDays !== null) {
      if (Object.keys(openDays).length === 0) return false;
      return ((openDays as any)[date]?.length ?? 0) > 0;
    }
    if (Object.keys(weeklyDays).length === 0) return false;
    const wd = WDAY_IDX[new Date(date + "T12:00:00").getDay()];
    return ((weeklyDays as any)[wd]?.length ?? 0) > 0;
  }

  const bestDays = tripDays
    .map((date) => ({ date, count: memberIds.filter((uid) => isFreeOnDate(uid, date)).length }))
    .filter((d) => d.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  res.json({ members: result, tripId, bestDays });
});

// ── PATCH /api/trips/:tripId/availability ────────────────────────────────────
// Set trip-specific open days — stored in trip_availability (scoped per trip+user).
// Schema: { openDays: { "2025-07-04": ["morning","evening"], ... } }

const PatchTripAvailabilitySchema = z.object({
  openDays: z.record(
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Key must be YYYY-MM-DD"),
    z.array(z.enum(BLOCKS)),
  ),
});

router.patch("/trips/:tripId/availability", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { tripId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const member = await isAcceptedTripMember(client, tripId, user.id);
  if (!member) { sendError(res, "not_member", "You must be an accepted trip member to set availability"); return; }

  const parsed = PatchTripAvailabilitySchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  const { data, error } = await client
    .from("trip_availability")
    .upsert({ trip_id: tripId, user_id: user.id, open_days: parsed.data.openDays, updated_at: new Date().toISOString() }, { onConflict: "trip_id,user_id" })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "patch trip availability"); sendError(res, "db_error", error.message); return; }

  res.json({ tripId, userId: user.id, openDays: (data as any).open_days ?? {} });

  // Fire-and-forget: nudge other members who haven't marked these dates yet.
  const freeDates = Object.entries(parsed.data.openDays)
    .filter(([, blocks]) => blocks.length > 0)
    .map(([date]) => date);
  if (freeDates.length > 0) {
    sendAvailabilityNudges(tripId, user.id, freeDates, req.log).catch(() => {});
  }
});

// ─── Availability nudge helper ─────────────────────────────────────────────────

async function sendAvailabilityNudges(
  tripId: string,
  senderId: string,
  freeDates: string[],
  log: any,
): Promise<void> {
  const sc = getServiceClient();
  if (!sc) return;

  const today = new Date().toISOString().slice(0, 10);

  // Fetch accepted trip members (excluding the sender)
  const { data: memberRows } = await sc
    .from("trip_members")
    .select("user_id")
    .eq("trip_id", tripId)
    .in("role", ["owner", "member"])
    .neq("user_id", senderId);

  const recipientIds = (memberRows ?? []).map((r: any) => r.user_id as string);
  if (recipientIds.length === 0) return;

  // Fetch existing trip availability for all recipients so we can skip those
  // who already have any of the free dates in their own open_days.
  const { data: existingAv } = await sc
    .from("trip_availability")
    .select("user_id, open_days")
    .eq("trip_id", tripId)
    .in("user_id", recipientIds);

  const existingAvMap: Record<string, Record<string, string[]>> = {};
  for (const row of existingAv ?? []) {
    existingAvMap[(row as any).user_id] = (row as any).open_days ?? {};
  }

  const rows: Array<{
    sender_id: string;
    recipient_id: string;
    trip_id: string;
    nudge_date: string;
    sent_on: string;
  }> = [];

  for (const recipientId of recipientIds) {
    const theirDays = existingAvMap[recipientId] ?? {};
    // Find the first free date the recipient hasn't explicitly set at all.
    // Any explicit entry (empty or non-empty array) means they've already
    // recorded their status for that day — free or busy.
    const firstUnmarked = freeDates.find(
      (d) => !Object.prototype.hasOwnProperty.call(theirDays, d),
    );
    if (!firstUnmarked) continue; // all dates already have an explicit entry

    rows.push({
      sender_id: senderId,
      recipient_id: recipientId,
      trip_id: tripId,
      nudge_date: firstUnmarked,
      sent_on: today,
    });
  }

  if (rows.length === 0) return;

  // INSERT ... ON CONFLICT DO NOTHING RETURNING *  — only newly-inserted rows
  // come back.  This is how we dedupe push without a separate pre-check:
  // recipients who already got a nudge today are silently skipped AND omitted
  // from the returned set, so they won't receive a duplicate push either.
  const { data: insertedRows, error } = await sc
    .from("availability_nudges")
    .upsert(rows, { onConflict: "recipient_id,trip_id,sent_on", ignoreDuplicates: true })
    .select("recipient_id, nudge_date");

  if (error) {
    logger.warn({ err: error, tripId, senderId }, "availability nudge insert failed");
    return;
  }

  const newRows = insertedRows ?? [];
  logger.info({ inserted: newRows.length, attempted: rows.length, tripId }, "availability nudges");

  if (newRows.length === 0) return; // all were duplicates — no push needed

  // ── Push notifications (only for newly-created nudges) ─────────────────────
  const newRecipientIds = (newRows as any[]).map((r) => r.recipient_id as string);
  // Representative date for the push body: earliest nudge_date across new rows
  const nudgeDate = (newRows as any[])
    .map((r) => r.nudge_date as string)
    .sort()[0];

  const [{ data: tokenRows }, { data: senderProfile }, { data: tripRow }, senderNameAllowed] = await Promise.all([
    sc.from("profiles").select("id, expo_push_token").in("id", newRecipientIds),
    sc.from("profiles").select("name, handle").eq("id", senderId).single(),
    sc.from("trips").select("title").eq("id", tripId).single(),
    nameVisibleFor(sc, senderId),
  ]);

  const senderHandle = (senderProfile as any)?.handle as string | null;
  const senderName = truncateDisplayName(senderNameAllowed
    ? ((senderProfile as any)?.name ?? (senderHandle ? `@${senderHandle}` : "A trip member"))
    : (senderHandle ? `@${senderHandle}` : "A trip member"));

  const tripTitle = (tripRow as any)?.title ?? "your trip";

  const dateLabel = new Date(nudgeDate + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const recipients = (tokenRows ?? []).map((r: any) => ({
    userId: r.id as string,
    tokens: [r.expo_push_token as string | null],
  }));

  await sendPushWithRetry(sc, recipients, {
    title: "Availability update 📅",
    body: `${senderName} is free ${dateLabel} — are you?`,
    data: { screen: "availability", tripId, tripTitle },
  });
}

// ── PATCH /api/circles/:circleId/availability ────────────────────────────────
// Update the calling user's own general availability (gated by circle membership).
// Circle availability = shared general grid; no separate scoped table needed.

router.patch("/circles/:circleId/availability", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { circleId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(circleId)) { sendError(res, "invalid_payload", "Invalid circleId"); return; }

  // Gate: must be circle owner or member
  const isOwner = user.id === circleId;
  if (!isOwner) {
    const { data: mem } = await client
      .from("circle_memberships")
      .select("other_id")
      .eq("user_id", circleId)
      .eq("other_id", user.id)
      .maybeSingle();
    if (!mem) { sendError(res, "forbidden", "Not a circle member"); return; }
  }

  const parsed = PatchAvailabilitySchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  const now = new Date().toISOString();
  const upsertRow: Record<string, any> = { user_id: user.id, updated_at: now };
  if (b.weeklyDays !== undefined) upsertRow.weekly_days = b.weeklyDays;
  if (b.openToMeet !== undefined) upsertRow.open_to_meet = b.openToMeet;
  if (b.strictMode !== undefined) upsertRow.strict_mode = b.strictMode;

  const { data, error } = await client
    .from("user_availability")
    .upsert(upsertRow, { onConflict: "user_id" })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "patch circle availability"); sendError(res, "db_error", error.message); return; }

  res.json({
    weeklyDays: (data as any).weekly_days ?? {},
    openToMeet: (data as any).open_to_meet ?? false,
    strictMode: (data as any).strict_mode ?? false,
  });
});

// ── GET /api/me/availability-nudges ──────────────────────────────────────────
// Returns recent availability nudges for the calling user, enriched with
// sender profile and trip title so the notifications screen can render them.

router.get("/me/availability-nudges", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { user } = ctx;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: rows, error } = await sc
    .from("availability_nudges")
    .select("id, sender_id, trip_id, nudge_date, created_at")
    .eq("recipient_id", user.id)
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) { sendError(res, "db_error", error.message); return; }

  if (!rows || rows.length === 0) {
    res.json({ nudges: [] });
    return;
  }

  const senderIds = [...new Set((rows as any[]).map((r) => r.sender_id as string))];
  const tripIds   = [...new Set((rows as any[]).map((r) => r.trip_id   as string))];

  const [{ data: profiles }, { data: trips }, allowedNames] = await Promise.all([
    sc.from("profiles").select("id, name, handle, avatar_url").in("id", senderIds),
    sc.from("trips").select("id, title, destination_city").in("id", tripIds),
    nameVisibilitySet(sc, senderIds),
  ]);

  const profileMap: Record<string, any> = {};
  for (const p of profiles ?? []) profileMap[(p as any).id] = p;

  const tripMap: Record<string, any> = {};
  for (const t of trips ?? []) tripMap[(t as any).id] = t;

  const nudges = (rows as any[]).map((r) => {
    const sender = profileMap[r.sender_id];
    const trip   = tripMap[r.trip_id];
    const nameAllowed = r.sender_id === user.id || allowedNames.has(r.sender_id as string);
    return {
      id:            r.id as string,
      senderId:      r.sender_id as string,
      senderName:    nameAllowed ? (sender?.name ?? null) : null,
      senderHandle:  sender?.handle ?? null,
      senderAvatarUrl: sender?.avatar_url ?? null,
      tripId:        r.trip_id    as string,
      tripTitle:     trip?.title  ?? null,
      destinationCity: trip?.destination_city ?? null,
      nudgeDate:     r.nudge_date as string,
      createdAt:     r.created_at as string,
    };
  });

  res.json({ nudges });
});

// ── GET /api/circles/:circleId/availability ──────────────────────────────────
// Returns quick statuses + weekly grid for all circle members
// circleId = circle owner's user_id

router.get("/circles/:circleId/availability", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { circleId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(circleId)) { sendError(res, "invalid_payload", "Invalid circleId"); return; }

  // Gate: must be the circle owner or a member
  const isOwner = user.id === circleId;
  if (!isOwner) {
    const { data: mem } = await client
      .from("circle_memberships")
      .select("other_id")
      .eq("user_id", circleId)
      .eq("other_id", user.id)
      .maybeSingle();
    if (!mem) { sendError(res, "forbidden", "Not a circle member"); return; }
  }

  // Get all circle members (owner + members)
  const { data: memRows } = await client
    .from("circle_memberships")
    .select("other_id")
    .eq("user_id", circleId);

  const memberIds = [circleId, ...((memRows ?? []).map((r: any) => r.other_id as string))];

  const [{ data: avRows }, { data: qsRows }, { data: profiles }] = await Promise.all([
    client.from("user_availability").select("user_id, weekly_days, open_to_meet").in("user_id", memberIds),
    client.from("quick_availability_status").select("user_id, status, expires_at").in("user_id", memberIds),
    client.from("profiles").select("id, handle, name, avatar_url").in("id", memberIds),
  ]);

  const now = new Date().toISOString();
  const avMap: Record<string, any> = {};
  for (const r of avRows ?? []) avMap[(r as any).user_id] = r;
  const qsMap: Record<string, any> = {};
  for (const r of qsRows ?? []) {
    if ((r as any).expires_at > now) qsMap[(r as any).user_id] = r;
  }
  const allowedNames = await nameVisibilitySet(getServiceClient() ?? client, memberIds);
  const profileMap: Record<string, any> = {};
  for (const p of profiles ?? []) profileMap[p.id] = p;

  const result = memberIds.map((uid) => {
    const av = avMap[uid];
    const qs = qsMap[uid];
    const p = profileMap[uid];
    const nameAllowed = uid === user.id || allowedNames.has(uid);
    return {
      userId: uid,
      handle: p?.handle ?? null,
      name: nameAllowed ? (p?.name ?? null) : null,
      avatarUrl: p?.avatar_url ?? null,
      weeklyDays: av?.weekly_days ?? {},
      openToMeet: av?.open_to_meet ?? false,
      quickStatus: qs ? { status: qs.status, expiresAt: qs.expires_at } : null,
      isOwner: uid === circleId,
    };
  });

  res.json({ members: result, circleId });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Passport §8 — Open to Plans / Temporary Intent (AvailabilityWindow, TABLE 8)
//
// These are ADDITIVE. The §6 weekly grid and quick-status routes above are
// untouched. Everything here is gated behind `open_to_plans_windows_enabled`
// (seeded OFF); when the flag is off, reads return { windows: [], enabled:false }
// and writes return { ok:true, enabled:false } and store nothing.
//
// §7 is enforced at THIS boundary too: the create endpoint never accepts a
// `source` from the body — a window set through the API is, by construction, an
// EXPLICIT answer. Inference lives server-side (OpenToPlansService.recordInferred-
// Window) and produces private plan_derived windows that this endpoint cannot.
// ═══════════════════════════════════════════════════════════════════════════════

const UUID_RE = /^[0-9a-f-]{36}$/i;

const CreateWindowSchema = z.object({
  type:               z.enum(WINDOW_TYPES),
  startAt:            z.string().min(1),
  endAt:              z.string().min(1),
  tripId:             z.string().regex(UUID_RE).nullish(),
  openToPlans:        z.boolean().optional(),
  intents:            z.array(z.enum(INTENT_TYPES)).max(INTENT_TYPES.length).optional(),
  groupPreference:    z.enum(GROUP_PREFERENCES).nullish(),
  maxTravelMinutes:   z.number().int().positive().max(1440).nullish(),
  visibility:         z.enum(VISIBILITY_POLICIES).optional(),
  socialAvailability: z.enum(SOCIAL_AVAILABILITY).nullish(),
  expiresAt:          z.string().nullish(),
});

const UpdateWindowSchema = z.object({
  openToPlans:        z.boolean().optional(),
  intents:            z.array(z.enum(INTENT_TYPES)).max(INTENT_TYPES.length).optional(),
  groupPreference:    z.enum(GROUP_PREFERENCES).nullish(),
  maxTravelMinutes:   z.number().int().positive().max(1440).nullish(),
  visibility:         z.enum(VISIBILITY_POLICIES).optional(),
  socialAvailability: z.enum(SOCIAL_AVAILABILITY).nullish(),
  endAt:              z.string().min(1).optional(),
  expiresAt:          z.string().nullish(),
}).refine((b) => Object.keys(b).length > 0, { message: "empty patch" });

// ── GET /api/me/availability-windows ─────────────────────────────────────────
// Own windows. Non-expired only by default (§31); ?includeExpired=1 for history.

router.get("/me/availability-windows", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  if (!(await isFlagEnabled(client, OPEN_TO_PLANS_FLAG))) {
    res.json({ windows: [], enabled: false });
    return;
  }

  const includeExpired = req.query.includeExpired === "1" || req.query.includeExpired === "true";
  const windows = await listWindows(client, user.id, { includeExpired });
  res.json({ windows, enabled: true });
});

// ── POST /api/me/availability-windows ────────────────────────────────────────
// Set an EXPLICIT intent window with a TTL. source is always 'explicit' (§7).

router.post("/me/availability-windows", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  if (!(await isFlagEnabled(client, OPEN_TO_PLANS_FLAG))) {
    res.json({ ok: true, enabled: false });
    return;
  }

  const parsed = CreateWindowSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const b = parsed.data;

  const { window, error } = await createWindow(client, {
    userId:             user.id, // §: user_id from JWT, never from body
    type:               b.type,
    startAt:            b.startAt,
    endAt:              b.endAt,
    tripId:             b.tripId ?? null,
    openToPlans:        b.openToPlans,
    intents:            b.intents,
    groupPreference:    b.groupPreference ?? null,
    maxTravelMinutes:   b.maxTravelMinutes ?? null,
    visibility:         b.visibility,
    source:             "explicit", // §7: an answer given through the API is explicit
    socialAvailability: b.socialAvailability ?? null,
    expiresAt:          b.expiresAt ?? null,
  });

  if (!window) {
    if (error && error !== "db_error") { sendError(res, "invalid_payload", error); return; }
    sendError(res, "db_error", "Could not create availability window");
    return;
  }
  res.status(201).json({ window, enabled: true });
});

// ── PATCH /api/me/availability-windows/:id ───────────────────────────────────
// Update intent/openToPlans/visibility/TTL on an owned window.

router.patch("/me/availability-windows/:id", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid window id"); return; }

  if (!(await isFlagEnabled(client, OPEN_TO_PLANS_FLAG))) {
    res.json({ ok: true, enabled: false });
    return;
  }

  const parsed = UpdateWindowSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  const { window, error } = await updateWindow(client, id, user.id, parsed.data);
  if (!window) {
    if (error === "not_found") { sendError(res, "not_found", "Window not found"); return; }
    if (error && error !== "db_error") { sendError(res, "invalid_payload", error); return; }
    sendError(res, "db_error", "Could not update availability window");
    return;
  }
  res.json({ window, enabled: true });
});

// ── DELETE /api/me/availability-windows/:id ──────────────────────────────────
// Explicit clear (§8 "explicit clear action").

router.delete("/me/availability-windows/:id", async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid window id"); return; }

  if (!(await isFlagEnabled(client, OPEN_TO_PLANS_FLAG))) {
    res.json({ ok: true, enabled: false });
    return;
  }

  const cleared = await clearWindow(client, id, user.id);
  if (!cleared) { sendError(res, "not_found", "Window not found"); return; }
  res.json({ ok: true, cleared: true, enabled: true });
});

export default router;
