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

router.get("/api/buddies/:buddyId/services", async (req, res) => {
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

router.get("/api/buddies/:buddyId/availability-exceptions", async (req, res) => {
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

export default router;
