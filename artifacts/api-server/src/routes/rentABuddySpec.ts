import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
// requireRentBuddyEnabled is the lane's ONE master-switch guard, defined in
// rentABuddy.ts (which already gates its own 70 handlers with it). Imported
// rather than re-implemented so this router cannot drift from the meaning of
// `rent_buddy_enabled`. See its doc comment for why admin routes are exempt.
import { findBlockingAvailabilityException, sendBuddyUnavailable, getUserLimits, deriveServiceCountry, resolveLaunchControlFromRows, requireRentBuddyEnabled } from "./rentABuddy.js";
import { adjustBuddyCounter } from "../services/rentBuddy/ReliabilityCounters.js";
import { requireBookingKyc } from "../lib/rentBuddyKycGate.js";
import { TRAINING_CHECKLIST_ITEMS } from "./rentABuddy.js";
import { isKillSwitchEngaged } from "../lib/featureFlags.js";
import { checkRentBuddyAccess } from "./rentABuddyRollout.js";
import { loadTravelerIdentity } from "../lib/travelerVerification.js";
import { isPrivateLocation } from "../lib/rentaBuddyScanner.js";
import { normalizeLaunchControlKey, upsertLaunchControlRow } from "../lib/rentBuddyLaunchControls.js";
import { createEarningsLedgerEntry } from "../lib/rentBuddyEarningsLedger.js";

const router = Router();

function sc(fallback?: any) {
  return getServiceClient() ?? fallback;
}

// ── Launch-control resolution (A1) ─────────────────────────────────────────────
// The shorthand loads every launch control once and resolves precedence with the
// SHARED resolver exported from rentABuddy.ts (resolveLaunchControlFromRows), so
// "which control applies" can never drift from the canonical booking path. This
// in-memory form also avoids the `.is("col", null)` builder call that several
// route paths' fakes do not implement.

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

router.get("/rent-a-buddy/buddies/:buddyId/services", asyncHandler(async (req, res) => {
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
}));

router.get("/rent-a-buddy/buddies/:buddyId/availability-exceptions", asyncHandler(async (req, res) => {
  // SEC-03: require auth and exclude the free-text `reason` (health/personal
  // details). Previously this was unauthenticated and select("*") leaked the
  // reason to any anonymous caller. Availability dates/times stay visible (they
  // are functional booking info); only the private reason is withheld.
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc();
  if (!serviceClient) return res.json({ exceptions: [] });

  const { from, to } = req.query as Record<string, string | undefined>;
  let query = serviceClient
    .from("buddy_availability_exceptions")
    .select("id, buddy_id, exception_date, end_date, exception_type, start_time, end_time, created_at, updated_at")
    .eq("buddy_id", req.params.buddyId)
    .order("exception_date");
  if (from) query = query.gte("exception_date", from);
  if (to)   query = query.lte("exception_date", to);

  const { data, error } = await query;
  if (error) return sendError(res, "db_error", error.message);
  return res.json({ exceptions: data ?? [] });
}));

router.get("/me/buddy-services", asyncHandler(async (req, res) => {
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
}));

router.post("/me/buddy-services", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

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
}));

router.patch("/me/buddy-services/:serviceId", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

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
}));

router.delete("/me/buddy-services/:serviceId", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

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
}));

router.post("/admin/rent-a-buddy/services/:serviceId/approve", asyncHandler(async (req, res) => {
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
}));

router.post("/admin/rent-a-buddy/services/:serviceId/disable", asyncHandler(async (req, res) => {
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
}));

// ── buddy_availability_exceptions ──────────────────────────────────────────────

router.get("/me/buddy-availability-exceptions", asyncHandler(async (req, res) => {
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
}));

router.post("/me/buddy-availability-exceptions", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

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
}));

router.patch("/me/buddy-availability-exceptions/:exceptionId", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

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
}));

router.delete("/me/buddy-availability-exceptions/:exceptionId", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

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
}));

// ── buddy_booking_events read — REMOVED (dead duplicate) ──────────────────────
//
// A second `GET /rent-a-buddy/bookings/:bookingId/events` was declared here.
// routes/index.ts mounts rentABuddy BEFORE rentABuddySpec, and rentABuddy.ts
// already declares the identical method+path, so this handler was unreachable:
// no request ever entered it.
//
// It was not a harmless copy. The live handler selects an explicit column list
// and filters out events whose metadata marks them admin_only; this one did
// `select("*")` with no such filter. Editing it — including tightening it —
// changed nothing, which is exactly the trap a dead duplicate sets. Deleted
// rather than merged: the reachable handler is the stricter of the two.
//
// src/test/rentBuddyRouteShadowing.test.ts now fails if any two of the four
// Rent-a-Buddy routers declare the same method and path again.

// ── booking request shorthand ──────────────────────────────────────────────────

// POST /api/rent-a-buddy/buddies/:buddyId/request — create a booking targeting a specific buddy
// Also accessible at /api/buddies/:buddyId/request via app.ts URL alias
router.post("/rent-a-buddy/buddies/:buddyId/request", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  const { user } = auth;

  // ── Booking-creation gate stack ────────────────────────────────────────────
  // This route INSERTs a rent_buddy_bookings row, which makes it a booking
  // CREATION path, and it carried none of the gates the canonical
  // POST /rent-a-buddy/bookings applies. It is reachable from mobile as
  // /api/buddies/:buddyId/request via lib/specAliasRewrite.ts, so it was a full
  // bypass of KYC, both kill switches, the city rollout and admin user limits.
  //
  // rentBuddyKycGate.ts claims the KYC gate "is applied to BOTH insert paths".
  // There are five creation paths; before this change two were gated. That
  // sentence is what kept anyone from looking.
  //
  // Order mirrors rentABuddy.ts:1002-1050 deliberately: gate failures preempt
  // payload validation and the buddy lookup, so a caller cannot use error
  // shapes to probe which buddies exist while the feature is closed.
  if (!await requireBookingKyc(serviceClient, res)) return;

  if (await isKillSwitchEngaged(serviceClient, 'disable_rent_buddy_booking')
      || await isKillSwitchEngaged(serviceClient, 'disable_rab_bookings')) {
    return res.status(404).json({ error: 'feature_disabled', message: 'Rent-a-Buddy bookings are temporarily disabled' });
  }

  const { buddyId } = req.params;
  const {
    bookingDate, durationH, city, category, notes, groupSize,
    paymentMode = "full_in_app", meetupType, meetupLocation,
  } = req.body ?? {};
  // NOTE: `countryCode` is intentionally NOT read from the body — the service
  // country is derived server-side from the buddy (below), so the client cannot
  // assert a false country to dodge that country's launch controls.

  const rolloutAccess = await checkRentBuddyAccess({
    sc: serviceClient, userId: user.id,
    city, category, action: "book", groupSize,
  });
  if (!rolloutAccess.allowed) {
    return res.status(rolloutAccess.httpStatus).json({ error: rolloutAccess.code, message: rolloutAccess.message });
  }

  const limits = await getUserLimits(serviceClient, user.id);
  if (limits?.rent_buddy_disabled || limits?.traveler_booking_disabled) {
    return res.status(403).json({
      error: "access_limited",
      message: "Rent a Buddy access is limited while your account is under review.",
    });
  }

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

  // Verify buddy exists and is active. `country` is selected so the service
  // country can be derived server-side from the buddy (never the client body).
  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id, user_id, status, admin_status, verified, categories, country")
    .eq("id", buddyId)
    .maybeSingle();

  if (!bp) return res.status(404).json({ error: "buddy_not_found" });
  if ((bp as any).status !== "active") {
    return res.status(422).json({ error: "buddy_not_available", message: "This buddy is not currently accepting bookings." });
  }
  if ((bp as any).admin_status !== "active") {
    return res.status(422).json({ error: "buddy_suspended" });
  }

  // Self-booking guard (user_id level) — catches the case where the traveler has no profile
  // of their own but still matches the buddy's underlying user account.
  const buddyUserId: string | null = (bp as any).user_id ?? null;
  if (buddyUserId && buddyUserId === auth.user.id) {
    return res.status(409).json({ error: "self_booking_not_allowed", message: "You cannot book yourself as a Buddy." });
  }

  // Block-table enforcement — traveler must not be blocked by, or have blocked, the buddy's user.
  if (buddyUserId) {
    const [blockedByBuddy, blockedByTraveler] = await Promise.all([
      serviceClient
        .from("blocks")
        .select("id")
        .eq("blocker_id", buddyUserId)
        .eq("blocked_id", auth.user.id)
        .maybeSingle(),
      serviceClient
        .from("blocks")
        .select("id")
        .eq("blocker_id", auth.user.id)
        .eq("blocked_id", buddyUserId)
        .maybeSingle(),
    ]);
    if (blockedByBuddy.data || blockedByTraveler.data) {
      return res.status(403).json({ error: "blocked", message: "You cannot book this Buddy." });
    }
  }

  // Category availability check
  const buddyCategories: string[] = (bp as any).categories ?? [];
  if (buddyCategories.length > 0 && !buddyCategories.includes(category)) {
    return res.status(422).json({ error: "category_not_offered", message: `This buddy does not offer the '${category}' category.` });
  }

  // ── A1: Launch-control gate (age / ID / phone / full-payment) ───────────────
  // This shorthand alias INSERTs a booking but never enforced launch controls,
  // so a traveler blocked on the canonical POST /rent-a-buddy/bookings by the
  // age gate (min_age / nightlife_min_age), require_id_verification,
  // require_phone_verification or full_payment_required could still book here.
  // Mirror of rentABuddy.ts:1079-1116, powered by the SHARED resolver and the
  // server-derived service country. Additive: when no launch control matches
  // nothing changes for a compliant traveler.
  const serviceCountry = deriveServiceCountry(bp);
  {
    const { data: launchRows } = await serviceClient
      .from("rent_buddy_launch_controls")
      .select("*");

    // Fail closed on unresolved country — same invariant as the canonical gate
    // (rentABuddy.ts:1098-1111). Now that the country is server-derived and
    // reliable, refuse rather than seat a booking under unknown country policy
    // whenever ANY launch control is configured.
    if (!serviceCountry && (launchRows ?? []).length > 0) {
      return res.status(400).json({
        error: "invalid_payload",
        message: "This buddy has no registered country, so booking policy cannot be verified for this location.",
      });
    }

    const launchCtrl = resolveLaunchControlFromRows(launchRows ?? [], {
      city, countryCode: serviceCountry ?? undefined, category,
    });
    if (launchCtrl) {
      if (!launchCtrl.enabled) {
        return launchCtrl.waitlistOnly
          ? res.status(403).json({ error: "waitlist_only", message: "Rent a Buddy bookings for this location are currently waitlist-only. Join the waitlist to be notified when it opens." })
          : res.status(403).json({ error: "location_unavailable", message: "Rent a Buddy is not yet available in this location or category." });
      }
      // Traveller identity comes from `profiles`, NOT rent_buddy_profiles.
      const travIdentity = await loadTravelerIdentity(serviceClient, auth.user.id);
      if (launchCtrl.requireIdVerification && !travIdentity.idVerified) {
        return res.status(403).json({ error: "verification_required", message: "ID verification is required to book in this location. Please verify your ID to continue." });
      }
      if (launchCtrl.requirePhoneVerification && !travIdentity.phoneVerified) {
        return res.status(403).json({ error: "verification_required", message: "Phone verification is required to book in this location. Please verify your phone number to continue." });
      }
      // Missing DOB is an explicit block — age cannot be verified without it.
      if (travIdentity.age === null) {
        return res.status(403).json({ error: "age_verification_required", message: "Date of birth verification is required to make a booking in this location." });
      }
      const minAge = category === "nightlife" ? launchCtrl.nightlifeMinAge : launchCtrl.minAge;
      if (travIdentity.age < minAge) {
        return res.status(403).json({
          error: "age_requirement",
          message: category === "nightlife"
            ? `Nightlife bookings require you to be at least ${minAge} years old.`
            : `You must be at least ${minAge} years old to book in this location.`,
        });
      }
      if (launchCtrl.fullPaymentRequired && paymentMode !== "full_in_app") {
        return res.status(403).json({ error: "payment_mode_required", message: "Full in-app payment is required for this location." });
      }
    }

    // ── C1: per-user forced public meetup ─────────────────────────────────────
    // rent_buddy_user_limits.public_meetup_required is written by the auto-
    // restriction / admin-PATCH / force-public-meetup paths but no booking path
    // read it, so a user restricted to public meetups could still book a private
    // one here. Fail closed: a restricted user must affirmatively declare a
    // public meetup (the public-meetup form), or the booking is refused.
    if (limits?.public_meetup_required) {
      const declaredType: string | null =
        (typeof meetupType === "string" ? meetupType : null) ??
        (meetupLocation && typeof meetupLocation === "object" ? ((meetupLocation as any).type ?? null) : null);
      const meetupText: string | null = typeof meetupLocation === "string" ? meetupLocation : null;
      const declaresPublicMeetup =
        declaredType === "public" && !(meetupText != null && isPrivateLocation(meetupText));
      if (!declaresPublicMeetup) {
        return res.status(403).json({
          error: "public_meetup_required",
          message: "Your account requires all Rent a Buddy meetups to start at a public location. Please book using the public-meetup option.",
        });
      }
    }
  }

  // Blocked/vacation date enforcement
  const blocking = await findBlockingAvailabilityException(serviceClient, buddyId, bookingDate);
  if (blocking) return sendBuddyUnavailable(res, blocking.exception_type);

  const now = new Date().toISOString();
  const { data, error } = await serviceClient
    .from("rent_buddy_bookings")
    .insert({
      traveler_id: auth.user.id,
      buddy_id: buddyId,
      booking_date: bookingDate,
      duration_h: durationH,
      city,
      country_code: serviceCountry,
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

  // Estimated earnings-ledger row — the third of the three booking-creation
  // paths that never wrote one. See lib/rentBuddyEarningsLedger.ts.
  if (data) await createEarningsLedgerEntry(serviceClient, data, buddyId).catch(() => {});

  return res.status(201).json({ booking: data });
}));

// ── safety check-in ────────────────────────────────────────────────────────────

// POST /api/rent-a-buddy/bookings/:bookingId/check-in
// Also accessible at /api/buddy-bookings/:bookingId/check-in via URL alias
router.post("/rent-a-buddy/bookings/:bookingId/check-in", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

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
}));

// GET /api/rent-a-buddy/bookings/:bookingId/safety-checkins
// Also accessible at /api/buddy-bookings/:bookingId/safety-checkins via URL alias
// Returns the full check-in history for a booking. Only the traveler and the
// buddy on the booking may access this data; all other callers receive 403.
router.get("/rent-a-buddy/bookings/:bookingId/safety-checkins", asyncHandler(async (req, res) => {
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
    .from("rent_buddy_safety_checkins")
    .select("*")
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: true });

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ checkins: data ?? [] });
}));

// GET /api/rent-a-buddy/bookings/:bookingId/safety-events
// Also accessible at /api/buddy-bookings/:bookingId/safety-events via URL alias
// Returns the safety event history for a booking. Only the traveler and the
// buddy on the booking may access this data; all other callers receive 403.
router.get("/rent-a-buddy/bookings/:bookingId/safety-events", asyncHandler(async (req, res) => {
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
    .from("rent_buddy_safety_events")
    .select("*")
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: true });

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ safetyEvents: data ?? [] });
}));

// ── report no-show ─────────────────────────────────────────────────────────────

// POST /api/rent-a-buddy/bookings/:bookingId/report-no-show
// Also accessible at /api/buddy-bookings/:bookingId/report-no-show via URL alias
router.post("/rent-a-buddy/bookings/:bookingId/report-no-show", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { notes } = req.body ?? {};
  const nowMs = Date.now();

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

  // Reject if the booking is already in a terminal or no-show/disputed state.
  // completed and cancelled are final — a no-show report would corrupt the booking's end state.
  if (
    b.status === "no_show_pending" ||
    b.status === "disputed" ||
    b.status === "completed" ||
    b.status === "cancelled"
  ) {
    return res.status(409).json({ error: "already_reported", status: b.status });
  }

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
      created_at: new Date(nowMs).toISOString(),
    })
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);

  // Enter a 2-hour grace period so the other party can respond before escalation.
  // The expiry sweeper promotes no_show_pending → disputed after the window closes.
  const now = new Date(nowMs).toISOString();
  const graceExpiry = new Date(nowMs + 2 * 3600 * 1000).toISOString();

  const { error: updateError } = await serviceClient
    .from("rent_buddy_bookings")
    .update({ status: "no_show_pending", no_show_grace_expires_at: graceExpiry, updated_at: now })
    .eq("id", bookingId);

  if (updateError) return sendError(res, "db_error", updateError.message);

  return res.status(201).json({ safetyEvent: data, gracePeriodExpiresAt: graceExpiry });
}));

// NOTE: change-request, respond-change-request, and rebook were removed from
// this file. The canonical implementations live in rentABuddy.ts at
// /api/rent-a-buddy/bookings/:bookingId/{change-request,respond-change-request,rebook}
// and enforce blocked dates via findBlockingAvailabilityException. The mobile
// client's /api/buddy-bookings/* URLs reach them through the specAliasRewrite
// middleware in app.ts.

// ── me/buddy-bookings explicit (also covered by app.ts URL alias) ──────────────

// GET /api/me/buddy-bookings — traveler's own bookings list (explicit route)
router.get("/me/buddy-bookings", asyncHandler(async (req, res) => {
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
}));

// ── admin spec routes ───────────────────────────────────────────────────────────

// GET /api/rent-a-buddy/admin/buddies/pending
// Also accessible at /api/admin/buddies/pending via URL alias
// Must be registered before the parameterized /:buddyId routes in this router.
router.get("/rent-a-buddy/admin/buddies/pending", asyncHandler(async (req, res) => {
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
}));

// POST /api/rent-a-buddy/admin/buddies/:buddyId/approve
// Also accessible at /api/admin/buddies/:buddyId/approve via URL alias
router.post("/rent-a-buddy/admin/buddies/:buddyId/approve", asyncHandler(async (req, res) => {
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

  // ── Safety-training gate ────────────────────────────────────────────────────
  // This handler used to set admin_status and status to "active" with no checks
  // at all. That pair is exactly what every search and booking gate reads, so
  // this was a second door into a listable, bookable buddy that bypassed the
  // 10-item safety training the OTHER approval door hard-blocks on
  // (rentABuddy.ts, PATCH /admin/applications/:appId).
  //
  // Keyed on the checklist table rather than rent_buddy_profiles.training_completed,
  // for the same reason the guarded door is: the checklist is written per
  // application_id, whereas training_completed is updated by user_id and silently
  // affects zero rows if the profile did not exist when the last item was ticked.
  //
  // FAILS CLOSED when the buddy has no application. That is not merely
  // conservative — the only writer of the checklist table refuses to record
  // anything without an application row, so "no application" is positive proof
  // that training was never completed. The admin's remedy is cheap: have the
  // buddy apply and tick the items, after which either door works.
  {
    const { data: prof } = await serviceClient
      .from("rent_buddy_profiles")
      .select("user_id")
      .eq("id", buddyId)
      .maybeSingle();
    const buddyUserId = (prof as any)?.user_id ?? null;
    if (!buddyUserId) return res.status(404).json({ error: "not_found" });

    const { data: app } = await serviceClient
      .from("rent_buddy_applications")
      .select("id")
      .eq("user_id", buddyUserId)
      .maybeSingle();
    const appId = (app as any)?.id ?? null;

    let trainedCount = 0;
    if (appId) {
      const { count } = await serviceClient
        .from("rent_buddy_training_checklist")
        .select("id", { count: "exact" })
        .eq("application_id", appId)
        .eq("completed", true);
      trainedCount = count ?? 0;
    }
    if (trainedCount < TRAINING_CHECKLIST_ITEMS.length) {
      return res.status(400).json({
        error: "training_incomplete",
        message: "Applicant must complete all required training before being approved as a Buddy.",
      });
    }
  }

  const { data, error } = await serviceClient
    .from("rent_buddy_profiles")
    .update({
      admin_status: "active",
      status: "active",
      training_completed: true,
      updated_at: new Date().toISOString(),
    })
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
}));

// POST /api/rent-a-buddy/admin/buddies/:buddyId/reject
// Also accessible at /api/admin/buddies/:buddyId/reject via URL alias
router.post("/rent-a-buddy/admin/buddies/:buddyId/reject", asyncHandler(async (req, res) => {
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

  // `status` is written alongside admin_status. Previously only admin_status was
  // set, so rejecting an already-active profile left status:"active" — and the
  // status-only helper requireBuddyProfile treats that as bookable, meaning a
  // rejected buddy stayed live to any surface that checks status alone.
  const { data, error } = await serviceClient
    .from("rent_buddy_profiles")
    .update({ admin_status: "rejected", status: "rejected", updated_at: new Date().toISOString() })
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
}));

// POST /api/rent-a-buddy/admin/buddies/:buddyId/unsuspend
// Also accessible at /api/admin/buddies/:buddyId/unsuspend via URL alias
// Semantic alias for reactivate (both set admin_status → active).
router.post("/rent-a-buddy/admin/buddies/:buddyId/unsuspend", asyncHandler(async (req, res) => {
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
}));

// ── favorite / unfavorite ──────────────────────────────────────────────────────

// POST /api/rent-a-buddy/buddies/:buddyId/favorite
// Also accessible at /api/buddies/:buddyId/favorite via app.ts URL alias
router.post("/rent-a-buddy/buddies/:buddyId/favorite", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;
  const { buddyId } = req.params;

  const { error } = await serviceClient
    .from("rent_buddy_saved")
    .upsert({ user_id: auth.user.id, buddy_id: buddyId }, { onConflict: "user_id,buddy_id" });

  if (error) return sendError(res, "db_error", error.message);
  return res.status(201).json({ saved: true, buddyId });
}));

// POST /api/rent-a-buddy/buddies/:buddyId/unfavorite — POST method alias for clients that
// cannot issue DELETE requests (e.g. some mobile HTTP stacks).
// Also accessible at /api/buddies/:buddyId/unfavorite via app.ts URL alias
router.post("/rent-a-buddy/buddies/:buddyId/unfavorite", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;
  const { buddyId } = req.params;
  const { error } = await serviceClient
    .from("rent_buddy_saved")
    .delete()
    .eq("user_id", auth.user.id)
    .eq("buddy_id", buddyId);
  if (error) return sendError(res, "db_error", error.message);
  return res.status(200).json({ saved: false, buddyId });
}));

// DELETE /api/rent-a-buddy/buddies/:buddyId/unfavorite
// Also accessible at /api/buddies/:buddyId/unfavorite via app.ts URL alias
router.delete("/rent-a-buddy/buddies/:buddyId/unfavorite", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;
  const { buddyId } = req.params;

  const { error } = await serviceClient
    .from("rent_buddy_saved")
    .delete()
    .eq("user_id", auth.user.id)
    .eq("buddy_id", buddyId);

  if (error) return sendError(res, "db_error", error.message);
  return res.status(200).json({ saved: false, buddyId });
}));

// ── buddy profile lifecycle (me) ───────────────────────────────────────────────

// GET /api/rent-a-buddy/me/profile/checklist
// Also accessible at /api/me/buddy-profile/checklist via app.ts URL alias
//
// Returns per-field completion status derived from real DB state.
// Response shape: { checklist: ChecklistItem[], allComplete: boolean }
// where ChecklistItem = { key, label, done, verificationRequired? }
//
// "verification" item is only present (and blocks allComplete) when one or more
// of the buddy's categories requires ID verification to go live.
router.get("/rent-a-buddy/me/profile/checklist", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: profile } = await serviceClient
    .from("rent_buddy_profiles")
    .select(
      "id, display_name, bio, categories, languages, hourly_rate_usd, " +
      "availability_blocks, policy_accepted, safety_acknowledged_at, " +
      "boundaries_acknowledged_at, cover_photo_url, gallery_urls, " +
      "preferred_meetup_zones, verification_status, city, country"
    )
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (!profile) {
    return res.status(404).json({ error: "profile_not_found", message: "No buddy profile found." });
  }

  const p = profile as any;

  // Parallel DB lookups: availability rows + active services + verification controls
  const [availResult, servicesResult, controlsResult] = await Promise.all([
    serviceClient
      .from("rent_buddy_availability")
      .select("id", { count: "exact" })
      .eq("buddy_id", p.id)
      .limit(1),
    serviceClient
      .from("buddy_services")
      .select("id", { count: "exact" })
      .eq("buddy_id", p.id)
      .eq("is_active", true)
      .limit(1),
    serviceClient
      .from("rent_buddy_launch_controls")
      .select("city, country_code, category, require_id_verification"),
  ]);

  const hasAvailability =
    (Array.isArray(p.availability_blocks) && p.availability_blocks.length > 0) ||
    (availResult.count ?? 0) > 0;

  const hasServices = (servicesResult.count ?? 0) > 0;
  const hasPhoto = (typeof p.cover_photo_url === "string" && p.cover_photo_url.trim().length > 0) ||
    (Array.isArray(p.gallery_urls) && p.gallery_urls.length > 0);
  const hasAreas = Array.isArray(p.preferred_meetup_zones) && p.preferred_meetup_zones.length > 0;
  const hasPricing = p.hourly_rate_usd != null && Number(p.hourly_rate_usd) > 0;

  const categories: string[] = Array.isArray(p.categories) ? p.categories : [];

  // Verification policy — scoped to the buddy's city, country AND categories.
  // A control is applicable when all three dimensions match (NULL = wildcard):
  //   city match: control.city === null OR control.city === profile.city
  //   country match: control.country_code === null OR control.country_code === profile.country
  //   category match: control.category === null OR control.category is in profile.categories
  // If any applicable control has require_id_verification=true, verification is required.
  // Falls back gracefully when the table is empty or query fails.
  const buddyCity: string | null = p.city ?? null;
  const buddyCountry: string | null = p.country ?? null;
  const needsVerification = (controlsResult.data ?? []).some((c: any) => {
    if (!c.require_id_verification) return false;
    const cityMatch = c.city === null || c.city === buddyCity;
    const countryMatch = c.country_code === null || c.country_code === buddyCountry;
    const catMatch = c.category === null || categories.includes(c.category);
    return cityMatch && countryMatch && catMatch;
  });
  const isVerified = p.verification_status === "verified";

  const checklist: Array<{ key: string; label: string; done: boolean; verificationRequired?: boolean }> = [
    {
      key: "display_name",
      label: "Set your display name",
      done: typeof p.display_name === "string" && p.display_name.trim().length > 0,
    },
    {
      key: "bio",
      label: "Write your bio (min 30 characters)",
      done: typeof p.bio === "string" && p.bio.trim().length >= 30,
    },
    {
      key: "photo",
      label: "Add at least one profile photo",
      done: hasPhoto,
    },
    {
      key: "categories",
      label: "Choose at least one category",
      done: categories.length > 0,
    },
    {
      key: "services",
      label: "Add at least one service offering",
      done: hasServices,
    },
    {
      key: "areas",
      label: "Set your preferred meetup areas",
      done: hasAreas,
    },
    {
      key: "languages",
      label: "Add the languages you speak",
      done: Array.isArray(p.languages) && p.languages.length > 0,
    },
    {
      key: "pricing",
      label: "Set your hourly rate",
      done: hasPricing,
    },
    {
      key: "availability",
      label: "Set your weekly availability",
      done: hasAvailability,
    },
    {
      key: "policy_accepted",
      label: "Accept the Buddy policy",
      done: p.policy_accepted === true,
    },
    {
      key: "safety_acknowledged",
      label: "Read and confirm the safety guidelines",
      done: p.safety_acknowledged_at != null,
    },
    {
      key: "boundaries_acknowledged",
      label: "Read and confirm the conduct & boundaries policy",
      done: p.boundaries_acknowledged_at != null,
    },
  ];

  // Only surface the verification item when it blocks this profile
  if (needsVerification) {
    checklist.push({
      key: "verification",
      label: "Complete ID verification (required by category policy)",
      done: isVerified,
      verificationRequired: true,
    });
  }

  const allComplete = checklist.every((i) => i.done);

  // Object-style per-field completion — stable contract shape; all keys always present.
  // `checklist` is kept for UI rendering; `fields` is the canonical machine-readable map.
  const fields: Record<string, boolean> = {};
  for (const item of checklist) {
    fields[item.key] = item.done;
  }
  // Normalise key names to match spec (safety_ack / policy_ack)
  fields.safety_ack = fields.safety_acknowledged ?? false;
  fields.policy_ack = fields.policy_accepted ?? false;
  delete fields.safety_acknowledged;
  delete fields.policy_accepted;
  // `verification` is always present: false when not required (no-op for clients in those cities),
  // true only when the policy requires AND the buddy has passed verification.
  fields.verification = needsVerification ? isVerified : true;

  return res.json({ checklist, allComplete, fields });
}));

// POST /api/rent-a-buddy/me/profile/submit — finalize and submit profile for review
// Also accessible at /api/me/buddy-profile/submit via app.ts URL alias
//
// Body (optional):
//   acceptSafety:     boolean — records safety_acknowledged_at on this call
//   acceptBoundaries: boolean — records boundaries_acknowledged_at on this call
//
// Returns 422 { error: "incomplete_profile", missing: [...] } if any required fields
// are empty. All fields must be filled before the profile can enter review.
// Returns 422 { error: "verification_required", verification_status } if a
// restricted category (e.g. nightlife) requires ID verification first.
router.post("/rent-a-buddy/me/profile/submit", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: profile } = await serviceClient
    .from("rent_buddy_profiles")
    .select(
      "id, status, admin_status, display_name, bio, categories, languages, " +
      "hourly_rate_usd, availability_blocks, policy_accepted, " +
      "safety_acknowledged_at, boundaries_acknowledged_at, " +
      "cover_photo_url, gallery_urls, preferred_meetup_zones, verification_status, " +
      "city, country"
    )
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (!profile) return res.status(404).json({ error: "profile_not_found", message: "No buddy profile found. Apply first." });

  const p = profile as any;
  // draft, pending, and paused profiles can all be submitted/re-submitted for review.
  // approved/rejected/suspended are terminal states that require an admin action first.
  if (!["draft", "pending", "paused"].includes(p.status)) {
    return res.status(409).json({ error: "invalid_state", message: `Profile in '${p.status}' state cannot be submitted for review.` });
  }

  // Accept acknowledgments passed in the submit body
  const { acceptSafety, acceptBoundaries } = req.body ?? {};
  const now = new Date().toISOString();
  const safetyAck = p.safety_acknowledged_at ?? (acceptSafety ? now : null);
  const boundariesAck = p.boundaries_acknowledged_at ?? (acceptBoundaries ? now : null);

  // Parallel DB lookups: availability rows + active services
  const [availResult, servicesResult] = await Promise.all([
    serviceClient
      .from("rent_buddy_availability")
      .select("id", { count: "exact" })
      .eq("buddy_id", p.id)
      .limit(1),
    serviceClient
      .from("buddy_services")
      .select("id", { count: "exact" })
      .eq("buddy_id", p.id)
      .eq("is_active", true)
      .limit(1),
  ]);

  const hasAvailability =
    (Array.isArray(p.availability_blocks) && p.availability_blocks.length > 0) ||
    (availResult.count ?? 0) > 0;
  const hasServices = (servicesResult.count ?? 0) > 0;
  const hasPhoto = (typeof p.cover_photo_url === "string" && p.cover_photo_url.trim().length > 0) ||
    (Array.isArray(p.gallery_urls) && p.gallery_urls.length > 0);
  const hasAreas = Array.isArray(p.preferred_meetup_zones) && p.preferred_meetup_zones.length > 0;

  // 422 gate — collect all missing required fields
  const missing: string[] = [];
  if (!(typeof p.display_name === "string" && p.display_name.trim().length > 0)) missing.push("display_name");
  if (!(typeof p.bio === "string" && p.bio.trim().length >= 30)) missing.push("bio");
  if (!hasPhoto) missing.push("photo");
  if (!(Array.isArray(p.categories) && p.categories.length > 0)) missing.push("categories");
  if (!hasServices) missing.push("services");
  if (!hasAreas) missing.push("areas");
  if (!(Array.isArray(p.languages) && p.languages.length > 0)) missing.push("languages");
  if (!(p.hourly_rate_usd != null && Number(p.hourly_rate_usd) > 0)) missing.push("pricing");
  if (!hasAvailability) missing.push("availability");
  if (!p.policy_accepted) missing.push("policy_accepted");
  if (!safetyAck) missing.push("safety_acknowledged");
  if (!boundariesAck) missing.push("boundaries_acknowledged");

  if (missing.length > 0) {
    return res.status(422).json({
      error: "incomplete_profile",
      message: "Profile is missing required fields before it can be submitted for review.",
      missing,
    });
  }

  // Verification gate — scoped to the buddy's city, country AND categories.
  // Uses the same NULL-wildcard logic as the checklist endpoint:
  //   city match: control.city === null OR control.city === profile.city
  //   country match: control.country_code === null OR control.country_code === profile.country
  //   category match: control.category === null OR control.category is in profile.categories
  // Falls back to false when the table is empty or query fails.
  const cats: string[] = Array.isArray(p.categories) ? p.categories : [];
  const submitCity: string | null = p.city ?? null;
  const submitCountry: string | null = p.country ?? null;
  const { data: allControls } = await serviceClient
    .from("rent_buddy_launch_controls")
    .select("city, country_code, category, require_id_verification");
  const needsVerification = (allControls ?? []).some((c: any) => {
    if (!c.require_id_verification) return false;
    const cityMatch = c.city === null || c.city === submitCity;
    const countryMatch = c.country_code === null || c.country_code === submitCountry;
    const catMatch = c.category === null || cats.includes(c.category);
    return cityMatch && countryMatch && catMatch;
  });
  if (needsVerification && p.verification_status !== "verified") {
    return res.status(422).json({
      error: "verification_required",
      message: "ID verification is required by your category policy before this profile can be submitted for review. Please complete your verification first.",
      verification_status: p.verification_status ?? "unverified",
    });
  }

  const patch: Record<string, unknown> = {
    status: "pending",
    admin_status: "pending_review",
    updated_at: now,
  };
  if (acceptSafety && !p.safety_acknowledged_at) patch.safety_acknowledged_at = now;
  if (acceptBoundaries && !p.boundaries_acknowledged_at) patch.boundaries_acknowledged_at = now;

  const { data, error } = await serviceClient
    .from("rent_buddy_profiles")
    .update(patch)
    .eq("id", p.id)
    .select()
    .single();

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ profile: data });
}));

// POST /api/rent-a-buddy/me/profile/pause — pause an active buddy profile
// Also accessible at /api/me/buddy-profile/pause via app.ts URL alias
router.post("/rent-a-buddy/me/profile/pause", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

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
}));

// POST /api/rent-a-buddy/me/profile/resume — resume a paused buddy profile
// Also accessible at /api/me/buddy-profile/resume via app.ts URL alias
router.post("/rent-a-buddy/me/profile/resume", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

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
}));

// ── admin kill-switch ──────────────────────────────────────────────────────────

// POST /api/rent-a-buddy/admin/kill-switch
// Also accessible at /api/admin/rent-a-buddy/kill-switch via app.ts URL alias
// Toggles or sets the global rent-a-buddy kill switch (disables all bookings globally).
router.post("/rent-a-buddy/admin/kill-switch", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);

  const { data: profile } = await serviceClient.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  const { enabled } = req.body ?? {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "invalid_payload", message: "enabled (boolean) is required." });
  }

  // Write the GLOBAL launch control (country_code=NULL, city=NULL, category=NULL).
  //
  // NOT `.upsert(..., { onConflict: "country_code,city,category" })`. That is what
  // stood here, and against this table's plain `UNIQUE (country_code, city,
  // category)` — NULLS DISTINCT — the ON CONFLICT arbiter never matched a row
  // whose key is all-NULL. Every press INSERTed another global row: the switch
  // could be pressed but never lifted, and the duplicated key then made the
  // global control unreadable to getLaunchControl. See lib/rentBuddyLaunchControls.ts.
  const { data, error } = await upsertLaunchControlRow(
    serviceClient,
    normalizeLaunchControlKey({}),
    {
      enabled,
      notes: enabled ? "Kill switch lifted by admin" : "Kill switch activated by admin",
    },
    auth.user.id,
  );

  if (error) return sendError(res, "db_error", (error as any).message ?? String(error));

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: auth.user.id,
    target_type: "launch_control",
    target_id: "global",
    action: enabled ? "kill_switch_lifted" : "kill_switch_activated",
    notes: null,
  });

  return res.json({ killSwitch: { enabled, record: data } });
}));

// ── admin city-status ──────────────────────────────────────────────────────────

// GET /api/rent-a-buddy/admin/city-status
// Also accessible at /api/admin/rent-a-buddy/city-status via app.ts URL alias
router.get("/rent-a-buddy/admin/city-status", asyncHandler(async (req, res) => {
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
}));

// PATCH /api/rent-a-buddy/admin/city-status/:city
// Also accessible at /api/admin/rent-a-buddy/city-status/:city via app.ts URL alias
router.patch("/rent-a-buddy/admin/city-status/:city", asyncHandler(async (req, res) => {
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
}));

// ── admin category-status ──────────────────────────────────────────────────────

// GET /api/rent-a-buddy/admin/category-status
// Also accessible at /api/admin/rent-a-buddy/category-status via app.ts URL alias
router.get("/rent-a-buddy/admin/category-status", asyncHandler(async (req, res) => {
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
}));

// PATCH /api/rent-a-buddy/admin/category-status/:category
// Also accessible at /api/admin/rent-a-buddy/category-status/:category via app.ts URL alias
router.patch("/rent-a-buddy/admin/category-status/:category", asyncHandler(async (req, res) => {
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

  // NULL-safe write — see the kill-switch handler above and
  // lib/rentBuddyLaunchControls.ts for why an onConflict upsert cannot work here.
  const { data, error } = await upsertLaunchControlRow(
    serviceClient,
    normalizeLaunchControlKey({ category }),
    { enabled, notes: notes ?? null },
    auth.user.id,
  );

  if (error) return sendError(res, "db_error", (error as any).message ?? String(error));

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: auth.user.id,
    target_type: "category",
    target_id: category,
    action: enabled ? `category_enabled` : `category_disabled`,
    notes: notes ?? null,
  });

  return res.json({ category: data });
}));

// ── admin dispute resolution ───────────────────────────────────────────────────

// POST /api/rent-a-buddy/admin/bookings/:bookingId/resolve-dispute
// Also accessible at /api/admin/buddy-bookings/:bookingId/resolve-dispute via app.ts URL alias
router.post("/rent-a-buddy/admin/bookings/:bookingId/resolve-dispute", asyncHandler(async (req, res) => {
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

  // Fetch booking to get traveler_id and buddy_id for counter logic
  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("traveler_id, buddy_id, status")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });
  if ((booking as any).status !== "disputed") {
    return res.status(409).json({ error: "invalid_transition", message: "Booking is not in disputed status." });
  }

  // Capture open dispute before updating — needed for no_show_count logic below,
  // since the update response only returns the post-update row without reason/raised_by.
  const { data: openDispute } = await serviceClient
    .from("rent_buddy_disputes")
    .select("id, reason, raised_by")
    .eq("booking_id", bookingId)
    .in("status", ["open", "reviewing"])
    .maybeSingle();

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

  // ── B2: completed_count compensation ────────────────────────────────────────
  // completed_count is incremented once, at buddy-mark-complete time
  // (rentABuddy.ts), which moves the booking to
  // completed_pending_traveler_confirmation. If the traveler then disputes and
  // this resolution favours them, the booking becomes "cancelled" and that
  // earlier +1 is now wrong. Decrement to compensate — but ONLY when the booking
  // actually passed through mark-complete, evidenced by the buddy_marked_complete
  // booking event. A dispute raised from in_progress, or an end-early transition,
  // never incremented completed_count, so those must NOT be decremented.
  // (Query uses only select/eq so every route fake can resolve it; adjustBuddyCounter
  //  clamps at >= 0, so a double-resolve cannot drive the counter negative.)
  if (newBookingStatus === "cancelled") {
    const { data: completeEvents } = await serviceClient
      .from("buddy_booking_events")
      .select("id")
      .eq("booking_id", bookingId)
      .eq("event", "buddy_marked_complete");
    if (Array.isArray(completeEvents) && completeEvents.length > 0) {
      await adjustBuddyCounter(serviceClient, (booking as any).buddy_id, "completed_count", -1);
    }
  }

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: auth.user.id,
    target_type: "dispute",
    target_id: (dispute as any).id,
    action: "dispute_resolved",
    notes: note ?? resolution,
    details: { bookingId, favorTraveler: favorTraveler ?? null },
  });

  // Confirmed buddy no-show: a no_show dispute raised by the traveler, resolved
  // as cancelled (session did not happen), increments the buddy's no_show_count.
  if (
    (openDispute as any)?.reason === "no_show" &&
    newBookingStatus === "cancelled" &&
    (openDispute as any)?.raised_by === (booking as any).traveler_id
  ) {
    await adjustBuddyCounter(serviceClient, (booking as any).buddy_id, "no_show_count", 1);
  }

  return res.json({ dispute, resolution, bookingStatus: newBookingStatus });
}));

// ── me/buddy-profile — create (initial profile setup) ─────────────────────────

// POST /api/rent-a-buddy/me/profile — create (or upsert) the caller's buddy profile.
// Spec route: POST /api/me/buddy-profile → rewritten by app.ts alias to this path.
// Separate from /submit (which transitions an existing draft to pending_review).
router.post("/rent-a-buddy/me/profile", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;
  const {
    displayName, tagline, bio, city, country, categories,
    languages, hourlyRateUsd, maxGroupSize, coverPhotoUrl,
    galleryUrls, vibeTags,
  } = req.body ?? {};
  if (!displayName || !city || !country) {
    return res.status(400).json({ error: "invalid_payload", message: "displayName, city, country are required." });
  }
  const { data, error } = await serviceClient
    .from("rent_buddy_profiles")
    .upsert(
      {
        user_id: auth.user.id,
        display_name: displayName,
        tagline: tagline ?? null,
        bio: bio ?? null,
        city,
        country,
        categories: categories ?? [],
        languages: languages ?? [],
        hourly_rate_usd: hourlyRateUsd ?? null,
        max_group_size: maxGroupSize ?? 4,
        cover_photo_url: coverPhotoUrl ?? null,
        gallery_urls: galleryUrls ?? [],
        vibe_tags: vibeTags ?? [],
        status: "draft",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    )
    .select()
    .single();
  if (error) return sendError(res, "db_error", error.message);
  return res.status(201).json({ profile: data });
}));

// ── me/buddy-requests — list booking requests for me-as-buddy ──────────────────

// GET /api/me/buddy-requests — list all booking requests where the caller is the buddy.
// Also accessible at /api/rent-a-buddy/me/buddy-requests via app.ts alias.
router.get("/me/buddy-requests", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  const { status, page = "1", limit = "20" } = req.query as Record<string, string | undefined>;

  // Pagination — this route previously did select("*")+order with no bound, so
  // a busy buddy's whole booking history streamed in a single response. Cap the
  // page size and window with .range() (same shape as GET /me/buddy-bookings).
  const pageNum = Math.max(1, parseInt(page ?? "1", 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(limit ?? "20", 10)));
  const offset = (pageNum - 1) * pageSize;

  // Resolve the caller's buddy profile id
  const { data: profile } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!profile) return res.status(404).json({ error: "not_found", message: "No buddy profile found." });

  let query = serviceClient
    .from("rent_buddy_bookings")
    .select("*", { count: "exact" })
    .eq("buddy_id", profile.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (status) query = query.eq("status", status as string);

  const { data, error, count } = await query;
  if (error) return sendError(res, "db_error", error.message);
  return res.json({ requests: data ?? [], total: count ?? 0, page: pageNum, pageSize });
}));

// ── me/buddy-availability — update my availability schedule ───────────────────

// PATCH /api/me/buddy-availability — update (upsert) availability rows for the caller's buddy profile.
// Also accessible at /api/rent-a-buddy/me/availability via app.ts alias.
router.patch("/me/buddy-availability", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;
  const { slots } = req.body ?? {};
  if (!Array.isArray(slots) || slots.length === 0) {
    return res.status(400).json({ error: "invalid_payload", message: "slots (array) is required." });
  }

  const { data: profile } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!profile) return res.status(404).json({ error: "not_found", message: "No buddy profile found." });

  const rows = (slots as Array<{ date: string; timeSlots?: unknown; isAvailable?: boolean; notes?: string }>)
    .map(s => ({
      buddy_id: profile.id,
      date: s.date,
      time_slots: s.timeSlots ?? [],
      is_available: s.isAvailable ?? true,
      notes: s.notes ?? null,
    }));

  const { data, error } = await serviceClient
    .from("rent_buddy_availability")
    .upsert(rows, { onConflict: "buddy_id,date" })
    .select();
  if (error) return sendError(res, "db_error", error.message);
  return res.json({ slots: data });
}));

// ── me/buddy-availability-exceptions — collection-level PATCH ─────────────────

// PATCH /api/me/buddy-availability-exceptions — bulk-upsert availability exceptions.
// (Item-level PATCH /:exceptionId already exists above.)
router.patch("/me/buddy-availability-exceptions", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;
  const { exceptions } = req.body ?? {};
  if (!Array.isArray(exceptions) || exceptions.length === 0) {
    return res.status(400).json({ error: "invalid_payload", message: "exceptions (array) is required." });
  }

  const { data: profile } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!profile) return res.status(404).json({ error: "not_found", message: "No buddy profile found." });

  const rows = (exceptions as Array<{
    exceptionDate: string; endDate?: string; exceptionType?: string; startTime?: string; endTime?: string; reason?: string;
  }>).map(e => ({
    buddy_id: profile.id,
    exception_date: e.exceptionDate,
    end_date: e.endDate ?? null,
    exception_type: (e.exceptionType ?? "blocked") as "blocked",
    start_time: e.startTime ?? null,
    end_time: e.endTime ?? null,
    reason: e.reason ?? null,
    updated_at: new Date().toISOString(),
  }));

  const { data, error } = await serviceClient
    .from("buddy_availability_exceptions")
    .upsert(rows, { onConflict: "buddy_id,exception_date" })
    .select();
  if (error) return sendError(res, "db_error", error.message);
  return res.json({ exceptions: data });
}));

// ── admin buddy-reports ────────────────────────────────────────────────────────

// GET /api/admin/buddy-reports — list buddy safety/support reports for admin review.
// Also accessible at /api/rent-a-buddy/admin/buddy-reports via app.ts alias.
router.get("/rent-a-buddy/admin/buddy-reports", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  const { data: profile } = await serviceClient.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  const { status, limit = "50", offset = "0" } = req.query;
  let query = serviceClient
    .from("rent_buddy_disputes")
    .select("*, booking:rent_buddy_bookings(id,city,category)")
    .order("created_at", { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (status) query = query.eq("status", status as string);

  const { data, error } = await query;
  if (error) return sendError(res, "db_error", error.message);
  return res.json({ reports: data ?? [] });
}));

// ── admin city-status POST (collection-level, city in body) ───────────────────

// POST /api/rent-a-buddy/admin/city-status — collection-level city status update.
// Accepts { city, status, notes, buddyCap } in the request body.
// Also accessible at /api/admin/rent-a-buddy/city-status via app.ts URL alias.
router.post("/rent-a-buddy/admin/city-status", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  const { data: profile } = await serviceClient.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  const { city, status, notes, buddyCap } = req.body ?? {};
  if (!city || !status) {
    return res.status(400).json({ error: "invalid_payload", message: "city and status are required." });
  }

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
}));

// ── admin category-status POST (collection-level, category in body) ────────────

// POST /api/rent-a-buddy/admin/category-status — collection-level category status update.
// Accepts { category, enabled, notes } in the request body.
// Also accessible at /api/admin/rent-a-buddy/category-status via app.ts URL alias.
router.post("/rent-a-buddy/admin/category-status", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  const { data: profile } = await serviceClient.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if ((profile as any)?.role !== "admin") return res.status(403).json({ error: "forbidden" });

  const { category, enabled, notes } = req.body ?? {};
  if (!category || typeof enabled !== "boolean") {
    return res.status(400).json({ error: "invalid_payload", message: "category and enabled (boolean) are required." });
  }

  // NULL-safe write — see lib/rentBuddyLaunchControls.ts. The onConflict upsert
  // that stood here never matched (NULLS DISTINCT) and duplicated the row.
  const { data, error } = await upsertLaunchControlRow(
    serviceClient,
    normalizeLaunchControlKey({ category }),
    { enabled, notes: notes ?? null },
    auth.user.id,
  );

  if (error) return sendError(res, "db_error", (error as any).message ?? String(error));
  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: auth.user.id, target_type: "category", target_id: category,
    action: enabled ? "category_enabled" : "category_disabled", notes: notes ?? null,
  });
  return res.json({ category: data });
}));

// ── admin city-status POST variant ────────────────────────────────────────────

// POST /api/rent-a-buddy/admin/city-status/:city
// POST alias required by spec in addition to PATCH variant.
// Also accessible at /api/admin/rent-a-buddy/city-status/:city via app.ts URL alias
router.post("/rent-a-buddy/admin/city-status/:city", asyncHandler(async (req, res) => {
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
}));

// ── admin category-status POST variant ────────────────────────────────────────

// POST /api/rent-a-buddy/admin/category-status/:category
// POST alias required by spec in addition to PATCH variant.
// Also accessible at /api/admin/rent-a-buddy/category-status/:category via app.ts URL alias
router.post("/rent-a-buddy/admin/category-status/:category", asyncHandler(async (req, res) => {
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

  // NULL-safe write — see lib/rentBuddyLaunchControls.ts. The onConflict upsert
  // that stood here never matched (NULLS DISTINCT) and duplicated the row.
  const { data, error } = await upsertLaunchControlRow(
    serviceClient,
    normalizeLaunchControlKey({ category }),
    { enabled, notes: notes ?? null },
    auth.user.id,
  );

  if (error) return sendError(res, "db_error", (error as any).message ?? String(error));
  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: auth.user.id, target_type: "category", target_id: category,
    action: enabled ? "category_enabled" : "category_disabled", notes: notes ?? null,
  });
  return res.json({ category: data });
}));

// ── admin payout hold / release ────────────────────────────────────────────────

// POST /api/rent-a-buddy/admin/payouts/:payoutId/hold
// Also accessible at /api/admin/buddy-payouts/:payoutId/hold via app.ts URL alias
router.post("/rent-a-buddy/admin/payouts/:payoutId/hold", asyncHandler(async (req, res) => {
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
}));

// POST /api/rent-a-buddy/admin/payouts/:payoutId/release
// Also accessible at /api/admin/buddy-payouts/:payoutId/release via app.ts URL alias
router.post("/rent-a-buddy/admin/payouts/:payoutId/release", asyncHandler(async (req, res) => {
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
}));

export default router;
