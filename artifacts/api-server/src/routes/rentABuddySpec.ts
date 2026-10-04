import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { requireAdmin } from "../lib/requireAdmin.js";
import { getServiceClient } from "../lib/supabase.js";
// requireRentBuddyEnabled is the lane's ONE master-switch guard, defined in
// rentABuddy.ts (which already gates its own 70 handlers with it). Imported
// rather than re-implemented so this router cannot drift from the meaning of
// `rent_buddy_enabled`. See its doc comment for why admin routes are exempt.
import { findBlockingAvailabilityException, sendBuddyUnavailable, getUserLimits, deriveServiceCountry, resolveLaunchControlFromRows, requireRentBuddyEnabled, recordBookingEvent, NO_SHOW_REPORTABLE_STATUSES, enforceCityRestrictions, refuseKnownMinorTraveler } from "./rentABuddy.js";
import { adjustBuddyCounter } from "../services/rentBuddy/ReliabilityCounters.js";
import { requireBookingKyc } from "../lib/rentBuddyKycGate.js";
import { TRAINING_CHECKLIST_ITEMS } from "./rentABuddy.js";
import { isKillSwitchEngaged, engagedRabBookingKillSwitch } from "../lib/featureFlags.js";
import { checkRentBuddyAccess } from "./rentABuddyRollout.js";
import { loadTravelerIdentity } from "../lib/travelerVerification.js";
import { isPrivateLocation } from "../lib/rentaBuddyScanner.js";
import { normalizeLaunchControlKey, upsertLaunchControlRow } from "../lib/rentBuddyLaunchControls.js";
import { createEarningsLedgerEntry, sendBookingLedgerRefusal, withdrawUnledgeredBooking } from "../lib/rentBuddyEarningsLedger.js"; import { sendMoneyRpcFailure, transitionPayout, type PayoutAction } from "../lib/rentBuddyLedgerPosting.js"; // one line: docs cite this file by line
import { isBlockedBetween } from "../lib/blockGuard.js";
import { affectedRows } from "../lib/affectedRows.js";

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
  const adminCtx = await requireAdmin(req, res);
  if (!adminCtx) return;
  const { sc: serviceClient } = adminCtx;

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
  const adminCtx = await requireAdmin(req, res);
  if (!adminCtx) return;
  const { sc: serviceClient } = adminCtx;

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
    return res.status(404).json({ error: 'feature_disabled', gate: await engagedRabBookingKillSwitch(serviceClient), message: 'Rent-a-Buddy bookings are temporarily disabled' });
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

  // ── Verified-minor refusal (IDF-25 / IDF-27) ───────────────────────────────
  // OUTSIDE the launch-control block below, and in the same position the
  // canonical path puts it (rentABuddy.ts, enforceBookingCreationGates: after
  // kill switch / rollout / limits, before launch controls).
  //
  // THIS IS THE WHOLE FIX. Every age check this route had lived inside
  // `if (launchCtrl) { … }`, so with `rent_buddy_launch_controls` EMPTY the
  // route fell past the deny-by-default branch — which only fires when rows
  // exist — straight to the insert, and seated a booking for a traveller whose
  // government document says they are a minor. The canonical route refuses that
  // booking with no launch control involved, and rentABuddy.ts:1735 states the
  // invariant this was breaking: "no creation path may seat a booking that
  // POST /rent-a-buddy/bookings would refuse."
  //
  // Exposure was LATENT rather than live — production holds 13 launch-control
  // rows, so the empty-table branch is not reachable there today — and the
  // shared helper is called rather than copied so this alias cannot drift from
  // the canonical refusal again.
  if (!await refuseKnownMinorTraveler(serviceClient, res, user.id)) return;

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
  //
  // FAIL-CLOSED, shape 1 (lib/exclusionSet.ts): one booking request, one pair,
  // so an unreadable `blocks` table refuses this request only. The old pair of
  // `.maybeSingle()` reads was fail-open twice: a resolved DB error left both
  // `.data` null ("not blocked"), and maybeSingle additionally RAISES on >1 row,
  // so a mutual block produced the same null. This alias must refuse exactly
  // where the canonical POST /rent-a-buddy/bookings refuses.
  if (buddyUserId && (await isBlockedBetween(serviceClient, auth.user.id, buddyUserId))) {
    return res.status(403).json({ error: "blocked", message: "You cannot book this Buddy." });
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
    // FAIL CLOSED on an unreadable table. supabase-js RESOLVES on a DB error, so
    // `{ data: null }` becomes `[]` below — byte-identical to "no launch control
    // is configured anywhere". That is the permissive answer at an admin policy
    // gate: it waives the server-derived-country requirement immediately below
    // AND every age / ID / phone / full-payment rule an admin has set for this
    // region. The canonical POST /rent-a-buddy/bookings refuses this booking
    // (sendLaunchControlsUnavailable, 503 + retryable); this alias must refuse
    // exactly where the canonical route refuses.
    const { data: launchRows, error: launchRowsErr } = await serviceClient
      .from("rent_buddy_launch_controls")
      .select("*");
    if (launchRowsErr) {
      return res.status(503).json({
        error: "restrictions_unavailable",
        retryable: true,
        message: "Booking availability for this location could not be verified right now. Please try again shortly.",
      });
    }

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
      //
      // The two OTHER ways `travIdentity.age` becomes null are handled above and
      // are checked here as well rather than left to ordering: a verified minor
      // and an unreadable `identity_verifications` must never reach this branch,
      // because this message says the user's date of birth is missing and in
      // both of those cases it is on file. `refuseKnownMinorTraveler` has
      // already returned for both; this is the belt to its braces, and it is
      // what keeps the message honest if the two are ever reordered.
      if (travIdentity.verificationUnreadable) {
        return res.status(503).json({
          error: "age_verification_unavailable",
          message: "Your age could not be verified right now. Please try again shortly.",
        });
      }
      if (travIdentity.verifiedMinor) {
        return res.status(403).json({
          error: "age_requirement",
          message: "Rent a Buddy bookings are only available to users aged 18 and over.",
        });
      }
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

    } else if ((launchRows ?? []).length > 0) {
      // DENY BY DEFAULT, matching enforceBookingCreationGates. Launch controls
      // are configured but none matches this city/country/category, which means
      // an admin has not opened this combination. The canonical route refuses
      // here; this alias used to seat the booking, so a region an admin had
      // simply not listed was bookable through the shorthand and not through
      // the main route.
      return res.status(403).json({
        error: "location_unavailable",
        message: "Rent a Buddy is not yet available in this location or category.",
      });
    }

    // ── City/category restrictions (admin policy — fail CLOSED) ───────────────
    // THE GAP. rent_buddy_city_restrictions was read by
    // enforceBookingCreationGates and by nothing else, and this route does not
    // run that gate stack — so `require_public_meetup`, `disable_deposit_cash`
    // and `require_full_in_app` were enforced on POST /rent-a-buddy/bookings,
    // on rebook, on offer-accept and on package-book, and ignored here. A
    // traveller refused a private meetup or a cash split by the canonical route
    // could seat exactly that booking through /api/buddies/:buddyId/request.
    // Same helper, same refusals, same fail-closed load error.
    if (!await enforceCityRestrictions({
      sc: serviceClient, res, city, category, meetupLocation, meetupType, paymentMode,
    })) return;

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

  // The booking's earnings ledger, entries and summary in one transaction. Not best-effort (PAY-050): a booking
  // whose ledger cannot be written is withdrawn and the request refused by name. See lib/rentBuddyEarningsLedger.ts.
  if (data) { const ledger = await createEarningsLedgerEntry(serviceClient, data, buddyId); if (ledger.status !== "written") { await withdrawUnledgeredBooking(serviceClient, (data as any).id); return sendBookingLedgerRefusal(res, ledger); } }

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

  // Already-in-process states get their own code so a client can tell an
  // idempotency conflict from a genuinely invalid transition (same shape as the
  // canonical /no-show route).
  if (b.status === "no_show_pending" || b.status === "disputed") {
    return res.status(409).json({ error: "already_reported", status: b.status });
  }

  // ALLOWLIST, shared with the canonical route.
  //
  // This was a hand-written denylist — no_show_pending | disputed | completed |
  // cancelled — which is the same action reached through a different URL with a
  // different and much wider notion of "reportable". It admitted `requested`,
  // `pending`, `expired` and `declined` (a session that never started cannot
  // have a no-show; writing one fabricates an incident and pushes the booking
  // into no_show_pending, from which the sweeper opens a real dispute), and it
  // admitted `cancelled_by_traveler` / `cancelled_by_buddy` because it named
  // only bare `cancelled`, which is the value ONLY admin dispute-resolution
  // writes. It also admitted `completed_pending_traveler_confirmation`, letting
  // a no-show be filed against a session both parties had just finished.
  if (!NO_SHOW_REPORTABLE_STATUSES.includes(b.status as any)) {
    return res.status(409).json({
      error: "invalid_transition",
      message: "No-show can only be reported for confirmed or in-progress bookings.",
      currentStatus: b.status,
    });
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

  const { data: movedRows, error: updateError } = await serviceClient
    .from("rent_buddy_bookings")
    .update({ status: "no_show_pending", no_show_grace_expires_at: graceExpiry, updated_at: now })
    .eq("id", bookingId)
    .in("status", [...NO_SHOW_REPORTABLE_STATUSES])
    .select("id");

  if (updateError) return sendError(res, "db_error", updateError.message);
  if (affectedRows(movedRows) === 0) {
    // The booking left a reportable state between the read and this write. The
    // safety event above stands (it is a report, and it happened), but no
    // transition did, so no grace period is claimed and the sweeper is not
    // handed a booking it should escalate.
    return res.status(409).json({
      error: "invalid_transition",
      message: "The booking changed state before this no-show report was applied. Refresh and try again.",
      currentStatus: b.status,
    });
  }

  // ── The `no_show_reported` event — the sweeper's ONLY attribution input ─────
  //
  // THE DEFECT. This path never wrote one. rentBuddyRequestSweeper phase 3
  // derives the no-show dispute's `raised_by` from the LATEST
  // buddy_booking_events row with event = 'no_show_reported', "do NOT assume
  // traveler; either party can file a no-show report" — and with no such row it
  // takes its `?? bk.traveler_id` fallback. rentABuddySpec's own dispute
  // resolution then gates the buddy's no_show_count on
  // `raised_by === traveler_id`. So a BUDDY reporting a traveller's no-show
  // through THIS route opened a dispute in the traveller's name and, when an
  // admin resolved it in the traveller's favour, incremented the BUDDY's
  // no_show_count for the traveller's absence.
  //
  // That is the same dead-producer/broken-consumer pair that was repaired for
  // POST /bookings/:id/no-show; this alias was the other producer, and it was
  // not dead, it was never written. Its absence also meant a no-show filed here
  // appeared nowhere in the evidence log
  // GET /rent-a-buddy/bookings/:bookingId/events serves to both parties.
  //
  // Shares rentABuddy.ts's writer so the two producers cannot drift: issued
  // (a `.then()` continuation, not a bare `void` on a thenable) and logged on
  // failure, but never able to fail a safety report that is already committed.
  recordBookingEvent(serviceClient, req.log, {
    booking_id: bookingId,
    actor_user_id: auth.user.id,
    event: "no_show_reported",
    from_status: b.status,
    to_status: "no_show_pending",
    metadata: {
      reported_by: auth.user.id === b.traveler_id ? "traveler" : "buddy",
      grace_expires_at: graceExpiry,
      safety_event_id: (data as any)?.id ?? null,
    },
  });

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
  //
  // FAIL CLOSED on a read error. supabase-js RESOLVES on a DB error, so
  // `{ data: null }` is byte-identical to "this booking has no open dispute" —
  // and this row is the ONLY input to the no_show_count decision at the bottom
  // of the handler. Swallowing the error silently turned a confirmed buddy
  // no-show into "no penalty", with a 200 and a resolved dispute to say the
  // adjudication had been carried out in full.
  const { data: openDispute, error: openDisputeErr } = await serviceClient
    .from("rent_buddy_disputes")
    .select("id, reason, raised_by, status")
    .eq("booking_id", bookingId)
    .in("status", ["open", "reviewing"])
    .maybeSingle();
  if (openDisputeErr) {
    req.log?.error?.({ err: openDisputeErr, bookingId }, "resolve-dispute: open-dispute read failed");
    return res.status(503).json({
      error: "precondition_unavailable",
      retryable: true,
      message: "The dispute record could not be read, so this resolution was not applied. Please try again shortly.",
    });
  }

  // ── completed_count compensation EVIDENCE, read as a precondition ──────────
  // Read before anything is written, and fail closed, for the same reason as
  // the dispute read above: `{ data: null }` on an unreadable
  // buddy_booking_events is indistinguishable from "this booking never passed
  // through mark-complete", and taking that branch silently skips a
  // compensation that is owed. Reading it here means a table we cannot consult
  // stops the resolution BEFORE the dispute row and the booking are moved,
  // instead of leaving a resolved dispute next to a counter that was never
  // corrected.
  // Only a resolution AGAINST the buddy can owe a compensation, so only that
  // resolution needs the evidence — and only that one is blocked by an
  // unreadable event log.
  let passedThroughMarkComplete = false;
  if (favorTraveler === true) {
    const { data: completeEvents, error: completeEventsErr } = await serviceClient
      .from("buddy_booking_events")
      .select("id")
      .eq("booking_id", bookingId)
      .eq("event", "buddy_marked_complete");
    if (completeEventsErr) {
      req.log?.error?.({ err: completeEventsErr, bookingId }, "resolve-dispute: mark-complete evidence read failed");
      return res.status(503).json({
        error: "precondition_unavailable",
        retryable: true,
        message: "The booking's event log could not be read, so this resolution was not applied. Please try again shortly.",
      });
    }
    passedThroughMarkComplete = Array.isArray(completeEvents) && completeEvents.length > 0;
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

  // ── Booking transition: COMPARE-AND-SET, not fire-and-hope ──────────────────
  //
  // THE DEFECT. This was `.update({status}).eq("id", bookingId)` with no status
  // predicate, no `.select()` and no error check — and every consequence below
  // it (the completed_count compensation, the no_show_count increment, the
  // admin-action audit row, the 200) was driven by the `booking.status ===
  // "disputed"` READ taken further up the handler rather than by what this
  // write actually did. The same defect the request sweeper had: a counter
  // moved by a read set instead of by the write's affected rows.
  //
  // Two ways that goes wrong, both silent:
  //   • the UPDATE fails — supabase-js resolves, so nothing here noticed. The
  //     dispute is marked resolved, the buddy's counters are adjusted, and the
  //     booking stays `disputed` forever with no open dispute to resolve it.
  //   • the booking left `disputed` between the read and the write. The write
  //     stomped whatever state it had reached, and the counters were adjusted
  //     for a transition that had already been made by someone else.
  //
  // Re-asserting `status = "disputed"` inside the same statement makes the
  // check and the write inseparable, and `.select("id")` makes the statement
  // RETURNING so zero rows is visible. Zero rows or an error ⇒ nothing was
  // adjudicated, so the dispute resolution is ROLLED BACK to the status it had
  // and the caller is told, rather than being handed a 200 for a booking
  // transition that did not happen.
  const newBookingStatus = favorTraveler === true ? "cancelled" : "completed";
  const { data: movedBooking, error: bookingUpdErr } = await serviceClient
    .from("rent_buddy_bookings")
    .update({ status: newBookingStatus, updated_at: new Date().toISOString() })
    .eq("id", bookingId)
    .eq("status", "disputed")
    .select("id");

  if (bookingUpdErr || affectedRows(movedBooking) === 0) {
    // Compensate: put the dispute back the way we found it, so the booking and
    // its dispute cannot be left disagreeing about whether it was adjudicated.
    // Best-effort and logged — a failed rollback is reported, never swallowed.
    try {
      const { error: rollbackErr } = await serviceClient
        .from("rent_buddy_disputes")
        .update({ status: (openDispute as any)?.status ?? "open", resolution_note: null, resolved_at: null })
        .eq("id", (dispute as any).id)
        .eq("status", "resolved");
      if (rollbackErr) {
        req.log?.error?.({ err: rollbackErr, bookingId, disputeId: (dispute as any).id },
          "resolve-dispute: booking transition failed AND the dispute rollback failed — dispute is resolved over a still-disputed booking");
      }
    } catch (err) {
      req.log?.error?.({ err, bookingId, disputeId: (dispute as any).id },
        "resolve-dispute: dispute rollback threw after a failed booking transition");
    }

    if (bookingUpdErr) {
      req.log?.error?.({ err: bookingUpdErr, bookingId }, "resolve-dispute: booking transition failed");
      return res.status(500).json({ error: "update_failed", message: "The booking could not be moved out of dispute. No counters were adjusted." });
    }
    return res.status(409).json({
      error: "invalid_transition",
      message: "The booking left 'disputed' before this resolution was applied. Refresh and try again.",
    });
  }

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
  if (newBookingStatus === "cancelled" && passedThroughMarkComplete) {
    await adjustBuddyCounter(serviceClient, (booking as any).buddy_id, "completed_count", -1);
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

// ── admin payouts: list, hold, release ─────────────────────────────────────────
//
// NO MONEY MOVES HERE. `rent_buddy_payouts` is a status ledger over rows that
// nothing in this tree inserts (09 §1.4; the lifecycle that creates one from a
// balance is PAY-T11). `released` is a status, not a disbursement: no processor
// is installed and nothing is paid to anyone.
//
// ── THE TRANSITION AND ITS AUDIT ROW ARE ONE TRANSACTION (PAY-075) ───────────
//
// THE DEFECT. Hold and release were an UPDATE of the payout followed by a
// SEPARATE `rent_buddy_admin_actions` INSERT whose result was never read. A
// failed audit insert therefore left an unlogged hold or release — the status
// had moved, the 200 had been sent, and the only record of who authorised a
// money transition did not exist. 09 §10: "the audit row is inside the same
// transaction as the entries; if it cannot be written, the money does not move."
//
// THE FIX. Both routes call `rb_admin_payout_transition` (migration 3824),
// which takes the payout's row lock, applies the transition and inserts the
// audit row in one function call — one transaction. If the insert raises, the
// UPDATE is rolled back with it and the caller gets a 503.
//
// ── STILL COMPARE-AND-SWAP (M3, 09 §9.1) ─────────────────────────────────────
// The state rules are unchanged, and now run under the row lock instead of as
// PostgREST predicates:
//   hold     from any status except `on_hold` and `released`
//   release  from `on_hold` only
// A transition that does not apply is a 409 carrying the status the payout IS
// in; the row, `held_by` / `released_by` and the audit trail are untouched. The
// hold rule stays a DENYLIST on purpose: `status` is free text whose vocabulary
// PAY-T11 will define, and an allowlist here would have to invent it.
//
// ── A REASON IS REQUIRED ─────────────────────────────────────────────────────
// Both transitions now refuse (400 `reason_required`) without one. An audit row
// that says who and not why is half a record. Release used to call the field
// `notes`; it is still read, so an existing caller keeps working.
//
// ── NO FALLBACK ──────────────────────────────────────────────────────────────
// With the function absent the transition is REFUSED — 503 `ledger_unavailable`
// — and is not retried as an UPDATE from here.

/** A uuid, which is what `rent_buddy_payouts.id` is. */
const PAYOUT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYOUT_REASON_MAX_LENGTH = 1000;

/** The columns the admin payouts screen renders. */
const PAYOUT_LIST_COLUMNS =
  "id, booking_id, buddy_id, amount_usd, status, hold_reason, held_by, held_at, released_by, released_at, notes, created_at, updated_at";

async function applyPayoutTransition(req: any, res: any, action: PayoutAction): Promise<void> {
  // The shared admin guard (lib/requireAdmin.ts): 401 / 403 / 503 already sent
  // when it returns null. The SQL function re-checks the role as well.
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient, userId: adminId } = admin;

  const { payoutId } = req.params;
  // Not a uuid ⇒ it cannot name a payout. Answered here because the function's
  // parameter is a uuid and PostgREST would otherwise report a cast error.
  if (typeof payoutId !== "string" || !PAYOUT_ID_RE.test(payoutId)) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const body = req.body ?? {};
  const rawReason = action === "hold" ? body.reason : (body.reason ?? body.notes);
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  if (reason.length === 0 || reason.length > PAYOUT_REASON_MAX_LENGTH) {
    res.status(400).json({
      error: "reason_required",
      message: `A reason of 1-${PAYOUT_REASON_MAX_LENGTH} characters is required to ${action} a payout.`,
    });
    return;
  }

  const result = await transitionPayout(serviceClient, { payoutId, action, adminId, reason });

  if (result.status === "unavailable" || result.status === "failed") {
    req.log?.error?.(
      { payoutId, action, error: result.error, rpc: result.rpc, detail: result.detail },
      "payout transition was NOT applied: the transition function is unavailable or failed — nothing was changed and nothing was audited",
    );
    sendMoneyRpcFailure(res, result, "The payout was not changed. Please try again.");
    return;
  }

  if (result.status === "refused") {
    if (result.refusal === "not_found") { res.status(404).json({ error: "not_found" }); return; }
    if (result.refusal === "not_admin") { res.status(403).json({ error: "forbidden" }); return; }
    if (result.refusal === "reason_required") {
      res.status(400).json({ error: "reason_required", message: result.detail });
      return;
    }
    if (result.refusal === "conflict") {
      res.status(409).json({ error: "conflict", message: result.detail, currentStatus: result.currentStatus });
      return;
    }
    res.status(409).json({ error: "payout_transition_refused", refusal: result.refusal, message: result.detail });
    return;
  }

  res.json({
    payout: result.payout,
    fromStatus: result.fromStatus,
    toStatus: result.toStatus,
    auditId: result.auditId,
  });
}

// GET /api/rent-a-buddy/admin/payouts?status=<state>&limit=&offset=
//
// The admin payouts queue. Lists payout rows newest first, optionally filtered
// to one state, with the exact count for that filter. A failed read is a 500,
// never an empty list: "there are no payouts" and "the payouts could not be
// read" are different answers and an admin acts differently on each.
router.get("/rent-a-buddy/admin/payouts", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient } = admin;

  const rawStatus = typeof req.query.status === "string" ? req.query.status.trim() : "";
  const status = rawStatus.length > 0 && rawStatus !== "all" ? rawStatus : null;
  const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit ?? 50)) || 50, 1), 200);
  const offset = Math.max(Math.trunc(Number(req.query.offset ?? 0)) || 0, 0);

  let query: any = serviceClient
    .from("rent_buddy_payouts")
    .select(PAYOUT_LIST_COLUMNS, { count: "exact" });
  if (status) query = query.eq("status", status);
  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    req.log?.error?.({ err: error, status }, "admin payouts: list read failed");
    return sendError(res, "db_error", error.message);
  }

  return res.json({
    payouts: data ?? [],
    total: count ?? (Array.isArray(data) ? data.length : 0),
    status: status ?? "all",
    // Said in the payload as well as on the screen, so no consumer can mistake
    // this queue for a disbursement surface.
    movesMoney: false,
  });
}));

// POST /api/rent-a-buddy/admin/payouts/:payoutId/hold
// Also accessible at /api/admin/buddy-payouts/:payoutId/hold via app.ts URL alias
router.post("/rent-a-buddy/admin/payouts/:payoutId/hold", asyncHandler(async (req, res) => {
  await applyPayoutTransition(req, res, "hold");
}));

// POST /api/rent-a-buddy/admin/payouts/:payoutId/release
// Also accessible at /api/admin/buddy-payouts/:payoutId/release via app.ts URL alias
router.post("/rent-a-buddy/admin/payouts/:payoutId/release", asyncHandler(async (req, res) => {
  await applyPayoutTransition(req, res, "release");
}));

export default router;
