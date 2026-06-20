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

const router = Router();

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
  const expiresAt = b.expiresAt ?? new Date(Date.now() + (defaultHours[b.status] ?? 8) * 3_600_000).toISOString();

  const { data, error } = await client
    .from("quick_availability_status")
    .upsert({ user_id: user.id, status: b.status, expires_at: expiresAt, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
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

  const [{ data: tripAvRows }, { data: globalAvRows }, { data: qsRows }, { data: profiles }] = await Promise.all([
    client.from("trip_availability").select("user_id, open_days").eq("trip_id", tripId).in("user_id", memberIds),
    client.from("user_availability").select("user_id, weekly_days, open_to_meet").in("user_id", memberIds),
    client.from("quick_availability_status").select("user_id, status, expires_at").in("user_id", memberIds),
    client.from("profiles").select("id, handle, name, avatar_url").in("id", memberIds),
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

  const profileMap: Record<string, any> = {};
  for (const p of profiles ?? []) profileMap[(p as any).id] = p;

  const result = memberIds.map((uid) => {
    const ta = tripAvMap[uid];
    const ga = globalAvMap[uid];
    const qs = qsMap[uid];
    const p = profileMap[uid];
    return {
      userId: uid,
      handle: p?.handle ?? null,
      name: p?.name ?? null,
      avatarUrl: p?.avatar_url ?? null,
      // trip-scoped open_days takes priority; fall back to global weekly_days
      openDays: ta?.open_days ?? null,
      weeklyDays: ga?.weekly_days ?? {},
      openToMeet: ga?.open_to_meet ?? false,
      quickStatus: qs ? { status: qs.status, expiresAt: qs.expires_at } : null,
    };
  });

  res.json({ members: result, tripId });
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
});

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
      .select("member_id")
      .eq("owner_id", circleId)
      .eq("member_id", user.id)
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
      .select("member_id")
      .eq("owner_id", circleId)
      .eq("member_id", user.id)
      .maybeSingle();
    if (!mem) { sendError(res, "forbidden", "Not a circle member"); return; }
  }

  // Get all circle members (owner + members)
  const { data: memRows } = await client
    .from("circle_memberships")
    .select("member_id")
    .eq("owner_id", circleId);

  const memberIds = [circleId, ...((memRows ?? []).map((r: any) => r.member_id as string))];

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
  const profileMap: Record<string, any> = {};
  for (const p of profiles ?? []) profileMap[p.id] = p;

  const result = memberIds.map((uid) => {
    const av = avMap[uid];
    const qs = qsMap[uid];
    const p = profileMap[uid];
    return {
      userId: uid,
      handle: p?.handle ?? null,
      name: p?.name ?? null,
      avatarUrl: p?.avatar_url ?? null,
      weeklyDays: av?.weekly_days ?? {},
      openToMeet: av?.open_to_meet ?? false,
      quickStatus: qs ? { status: qs.status, expiresAt: qs.expires_at } : null,
      isOwner: uid === circleId,
    };
  });

  res.json({ members: result, circleId });
});

export default router;
