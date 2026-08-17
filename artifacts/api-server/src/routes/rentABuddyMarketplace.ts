/**
 * Rent a Buddy — Marketplace Layer
 *
 * Endpoints added in this file (all under /api/rent-a-buddy/):
 *
 * Match & Discovery
 *   POST   /match/preferences          — save quiz answers
 *   POST   /match                      — run compatibility + return ranked list
 *   GET    /sections                   — 13 discovery sections in one call
 *   GET    /available-now              — Available Now Buddies
 *   GET    /cities/:city/top           — top Buddies in a city
 *
 * Availability
 *   GET    /me/availability-settings   — full availability settings
 *   PATCH  /me/availability-settings   — update all availability fields
 *   POST   /me/available-now           — toggle Available Now ON (with duration)
 *   DELETE /me/available-now           — toggle Available Now OFF
 *
 * Requests & Offers
 *   POST   /requests                   — create open request
 *   GET    /requests/:requestId        — get request
 *   GET    /me/matching-requests       — Buddy inbox of matching open requests
 *   POST   /requests/:requestId/offers — Buddy submits offer
 *   POST   /offers/:offerId/accept     — convert offer → booking
 *   POST   /offers/:offerId/decline    — decline offer (traveler)
 *   POST   /offers/:offerId/withdraw   — withdraw offer (buddy)
 *   GET    /me/offers                  — Buddy's sent offers
 *   GET    /requests/:requestId/offers — traveler view of offers on a request
 *
 * Enhanced Packages
 *   POST   /me/packages/v2             — create package with stops + admin review
 *   PATCH  /me/packages/v2/:packageId  — update package
 *   GET    /buddies/:buddyId/packages  — packages for a buddy
 *   GET    /packages/:packageId        — single package
 *   POST   /packages/:packageId/book   — book a package
 *
 * Add-ons & Tips
 *   GET    /buddies/:buddyId/addons    — buddy's active addons
 *   POST   /me/addons                  — create addon
 *   PATCH  /me/addons/:addonId         — update addon
 *   POST   /bookings/:bookingId/addons — attach addons at checkout
 *   POST   /bookings/:bookingId/tip    — post-completion tip
 *
 * Saved Buddies & Waitlist
 *   POST   /buddies/:buddyId/save      — save with notes
 *   DELETE /buddies/:buddyId/save      — unsave
 *   GET    /me/saved-buddies           — list saved + notes
 *   POST   /buddies/:buddyId/book-again— shortcut to create booking
 *   POST   /waitlist/v2                — join waitlist (full fields)
 *   GET    /me/waitlist/v2             — list waitlist entries
 *   DELETE /waitlist/:waitlistId       — leave waitlist entry
 *
 * Earnings Ledger
 *   GET    /me/earnings/summary        — aggregated summary
 *   GET    /me/earnings/ledger         — per-booking fee breakdowns
 *
 * Pricing helpers
 *   GET    /pricing/suggestion         — suggested range for Buddy
 *
 * Admin Marketplace
 *   GET    /admin/marketplace/analytics  — full analytics
 *   GET    /admin/marketplace/cities     — city supply/demand
 *   POST   /admin/profiles/:id/feature
 *   DELETE /admin/profiles/:id/feature
 *   POST   /admin/profiles/:id/city-ambassador
 *   POST   /admin/packages/:id/approve
 *   POST   /admin/packages/:id/disable
 *   GET    /admin/pricing/outliers
 *   PATCH  /admin/fee-rules
 *   POST   /admin/users/:userId/force-public-meetup
 *   POST   /admin/users/:userId/force-full-in-app
 *   POST   /admin/restrictions/city-category — disable deposit_plus_cash for city/category
 */

import { Router } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import { isNonNumericCoord } from "../lib/coords.js";
import { sendPushWithRetry } from "../lib/pushWithRetry.js";
import { invalidate as invalidateCompassCache } from "../compass/CompassCacheEngine.js";
import { invalidateSuggestedCityCache, checkRentBuddyAccess } from "./rentABuddyRollout.js";
import { requireBookingKyc } from "../lib/rentBuddyKycGate.js";
import { isKillSwitchEngaged } from "../lib/featureFlags.js";
import { getUserLimits } from "./rentABuddy.js";
import {
  calculateCompatibilityScore,
  rankBuddies,
  type BuddyScoringData,
  type MatchPreferences,
} from "../services/rentBuddy/CompatibilityScoreService.js";
import { NotificationPreferenceService } from "../services/notifications/NotificationPreferenceService.js";
import { syncFavoritesCount } from "../services/rentBuddy/ReliabilityCounters.js";
import {
  getPricingSuggestion,
  calculateDeposit,
  getBookingExpiresAt,
} from "../services/rentBuddy/PricingService.js";

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────────

function sc() {
  return getServiceClient();
}

async function requireAdmin(req: any, res: any): Promise<{ userId: string; svc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;
  const { data } = await client.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required." });
    return null;
  }
  return { userId: user.id, svc: sc() ?? client };
}

async function requireBuddyProfile(client: any, userId: string): Promise<any | null> {
  const { data } = await client
    .from("rent_buddy_profiles")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  return data ?? null;
}

async function emitAnalyticsEvent(
  svc: any,
  eventType: string,
  payload: {
    userId?: string | null;
    buddyId?: string | null;
    city?: string | null;
    category?: string | null;
    amountUsd?: number | null;
    metadata?: Record<string, unknown>;
  },
) {
  const { error } = await svc.from("rent_buddy_marketplace_analytics_events").insert({
    event_type: eventType,
    user_id: payload.userId ?? null,
    buddy_id: payload.buddyId ?? null,
    city: payload.city ?? null,
    category: payload.category ?? null,
    amount_usd: payload.amountUsd ?? null,
    metadata: payload.metadata ?? {},
  });
  if (error) {
    logger.error({ err: error, eventType }, "analytics event emit failed");
  }
}

function mapPackage(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    buddyId: row.buddy_id,
    title: row.title,
    description: row.description,
    category: row.category,
    city: row.city,
    durationH: Number(row.duration_h ?? 0),
    durationMinutes: row.duration_minutes ?? 0,
    priceUsd: Number(row.price_usd ?? 0),
    basePrice: row.base_price ? Number(row.base_price) : null,
    maxGroup: row.max_group ?? 1,
    maxGroupSize: row.max_group ?? 1,
    isActive: row.is_active,
    depositRequired: row.deposit_required,
    depositPercent: row.deposit_percent,
    paymentModesAllowed: row.payment_modes_allowed ?? ['full_in_app'],
    includedStops: row.included_stops ?? [],
    includedServices: row.included_services ?? [],
    addonIds: row.addon_ids ?? [],
    adminReviewStatus: row.admin_review_status ?? 'pending',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOffer(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    requestId: row.request_id,
    buddyProfileId: row.buddy_profile_id,
    buddyUserId: row.buddy_user_id,
    proposedPriceUsd: Number(row.proposed_price_usd ?? 0),
    depositAmountUsd: Number(row.deposit_amount_usd ?? 0),
    cashBalanceUsd: Number(row.cash_balance_usd ?? 0),
    proposedStart: row.proposed_start,
    proposedEnd: row.proposed_end,
    meetupLocation: row.meetup_location,
    message: row.message,
    includedServices: row.included_services ?? [],
    addonsOffered: row.addons_offered ?? [],
    paymentMode: row.payment_mode,
    expiresAt: row.expires_at,
    status: row.status,
    acceptedBookingId: row.accepted_booking_id,
    createdAt: row.created_at,
  };
}

function mapRequest(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    travelerId: row.traveler_id,
    city: row.city,
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    category: row.category,
    desiredDate: row.desired_date,
    desiredTime: row.desired_time,
    durationMinutes: row.duration_minutes,
    groupSize: row.group_size,
    budgetMinUsd: row.budget_min_usd ? Number(row.budget_min_usd) : null,
    budgetMaxUsd: row.budget_max_usd ? Number(row.budget_max_usd) : null,
    languageNeeded: row.language_needed,
    energyType: row.energy_type,
    paymentModePref: row.payment_mode_pref,
    notes: row.notes,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function mapProfile(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    tagline: row.tagline,
    city: row.city,
    country: row.country,
    languages: row.languages ?? [],
    categories: row.categories ?? [],
    hourlyRateUsd: row.hourly_rate_usd ? Number(row.hourly_rate_usd) : null,
    halfDayRateUsd: row.half_day_rate_usd ? Number(row.half_day_rate_usd) : null,
    fullDayRateUsd: row.full_day_rate_usd ? Number(row.full_day_rate_usd) : null,
    nightlifeRateUsd: row.nightlife_rate_usd ? Number(row.nightlife_rate_usd) : null,
    arrivalRateUsd: row.arrival_rate_usd ? Number(row.arrival_rate_usd) : null,
    status: row.status,
    verified: row.verified,
    averageRating: row.average_rating ? Number(row.average_rating) : null,
    reviewCount: row.review_count ?? 0,
    completedBookings: row.completed_count ?? row.completed_bookings ?? 0,
    responseTimeH: row.response_time_h ? Number(row.response_time_h) : null,
    coverPhotoUrl: row.cover_photo_url,
    galleryUrls: row.gallery_urls ?? [],
    vibeTags: row.vibe_tags ?? [],
    safetyBadges: row.safety_badges ?? [],
    buddyLevel: row.buddy_level,
    featured: row.featured ?? false,
    cityAmbassador: row.city_ambassador ?? false,
    availableNow: row.available_now ?? false,
    femaleOnlyService: row.female_only_service ?? false,
    publicMeetupOnly: row.public_meetup_only ?? false,
    groupApproved: row.group_approved ?? false,
    nightlifeApproved: row.nightlife_approved ?? false,
    energyType: row.energy_type,
    maxGroupSize: row.max_group_size,
    createdAt: row.created_at,
  };
}

// ── Build BuddyScoringData from DB row ────────────────────────────────────────

function toBuddyScoringData(row: any, trustScore: number): BuddyScoringData {
  return {
    buddyProfileId: row.id,
    buddyUserId: row.user_id,
    city: row.city,
    categories: row.categories ?? [],
    languages: row.languages ?? [],
    hourlyRateUsd: row.hourly_rate_usd ? Number(row.hourly_rate_usd) : null,
    halfDayRateUsd: row.half_day_rate_usd ? Number(row.half_day_rate_usd) : null,
    fullDayRateUsd: row.full_day_rate_usd ? Number(row.full_day_rate_usd) : null,
    vibeTagsList: row.vibe_tags ?? [],
    energyType: row.energy_type ?? null,
    buddyLevel: row.buddy_level ?? 'new',
    averageRating: row.average_rating ? Number(row.average_rating) : null,
    reviewCount: row.review_count ?? 0,
    completedBookings: row.completed_count ?? row.completed_bookings ?? 0,
    responseTimeH: row.response_time_h ? Number(row.response_time_h) : null,
    verified: row.verified ?? false,
    featured: row.featured ?? false,
    cityAmbassador: row.city_ambassador ?? false,
    availableNow: row.available_now ?? false,
    femaleOnlyService: row.female_only_service ?? false,
    publicMeetupOnly: row.public_meetup_only ?? false,
    groupApproved: row.group_approved ?? false,
    nightlifeApproved: row.nightlife_approved ?? false,
    arrivalApproved: row.arrival_approved ?? false,
    categoryApprovals: row.category_approvals ?? {},
    trustScore,
    maxGroupSize: row.max_group_size ?? 4,
    newBuddyPublicOnly: row.new_buddy_public_only ?? true,
    newBuddyDaytimeOnly: row.new_buddy_daytime_only ?? true,
    riskHold: row.risk_hold ?? false,
    adminStatus: row.admin_status ?? 'active',
    status: row.status ?? 'active',
  };
}

// ── Match preferences ─────────────────────────────────────────────────────────

router.post("/rent-a-buddy/match/preferences", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const svc = sc() ?? auth.client;

  const {
    need, vibe, energy, language,
    budgetMinUsd, budgetMaxUsd, bookingLength,
    safetyPrefs, groupSize, femaleOnly, publicOnly, rawAnswers,
  } = req.body ?? {};

  const { error } = await svc
    .from("rent_buddy_match_preferences")
    .upsert({
      user_id: user.id,
      need: need ?? null,
      vibe: vibe ?? null,
      energy: energy ?? null,
      language: language ?? null,
      budget_min_usd: budgetMinUsd ?? null,
      budget_max_usd: budgetMaxUsd ?? null,
      booking_length: bookingLength ?? null,
      safety_prefs: safetyPrefs ?? {},
      group_size: groupSize ?? 1,
      female_only: femaleOnly ?? false,
      public_only: publicOnly ?? false,
      raw_answers: rawAnswers ?? {},
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

  if (error) return sendError(res, 'db_error', error.message);
  res.json({ ok: true });
});

// ── Run match ─────────────────────────────────────────────────────────────────

router.post("/rent-a-buddy/match", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const svc = sc() ?? auth.client;

  const { city, preferences: prefOverride, limit = 20 } = req.body ?? {};

  // Load stored preferences (merge with any overrides in body)
  const { data: storedPrefs } = await svc
    .from("rent_buddy_match_preferences")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  const prefs: MatchPreferences = {
    need: prefOverride?.need ?? (storedPrefs as any)?.need,
    vibe: prefOverride?.vibe ?? (storedPrefs as any)?.vibe,
    energy: prefOverride?.energy ?? (storedPrefs as any)?.energy,
    language: prefOverride?.language ?? (storedPrefs as any)?.language,
    budgetMinUsd: prefOverride?.budgetMinUsd ?? (storedPrefs as any)?.budget_min_usd,
    budgetMaxUsd: prefOverride?.budgetMaxUsd ?? (storedPrefs as any)?.budget_max_usd,
    bookingLength: prefOverride?.bookingLength ?? (storedPrefs as any)?.booking_length,
    safetyPrefs: prefOverride?.safetyPrefs ?? (storedPrefs as any)?.safety_prefs ?? {},
    groupSize: prefOverride?.groupSize ?? (storedPrefs as any)?.group_size ?? 1,
    femaleOnly: prefOverride?.femaleOnly ?? (storedPrefs as any)?.female_only ?? false,
    publicOnly: prefOverride?.publicOnly ?? (storedPrefs as any)?.public_only ?? false,
  };

  // Load eligible Buddies in city
  const query = svc
    .from("rent_buddy_profiles")
    .select("*")
    .eq("status", "active")
    .eq("admin_status", "active");
  if (city) query.eq("city", city);

  const { data: buddyRows, error } = await query.limit(200);
  if (error) return sendError(res, 'db_error', error.message);

  const rows = (buddyRows as any[]) ?? [];

  // Load trust scores in batch
  const userIds = rows.map((r: any) => r.user_id);
  const { data: trustRows } = await svc
    .from("trust_profiles")
    .select("user_id, overall_score")
    .in("user_id", userIds.length > 0 ? userIds : ["00000000-0000-0000-0000-000000000000"]);

  const trustMap = new Map<string, number>();
  for (const t of (trustRows as any[]) ?? []) {
    trustMap.set(t.user_id, Number(t.overall_score ?? 50));
  }

  // Score + rank
  const scoringDataList = rows.map((r: any) =>
    toBuddyScoringData(r, trustMap.get(r.user_id) ?? 50)
  );
  const scoringMap = new Map(scoringDataList.map((s) => [s.buddyProfileId, s]));
  const scored = scoringDataList.map((bd) =>
    calculateCompatibilityScore(bd, prefs, city ?? null)
  );
  const ranked = rankBuddies(scored, scoringMap);
  const top = ranked.slice(0, limit);

  // Persist scores for caching
  const scoreInserts = top.map((s) => ({
    user_id: user.id,
    buddy_id: s.buddyProfileId,
    score: s.score,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    inputs: { prefs, breakdown: s.scoreBreakdown },
  }));
  if (scoreInserts.length > 0) {
    await Promise.resolve(await svc.from("rent_buddy_match_scores").upsert(scoreInserts, { onConflict: "user_id,buddy_id" })).catch(() => {});
  }

  // Log search event
  await Promise.resolve(await svc.from("rent_buddy_search_events").insert({
    user_id: user.id,
    city: city ?? null,
    category: prefs.need ?? null,
    filters: prefs,
    result_count: top.length,
  })).catch(() => {});

  const rowMap = new Map(rows.map((r: any) => [r.id, r]));
  const results = top.map((s) => ({
    ...mapProfile(rowMap.get(s.buddyProfileId)),
    compatibilityScore: s.score,
    scoreBreakdown: s.scoreBreakdown,
  }));

  emitAnalyticsEvent(svc, "search", { userId: user.id, city, category: prefs.need ?? null, metadata: { resultCount: top.length } });

  res.json({ results, total: top.length });
});

// ── Discovery sections ────────────────────────────────────────────────────────

router.get("/rent-a-buddy/sections", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const svc = sc() ?? auth.client;

  const city = (req.query.city as string) ?? null;
  const queryBase = svc.from("rent_buddy_profiles").select("*").eq("status", "active").eq("admin_status", "active");

  // Helper to run a filtered query
  async function section(filter: (q: any) => any, limit: number): Promise<any[]> {
    const q = svc.from("rent_buddy_profiles").select("*").eq("status", "active").eq("admin_status", "active");
    return (await filter(q).limit(limit)).data ?? [];
  }

  const cityFilter = (q: any) => city ? q.eq("city", city) : q;

  const [
    availableNowRows,
    topCityRows,
    femaleRows,
    nightlifeRows,
    languageRows,
    arrivalRows,
    contentRows,
    budgetRows,
    luxuryRows,
    groupRows,
    newVerifiedRows,
    ambassadorRows,
    requestRows,
  ] = await Promise.all([
    section((q) => cityFilter(q).eq("available_now", true), 10),
    section((q) => cityFilter(q).order("completed_count", { ascending: false }), 10),
    section((q) => cityFilter(q).eq("female_only_service", true), 10),
    section((q) => cityFilter(q).eq("nightlife_approved", true).contains("categories", ["nightlife"]), 10),
    section((q) => cityFilter(q).contains("categories", ["language"]), 10),
    section((q) => cityFilter(q).eq("arrival_approved", true).contains("categories", ["arrival"]), 10),
    section((q) => cityFilter(q).contains("categories", ["content"]), 10),
    section((q) => cityFilter(q).lte("hourly_rate_usd", 25).order("hourly_rate_usd", { ascending: true }), 10),
    section((q) => cityFilter(q).gte("hourly_rate_usd", 60).order("average_rating", { ascending: false }), 10),
    section((q) => cityFilter(q).eq("group_approved", true), 10),
    section((q) => cityFilter(q).eq("verified", true).eq("buddy_level", "new").order("created_at", { ascending: false }), 10),
    section((q) => cityFilter(q).eq("city_ambassador", true), 10),
    section((q) => cityFilter(q).order("created_at", { ascending: false }), 5),
  ]);

  emitAnalyticsEvent(svc, "search", { userId: user.id, city, metadata: { type: "sections" } });

  res.json({
    sections: [
      { key: "available_now",       title: "Available Now",              buddies: availableNowRows.map(mapProfile) },
      { key: "top_in_city",         title: "Top Buddies in This City",   buddies: topCityRows.map(mapProfile) },
      { key: "female_favorites",    title: "Female Traveler Favorites",  buddies: femaleRows.map(mapProfile) },
      { key: "nightlife",           title: "Nightlife Guides",           buddies: nightlifeRows.map(mapProfile) },
      { key: "language_help",       title: "Language Help",              buddies: languageRows.map(mapProfile) },
      { key: "arrival_help",        title: "Arrival Support",            buddies: arrivalRows.map(mapProfile) },
      { key: "content_photo",       title: "Content & Photo",            buddies: contentRows.map(mapProfile) },
      { key: "budget_friendly",     title: "Budget-Friendly Picks",      buddies: budgetRows.map(mapProfile) },
      { key: "luxury",              title: "Luxury Experiences",         buddies: luxuryRows.map(mapProfile) },
      { key: "group",               title: "Group Experiences",          buddies: groupRows.map(mapProfile) },
      { key: "new_verified",        title: "New Verified Buddies",       buddies: newVerifiedRows.map(mapProfile) },
      { key: "city_ambassadors",    title: "City Ambassadors",           buddies: ambassadorRows.map(mapProfile) },
      { key: "request_a_buddy",     title: "Request a Buddy",            buddies: requestRows.map(mapProfile), isCtaSection: true },
    ],
    city,
  });
});

// ── Available Now ─────────────────────────────────────────────────────────────

router.get("/rent-a-buddy/available-now", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;
  const city = req.query.city as string | undefined;

  let q = svc
    .from("rent_buddy_profiles")
    .select("*")
    .eq("status", "active")
    .eq("admin_status", "active")
    .eq("available_now", true);

  // Case/whitespace-insensitive match — must agree with /rent-buddy/launch-status'
  // availableNowCount, which uses the same ilike-on-trimmed-city comparison. An
  // exact `.eq` here previously let this list silently disagree with the count
  // used to decide whether to show a "buddies available" claim elsewhere.
  if (city) q = q.ilike("city", city.trim());

  const { data, error } = await q.limit(20);
  if (error) return sendError(res, 'db_error', error.message);
  res.json({ buddies: (data ?? []).map(mapProfile) });
});

// ── Top in city ───────────────────────────────────────────────────────────────

router.get("/rent-a-buddy/cities/:city/top", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;
  const { city } = req.params;

  const { data, error } = await svc
    .from("rent_buddy_profiles")
    .select("*")
    .eq("status", "active")
    .eq("admin_status", "active")
    .eq("city", city)
    .order("completed_count", { ascending: false })
    .limit(20);

  if (error) return sendError(res, 'db_error', error.message);
  res.json({ buddies: (data ?? []).map(mapProfile) });
});

// ── Availability settings ─────────────────────────────────────────────────────

router.get("/rent-a-buddy/me/availability-settings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;
  const buddyProfile = await requireBuddyProfile(svc, auth.user.id);
  if (!buddyProfile) return sendError(res, 'not_found', "Buddy profile not found.");

  const { data, error } = await svc
    .from("rent_buddy_availability")
    .select("*")
    .eq("buddy_id", buddyProfile.id)
    .maybeSingle();

  if (error) return sendError(res, 'db_error', error.message);
  res.json({ settings: data ?? null });
});

router.patch("/rent-a-buddy/me/availability-settings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;
  const buddyProfile = await requireBuddyProfile(svc, auth.user.id);
  if (!buddyProfile) return sendError(res, 'not_found', "Buddy profile not found.");

  const {
    weeklyBlocks, oneTimeBlocks, vacationDates,
    minNoticeHours, bufferMinutes, maxBookingsPerDay,
    nightlifeAvailable, arrivalAvailable, groupAvailable, customAvailable,
  } = req.body ?? {};

  const patch: Record<string, unknown> = { buddy_id: buddyProfile.id, updated_at: new Date().toISOString() };
  if (weeklyBlocks !== undefined) patch.weekly_blocks = weeklyBlocks;
  if (oneTimeBlocks !== undefined) patch.one_time_blocks = oneTimeBlocks;
  if (vacationDates !== undefined) patch.vacation_dates = vacationDates;
  if (minNoticeHours !== undefined) patch.min_notice_hours = minNoticeHours;
  if (bufferMinutes !== undefined) patch.buffer_minutes = bufferMinutes;
  if (maxBookingsPerDay !== undefined) patch.max_bookings_per_day = maxBookingsPerDay;
  if (nightlifeAvailable !== undefined) patch.nightlife_available = nightlifeAvailable;
  if (arrivalAvailable !== undefined) patch.arrival_available = arrivalAvailable;
  if (groupAvailable !== undefined) patch.group_available = groupAvailable;
  if (customAvailable !== undefined) patch.custom_available = customAvailable;

  const { error } = await svc
    .from("rent_buddy_availability")
    .upsert(patch, { onConflict: "buddy_id" });

  if (error) return sendError(res, 'db_error', error.message);
  res.json({ ok: true });
});

// ── Available Now toggle ──────────────────────────────────────────────────────

router.post("/rent-a-buddy/me/available-now", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;
  const buddyProfile = await requireBuddyProfile(svc, auth.user.id);
  if (!buddyProfile) return sendError(res, 'not_found', "Buddy profile not found.");

  const durationMinutes = Number(req.body?.durationMinutes ?? 60);
  const nowMs = Date.now();
  const until = new Date(nowMs + durationMinutes * 60 * 1000).toISOString();

  const { error } = await svc
    .from("rent_buddy_profiles")
    .update({ available_now: true, available_now_until: until, updated_at: new Date(nowMs).toISOString() })
    .eq("id", buddyProfile.id);

  if (error) return sendError(res, 'db_error', error.message);

  // Invalidate the suggested-city cache — buddy availability just changed
  invalidateSuggestedCityCache();

  // Notify waitlisted travelers
  notifyWaitlistedTravelers(svc, buddyProfile).catch(() => {});

  res.json({ ok: true, availableUntil: until });
});

router.delete("/rent-a-buddy/me/available-now", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;
  const buddyProfile = await requireBuddyProfile(svc, auth.user.id);
  if (!buddyProfile) return sendError(res, 'not_found', "Buddy profile not found.");

  const { error } = await svc
    .from("rent_buddy_profiles")
    .update({ available_now: false, available_now_until: null, updated_at: new Date().toISOString() })
    .eq("id", buddyProfile.id);

  if (error) return sendError(res, 'db_error', error.message);

  // Invalidate the suggested-city cache — buddy availability just changed
  invalidateSuggestedCityCache();

  res.json({ ok: true });
});

// ── Waitlist matching notification helper ─────────────────────────────────────

async function notifyWaitlistedTravelers(svc: any, buddyProfile: any) {
  const { data: waitlistRows } = await svc
    .from("rent_buddy_waitlist")
    .select("*")
    .eq("city", buddyProfile.city)
    .eq("status", "active")
    .or(`category.is.null,category.in.(${(buddyProfile.categories ?? []).join(",")})`);

  if (!waitlistRows || (waitlistRows as any[]).length === 0) return;

  const notifyIds = (waitlistRows as any[]).map((w: any) => w.user_id);
  logger.info({ buddyId: buddyProfile.id, city: buddyProfile.city, count: notifyIds.length }, "notifying waitlisted travelers");
}

// ── Request a Buddy ───────────────────────────────────────────────────────────

router.post("/rent-a-buddy/requests", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const svc = sc() ?? auth.client;

  const {
    city, lat, lng, category, desiredDate, desiredTime,
    durationMinutes, groupSize, budgetMinUsd, budgetMaxUsd,
    languageNeeded, energyType, safetyPrefs, paymentModePref, notes,
  } = req.body ?? {};

  if (!city || !category) return sendError(res, 'invalid_payload', "city and category are required.");

  // Reject any non-numeric (but present) coord value — string, boolean, object, etc.
  if (isNonNumericCoord(lat) || isNonNumericCoord(lng)) {
    return sendError(res, 'invalid_payload', "lat and lng must be finite numbers.");
  }
  const latPresent = typeof lat === "number" && Number.isFinite(lat);
  const lngPresent = typeof lng === "number" && Number.isFinite(lng);
  if (latPresent !== lngPresent) {
    return sendError(res, 'invalid_payload', "lat and lng must both be provided together.");
  }

  // Policy scan on notes
  let policyFlag = false;
  let policyFlagReason: string | null = null;
  if (notes && typeof notes === "string") {
    const BLOCKED = [/\bescort\b/i, /\bsex\b/i, /\bprostitut/i, /\bgfe\b/i, /\bhappy.ending/i, /\boff.app\b/i];
    for (const re of BLOCKED) {
      if (re.test(notes)) {
        policyFlag = true;
        policyFlagReason = "policy_violation_in_notes";
        break;
      }
    }
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await svc
    .from("rent_buddy_requests")
    .insert({
      traveler_id: user.id,
      city,
      lat: typeof lat === "number" && Number.isFinite(lat) ? lat : null,
      lng: typeof lng === "number" && Number.isFinite(lng) ? lng : null,
      category,
      desired_date: desiredDate ?? null,
      desired_time: desiredTime ?? null,
      duration_minutes: durationMinutes ?? 120,
      group_size: groupSize ?? 1,
      budget_min_usd: budgetMinUsd ?? null,
      budget_max_usd: budgetMaxUsd ?? null,
      language_needed: languageNeeded ?? null,
      energy_type: energyType ?? null,
      safety_prefs: safetyPrefs ?? {},
      payment_mode_pref: paymentModePref ?? "any",
      notes: notes ?? null,
      policy_flag: policyFlag,
      policy_flag_reason: policyFlagReason,
      status: "open",
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (error) return sendError(res, 'db_error', error.message);

  // Find and notify eligible Buddies
  notifyEligibleBuddies(svc, data as any).catch(() => {});
  emitAnalyticsEvent(svc, "request", { userId: user.id, city, category });

  res.status(201).json({ request: mapRequest(data) });
});

/** Exported for testing. */
export async function notifyEligibleBuddies(svc: any, request: any) {
  const { data: buddies } = await svc
    .from("rent_buddy_profiles")
    .select("id, user_id, expo_push_token")
    .eq("city", request.city)
    .eq("status", "active")
    .eq("admin_status", "active")
    .contains("categories", [request.category]);

  if (!buddies) return;

  // Never notify the traveler about their own request.
  const candidates = (buddies as any[]).filter((b: any) => b.user_id !== request.traveler_id);

  // Respect notification preferences: skip buddies who muted push globally or
  // turned off the rent_buddy category. Uses the shared preference system so
  // quiet hours / global mute / category toggles all apply.
  const prefService = new NotificationPreferenceService(svc);
  const candidateUserIds = candidates.map((b: any) => b.user_id);
  const [prefsByUser, catPrefsByUser] = await Promise.all([
    prefService.getPreferencesForUsers(candidateUserIds),
    prefService.getCategoryPreferenceForUsers(candidateUserIds, "rent_buddy"),
  ]);
  const eligible = candidates.filter((b: any) => {
    const prefs = prefsByUser.get(b.user_id);
    if (!prefs) return true;
    const channels = prefService.filterChannels(
      ["push"],
      prefs,
      catPrefsByUser.get(b.user_id),
      "normal",
      "rent_buddy",
    );
    return channels.includes("push");
  });
  const optedOut = candidates.length - eligible.length;
  if (optedOut > 0) {
    logger.info(
      { requestId: request.id, optedOut },
      "buddy request: buddies skipped by notification preferences",
    );
  }

  const buddyIds = eligible.map((b: any) => b.id);
  if (buddyIds.length > 0) {
    const { error: notifiedErr } = await svc
      .from("rent_buddy_requests")
      .update({ notified_buddy_ids: buddyIds })
      .eq("id", request.id);
    if (notifiedErr) logger.error({ err: notifiedErr, requestId: request.id }, "notified_buddy_ids update failed (best-effort)");
  }

  // Collect push tokens. Buddies who registered their device before the
  // rent_buddy_profiles token backfill existed only have a token on the
  // legacy profiles.expo_push_token column — fall back to it.
  // Track which user each token belongs to so retry-queue rows can be
  // attributed to the right buddy.
  const tokensByUser = new Map<string, string[]>();
  function addToken(userId: string, token: string) {
    const list = tokensByUser.get(userId) ?? [];
    list.push(token);
    tokensByUser.set(userId, list);
  }
  for (const b of eligible) {
    if (b.expo_push_token) addToken(b.user_id, b.expo_push_token);
  }
  const missingUserIds = eligible
    .filter((b: any) => !b.expo_push_token)
    .map((b: any) => b.user_id);
  if (missingUserIds.length > 0) {
    const { data: legacyRows } = await svc
      .from("profiles")
      .select("id, expo_push_token")
      .in("id", missingUserIds);
    for (const p of (legacyRows as any[]) ?? []) {
      if (p.expo_push_token) addToken(p.id, p.expo_push_token);
    }
  }

  if (tokensByUser.size === 0) {
    logger.info({ requestId: request.id, eligible: eligible.length }, "buddy request: no push tokens to notify");
    return;
  }

  const payload = {
    title: `New buddy request in ${request.city}`,
    body: `A traveler is looking for a ${request.category} buddy in ${request.city}. Open the app to send an offer.`,
    data: {
      type: "rent_buddy_request",
      requestId: request.id,
      city: request.city,
      category: request.category,
    },
  };

  const recipients = [...tokensByUser.entries()].map(([userId, tokens]) => ({ userId, tokens }));
  const result = await sendPushWithRetry(svc, recipients, payload);

  logger.info(
    { requestId: request.id, eligible: eligible.length, sent: result.sent },
    "buddy request: push notifications dispatched",
  );
}

router.get("/rent-a-buddy/requests/:requestId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;
  const { requestId } = req.params;

  const { data, error } = await svc
    .from("rent_buddy_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle();

  if (error) return sendError(res, 'db_error', error.message);
  if (!data) return sendError(res, 'not_found', "Request not found.");

  const req_ = data as any;
  if (req_.traveler_id !== auth.user.id) {
    // Non-owners can only see open requests
    if (req_.status !== "open") return sendError(res, 'not_found', "Request not found.");
  }

  res.json({ request: mapRequest(data) });
});

router.get("/rent-a-buddy/me/matching-requests", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;
  const buddyProfile = await requireBuddyProfile(svc, auth.user.id);
  if (!buddyProfile) return sendError(res, 'not_found', "Buddy profile not found.");

  const { data, error } = await svc
    .from("rent_buddy_requests")
    .select("*")
    .eq("city", buddyProfile.city)
    .eq("status", "open")
    .in("category", buddyProfile.categories ?? [])
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return sendError(res, 'db_error', error.message);
  res.json({ requests: (data ?? []).map(mapRequest) });
});

// ── Offers ────────────────────────────────────────────────────────────────────

router.post("/rent-a-buddy/requests/:requestId/offers", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const svc = sc() ?? auth.client;

  const buddyProfile = await requireBuddyProfile(svc, user.id);
  if (!buddyProfile) return sendError(res, 'forbidden', "Active Buddy profile required.");

  const { requestId } = req.params;
  const { data: requestRow } = await svc
    .from("rent_buddy_requests")
    .select("*")
    .eq("id", requestId)
    .eq("status", "open")
    .maybeSingle();

  if (!requestRow) return sendError(res, 'not_found', "Request not found or no longer open.");

  const req_ = requestRow as any;
  if (req_.traveler_id === user.id) return sendError(res, 'invalid_payload', "Cannot offer on your own request.");

  const {
    proposedPriceUsd, depositAmountUsd, cashBalanceDue,
    proposedStart, proposedEnd, meetupLocation, message,
    includedServices, addonsOffered, paymentMode, expiresInHours,
  } = req.body ?? {};

  if (!proposedPriceUsd) return sendError(res, 'invalid_payload', "proposedPriceUsd is required.");

  const expiresAt = new Date(
    Date.now() + (expiresInHours ?? 12) * 60 * 60 * 1000
  ).toISOString();

  const { data, error } = await svc
    .from("rent_buddy_offers")
    .insert({
      request_id: requestId,
      buddy_profile_id: buddyProfile.id,
      buddy_user_id: user.id,
      proposed_price_usd: proposedPriceUsd,
      deposit_amount_usd: depositAmountUsd ?? 0,
      cash_balance_usd: cashBalanceDue ?? 0,
      proposed_start: proposedStart ?? null,
      proposed_end: proposedEnd ?? null,
      meetup_location: meetupLocation ?? null,
      message: message ?? null,
      included_services: includedServices ?? [],
      addons_offered: addonsOffered ?? [],
      payment_mode: paymentMode ?? "full_in_app",
      expires_at: expiresAt,
      status: "pending",
    })
    .select()
    .single();

  if (error) return sendError(res, 'db_error', error.message);
  emitAnalyticsEvent(svc, "offer_sent", { userId: user.id, buddyId: buddyProfile.id, city: req_.city, category: req_.category, amountUsd: Number(proposedPriceUsd) });
  res.status(201).json({ offer: mapOffer(data) });
});

router.get("/rent-a-buddy/requests/:requestId/offers", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;
  const { requestId } = req.params;

  // Only traveler who owns the request can view all offers
  const { data: requestRow } = await svc
    .from("rent_buddy_requests")
    .select("traveler_id")
    .eq("id", requestId)
    .maybeSingle();

  if (!requestRow || (requestRow as any).traveler_id !== auth.user.id) {
    return sendError(res, 'forbidden', "Not authorized to view offers for this request.");
  }

  const { data, error } = await svc
    .from("rent_buddy_offers")
    .select("*, buddy:rent_buddy_profiles(id, display_name, tagline, average_rating, verified, buddy_level, cover_photo_url)")
    .eq("request_id", requestId)
    .order("created_at", { ascending: false });

  if (error) return sendError(res, 'db_error', error.message);

  const offers = (data ?? []).map((o: any) => ({
    ...mapOffer(o),
    buddy: o.buddy ? mapProfile(o.buddy) : null,
  }));

  res.json({ offers });
});

router.get("/rent-a-buddy/me/offers", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;

  const { data, error } = await svc
    .from("rent_buddy_offers")
    .select("*")
    .eq("buddy_user_id", auth.user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return sendError(res, 'db_error', error.message);
  res.json({ offers: (data ?? []).map(mapOffer) });
});

router.post("/rent-a-buddy/offers/:offerId/accept", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const svc = sc() ?? auth.client;

  // Booking-creation gate stack. Accepting an offer INSERTs a
  // rent_buddy_bookings row, so this is a creation path and takes the same
  // gates as POST /rent-a-buddy/bookings — it previously had none of them, not
  // even the admin user-limits check its package-book sibling performs.
  // Wiring action "offer-accept" also revives the rollout branch at
  // rentABuddyRollout.ts:270-280, which was dead because no caller passed it,
  // so RENT_BUDDY_OFFERS_ENABLED gated nothing.
  if (!await requireBookingKyc(svc, res)) return;
  if (await isKillSwitchEngaged(svc, 'disable_rent_buddy_booking')
      || await isKillSwitchEngaged(svc, 'disable_rab_bookings')) {
    return res.status(404).json({ error: 'feature_disabled', message: 'Rent-a-Buddy bookings are temporarily disabled' });
  }

  const { offerId } = req.params;
  const { data: offer, error: offerErr } = await svc
    .from("rent_buddy_offers")
    .select("*, request:rent_buddy_requests(*)")
    .eq("id", offerId)
    .maybeSingle();

  if (offerErr || !offer) return sendError(res, 'not_found', "Offer not found.");
  const o = offer as any;
  if (o.status !== "pending") return sendError(res, 'invalid_payload', `Offer is already ${o.status}.`);
  if (o.request.traveler_id !== user.id) return sendError(res, 'forbidden', "Only the traveler can accept offers.");

  // City/category rollout + admin user limits. Deferred to here rather than the
  // top of the handler because both values live on the offer's parent request,
  // so they are not knowable until the offer has been loaded.
  const offerAccess = await checkRentBuddyAccess({
    sc: svc, userId: user.id,
    city: o.request.city, category: o.request.category,
    action: "offer-accept",
  });
  if (!offerAccess.allowed) {
    return res.status(offerAccess.httpStatus).json({ error: offerAccess.code, message: offerAccess.message });
  }

  const offerLimits = await getUserLimits(svc, user.id);
  if (offerLimits?.rent_buddy_disabled || offerLimits?.traveler_booking_disabled) {
    return res.status(403).json({
      error: "access_limited",
      message: "Rent a Buddy access is limited while your account is under review.",
    });
  }

  const now = new Date().toISOString();
  if (o.expires_at && new Date(o.expires_at) < new Date()) {
    const { error: expireErr } = await svc.from("rent_buddy_offers").update({ status: "expired" }).eq("id", offerId);
    if (expireErr) logger.error({ err: expireErr, offerId }, "offer expire status write failed (best-effort)");
    return sendError(res, 'invalid_payload', "Offer has expired.");
  }

  // Create booking from offer
  const { data: booking, error: bkErr } = await svc
    .from("rent_buddy_bookings")
    .insert({
      buddy_id: o.buddy_profile_id,
      traveler_id: user.id,
      booking_date: o.proposed_start ? new Date(o.proposed_start).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      start_time: o.proposed_start ? new Date(o.proposed_start).toTimeString().slice(0, 5) : null,
      duration_h: o.proposed_end && o.proposed_start
        ? (new Date(o.proposed_end).getTime() - new Date(o.proposed_start).getTime()) / 3600000
        : 2,
      group_size: o.request.group_size ?? 1,
      city: o.request.city,
      category: o.request.category,
      notes: o.message,
      payment_mode: o.payment_mode,
      total_usd: o.proposed_price_usd,
      deposit_usd: o.deposit_amount_usd,
      cash_balance_usd: o.cash_balance_usd,
      status: "pending",
      offer_id: offerId,
      request_id: o.request_id,
    })
    .select()
    .single();

  if (bkErr) return sendError(res, 'db_error', bkErr.message);

  const bk = booking as any;

  // Mark offer accepted, decline others
  const { error: acceptErr } = await svc.from("rent_buddy_offers").update({ status: "accepted", accepted_booking_id: bk.id, updated_at: now }).eq("id", offerId);
  if (acceptErr) return sendError(res, 'db_error', acceptErr.message);
  // Best-effort cascades: the acceptance itself is committed — log, don't fail the response.
  const { error: declineOthersErr } = await svc.from("rent_buddy_offers")
    .update({ status: "declined", updated_at: now })
    .eq("request_id", o.request_id)
    .neq("id", offerId)
    .eq("status", "pending");
  if (declineOthersErr) logger.error({ err: declineOthersErr, offerId }, "declining sibling offers failed (best-effort)");

  // Close request
  const { error: closeReqErr } = await svc.from("rent_buddy_requests").update({ status: "matched", updated_at: now }).eq("id", o.request_id);
  if (closeReqErr) logger.error({ err: closeReqErr, requestId: o.request_id }, "closing matched request failed (best-effort)");

  // Create earnings ledger entry
  await createEarningsLedgerEntry(svc, bk, o.buddy_profile_id).catch(() => {});
  emitAnalyticsEvent(svc, "offer_accepted", { userId: user.id, buddyId: o.buddy_profile_id, city: o.request.city, category: o.request.category, amountUsd: Number(o.proposed_price_usd) });

  res.json({ booking: bk, bookingId: bk.id });
});

router.post("/rent-a-buddy/offers/:offerId/decline", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;
  const { offerId } = req.params;

  const { data: offer } = await svc.from("rent_buddy_offers").select("*, request:rent_buddy_requests(traveler_id)").eq("id", offerId).maybeSingle();
  if (!offer) return sendError(res, 'not_found', "Offer not found.");
  const o = offer as any;
  if (o.request.traveler_id !== auth.user.id) return sendError(res, 'forbidden', "Only the traveler can decline offers.");

  const { error: declineErr } = await svc.from("rent_buddy_offers").update({ status: "declined", updated_at: new Date().toISOString() }).eq("id", offerId);
  if (declineErr) return sendError(res, 'db_error', declineErr.message);
  emitAnalyticsEvent(svc, "offer_declined", { userId: auth.user.id });
  res.json({ ok: true });
});

router.post("/rent-a-buddy/offers/:offerId/withdraw", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;
  const { offerId } = req.params;

  const { data: offer } = await svc.from("rent_buddy_offers").select("buddy_user_id").eq("id", offerId).maybeSingle();
  if (!offer) return sendError(res, 'not_found', "Offer not found.");
  if ((offer as any).buddy_user_id !== auth.user.id) return sendError(res, 'forbidden', "Only the Buddy can withdraw their offer.");

  const { error: withdrawErr } = await svc.from("rent_buddy_offers").update({ status: "withdrawn", updated_at: new Date().toISOString() }).eq("id", offerId);
  if (withdrawErr) return sendError(res, 'db_error', withdrawErr.message);
  res.json({ ok: true });
});

// ── Packages (v2) ─────────────────────────────────────────────────────────────

router.post("/rent-a-buddy/me/packages/v2", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;
  const buddyProfile = await requireBuddyProfile(svc, auth.user.id);
  if (!buddyProfile) return sendError(res, 'forbidden', "Active Buddy profile required.");

  const {
    title, description, category, city, durationH, priceUsd,
    maxGroup, depositRequired, depositPercent, paymentModesAllowed,
    includedStops, includedServices, addonIds, isActive,
  } = req.body ?? {};

  if (!title || !category || !priceUsd) return sendError(res, 'invalid_payload', "title, category, priceUsd required.");
  { const p = Number(priceUsd); if (!Number.isFinite(p) || p <= 0 || p > 100000) return sendError(res, 'invalid_payload', "priceUsd must be a positive number up to 100000."); }  // API-07

  const needsAdminReview = category === "nightlife" || category === "arrival" || (maxGroup ?? 1) > 4;
  const adminStatus = needsAdminReview ? "pending" : "approved";

  const { data, error } = await svc
    .from("rent_buddy_packages")
    .insert({
      buddy_id: buddyProfile.id,
      title,
      description: description ?? null,
      category,
      city: city ?? buddyProfile.city,
      duration_h: durationH ?? 2,
      price_usd: priceUsd,
      max_group: maxGroup ?? 1,
      is_active: isActive ?? true,
      deposit_required: depositRequired ?? true,
      deposit_percent: depositPercent ?? 20,
      payment_modes_allowed: paymentModesAllowed ?? ["full_in_app"],
      included_stops: includedStops ?? [],
      included_services: includedServices ?? [],
      addon_ids: addonIds ?? [],
      admin_review_status: adminStatus,
    })
    .select()
    .single();

  if (error) return sendError(res, 'db_error', error.message);
  res.status(201).json({ pkg: mapPackage(data), requiresAdminReview: needsAdminReview });
});

router.patch("/rent-a-buddy/me/packages/v2/:packageId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;
  const buddyProfile = await requireBuddyProfile(svc, auth.user.id);
  if (!buddyProfile) return sendError(res, 'forbidden', "Active Buddy profile required.");

  const { packageId } = req.params;
  const { data: existing } = await svc
    .from("rent_buddy_packages")
    .select("id, buddy_id")
    .eq("id", packageId)
    .eq("buddy_id", buddyProfile.id)
    .maybeSingle();

  if (!existing) return sendError(res, 'not_found', "Package not found.");

  const {
    title, description, priceUsd, maxGroup, isActive,
    depositRequired, depositPercent, paymentModesAllowed,
    includedStops, includedServices, addonIds,
  } = req.body ?? {};

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (title !== undefined) patch.title = title;
  if (description !== undefined) patch.description = description;
  if (priceUsd !== undefined) patch.price_usd = priceUsd;
  if (maxGroup !== undefined) patch.max_group = maxGroup;
  if (isActive !== undefined) patch.is_active = isActive;
  if (depositRequired !== undefined) patch.deposit_required = depositRequired;
  if (depositPercent !== undefined) patch.deposit_percent = depositPercent;
  if (paymentModesAllowed !== undefined) patch.payment_modes_allowed = paymentModesAllowed;
  if (includedStops !== undefined) patch.included_stops = includedStops;
  if (includedServices !== undefined) patch.included_services = includedServices;
  if (addonIds !== undefined) patch.addon_ids = addonIds;

  const { data, error } = await svc
    .from("rent_buddy_packages")
    .update(patch)
    .eq("id", packageId)
    .select()
    .single();

  if (error) return sendError(res, 'db_error', error.message);
  res.json({ pkg: mapPackage(data) });
});

router.get("/rent-a-buddy/buddies/:buddyId/packages", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;

  const { data, error } = await svc
    .from("rent_buddy_packages")
    .select("*")
    .eq("buddy_id", req.params.buddyId)
    .eq("is_active", true)
    .eq("admin_review_status", "approved");

  if (error) return sendError(res, 'db_error', error.message);
  res.json({ packages: (data ?? []).map(mapPackage) });
});

router.get("/rent-a-buddy/packages/:packageId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;

  const { data, error } = await svc
    .from("rent_buddy_packages")
    .select("*, stops:rent_buddy_package_stops(*)")
    .eq("id", req.params.packageId)
    .maybeSingle();

  if (error || !data) return sendError(res, 'not_found', "Package not found.");
  res.json({ pkg: { ...mapPackage(data), stops: (data as any).stops ?? [] } });
});

router.post("/rent-a-buddy/packages/:packageId/book", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const svc = sc() ?? auth.client;

  // Booking-creation gate stack — see the offer-accept handler above. This path
  // checked rent_buddy_user_limits but nothing else: no KYC, no kill switches,
  // no rollout. Wiring action "package-book" also revives the dead branch at
  // rentABuddyRollout.ts:257-267, so RENT_BUDDY_PACKAGES_ENABLED (seeded false
  // in migrations/0090) finally gates something.
  if (!await requireBookingKyc(svc, res)) return;
  if (await isKillSwitchEngaged(svc, 'disable_rent_buddy_booking')
      || await isKillSwitchEngaged(svc, 'disable_rab_bookings')) {
    return res.status(404).json({ error: 'feature_disabled', message: 'Rent-a-Buddy bookings are temporarily disabled' });
  }

  const { data: pkg } = await svc
    .from("rent_buddy_packages")
    .select("*, buddy:rent_buddy_profiles(*)")
    .eq("id", req.params.packageId)
    .eq("is_active", true)
    .maybeSingle();

  if (!pkg) return sendError(res, 'not_found', "Package not found.");
  const p = pkg as any;
  if (p.admin_review_status !== "approved") return sendError(res, 'forbidden', "Package is pending admin review.");

  const { groupSize = 1, bookingDate, notes, paymentMode } = req.body ?? {};

  // Group size check
  if (groupSize > (p.max_group ?? 1)) return sendError(res, 'invalid_payload', `Max group size for this package is ${p.max_group}.`);

  const buddy = p.buddy;
  if (!buddy || buddy.status !== "active") return sendError(res, 'invalid_payload', "Buddy is not available.");
  if (groupSize > 1 && !buddy.group_approved) return sendError(res, 'invalid_payload', "This Buddy is not approved for group bookings.");

  // City/category rollout. Placed here because both values come off the loaded
  // package and its buddy, so they are not knowable at the top of the handler.
  // The existing user-limits check below is left as-is: it already performs the
  // same restriction lookup inline, and duplicating it via getUserLimits would
  // add a query without changing behaviour.
  const pkgAccess = await checkRentBuddyAccess({
    sc: svc, userId: user.id,
    city: buddy.city, category: p.category,
    action: "package-book", groupSize,
  });
  if (!pkgAccess.allowed) {
    return res.status(pkgAccess.httpStatus).json({ error: pkgAccess.code, message: pkgAccess.message });
  }

  // User limits
  const { data: limits } = await svc.from("rent_buddy_user_limits").select("*").eq("user_id", user.id).maybeSingle();
  const l = limits as any;
  if (l?.rent_buddy_disabled || l?.traveler_booking_disabled) return sendError(res, 'forbidden', "Booking is currently disabled for your account.");

  // Calculate deposit
  const { data: travellerHistory } = await svc
    .from("rent_buddy_bookings")
    .select("id")
    .eq("traveler_id", user.id)
    .eq("status", "completed");

  const completedCount = (travellerHistory ?? []).length;

  const depositResult = calculateDeposit({
    category: p.category,
    pricingType: "package",
    buddyLevel: buddy.buddy_level,
    travelerCompletedBookings: completedCount,
    travelerId: user.id,
    isGroupBooking: groupSize > 1,
    cashBalanceDisabled: l?.cash_balance_disabled ?? false,
    fullInAppRequired: l?.full_in_app_payment_required ?? false,
    disableDepositCash: buddy.disable_deposit_cash ?? false,
    buddyCashBalanceAccepted: buddy.cash_balance_accepted ?? true,
    riskHold: buddy.risk_hold ?? false,
    totalUsd: Number(p.price_usd),
  });

  const expiresAt = getBookingExpiresAt(bookingDate ?? new Date().toISOString().slice(0, 10), buddy.available_now ?? false);

  const { data: booking, error: bkErr } = await svc
    .from("rent_buddy_bookings")
    .insert({
      buddy_id: buddy.id,
      traveler_id: user.id,
      package_id: p.id,
      booking_date: bookingDate ?? new Date().toISOString().slice(0, 10),
      duration_h: p.duration_h,
      group_size: groupSize,
      city: buddy.city,
      category: p.category,
      notes: notes ?? null,
      payment_mode: depositResult.paymentMode,
      total_usd: p.price_usd,
      deposit_usd: depositResult.depositUsd,
      cash_balance_usd: depositResult.cashBalanceDue,
      pricing_type: "package",
      deposit_rule_applied: depositResult.depositRuleApplied,
      deposit_percent: depositResult.depositPercent,
      deposit_reason: depositResult.depositReason,
      is_group_booking: groupSize > 1,
      expires_at: expiresAt.toISOString(),
      status: "pending",
    })
    .select()
    .single();

  if (bkErr) return sendError(res, 'db_error', bkErr.message);
  await createEarningsLedgerEntry(svc, booking as any, buddy.id).catch(() => {});
  emitAnalyticsEvent(svc, "booking", { userId: user.id, buddyId: buddy.id, city: buddy.city, category: p.category, amountUsd: Number(p.price_usd) });

  res.status(201).json({ booking });
});

// ── Add-ons ───────────────────────────────────────────────────────────────────

router.get("/rent-a-buddy/buddies/:buddyId/addons", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;

  const { data, error } = await svc
    .from("rent_buddy_addons")
    .select("*")
    .eq("buddy_id", req.params.buddyId)
    .eq("is_active", true)
    .eq("admin_approved", true);

  if (error) return sendError(res, 'db_error', error.message);
  res.json({ addons: data ?? [] });
});

router.post("/rent-a-buddy/me/addons", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;
  const buddyProfile = await requireBuddyProfile(svc, auth.user.id);
  if (!buddyProfile) return sendError(res, 'forbidden', "Active Buddy profile required.");

  const { title, description, priceUsd, category, requiresAdminApproval } = req.body ?? {};
  if (!title || priceUsd == null) return sendError(res, 'invalid_payload', "title and priceUsd required.");

  const needsApproval = requiresAdminApproval ?? false;

  const { data, error } = await svc
    .from("rent_buddy_addons")
    .insert({
      buddy_id: buddyProfile.id,
      title,
      description: description ?? null,
      price_usd: priceUsd,
      category: category ?? null,
      is_active: true,
      requires_admin_approval: needsApproval,
      admin_approved: !needsApproval,
    })
    .select()
    .single();

  if (error) return sendError(res, 'db_error', error.message);
  res.status(201).json({ addon: data });
});

router.patch("/rent-a-buddy/me/addons/:addonId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;
  const buddyProfile = await requireBuddyProfile(svc, auth.user.id);
  if (!buddyProfile) return sendError(res, 'forbidden', "Active Buddy profile required.");

  const { addonId } = req.params;
  const patch: Record<string, unknown> = {};
  const { title, description, priceUsd, isActive } = req.body ?? {};
  if (title !== undefined) patch.title = title;
  if (description !== undefined) patch.description = description;
  if (priceUsd !== undefined) patch.price_usd = priceUsd;
  if (isActive !== undefined) patch.is_active = isActive;

  const { data, error } = await svc
    .from("rent_buddy_addons")
    .update(patch)
    .eq("id", addonId)
    .eq("buddy_id", buddyProfile.id)
    .select()
    .single();

  if (error) return sendError(res, 'db_error', error.message);
  res.json({ addon: data });
});

router.post("/rent-a-buddy/bookings/:bookingId/addons", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const svc = sc() ?? auth.client;

  const { bookingId } = req.params;
  const { data: booking } = await svc
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return sendError(res, 'not_found', "Booking not found.");
  const bk = booking as any;
  if (bk.traveler_id !== user.id) return sendError(res, 'forbidden', "Only the traveler can attach add-ons.");
  if (!["pending", "confirmed"].includes(bk.status)) return sendError(res, 'invalid_payload', "Add-ons can only be attached to pending or confirmed bookings.");

  const { addonIds } = req.body ?? {};
  if (!Array.isArray(addonIds) || addonIds.length === 0) return sendError(res, 'invalid_payload', "addonIds array required.");

  // Load addons
  const { data: addons } = await svc
    .from("rent_buddy_addons")
    .select("*")
    .in("id", addonIds)
    .eq("is_active", true);

  const addonRows = (addons ?? []) as any[];
  if (addonRows.length === 0) return sendError(res, 'invalid_payload', "No valid add-ons found.");

  const addonsTotal = addonRows.reduce((sum: number, a: any) => sum + Number(a.price_usd ?? 0), 0);

  // Insert booking addons
  const inserts = addonRows.map((a: any) => ({
    booking_id: bookingId,
    addon_id: a.id,
    title: a.title,
    price_usd: a.price_usd,
  }));
  const { error: addonInsErr } = await svc.from("rent_buddy_booking_addons").insert(inserts);
  if (addonInsErr) return sendError(res, 'db_error', addonInsErr.message);

  // Recalculate total + deposit
  const newTotal = Number(bk.total_usd) + addonsTotal;
  const { data: limits } = await svc.from("rent_buddy_user_limits").select("*").eq("user_id", user.id).maybeSingle();
  const { data: buddyRow } = await svc.from("rent_buddy_profiles").select("*").eq("id", bk.buddy_id).maybeSingle();

  const depositResult = calculateDeposit({
    category: bk.category,
    pricingType: bk.pricing_type ?? "hourly",
    buddyLevel: (buddyRow as any)?.buddy_level ?? "new",
    travelerCompletedBookings: 0,
    travelerId: user.id,
    isGroupBooking: bk.is_group_booking ?? false,
    cashBalanceDisabled: (limits as any)?.cash_balance_disabled ?? false,
    fullInAppRequired: (limits as any)?.full_in_app_payment_required ?? false,
    disableDepositCash: (buddyRow as any)?.disable_deposit_cash ?? false,
    buddyCashBalanceAccepted: (buddyRow as any)?.cash_balance_accepted ?? true,
    riskHold: (buddyRow as any)?.risk_hold ?? false,
    totalUsd: newTotal,
  });

  const { error: totalsErr } = await svc
    .from("rent_buddy_bookings")
    .update({
      total_usd: newTotal,
      deposit_usd: depositResult.depositUsd,
      cash_balance_usd: depositResult.cashBalanceDue,
      addons_total_usd: (Number(bk.addons_total_usd ?? 0) + addonsTotal),
      payment_mode: depositResult.paymentMode,
      deposit_rule_applied: depositResult.depositRuleApplied,
      deposit_percent: depositResult.depositPercent,
      deposit_reason: depositResult.depositReason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", bookingId);
  if (totalsErr) return sendError(res, 'db_error', totalsErr.message);

  emitAnalyticsEvent(svc, "addon_attached", { userId: user.id, city: bk.city, category: bk.category, amountUsd: addonsTotal });

  res.json({ ok: true, newTotal, depositUsd: depositResult.depositUsd, cashBalanceDue: depositResult.cashBalanceDue, addonsAdded: addonRows.length });
});

// ── Tips ──────────────────────────────────────────────────────────────────────

router.post("/rent-a-buddy/bookings/:bookingId/tip", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const svc = sc() ?? auth.client;

  const { bookingId } = req.params;
  const { data: booking } = await svc
    .from("rent_buddy_bookings")
    .select("*, buddy:rent_buddy_profiles(user_id, city, buddy_level)")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return sendError(res, 'not_found', "Booking not found.");
  const bk = booking as any;
  if (bk.traveler_id !== user.id) return sendError(res, 'forbidden', "Only the traveler can leave a tip.");
  if (bk.status !== "completed") return sendError(res, 'invalid_payload', "Tips are only allowed after a completed booking.");

  const { amountUsd, note } = req.body ?? {};
  if (!amountUsd || Number(amountUsd) <= 0) return sendError(res, 'invalid_payload', "amountUsd must be positive.");
  if (![5, 10, 20].includes(Number(amountUsd)) && Number(amountUsd) > 200) {
    return sendError(res, 'invalid_payload', "Maximum tip amount is $200.");
  }

  const { error } = await svc
    .from("rent_buddy_tips")
    .upsert({
      booking_id: bookingId,
      traveler_id: user.id,
      buddy_user_id: bk.buddy.user_id,
      amount_usd: amountUsd,
      note: note ?? null,
    }, { onConflict: "booking_id" });

  if (error) return sendError(res, 'db_error', error.message);

  // Update ledger with tip (best-effort: the tip row itself is committed — log only)
  const { error: ledgerTipErr } = await svc
    .from("rent_buddy_earnings_ledger")
    .update({ tip_usd: amountUsd, updated_at: new Date().toISOString() })
    .eq("booking_id", bookingId);
  if (ledgerTipErr) logger.error({ err: ledgerTipErr, bookingId }, "ledger tip update failed (best-effort)");

  // Update booking tip field (best-effort denormalised copy)
  const { error: bookingTipErr } = await svc.from("rent_buddy_bookings").update({ tip_usd: amountUsd, updated_at: new Date().toISOString() }).eq("id", bookingId);
  if (bookingTipErr) logger.error({ err: bookingTipErr, bookingId }, "booking tip update failed (best-effort)");

  emitAnalyticsEvent(svc, "tip_sent", { userId: user.id, buddyId: bk.buddy_id, city: bk.buddy?.city, category: bk.category, amountUsd: Number(amountUsd) });

  res.json({ ok: true });
});

// ── Saved Buddies (enhanced) ──────────────────────────────────────────────────

router.post("/rent-a-buddy/buddies/:buddyId/save", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;
  const { notes } = req.body ?? {};

  const { error } = await svc
    .from("rent_buddy_saved")
    .upsert({
      user_id: auth.user.id,
      buddy_id: req.params.buddyId,
      notes: notes ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,buddy_id" });

  if (error) return sendError(res, 'db_error', error.message);
  await syncFavoritesCount(svc, req.params.buddyId);
  res.json({ ok: true });
});

router.delete("/rent-a-buddy/buddies/:buddyId/save", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;

  const { error: unsaveErr } = await svc.from("rent_buddy_saved").delete().eq("user_id", auth.user.id).eq("buddy_id", req.params.buddyId);
  if (unsaveErr) return sendError(res, 'db_error', unsaveErr.message);
  await syncFavoritesCount(svc, req.params.buddyId);
  res.json({ ok: true });
});

router.get("/rent-a-buddy/me/saved-buddies", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;

  const { data, error } = await svc
    .from("rent_buddy_saved")
    .select("*, buddy:rent_buddy_profiles(*)")
    .eq("user_id", auth.user.id)
    .order("updated_at", { ascending: false });

  if (error) return sendError(res, 'db_error', error.message);

  const results = (data ?? []).map((row: any) => ({
    buddyId: row.buddy_id,
    notes: row.notes,
    savedAt: row.created_at,
    updatedAt: row.updated_at,
    buddy: mapProfile(row.buddy),
  }));

  res.json({ saved: results });
});

router.post("/rent-a-buddy/buddies/:buddyId/book-again", async (req, res) => {
  // Forward to /bookings creation with buddy pre-filled
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;
  const { buddyId } = req.params;

  const { data: buddyRow } = await svc
    .from("rent_buddy_profiles")
    .select("*")
    .eq("id", buddyId)
    .eq("status", "active")
    .maybeSingle();

  if (!buddyRow) return sendError(res, 'not_found', "Buddy not found or unavailable.");

  const { category, durationH, bookingDate, notes } = req.body ?? {};
  const bud = buddyRow as any;

  res.json({
    suggestion: {
      buddyId: bud.id,
      buddyName: bud.display_name,
      city: bud.city,
      suggestedCategory: category ?? (bud.categories ?? [])[0] ?? "city",
      suggestedDurationH: durationH ?? 2,
      bookingDate: bookingDate ?? null,
      notes: notes ?? null,
      hourlyRateUsd: bud.hourly_rate_usd ? Number(bud.hourly_rate_usd) : null,
    },
    message: "Ready to book. Submit to /api/rent-a-buddy/bookings to confirm.",
  });
});

// ── Waitlist (v2) ─────────────────────────────────────────────────────────────

router.post("/rent-a-buddy/waitlist/v2", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;

  const {
    city, lat, lng, category, language, budgetMaxUsd,
    desiredDate, desiredTime, notes, groupSize, expiryDays,
  } = req.body ?? {};

  if (!city) return sendError(res, 'invalid_payload', "city is required.");

  // Reject any non-numeric (but present) coord value — string, boolean, object, etc.
  if (isNonNumericCoord(lat) || isNonNumericCoord(lng)) {
    return sendError(res, 'invalid_payload', "lat and lng must be finite numbers.");
  }
  const latPresent = typeof lat === "number" && Number.isFinite(lat);
  const lngPresent = typeof lng === "number" && Number.isFinite(lng);
  if (latPresent !== lngPresent) {
    return sendError(res, 'invalid_payload', "lat and lng must both be provided together.");
  }

  const expires = expiryDays
    ? new Date(Date.now() + Number(expiryDays) * 24 * 60 * 60 * 1000).toISOString()
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await svc
    .from("rent_buddy_waitlist")
    .upsert({
      user_id: auth.user.id,
      city,
      lat: typeof lat === "number" && Number.isFinite(lat) ? lat : null,
      lng: typeof lng === "number" && Number.isFinite(lng) ? lng : null,
      category: category ?? null,
      language: language ?? null,
      budget_max_usd: budgetMaxUsd ?? null,
      desired_date: desiredDate ?? null,
      desired_time: desiredTime ?? null,
      notes: notes ?? null,
      group_size: groupSize ?? 1,
      status: "active",
      expires_at: expires,
    }, { onConflict: "user_id,city" })
    .select()
    .single();

  if (error) return sendError(res, 'db_error', error.message);
  emitAnalyticsEvent(svc, "waitlist_join", { userId: auth.user.id, city, category: category ?? null });
  res.status(201).json({ entry: data });
});

router.get("/rent-a-buddy/me/waitlist/v2", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;

  const { data, error } = await svc
    .from("rent_buddy_waitlist")
    .select("*")
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false });

  if (error) return sendError(res, 'db_error', error.message);
  res.json({ waitlist: data ?? [] });
});

router.delete("/rent-a-buddy/waitlist/:waitlistId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;

  const { error: waitlistErr } = await svc
    .from("rent_buddy_waitlist")
    .update({ status: "cancelled" })
    .eq("id", req.params.waitlistId)
    .eq("user_id", auth.user.id);
  if (waitlistErr) return sendError(res, 'db_error', waitlistErr.message);

  res.json({ ok: true });
});

// ── Pricing suggestion ────────────────────────────────────────────────────────

router.get("/rent-a-buddy/pricing/suggestion", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const {
    city = "Unknown",
    category = "city",
    durationMinutes = "120",
    buddyLevel = "new",
    groupSize = "1",
    pricingType = "hourly",
  } = req.query as Record<string, string>;

  const result = getPricingSuggestion(
    city, category, Number(durationMinutes), buddyLevel, Number(groupSize), pricingType
  );
  res.json(result);
});

// ── Earnings ──────────────────────────────────────────────────────────────────

router.get("/rent-a-buddy/me/earnings/summary", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;

  const buddyProfile = await requireBuddyProfile(svc, auth.user.id);
  if (!buddyProfile) return sendError(res, 'not_found', "Buddy profile not found.");

  const today = new Date().toISOString().slice(0, 10);

  const [bookingsRes, tipsRes, ledgerRes, trustRes] = await Promise.all([
    svc.from("rent_buddy_bookings")
      .select("id, status, total_usd, deposit_usd, cash_balance_usd, cash_balance_confirmed_by_buddy, booking_date, category, city, duration_h, tip_usd, pricing_type")
      .eq("buddy_id", buddyProfile.id),
    svc.from("rent_buddy_tips")
      .select("amount_usd")
      .eq("buddy_user_id", auth.user.id),
    svc.from("rent_buddy_earnings_ledger")
      .select("*")
      .eq("buddy_user_id", auth.user.id),
    svc.from("trust_profiles")
      .select("overall_score, public_level")
      .eq("user_id", auth.user.id)
      .maybeSingle(),
  ]);

  const bookings = (bookingsRes.data ?? []) as any[];
  const tips = (tipsRes.data ?? []) as any[];
  const ledger = (ledgerRes.data ?? []) as any[];

  const todayBkgs = bookings.filter((b) => b.booking_date === today);
  const upcoming = bookings.filter((b) => b.booking_date > today && ["pending", "confirmed"].includes(b.status));
  const completed = bookings.filter((b) => b.status === "completed");
  const disputed = bookings.filter((b) => b.status === "disputed");
  const cancelled = bookings.filter((b) => b.status === "cancelled");

  const sum = (arr: any[], key: string) => arr.reduce((s, r) => s + Number(r[key] ?? 0), 0);

  const totalTips = sum(tips, "amount_usd");
  const completedTotal = sum(completed, "total_usd");
  const depositCollected = sum(completed, "deposit_usd");
  const cashBalanceDue = completed
    .filter((b) => b.cash_balance_confirmed_by_buddy !== true)
    .reduce((s, b) => s + Number(b.cash_balance_usd ?? 0), 0);
  const cashBalanceConfirmed = completed
    .filter((b) => b.cash_balance_confirmed_by_buddy === true)
    .reduce((s, b) => s + Number(b.cash_balance_usd ?? 0), 0);

  // Platform fee estimate
  const ledgerEntry = ledger[0];
  const defaultFeePercent = 22;
  const feePercent = ledgerEntry?.platform_fee_percent ?? defaultFeePercent;
  const estimatedPlatformFee = Math.round(completedTotal * feePercent / 100 * 100) / 100;
  const estimatedBuddyEarnings = Math.round((completedTotal - estimatedPlatformFee) * 100) / 100;

  res.json({
    isEstimated: true,
    warning: "All figures are estimates. Cash balance is tracked but not charged. Payout system not connected.",
    today: {
      bookingCount: todayBkgs.length,
      bookings: todayBkgs,
    },
    upcoming: {
      bookingCount: upcoming.length,
      bookings: upcoming,
    },
    completed: {
      count: completed.length,
      totalUsd: completedTotal,
      depositCollected,
      cashBalanceDue,
      cashBalanceConfirmed,
      inAppAmountCollected: depositCollected,
    },
    tips: { total: totalTips, count: tips.length },
    estimatedPlatformFeeUsd: estimatedPlatformFee,
    estimatedBuddyEarningsUsd: estimatedBuddyEarnings,
    statusBreakdown: {
      completed: completed.length,
      disputed: disputed.length,
      cancelled: cancelled.length,
    },
    trustScore: (trustRes.data as any)?.overall_score ?? null,
    trustLevel: (trustRes.data as any)?.public_level ?? null,
    profileViews: buddyProfile.profile_views ?? 0,
    searchAppearances: buddyProfile.search_appearances ?? 0,
    repeatClientCount: buddyProfile.repeat_client_count ?? 0,
    cityRanking: buddyProfile.city_ranking ?? null,
    averageRating: buddyProfile.average_rating ?? null,
    reviewCount: buddyProfile.review_count ?? 0,
  });
});

router.get("/rent-a-buddy/me/earnings/ledger", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const svc = sc() ?? auth.client;

  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const offset = Number(req.query.offset ?? 0);

  const { data, error, count } = await svc
    .from("rent_buddy_earnings_ledger")
    .select("*", { count: "exact" })
    .eq("buddy_user_id", auth.user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return sendError(res, 'db_error', error.message);

  const entries = (data ?? []).map((row: any) => ({
    ...row,
    isEstimated: row.is_estimated,
    warning: row.is_estimated ? "Estimated — payout not processed" : undefined,
  }));

  res.json({ ledger: entries, total: count ?? 0 });
});

// ── Earnings ledger creation helper ──────────────────────────────────────────

async function createEarningsLedgerEntry(svc: any, booking: any, buddyProfileId: string) {
  const { data: buddy } = await svc
    .from("rent_buddy_profiles")
    .select("user_id, buddy_level")
    .eq("id", buddyProfileId)
    .maybeSingle();
  if (!buddy) return;

  const { data: feeRule } = await svc
    .from("rent_buddy_fee_rules")
    .select("*")
    .eq("buddy_level", (buddy as any).buddy_level ?? "new")
    .maybeSingle();

  const feePercent = (feeRule as any)?.platform_fee_percent ?? 22;
  const travelerSvcFee = Number((feeRule as any)?.traveler_service_fee_usd ?? 0);
  const total = Number(booking.total_usd ?? 0);
  const platformFeeAmount = Math.round(total * feePercent / 100 * 100) / 100;
  const buddyGross = total + Number(booking.tip_usd ?? 0);
  const buddyNet = Math.round((buddyGross - platformFeeAmount) * 100) / 100;

  const { error: ledgerErr } = await svc.from("rent_buddy_earnings_ledger").upsert({
    booking_id: booking.id,
    buddy_user_id: (buddy as any).user_id,
    traveler_id: booking.traveler_id,
    pricing_type: booking.pricing_type ?? "hourly",
    total_booking_usd: total,
    addons_usd: Number(booking.addons_total_usd ?? 0),
    tip_usd: Number(booking.tip_usd ?? 0),
    platform_fee_percent: feePercent,
    platform_fee_amount: platformFeeAmount,
    traveler_service_fee_amount: travelerSvcFee,
    buddy_gross_amount: buddyGross,
    buddy_net_estimated_amount: buddyNet,
    deposit_amount: Number(booking.deposit_usd ?? 0),
    in_app_amount_collected: Number(booking.deposit_usd ?? 0),
    cash_balance_due: Number(booking.cash_balance_usd ?? 0),
    cash_balance_confirmed: false,
    is_estimated: true,
  }, { onConflict: "booking_id" });
  if (ledgerErr) logger.error({ err: ledgerErr, bookingId: booking.id }, "earnings ledger upsert failed (best-effort)");
}

// ── Admin Marketplace ─────────────────────────────────────────────────────────

router.get("/rent-a-buddy/admin/marketplace/analytics", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { svc } = admin;

  const nowMs = Date.now();
  const since = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [bookingsRes, analyticsRes, waitlistRes, buddiesRes, feeRulesRes] = await Promise.all([
    svc.from("rent_buddy_bookings").select("id, city, category, status, total_usd, deposit_usd, cash_balance_usd, payment_mode, created_at, buddy_id").gte("created_at", since),
    svc.from("rent_buddy_marketplace_analytics_events").select("*").gte("created_at", since),
    svc.from("rent_buddy_waitlist").select("city, category, status"),
    svc.from("rent_buddy_profiles").select("id, city, status, buddy_level, featured, city_ambassador, available_now"),
    svc.from("rent_buddy_fee_rules").select("*"),
  ]);

  const bookings = (bookingsRes.data ?? []) as any[];
  const events = (analyticsRes.data ?? []) as any[];
  const waitlist = (waitlistRes.data ?? []) as any[];
  const buddies = (buddiesRes.data ?? []) as any[];

  // By city
  const cityStats: Record<string, { bookings: number; revenue: number; deposit: number; cash: number; inApp: number }> = {};
  for (const b of bookings) {
    if (!cityStats[b.city]) cityStats[b.city] = { bookings: 0, revenue: 0, deposit: 0, cash: 0, inApp: 0 };
    cityStats[b.city].bookings++;
    cityStats[b.city].revenue += Number(b.total_usd ?? 0);
    cityStats[b.city].deposit += Number(b.deposit_usd ?? 0);
    cityStats[b.city].cash += Number(b.cash_balance_usd ?? 0);
    cityStats[b.city].inApp += b.payment_mode === "full_in_app" ? Number(b.total_usd ?? 0) : Number(b.deposit_usd ?? 0);
  }

  // By category
  const catStats: Record<string, { count: number; revenue: number }> = {};
  for (const b of bookings) {
    if (!catStats[b.category]) catStats[b.category] = { count: 0, revenue: 0 };
    catStats[b.category].count++;
    catStats[b.category].revenue += Number(b.total_usd ?? 0);
  }

  // Status counts
  const statusCounts: Record<string, number> = {};
  for (const b of bookings) {
    statusCounts[b.status] = (statusCounts[b.status] ?? 0) + 1;
  }

  // Waitlist demand
  const waitlistDemand: Record<string, number> = {};
  for (const w of waitlist) {
    const key = `${w.city}:${w.category ?? "any"}`;
    waitlistDemand[key] = (waitlistDemand[key] ?? 0) + 1;
  }

  // Supply by city
  const supply: Record<string, { total: number; active: number; availableNow: number }> = {};
  for (const b of buddies) {
    if (!supply[b.city]) supply[b.city] = { total: 0, active: 0, availableNow: 0 };
    supply[b.city].total++;
    if (b.status === "active") supply[b.city].active++;
    if (b.available_now) supply[b.city].availableNow++;
  }

  // Conversion
  const searches = events.filter((e) => e.event_type === "search").length;
  const completedCount = bookings.filter((b) => b.status === "completed").length;
  const conversionRate = searches > 0 ? Math.round((completedCount / searches) * 10000) / 100 : 0;

  // Policy flags
  const { data: flagsData } = await svc.from("rent_buddy_policy_flags").select("id, severity, status").gte("created_at", since);
  const flags = (flagsData ?? []) as any[];
  const openFlags = flags.filter((f) => f.status === "open").length;
  const criticalFlags = flags.filter((f) => f.severity === "critical").length;

  res.json({
    period: { since, until: new Date(nowMs).toISOString() },
    bookings: {
      total: bookings.length,
      byStatus: statusCounts,
      byCity: cityStats,
      byCategory: catStats,
    },
    revenue: {
      total: bookings.reduce((s, b) => s + Number(b.total_usd ?? 0), 0),
      deposit: bookings.reduce((s, b) => s + Number(b.deposit_usd ?? 0), 0),
      cashBalance: bookings.reduce((s, b) => s + Number(b.cash_balance_usd ?? 0), 0),
    },
    conversion: { searches, completedBookings: completedCount, conversionRate },
    supply,
    waitlistDemand,
    policyFlags: { total: flags.length, open: openFlags, critical: criticalFlags },
    feeRules: feeRulesRes.data ?? [],
  });
});

router.get("/rent-a-buddy/admin/marketplace/cities", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { svc } = admin;

  const { data } = await svc
    .from("rent_buddy_profiles")
    .select("city, status, available_now, buddy_level")
    .eq("status", "active");

  const cityMap: Record<string, { total: number; available: number; byLevel: Record<string, number> }> = {};
  for (const b of (data ?? []) as any[]) {
    if (!cityMap[b.city]) cityMap[b.city] = { total: 0, available: 0, byLevel: {} };
    cityMap[b.city].total++;
    if (b.available_now) cityMap[b.city].available++;
    cityMap[b.city].byLevel[b.buddy_level] = (cityMap[b.city].byLevel[b.buddy_level] ?? 0) + 1;
  }

  res.json({ cities: cityMap });
});

router.post("/rent-a-buddy/admin/profiles/:id/feature", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { svc } = admin;

  const { error } = await svc
    .from("rent_buddy_profiles")
    .update({ featured: true, featured_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", req.params.id);

  if (error) return sendError(res, 'db_error', error.message);

  const { error: auditErr } = await svc.from("rent_buddy_admin_actions").insert({
    admin_id: admin.userId,
    target_type: "profile",
    target_id: req.params.id,
    action: "feature",
    notes: req.body?.reason ?? null,
  });
  if (auditErr) logger.error({ err: auditErr }, "admin action audit insert failed (best-effort)");

  res.json({ ok: true });
});

router.delete("/rent-a-buddy/admin/profiles/:id/feature", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { svc } = admin;

  const { error: unfeatureErr } = await svc.from("rent_buddy_profiles")
    .update({ featured: false, featured_at: null, updated_at: new Date().toISOString() })
    .eq("id", req.params.id);
  if (unfeatureErr) return sendError(res, 'db_error', unfeatureErr.message);

  const { error: auditErr } = await svc.from("rent_buddy_admin_actions").insert({
    admin_id: admin.userId, target_type: "profile", target_id: req.params.id, action: "unfeature", notes: null,
  });
  if (auditErr) logger.error({ err: auditErr }, "admin action audit insert failed (best-effort)");

  res.json({ ok: true });
});

router.post("/rent-a-buddy/admin/profiles/:id/city-ambassador", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { svc } = admin;

  const enable = req.body?.enable !== false;
  const { error: ambassadorErr } = await svc.from("rent_buddy_profiles")
    .update({
      city_ambassador: enable,
      city_ambassador_at: enable ? new Date().toISOString() : null,
      buddy_level: enable ? "city_ambassador" : "elite",
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.params.id);
  if (ambassadorErr) return sendError(res, 'db_error', ambassadorErr.message);

  const { error: auditErr } = await svc.from("rent_buddy_admin_actions").insert({
    admin_id: admin.userId, target_type: "profile", target_id: req.params.id,
    action: enable ? "city_ambassador_grant" : "city_ambassador_revoke", notes: req.body?.reason ?? null,
  });
  if (auditErr) logger.error({ err: auditErr }, "admin action audit insert failed (best-effort)");

  res.json({ ok: true });
});

router.post("/rent-a-buddy/admin/packages/:id/approve", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { svc } = admin;

  const { error: approveErr } = await svc.from("rent_buddy_packages")
    .update({
      admin_review_status: "approved",
      admin_reviewed_by: admin.userId,
      admin_reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.params.id);
  if (approveErr) return sendError(res, 'db_error', approveErr.message);

  const { error: auditErr } = await svc.from("rent_buddy_admin_actions").insert({
    admin_id: admin.userId, target_type: "package", target_id: req.params.id, action: "package_approve", notes: req.body?.reason ?? null,
  });
  if (auditErr) logger.error({ err: auditErr }, "admin action audit insert failed (best-effort)");

  // Compass: buddy's approved package changes their feed ranking — invalidate their cache
  const { data: pkg } = await svc
    .from("rent_buddy_packages")
    .select("buddy_id")
    .eq("id", req.params.id)
    .maybeSingle();
  if (pkg?.buddy_id) {
    await invalidateCompassCache(svc, pkg.buddy_id as string, "package_approved");
  }

  res.json({ ok: true });
});

router.post("/rent-a-buddy/admin/packages/:id/disable", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { svc } = admin;

  const { error: disableErr } = await svc.from("rent_buddy_packages")
    .update({
      admin_review_status: "disabled",
      is_active: false,
      admin_reviewed_by: admin.userId,
      admin_reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", req.params.id);
  if (disableErr) return sendError(res, 'db_error', disableErr.message);

  const { error: auditErr } = await svc.from("rent_buddy_admin_actions").insert({
    admin_id: admin.userId, target_type: "package", target_id: req.params.id, action: "package_disable", notes: req.body?.reason ?? null,
  });
  if (auditErr) logger.error({ err: auditErr }, "admin action audit insert failed (best-effort)");

  // Compass: buddy's package was revoked — their ranking/availability changes
  const { data: disabledPkg } = await svc
    .from("rent_buddy_packages")
    .select("buddy_id")
    .eq("id", req.params.id)
    .maybeSingle();
  if (disabledPkg?.buddy_id) {
    await invalidateCompassCache(svc, disabledPkg.buddy_id as string, "package_disabled");
  }

  res.json({ ok: true });
});

router.get("/rent-a-buddy/admin/pricing/outliers", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { svc } = admin;

  // Buddies with rates more than 3x the city/category average
  const { data } = await svc
    .from("rent_buddy_profiles")
    .select("id, display_name, city, categories, hourly_rate_usd, buddy_level, verified")
    .eq("status", "active")
    .not("hourly_rate_usd", "is", null)
    .order("hourly_rate_usd", { ascending: false })
    .limit(50);

  res.json({ outliers: data ?? [] });
});

router.patch("/rent-a-buddy/admin/fee-rules", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { svc } = admin;

  const { updates } = req.body ?? {};
  if (!Array.isArray(updates)) return sendError(res, 'invalid_payload', "updates array required.");

  for (const upd of updates) {
    if (!upd.buddyLevel) continue;
    const { error: feeErr } = await svc.from("rent_buddy_fee_rules")
      .upsert({
        buddy_level: upd.buddyLevel,
        platform_fee_percent: upd.platformFeePercent,
        traveler_service_fee_usd: upd.travelerServiceFeeUsd ?? 0,
        traveler_service_fee_pct: upd.travelerServiceFeePct ?? 0,
        updated_at: new Date().toISOString(),
      }, { onConflict: "buddy_level" });
    if (feeErr) return sendError(res, 'db_error', feeErr.message);
  }

  const { error: auditErr } = await svc.from("rent_buddy_admin_actions").insert({
    admin_id: admin.userId, target_type: "fee_rules", target_id: admin.userId, action: "fee_rules_update", notes: null,
  });
  if (auditErr) logger.error({ err: auditErr }, "admin action audit insert failed (best-effort)");

  res.json({ ok: true });
});

router.post("/rent-a-buddy/admin/users/:userId/force-public-meetup", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { svc } = admin;

  const { error: limitErr } = await svc.from("rent_buddy_user_limits").upsert({
    user_id: req.params.userId,
    public_meetup_required: true,
    reason: req.body?.reason ?? "Admin restriction",
    created_by_admin_id: admin.userId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (limitErr) return sendError(res, 'db_error', limitErr.message);

  const { error: auditErr } = await svc.from("rent_buddy_admin_actions").insert({
    admin_id: admin.userId, target_type: "user", target_id: req.params.userId, action: "force_public_meetup", notes: req.body?.reason ?? null,
  });
  if (auditErr) logger.error({ err: auditErr }, "admin action audit insert failed (best-effort)");

  res.json({ ok: true });
});

router.post("/rent-a-buddy/admin/users/:userId/force-full-in-app", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { svc } = admin;

  const { error: limitErr } = await svc.from("rent_buddy_user_limits").upsert({
    user_id: req.params.userId,
    full_in_app_payment_required: true,
    cash_balance_disabled: true,
    reason: req.body?.reason ?? "Admin restriction",
    created_by_admin_id: admin.userId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (limitErr) return sendError(res, 'db_error', limitErr.message);

  const { error: auditErr } = await svc.from("rent_buddy_admin_actions").insert({
    admin_id: admin.userId, target_type: "user", target_id: req.params.userId, action: "force_full_in_app", notes: req.body?.reason ?? null,
  });
  if (auditErr) logger.error({ err: auditErr }, "admin action audit insert failed (best-effort)");

  res.json({ ok: true });
});

router.post("/rent-a-buddy/admin/restrictions/city-category", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { svc } = admin;

  const { city, category, disableDepositCash, requirePublicMeetup, requireFullInApp, reason } = req.body ?? {};
  if (!city) return sendError(res, 'invalid_payload', "city is required.");

  const { error: restrictionErr } = await svc.from("rent_buddy_city_restrictions").upsert({
    city,
    category: category ?? null,
    disable_deposit_cash: disableDepositCash ?? false,
    require_public_meetup: requirePublicMeetup ?? false,
    require_full_in_app: requireFullInApp ?? false,
    reason: reason ?? null,
    created_by: admin.userId,
  }, { onConflict: "city,category" });
  if (restrictionErr) return sendError(res, 'db_error', restrictionErr.message);

  // Compass: city/category restriction immediately invalidates all affected buddy caches.
  // Enumerate buddies in the city (and optionally in the given category) and fan out
  // synchronously. Capped at 200 users to keep the request latency bounded.
  {
    let q = svc
      .from("rent_buddy_profiles")
      .select("user_id")
      .eq("city", city)
      .eq("status", "active")
      .limit(200);
    if (category) q = (q as any).contains("categories", [category]);
    const { data: affectedBuddies } = await q;
    if (affectedBuddies?.length) {
      await Promise.allSettled(
        (affectedBuddies as Array<{ user_id: string }>).map(b =>
          invalidateCompassCache(svc, b.user_id, "city_category_restriction"),
        ),
      );
    }
  }

  res.json({ ok: true });
});

export default router;
