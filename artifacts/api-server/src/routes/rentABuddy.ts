/**
 * Rent a Buddy — full implementation
 *
 * All non-admin routes are gated by requireRentBuddyEnabled (feature flag).
 * Admin routes intentionally bypass the flag so admins can manage the feature
 * even while it is disabled (e.g. review applications, handle flags).
 *
 * IDENTITY CONTRACT
 * ─────────────────
 * rent_buddy_profiles.id       → "buddyProfileId"  (used as buddy_id in bookings)
 * rent_buddy_profiles.user_id  → "buddyUserId"     (= profiles.id, used in FKs to profiles)
 * rent_buddy_bookings.traveler_id                  (= profiles.id, user ID)
 *
 * When writing to tables with FK → profiles(id), always use the *user_id*, never
 * the buddy profile id.
 */

import { Router } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { recordTrustEvent } from "../services/trust/TrustEventService.js";
import { recordActivityEvent } from "../compass/CompassActiveUserRewardEngine.js";
import { endFairExposure } from "../compass/CompassFairExposureEngine.js";
import { invalidate as invalidateCompassCache } from "../compass/CompassCacheEngine.js";

const router = Router();


// ── Policy language ────────────────────────────────────────────────────────────

export const POLICY_TEXT =
  "Rent a Buddy is for travel companionship, city guidance, language support, local help, social exploration, shopping, nightlife guidance, content help, and arrival support only. It is not a dating, escort, adult, romantic, sexual, or illegal-service feature. Requests or offers that violate this policy may lead to account review, suspension, removal, and Trust Score penalties.";

// ── Private meetup location blocklist ─────────────────────────────────────────

const PRIVATE_LOCATION_PATTERNS = [
  /private\s+hotel\s+room/i,
  /come\s+to\s+my\s+room/i,
  /\bmy\s+room\b/i,
  /hotel\s+room/i,
  /\bmy\s+place\b/i,
  /my\s+apartment/i,
  /my\s+airbnb/i,
  /\bmy\s+home\b/i,
  /private\s+home/i,
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
    patterns: [/\bescort\b/i, /girlfriend\s+experience/i, /boyfriend\s+experience/i, /\bgfe\b/i, /\bbfe\b/i],
    category: "adult_service",
    severity: "critical",
  },
  {
    patterns: [/\badult\s+service/i, /\bsexual\s+service/i, /\bsex\s+work\b/i, /\bsex\b.*\bfor\s+hire\b/i],
    category: "adult_service",
    severity: "critical",
  },
  {
    patterns: [/\bprostitut/i, /\bcall\s+girl\b/i, /\bcall\s+boy\b/i, /\bsugarbaby\b/i, /\bsugar\s+baby\b/i],
    category: "adult_service",
    severity: "critical",
  },
  {
    patterns: [/\bmassage\s+with\s+(happy|happy[-\s]ending|extra|sexual)/i, /\bhappy\s+ending\b/i],
    category: "adult_massage",
    severity: "critical",
  },
  {
    patterns: [/\bmassage\b/i, /\bbody\s+rub\b/i],
    category: "massage_service",
    severity: "medium",
  },
  {
    patterns: [/\bhookup\b/i, /\bdate\s+me\b/i, /\bromantic\s+service/i, /\bromantic\s+companion/i, /\bintimate\s+time\b/i],
    category: "romantic_service",
    severity: "high",
  },
  {
    patterns: [/\bsex\b/i, /\bsexy\b/i],
    category: "explicit",
    severity: "high",
  },
  {
    patterns: [/\boff[-\s]?app\b/i, /\bpay\s+outside\b/i, /\bcash\s+only\b.*\boutside\b/i, /\bvenmo\s+me\b/i, /\bpaypal\s+me\b/i, /\bbank\s+transfer\s+only\b/i, /\bno\s+app\s+payment\b/i],
    category: "off_app_payment",
    severity: "high",
  },
  {
    patterns: [/\bdrugs?\b(?!\s+store)/i, /\bweed\b/i, /\bcocaine\b/i, /\bheroin\b/i, /\bmeth\b/i, /\bmdma\b/i, /\becstasy\b/i, /\bketamine\b/i, /\bsupply\s+drugs?\b/i],
    category: "drugs",
    severity: "high",
  },
  {
    patterns: [/\bweapon\b/i, /\bknife\b/i, /\bgun\b/i, /\bfirearm\b/i],
    category: "weapons",
    severity: "critical",
  },
  {
    patterns: [/\balone\s+in\s+my\s+room\b/i, /\bno\s+one\s+will\s+know\b/i, /\bkeep\s+this\s+between\s+us\b/i, /\bdon.t\s+tell\s+anyone\b/i],
    category: "grooming_language",
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
  const seen = new Set<string>();
  for (const rule of POLICY_RULES) {
    if (seen.has(rule.category)) continue;
    for (const pattern of rule.patterns) {
      const m = text.match(pattern);
      if (m) {
        matches.push({
          category: rule.category,
          severity: rule.severity,
          excerpt: text.substring(Math.max(0, (m.index ?? 0) - 20), (m.index ?? 0) + m[0].length + 20),
        });
        seen.add(rule.category);
        break;
      }
    }
  }
  return matches;
}

function worstSeverity(matches: PolicyMatch[]): PolicyMatch | null {
  if (matches.length === 0) return null;
  const order: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };
  return matches.reduce((a, b) => order[a.severity] >= order[b.severity] ? a : b);
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

  const worst = worstSeverity(matches)!;

  await sc.from("rent_buddy_policy_flags").insert({
    booking_id: bookingId ?? null,
    reporter_user_id: reporterUserId ?? null,
    flagged_user_id: flaggedUserId ?? null,
    source_type: sourceType,
    source_id: sourceId ?? null,
    category: worst.category,
    severity: worst.severity,
    matched_text_excerpt: worst.excerpt,
    status: "open",
  });

  return matches;
}

/**
 * Apply policy severity ONLY for automated scanner context (pre-submission
 * gating). Trust Score penalties are applied when admin CONFIRMS a flag,
 * not when the scanner runs.
 */
async function applyPolicySeverity(opts: {
  sc: any;
  userId: string;
  matches: PolicyMatch[];
}): Promise<void> {
  if (opts.matches.length === 0) return;
  const { sc, userId, matches } = opts;

  const worst = worstSeverity(matches)!;

  if (worst.severity === "critical") {
    // Disable profile immediately for critical — high-risk content
    await sc
      .from("rent_buddy_profiles")
      .update({ admin_status: "disabled", risk_hold: true })
      .eq("user_id", userId);
  } else if (worst.severity === "high") {
    // Apply access limits; Trust Score penalty deferred to admin confirmation
    await sc
      .from("rent_buddy_user_limits")
      .upsert(
        {
          user_id: userId,
          nightlife_disabled: true,
          public_meetup_required: true,
          full_in_app_payment_required: true,
          reason: `Auto-restricted: policy flag (${worst.category})`,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
  }
  // medium and low: flag created, no immediate action — admin reviews
}

// ── Feature flag guard ─────────────────────────────────────────────────────────

async function checkRentBuddyEnabled(sc: any): Promise<boolean> {
  const { data } = await sc
    .from("feature_flags")
    .select("enabled")
    .eq("flag", "rent_buddy_enabled")
    .maybeSingle();
  return !!data && !!(data as any).enabled;
}

async function requireRentBuddyEnabled(sc: any, res: any): Promise<boolean> {
  const enabled = await checkRentBuddyEnabled(sc);
  if (!enabled) {
    res.status(403).json({ error: "feature_disabled", message: "Rent a Buddy is not available yet." });
    return false;
  }
  return true;
}

// ── Get service client (with fallback) ────────────────────────────────────────

function sc(fallback?: any) {
  return getServiceClient() ?? fallback;
}

// ── User limits helper ─────────────────────────────────────────────────────────

async function getUserLimits(client: any, userId: string): Promise<any | null> {
  const { data } = await client
    .from("rent_buddy_user_limits")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return data ?? null;
}

// ── Booking-party auth check ──────────────────────────────────────────────────

/**
 * Returns { isTraveler, isBuddy, buddyUserId } or null if the caller has no
 * relationship to this booking. Sends 403 if not a party.
 */
async function requireBookingParty(
  client: any,
  booking: any,
  callerUserId: string,
  res: any,
): Promise<{ isTraveler: boolean; isBuddy: boolean; buddyUserId: string } | null> {
  const isTraveler = booking.traveler_id === callerUserId;
  const { data: bp } = await client
    .from("rent_buddy_profiles")
    .select("id, user_id")
    .eq("id", booking.buddy_id)
    .maybeSingle();

  const buddyUserId: string = bp ? (bp as any).user_id : "";
  const isBuddy = !!bp && buddyUserId === callerUserId;

  if (!isTraveler && !isBuddy) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return { isTraveler, isBuddy, buddyUserId };
}

// ── Admin guard ────────────────────────────────────────────────────────────────

async function requireAdmin(
  req: any,
  res: any,
): Promise<{ userId: string; client: any; sc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;
  const serviceClient = getServiceClient() ?? client;

  const { data } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (!data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }
  return { userId: user.id, client, sc: serviceClient };
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

// ── Booking system message helper ─────────────────────────────────────────────
// Fire-and-forget: inserts a system message into the booking's Telegraph thread.
// Called after key booking state transitions. Silent no-op if no thread exists.

async function emitBookingMilestone(
  client: any,
  bookingId: string,
  actorId: string,
  subtype: string,
  body: string,
): Promise<void> {
  try {
    const { data: bk } = await client
      .from("rent_buddy_bookings")
      .select("telegraph_thread_id")
      .eq("id", bookingId)
      .maybeSingle();
    const threadId: string | null = (bk as any)?.telegraph_thread_id ?? null;
    if (!threadId) return;
    await client.from("messages").insert({
      thread_id: threadId,
      sender_id: actorId,
      body,
      msg_type: "system",
      subtype,
    });
  } catch { /* non-critical — never fail the main request */ }
}

// ── Search ────────────────────────────────────────────────────────────────────

router.post("/api/rent-a-buddy/search", async (req, res) => {
  const serviceClient = sc();
  if (!serviceClient) return res.json({ buddies: [], total: 0, page: 1, perPage: 20 });
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const {
    city, category, language, maxBudgetUsd, buddyLevel,
    nightlifeAvailable, publicMeetupOnly, page = 1, perPage = 20,
  } = req.body ?? {};

  let query = serviceClient
    .from("rent_buddy_profiles")
    .select("*", { count: "exact" })
    .eq("status", "active")
    .eq("admin_status", "active")
    .order("review_count", { ascending: false })
    .range((page - 1) * perPage, page * perPage - 1);

  if (city)          query = query.ilike("city", `%${city}%`);
  if (category)      query = query.contains("categories", [category]);
  if (language)      query = query.contains("languages", [language]);
  if (maxBudgetUsd)  query = query.lte("hourly_rate_usd", maxBudgetUsd);
  if (buddyLevel)    query = query.eq("buddy_level", buddyLevel);
  if (nightlifeAvailable) query = query.contains("categories", ["nightlife"]);
  if (publicMeetupOnly)   query = query.eq("new_buddy_public_only", true);

  const { data, count, error } = await query;
  if (error) return sendError(res, "db_error", error.message);

  return res.json({ buddies: (data ?? []).map(mapProfile), total: count ?? 0, page, perPage });
});

// ── Buddy profile ─────────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/buddies/:buddyId", async (req, res) => {
  const serviceClient = sc();
  if (!serviceClient) return res.json({ buddy: null, packages: [], addons: [], reviews: [], availability: [], savedByMe: false });
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const auth = await requireUser(req, res);
  const userId = auth?.user.id ?? null;
  const { buddyId } = req.params;

  const [profileRes, packagesRes, addonsRes, availRes] = await Promise.all([
    serviceClient.from("rent_buddy_profiles").select("*").eq("id", buddyId).maybeSingle(),
    serviceClient.from("rent_buddy_packages").select("*").eq("buddy_id", buddyId).eq("is_active", true),
    serviceClient.from("rent_buddy_addons").select("*").eq("buddy_id", buddyId).eq("is_active", true),
    serviceClient.from("rent_buddy_availability")
      .select("*")
      .eq("buddy_id", buddyId)
      .gte("date", new Date().toISOString().slice(0, 10))
      .limit(30),
  ]);

  // reviewee_id references profiles.id (user_id), not rent_buddy_profiles.id
  const buddyUserIdForReviews: string = profileRes.data ? (profileRes.data as any).user_id : "";
  const reviewsRes = buddyUserIdForReviews
    ? await serviceClient
        .from("rent_buddy_reviews")
        .select("*")
        .eq("reviewee_id", buddyUserIdForReviews)
        .eq("is_public", true)
        .order("created_at", { ascending: false })
        .limit(5)
    : { data: [] };

  let savedByMe = false;
  if (userId && profileRes.data) {
    const { data: savedRow } = await serviceClient
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
      maxGroup: p.max_group, isActive: p.is_active,
    })),
    addons: (addonsRes.data ?? []).map((a: any) => ({
      id: a.id, buddyId: a.buddy_id, title: a.title, description: a.description,
      priceUsd: Number(a.price_usd), isActive: a.is_active,
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
  const serviceClient = sc();
  if (!serviceClient) return res.json({ availability: [] });
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { buddyId } = req.params;
  const month = (req.query.month as string) ?? "";
  let query = serviceClient.from("rent_buddy_availability").select("*").eq("buddy_id", buddyId);
  if (month) query = query.like("date", `${month}%`);

  const { data } = await query.order("date");
  return res.json({
    availability: (data ?? []).map((av: any) => ({
      id: av.id, date: av.date, timeSlots: av.time_slots ?? [], isAvailable: av.is_available,
    })),
  });
});

router.get("/api/rent-a-buddy/buddies/:buddyId/reviews", async (req, res) => {
  const serviceClient = sc();
  if (!serviceClient) return res.json({ reviews: [], total: 0 });
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { buddyId } = req.params;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 10;

  // reviewee_id references profiles.id (user_id), not rent_buddy_profiles.id
  const { data: bpRow } = await serviceClient
    .from("rent_buddy_profiles")
    .select("user_id")
    .eq("id", buddyId)
    .maybeSingle();

  if (!bpRow) return res.json({ reviews: [], total: 0 });

  const buddyUserId: string = (bpRow as any).user_id;

  const { data, count } = await serviceClient
    .from("rent_buddy_reviews")
    .select("*", { count: "exact" })
    .eq("reviewee_id", buddyUserId)
    .eq("is_public", true)
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  return res.json({ reviews: data ?? [], total: count ?? 0 });
});

// ── Bookings — Create ──────────────────────────────────────────────────────────

router.post("/api/rent-a-buddy/bookings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const serviceClient = sc(auth.client);

  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const limits = await getUserLimits(serviceClient, user.id);
  if (limits?.rent_buddy_disabled || limits?.traveler_booking_disabled) {
    return res.status(403).json({
      error: "access_limited",
      message: "Rent a Buddy access is limited while your account is under review.",
    });
  }

  const {
    buddyId, packageId, tripId, bookingDate, startTime,
    durationH, groupSize = 1, city, category, notes,
    paymentMode = "full_in_app",
  } = req.body ?? {};

  if (!buddyId || !bookingDate || !durationH || !city || !category) {
    return res.status(400).json({ error: "invalid_payload", message: "buddyId, bookingDate, durationH, city, category are required." });
  }

  if (limits?.cash_balance_disabled && paymentMode === "deposit_plus_cash") {
    return res.status(403).json({ error: "access_limited", message: "Cash balance is unavailable. Full in-app payment is required." });
  }

  if (limits?.full_in_app_payment_required && paymentMode !== "full_in_app") {
    return res.status(403).json({ error: "access_limited", message: "Full in-app payment is required for your account." });
  }

  if (limits?.nightlife_disabled && category === "nightlife") {
    return res.status(403).json({ error: "access_limited", message: "Nightlife bookings are not available for your account." });
  }

  const maxDurMin = limits?.max_booking_duration_minutes;
  if (maxDurMin && durationH * 60 > maxDurMin) {
    return res.status(403).json({ error: "access_limited", message: `Max booking duration for your account is ${maxDurMin} minutes.` });
  }

  const { data: buddyProfile } = await serviceClient
    .from("rent_buddy_profiles")
    .select("*")
    .eq("id", buddyId)
    .maybeSingle();

  if (!buddyProfile) return res.status(404).json({ error: "not_found", message: "Buddy not found." });

  if (buddyProfile.status !== "active" || buddyProfile.admin_status !== "active") {
    return res.status(400).json({ error: "buddy_unavailable", message: "This Buddy is not accepting bookings." });
  }

  // New Buddy restrictions
  if (buddyProfile.new_buddy_public_only) {
    if (isPrivateLocation(city)) {
      return res.status(400).json({
        error: "invalid_location",
        message: "First meetup must be at a public location (hotel lobby, airport, coffee shop, landmark, etc.). Private rooms and private homes are not allowed.",
      });
    }

    const approvals: Record<string, boolean> = buddyProfile.category_approvals ?? {};
    if ((category === "nightlife" || category === "group") && !approvals[category]) {
      return res.status(403).json({ error: "category_not_approved", message: `This Buddy is not approved for ${category} bookings yet.` });
    }

    if (durationH > buddyProfile.new_buddy_max_hours) {
      return res.status(400).json({ error: "duration_exceeded", message: `New Buddies can accept a maximum of ${buddyProfile.new_buddy_max_hours} hours per booking.` });
    }
  }

  // Policy scan on traveler notes
  if (notes) {
    const matches = await scanForPolicyViolations({
      sc: serviceClient, text: notes, sourceType: "booking_note", flaggedUserId: user.id,
    });
    await applyPolicySeverity({ sc: serviceClient, userId: user.id, matches });
    const isBlockable = matches.some((m) => m.severity === "critical" || m.severity === "high");
    if (isBlockable) {
      return res.status(400).json({
        error: "policy_violation",
        message: "Your booking note contains content that violates Rent a Buddy policy. Please review our policy and try again.",
      });
    }
  }

  const rateUsd = buddyProfile.hourly_rate_usd ? Number(buddyProfile.hourly_rate_usd) : 0;
  const totalUsd = Math.round(rateUsd * durationH * 100) / 100;
  const depositUsd = paymentMode === "deposit_plus_cash" ? Math.round(totalUsd * 0.3 * 100) / 100 : totalUsd;
  const cashBalanceUsd = paymentMode === "deposit_plus_cash" ? Math.round((totalUsd - depositUsd) * 100) / 100 : 0;

  const { data: booking, error } = await serviceClient
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
      safety_status: "normal",
      route_plan: [],
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
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data } = await serviceClient
    .from("rent_buddy_bookings")
    .select("*")
    .eq("traveler_id", auth.user.id)
    .order("created_at", { ascending: false });

  return res.json({ bookings: (data ?? []).map(mapBooking) });
});

router.get("/api/rent-a-buddy/bookings/:bookingId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { data } = await serviceClient
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();

  if (!data) return res.status(404).json({ error: "not_found" });

  const party = await requireBookingParty(serviceClient, data, auth.user.id, res);
  if (!party) return;

  return res.json({ booking: mapBooking(data), policyText: POLICY_TEXT });
});

// ── Bookings — Payment ────────────────────────────────────────────────────────

router.post("/api/rent-a-buddy/bookings/:bookingId/pay-deposit", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .eq("traveler_id", auth.user.id)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  const b = booking as any;
  if (b.payment_mode !== "deposit_plus_cash") {
    return res.status(400).json({ error: "invalid_payload", message: "This booking uses full in-app payment. Use /pay-full." });
  }
  if (!["pending", "confirmed"].includes(b.status)) {
    return res.status(400).json({ error: "invalid_payload", message: "Deposit can only be paid for pending or confirmed bookings." });
  }

  // Record deposit intent — real Stripe integration wires here
  void emitBookingMilestone(serviceClient, bookingId, auth.user.id, "rent_buddy_deposit_paid", "Deposit paid — your booking is secured.");
  return res.json({
    ok: true,
    depositUsd: Number(b.deposit_usd),
    cashBalanceUsd: Number(b.cash_balance_usd),
    paymentIntent: { status: "requires_payment_method", bookingId },
    message: "Deposit recorded. Complete payment via the Stripe payment sheet.",
  });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/pay-full", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .eq("traveler_id", auth.user.id)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  const b = booking as any;
  if (b.payment_mode !== "full_in_app") {
    return res.status(400).json({ error: "invalid_payload", message: "This booking uses deposit+cash. Use /pay-deposit." });
  }
  if (!["pending", "confirmed"].includes(b.status)) {
    return res.status(400).json({ error: "invalid_payload", message: "Full payment can only be made for pending or confirmed bookings." });
  }

  void emitBookingMilestone(serviceClient, bookingId, auth.user.id, "rent_buddy_deposit_paid", "Payment confirmed — your booking is fully secured.");
  return res.json({
    ok: true,
    totalUsd: Number(b.total_usd),
    paymentIntent: { status: "requires_payment_method", bookingId },
    message: "Payment recorded. Complete payment via the Stripe payment sheet.",
  });
});

// ── Bookings — Cancel ─────────────────────────────────────────────────────────

router.post("/api/rent-a-buddy/bookings/:bookingId/cancel", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  const b = booking as any;
  if (b.traveler_id !== auth.user.id) return res.status(403).json({ error: "forbidden" });

  const now = new Date();
  const bookingDt = new Date(`${b.booking_date}T${b.start_time ?? "12:00"}Z`);
  const hoursUntil = (bookingDt.getTime() - now.getTime()) / 3600000;
  const eventType = hoursUntil < 2 ? "rent_buddy_late_cancel" : "rent_buddy_abandoned_booking";

  await serviceClient
    .from("rent_buddy_bookings")
    .update({ status: "cancelled", cancelled_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("id", bookingId);

  void recordTrustEvent(serviceClient, {
    userId: auth.user.id,
    eventType,
    category: "communication",
    delta: hoursUntil < 2 ? -5 : -2,
    severity: "minor",
    sourceType: "booking",
    sourceId: bookingId,
  });

  void emitBookingMilestone(serviceClient, bookingId, auth.user.id, "rent_buddy_cancelled", "Booking cancelled.");

  // Invalidate compass cache: active_booking state changed for traveler
  void invalidateCompassCache(getServiceClient(), auth.user.id, "booking_cancel");

  return res.json({ ok: true });
});

// ── Bookings — Buddy lifecycle (accept / decline / start / complete) ───────────

router.post("/api/rent-a-buddy/bookings/:bookingId/accept", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id, status, admin_status")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (!bp || (bp as any).status !== "active" || (bp as any).admin_status !== "active") {
    return res.status(403).json({ error: "forbidden", message: "Your Buddy profile is not active." });
  }

  const limits = await getUserLimits(serviceClient, auth.user.id);
  if (limits?.rent_buddy_disabled || limits?.buddy_disabled) {
    return res.status(403).json({ error: "access_limited", message: "Rent a Buddy access is limited while your account is under review." });
  }

  const { bookingId } = req.params;
  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .eq("buddy_id", (bp as any).id)
    .eq("status", "pending")
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  const now = new Date().toISOString();
  await serviceClient
    .from("rent_buddy_bookings")
    .update({ status: "confirmed", confirmed_at: now, updated_at: now })
    .eq("id", bookingId);

  // Positive trust event: buddy accepted and committed to the booking
  void recordTrustEvent(serviceClient, {
    userId: auth.user.id,
    eventType: "rent_buddy_booking_accepted",
    category: "community_value",
    delta: 3,
    severity: "minor",
    sourceType: "booking",
    sourceId: bookingId,
  });

  // Ensure a booking thread exists before emitting the confirmation milestone
  if (!(booking as any).telegraph_thread_id) {
    const otherUserId = (booking as any).traveler_id;
    const buddyUserId = auth.user.id;
    const { data: newThread } = await serviceClient
      .from("message_threads")
      .insert({ thread_type: "rent_buddy_booking", created_by: buddyUserId, title: null })
      .select("id")
      .single();
    if (newThread) {
      const tid: string = (newThread as any).id;
      await serviceClient.from("message_thread_members").insert([
        { thread_id: tid, user_id: buddyUserId },
        { thread_id: tid, user_id: otherUserId },
      ]);
      await serviceClient.from("rent_buddy_bookings").update({ telegraph_thread_id: tid }).eq("id", bookingId);
    }
  }

  void emitBookingMilestone(serviceClient, bookingId, auth.user.id, "rent_buddy_accepted", "Buddy accepted — your booking is confirmed!");
  void emitBookingMilestone(serviceClient, bookingId, auth.user.id, "rent_buddy_confirmed", "Booking confirmed — your Buddy accepted the request.");

  // Invalidate compass cache: active_booking state changed for both buddy and traveler
  const sc_ = getServiceClient();
  void invalidateCompassCache(sc_, auth.user.id, "booking_accept");
  void invalidateCompassCache(sc_, (booking as any).traveler_id as string, "booking_accept");

  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/decline", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (!bp) return res.status(403).json({ error: "forbidden" });

  const now = new Date().toISOString();
  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("id")
    .eq("id", req.params.bookingId)
    .eq("buddy_id", (bp as any).id)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  await serviceClient
    .from("rent_buddy_bookings")
    .update({ status: "cancelled", cancelled_at: now, updated_at: now })
    .eq("id", req.params.bookingId);

  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/start", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .eq("traveler_id", auth.user.id)
    .eq("status", "confirmed")
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  const now = new Date().toISOString();
  await serviceClient
    .from("rent_buddy_bookings")
    .update({ status: "in_progress", started_at: now, updated_at: now })
    .eq("id", bookingId);

  await serviceClient.from("rent_buddy_emergency_contacts_snapshot").insert({
    booking_id: bookingId,
    user_id: auth.user.id,
    trusted_circle_shared: req.body?.trustedCircleShared ?? false,
    safe_return_enabled: req.body?.safeReturnEnabled ?? false,
    emergency_contact_count: req.body?.emergencyContactCount ?? 0,
  });

  void emitBookingMilestone(serviceClient, bookingId, auth.user.id, "rent_buddy_started", "Meetup started — enjoy your time together!");

  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/complete", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .eq("traveler_id", auth.user.id)
    .eq("status", "in_progress")
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  const now = new Date().toISOString();
  await serviceClient
    .from("rent_buddy_bookings")
    .update({ status: "completed", completed_at: now, updated_at: now })
    .eq("id", bookingId);

  // Fetch current count from profile (not from booking row)
  const { data: profRow } = await serviceClient
    .from("rent_buddy_profiles")
    .select("completed_bookings, user_id")
    .eq("id", (booking as any).buddy_id)
    .maybeSingle();

  const currentCount = (profRow as any)?.completed_bookings ?? 0;
  const buddyUserId: string = (profRow as any)?.user_id ?? "";

  await serviceClient
    .from("rent_buddy_profiles")
    .update({ completed_bookings: currentCount + 1, updated_at: now })
    .eq("id", (booking as any).buddy_id);

  void recordTrustEvent(serviceClient, {
    userId: auth.user.id,
    eventType: "rent_buddy_completed",
    category: "community_value",
    delta: 5,
    severity: "minor",
    sourceType: "booking",
    sourceId: bookingId,
  });

  if (buddyUserId) {
    void recordTrustEvent(serviceClient, {
      userId: buddyUserId,
      eventType: "rent_buddy_completed",
      category: "community_value",
      delta: 5,
      severity: "minor",
      sourceType: "booking",
      sourceId: bookingId,
    });
  }

  void emitBookingMilestone(serviceClient, bookingId, auth.user.id, "rent_buddy_completed", "Booking completed — hope you had a great time!");

  // Compass activity ingestion — both traveler and buddy get credit
  recordActivityEvent(serviceClient, auth.user.id, "booking_completed", { category: "buddy_session" });
  if (buddyUserId) {
    recordActivityEvent(serviceClient, buddyUserId, "buddy_session_completed", { category: "buddy_session" });
  }

  // Archive the booking thread unless BOTH parties opted to stay connected.
  // Either party may call POST /api/rent-a-buddy/bookings/:bookingId/stay-connected before or after
  // completion to record their preference. We check both here.
  // Read durable stay-connected opt-ins from DB (not in-memory — survives restarts).
  const bothStayConnected = !!((booking as any).stay_connected_traveler && (booking as any).stay_connected_buddy);

  if (!bothStayConnected) {
    const telegraphThreadId2: string | null = (booking as any).telegraph_thread_id ?? null;
    if (telegraphThreadId2) {
      const archiveNow = new Date().toISOString();
      await serviceClient
        .from("message_thread_members")
        .update({ archived_at: archiveNow })
        .eq("thread_id", telegraphThreadId2)
        .is("archived_at", null);
    }
  }
  return res.json({ ok: true });
});

// ── Bookings — Telegraph thread ───────────────────────────────────────────────
// POST /api/rent-a-buddy/bookings/:bookingId/thread
// Gets or creates the Telegraph thread for a rent-a-buddy booking.
// Both the traveler and the buddy can call this to get the thread ID.

// POST /api/rent-a-buddy/bookings/:bookingId/add-time
// Traveler or buddy adds extra hours to an in-progress or confirmed booking and
// emits a rent_buddy_extra_time system milestone on the thread.
router.post("/api/rent-a-buddy/bookings/:bookingId/add-time", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { hours } = req.body ?? {};
  if (!hours || typeof hours !== "number" || hours <= 0) {
    return res.status(400).json({ error: "invalid_payload", message: "hours must be a positive number." });
  }

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("id, traveler_id, buddy_id, duration_h, status")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const { data: bProf } = await serviceClient
    .from("rent_buddy_profiles")
    .select("user_id")
    .eq("id", (booking as any).buddy_id)
    .maybeSingle();
  const buddyUserId: string = (bProf as any)?.user_id ?? "";
  const isTraveler = (booking as any).traveler_id === auth.user.id;
  const isBuddy = buddyUserId === auth.user.id;
  if (!isTraveler && !isBuddy) return res.status(403).json({ error: "forbidden" });

  // Add-time is only valid while the booking is active; reject all other states.
  const addTimeAllowedStatuses = ["confirmed", "in_progress"];
  if (!addTimeAllowedStatuses.includes((booking as any).status)) {
    return res.status(409).json({
      error: "invalid_booking_status",
      message: "Extra time can only be added to confirmed or in-progress bookings.",
    });
  }

  const newDurationH = Number((booking as any).duration_h) + hours;
  await serviceClient
    .from("rent_buddy_bookings")
    .update({ duration_h: newDurationH, updated_at: new Date().toISOString() })
    .eq("id", bookingId);

  await emitBookingMilestone(
    serviceClient,
    bookingId,
    auth.user.id,
    "rent_buddy_extra_time",
    `${hours} extra hour${hours !== 1 ? 's' : ''} added — new total: ${newDurationH}h`,
  );

  return res.json({ ok: true, newDurationH });
});

// POST /api/rent-a-buddy/bookings/:bookingId/stay-connected
// Either party (traveler or buddy) calls this to opt into keeping the thread open after completion.
// Both parties must call before completion fires for the thread to remain open.
router.post("/api/rent-a-buddy/bookings/:bookingId/stay-connected", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("id, traveler_id, buddy_id, status")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  // Resolve buddy user_id
  const { data: bProf } = await serviceClient
    .from("rent_buddy_profiles")
    .select("user_id")
    .eq("id", (booking as any).buddy_id)
    .maybeSingle();
  const buddyUserId: string = (bProf as any)?.user_id ?? "";
  const isTraveler = (booking as any).traveler_id === auth.user.id;
  const isBuddy = buddyUserId === auth.user.id;
  if (!isTraveler && !isBuddy) return res.status(403).json({ error: "forbidden" });

  // Persist opt-in to DB so it survives server restarts and works across instances.
  const column = isTraveler ? "stay_connected_traveler" : "stay_connected_buddy";
  await serviceClient
    .from("rent_buddy_bookings")
    .update({ [column]: true, updated_at: new Date().toISOString() })
    .eq("id", bookingId);

  return res.json({ ok: true, optedIn: true });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/thread", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;

  // Fetch the booking — user must be the traveler or the buddy's user
  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("id, traveler_id, buddy_id, telegraph_thread_id, status")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  // Resolve the buddy's user_id so either party can access
  const { data: buddyProfile } = await serviceClient
    .from("rent_buddy_profiles")
    .select("user_id")
    .eq("id", (booking as any).buddy_id)
    .maybeSingle();

  const buddyUserId: string = (buddyProfile as any)?.user_id ?? "";
  const isTraveler = (booking as any).traveler_id === auth.user.id;
  const isBuddy = buddyUserId === auth.user.id;

  if (!isTraveler && !isBuddy) {
    return res.status(403).json({ error: "forbidden" });
  }

  // Enforce lifecycle: thread may only be created once the booking is confirmed or later.
  // Pending and cancelled bookings have no chat thread yet.
  const threadAllowedStatuses = ["confirmed", "in_progress", "completed", "disputed"];
  if (!threadAllowedStatuses.includes((booking as any).status)) {
    return res.status(409).json({
      error: "thread_not_available",
      message: "The chat thread opens once the Buddy confirms the booking.",
    });
  }

  // If a thread already exists, return it
  if ((booking as any).telegraph_thread_id) {
    return res.json({
      threadId: (booking as any).telegraph_thread_id,
      bookingId,
      isNew: false,
    });
  }

  // Create a new direct thread between traveler and buddy
  // First look up or create a thread_members row
  const otherUserId = isTraveler ? buddyUserId : (booking as any).traveler_id;

  // Create a message_threads row with thread_type='rent_buddy_booking' so inbox can detect and route correctly
  const { data: thread, error: threadErr } = await serviceClient
    .from("message_threads")
    .insert({
      thread_type: "rent_buddy_booking",
      created_by: auth.user.id,
      title: null,
    })
    .select("id")
    .single();

  if (threadErr || !thread) {
    req.log?.error({ err: threadErr }, "Failed to create booking thread");
    return res.status(500).json({ error: "thread_creation_failed" });
  }

  const threadId: string = (thread as any).id;

  // Add both members
  await serviceClient.from("message_thread_members").insert([
    { thread_id: threadId, user_id: auth.user.id },
    { thread_id: threadId, user_id: otherUserId },
  ]);

  // Store thread ID on booking
  await serviceClient
    .from("rent_buddy_bookings")
    .update({ telegraph_thread_id: threadId })
    .eq("id", bookingId);

  return res.json({ threadId, bookingId, isNew: true });
});

// ── Bookings — Cash balance confirmation ──────────────────────────────────────

router.post("/api/rent-a-buddy/bookings/:bookingId/confirm-cash", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { confirmed } = req.body ?? {};

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  const party = await requireBookingParty(serviceClient, booking, auth.user.id, res);
  if (!party) return;

  const { isTraveler, isBuddy } = party;
  const updatePatch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (isTraveler) updatePatch.cash_balance_confirmed_by_traveler = confirmed;
  if (isBuddy)    updatePatch.cash_balance_confirmed_by_buddy = confirmed;

  await serviceClient.from("rent_buddy_bookings").update(updatePatch).eq("id", bookingId);

  const b = booking as any;
  const tConf = isTraveler ? confirmed : b.cash_balance_confirmed_by_traveler;
  const bConf = isBuddy    ? confirmed : b.cash_balance_confirmed_by_buddy;

  if (tConf === false || bConf === false) {
    await serviceClient.from("rent_buddy_bookings")
      .update({ status: "disputed", updated_at: new Date().toISOString() })
      .eq("id", bookingId);

    await serviceClient.from("rent_buddy_disputes").insert({
      booking_id: bookingId,
      raised_by: auth.user.id,
      reason: "cash_balance_disagreement",
      status: "open",
    });
    return res.json({ ok: true, disputed: true });
  }

  if (tConf && bConf) {
    void recordTrustEvent(serviceClient, {
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

// ── Bookings — Route management ───────────────────────────────────────────────

router.post("/api/rent-a-buddy/bookings/:bookingId/route", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { stops } = req.body ?? {};
  if (!Array.isArray(stops)) return res.status(400).json({ error: "invalid_payload", message: "stops array required." });

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("buddy_id, traveler_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles").select("id, user_id").eq("id", (booking as any).buddy_id).maybeSingle();
  if (!bp || (bp as any).user_id !== auth.user.id) return res.status(403).json({ error: "forbidden" });

  await serviceClient.from("rent_buddy_route_stops").delete().eq("booking_id", bookingId);
  const inserts = stops.map((s: any, i: number) => ({
    booking_id: bookingId,
    stop_order: i + 1,
    name: s.name ?? `Stop ${i + 1}`,
    notes: s.notes ?? null,
    eta: s.eta ?? null,
    lat: s.lat ?? null,
    lng: s.lng ?? null,
  }));
  if (inserts.length > 0) await serviceClient.from("rent_buddy_route_stops").insert(inserts);
  await serviceClient.from("rent_buddy_bookings").update({ route_plan: stops, updated_at: new Date().toISOString() }).eq("id", bookingId);

  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/route-change", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { newStops, reason } = req.body ?? {};

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const party = await requireBookingParty(serviceClient, booking, auth.user.id, res);
  if (!party) return;

  // Scan new stops for policy violations
  const stopText = (newStops ?? []).map((s: any) => s.name ?? "").join(" ");
  if (stopText) {
    const matches = await scanForPolicyViolations({
      sc: serviceClient, text: stopText, sourceType: "route_change",
      bookingId, flaggedUserId: auth.user.id,
    });
    await applyPolicySeverity({ sc: serviceClient, userId: auth.user.id, matches });
  }

  // If buddy is unilaterally proposing a route change, log it as safety event
  if (party.isBuddy) {
    await serviceClient.from("rent_buddy_safety_events").insert({
      booking_id: bookingId,
      actor_user_id: auth.user.id,
      target_user_id: (booking as any).traveler_id,
      event_type: "route_change_unapproved",
      event_status: "open",
      metadata: { new_stops: newStops, reason },
    });
  }

  const { data: changeReq } = await serviceClient
    .from("rent_buddy_route_change_requests")
    .insert({
      booking_id: bookingId,
      requested_by: auth.user.id,
      old_stops_json: (booking as any).route_plan ?? [],
      new_stops_json: newStops ?? [],
      reason: reason ?? null,
    })
    .select()
    .maybeSingle();

  return res.status(201).json({ routeChangeRequest: changeReq });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/route-change/:changeId/approve", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId, changeId } = req.params;
  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("traveler_id, buddy_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  // Only the traveler can approve a buddy-proposed route change
  if ((booking as any).traveler_id !== auth.user.id) {
    return res.status(403).json({ error: "forbidden", message: "Only the traveler can approve route changes." });
  }

  const { data: changeReq } = await serviceClient
    .from("rent_buddy_route_change_requests")
    .select("*")
    .eq("id", changeId)
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (!changeReq) return res.status(404).json({ error: "not_found" });

  await serviceClient.from("rent_buddy_route_change_requests")
    .update({ traveler_response: "approved", responded_at: new Date().toISOString() })
    .eq("id", changeId);

  // Apply the new route plan to the booking
  const newStops = (changeReq as any).new_stops_json ?? [];
  await serviceClient.from("rent_buddy_bookings")
    .update({ route_plan: newStops, updated_at: new Date().toISOString() })
    .eq("id", bookingId);

  // Resolve any open safety event created for this unapproved change
  await serviceClient.from("rent_buddy_safety_events")
    .update({ event_status: "resolved" })
    .eq("booking_id", bookingId)
    .eq("event_type", "route_change_unapproved")
    .eq("event_status", "open");

  void emitBookingMilestone(serviceClient, bookingId, auth.user.id, "rent_buddy_route_approved", "Route change approved — your itinerary has been updated.");
  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/bookings/:bookingId/route-change/:changeId/decline", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId, changeId } = req.params;
  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("traveler_id, buddy_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  if ((booking as any).traveler_id !== auth.user.id) {
    return res.status(403).json({ error: "forbidden", message: "Only the traveler can decline route changes." });
  }

  const { data: changeReq } = await serviceClient
    .from("rent_buddy_route_change_requests")
    .select("requested_by")
    .eq("id", changeId)
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (!changeReq) return res.status(404).json({ error: "not_found" });

  await serviceClient.from("rent_buddy_route_change_requests")
    .update({ traveler_response: "declined", responded_at: new Date().toISOString() })
    .eq("id", changeId);

  // Trust penalty: buddy proposed an unauthorized route deviation, traveler declined
  const buddyWhoRequested: string = (changeReq as any).requested_by ?? "";
  if (buddyWhoRequested && buddyWhoRequested !== auth.user.id) {
    void recordTrustEvent(serviceClient, {
      userId: buddyWhoRequested,
      eventType: "rent_buddy_route_change_declined",
      category: "respect_safety",
      delta: -5,
      severity: "minor",
      sourceType: "booking",
      sourceId: bookingId,
    });
  }

  return res.json({ ok: true });
});

// ── Bookings — Reviews ────────────────────────────────────────────────────────

router.post("/api/rent-a-buddy/bookings/:bookingId/review", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { rating, body: reviewBody, safetyScore, communicationScore, punctualityScore, photos = [] } = req.body ?? {};
  if (!rating) return res.status(400).json({ error: "invalid_payload", message: "rating required." });

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const party = await requireBookingParty(serviceClient, booking, auth.user.id, res);
  if (!party) return;

  const b = booking as any;
  const { isTraveler, buddyUserId } = party;

  const role = isTraveler ? "traveler" : "buddy";
  // reviewee must be a profiles.id (user ID), NOT a rent_buddy_profiles.id
  const revieweeId: string = isTraveler ? buddyUserId : b.traveler_id;

  // Double-blind: blind until 7 days after booking date
  const blindUntil = new Date(b.booking_date);
  blindUntil.setDate(blindUntil.getDate() + 7);

  const { data: review, error } = await serviceClient
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

  // Compass activity ingestion — reviewer earns review_posted credit
  recordActivityEvent(serviceClient, auth.user.id, "review_posted", { category: "buddy_session" });

  // Unblind if both sides have submitted
  const { count } = await serviceClient
    .from("rent_buddy_reviews")
    .select("id", { count: "exact" })
    .eq("booking_id", bookingId);

  let unblinded = false;
  if ((count ?? 0) >= 2) {
    await serviceClient.from("rent_buddy_reviews")
      .update({ is_public: true, blind_until: new Date().toISOString() })
      .eq("booking_id", bookingId);
    unblinded = true;

    void recordTrustEvent(serviceClient, {
      userId: auth.user.id,
      eventType: "rent_buddy_positive_review",
      category: "community_value",
      delta: Number(rating) >= 4 ? 4 : 2,
      severity: "minor",
      sourceType: "review",
      sourceId: (review as any)?.id,
    });
  }

  void emitBookingMilestone(serviceClient, bookingId, auth.user.id, "rent_buddy_review_requested", "Review submitted — helping build trust in the community.");
  return res.status(201).json({ review, unblinded });
});

// ── Bookings — Report (no immediate trust penalty; admin reviews) ─────────────

router.post("/api/rent-a-buddy/bookings/:bookingId/report", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { reason = "other", details } = req.body ?? {};

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("traveler_id, buddy_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const party = await requireBookingParty(serviceClient, booking, auth.user.id, res);
  if (!party) return;

  await serviceClient.from("rent_buddy_disputes").insert({
    booking_id: bookingId,
    raised_by: auth.user.id,
    reason,
    status: "open",
  });

  if (details) {
    await scanForPolicyViolations({
      sc: serviceClient,
      text: details,
      sourceType: "report",
      bookingId,
      reporterUserId: auth.user.id,
      // The reported party is whoever is NOT the reporter
      flaggedUserId: party.isTraveler ? party.buddyUserId : (booking as any).traveler_id,
    });
  }

  // Trust Score penalty deferred until admin confirms the report —
  // do NOT emit here to avoid false penalties.

  return res.status(201).json({ ok: true });
});

// ── Safety routes ─────────────────────────────────────────────────────────────

router.post("/api/rent-a-buddy/bookings/:bookingId/safety/checkin", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { checkinType, response: checkinResponse } = req.body ?? {};
  if (!checkinType) return res.status(400).json({ error: "invalid_payload", message: "checkinType required." });

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("traveler_id, buddy_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const party = await requireBookingParty(serviceClient, booking, auth.user.id, res);
  if (!party) return;

  await serviceClient.from("rent_buddy_safety_checkins").insert({
    booking_id: bookingId,
    user_id: auth.user.id,
    checkin_type: checkinType,
    response: checkinResponse ?? null,
  });

  const distressResponses = ["uncomfortable", "end_early", "contact_support", "start_safe_return"];
  if (distressResponses.includes(checkinResponse ?? "") || distressResponses.includes(checkinType)) {
    await serviceClient.from("rent_buddy_safety_events").insert({
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
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("traveler_id, buddy_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const party = await requireBookingParty(serviceClient, booking, auth.user.id, res);
  if (!party) return;

  await serviceClient
    .from("rent_buddy_bookings")
    .update({ safety_status: "uncomfortable", updated_at: new Date().toISOString() })
    .eq("id", bookingId);

  await serviceClient.from("rent_buddy_safety_events").insert({
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
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("traveler_id, buddy_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const party = await requireBookingParty(serviceClient, booking, auth.user.id, res);
  if (!party) return;

  const now = new Date().toISOString();
  await serviceClient
    .from("rent_buddy_bookings")
    .update({ status: "completed", completed_at: now, safety_status: "emergency", updated_at: now })
    .eq("id", bookingId);

  await serviceClient.from("rent_buddy_safety_events").insert({
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
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("traveler_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  // Emergency phrase is traveler-ONLY — buddy cannot trigger it
  if ((booking as any).traveler_id !== auth.user.id) {
    return res.status(403).json({ error: "forbidden" });
  }

  await serviceClient.from("rent_buddy_safety_events").insert({
    booking_id: bookingId,
    actor_user_id: auth.user.id,
    event_type: "emergency_phrase_triggered",
    event_status: "open",
    metadata: { phrase: "I need to check my passport" },
  });

  await serviceClient
    .from("rent_buddy_bookings")
    .update({ safety_status: "check_requested", updated_at: new Date().toISOString() })
    .eq("id", bookingId);

  // Private prompt — returned to traveler ONLY. Buddy is never informed.
  return res.json({
    travelerOnly: true,
    prompt: "Are you okay? Only you can see this message.",
    options: [
      { id: "ok",             label: "I am okay" },
      { id: "end_booking",    label: "End booking now" },
      { id: "share_location", label: "Share location with Trusted Circle" },
      { id: "safe_return",    label: "Start Safe Return" },
      { id: "contact_support",label: "Contact support" },
      { id: "emergency",      label: "Use emergency button" },
    ],
  });
});

// ── Application ───────────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/apply", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data } = await serviceClient
    .from("rent_buddy_applications")
    .select("*")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  return res.json({ application: mapApplication(data) });
});

router.post("/api/rent-a-buddy/apply", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { city, country, categories = [], languages = [], motivation, socialLinks = {} } = req.body ?? {};
  if (!city) return res.status(400).json({ error: "invalid_payload", message: "city required." });

  if (motivation) {
    const matches = await scanForPolicyViolations({
      sc: serviceClient, text: motivation, sourceType: "profile", flaggedUserId: auth.user.id,
    });
    await applyPolicySeverity({ sc: serviceClient, userId: auth.user.id, matches });
  }

  const { data, error } = await serviceClient
    .from("rent_buddy_applications")
    .upsert(
      {
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
      },
      { onConflict: "user_id" },
    )
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
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data } = await serviceClient
    .from("rent_buddy_profiles")
    .select("*")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  return res.json({ profile: mapProfile(data) });
});

router.patch("/api/rent-a-buddy/me/profile", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const body = req.body ?? {};
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (body.displayName !== undefined)  patch.display_name   = body.displayName;
  if (body.tagline !== undefined)       patch.tagline        = body.tagline;
  if (body.bio !== undefined)           patch.bio            = body.bio;
  if (body.introVideoUrl !== undefined) patch.intro_video_url = body.introVideoUrl;
  if (body.languages !== undefined)     patch.languages      = body.languages;
  if (body.coverPhotoUrl !== undefined) patch.cover_photo_url = body.coverPhotoUrl;
  if (body.galleryUrls !== undefined)   patch.gallery_urls   = body.galleryUrls;
  if (body.vibeTags !== undefined)      patch.vibe_tags      = body.vibeTags;
  if (body.maxGroupSize !== undefined)  patch.max_group_size = body.maxGroupSize;
  if (body.preferredMeetupZones !== undefined) patch.preferred_meetup_zones = body.preferredMeetupZones;

  if (body.bio) {
    const matches = await scanForPolicyViolations({
      sc: serviceClient, text: body.bio, sourceType: "profile", flaggedUserId: auth.user.id,
    });
    await applyPolicySeverity({ sc: serviceClient, userId: auth.user.id, matches });
  }

  await serviceClient.from("rent_buddy_profiles").update(patch).eq("user_id", auth.user.id);
  return res.json({ ok: true });
});

router.patch("/api/rent-a-buddy/me/availability", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });

  const { entries = [] } = req.body ?? {};
  for (const e of entries as any[]) {
    await serviceClient.from("rent_buddy_availability").upsert(
      {
        buddy_id: (bp as any).id, date: e.date,
        time_slots: e.timeSlots ?? [], is_available: e.isAvailable ?? true, notes: e.notes ?? null,
      },
      { onConflict: "buddy_id,date" },
    );
  }
  return res.json({ ok: true });
});

router.get("/api/rent-a-buddy/me/requests", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!bp) return res.json({ requests: [] });

  const { data } = await serviceClient
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
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data } = await serviceClient
    .from("rent_buddy_saved")
    .select("buddy_id, rent_buddy_profiles(*)")
    .eq("user_id", auth.user.id);

  return res.json({ saved: (data ?? []).map((row: any) => mapProfile(row.rent_buddy_profiles)) });
});

router.post("/api/rent-a-buddy/saved/:buddyId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  await serviceClient.from("rent_buddy_saved").upsert({ user_id: auth.user.id, buddy_id: req.params.buddyId });
  return res.json({ ok: true });
});

router.delete("/api/rent-a-buddy/saved/:buddyId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  await serviceClient.from("rent_buddy_saved").delete().eq("user_id", auth.user.id).eq("buddy_id", req.params.buddyId);
  return res.json({ ok: true });
});

// ── Waitlist ──────────────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/waitlist", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data } = await serviceClient
    .from("rent_buddy_waitlist")
    .select("id, city, category, created_at")
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false });

  return res.json({ waitlist: (data ?? []).map((r: any) => ({ id: r.id, city: r.city, category: r.category, createdAt: r.created_at })) });
});

router.post("/api/rent-a-buddy/waitlist", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { city, category } = req.body ?? {};
  if (!city) return res.status(400).json({ error: "invalid_payload", message: "city required." });

  await serviceClient.from("rent_buddy_waitlist").upsert(
    { user_id: auth.user.id, city, category: category ?? null },
    { onConflict: "user_id,city" },
  );

  return res.status(201).json({ ok: true });
});

router.delete("/api/rent-a-buddy/waitlist/:city", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  await serviceClient.from("rent_buddy_waitlist")
    .delete()
    .eq("user_id", auth.user.id)
    .eq("city", decodeURIComponent(req.params.city));

  return res.json({ ok: true });
});

// ── Buddy Dashboard ───────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/dashboard", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: profile } = await serviceClient
    .from("rent_buddy_profiles")
    .select("*")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (!profile) {
    return res.json({ profile: null, upcomingBookings: 0, pendingRequests: 0, totalEarningsUsd: 0, averageRating: null, reviewCount: 0 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const [upcomingRes, pendingRes, earningsRes] = await Promise.all([
    serviceClient.from("rent_buddy_bookings").select("id", { count: "exact" }).eq("buddy_id", (profile as any).id).eq("status", "confirmed").gte("booking_date", today),
    serviceClient.from("rent_buddy_bookings").select("id", { count: "exact" }).eq("buddy_id", (profile as any).id).eq("status", "pending"),
    serviceClient.from("rent_buddy_bookings").select("total_usd").eq("buddy_id", (profile as any).id).eq("status", "completed"),
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
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.json({ requests: [] });

  const { data } = await serviceClient
    .from("rent_buddy_bookings")
    .select("*")
    .eq("buddy_id", (bp as any).id)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  return res.json({ requests: (data ?? []).map(mapBooking) });
});

router.patch("/api/rent-a-buddy/dashboard/offer", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const body = req.body ?? {};
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (body.displayName !== undefined)  patch.display_name   = body.displayName;
  if (body.tagline !== undefined)       patch.tagline        = body.tagline;
  if (body.bio !== undefined)           patch.bio            = body.bio;
  if (body.languages !== undefined)     patch.languages      = body.languages;
  if (body.categories !== undefined)    patch.categories     = body.categories;
  if (body.hourlyRateUsd !== undefined) patch.hourly_rate_usd = body.hourlyRateUsd;

  await serviceClient.from("rent_buddy_profiles").update(patch).eq("user_id", auth.user.id);
  return res.json({ ok: true });
});

router.get("/api/rent-a-buddy/dashboard/availability", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.json({ availability: [] });

  const { data } = await serviceClient
    .from("rent_buddy_availability")
    .select("*")
    .eq("buddy_id", (bp as any).id)
    .gte("date", new Date().toISOString().slice(0, 10))
    .order("date");

  return res.json({
    availability: (data ?? []).map((av: any) => ({
      id: av.id, date: av.date, timeSlots: av.time_slots ?? [], isAvailable: av.is_available, notes: av.notes,
    })),
  });
});

router.post("/api/rent-a-buddy/dashboard/availability", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });

  const { entries = [] } = req.body ?? {};
  for (const e of entries as any[]) {
    await serviceClient.from("rent_buddy_availability").upsert(
      { buddy_id: (bp as any).id, date: e.date, time_slots: e.timeSlots ?? [], is_available: e.isAvailable ?? true, notes: e.notes ?? null },
      { onConflict: "buddy_id,date" },
    );
  }
  return res.json({ ok: true });
});

// ── Dashboard — Packages ──────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/dashboard/packages", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.json({ packages: [] });
  const { data } = await serviceClient.from("rent_buddy_packages").select("*").eq("buddy_id", (bp as any).id).order("created_at");
  return res.json({ packages: data ?? [] });
});

router.post("/api/rent-a-buddy/dashboard/packages", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });

  const { title, description, category, durationH, priceUsd, maxGroup = 1 } = req.body ?? {};
  if (!title || !category || !durationH || !priceUsd) {
    return res.status(400).json({ error: "invalid_payload", message: "title, category, durationH, priceUsd required." });
  }

  const { data, error } = await serviceClient.from("rent_buddy_packages").insert({
    buddy_id: (bp as any).id, title, description: description ?? null, category,
    duration_h: durationH, price_usd: priceUsd, max_group: maxGroup, is_active: true,
    updated_at: new Date().toISOString(),
  }).select().maybeSingle();
  if (error) return sendError(res, "db_error", error.message);

  return res.status(201).json({ pkg: data });
});

router.patch("/api/rent-a-buddy/dashboard/packages/:packageId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });

  const body = req.body ?? {};
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (body.title !== undefined)       patch.title       = body.title;
  if (body.description !== undefined) patch.description = body.description;
  if (body.durationH !== undefined)   patch.duration_h  = body.durationH;
  if (body.priceUsd !== undefined)    patch.price_usd   = body.priceUsd;
  if (body.maxGroup !== undefined)    patch.max_group   = body.maxGroup;
  if (body.isActive !== undefined)    patch.is_active   = body.isActive;

  await serviceClient.from("rent_buddy_packages").update(patch).eq("id", req.params.packageId).eq("buddy_id", (bp as any).id);
  return res.json({ ok: true });
});

router.delete("/api/rent-a-buddy/dashboard/packages/:packageId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });
  await serviceClient.from("rent_buddy_packages").delete().eq("id", req.params.packageId).eq("buddy_id", (bp as any).id);
  return res.json({ ok: true });
});

// ── Dashboard — Addons ────────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/dashboard/addons", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.json({ addons: [] });
  const { data } = await serviceClient.from("rent_buddy_addons").select("*").eq("buddy_id", (bp as any).id).order("created_at");
  return res.json({ addons: data ?? [] });
});

router.post("/api/rent-a-buddy/dashboard/addons", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });

  const { title, description, priceUsd } = req.body ?? {};
  if (!title || !priceUsd) return res.status(400).json({ error: "invalid_payload", message: "title, priceUsd required." });

  const { data, error } = await serviceClient.from("rent_buddy_addons").insert({
    buddy_id: (bp as any).id, title, description: description ?? null, price_usd: priceUsd, is_active: true,
  }).select().maybeSingle();
  if (error) return sendError(res, "db_error", error.message);

  return res.status(201).json({ addon: data });
});

router.patch("/api/rent-a-buddy/dashboard/addons/:addonId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });

  const body = req.body ?? {};
  const patch: Record<string, any> = {};
  if (body.title !== undefined)       patch.title       = body.title;
  if (body.description !== undefined) patch.description = body.description;
  if (body.priceUsd !== undefined)    patch.price_usd   = body.priceUsd;
  if (body.isActive !== undefined)    patch.is_active   = body.isActive;

  await serviceClient.from("rent_buddy_addons").update(patch).eq("id", req.params.addonId).eq("buddy_id", (bp as any).id);
  return res.json({ ok: true });
});

router.delete("/api/rent-a-buddy/dashboard/addons/:addonId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });
  await serviceClient.from("rent_buddy_addons").delete().eq("id", req.params.addonId).eq("buddy_id", (bp as any).id);
  return res.json({ ok: true });
});

// ── Dashboard — Earnings ──────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/dashboard/earnings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.json({ totalUsd: 0, thisMonthUsd: 0, completedBookings: 0, breakdown: [] });

  const { data } = await serviceClient
    .from("rent_buddy_bookings")
    .select("total_usd, booking_date")
    .eq("buddy_id", (bp as any).id)
    .eq("status", "completed");

  const rows = (data ?? []) as any[];
  const totalUsd = rows.reduce((s: number, r: any) => s + Number(r.total_usd ?? 0), 0);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const thisMonthUsd = rows
    .filter((r: any) => (r.booking_date ?? "").startsWith(thisMonth))
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

// ── Admin — Applications ──────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/admin/applications", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient } = admin;

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const status = (req.query.status as string) ?? undefined;

  let query = serviceClient
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
  const { sc: serviceClient, userId } = admin;

  const { appId } = req.params;
  const { status, reviewNotes, approvedCategories } = req.body ?? {};

  const { adminStatus } = req.body ?? {};
  // Handle adminStatus-only updates (limit/suspend) separately from status workflow changes
  if (adminStatus !== undefined && status === undefined) {
    if (!["limited", "suspended"].includes(adminStatus)) {
      return res.status(400).json({ error: "invalid_payload" });
    }
    await serviceClient.from("rent_buddy_applications").update({
      admin_status: adminStatus,
      updated_at: new Date().toISOString(),
    }).eq("id", appId);
    await serviceClient.from("rent_buddy_admin_actions").insert({
      admin_id: userId, target_type: "application", target_id: appId,
      action: `admin_status_${adminStatus}`, notes: null,
    });
    return res.json({ ok: true });
  }

  if (!["approved", "rejected", "under_review"].includes(status)) {
    return res.status(400).json({ error: "invalid_payload", message: "status must be approved|rejected|under_review." });
  }

  const { data: app } = await serviceClient
    .from("rent_buddy_applications")
    .select("user_id, city, categories, languages")
    .eq("id", appId)
    .maybeSingle();
  if (!app) return res.status(404).json({ error: "not_found" });

  await serviceClient.from("rent_buddy_applications").update({
    status,
    review_notes: reviewNotes ?? null,
    reviewed_by: userId,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", appId);

  if (status === "approved") {
    // Use admin-selected subset of categories if provided; fall back to all application categories
    const categoriesToApprove: string[] = (
      Array.isArray(approvedCategories) && approvedCategories.length > 0
        ? approvedCategories
        : (app as any).categories ?? []
    );
    await serviceClient.from("rent_buddy_profiles").upsert({
      user_id: (app as any).user_id,
      city: (app as any).city ?? "Unknown",
      categories: categoriesToApprove,
      languages: (app as any).languages ?? [],
      status: "active",
      admin_status: "active",
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

    // Positive trust event for the newly approved buddy
    void recordTrustEvent(serviceClient, {
      userId: (app as any).user_id,
      eventType: "rent_buddy_application_approved",
      category: "community_value",
      delta: 10,
      severity: "minor",
      sourceType: "admin",
      sourceId: appId,
    });
  }

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: userId,
    target_type: "application",
    target_id: appId,
    action: `status_changed_to_${status}`,
    notes: reviewNotes ?? null,
  });

  return res.json({ ok: true });
});

// ── Admin — Buddies & Bookings ────────────────────────────────────────────────

router.get("/api/rent-a-buddy/admin/buddies", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient } = admin;

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const { city, status, category, level } = req.query as Record<string, string | undefined>;

  let query = serviceClient
    .from("rent_buddy_profiles")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false });

  if (city) query = (query as any).ilike("city", `%${city}%`);
  if (status && status !== "all") query = (query as any).eq("status", status);
  if (category) query = (query as any).contains("categories", [category]);
  if (level) query = (query as any).eq("buddy_level", level);

  const { data, count } = await (query as any).range((page - 1) * limit, page * limit - 1);

  return res.json({ buddies: (data ?? []).map(mapProfile), total: count ?? 0 });
});

router.post("/api/rent-a-buddy/admin/buddies/:buddyId/suspend", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient, userId } = admin;
  const { buddyId } = req.params;
  const { reason } = req.body ?? {};
  const { data: buddy } = await serviceClient.from("rent_buddy_profiles").select("id").eq("id", buddyId).maybeSingle();
  if (!buddy) return res.status(404).json({ error: "not_found" });
  await serviceClient.from("rent_buddy_profiles").update({ admin_status: "disabled", status: "suspended", updated_at: new Date().toISOString() }).eq("id", buddyId);
  await serviceClient.from("rent_buddy_admin_actions").insert({ admin_id: userId, target_type: "buddy", target_id: buddyId, action: "suspended", notes: reason ?? null });
  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/admin/buddies/:buddyId/reactivate", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient, userId } = admin;
  const { buddyId } = req.params;
  const { data: buddy } = await serviceClient.from("rent_buddy_profiles").select("id").eq("id", buddyId).maybeSingle();
  if (!buddy) return res.status(404).json({ error: "not_found" });
  await serviceClient.from("rent_buddy_profiles").update({ admin_status: "active", status: "active", updated_at: new Date().toISOString() }).eq("id", buddyId);
  await serviceClient.from("rent_buddy_admin_actions").insert({ admin_id: userId, target_type: "buddy", target_id: buddyId, action: "reactivated", notes: null });
  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/admin/buddies/:buddyId/feature", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient, userId } = admin;
  const { buddyId } = req.params;
  const { data: buddy } = await serviceClient.from("rent_buddy_profiles").select("id").eq("id", buddyId).maybeSingle();
  if (!buddy) return res.status(404).json({ error: "not_found" });
  await serviceClient.from("rent_buddy_profiles").update({ featured: true, updated_at: new Date().toISOString() }).eq("id", buddyId);
  await serviceClient.from("rent_buddy_admin_actions").insert({ admin_id: userId, target_type: "buddy", target_id: buddyId, action: "featured", notes: null });
  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/admin/buddies/:buddyId/unfeature", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient, userId } = admin;
  const { buddyId } = req.params;
  const { data: buddy } = await serviceClient.from("rent_buddy_profiles").select("id").eq("id", buddyId).maybeSingle();
  if (!buddy) return res.status(404).json({ error: "not_found" });
  await serviceClient.from("rent_buddy_profiles").update({ featured: false, updated_at: new Date().toISOString() }).eq("id", buddyId);
  await serviceClient.from("rent_buddy_admin_actions").insert({ admin_id: userId, target_type: "buddy", target_id: buddyId, action: "unfeatured", notes: null });
  return res.json({ ok: true });
});

router.patch("/api/rent-a-buddy/admin/buddies/:buddyId/level", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient, userId } = admin;
  const { buddyId } = req.params;
  const { level } = req.body as { level: string };
  if (!['standard', 'pro', 'elite'].includes(level)) return res.status(400).json({ error: "invalid_level" });
  const { data: buddy } = await serviceClient.from("rent_buddy_profiles").select("id").eq("id", buddyId).maybeSingle();
  if (!buddy) return res.status(404).json({ error: "not_found" });
  await serviceClient.from("rent_buddy_profiles").update({ buddy_level: level, updated_at: new Date().toISOString() }).eq("id", buddyId);
  await serviceClient.from("rent_buddy_admin_actions").insert({ admin_id: userId, target_type: "buddy", target_id: buddyId, action: `level_set_${level}`, notes: null });
  return res.json({ ok: true });
});

router.patch("/api/rent-a-buddy/admin/buddies/:buddyId/categories", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient, userId } = admin;
  const { buddyId } = req.params;
  const { categories } = req.body as { categories: string[] };
  if (!Array.isArray(categories)) return res.status(400).json({ error: "invalid_payload" });
  const { data: buddy } = await serviceClient.from("rent_buddy_profiles").select("id").eq("id", buddyId).maybeSingle();
  if (!buddy) return res.status(404).json({ error: "not_found" });
  await serviceClient.from("rent_buddy_profiles").update({ categories, updated_at: new Date().toISOString() }).eq("id", buddyId);
  await serviceClient.from("rent_buddy_admin_actions").insert({ admin_id: userId, target_type: "buddy", target_id: buddyId, action: "categories_updated", notes: JSON.stringify(categories) });
  return res.json({ ok: true });
});

router.get("/api/rent-a-buddy/admin/bookings", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient } = admin;

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const status = (req.query.status as string) ?? undefined;
  const city = (req.query.city as string) ?? undefined;
  const category = (req.query.category as string) ?? undefined;
  const paymentMode = (req.query.paymentMode as string) ?? undefined;
  const dateFrom = (req.query.dateFrom as string) ?? undefined;
  const dateTo = (req.query.dateTo as string) ?? undefined;

  let query = serviceClient
    .from("rent_buddy_bookings")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);
  if (status) query = query.eq("status", status);
  if (city) query = query.ilike("city", `%${city}%`);
  if (category) query = query.eq("category", category);
  if (paymentMode) query = query.eq("payment_mode", paymentMode);
  if (dateFrom) query = query.gte("booking_date", dateFrom);
  if (dateTo) query = query.lte("booking_date", dateTo);

  const { data, count } = await query;
  return res.json({ bookings: (data ?? []).map(mapBooking), total: count ?? 0 });
});

router.get("/api/rent-a-buddy/admin/analytics", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient } = admin;

  const [totalBuddies, activeBuddies, totalBookings, completedBookings, pendingApps] = await Promise.all([
    serviceClient.from("rent_buddy_profiles").select("id", { count: "exact" }),
    serviceClient.from("rent_buddy_profiles").select("id", { count: "exact" }).eq("status", "active"),
    serviceClient.from("rent_buddy_bookings").select("id", { count: "exact" }),
    serviceClient.from("rent_buddy_bookings").select("id", { count: "exact" }).eq("status", "completed"),
    serviceClient.from("rent_buddy_applications").select("id", { count: "exact" }).eq("status", "pending"),
  ]);

  const { data: revenueData } = await serviceClient
    .from("rent_buddy_bookings")
    .select("total_usd")
    .eq("status", "completed");

  const totalRevenueUsd = (revenueData ?? []).reduce((s: number, r: any) => s + Number(r.total_usd ?? 0), 0);

  const [{ data: bookingsForBreakdown }, { count: openFlagsCount }] = await Promise.all([
    serviceClient.from("rent_buddy_bookings").select("status, city, category"),
    serviceClient.from("rent_buddy_policy_flags").select("id", { count: "exact" }).eq("status", "open"),
  ]);

  const statusMap: Record<string, number> = {};
  const cityMap: Record<string, number> = {};
  const categoryMap: Record<string, number> = {};
  for (const bk of bookingsForBreakdown ?? []) {
    const b = bk as any;
    statusMap[b.status] = (statusMap[b.status] ?? 0) + 1;
    if (b.city) cityMap[b.city] = (cityMap[b.city] ?? 0) + 1;
    if (b.category) categoryMap[b.category] = (categoryMap[b.category] ?? 0) + 1;
  }
  const bookingsByStatus = Object.entries(statusMap).map(([status, count]) => ({ status, count }));
  const bookingsByCity = Object.entries(cityMap).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([city, count]) => ({ city, count }));
  const bookingsByCategory = Object.entries(categoryMap).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([category, count]) => ({ category, count }));

  return res.json({
    totalBuddies: totalBuddies.count ?? 0,
    activeBuddies: activeBuddies.count ?? 0,
    totalBookings: totalBookings.count ?? 0,
    completedBookings: completedBookings.count ?? 0,
    totalRevenue: totalRevenueUsd,
    totalRevenueUsd,
    pendingApplications: pendingApps.count ?? 0,
    openFlags: openFlagsCount ?? 0,
    bookingsByStatus,
    bookingsByCity,
    bookingsByCategory,
  });
});

// ── Admin — Safety flags ──────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/admin/safety/flags", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient } = admin;

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const severity = (req.query.severity as string) ?? undefined;
  const status = (req.query.status as string) ?? "open";

  let query = serviceClient
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
  const { sc: serviceClient, userId } = admin;

  const { flagId } = req.params;
  const { data: flag } = await serviceClient
    .from("rent_buddy_policy_flags")
    .select("id")
    .eq("id", flagId)
    .maybeSingle();
  if (!flag) return res.status(404).json({ error: "not_found" });

  await serviceClient.from("rent_buddy_policy_flags").update({
    status: "dismissed",
    admin_notes: req.body?.notes ?? null,
    resolved_at: new Date().toISOString(),
  }).eq("id", flagId);

  await serviceClient.from("rent_buddy_admin_actions").insert({
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
  const { sc: serviceClient, userId } = admin;

  const { flagId } = req.params;
  const { data: flag } = await serviceClient
    .from("rent_buddy_policy_flags")
    .select("*")
    .eq("id", flagId)
    .maybeSingle();
  if (!flag) return res.status(404).json({ error: "not_found" });

  const f = flag as any;

  await serviceClient.from("rent_buddy_policy_flags").update({
    status: "resolved",
    admin_notes: req.body?.notes ?? null,
    resolved_at: new Date().toISOString(),
  }).eq("id", flagId);

  // Trust Score penalty emitted HERE (admin confirms), not at scan time
  if (f.flagged_user_id) {
    const severityDelta: Record<string, number> = { critical: -30, high: -15, medium: -8, low: -3 };
    const trustSeverity: Record<string, "severe" | "serious" | "moderate" | "minor"> = {
      critical: "severe", high: "serious", medium: "moderate", low: "minor",
    };
    void recordTrustEvent(serviceClient, {
      userId: f.flagged_user_id,
      eventType: "rent_buddy_policy_flag_confirmed",
      category: "respect_safety",
      delta: severityDelta[f.severity] ?? -5,
      severity: trustSeverity[f.severity] ?? "minor",
      sourceType: "admin",
      sourceId: flagId,
    });

    // Risk hold for critical flags
    if (f.severity === "critical") {
      await serviceClient.from("rent_buddy_profiles")
        .update({ risk_hold: true, admin_status: "disabled" })
        .eq("user_id", f.flagged_user_id);
    }
  }

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: userId,
    target_type: "flag",
    target_id: flagId,
    action: "confirmed",
    notes: req.body?.notes ?? null,
  });

  return res.json({ ok: true });
});

router.post("/api/rent-a-buddy/admin/safety/flags/:flagId/escalate", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient, userId } = admin;

  const { flagId } = req.params;
  const { data: flag } = await serviceClient
    .from("rent_buddy_policy_flags")
    .select("id")
    .eq("id", flagId)
    .maybeSingle();
  if (!flag) return res.status(404).json({ error: "not_found" });

  await serviceClient.from("rent_buddy_policy_flags").update({
    status: "escalated",
    admin_notes: req.body?.notes ? `[ESCALATED] ${req.body.notes}` : "[ESCALATED TO SUPPORT]",
    updated_at: new Date().toISOString(),
  }).eq("id", flagId);

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: userId,
    target_type: "flag",
    target_id: flagId,
    action: "escalated",
    notes: req.body?.notes ?? null,
  });

  return res.json({ ok: true });
});

// ── Admin — Safety events ─────────────────────────────────────────────────────

router.get("/api/rent-a-buddy/admin/safety/events", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient } = admin;

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const status = (req.query.status as string) ?? "open";

  let query = serviceClient
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
  const { sc: serviceClient, userId: adminId } = admin;

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

  const { data, error } = await serviceClient.from("rent_buddy_user_limits").upsert(
    {
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
    },
    { onConflict: "user_id" },
  ).select().maybeSingle();

  if (error) return sendError(res, "db_error", error.message);

  await serviceClient.from("rent_buddy_admin_actions").insert({
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
  const { sc: serviceClient, userId: adminId } = admin;

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

  await serviceClient.from("rent_buddy_user_limits").update(patch).eq("user_id", userId);

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: adminId,
    target_type: "user",
    target_id: userId,
    action: "limits_updated",
    notes: body.reason ?? null,
  });

  return res.json({ ok: true });
});

export default router;
