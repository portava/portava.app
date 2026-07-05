import { Router } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";

const router = Router();

function sc(fallback?: any) {
  return getServiceClient() ?? fallback;
}

async function requireAdminCtx(req: any, res: any) {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const serviceClient = sc(auth.client);
  const { data: profile } = await serviceClient
    .from("profiles")
    .select("role")
    .eq("id", auth.user.id)
    .maybeSingle();
  if ((profile as any)?.role !== "admin") {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return { auth, serviceClient };
}

// ── buddy_services ─────────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/buddies/:buddyId/services", async (req, res) => {
  const serviceClient = sc();
  if (!serviceClient) return res.json({ services: [] });

  const { data, error } = await serviceClient
    .from("buddy_services")
    .select("*")
    .eq("buddy_id", req.params.buddyId)
    .eq("is_active", true)
    .eq("approved", true)
    .order("category")
    .order("created_at");

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ services: data ?? [] });
});

router.get("/api/rent-a-buddy/buddies/:buddyId/availability-exceptions", async (req, res) => {
  const serviceClient = sc();
  if (!serviceClient) return res.json({ exceptions: [] });

  const { from, to } = req.query as Record<string, string | undefined>;
  let query = serviceClient
    .from("buddy_availability_exceptions")
    .select("*")
    .eq("buddy_id", req.params.buddyId)
    .order("exception_date");
  if (from) query = query.gte("exception_date", from);
  if (to)   query = query.lte("exception_date", to);

  const { data, error } = await query;
  if (error) return sendError(res, "db_error", error.message);
  return res.json({ exceptions: data ?? [] });
});

router.get("/api/me/buddy-services", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!bp) return res.status(403).json({ error: "not_a_buddy" });

  const { data, error } = await serviceClient
    .from("buddy_services")
    .select("*")
    .eq("buddy_id", (bp as any).id)
    .order("created_at", { ascending: false });

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ services: data ?? [] });
});

router.post("/api/me/buddy-services", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id, status")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!bp || (bp as any).status !== "active") return res.status(403).json({ error: "not_a_buddy" });

  const { category, title, description, hourlyRateUsd, halfDayUsd, fullDayUsd, minHours, maxHours, maxGroupSize } = req.body ?? {};
  if (!category || !title) {
    return res.status(400).json({ error: "invalid_payload", message: "category and title are required." });
  }

  const now = new Date().toISOString();
  const { data, error } = await serviceClient
    .from("buddy_services")
    .insert({
      buddy_id: (bp as any).id,
      category,
      title,
      description: description ?? null,
      hourly_rate_usd: hourlyRateUsd ?? null,
      half_day_usd: halfDayUsd ?? null,
      full_day_usd: fullDayUsd ?? null,
      min_hours: minHours ?? 1,
      max_hours: maxHours ?? null,
      max_group_size: maxGroupSize ?? 4,
      is_active: true,
      approved: false,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  return res.status(201).json({ service: data });
});

router.patch("/api/me/buddy-services/:serviceId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!bp) return res.status(403).json({ error: "not_a_buddy" });

  const { data: existing } = await serviceClient
    .from("buddy_services")
    .select("id")
    .eq("id", req.params.serviceId)
    .eq("buddy_id", (bp as any).id)
    .maybeSingle();
  if (!existing) return res.status(404).json({ error: "not_found" });

  const fieldMap: Record<string, string> = {
    title: "title", description: "description",
    hourlyRateUsd: "hourly_rate_usd", halfDayUsd: "half_day_usd", fullDayUsd: "full_day_usd",
    minHours: "min_hours", maxHours: "max_hours", maxGroupSize: "max_group_size",
    isActive: "is_active",
  };
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [camelKey, dbKey] of Object.entries(fieldMap)) {
    if (req.body?.[camelKey] !== undefined) updates[dbKey] = req.body[camelKey];
    else if (req.body?.[dbKey] !== undefined) updates[dbKey] = req.body[dbKey];
  }
  const rateKeys = ["hourly_rate_usd", "half_day_usd", "full_day_usd"];
  if (rateKeys.some(k => updates[k] !== undefined)) {
    updates.approved = false;
    updates.approved_at = null;
  }

  const { data, error } = await serviceClient
    .from("buddy_services")
    .update(updates)
    .eq("id", req.params.serviceId)
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ service: data });
});

router.delete("/api/me/buddy-services/:serviceId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!bp) return res.status(403).json({ error: "not_a_buddy" });

  const { error } = await serviceClient
    .from("buddy_services")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", req.params.serviceId)
    .eq("buddy_id", (bp as any).id);

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ ok: true });
});

router.post("/api/admin/rent-a-buddy/services/:serviceId/approve", async (req, res) => {
  const adminCtx = await requireAdminCtx(req, res);
  if (!adminCtx) return;
  const { serviceClient } = adminCtx;

  const now = new Date().toISOString();
  const { data, error } = await serviceClient
    .from("buddy_services")
    .update({ approved: true, approved_at: now, updated_at: now })
    .eq("id", req.params.serviceId)
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ service: data });
});

router.post("/api/admin/rent-a-buddy/services/:serviceId/disable", async (req, res) => {
  const adminCtx = await requireAdminCtx(req, res);
  if (!adminCtx) return;
  const { serviceClient } = adminCtx;

  const now = new Date().toISOString();
  const { data, error } = await serviceClient
    .from("buddy_services")
    .update({ is_active: false, approved: false, updated_at: now })
    .eq("id", req.params.serviceId)
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ ok: true, service: data });
});

// ── buddy_availability_exceptions ──────────────────────────────────────────────

router.get("/api/me/buddy-availability-exceptions", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!bp) return res.status(403).json({ error: "not_a_buddy" });

  const { from, to } = req.query as Record<string, string | undefined>;
  let query = serviceClient
    .from("buddy_availability_exceptions")
    .select("*")
    .eq("buddy_id", (bp as any).id)
    .order("exception_date");
  if (from) query = query.gte("exception_date", from);
  if (to)   query = query.lte("exception_date", to);

  const { data, error } = await query;
  if (error) return sendError(res, "db_error", error.message);
  return res.json({ exceptions: data ?? [] });
});

router.post("/api/me/buddy-availability-exceptions", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!bp) return res.status(403).json({ error: "not_a_buddy" });

  const { exceptionDate, endDate, exceptionType, startTime, endTime, reason } = req.body ?? {};
  if (!exceptionDate || !/^\d{4}-\d{2}-\d{2}$/.test(exceptionDate)) {
    return res.status(400).json({ error: "invalid_payload", message: "exceptionDate (YYYY-MM-DD) is required." });
  }

  const now = new Date().toISOString();
  const { data, error } = await serviceClient
    .from("buddy_availability_exceptions")
    .insert({
      buddy_id: (bp as any).id,
      exception_date: exceptionDate,
      end_date: endDate ?? null,
      exception_type: exceptionType ?? "blocked",
      start_time: startTime ?? null,
      end_time: endTime ?? null,
      reason: reason ?? null,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  return res.status(201).json({ exception: data });
});

router.patch("/api/me/buddy-availability-exceptions/:exceptionId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!bp) return res.status(403).json({ error: "not_a_buddy" });

  const fieldMap: Record<string, string> = {
    exceptionDate: "exception_date", endDate: "end_date", exceptionType: "exception_type",
    startTime: "start_time", endTime: "end_time", reason: "reason",
  };
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [camelKey, dbKey] of Object.entries(fieldMap)) {
    if (req.body?.[camelKey] !== undefined) updates[dbKey] = req.body[camelKey];
    else if (req.body?.[dbKey] !== undefined) updates[dbKey] = req.body[dbKey];
  }

  const { data, error } = await serviceClient
    .from("buddy_availability_exceptions")
    .update(updates)
    .eq("id", req.params.exceptionId)
    .eq("buddy_id", (bp as any).id)
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  if (!data) return res.status(404).json({ error: "not_found" });
  return res.json({ exception: data });
});

router.delete("/api/me/buddy-availability-exceptions/:exceptionId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!bp) return res.status(403).json({ error: "not_a_buddy" });

  const { error } = await serviceClient
    .from("buddy_availability_exceptions")
    .delete()
    .eq("id", req.params.exceptionId)
    .eq("buddy_id", (bp as any).id);

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ ok: true });
});

// ── buddy_booking_events read ──────────────────────────────────────────────────
// Also accessible at /api/buddy-bookings/:id/events via URL alias in app.ts

router.get("/api/rent-a-buddy/bookings/:bookingId/events", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { bookingId } = req.params;
  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("id, traveler_id, buddy_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const b = booking as any;
  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  const isParty = b.traveler_id === auth.user.id || (bp && b.buddy_id === (bp as any).id);
  if (!isParty) return res.status(403).json({ error: "forbidden" });

  const { data, error } = await serviceClient
    .from("buddy_booking_events")
    .select("*")
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: true });

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ events: data ?? [] });
});

// ── booking request shorthand ──────────────────────────────────────────────────

// POST /api/rent-a-buddy/buddies/:buddyId/request — create a booking targeting a specific buddy
// Also accessible at /api/buddies/:buddyId/request via app.ts URL alias
router.post("/api/rent-a-buddy/buddies/:buddyId/request", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { buddyId } = req.params;
  const { bookingDate, durationH, city, category, notes, groupSize } = req.body ?? {};

  // Required field validation
  if (!bookingDate || !durationH || !city || !category) {
    return res.status(400).json({
      error: "invalid_payload",
      message: "bookingDate, durationH, city, and category are required.",
    });
  }

  // Self-booking prevention
  const { data: ownProfile } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (ownProfile && (ownProfile as any).id === buddyId) {
    return res.status(409).json({ error: "self_booking_not_allowed" });
  }

  // Verify buddy exists and is active
  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id, status, admin_status, verified, categories")
    .eq("id", buddyId)
    .maybeSingle();

  if (!bp) return res.status(404).json({ error: "buddy_not_found" });
  if ((bp as any).status !== "active") {
    return res.status(422).json({ error: "buddy_not_available", message: "This buddy is not currently accepting bookings." });
  }
  if ((bp as any).admin_status !== "active") {
    return res.status(422).json({ error: "buddy_suspended" });
  }

  // Category availability check
  const buddyCategories: string[] = (bp as any).categories ?? [];
  if (buddyCategories.length > 0 && !buddyCategories.includes(category)) {
    return res.status(422).json({ error: "category_not_offered", message: `This buddy does not offer the '${category}' category.` });
  }

  const now = new Date().toISOString();
  const { data, error } = await serviceClient
    .from("rent_buddy_bookings")
    .insert({
      traveler_id: auth.user.id,
      buddy_id: buddyId,
      booking_date: bookingDate,
      duration_h: durationH,
      city,
      category,
      notes: notes ?? null,
      group_size: groupSize ?? 1,
      route_plan: [],
      total_usd: 0,
      deposit_usd: 0,
      status: "pending",
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  return res.status(201).json({ booking: data });
});

// ── safety check-in ────────────────────────────────────────────────────────────

// POST /api/rent-a-buddy/bookings/:bookingId/check-in
// Also accessible at /api/buddy-bookings/:bookingId/check-in via URL alias
router.post("/api/rent-a-buddy/bookings/:bookingId/check-in", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { bookingId } = req.params;
  const { checkinType, response: checkinResponse } = req.body ?? {};

  const VALID_CHECKIN_TYPES = [
    "arrival", "comfort_30min", "check_ok", "uncomfortable",
    "end_early", "contact_support", "start_safe_return", "emergency_phrase",
  ] as const;

  if (!checkinType || !VALID_CHECKIN_TYPES.includes(checkinType)) {
    return res.status(400).json({
      error: "invalid_payload",
      message: `checkinType must be one of: ${VALID_CHECKIN_TYPES.join(", ")}.`,
    });
  }

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("id, traveler_id, buddy_id, status")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const b = booking as any;
  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  const isParty = b.traveler_id === auth.user.id || (bp && b.buddy_id === (bp as any).id);
  if (!isParty) return res.status(403).json({ error: "forbidden" });

  const { data, error } = await serviceClient
    .from("rent_buddy_safety_checkins")
    .insert({
      booking_id: bookingId,
      user_id: auth.user.id,
      checkin_type: checkinType,
      response: checkinResponse ?? null,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  return res.status(201).json({ checkin: data });
});

// ── report no-show ─────────────────────────────────────────────────────────────

// POST /api/rent-a-buddy/bookings/:bookingId/report-no-show
// Also accessible at /api/buddy-bookings/:bookingId/report-no-show via URL alias
router.post("/api/rent-a-buddy/bookings/:bookingId/report-no-show", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { bookingId } = req.params;
  const { notes } = req.body ?? {};

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("id, traveler_id, buddy_id, status")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const b = booking as any;

  // Resolve caller's buddy profile (if they are a buddy)
  const { data: callerBp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  const isParty = b.traveler_id === auth.user.id || (callerBp && b.buddy_id === (callerBp as any).id);
  if (!isParty) return res.status(403).json({ error: "forbidden" });

  // Resolve the no-show target's user_id:
  //   traveler reports → target is the buddy's user_id (looked up via rent_buddy_profiles)
  //   buddy reports    → target is traveler_id (already a profiles.id)
  let targetUserId: string | null = null;
  if (auth.user.id === b.traveler_id) {
    const { data: buddyProfile } = await serviceClient
      .from("rent_buddy_profiles")
      .select("user_id")
      .eq("id", b.buddy_id)
      .maybeSingle();
    targetUserId = (buddyProfile as any)?.user_id ?? null;
  } else {
    targetUserId = b.traveler_id;
  }

  const { data, error } = await serviceClient
    .from("rent_buddy_safety_events")
    .insert({
      booking_id: bookingId,
      actor_user_id: auth.user.id,
      target_user_id: targetUserId,
      event_type: "no_show",
      event_status: "open",
      metadata: { notes: notes ?? null },
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  return res.status(201).json({ safetyEvent: data });
});

// ── route change request ───────────────────────────────────────────────────────

// POST /api/rent-a-buddy/bookings/:bookingId/change-request
// Also accessible at /api/buddy-bookings/:bookingId/change-request via URL alias
router.post("/api/rent-a-buddy/bookings/:bookingId/change-request", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { bookingId } = req.params;
  const { newStops, reason } = req.body ?? {};

  if (!Array.isArray(newStops)) {
    return res.status(400).json({ error: "invalid_payload", message: "newStops array is required." });
  }

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("id, traveler_id, buddy_id, status")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const b = booking as any;
  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  const isParty = b.traveler_id === auth.user.id || (bp && b.buddy_id === (bp as any).id);
  if (!isParty) return res.status(403).json({ error: "forbidden" });

  if (!["confirmed", "in_progress"].includes(b.status)) {
    return res.status(409).json({ error: "invalid_state", message: "Change requests are only allowed on confirmed or in-progress bookings." });
  }

  const { data, error } = await serviceClient
    .from("rent_buddy_route_change_requests")
    .insert({
      booking_id: bookingId,
      requested_by: auth.user.id,
      old_stops_json: b.route_plan ?? [],
      new_stops_json: newStops,
      reason: reason ?? null,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  return res.status(201).json({ changeRequest: data });
});

// POST /api/rent-a-buddy/bookings/:bookingId/respond-change-request
// Also accessible at /api/buddy-bookings/:bookingId/respond-change-request via URL alias
router.post("/api/rent-a-buddy/bookings/:bookingId/respond-change-request", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { bookingId } = req.params;
  const { response: decision } = req.body ?? {};
  if (!["approved", "declined"].includes(decision)) {
    return res.status(400).json({ error: "invalid_payload", message: "response must be 'approved' or 'declined'." });
  }

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("id, traveler_id, buddy_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const b = booking as any;
  if (b.traveler_id !== auth.user.id) {
    return res.status(403).json({ error: "forbidden", message: "Only the traveler can respond to a change request." });
  }

  const now = new Date().toISOString();
  // Find the latest open (null traveler_response) change request
  const { data: cr } = await serviceClient
    .from("rent_buddy_route_change_requests")
    .select("id")
    .eq("booking_id", bookingId)
    .is("traveler_response", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!cr) return res.status(404).json({ error: "no_pending_change_request" });

  const { data, error } = await serviceClient
    .from("rent_buddy_route_change_requests")
    .update({ traveler_response: decision, responded_at: now })
    .eq("id", (cr as any).id)
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ changeRequest: data });
});

// ── rebook ─────────────────────────────────────────────────────────────────────

// POST /api/rent-a-buddy/bookings/:bookingId/rebook
// Also accessible at /api/buddy-bookings/:bookingId/rebook via URL alias
router.post("/api/rent-a-buddy/bookings/:bookingId/rebook", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { bookingId } = req.params;
  const { bookingDate, durationH, notes } = req.body ?? {};
  if (!bookingDate || !durationH) {
    return res.status(400).json({ error: "invalid_payload", message: "bookingDate and durationH are required for rebook." });
  }

  const { data: original } = await serviceClient
    .from("rent_buddy_bookings")
    .select("buddy_id, traveler_id, city, category, group_size")
    .eq("id", bookingId)
    .eq("traveler_id", auth.user.id)
    .maybeSingle();

  if (!original) return res.status(404).json({ error: "not_found" });

  const o = original as any;
  const now = new Date().toISOString();
  const { data, error } = await serviceClient
    .from("rent_buddy_bookings")
    .insert({
      traveler_id: auth.user.id,
      buddy_id: o.buddy_id,
      booking_date: bookingDate,
      duration_h: durationH,
      city: o.city,
      category: o.category,
      notes: notes ?? null,
      group_size: o.group_size ?? 1,
      route_plan: [],
      total_usd: 0,
      deposit_usd: 0,
      status: "pending",
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  return res.status(201).json({ booking: data, rebookedFromId: bookingId });
});

// ── me/buddy-bookings explicit (also covered by app.ts URL alias) ──────────────

// GET /api/me/buddy-bookings — traveler's own bookings list (explicit route)
router.get("/api/me/buddy-bookings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { status, page = "1", limit = "20" } = req.query as Record<string, string | undefined>;
  const pageNum = Math.max(1, parseInt(page ?? "1", 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(limit ?? "20", 10)));
  const offset = (pageNum - 1) * pageSize;

  let query = serviceClient
    .from("rent_buddy_bookings")
    .select("*", { count: "exact" })
    .eq("traveler_id", auth.user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (status) query = query.eq("status", status);

  const { data, error, count } = await query;
  if (error) return sendError(res, "db_error", error.message);
  return res.json({ bookings: data ?? [], total: count ?? 0, page: pageNum, pageSize });
});

// ── admin spec routes ───────────────────────────────────────────────────────────

// GET /api/rent-a-buddy/admin/buddies/pending
// Also accessible at /api/admin/buddies/pending via URL alias
// Must be registered before the parameterized /:buddyId routes in this router.
router.get("/api/rent-a-buddy/admin/buddies/pending", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: profile } = await serviceClient
    .from("profiles")
    .select("role")
    .eq("id", auth.user.id)
    .maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  const { page = "1", limit = "20" } = req.query as Record<string, string | undefined>;
  const pageNum = Math.max(1, parseInt(page ?? "1", 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(limit ?? "20", 10)));
  const offset = (pageNum - 1) * pageSize;

  const { data, error, count } = await serviceClient
    .from("rent_buddy_profiles")
    .select("*", { count: "exact" })
    .eq("admin_status", "pending_review")
    .order("created_at", { ascending: true })
    .range(offset, offset + pageSize - 1);

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ buddies: data ?? [], total: count ?? 0, page: pageNum, pageSize });
});

// POST /api/rent-a-buddy/admin/buddies/:buddyId/approve
// Also accessible at /api/admin/buddies/:buddyId/approve via URL alias
router.post("/api/rent-a-buddy/admin/buddies/:buddyId/approve", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: profile } = await serviceClient
    .from("profiles")
    .select("role")
    .eq("id", auth.user.id)
    .maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  const { buddyId } = req.params;
  const { note } = req.body ?? {};

  const { data, error } = await serviceClient
    .from("rent_buddy_profiles")
    .update({ admin_status: "active", status: "active", updated_at: new Date().toISOString() })
    .eq("id", buddyId)
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: auth.user.id,
    target_type: "buddy",
    target_id: buddyId,
    action: "approved",
    notes: note ?? null,
  });

  return res.json({ buddy: data });
});

// POST /api/rent-a-buddy/admin/buddies/:buddyId/reject
// Also accessible at /api/admin/buddies/:buddyId/reject via URL alias
router.post("/api/rent-a-buddy/admin/buddies/:buddyId/reject", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: profile } = await serviceClient
    .from("profiles")
    .select("role")
    .eq("id", auth.user.id)
    .maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  const { buddyId } = req.params;
  const { reason } = req.body ?? {};

  const { data, error } = await serviceClient
    .from("rent_buddy_profiles")
    .update({ admin_status: "rejected", updated_at: new Date().toISOString() })
    .eq("id", buddyId)
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: auth.user.id,
    target_type: "buddy",
    target_id: buddyId,
    action: "rejected",
    notes: reason ?? null,
  });

  return res.json({ buddy: data });
});

// POST /api/rent-a-buddy/admin/buddies/:buddyId/unsuspend
// Also accessible at /api/admin/buddies/:buddyId/unsuspend via URL alias
// Semantic alias for reactivate (both set admin_status → active).
router.post("/api/rent-a-buddy/admin/buddies/:buddyId/unsuspend", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: profile } = await serviceClient
    .from("profiles")
    .select("role")
    .eq("id", auth.user.id)
    .maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  const { buddyId } = req.params;
  const { note } = req.body ?? {};

  const { data, error } = await serviceClient
    .from("rent_buddy_profiles")
    .update({ admin_status: "active", status: "active", updated_at: new Date().toISOString() })
    .eq("id", buddyId)
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: auth.user.id,
    target_type: "buddy",
    target_id: buddyId,
    action: "unsuspended",
    notes: note ?? null,
  });

  return res.json({ buddy: data });
});

// ── favorite / unfavorite ──────────────────────────────────────────────────────

// POST /api/rent-a-buddy/buddies/:buddyId/favorite
// Also accessible at /api/buddies/:buddyId/favorite via app.ts URL alias
router.post("/api/rent-a-buddy/buddies/:buddyId/favorite", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  const { buddyId } = req.params;

  const { error } = await serviceClient
    .from("rent_buddy_saved")
    .upsert({ user_id: auth.user.id, buddy_id: buddyId }, { onConflict: "user_id,buddy_id" });

  if (error) return sendError(res, "db_error", error.message);
  return res.status(201).json({ saved: true, buddyId });
});

// POST /api/rent-a-buddy/buddies/:buddyId/unfavorite — POST method alias for clients that
// cannot issue DELETE requests (e.g. some mobile HTTP stacks).
// Also accessible at /api/buddies/:buddyId/unfavorite via app.ts URL alias
router.post("/api/rent-a-buddy/buddies/:buddyId/unfavorite", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  const { buddyId } = req.params;
  const { error } = await serviceClient
    .from("rent_buddy_saved")
    .delete()
    .eq("user_id", auth.user.id)
    .eq("buddy_id", buddyId);
  if (error) return sendError(res, "db_error", error.message);
  return res.status(200).json({ saved: false, buddyId });
});

// DELETE /api/rent-a-buddy/buddies/:buddyId/unfavorite
// Also accessible at /api/buddies/:buddyId/unfavorite via app.ts URL alias
router.delete("/api/rent-a-buddy/buddies/:buddyId/unfavorite", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  const { buddyId } = req.params;

  const { error } = await serviceClient
    .from("rent_buddy_saved")
    .delete()
    .eq("user_id", auth.user.id)
    .eq("buddy_id", buddyId);

  if (error) return sendError(res, "db_error", error.message);
  return res.status(200).json({ saved: false, buddyId });
});

// ── buddy profile lifecycle (me) ───────────────────────────────────────────────

// POST /api/rent-a-buddy/me/profile/submit — finalize and submit profile for review
// Also accessible at /api/me/buddy-profile/submit via app.ts URL alias
router.post("/api/rent-a-buddy/me/profile/submit", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: profile } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id, status, admin_status")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (!profile) return res.status(404).json({ error: "profile_not_found", message: "No buddy profile found. Apply first." });

  const p = profile as any;
  if (!["pending", "paused"].includes(p.status)) {
    return res.status(409).json({ error: "invalid_state", message: `Profile in '${p.status}' state cannot be submitted.` });
  }

  const { data, error } = await serviceClient
    .from("rent_buddy_profiles")
    .update({ status: "pending", admin_status: "pending_review", updated_at: new Date().toISOString() })
    .eq("id", p.id)
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ profile: data });
});

// POST /api/rent-a-buddy/me/profile/pause — pause an active buddy profile
// Also accessible at /api/me/buddy-profile/pause via app.ts URL alias
router.post("/api/rent-a-buddy/me/profile/pause", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: profile } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id, status")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (!profile) return res.status(404).json({ error: "profile_not_found" });

  const p = profile as any;
  if (p.status !== "active") {
    return res.status(409).json({ error: "invalid_state", message: `Cannot pause a profile in '${p.status}' state.` });
  }

  const { data, error } = await serviceClient
    .from("rent_buddy_profiles")
    .update({ status: "paused", updated_at: new Date().toISOString() })
    .eq("id", p.id)
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ profile: data });
});

// POST /api/rent-a-buddy/me/profile/resume — resume a paused buddy profile
// Also accessible at /api/me/buddy-profile/resume via app.ts URL alias
router.post("/api/rent-a-buddy/me/profile/resume", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: profile } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id, status, admin_status")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (!profile) return res.status(404).json({ error: "profile_not_found" });

  const p = profile as any;
  if (p.status !== "paused") {
    return res.status(409).json({ error: "invalid_state", message: `Cannot resume a profile in '${p.status}' state.` });
  }
  if (p.admin_status !== "active") {
    return res.status(403).json({ error: "admin_hold", message: "Profile is under admin review and cannot be self-resumed." });
  }

  const { data, error } = await serviceClient
    .from("rent_buddy_profiles")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", p.id)
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ profile: data });
});

// ── admin kill-switch ──────────────────────────────────────────────────────────

// POST /api/rent-a-buddy/admin/kill-switch
// Also accessible at /api/admin/rent-a-buddy/kill-switch via app.ts URL alias
// Toggles or sets the global rent-a-buddy kill switch (disables all bookings globally).
router.post("/api/rent-a-buddy/admin/kill-switch", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: profile } = await serviceClient.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  const { enabled } = req.body ?? {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "invalid_payload", message: "enabled (boolean) is required." });
  }

  // Upsert the global launch control (country_code=NULL, city=NULL, category=NULL)
  const { data, error } = await serviceClient
    .from("rent_buddy_launch_controls")
    .upsert(
      {
        country_code: null,
        city: null,
        category: null,
        enabled,
        notes: enabled ? "Kill switch lifted by admin" : "Kill switch activated by admin",
        created_by: auth.user.id,
      },
      { onConflict: "country_code,city,category" }
    )
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: auth.user.id,
    target_type: "launch_control",
    target_id: "global",
    action: enabled ? "kill_switch_lifted" : "kill_switch_activated",
    notes: null,
  });

  return res.json({ killSwitch: { enabled, record: data } });
});

// ── admin city-status ──────────────────────────────────────────────────────────

// GET /api/rent-a-buddy/admin/city-status
// Also accessible at /api/admin/rent-a-buddy/city-status via app.ts URL alias
router.get("/api/rent-a-buddy/admin/city-status", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: profile } = await serviceClient.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  const { data, error } = await serviceClient
    .from("rent_buddy_city_rollouts")
    .select("*")
    .order("city", { ascending: true });

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ cities: data ?? [] });
});

// PATCH /api/rent-a-buddy/admin/city-status/:city
// Also accessible at /api/admin/rent-a-buddy/city-status/:city via app.ts URL alias
router.patch("/api/rent-a-buddy/admin/city-status/:city", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: profile } = await serviceClient.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  const { city } = req.params;
  const { status, notes, buddyCap } = req.body ?? {};

  if (!status) return res.status(400).json({ error: "invalid_payload", message: "status is required." });

  const { data, error } = await serviceClient
    .from("rent_buddy_city_rollouts")
    .update({
      status,
      notes: notes ?? null,
      buddy_cap: buddyCap ?? null,
      status_changed_at: new Date().toISOString(),
      status_changed_by: auth.user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("city", city)
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: auth.user.id,
    target_type: "city",
    target_id: city,
    action: `city_status_set_${status}`,
    notes: notes ?? null,
  });

  return res.json({ city: data });
});

// ── admin category-status ──────────────────────────────────────────────────────

// GET /api/rent-a-buddy/admin/category-status
// Also accessible at /api/admin/rent-a-buddy/category-status via app.ts URL alias
router.get("/api/rent-a-buddy/admin/category-status", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: profile } = await serviceClient.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  // Category-level controls live in rent_buddy_launch_controls where category IS NOT NULL
  const { data, error } = await serviceClient
    .from("rent_buddy_launch_controls")
    .select("*")
    .not("category", "is", null)
    .order("category", { ascending: true });

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ categories: data ?? [] });
});

// PATCH /api/rent-a-buddy/admin/category-status/:category
// Also accessible at /api/admin/rent-a-buddy/category-status/:category via app.ts URL alias
router.patch("/api/rent-a-buddy/admin/category-status/:category", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: profile } = await serviceClient.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  const { category } = req.params;
  const { enabled, notes } = req.body ?? {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "invalid_payload", message: "enabled (boolean) is required." });
  }

  const { data, error } = await serviceClient
    .from("rent_buddy_launch_controls")
    .upsert(
      {
        country_code: null,
        city: null,
        category,
        enabled,
        notes: notes ?? null,
        created_by: auth.user.id,
      },
      { onConflict: "country_code,city,category" }
    )
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: auth.user.id,
    target_type: "category",
    target_id: category,
    action: enabled ? `category_enabled` : `category_disabled`,
    notes: notes ?? null,
  });

  return res.json({ category: data });
});

// ── admin dispute resolution ───────────────────────────────────────────────────

// POST /api/rent-a-buddy/admin/bookings/:bookingId/resolve-dispute
// Also accessible at /api/admin/buddy-bookings/:bookingId/resolve-dispute via app.ts URL alias
router.post("/api/rent-a-buddy/admin/bookings/:bookingId/resolve-dispute", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: profile } = await serviceClient.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  const { bookingId } = req.params;
  const { resolution, note, favorTraveler } = req.body ?? {};

  if (!resolution) {
    return res.status(400).json({ error: "invalid_payload", message: "resolution is required." });
  }

  // Resolve the dispute row
  const { data: dispute, error: dErr } = await serviceClient
    .from("rent_buddy_disputes")
    .update({
      status: "resolved",
      resolution_note: note ?? resolution,
      resolved_at: new Date().toISOString(),
    })
    .eq("booking_id", bookingId)
    .in("status", ["open", "reviewing"])
    .select()
    .single();

  if (dErr || !dispute) return res.status(404).json({ error: "dispute_not_found", message: dErr?.message });

  // Update booking status based on resolution
  const newBookingStatus = favorTraveler === true ? "cancelled" : "completed";
  await serviceClient
    .from("rent_buddy_bookings")
    .update({ status: newBookingStatus, updated_at: new Date().toISOString() })
    .eq("id", bookingId);

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: auth.user.id,
    target_type: "dispute",
    target_id: (dispute as any).id,
    action: "dispute_resolved",
    notes: note ?? resolution,
    details: { bookingId, favorTraveler: favorTraveler ?? null },
  });

  return res.json({ dispute, resolution, bookingStatus: newBookingStatus });
});

// ── admin city-status POST variant ────────────────────────────────────────────

// POST /api/rent-a-buddy/admin/city-status/:city
// POST alias required by spec in addition to PATCH variant.
// Also accessible at /api/admin/rent-a-buddy/city-status/:city via app.ts URL alias
router.post("/api/rent-a-buddy/admin/city-status/:city", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  const { data: profile } = await serviceClient.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  const { city } = req.params;
  const { status, notes, buddyCap } = req.body ?? {};
  if (!status) return res.status(400).json({ error: "invalid_payload", message: "status is required." });

  const { data, error } = await serviceClient
    .from("rent_buddy_city_rollouts")
    .update({
      status,
      notes: notes ?? null,
      buddy_cap: buddyCap ?? null,
      status_changed_at: new Date().toISOString(),
      status_changed_by: auth.user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("city", city)
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: auth.user.id, target_type: "city", target_id: city,
    action: `city_status_set_${status}`, notes: notes ?? null,
  });
  return res.json({ city: data });
});

// ── admin category-status POST variant ────────────────────────────────────────

// POST /api/rent-a-buddy/admin/category-status/:category
// POST alias required by spec in addition to PATCH variant.
// Also accessible at /api/admin/rent-a-buddy/category-status/:category via app.ts URL alias
router.post("/api/rent-a-buddy/admin/category-status/:category", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  const { data: profile } = await serviceClient.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  const { category } = req.params;
  const { enabled, notes } = req.body ?? {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "invalid_payload", message: "enabled (boolean) is required." });
  }

  const { data, error } = await serviceClient
    .from("rent_buddy_launch_controls")
    .upsert(
      { country_code: null, city: null, category, enabled, notes: notes ?? null, created_by: auth.user.id },
      { onConflict: "country_code,city,category" }
    )
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: auth.user.id, target_type: "category", target_id: category,
    action: enabled ? "category_enabled" : "category_disabled", notes: notes ?? null,
  });
  return res.json({ category: data });
});

// ── admin payout hold / release ────────────────────────────────────────────────

// POST /api/rent-a-buddy/admin/payouts/:payoutId/hold
// Also accessible at /api/admin/buddy-payouts/:payoutId/hold via app.ts URL alias
router.post("/api/rent-a-buddy/admin/payouts/:payoutId/hold", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  const { data: profile } = await serviceClient.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  const { payoutId } = req.params;
  const { reason } = req.body ?? {};

  const { data, error } = await serviceClient
    .from("rent_buddy_payouts")
    .update({
      status: "on_hold",
      hold_reason: reason ?? null,
      held_by: auth.user.id,
      held_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", payoutId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: "not_found", message: error?.message });

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: auth.user.id,
    target_type: "payout",
    target_id: payoutId,
    action: "payout_held",
    notes: reason ?? null,
  });

  return res.json({ payout: data });
});

// POST /api/rent-a-buddy/admin/payouts/:payoutId/release
// Also accessible at /api/admin/buddy-payouts/:payoutId/release via app.ts URL alias
router.post("/api/rent-a-buddy/admin/payouts/:payoutId/release", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  const { data: profile } = await serviceClient.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  const { payoutId } = req.params;
  const { notes } = req.body ?? {};

  const { data, error } = await serviceClient
    .from("rent_buddy_payouts")
    .update({
      status: "released",
      released_by: auth.user.id,
      released_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", payoutId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: "not_found", message: error?.message });

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: auth.user.id,
    target_type: "payout",
    target_id: payoutId,
    action: "payout_released",
    notes: notes ?? null,
  });

  return res.json({ payout: data });
});

export default router;
