/**
 * Rent a Buddy — full implementation
 *
 * All routes are gated by requireRentBuddyEnabled (feature flag).
 * Policy scanner runs on user-generated text at write time.
 *
 * POST   /api/rent-a-buddy/search
 * GET    /api/rent-a-buddy/buddies/:buddyId
 * GET    /api/rent-a-buddy/buddies/:buddyId/availability
 * GET    /api/rent-a-buddy/buddies/:buddyId/reviews
 * POST   /api/rent-a-buddy/bookings
 * GET    /api/rent-a-buddy/bookings
 * GET    /api/rent-a-buddy/bookings/:bookingId
 * POST   /api/rent-a-buddy/bookings/:bookingId/accept
 * POST   /api/rent-a-buddy/bookings/:bookingId/decline
 * POST   /api/rent-a-buddy/bookings/:bookingId/start
 * POST   /api/rent-a-buddy/bookings/:bookingId/complete
 * POST   /api/rent-a-buddy/bookings/:bookingId/cancel
 * POST   /api/rent-a-buddy/bookings/:bookingId/confirm-cash
 * POST   /api/rent-a-buddy/bookings/:bookingId/route
 * POST   /api/rent-a-buddy/bookings/:bookingId/route-change
 * POST   /api/rent-a-buddy/bookings/:bookingId/review
 * POST   /api/rent-a-buddy/bookings/:bookingId/report
 * POST   /api/rent-a-buddy/bookings/:bookingId/safety/checkin
 * POST   /api/rent-a-buddy/bookings/:bookingId/safety/feel-unsafe
 * POST   /api/rent-a-buddy/bookings/:bookingId/safety/end-early
 * POST   /api/rent-a-buddy/bookings/:bookingId/safety/emergency-phrase
 * GET    /api/rent-a-buddy/apply
 * POST   /api/rent-a-buddy/apply
 * GET    /api/rent-a-buddy/me/profile
 * PATCH  /api/rent-a-buddy/me/profile
 * PATCH  /api/rent-a-buddy/me/availability
 * GET    /api/rent-a-buddy/me/requests
 * GET    /api/rent-a-buddy/saved
 * POST   /api/rent-a-buddy/saved/:buddyId
 * DELETE /api/rent-a-buddy/saved/:buddyId
 * GET    /api/rent-a-buddy/waitlist
 * POST   /api/rent-a-buddy/waitlist
 * DELETE /api/rent-a-buddy/waitlist/:city
 * GET    /api/rent-a-buddy/dashboard
 * GET    /api/rent-a-buddy/dashboard/requests
 * PATCH  /api/rent-a-buddy/dashboard/offer
 * GET    /api/rent-a-buddy/dashboard/availability
 * POST   /api/rent-a-buddy/dashboard/availability
 * GET    /api/rent-a-buddy/dashboard/packages
 * POST   /api/rent-a-buddy/dashboard/packages
 * PATCH  /api/rent-a-buddy/dashboard/packages/:packageId
 * DELETE /api/rent-a-buddy/dashboard/packages/:packageId
 * GET    /api/rent-a-buddy/dashboard/addons
 * POST   /api/rent-a-buddy/dashboard/addons
 * PATCH  /api/rent-a-buddy/dashboard/addons/:addonId
 * DELETE /api/rent-a-buddy/dashboard/addons/:addonId
 * GET    /api/rent-a-buddy/dashboard/earnings
 * GET    /api/rent-a-buddy/admin/applications
 * PATCH  /api/rent-a-buddy/admin/applications/:appId
 * GET    /api/rent-a-buddy/admin/buddies
 * GET    /api/rent-a-buddy/admin/bookings
 * GET    /api/rent-a-buddy/admin/analytics
 * GET    /api/rent-a-buddy/admin/safety/flags
 * POST   /api/rent-a-buddy/admin/safety/flags/:flagId/dismiss
 * POST   /api/rent-a-buddy/admin/safety/flags/:flagId/confirm
 * GET    /api/rent-a-buddy/admin/safety/events
 * POST   /api/rent-a-buddy/admin/users/:userId/limits
 * PATCH  /api/rent-a-buddy/admin/users/:userId/limits
 */

import { Router } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { recordTrustEvent } from "../services/trust/TrustEventService.js";

const router = Router();

// ── Policy language ────────────────────────────────────────────────────────────

export const POLICY_TEXT =
  "Rent a Buddy is for travel companionship, city guidance, language support, local help, social exploration, shopping, nightlife guidance, content help, and arrival support only. It is not a dating, escort, adult, romantic, sexual, or illegal-service feature. Requests or offers that violate this policy may lead to account review, suspension, removal, and Trust Score penalties.";

// ── Private meetup location blocklist ─────────────────────────────────────────

const PRIVATE_LOCATION_PATTERNS = [
  /private\s+hotel\s+room/i,
  /come\s+to\s+my\s+room/i,
  /my\s+room/i,
  /hotel\s+room/i,
  /private\s+home/i,
  /my\s+place/i,
  /my\s+apartment/i,
  /my\s+airbnb/i,
];

function isPrivateLocation(text: string): boolean {
  return PRIVATE_LOCATION_PATTERNS.some((p) => p.test(text));
}

// ── Policy keyword scanner ────────────────────────────────────────────────────

const POLICY_RULES: Array<{
  patterns: RegExp[];
  category: string;
  severity: "low" | "medium" | "high" | "critical";
}> = [
  {
    patterns: [/escort/i, /girlfriend\s+experience/i, /boyfriend\s+experience/i, /gfe\b/i, /bfe\b/i],
    category: "adult_service",
    severity: "critical",
  },
  {
    patterns: [/adult\s+service/i, /sexual\s+service/i, /sex\s+work/i, /sex\b.*for\s+hire/i],
    category: "adult_service",
    severity: "critical",
  },
  {
    patterns: [/massage\b/i],
    category: "massage_service",
    severity: "medium",
  },
  {
    patterns: [/\bhookup\b/i, /date\s+me/i, /romantic\s+service/i, /romantic\s+companion/i],
    category: "romantic_service",
    severity: "high",
  },
  {
    patterns: [/\bsex\b/i],
    category: "explicit",
    severity: "high",
  },
  {
    patterns: [/off[-\s]?app/i, /pay\s+outside/i, /cash\s+only\s+outside/i, /venmo\s+me/i, /paypal\s+me/i],
    category: "off_app_payment",
    severity: "medium",
  },
  {
    patterns: [/\bdrugs?\b/i, /\bweed\b/i, /\bcocaine\b/i, /\bheroin\b/i, /\bmeth\b/i, /\bmdma\b/i],
    category: "drugs",
    severity: "high",
  },
];

interface PolicyMatch {
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  excerpt: string;
}

function scanText(text: string): PolicyMatch[] {
  const matches: PolicyMatch[] = [];
  for (const rule of POLICY_RULES) {
    for (const pattern of rule.patterns) {
      const m = text.match(pattern);
      if (m) {
        matches.push({
          category: rule.category,
          severity: rule.severity,
          excerpt: text.substring(Math.max(0, (m.index ?? 0) - 20), (m.index ?? 0) + m[0].length + 20),
        });
        break;
      }
    }
  }
  return matches;
}

async function scanForPolicyViolations(opts: {
  sc: any;
  text: string;
  sourceType: string;
  sourceId?: string | null;
  bookingId?: string | null;
  flaggedUserId?: string | null;
  reporterUserId?: string | null;
}): Promise<PolicyMatch[]> {
  const { sc, text, sourceType, sourceId, bookingId, flaggedUserId, reporterUserId } = opts;
  const matches = scanText(text);
  if (matches.length === 0) return [];

  const mostSevere = matches.reduce((a, b) => {
    const order = { critical: 3, high: 2, medium: 1, low: 0 };
    return order[a.severity] >= order[b.severity] ? a : b;
  });

  await sc.from("rent_buddy_policy_flags").insert({
    booking_id: bookingId ?? null,
    reporter_user_id: reporterUserId ?? null,
    flagged_user_id: flaggedUserId ?? null,
    source_type: sourceType,
    source_id: sourceId ?? null,
    category: mostSevere.category,
    severity: mostSevere.severity,
    matched_text_excerpt: mostSevere.excerpt,
    status: "open",
  });

  return matches;
}

async function applyPolicySeverity(opts: {
  sc: any;
  userId: string;
  matches: PolicyMatch[];
}): Promise<void> {
  if (opts.matches.length === 0) return;
  const { sc, userId, matches } = opts;

  const mostSevere = matches.reduce((a, b) => {
    const order = { critical: 3, high: 2, medium: 1, low: 0 };
    return order[a.severity] >= order[b.severity] ? a : b;
  });

  if (mostSevere.severity === "critical") {
    await sc
      .from("rent_buddy_profiles")
      .update({ admin_status: "disabled" })
      .eq("user_id", userId);
    void recordTrustEvent(sc, {
      userId,
      eventType: "rent_buddy_policy_flag_confirmed",
      category: "respect_safety",
      delta: -30,
      severity: "severe",
      sourceType: "policy_scanner",
    });
  } else if (mostSevere.severity === "high") {
    await sc
      .from("rent_buddy_user_limits")
      .upsert({
        user_id: userId,
        nightlife_disabled: true,
        public_meetup_required: true,
        full_in_app_payment_required: true,
        reason: `Policy flag: ${mostSevere.category}`,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
    void recordTrustEvent(sc, {
      userId,
      eventType: "rent_buddy_policy_flag_confirmed",
      category: "respect_safety",
      delta: -15,
      severity: "serious",
      sourceType: "policy_scanner",
    });
  } else if (mostSevere.severity === "medium") {
    void recordTrustEvent(sc, {
      userId,
      eventType: "rent_buddy_policy_flag_confirmed",
      category: "respect_safety",
      delta: -8,
      severity: "moderate",
      sourceType: "policy_scanner",
    });
  }
}

// ── Feature flag guard ─────────────────────────────────────────────────────────

async function requireRentBuddyEnabled(sc: any, res: any): Promise<boolean> {
  const { data } = await sc
    .from("feature_flags")
    .select("enabled")
    .eq("flag", "rent_buddy_enabled")
    .maybeSingle();
  if (!data || !(data as any).enabled) {
    res.status(403).json({ error: "feature_disabled", message: "Rent a Buddy is not available yet." });
    return false;
  }
  return true;
}

// ── User limits helper ─────────────────────────────────────────────────────────

async function getUserLimits(sc: any, userId: string): Promise<any | null> {
  const { data } = await sc
    .from("rent_buddy_user_limits")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return data ?? null;
}

// ── Admin guard ────────────────────────────────────────────────────────────────

async function requireAdmin(
  req: any,
  res: any,
): Promise<{ userId: string; client: any; sc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;
  const sc = getServiceClient() ?? client;

  const { data } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (!data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }
  return { userId: user.id, client, sc };
}

// ── Row mapper helpers ─────────────────────────────────────────────────────────

function mapProfile(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    tagline: row.tagline,
    bio: row.bio,
    introVideoUrl: row.intro_video_url,
    languages: row.languages ?? [],
    city: row.city,
    country: row.country,
    categories: row.categories ?? [],
    hourlyRateUsd: row.hourly_rate_usd ? Number(row.hourly_rate_usd) : null,
    status: row.status,
    adminStatus: row.admin_status,
    verified: row.verified,
    verifiedAt: row.verified_at,
    averageRating: row.average_rating ? Number(row.average_rating) : null,
    reviewCount: row.review_count ?? 0,
    completedBookings: row.completed_bookings ?? 0,
    responseTimeH: row.response_time_h ? Number(row.response_time_h) : null,
    coverPhotoUrl: row.cover_photo_url,
    galleryUrls: row.gallery_urls ?? [],
    vibeTags: row.vibe_tags ?? [],
    safetyBadges: row.safety_badges ?? [],
    buddyLevel: row.buddy_level,
    categoryApprovals: row.category_approvals ?? {},
    newBuddyPublicOnly: row.new_buddy_public_only,
    newBuddyDaytimeOnly: row.new_buddy_daytime_only,
    newBuddyMaxHours: row.new_buddy_max_hours,
    maxGroupSize: row.max_group_size,
    preferredMeetupZones: row.preferred_meetup_zones ?? [],
    trustScoreOverride: row.trust_score_override,
    riskHold: row.risk_hold,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBooking(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    buddyId: row.buddy_id,
    travelerId: row.traveler_id,
    packageId: row.package_id,
    tripId: row.trip_id,
    bookingDate: row.booking_date,
    startTime: row.start_time,
    durationH: row.duration_h ? Number(row.duration_h) : 0,
    groupSize: row.group_size,
    city: row.city,
    category: row.category,
    notes: row.notes,
    routePlan: row.route_plan ?? [],
    paymentMode: row.payment_mode,
    totalUsd: Number(row.total_usd ?? 0),
    depositUsd: Number(row.deposit_usd ?? 0),
    cashBalanceUsd: Number(row.cash_balance_usd ?? 0),
    cashBalanceConfirmedByBuddy: row.cash_balance_confirmed_by_buddy,
    cashBalanceConfirmedByTraveler: row.cash_balance_confirmed_by_traveler,
    status: row.status,
    safetyStatus: row.safety_status,
    cancelledAt: row.cancelled_at,
    confirmedAt: row.confirmed_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    telegraphThreadId: row.telegraph_thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapApplication(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    city: row.city,
    country: row.country,
    categories: row.categories ?? [],
    languages: row.languages ?? [],
    motivation: row.motivation,
    idVerificationRef: row.id_verification_ref,
    socialLinks: row.social_links ?? {},
    policyAccepted: row.policy_accepted,
    reviewNotes: row.review_notes,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Search ────────────────────────────────────────────────────────────────────

router.post("/api/rent-a-buddy/search", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) return res.json({ buddies: [], total: 0, page: 1, perPage: 20 });
  if (!await requireRentBuddyEnabled(sc, res)) return;

  const {
    city, category, date, groupSize, language, maxBudgetUsd,
    trustScoreMin, buddyLevel, vibeTags, femaleSafetyMode,
    publicMeetupOnly, nightlifeAvailable, availableNow,
    page = 1, perPage = 20,
  } = req.body ?? {};

  let query = sc
    .from("rent_buddy_profiles")
    .select("*", { count: "exact" })
    .eq("status", "active")
    .eq("admin_status", "active")
    .ilike("city", `%${city ?? ""}%`)
    .order("review_count", { ascending: false })
    .range((page - 1) * perPage, page * perPage - 1);

  if (category) query = query.contains("categories", [category]);
  if (language)  query = query.contains("languages", [language]);
  if (maxBudgetUsd) query = query.lte("hourly_rate_usd", maxBudgetUsd);
  if (buddyLevel) query = query.eq("buddy_level", buddyLevel);
  if (nightlifeAvailable) query = query.contains("categories", ["nightlife"]);
  if (publicMeetupOnly) query = query.eq("new_buddy_public_only", true);

  const { data, count, error } = await query;
  if (error) return sendError(res, "db_error", error.message);

  return res.json({
    buddies: (data ?? []).map(mapProfile),
    total: count ?? 0,
    page,
    perPage,
  });
});

// ── Buddy profile ─────────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/buddies/:buddyId", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) return res.json({ buddy: null, packages: [], addons: [], reviews: [], availability: [], savedByMe: false });
  if (!await requireRentBuddyEnabled(sc, res)) return;

  const auth = await requireUser(req, res);
  const userId = auth?.user.id ?? null;
  const { buddyId } = req.params;

  const [profileRes, packagesRes, addonsRes, reviewsRes, availRes] = await Promise.all([
    sc.from("rent_buddy_profiles").select("*").eq("id", buddyId).maybeSingle(),
    sc.from("rent_buddy_packages").select("*").eq("buddy_id", buddyId).eq("is_active", true),
    sc.from("rent_buddy_addons").select("*").eq("buddy_id", buddyId).eq("is_active", true),
    sc.from("rent_buddy_reviews")
      .select("*")
      .eq("reviewee_id", buddyId)
      .eq("is_public", true)
      .order("created_at", { ascending: false })
      .limit(5),
    sc.from("rent_buddy_availability")
      .select("*")
      .eq("buddy_id", buddyId)
      .gte("date", new Date().toISOString().slice(0, 10))
      .limit(30),
  ]);

  let savedByMe = false;
  if (userId && profileRes.data) {
    const { data: savedRow } = await sc
      .from("rent_buddy_saved")
      .select("buddy_id")
      .eq("user_id", userId)
      .eq("buddy_id", buddyId)
      .maybeSingle();
    savedByMe = !!savedRow;
  }

  return res.json({
    buddy: mapProfile(profileRes.data),
    packages: (packagesRes.data ?? []).map((p: any) => ({
      id: p.id, buddyId: p.buddy_id, title: p.title, description: p.description,
      category: p.category, durationH: Number(p.duration_h), priceUsd: Number(p.price_usd),
      maxGroup: p.max_group, isActive: p.is_active, createdAt: p.created_at, updatedAt: p.updated_at,
    })),
    addons: (addonsRes.data ?? []).map((a: any) => ({
      id: a.id, buddyId: a.buddy_id, title: a.title, description: a.description,
      priceUsd: Number(a.price_usd), isActive: a.is_active, createdAt: a.created_at,
    })),
    reviews: reviewsRes.data ?? [],
    availability: (availRes.data ?? []).map((av: any) => ({
      id: av.id, buddyId: av.buddy_id, date: av.date,
      timeSlots: av.time_slots ?? [], isAvailable: av.is_available, notes: av.notes,
    })),
    savedByMe,
  });
});

router.get("/api/rent-a-buddy/buddies/:buddyId/availability", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) return res.json({ availability: [] });

  const { buddyId } = req.params;
  const month = (req.query.month as string) ?? "";
  let query = sc.from("rent_buddy_availability").select("*").eq("buddy_id", buddyId);
  if (month) query = query.like("date", `${month}%`);

  const { data } = await query.order("date");
  return res.json({
    availability: (data ?? []).map((av: any) => ({
      id: av.id, buddyId: av.buddy_id, date: av.date,
      timeSlots: av.time_slots ?? [], isAvailable: av.is_available, notes: av.notes,
    })),
  });
});

router.get("/api/rent-a-buddy/buddies/:buddyId/reviews", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) return res.json({ reviews: [], total: 0 });

  const { buddyId } = req.params;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 10;

  const { data, count } = await sc
    .from("rent_buddy_reviews")
    .select("*", { count: "exact" })
    .eq("reviewee_id", buddyId)
    .eq("is_public", true)
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  return res.json({ reviews: data ?? [], total: count ?? 0 });
});

// ── Bookings — Traveler ───────────────────────────────────────────────────────

router.post("/api/rent-a-buddy/bookings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient() ?? auth.client;

  if (!await requireRentBuddyEnabled(sc, res)) return;

  const limits = await getUserLimits(sc, user.id);
  if (limits?.rent_buddy_disabled || limits?.traveler_booking_disabled) {
    return res.status(403).json({
      error: "access_limited",
      message: "Rent a Buddy access is limited while your account is under review.",
    });
  }

  const {
    buddyId, packageId, tripId, bookingDate, startTime,
    durationH, groupSize = 1, city, category, notes,
    addonIds, paymentMode = "full_in_app",
  } = req.body ?? {};

  if (!buddyId || !bookingDate || !durationH || !city || !category) {
    return res.status(400).json({ error: "invalid_payload", message: "buddyId, bookingDate, durationH, city, category required." });
  }

  if (limits?.cash_balance_disabled && paymentMode === "deposit_plus_cash") {
    return res.status(403).json({
      error: "access_limited",
      message: "Cash balance is unavailable for this booking. Full in-app payment is required.",
    });
  }

  if (limits?.full_in_app_payment_required && paymentMode !== "full_in_app") {
    return res.status(403).json({
      error: "access_limited",
      message: "Full in-app payment is required for your account.",
    });
  }

  if (limits?.nightlife_disabled && category === "nightlife") {
    return res.status(403).json({
      error: "access_limited",
      message: "Nightlife bookings are not available for your account.",
    });
  }

  const maxDurMin = limits?.max_booking_duration_minutes;
  if (maxDurMin && durationH * 60 > maxDurMin) {
    return res.status(403).json({
      error: "access_limited",
      message: `Max booking duration for your account is ${maxDurMin} minutes.`,
    });
  }

  // Fetch buddy profile for new-buddy restriction checks
  const { data: buddyProfile } = await sc
    .from("rent_buddy_profiles")
    .select("*")
    .eq("id", buddyId)
    .maybeSingle();

  if (!buddyProfile) {
    return res.status(404).json({ error: "not_found", message: "Buddy not found." });
  }

  if (buddyProfile.status !== "active" || buddyProfile.admin_status !== "active") {
    return res.status(400).json({ error: "buddy_unavailable", message: "This Buddy is not accepting bookings." });
  }

  // New Buddy: public meetup required, no nightlife/group, max hours enforced
  if (buddyProfile.new_buddy_public_only && limits?.public_meetup_required !== false) {
    if (isPrivateLocation(city)) {
      return res.status(400).json({
        error: "invalid_location",
        message: "First meetup must be at a public location (hotel lobby, airport, coffee shop, landmark, etc.). Private hotel rooms and private homes are not allowed.",
      });
    }
  }

  if (buddyProfile.new_buddy_public_only && (category === "nightlife" || category === "group") &&
      !((buddyProfile.category_approvals as any)?.[category])) {
    return res.status(403).json({
      error: "category_not_approved",
      message: `This Buddy is not approved for ${category} bookings yet.`,
    });
  }

  if (buddyProfile.new_buddy_public_only && durationH > buddyProfile.new_buddy_max_hours) {
    return res.status(400).json({
      error: "duration_exceeded",
      message: `New Buddies can accept a maximum of ${buddyProfile.new_buddy_max_hours} hours per booking.`,
    });
  }

  // Scan traveler notes for policy violations
  if (notes) {
    const matches = await scanForPolicyViolations({
      sc,
      text: notes,
      sourceType: "booking_note",
      flaggedUserId: user.id,
    });
    await applyPolicySeverity({ sc, userId: user.id, matches });
    const hasCritical = matches.some((m) => m.severity === "critical" || m.severity === "high");
    if (hasCritical) {
      return res.status(400).json({
        error: "policy_violation",
        message: "Your booking note contains content that violates Rent a Buddy policy. Please review our policy and try again.",
      });
    }
  }

  // Compute pricing
  const rateUsd = buddyProfile.hourly_rate_usd ? Number(buddyProfile.hourly_rate_usd) : 0;
  const totalUsd = rateUsd * durationH;
  const depositUsd = paymentMode === "deposit_plus_cash" ? Math.round(totalUsd * 0.3 * 100) / 100 : totalUsd;
  const cashBalanceUsd = paymentMode === "deposit_plus_cash" ? totalUsd - depositUsd : 0;

  const { data: booking, error } = await sc
    .from("rent_buddy_bookings")
    .insert({
      buddy_id: buddyId,
      traveler_id: user.id,
      package_id: packageId ?? null,
      trip_id: tripId ?? null,
      booking_date: bookingDate,
      start_time: startTime ?? null,
      duration_h: durationH,
      group_size: groupSize,
      city,
      category,
      notes: notes ?? null,
      payment_mode: paymentMode,
      total_usd: totalUsd,
      deposit_usd: depositUsd,
      cash_balance_usd: cashBalanceUsd,
      status: "pending",
      updated_at: new Date().toISOString(),
    })
    .select()
    .maybeSingle();

  if (error) return sendError(res, "db_error", error.message);

  return res.status(201).json({ booking: mapBooking(booking), policyText: POLICY_TEXT });
});

router.get("/api/rent-a-buddy/bookings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;
  if (!await requireRentBuddyEnabled(sc, res)) return;

  const { data } = await sc
    .from("rent_buddy_bookings")
    .select("*")
    .eq("traveler_id", auth.user.id)
    .order("created_at", { ascending: false });

  return res.json({ bookings: (data ?? []).map(mapBooking) });
});

router.get("/api/rent-a-buddy/bookings/:bookingId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;
  if (!await requireRentBuddyEnabled(sc, res)) return;

  const { bookingId } = req.params;
  const { data } = await sc
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();

  if (!data) return res.status(404).json({ error: "not_found" });

  const b = data as any;
  if (b.traveler_id !== auth.user.id) {
    const { data: bp } = await sc
      .from("rent_buddy_profiles")
      .select("id")
      .eq("user_id", auth.user.id)
      .maybeSingle();
    if (!bp || bp.id !== b.buddy_id) return res.status(403).json({ error: "forbidden" });
  }

  return res.json({ booking: mapBooking(data), policyText: POLICY_TEXT });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/cancel", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { bookingId } = req.params;
  const { data: booking } = await sc
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  const b = booking as any;
  const isParty = b.traveler_id === auth.user.id;
  if (!isParty) return res.status(403).json({ error: "forbidden" });

  const now = new Date();
  const bookingDt = new Date(`${b.booking_date}T${b.start_time ?? "00:00"}Z`);
  const hoursUntil = (bookingDt.getTime() - now.getTime()) / 3600000;
  const eventType = hoursUntil < 2 ? "rent_buddy_late_cancel" : "rent_buddy_abandoned_booking";

  await sc
    .from("rent_buddy_bookings")
    .update({ status: "cancelled", cancelled_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("id", bookingId);

  void recordTrustEvent(sc, {
    userId: auth.user.id,
    eventType,
    category: "communication",
    delta: hoursUntil < 2 ? -5 : -2,
    severity: "minor",
    sourceType: "booking",
    sourceId: bookingId,
  });

  return res.json({ ok: true });
});

// ── Bookings — Buddy-side lifecycle ───────────────────────────────────────────

router.post("/api/rent-a-buddy/bookings/:bookingId/accept", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { data: bp } = await sc
    .from("rent_buddy_profiles")
    .select("id, status, admin_status")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (!bp || bp.status !== "active" || bp.admin_status !== "active") {
    return res.status(403).json({ error: "forbidden", message: "Your Buddy profile is not active." });
  }

  const limits = await getUserLimits(sc, auth.user.id);
  if (limits?.rent_buddy_disabled || limits?.buddy_disabled) {
    return res.status(403).json({ error: "access_limited", message: "Rent a Buddy access is limited while your account is under review." });
  }

  const { bookingId } = req.params;
  const { data: booking } = await sc
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .eq("buddy_id", (bp as any).id)
    .eq("status", "pending")
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  const now = new Date().toISOString();
  await sc
    .from("rent_buddy_bookings")
    .update({ status: "confirmed", confirmed_at: now, updated_at: now })
    .eq("id", bookingId);

  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/decline", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { data: bp } = await sc
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (!bp) return res.status(403).json({ error: "forbidden" });

  const { bookingId } = req.params;
  const now = new Date().toISOString();
  await sc
    .from("rent_buddy_bookings")
    .update({ status: "cancelled", cancelled_at: now, updated_at: now })
    .eq("id", bookingId)
    .eq("buddy_id", (bp as any).id);

  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/start", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { bookingId } = req.params;
  const { data: booking } = await sc
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .eq("traveler_id", auth.user.id)
    .eq("status", "confirmed")
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  const now = new Date().toISOString();
  await sc
    .from("rent_buddy_bookings")
    .update({ status: "in_progress", started_at: now, updated_at: now })
    .eq("id", bookingId);

  await sc.from("rent_buddy_emergency_contacts_snapshot").insert({
    booking_id: bookingId,
    user_id: auth.user.id,
    trusted_circle_shared: req.body?.trustedCircleShared ?? false,
    safe_return_enabled: req.body?.safeReturnEnabled ?? false,
    emergency_contact_count: req.body?.emergencyContactCount ?? 0,
  });

  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/complete", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { bookingId } = req.params;
  const { data: booking } = await sc
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .eq("traveler_id", auth.user.id)
    .eq("status", "in_progress")
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  const now = new Date().toISOString();
  await sc
    .from("rent_buddy_bookings")
    .update({ status: "completed", completed_at: now, updated_at: now })
    .eq("id", bookingId);

  await sc
    .from("rent_buddy_profiles")
    .update({ completed_bookings: ((booking as any).completed_bookings ?? 0) + 1 })
    .eq("id", (booking as any).buddy_id);

  void recordTrustEvent(sc, {
    userId: auth.user.id,
    eventType: "rent_buddy_completed",
    category: "community_value",
    delta: 5,
    severity: "minor",
    sourceType: "booking",
    sourceId: bookingId,
  });

  void recordTrustEvent(sc, {
    userId: auth.user.id,
    eventType: "rent_buddy_stayed_on_app",
    category: "community_value",
    delta: 3,
    severity: "minor",
    sourceType: "booking",
    sourceId: bookingId,
  });

  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/confirm-cash", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { bookingId } = req.params;
  const { confirmed } = req.body ?? {};

  const { data: booking } = await sc
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });
  const b = booking as any;

  const { data: bp } = await sc
    .from("rent_buddy_profiles")
    .select("id, user_id")
    .eq("id", b.buddy_id)
    .maybeSingle();

  const isTraveler = b.traveler_id === auth.user.id;
  const isBuddy = bp && (bp as any).user_id === auth.user.id;

  if (!isTraveler && !isBuddy) return res.status(403).json({ error: "forbidden" });

  const updatePatch: Record<string, any> = { updated_at: new Date().toISOString() };

  if (isTraveler) updatePatch.cash_balance_confirmed_by_traveler = confirmed;
  if (isBuddy)    updatePatch.cash_balance_confirmed_by_buddy = confirmed;

  await sc.from("rent_buddy_bookings").update(updatePatch).eq("id", bookingId);

  const refreshed = { ...b, ...updatePatch };
  const tConfirmed = refreshed.cash_balance_confirmed_by_traveler;
  const bConfirmed = refreshed.cash_balance_confirmed_by_buddy;

  if (tConfirmed === false || bConfirmed === false) {
    // Disagreement → disputed
    await sc.from("rent_buddy_bookings")
      .update({ status: "disputed", updated_at: new Date().toISOString() })
      .eq("id", bookingId);

    await sc.from("rent_buddy_disputes").insert({
      booking_id: bookingId,
      raised_by: auth.user.id,
      reason: "cash_balance_disagreement",
      status: "open",
    });

    return res.json({ ok: true, disputed: true });
  }

  if (tConfirmed && bConfirmed) {
    void recordTrustEvent(sc, {
      userId: b.traveler_id,
      eventType: "rent_buddy_cash_balance_confirmed",
      category: "community_value",
      delta: 2,
      severity: "minor",
      sourceType: "booking",
      sourceId: bookingId,
    });
  }

  return res.json({ ok: true, disputed: false });
});

// ── Booking — Route management ─────────────────────────────────────────────────

router.post("/api/rent-a-buddy/bookings/:bookingId/route", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { bookingId } = req.params;
  const { stops } = req.body ?? {};

  if (!Array.isArray(stops)) {
    return res.status(400).json({ error: "invalid_payload", message: "stops array required." });
  }

  const { data: booking } = await sc
    .from("rent_buddy_bookings")
    .select("buddy_id, traveler_id")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  const b = booking as any;
  const { data: bp } = await sc
    .from("rent_buddy_profiles").select("id, user_id").eq("id", b.buddy_id).maybeSingle();
  const isBuddy = bp && (bp as any).user_id === auth.user.id;
  if (!isBuddy) return res.status(403).json({ error: "forbidden" });

  await sc.from("rent_buddy_route_stops").delete().eq("booking_id", bookingId);

  const inserts = stops.map((s: any, i: number) => ({
    booking_id: bookingId,
    stop_order: i + 1,
    name: s.name ?? `Stop ${i + 1}`,
    notes: s.notes ?? null,
    eta: s.eta ?? null,
    lat: s.lat ?? null,
    lng: s.lng ?? null,
  }));

  await sc.from("rent_buddy_route_stops").insert(inserts);
  await sc.from("rent_buddy_bookings").update({ route_plan: stops, updated_at: new Date().toISOString() }).eq("id", bookingId);

  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/route-change", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { bookingId } = req.params;
  const { newStops, reason } = req.body ?? {};

  const { data: booking } = await sc
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });
  const b = booking as any;

  const { data: bp } = await sc
    .from("rent_buddy_profiles").select("id, user_id").eq("id", b.buddy_id).maybeSingle();
  const isBuddy = bp && (bp as any).user_id === auth.user.id;
  if (!isBuddy) return res.status(403).json({ error: "forbidden" });

  // Scan new stops for private location flags
  const stopText = (newStops ?? []).map((s: any) => s.name ?? "").join(" ");
  if (stopText) {
    const matches = await scanForPolicyViolations({
      sc,
      text: stopText,
      sourceType: "route_change",
      bookingId,
      flaggedUserId: auth.user.id,
    });
    await applyPolicySeverity({ sc, userId: auth.user.id, matches });
  }

  const { data: changeReq } = await sc
    .from("rent_buddy_route_change_requests")
    .insert({
      booking_id: bookingId,
      requested_by: auth.user.id,
      old_stops_json: b.route_plan ?? [],
      new_stops_json: newStops ?? [],
      reason: reason ?? null,
    })
    .select()
    .maybeSingle();

  return res.status(201).json({ routeChangeRequest: changeReq });
});

// ── Booking — Reviews ─────────────────────────────────────────────────────────

router.post("/api/rent-a-buddy/bookings/:bookingId/review", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { bookingId } = req.params;
  const { rating, body: reviewBody, safetyScore, communicationScore, punctualityScore, isPublic = false, photos = [] } = req.body ?? {};

  if (!rating) return res.status(400).json({ error: "invalid_payload", message: "rating required." });

  const { data: booking } = await sc
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });
  const b = booking as any;

  const { data: bp } = await sc
    .from("rent_buddy_profiles").select("id, user_id").eq("id", b.buddy_id).maybeSingle();
  const isTraveler = b.traveler_id === auth.user.id;
  const isBuddy = bp && (bp as any).user_id === auth.user.id;
  if (!isTraveler && !isBuddy) return res.status(403).json({ error: "forbidden" });

  const role = isTraveler ? "traveler" : "buddy";
  const revieweeId = isTraveler ? b.buddy_id : b.traveler_id;

  // Double-blind: blind until 7 days after booking date or both submitted
  const blindUntil = new Date(b.booking_date);
  blindUntil.setDate(blindUntil.getDate() + 7);

  const { data: review, error } = await sc
    .from("rent_buddy_reviews")
    .insert({
      booking_id: bookingId,
      reviewer_id: auth.user.id,
      reviewee_id: revieweeId,
      role,
      rating,
      safety_score: safetyScore ?? null,
      communication_score: communicationScore ?? null,
      punctuality_score: punctualityScore ?? null,
      body: reviewBody ?? null,
      photos,
      is_public: false,
      blind_until: blindUntil.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select()
    .maybeSingle();

  if (error) return sendError(res, "db_error", error.message);

  // Check if both sides submitted — if so, reveal both
  const { count } = await sc
    .from("rent_buddy_reviews")
    .select("id", { count: "exact" })
    .eq("booking_id", bookingId);

  let unblinded = false;
  if ((count ?? 0) >= 2) {
    await sc.from("rent_buddy_reviews")
      .update({ is_public: true, blind_until: new Date().toISOString() })
      .eq("booking_id", bookingId);
    unblinded = true;

    void recordTrustEvent(sc, {
      userId: auth.user.id,
      eventType: "rent_buddy_positive_review",
      category: "community_value",
      delta: rating >= 4 ? 4 : 2,
      severity: "minor",
      sourceType: "review",
      sourceId: review?.id,
    });
  }

  return res.status(201).json({ review, unblinded });
});

// ── Booking — Report ──────────────────────────────────────────────────────────

router.post("/api/rent-a-buddy/bookings/:bookingId/report", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { bookingId } = req.params;
  const { reason = "other", details } = req.body ?? {};

  const { data: booking } = await sc
    .from("rent_buddy_bookings")
    .select("traveler_id, buddy_id")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });
  const b = booking as any;

  const { data: bp } = await sc
    .from("rent_buddy_profiles").select("id, user_id").eq("id", b.buddy_id).maybeSingle();
  const isTraveler = b.traveler_id === auth.user.id;
  const isBuddy = bp && (bp as any).user_id === auth.user.id;
  if (!isTraveler && !isBuddy) return res.status(403).json({ error: "forbidden" });

  await sc.from("rent_buddy_disputes").insert({
    booking_id: bookingId,
    raised_by: auth.user.id,
    reason,
    status: "open",
  });

  if (details) {
    await scanForPolicyViolations({
      sc,
      text: details,
      sourceType: "report",
      bookingId,
      reporterUserId: auth.user.id,
    });
  }

  void recordTrustEvent(sc, {
    userId: isTraveler ? b.buddy_id : b.traveler_id,
    eventType: "rent_buddy_harassment_report_confirmed",
    category: "respect_safety",
    delta: -10,
    severity: "serious",
    sourceType: "booking",
    sourceId: bookingId,
  });

  return res.status(201).json({ ok: true });
});

// ── Safety routes ─────────────────────────────────────────────────────────────

router.post("/api/rent-a-buddy/bookings/:bookingId/safety/checkin", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { bookingId } = req.params;
  const { checkinType, response: checkinResponse } = req.body ?? {};

  if (!checkinType) return res.status(400).json({ error: "invalid_payload", message: "checkinType required." });

  const { data: booking } = await sc
    .from("rent_buddy_bookings")
    .select("traveler_id, buddy_id")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  await sc.from("rent_buddy_safety_checkins").insert({
    booking_id: bookingId,
    user_id: auth.user.id,
    checkin_type: checkinType,
    response: checkinResponse ?? null,
  });

  const distressResponses = ["uncomfortable", "end_early", "contact_support", "start_safe_return"];
  if (distressResponses.includes(checkinResponse ?? "") || distressResponses.includes(checkinType)) {
    await sc.from("rent_buddy_safety_events").insert({
      booking_id: bookingId,
      actor_user_id: auth.user.id,
      event_type: "comfort_check_distress",
      event_status: "open",
      metadata: { checkin_type: checkinType, response: checkinResponse },
    });
  }

  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/safety/feel-unsafe", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { bookingId } = req.params;

  const { data: booking } = await sc
    .from("rent_buddy_bookings")
    .select("traveler_id, buddy_id")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  await sc
    .from("rent_buddy_bookings")
    .update({ safety_status: "uncomfortable", updated_at: new Date().toISOString() })
    .eq("id", bookingId);

  await sc.from("rent_buddy_safety_events").insert({
    booking_id: bookingId,
    actor_user_id: auth.user.id,
    event_type: "feel_unsafe",
    event_status: "open",
    metadata: req.body ?? {},
  });

  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/safety/end-early", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { bookingId } = req.params;
  const now = new Date().toISOString();

  await sc
    .from("rent_buddy_bookings")
    .update({ status: "completed", completed_at: now, safety_status: "emergency", updated_at: now })
    .eq("id", bookingId);

  await sc.from("rent_buddy_safety_events").insert({
    booking_id: bookingId,
    actor_user_id: auth.user.id,
    event_type: "end_early",
    event_status: "open",
    metadata: req.body ?? {},
  });

  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/safety/emergency-phrase", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { bookingId } = req.params;

  const { data: booking } = await sc
    .from("rent_buddy_bookings")
    .select("traveler_id")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });
  if ((booking as any).traveler_id !== auth.user.id) {
    return res.status(403).json({ error: "forbidden" });
  }

  await sc.from("rent_buddy_safety_events").insert({
    booking_id: bookingId,
    actor_user_id: auth.user.id,
    event_type: "emergency_phrase_triggered",
    event_status: "open",
    metadata: { phrase: "I need to check my passport" },
  });

  await sc
    .from("rent_buddy_bookings")
    .update({ safety_status: "check_requested", updated_at: new Date().toISOString() })
    .eq("id", bookingId);

  // Private prompt — returned to traveler ONLY. Buddy is never notified.
  return res.json({
    travelerOnly: true,
    prompt: "Are you okay? Only you can see this message.",
    options: [
      { id: "ok",            label: "I am okay" },
      { id: "end_booking",   label: "End booking now" },
      { id: "share_location",label: "Share location with Trusted Circle" },
      { id: "safe_return",   label: "Start Safe Return" },
      { id: "contact_support",label: "Contact support" },
      { id: "emergency",     label: "Use emergency button" },
    ],
  });
});

// ── Application ───────────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/apply", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;
  if (!await requireRentBuddyEnabled(sc, res)) return;

  const { data } = await sc
    .from("rent_buddy_applications")
    .select("*")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  return res.json({ application: mapApplication(data) });
});

router.post("/api/rent-a-buddy/apply", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;
  if (!await requireRentBuddyEnabled(sc, res)) return;

  const { city, country, categories = [], languages = [], motivation, socialLinks = {} } = req.body ?? {};
  if (!city) return res.status(400).json({ error: "invalid_payload", message: "city required." });

  if (motivation) {
    const matches = await scanForPolicyViolations({
      sc,
      text: motivation,
      sourceType: "profile",
      flaggedUserId: auth.user.id,
    });
    await applyPolicySeverity({ sc, userId: auth.user.id, matches });
  }

  const { data, error } = await sc
    .from("rent_buddy_applications")
    .upsert({
      user_id: auth.user.id,
      city,
      country: country ?? null,
      categories,
      languages,
      motivation: motivation ?? null,
      social_links: socialLinks,
      policy_accepted: true,
      policy_accepted_at: new Date().toISOString(),
      status: "pending",
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" })
    .select()
    .maybeSingle();

  if (error) return sendError(res, "db_error", error.message);

  return res.status(201).json({
    application: mapApplication(data),
    message: "Application submitted. Our team will review it soon.",
    policyText: POLICY_TEXT,
  });
});

// ── Buddy me profile ──────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/me/profile", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { data } = await sc
    .from("rent_buddy_profiles")
    .select("*")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  return res.json({ profile: mapProfile(data) });
});

router.patch("/api/rent-a-buddy/me/profile", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const allowed = ["display_name","tagline","bio","intro_video_url","languages","categories",
                   "hourly_rate_usd","cover_photo_url","gallery_urls","vibe_tags",
                   "preferred_meetup_zones","max_group_size"];
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  const body = req.body ?? {};
  for (const k of allowed) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (body.displayName !== undefined)  patch.display_name   = body.displayName;
  if (body.tagline !== undefined)       patch.tagline        = body.tagline;
  if (body.bio !== undefined)           patch.bio            = body.bio;
  if (body.introVideoUrl !== undefined) patch.intro_video_url = body.introVideoUrl;

  if (body.bio) {
    const matches = await scanForPolicyViolations({
      sc,
      text: body.bio,
      sourceType: "profile",
      flaggedUserId: auth.user.id,
    });
    await applyPolicySeverity({ sc, userId: auth.user.id, matches });
  }

  await sc.from("rent_buddy_profiles").update(patch).eq("user_id", auth.user.id);
  return res.json({ ok: true });
});

router.patch("/api/rent-a-buddy/me/availability", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { data: bp } = await sc
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (!bp) return res.status(404).json({ error: "profile_not_found" });

  const { entries = [] } = req.body ?? {};
  for (const e of entries as any[]) {
    await sc.from("rent_buddy_availability").upsert({
      buddy_id: (bp as any).id,
      date: e.date,
      time_slots: e.timeSlots ?? [],
      is_available: e.isAvailable ?? true,
      notes: e.notes ?? null,
    }, { onConflict: "buddy_id,date" });
  }

  return res.json({ ok: true });
});

router.get("/api/rent-a-buddy/me/requests", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { data: bp } = await sc
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (!bp) return res.json({ requests: [] });

  const { data } = await sc
    .from("rent_buddy_bookings")
    .select("*")
    .eq("buddy_id", (bp as any).id)
    .in("status", ["pending", "confirmed"])
    .order("booking_date", { ascending: true });

  return res.json({ requests: (data ?? []).map(mapBooking) });
});

// ── Saved ─────────────────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/saved", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { data } = await sc
    .from("rent_buddy_saved")
    .select("buddy_id, rent_buddy_profiles(*)")
    .eq("user_id", auth.user.id);

  return res.json({
    saved: (data ?? []).map((row: any) => mapProfile(row.rent_buddy_profiles)),
  });
});

router.post("/api/rent-a-buddy/saved/:buddyId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { buddyId } = req.params;
  await sc.from("rent_buddy_saved").upsert({ user_id: auth.user.id, buddy_id: buddyId });
  return res.json({ ok: true });
});

router.delete("/api/rent-a-buddy/saved/:buddyId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { buddyId } = req.params;
  await sc.from("rent_buddy_saved").delete().eq("user_id", auth.user.id).eq("buddy_id", buddyId);
  return res.json({ ok: true });
});

// ── Waitlist ──────────────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/waitlist", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { data } = await sc
    .from("rent_buddy_waitlist")
    .select("id, city, category, created_at")
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false });

  return res.json({ waitlist: (data ?? []).map((r: any) => ({ id: r.id, city: r.city, category: r.category, createdAt: r.created_at })) });
});

router.post("/api/rent-a-buddy/waitlist", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { city, category } = req.body ?? {};
  if (!city) return res.status(400).json({ error: "invalid_payload", message: "city required." });

  await sc.from("rent_buddy_waitlist").upsert(
    { user_id: auth.user.id, city, category: category ?? null },
    { onConflict: "user_id,city" },
  );

  return res.status(201).json({ ok: true });
});

router.delete("/api/rent-a-buddy/waitlist/:city", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  await sc.from("rent_buddy_waitlist")
    .delete()
    .eq("user_id", auth.user.id)
    .eq("city", decodeURIComponent(req.params.city));

  return res.json({ ok: true });
});

// ── Buddy Dashboard ───────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/dashboard", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { data: profile } = await sc
    .from("rent_buddy_profiles")
    .select("*")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (!profile) {
    return res.json({ profile: null, upcomingBookings: 0, pendingRequests: 0, totalEarningsUsd: 0, averageRating: null, reviewCount: 0 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const [upcomingRes, pendingRes, earningsRes] = await Promise.all([
    sc.from("rent_buddy_bookings").select("id", { count: "exact" }).eq("buddy_id", (profile as any).id).eq("status", "confirmed").gte("booking_date", today),
    sc.from("rent_buddy_bookings").select("id", { count: "exact" }).eq("buddy_id", (profile as any).id).eq("status", "pending"),
    sc.from("rent_buddy_bookings").select("total_usd").eq("buddy_id", (profile as any).id).eq("status", "completed"),
  ]);

  const totalEarnings = (earningsRes.data ?? []).reduce((s: number, r: any) => s + Number(r.total_usd ?? 0), 0);

  return res.json({
    profile: mapProfile(profile),
    upcomingBookings: upcomingRes.count ?? 0,
    pendingRequests: pendingRes.count ?? 0,
    totalEarningsUsd: totalEarnings,
    averageRating: (profile as any).average_rating ? Number((profile as any).average_rating) : null,
    reviewCount: (profile as any).review_count ?? 0,
  });
});

router.get("/api/rent-a-buddy/dashboard/requests", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { data: bp } = await sc.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.json({ requests: [] });

  const { data } = await sc
    .from("rent_buddy_bookings")
    .select("*")
    .eq("buddy_id", (bp as any).id)
    .in("status", ["pending"])
    .order("created_at", { ascending: false });

  return res.json({ requests: (data ?? []).map(mapBooking) });
});

router.get("/api/rent-a-buddy/dashboard/availability", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { data: bp } = await sc.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.json({ availability: [] });

  const { data } = await sc
    .from("rent_buddy_availability")
    .select("*")
    .eq("buddy_id", (bp as any).id)
    .gte("date", new Date().toISOString().slice(0, 10))
    .order("date");

  return res.json({
    availability: (data ?? []).map((av: any) => ({
      id: av.id, buddyId: av.buddy_id, date: av.date,
      timeSlots: av.time_slots ?? [], isAvailable: av.is_available, notes: av.notes,
    })),
  });
});

router.post("/api/rent-a-buddy/dashboard/availability", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { data: bp } = await sc.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });

  const { entries = [] } = req.body ?? {};
  for (const e of entries as any[]) {
    await sc.from("rent_buddy_availability").upsert({
      buddy_id: (bp as any).id,
      date: e.date,
      time_slots: e.timeSlots ?? [],
      is_available: e.isAvailable ?? true,
      notes: e.notes ?? null,
    }, { onConflict: "buddy_id,date" });
  }

  return res.json({ ok: true });
});

router.patch("/api/rent-a-buddy/dashboard/offer", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const body = req.body ?? {};
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (body.displayName !== undefined)  patch.display_name   = body.displayName;
  if (body.tagline !== undefined)       patch.tagline        = body.tagline;
  if (body.bio !== undefined)           patch.bio            = body.bio;
  if (body.languages !== undefined)     patch.languages      = body.languages;
  if (body.categories !== undefined)    patch.categories     = body.categories;
  if (body.hourlyRateUsd !== undefined) patch.hourly_rate_usd = body.hourlyRateUsd;

  await sc.from("rent_buddy_profiles").update(patch).eq("user_id", auth.user.id);
  return res.json({ ok: true });
});

// ── Dashboard — Packages ──────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/dashboard/packages", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;
  const { data: bp } = await sc.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.json({ packages: [] });
  const { data } = await sc.from("rent_buddy_packages").select("*").eq("buddy_id", (bp as any).id).order("created_at");
  return res.json({ packages: data ?? [] });
});

router.post("/api/rent-a-buddy/dashboard/packages", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;
  const { data: bp } = await sc.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });
  const { title, description, category, durationH, priceUsd, maxGroup = 1 } = req.body ?? {};
  if (!title || !category || !durationH || !priceUsd) {
    return res.status(400).json({ error: "invalid_payload", message: "title, category, durationH, priceUsd required." });
  }
  const { data } = await sc.from("rent_buddy_packages").insert({
    buddy_id: (bp as any).id, title, description: description ?? null, category,
    duration_h: durationH, price_usd: priceUsd, max_group: maxGroup, is_active: true,
    updated_at: new Date().toISOString(),
  }).select().maybeSingle();
  return res.status(201).json({ pkg: data });
});

router.patch("/api/rent-a-buddy/dashboard/packages/:packageId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;
  const { data: bp } = await sc.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });
  const body = req.body ?? {};
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (body.title !== undefined)      patch.title       = body.title;
  if (body.description !== undefined) patch.description = body.description;
  if (body.durationH !== undefined)   patch.duration_h  = body.durationH;
  if (body.priceUsd !== undefined)    patch.price_usd   = body.priceUsd;
  if (body.maxGroup !== undefined)    patch.max_group   = body.maxGroup;
  if (body.isActive !== undefined)    patch.is_active   = body.isActive;
  await sc.from("rent_buddy_packages").update(patch).eq("id", req.params.packageId).eq("buddy_id", (bp as any).id);
  return res.json({ ok: true });
});

router.delete("/api/rent-a-buddy/dashboard/packages/:packageId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;
  const { data: bp } = await sc.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });
  await sc.from("rent_buddy_packages").delete().eq("id", req.params.packageId).eq("buddy_id", (bp as any).id);
  return res.json({ ok: true });
});

// ── Dashboard — Addons ────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/dashboard/addons", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;
  const { data: bp } = await sc.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.json({ addons: [] });
  const { data } = await sc.from("rent_buddy_addons").select("*").eq("buddy_id", (bp as any).id).order("created_at");
  return res.json({ addons: data ?? [] });
});

router.post("/api/rent-a-buddy/dashboard/addons", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;
  const { data: bp } = await sc.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });
  const { title, description, priceUsd } = req.body ?? {};
  if (!title || !priceUsd) return res.status(400).json({ error: "invalid_payload", message: "title, priceUsd required." });
  const { data } = await sc.from("rent_buddy_addons").insert({
    buddy_id: (bp as any).id, title, description: description ?? null, price_usd: priceUsd, is_active: true,
  }).select().maybeSingle();
  return res.status(201).json({ addon: data });
});

router.patch("/api/rent-a-buddy/dashboard/addons/:addonId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;
  const { data: bp } = await sc.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });
  const body = req.body ?? {};
  const patch: Record<string, any> = {};
  if (body.title !== undefined)       patch.title       = body.title;
  if (body.description !== undefined) patch.description = body.description;
  if (body.priceUsd !== undefined)    patch.price_usd   = body.priceUsd;
  if (body.isActive !== undefined)    patch.is_active   = body.isActive;
  await sc.from("rent_buddy_addons").update(patch).eq("id", req.params.addonId).eq("buddy_id", (bp as any).id);
  return res.json({ ok: true });
});

router.delete("/api/rent-a-buddy/dashboard/addons/:addonId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;
  const { data: bp } = await sc.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });
  await sc.from("rent_buddy_addons").delete().eq("id", req.params.addonId).eq("buddy_id", (bp as any).id);
  return res.json({ ok: true });
});

// ── Dashboard — Earnings ──────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/dashboard/earnings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient() ?? auth.client;

  const { data: bp } = await sc.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.json({ totalUsd: 0, thisMonthUsd: 0, completedBookings: 0, breakdown: [] });

  const { data } = await sc
    .from("rent_buddy_bookings")
    .select("total_usd, booking_date")
    .eq("buddy_id", (bp as any).id)
    .eq("status", "completed");

  const rows = (data ?? []) as any[];
  const totalUsd = rows.reduce((s: number, r: any) => s + Number(r.total_usd ?? 0), 0);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const thisMonthUsd = rows.filter((r: any) => (r.booking_date ?? "").startsWith(thisMonth))
    .reduce((s: number, r: any) => s + Number(r.total_usd ?? 0), 0);

  const byMonth: Record<string, { total: number; count: number }> = {};
  for (const r of rows) {
    const m = (r.booking_date ?? "").slice(0, 7);
    if (!byMonth[m]) byMonth[m] = { total: 0, count: 0 };
    byMonth[m].total += Number(r.total_usd ?? 0);
    byMonth[m].count++;
  }

  return res.json({
    totalUsd,
    thisMonthUsd,
    completedBookings: rows.length,
    breakdown: Object.entries(byMonth).map(([month, v]) => ({ month, totalUsd: v.total, bookingCount: v.count })),
  });
});

// ── Admin routes ──────────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/admin/applications", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const status = (req.query.status as string) ?? undefined;

  let query = sc
    .from("rent_buddy_applications")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (status) query = query.eq("status", status);

  const { data, count } = await query;
  return res.json({ applications: (data ?? []).map(mapApplication), total: count ?? 0 });
});

router.patch("/api/rent-a-buddy/admin/applications/:appId", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId } = admin;

  const { appId } = req.params;
  const { status, reviewNotes } = req.body ?? {};

  if (!["approved", "rejected", "under_review"].includes(status)) {
    return res.status(400).json({ error: "invalid_payload", message: "status must be approved|rejected|under_review." });
  }

  const { data: app } = await sc
    .from("rent_buddy_applications")
    .select("user_id")
    .eq("id", appId)
    .maybeSingle();

  if (!app) return res.status(404).json({ error: "not_found" });

  await sc.from("rent_buddy_applications").update({
    status,
    review_notes: reviewNotes ?? null,
    reviewed_by: userId,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", appId);

  if (status === "approved") {
    await sc.from("rent_buddy_profiles").upsert({
      user_id: (app as any).user_id,
      city: (app as any).city ?? "Unknown",
      status: "active",
      admin_status: "active",
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
  }

  await sc.from("rent_buddy_admin_actions").insert({
    admin_id: userId,
    target_type: "application",
    target_id: appId,
    action: `status_changed_to_${status}`,
    notes: reviewNotes ?? null,
  });

  return res.json({ ok: true });
});

router.get("/api/rent-a-buddy/admin/buddies", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const { data, count } = await sc
    .from("rent_buddy_profiles")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  return res.json({ buddies: (data ?? []).map(mapProfile), total: count ?? 0 });
});

router.get("/api/rent-a-buddy/admin/bookings", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const status = (req.query.status as string) ?? undefined;

  let query = sc
    .from("rent_buddy_bookings")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (status) query = query.eq("status", status);

  const { data, count } = await query;
  return res.json({ bookings: (data ?? []).map(mapBooking), total: count ?? 0 });
});

router.get("/api/rent-a-buddy/admin/analytics", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const [totalBuddies, activeBuddies, totalBookings, completedBookings, pendingApps] = await Promise.all([
    sc.from("rent_buddy_profiles").select("id", { count: "exact" }),
    sc.from("rent_buddy_profiles").select("id", { count: "exact" }).eq("status", "active"),
    sc.from("rent_buddy_bookings").select("id", { count: "exact" }),
    sc.from("rent_buddy_bookings").select("id", { count: "exact" }).eq("status", "completed"),
    sc.from("rent_buddy_applications").select("id", { count: "exact" }).eq("status", "pending"),
  ]);

  const { data: revenueData } = await sc
    .from("rent_buddy_bookings")
    .select("total_usd")
    .eq("status", "completed");

  const totalRevenueUsd = (revenueData ?? []).reduce((s: number, r: any) => s + Number(r.total_usd ?? 0), 0);

  return res.json({
    totalBuddies: totalBuddies.count ?? 0,
    activeBuddies: activeBuddies.count ?? 0,
    totalBookings: totalBookings.count ?? 0,
    completedBookings: completedBookings.count ?? 0,
    totalRevenueUsd,
    pendingApplications: pendingApps.count ?? 0,
  });
});

// ── Admin — Safety flags ──────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/admin/safety/flags", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const severity = (req.query.severity as string) ?? undefined;
  const status = (req.query.status as string) ?? "open";

  let query = sc
    .from("rent_buddy_policy_flags")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (severity) query = query.eq("severity", severity);
  if (status)   query = query.eq("status", status);

  const { data, count } = await query;
  return res.json({ flags: data ?? [], total: count ?? 0 });
});

router.post("/api/rent-a-buddy/admin/safety/flags/:flagId/dismiss", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId } = admin;

  const { flagId } = req.params;
  await sc.from("rent_buddy_policy_flags").update({
    status: "dismissed",
    admin_notes: req.body?.notes ?? null,
    resolved_at: new Date().toISOString(),
  }).eq("id", flagId);

  await sc.from("rent_buddy_admin_actions").insert({
    admin_id: userId,
    target_type: "flag",
    target_id: flagId,
    action: "dismissed",
    notes: req.body?.notes ?? null,
  });

  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/admin/safety/flags/:flagId/confirm", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId } = admin;

  const { flagId } = req.params;
  const { data: flag } = await sc
    .from("rent_buddy_policy_flags")
    .select("*")
    .eq("id", flagId)
    .maybeSingle();

  if (!flag) return res.status(404).json({ error: "not_found" });
  const f = flag as any;

  await sc.from("rent_buddy_policy_flags").update({
    status: "resolved",
    admin_notes: req.body?.notes ?? null,
    resolved_at: new Date().toISOString(),
  }).eq("id", flagId);

  // Apply Trust Score penalty for confirmed flag
  if (f.flagged_user_id) {
    const severityDelta: Record<string, number> = { critical: -30, high: -15, medium: -8, low: -3 };
    const trustSeverity: Record<string, string> = { critical: "severe", high: "serious", medium: "moderate", low: "minor" };
    void recordTrustEvent(sc, {
      userId: f.flagged_user_id,
      eventType: "rent_buddy_policy_flag_confirmed",
      category: "respect_safety",
      delta: severityDelta[f.severity] ?? -5,
      severity: (trustSeverity[f.severity] ?? "minor") as any,
      sourceType: "admin",
      sourceId: flagId,
    });

    // Risk hold for critical
    if (f.severity === "critical") {
      await sc.from("rent_buddy_profiles")
        .update({ risk_hold: true })
        .eq("user_id", f.flagged_user_id);
    }
  }

  await sc.from("rent_buddy_admin_actions").insert({
    admin_id: userId,
    target_type: "flag",
    target_id: flagId,
    action: "confirmed",
    notes: req.body?.notes ?? null,
  });

  return res.json({ ok: true });
});

// ── Admin — Safety events ─────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/admin/safety/events", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const status = (req.query.status as string) ?? "open";

  let query = sc
    .from("rent_buddy_safety_events")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (status) query = query.eq("event_status", status);

  const { data, count } = await query;
  return res.json({ events: data ?? [], total: count ?? 0 });
});

// ── Admin — User limits ───────────────────────────────────────────────────────

router.post("/api/rent-a-buddy/admin/users/:userId/limits", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminId } = admin;

  const { userId } = req.params;
  const {
    rentBuddyDisabled = false,
    buddyDisabled = false,
    travelerBookingDisabled = false,
    nightlifeDisabled = false,
    cashBalanceDisabled = false,
    maxBookingDurationMinutes,
    publicMeetupRequired = false,
    fullInAppPaymentRequired = false,
    reason,
  } = req.body ?? {};

  const { data, error } = await sc.from("rent_buddy_user_limits").upsert({
    user_id: userId,
    rent_buddy_disabled: rentBuddyDisabled,
    buddy_disabled: buddyDisabled,
    traveler_booking_disabled: travelerBookingDisabled,
    nightlife_disabled: nightlifeDisabled,
    cash_balance_disabled: cashBalanceDisabled,
    max_booking_duration_minutes: maxBookingDurationMinutes ?? null,
    public_meetup_required: publicMeetupRequired,
    full_in_app_payment_required: fullInAppPaymentRequired,
    reason: reason ?? null,
    created_by_admin_id: adminId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" }).select().maybeSingle();

  if (error) return sendError(res, "db_error", error.message);

  await sc.from("rent_buddy_admin_actions").insert({
    admin_id: adminId,
    target_type: "user",
    target_id: userId,
    action: "limits_applied",
    notes: reason ?? null,
  });

  return res.status(201).json({ limits: data });
});

router.patch("/api/rent-a-buddy/admin/users/:userId/limits", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminId } = admin;

  const { userId } = req.params;
  const body = req.body ?? {};
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };

  if (body.rentBuddyDisabled !== undefined)          patch.rent_buddy_disabled            = body.rentBuddyDisabled;
  if (body.buddyDisabled !== undefined)               patch.buddy_disabled                 = body.buddyDisabled;
  if (body.travelerBookingDisabled !== undefined)     patch.traveler_booking_disabled      = body.travelerBookingDisabled;
  if (body.nightlifeDisabled !== undefined)           patch.nightlife_disabled             = body.nightlifeDisabled;
  if (body.cashBalanceDisabled !== undefined)         patch.cash_balance_disabled          = body.cashBalanceDisabled;
  if (body.maxBookingDurationMinutes !== undefined)   patch.max_booking_duration_minutes   = body.maxBookingDurationMinutes;
  if (body.publicMeetupRequired !== undefined)        patch.public_meetup_required         = body.publicMeetupRequired;
  if (body.fullInAppPaymentRequired !== undefined)    patch.full_in_app_payment_required   = body.fullInAppPaymentRequired;
  if (body.reason !== undefined)                      patch.reason                         = body.reason;

  await sc.from("rent_buddy_user_limits").update(patch).eq("user_id", userId);

  await sc.from("rent_buddy_admin_actions").insert({
    admin_id: adminId,
    target_type: "user",
    target_id: userId,
    action: "limits_updated",
    notes: body.reason ?? null,
  });

  return res.json({ ok: true });
});

export default router;
