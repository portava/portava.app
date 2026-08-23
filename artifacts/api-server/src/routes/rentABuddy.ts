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
import { requireUser, optionalUser, sendError, safeSecretEquals } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled, isKillSwitchEngaged } from "../lib/featureFlags.js";
import { recordTrustEvent } from "../services/trust/TrustEventService.js";
import { computeTrustScore } from "../lib/trustScore.js";
import { adjustBuddyCounter, syncFavoritesCount } from "../services/rentBuddy/ReliabilityCounters.js";
import { recordActivityEvent } from "../compass/CompassActiveUserRewardEngine.js";
import { endFairExposure } from "../compass/CompassFairExposureEngine.js";
import { invalidate as invalidateCompassCache } from "../compass/CompassCacheEngine.js";
import { checkRentBuddyAccess, invalidateSuggestedCityCache } from "./rentABuddyRollout.js";
import { requireBookingKyc } from "../lib/rentBuddyKycGate.js";
import { notifyBookingParty } from "../lib/bookingNotify.js";
import { loadTravelerIdentity } from "../lib/travelerVerification.js";
import { runBuddyRequestSweep } from "../lib/rentBuddyRequestSweeper.js";
import { haversineKm } from "../lib/canonicalLocations.js";
import { isNonNumericCoord } from "../lib/coords.js";
import { SEED_CITIES } from "../lib/popularCities.js";
import {
  POLICY_TEXT,
  isPrivateLocation,
  CATEGORY_RISK_LEVELS,
  getCategoryRiskLevel,
  type PolicyMatch,
  scanText,
  worstSeverity,
} from "../lib/rentaBuddyScanner.js";

import { requireAdmin } from "../lib/requireAdmin.js";

export { POLICY_TEXT, CATEGORY_RISK_LEVELS, getCategoryRiskLevel };

const router = Router();

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

// Exported so every booking-CREATION path applies the same account-level
// restrictions. There are five such paths and only this file's two were gated;
// rentABuddySpec and rentABuddyMarketplace now import this rather than
// re-querying rent_buddy_user_limits ad hoc (or, as before, not at all).
export async function getUserLimits(client: any, userId: string): Promise<any | null> {
  const { data } = await client
    .from("rent_buddy_user_limits")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return data ?? null;
}

// ── Buddy blocked-dates (availability exceptions) helper ─────────────────────

/**
 * Returns the availability exception (vacation/blocked range) covering
 * `isoDate` for the given buddy profile, or null when the date is free.
 * An exception blocks the date if:
 *   exception_date <= isoDate AND (end_date IS NULL → exception_date == isoDate,
 *   OR end_date >= isoDate).
 * Used by booking creation, reschedule/suggest-changes, and rebook so a
 * booking can never land on a Buddy's blocked dates.
 */
export async function findBlockingAvailabilityException(
  serviceClient: any,
  buddyProfileId: string,
  isoDate: string,
): Promise<{ id: string; exception_type: string } | null> {
  const { data: availExceptions } = await serviceClient
    .from("buddy_availability_exceptions")
    .select("id, exception_type, exception_date, end_date")
    .eq("buddy_id", buddyProfileId)
    .lte("exception_date", isoDate)
    .or(`end_date.is.null,end_date.gte.${isoDate}`);

  return (
    (availExceptions ?? []).find((ex: any) => {
      if (ex.end_date == null) return ex.exception_date === isoDate;
      return ex.end_date >= isoDate;
    }) ?? null
  );
}

/** Standard 409 payload when a date falls inside a buddy's blocked range. */
export function sendBuddyUnavailable(res: any, exceptionType: string | null | undefined): void {
  const isVacation = exceptionType === "vacation";
  res.status(409).json({
    error: "buddy_unavailable",
    message: isVacation
      ? "This Buddy is on vacation and not accepting bookings on that date."
      : "This Buddy is not available on the requested date.",
  });
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

// ── Row mapper helpers ─────────────────────────────────────────────────────────

/**
 * Explicit column list for all public-facing buddy profile selects.
 * Intentionally excludes admin-only and private contact fields:
 *   admin_status, risk_hold, id_verification_ref, legal_name,
 *   exact_address, home_address, phone_number.
 */
const BUDDY_PUBLIC_COLUMNS =
  "id, user_id, display_name, tagline, bio, intro_video_url, languages, city, country, " +
  "categories, hourly_rate_usd, status, verified, verified_at, verification_status, " +
  "average_rating, review_count, completed_bookings, completed_count, response_time_h, " +
  "cover_photo_url, gallery_urls, vibe_tags, safety_badges, buddy_level, category_approvals, " +
  "new_buddy_public_only, new_buddy_daytime_only, new_buddy_max_hours, max_group_size, " +
  "preferred_meetup_zones, availability_blocks, meetup_base_lat, meetup_base_lng, featured, available_now, cancel_count, no_show_count, " +
  "favorites_count, created_at, updated_at, profiles!user_id(verification_level)";

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
    verified: row.verified,
    verifiedAt: row.verified_at,
    averageRating: row.average_rating ? Number(row.average_rating) : null,
    reviewCount: row.review_count ?? 0,
    completedBookings: row.completed_count ?? row.completed_bookings ?? 0,
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
    availabilityBlocks: row.availability_blocks ?? [],
    meetupBaseLat: typeof row.meetup_base_lat === "number" ? row.meetup_base_lat : null,
    meetupBaseLng: typeof row.meetup_base_lng === "number" ? row.meetup_base_lng : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    verificationLevel: (row.profiles?.verification_level as string) ?? null,
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
    stayConnectedTraveler: !!row.stay_connected_traveler,
    stayConnectedBuddy: !!row.stay_connected_buddy,
    isTest: !!row.is_test_booking,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// `profile` is the applicant's rent_buddy_profiles row (if any). Wizard-collected
// fields (displayName, bio, hourlyRateUsd, availability, zones) are persisted there
// at apply time, so we surface them on the application shape for admin review.
function mapApplication(row: any, profile?: any) {
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
    displayName: profile?.display_name ?? null,
    bio: profile?.bio ?? null,
    hourlyRateUsd: profile?.hourly_rate_usd != null ? Number(profile.hourly_rate_usd) : null,
    availability: profile?.availability_blocks ?? [],
    zones: profile?.preferred_meetup_zones ?? [],
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

// Sends a structured booking card message into the thread.
// Called on acceptance (initial card) and on each major status transition so
// the UI always has a current card. The card body is a JSON string.
async function emitBookingCard(
  client: any,
  bookingId: string,
  actorId: string,
  newStatus: string,
): Promise<void> {
  try {
    const { data: bk } = await client
      .from("rent_buddy_bookings")
      .select("telegraph_thread_id, booking_date, start_time, duration_h, city, category, total_usd")
      .eq("id", bookingId)
      .maybeSingle();
    const threadId: string | null = (bk as any)?.telegraph_thread_id ?? null;
    if (!threadId) return;
    const cardBody = JSON.stringify({
      booking_id: bookingId,
      status: newStatus,
      booking_date: (bk as any)?.booking_date ?? null,
      start_time: (bk as any)?.start_time ?? null,
      duration_h: (bk as any)?.duration_h ?? null,
      city: (bk as any)?.city ?? null,
      category: (bk as any)?.category ?? null,
      total_usd: (bk as any)?.total_usd ?? null,
      cancellation_policy: "Free cancellation up to 24h before start. After that, a 50% fee may apply.",
      safety_reminder: "Always meet in public places. Share your itinerary with someone you trust.",
    });
    await client.from("messages").insert({
      thread_id: threadId,
      sender_id: actorId,
      body: cardBody,
      msg_type: "booking_card",
      subtype: `booking_status_${newStatus}`,
    });
  } catch { /* non-critical — never fail the main request */ }
}

// ── Booking push notification helper ──────────────────────────────────────────
// Fire-and-forget: sends a push notification to one party of a booking.
// eventType is a free-form string; the NotificationTemplateService renders title/body.
// Silent no-op on any error — never fails the main request.

// notifyBookingParty now lives in lib/bookingNotify.ts so background jobs can
// reuse it without importing from routes/ (which would create an import cycle).

// ── City availability (public, no auth) ──────────────────────────────────────
// GET /api/rent-a-buddy/cities/:city/available
// Returns { available: boolean, code?: string } based on the city rollout table.
// Does NOT require authentication — used by Event Detail to gate the "Find a Buddy" CTA.
router.get("/rent-a-buddy/cities/:city/available", async (req, res) => {
  const serviceClient = sc();
  if (!serviceClient) return res.json({ available: false, code: "service_unavailable" });

  const rentBuddyEnabled = await isFlagEnabled(serviceClient, "rent_buddy_enabled").catch(() => false);
  if (!rentBuddyEnabled) return res.json({ available: false, code: "feature_disabled" });

  const city = req.params.city?.trim();
  if (!city) return res.json({ available: false, code: "invalid_city" });

  const { data: rollout } = await serviceClient
    .from("rent_buddy_city_rollouts")
    .select("status")
    .ilike("city", city)
    .maybeSingle();

  const cityStatus: string = rollout ? (rollout as any).status : "disabled";

  if (cityStatus === "disabled" || cityStatus === "suspended") {
    return res.json({ available: false, code: "city_not_available" });
  }

  return res.json({ available: true, status: cityStatus });
});

// ── Search ────────────────────────────────────────────────────────────────────

// City → coordinates resolver used for proximity ranking / distance labels.
// Buddy profiles carry only a city name (no coordinates), so distance is
// measured from the queried point to the buddy's city centre.
// Seed-city lookup first (no network), then Nominatim with an in-memory cache.
// Failures are cached briefly so a geocoder outage cannot flood it with retries.
const GEOCODE_OK_TTL_MS   = 24 * 60 * 60 * 1000;
const GEOCODE_FAIL_TTL_MS = 10 * 60 * 1000;
const cityCoordsCache = new Map<string, { coords: { lat: number; lng: number } | null; expiresAt: number }>();

async function geocodeBuddyCity(city: string, country: string | null): Promise<{ lat: number; lng: number } | null> {
  const key = `${city.trim().toLowerCase()}|${(country ?? "").trim().toLowerCase()}`;
  const hit = cityCoordsCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.coords;

  const seed = SEED_CITIES.find((s) => s.name.toLowerCase() === city.trim().toLowerCase());
  if (seed) {
    const coords = { lat: seed.lat, lng: seed.lng };
    cityCoordsCache.set(key, { coords, expiresAt: Date.now() + GEOCODE_OK_TTL_MS });
    return coords;
  }

  let coords: { lat: number; lng: number } | null = null;
  try {
    const q = country ? `${city}, ${country}` : city;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
      { headers: { "User-Agent": "TravelBuddy/1.0 (travel-buddy app)" }, signal: ctrl.signal },
    ).finally(() => clearTimeout(t));
    if (resp.ok) {
      const rows = await resp.json() as Array<{ lat: string; lon: string }>;
      const r = rows?.[0];
      if (r) coords = { lat: parseFloat(r.lat), lng: parseFloat(r.lon) };
    }
  } catch { /* treated as a miss; cached below with short TTL */ }

  cityCoordsCache.set(key, {
    coords,
    expiresAt: Date.now() + (coords ? GEOCODE_OK_TTL_MS : GEOCODE_FAIL_TTL_MS),
  });
  return coords;
}

/** True when a buddy row carries a usable approximate meetup-base pin. */
function hasMeetupBase(r: Record<string, unknown>): boolean {
  return typeof r.meetup_base_lat === "number" && Number.isFinite(r.meetup_base_lat)
    && typeof r.meetup_base_lng === "number" && Number.isFinite(r.meetup_base_lng);
}

router.post("/rent-a-buddy/search", async (req, res) => {
  const serviceClient = sc();
  if (!serviceClient) return res.json({ buddies: [], total: 0, page: 1, perPage: 20 });
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const {
    city, category, language, maxBudgetUsd, buddyLevel,
    nightlifeAvailable, publicMeetupOnly, lat, lng, page = 1, perPage = 20,
  } = req.body ?? {};

  // Reject any non-numeric (but present) coord value — string, boolean, object, etc.
  if (isNonNumericCoord(lat) || isNonNumericCoord(lng)) {
    return sendError(res, "invalid_payload", "lat and lng must be finite numbers.");
  }
  const latPresent = typeof lat === "number" && Number.isFinite(lat);
  const lngPresent = typeof lng === "number" && Number.isFinite(lng);
  if (latPresent !== lngPresent) {
    return sendError(res, "invalid_payload", "lat and lng must both be provided together.");
  }

  const origin = latPresent && lngPresent ? { lat: lat as number, lng: lng as number } : null;

  let query = serviceClient
    .from("rent_buddy_profiles")
    .select(BUDDY_PUBLIC_COLUMNS, { count: "exact" })
    .eq("status", "active")
    .eq("admin_status", "active")
    .order("review_count", { ascending: false });

  // With an origin point, proximity ranking happens in JS across the whole
  // candidate pool, so pagination must also happen after sorting.
  query = origin
    ? query.limit(500)
    : query.range((page - 1) * perPage, page * perPage - 1);

  if (city)          query = query.ilike("city", `%${city}%`);
  if (category)      query = query.contains("categories", [category]);
  if (language)      query = query.contains("languages", [language]);
  if (maxBudgetUsd)  query = query.lte("hourly_rate_usd", maxBudgetUsd);
  if (buddyLevel)    query = query.eq("buddy_level", buddyLevel);
  if (nightlifeAvailable) query = query.contains("categories", ["nightlife"]);
  if (publicMeetupOnly)   query = query.eq("new_buddy_public_only", true);

  const { data, count, error } = await query;
  if (error) return sendError(res, "db_error", error.message);

  let rows: Record<string, unknown>[] = data ?? [];
  const distanceById = new Map<string, number | null>();

  if (origin) {
    // Resolve a coordinate for each buddy: the buddy's own approximate
    // meetup-base pin when set (neighbourhood-level precision), otherwise the
    // buddy's city centre (cached geocode). Unresolvable buddies sort last,
    // keeping their review-count order.
    const distinctCities = new Map<string, { city: string; country: string | null }>();
    for (const r of rows) {
      if (hasMeetupBase(r)) continue; // no city geocode needed for pinned buddies
      const c = String(r.city ?? "").trim();
      if (!c) continue;
      const k = `${c.toLowerCase()}|${String(r.country ?? "").trim().toLowerCase()}`;
      if (!distinctCities.has(k)) distinctCities.set(k, { city: c, country: (r.country as string | null) ?? null });
    }
    const coordsByKey = new Map<string, { lat: number; lng: number } | null>();
    await Promise.all([...distinctCities.entries()].map(async ([k, v]) => {
      coordsByKey.set(k, await geocodeBuddyCity(v.city, v.country));
    }));

    for (const r of rows) {
      let coords: { lat: number; lng: number } | null = null;
      if (hasMeetupBase(r)) {
        coords = { lat: r.meetup_base_lat as number, lng: r.meetup_base_lng as number };
      } else {
        const c = String(r.city ?? "").trim();
        const k = `${c.toLowerCase()}|${String(r.country ?? "").trim().toLowerCase()}`;
        coords = c ? coordsByKey.get(k) ?? null : null;
      }
      distanceById.set(
        String(r.id),
        coords ? Math.round(haversineKm(origin.lat, origin.lng, coords.lat, coords.lng) * 10) / 10 : null,
      );
    }

    rows = [...rows].sort((a, b) => {
      const da = distanceById.get(String(a.id));
      const db = distanceById.get(String(b.id));
      if (da == null && db == null) return 0;
      if (da == null) return 1;
      if (db == null) return -1;
      return da - db;
    });
    rows = rows.slice((page - 1) * perPage, page * perPage);
  }

  return res.json({
    buddies: rows.map((p: Record<string, unknown>) => ({
      ...mapProfile(stripBuddyPrivateFields(p, false)),
      distanceKm: distanceById.get(String(p.id)) ?? null,
    })),
    total: count ?? 0,
    page,
    perPage,
  });
});

// ── GET /api/buddies — public RESTful buddy listing with SQL-level filtering ──
// Canonical public-facing endpoint.  All filter params are query-string so
// the URL is bookmarkable / cache-friendly without a request body.

router.get("/buddies", async (req, res) => {
  const serviceClient = sc();
  if (!serviceClient) return res.json({ buddies: [], total: 0, page: 1, perPage: 20 });
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const {
    city,
    country,
    category,
    language,
    minBudgetUsd,
    maxBudgetUsd,
    minRating,
    buddyLevel,
    available,
    availableDate,
    featured,
    verified,
    q,
    page: rawPage = "1",
    perPage: rawPerPage = "20",
  } = req.query as Record<string, string | undefined>;

  const page = Math.max(1, parseInt(rawPage ?? "1", 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(rawPerPage ?? "20", 10) || 20));

  // If availableDate is supplied, pre-fetch buddy IDs available on that date
  let buddyIdsFilter: string[] | null = null;
  if (availableDate && /^\d{4}-\d{2}-\d{2}$/.test(availableDate)) {
    const { data: avRows } = await serviceClient
      .from("rent_buddy_availability")
      .select("buddy_id")
      .eq("date", availableDate)
      .eq("is_available", true);
    const ids: string[] = (avRows ?? []).map((r: any) => r.buddy_id as string);
    if (ids.length === 0) {
      return res.json({ buddies: [], total: 0, page, perPage, totalPages: 0 });
    }
    buddyIdsFilter = ids;
  }

  // Weighted best-match ranking.
  //
  // Strategy: fetch up to CANDIDATE_LIMIT rows (pre-sorted by featured/rating at DB
  // level for efficient candidate selection), apply weighted scoring across the full
  // pool in JS (BEFORE pagination), then slice the requested page from the sorted
  // results.  A separate head-only count query reports the accurate total across all
  // matching rows so pagination controls are always correct.
  //
  // Scoring weights (safety signals outweigh engagement per spec):
  //   featured          +20   (admin-surfaced)
  //   verified          +20   (trust/safety — highest priority)
  //   category match    +15   (relevance: buddy supports the requested category)
  //   language match    +15   (relevance: buddy speaks the requested language)
  //   rating+count      ≤20   (avg_rating×3 + log(completed_count+1)×2)
  //   new_buddy         +5    (0 reviews → fair-exposure boost)
  //   cancel_count      –15/ea (reliability penalty)
  //   no_show_count     –10/ea (severe trust penalty)
  //   favorites         +5 max (weak popularity tiebreak)
  const scoreProfile = (p: Record<string, unknown>): number => {
    const featPts     = (p.featured as boolean) ? 20 : 0;
    const verPts      = (p.verification_status as string) === "verified" ? 20 : 0;
    const catPts      = category && Array.isArray(p.categories) && (p.categories as string[]).includes(category) ? 15 : 0;
    const langPts     = language && Array.isArray(p.languages) && (p.languages as string[]).includes(language) ? 15 : 0;
    const ratingScore = Math.min(20, Number(p.average_rating ?? 0) * 3 + Math.log(Number((p as any).completed_count ?? p.review_count ?? 0) + 1) * 2);
    const newBuddy    = Number(p.review_count ?? 0) === 0 ? 5 : 0;
    const cancelPen   = Number((p as any).cancel_count ?? 0) * -15;
    const noShowPen   = Number((p as any).no_show_count ?? 0) * -10;
    const favPts      = Math.min(5, Number((p as any).favorites_count ?? 0));
    // Response-time signal: quicker reply = higher trust (column: response_time_h in decimal hours)
    const rtH         = Number((p as any).response_time_h ?? Infinity);
    const responsePts = rtH <= 0.5 ? 15 : rtH <= 1 ? 10 : rtH <= 4 ? 5 : 0;
    // Availability-match signal: proactively scheduled availability boosts relevance.
    // When an explicit date filter pre-selected these candidates, all share the bonus (+10).
    // When a real-time "available now" filter was requested, available_now drives the signal.
    const availPts    = buddyIdsFilter !== null ? 10 : ((p.available_now as boolean) ? 5 : 0);
    return featPts + verPts + catPts + langPts + ratingScore + newBuddy + cancelPen + noShowPen + favPts + responsePts + availPts;
  };

  // Shared filter helper — closes over all filter params from req.query.
  // Applies the same predicates to both the count query and the data query so
  // results and totals are always consistent.
  function applyBuddyFilters(qb: any): any {
    if (city)                    qb = qb.ilike("city", `%${city}%`);
    if (country)                 qb = qb.ilike("country", `%${country}%`);
    if (category)                qb = qb.contains("categories", [category]);
    if (language)                qb = qb.contains("languages", [language]);
    if (minBudgetUsd)            qb = qb.gte("hourly_rate_usd", Number(minBudgetUsd));
    if (maxBudgetUsd)            qb = qb.lte("hourly_rate_usd", Number(maxBudgetUsd));
    if (minRating)               qb = qb.gte("average_rating", Number(minRating));
    if (buddyLevel)              qb = qb.eq("buddy_level", buddyLevel);
    if (available === "now")     qb = qb.eq("available_now", true);
    if (featured === "true")     qb = qb.eq("featured", true);
    // Use verification_status enum (migration 0109) — avoids legacy boolean divergence.
    if (verified === "true")     qb = qb.eq("verification_status", "verified");
    if (buddyIdsFilter !== null) qb = qb.in("id", buddyIdsFilter);
    // Free-text search across display_name, tagline, bio, city.
    if (q) {
      const safe = q.replace(/[%_,.'"\s]+/g, " ").trim().slice(0, 120);
      if (safe) {
        const term = `%${safe}%`;
        qb = qb.or(
          [`display_name.ilike.${term}`, `tagline.ilike.${term}`, `bio.ilike.${term}`, `city.ilike.${term}`].join(","),
        );
      }
    }
    return qb;
  }

  // Count query — accurate total across all matching rows (no data transfer).
  const { count: totalCount, error: countError } = await applyBuddyFilters(
    serviceClient
      .from("rent_buddy_profiles")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .eq("admin_status", "active"),
  );
  if (countError) return sendError(res, "db_error", countError.message);

  // Scoring pool — size adapts to totalCount so scored.length ≈ totalCount for
  // realistic datasets (< 2000 buddies per city), keeping totalPages consistent.
  // Hard cap of 2000 prevents excessive memory use on large global result sets.
  const fetchLimit = Math.min(Math.max(totalCount ?? 0, perPage), 2000);
  const { data, error } = await applyBuddyFilters(
    serviceClient
      .from("rent_buddy_profiles")
      .select(BUDDY_PUBLIC_COLUMNS)
      .eq("status", "active")
      .eq("admin_status", "active")
      .order("featured", { ascending: false })
      .order("average_rating", { ascending: false })
      .order("review_count", { ascending: false })
      .limit(fetchLimit),
  );
  if (error) return sendError(res, "db_error", error.message);

  // Apply weighted scoring across the full fetched pool, THEN paginate.
  const scored = (data ?? [] as Record<string, unknown>[]).sort(
    (a: Record<string, unknown>, b: Record<string, unknown>) => scoreProfile(b) - scoreProfile(a),
  );
  const pageStart = (page - 1) * perPage;
  const pageData  = scored.slice(pageStart, pageStart + perPage);

  return res.json({
    buddies: pageData.map((p: Record<string, unknown>) => mapProfile(stripBuddyPrivateFields(p, false))),
    total: totalCount ?? 0,
    page,
    perPage,
    // totalPages is based on scored.length (the pool we can actually serve weighted) so
    // pagination controls are always consistent with the data returned by each page.
    totalPages: Math.ceil(scored.length / perPage),
  });
});

// ── Buddy profile ─────────────────────────────────────────────────────────────

router.get("/rent-a-buddy/buddies/:buddyId", async (req, res) => {
  const serviceClient = sc();
  if (!serviceClient) return res.json({ buddy: null, packages: [], addons: [], reviews: [], availability: [], savedByMe: false });
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  // optionalUser, not requireUser. This route treats auth as OPTIONAL — it
  // immediately does `auth?.user.id ?? null` and serves anonymous callers a
  // public buddy profile. But requireUser SENDS a 401 before returning null, so
  // for every signed-out visitor the handler wrote a 401 and then kept running
  // to write a second, 200 response on the same request. optionalUser exists in
  // lib/http.ts for exactly this shape: it returns null without touching `res`.
  const auth = await optionalUser(req);
  const userId = auth?.user.id ?? null;
  const { buddyId } = req.params;

  const [profileRes, packagesRes, addonsRes, availRes] = await Promise.all([
    serviceClient.from("rent_buddy_profiles").select(BUDDY_PUBLIC_COLUMNS).eq("id", buddyId).maybeSingle(),
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
        .in("moderation_status", ["approved", "auto_approved"])
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

  // Compute trust score for the buddy — fail-open.
  let trustScore: number | null = null;
  let trustLabel: string | null = null;
  let trustScoreBreakdown: { factors: Array<{ key: string; label: string; points: number; maxPoints: number; maxed: boolean; hint: null }> } | null = null;
  if (profileRes.data) {
    try {
      const buddyUserId = (profileRes.data as any).user_id as string;
      // Pass no preloaded row — profileRes.data is from rent_buddy_profiles, not profiles.
      // computeTrustScore will fetch the correct profiles row (verified, id_verified_at,
      // created_at, safety_flags_count) itself.
      const ts = await computeTrustScore(buddyUserId, serviceClient);
      trustScore = ts.score;
      trustLabel = ts.label;
      // Public breakdown — hints are stripped (they're only meaningful to the owner).
      trustScoreBreakdown = {
        factors: ts.breakdown.factors.map(f => ({ ...f, hint: null })),
      };
    } catch {
      /* non-critical — buddy card still shown without trust breakdown */
    }
  }

  return res.json({
    buddy: mapProfile(profileRes.data)
      ? { ...mapProfile(profileRes.data), trustScore, trustLabel, trustScoreBreakdown }
      : null,
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

router.get("/rent-a-buddy/by-user/:userId", async (req, res) => {
  const serviceClient = sc();
  if (!serviceClient) return res.json({ buddy: null });

  const enabled = await checkRentBuddyEnabled(serviceClient);
  if (!enabled) return res.json({ buddy: null });

  const { userId } = req.params;

  const { data, error } = await serviceClient
    .from("rent_buddy_profiles")
    .select(BUDDY_PUBLIC_COLUMNS)  // API-05: was select("*") — restrict to public columns like the sibling routes
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (error || !data) return res.json({ buddy: null });

  return res.json({ buddy: mapProfile(data) });
});

router.get("/rent-a-buddy/buddies/:buddyId/availability", async (req, res) => {
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

// ── Blocked dates (public) ────────────────────────────────────────────────────
// GET /api/rent-a-buddy/buddies/:buddyId/blocked-dates
// Returns upcoming availability exceptions (vacation/blocked ranges) for a buddy
// so the booking date picker can disable those dates before the traveller submits.
// Only exposes date-range + type — no reasons or private details.
router.get("/rent-a-buddy/buddies/:buddyId/blocked-dates", async (req, res) => {
  const serviceClient = sc();
  if (!serviceClient) return res.json({ blocked: [] });
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { buddyId } = req.params;
  const today = new Date().toISOString().slice(0, 10);

  // Upcoming exceptions: single-day rows on/after today, or ranges that end on/after today.
  const { data, error } = await serviceClient
    .from("buddy_availability_exceptions")
    .select("id, exception_type, exception_date, end_date")
    .eq("buddy_id", buddyId)
    .or(`and(end_date.is.null,exception_date.gte.${today}),end_date.gte.${today}`)
    .order("exception_date");

  if (error) return sendError(res, "db_error", error.message);

  return res.json({
    blocked: (data ?? []).map((ex: any) => ({
      id: ex.id,
      type: ex.exception_type,
      startDate: ex.exception_date,
      endDate: ex.end_date ?? ex.exception_date,
    })),
  });
});

router.get("/rent-a-buddy/buddies/:buddyId/reviews", async (req, res) => {
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
    .in("moderation_status", ["approved", "auto_approved"])
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  return res.json({ reviews: data ?? [], total: count ?? 0 });
});

// ── Bookings — Create ──────────────────────────────────────────────────────────

router.post("/rent-a-buddy/bookings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const nowMs = Date.now();
  const serviceClient = sc(auth.client);

  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  // KYC gate (audit P1 item 8): no working identity verification means no new
  // bookings between strangers. Fails closed and is independent of the
  // launch-control config below, which is admin-editable.
  if (!await requireBookingKyc(serviceClient, res)) return;

  // Emergency flags: honor BOTH admin kill-switch names (FL-06 — `disable_rab_bookings`
  // was an orphan with no reader, so that admin toggle was a silent no-op). Fail-CLOSED on DB error.
  if (await isKillSwitchEngaged(serviceClient, 'disable_rent_buddy_booking')
      || await isKillSwitchEngaged(serviceClient, 'disable_rab_bookings')) {
    return res.status(404).json({ error: 'feature_disabled', message: 'Rent-a-Buddy bookings are temporarily disabled' });
  }

  const rolloutAccess = await checkRentBuddyAccess({
    sc: serviceClient, userId: user.id,
    city: req.body?.city, category: req.body?.category,
    action: "book",
    groupSize: req.body?.groupSize,
    paymentMode: req.body?.paymentMode ?? "full_in_app",
    meetupType: req.body?.meetupLocation?.type,
  });
  if (!rolloutAccess.allowed) {
    return res.status(rolloutAccess.httpStatus).json({ error: rolloutAccess.code, message: rolloutAccess.message });
  }

  // Test booking guard — only admins can create test bookings
  if (req.body?.is_test_booking) {
    const { data: callerProfile } = await serviceClient
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    const callerRole = (callerProfile as any)?.role ?? "";
    if (callerRole !== "admin" && callerRole !== "owner") {
      return res.status(403).json({
        error: "forbidden",
        message: "Only admins can create test bookings.",
      });
    }
  }

  const limits = await getUserLimits(serviceClient, user.id);
  if (limits?.rent_buddy_disabled || limits?.traveler_booking_disabled) {
    return res.status(403).json({
      error: "access_limited",
      message: "Rent a Buddy access is limited while your account is under review.",
    });
  }

  const {
    buddyId, packageId, tripId, bookingDate, startTime,
    durationH, groupSize = 1, city, countryCode, meetupLocation, category, notes,
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

  // ── Launch control gating ─────────────────────────────────────────────────
  // countryCode must be provided whenever launch controls are configured —
  // without it we cannot enforce country-level policy, so fail closed.
  if (!countryCode) {
    const { count: ctrlCount } = await serviceClient
      .from("rent_buddy_launch_controls")
      .select("id", { count: "exact" })
      .limit(1);
    if ((ctrlCount ?? 0) > 0) {
      return res.status(400).json({
        error: "invalid_payload",
        message: "countryCode is required when booking in a region with active launch controls.",
      });
    }
  }

  const launchCtrl = await getLaunchControl(serviceClient, {
    city, countryCode: countryCode ?? undefined, category,
  });
  if (launchCtrl) {
    if (!launchCtrl.enabled) {
      return launchCtrl.waitlistOnly
        ? res.status(403).json({ error: "waitlist_only", message: "Rent a Buddy bookings for this location are currently waitlist-only. Join the waitlist to be notified when it opens." })
        : res.status(403).json({ error: "location_unavailable", message: "Rent a Buddy is not yet available in this location or category." });
    }
    // Traveller identity comes from `profiles`, NOT from rent_buddy_profiles.
    // This block used to read the BUDDY table, where a row exists only for users
    // who applied to become a buddy — so an ordinary traveller had no row and
    // was hard-403'd with age_verification_required no matter what they did.
    // See lib/travelerVerification.ts for where each signal actually lives.
    const travIdentity = await loadTravelerIdentity(serviceClient, user.id);
    if (launchCtrl.requireIdVerification && !travIdentity.idVerified) {
      return res.status(403).json({ error: "verification_required", message: "ID verification is required to book in this location. Please verify your ID to continue." });
    }
    if (launchCtrl.requirePhoneVerification && !travIdentity.phoneVerified) {
      return res.status(403).json({ error: "verification_required", message: "Phone verification is required to book in this location. Please verify your phone number to continue." });
    }
    // Missing DOB is an explicit block — age cannot be verified without it
    if (travIdentity.age === null) {
      return res.status(403).json({ error: "age_verification_required", message: "Date of birth verification is required to make a booking in this location." });
    }
    const calcAge = travIdentity.age;
    const minAge = category === "nightlife" ? launchCtrl.nightlifeMinAge : launchCtrl.minAge;
    if (calcAge < minAge) {
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
  } else {
    // Deny-by-default: if launch controls are configured but none match this booking, block it
    const { count: ctrlCount } = await serviceClient
      .from("rent_buddy_launch_controls")
      .select("id", { count: "exact" })
      .limit(1);
    if ((ctrlCount ?? 0) > 0) {
      return res.status(403).json({
        error: "location_unavailable",
        message: "Rent a Buddy is not yet available in this location or category.",
      });
    }
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

  // Self-booking block — a buddy cannot book themselves
  if ((buddyProfile as any).user_id === user.id) {
    return res.status(409).json({ error: "self_booking", message: "You cannot book yourself as a Buddy." });
  }

  // Block-table enforcement — traveler must not be blocked by, or have blocked, the buddy's user
  const buddyUserId = (buddyProfile as any).user_id;
  if (buddyUserId) {
    const [blockedByBuddy, blockedByTraveler] = await Promise.all([
      serviceClient
        .from("blocks")
        .select("id")
        .eq("blocker_id", buddyUserId)
        .eq("blocked_id", user.id)
        .maybeSingle(),
      serviceClient
        .from("blocks")
        .select("id")
        .eq("blocker_id", user.id)
        .eq("blocked_id", buddyUserId)
        .maybeSingle(),
    ]);
    if (blockedByBuddy.data || blockedByTraveler.data) {
      return res.status(403).json({
        error: "blocked",
        message: "You cannot book this Buddy.",
      });
    }
  }

  if (buddyProfile.status !== "active" || buddyProfile.admin_status !== "active") {
    return res.status(400).json({ error: "buddy_unavailable", message: "This Buddy is not accepting bookings." });
  }

  // Nightlife and group category approvals are required for ALL bookings, not just new buddies
  if (category === "nightlife" || category === "group") {
    const approvals: Record<string, boolean> = (buddyProfile as any).category_approvals ?? {};
    if (!approvals[category]) {
      return res.status(403).json({
        error: "category_not_approved",
        message: `This Buddy is not approved for ${category} bookings yet.`,
      });
    }
  }

  // Nightlife bookings additionally require explicit admin sign-off on the buddy
  if (category === "nightlife" && !(buddyProfile as any).nightlife_admin_approved) {
    return res.status(403).json({
      error: "nightlife_not_approved",
      message: "This Buddy has not received admin approval for nightlife bookings.",
    });
  }

  // Nightlife bookings require a public meetup location — checked against the
  // explicit meetupLocation when provided; city is the buddy's operating city,
  // not the meetup spot, so we only enforce if a meetup location was given.
  if (category === "nightlife" && meetupLocation && isPrivateLocation(meetupLocation)) {
    return res.status(400).json({
      error: "invalid_location",
      message: "Nightlife meetups must start at a public location (venue entrance, hotel lobby, landmark, etc.). Private rooms and homes are not allowed.",
    });
  }

  // High-risk category verification gate ─────────────────────────────────────
  // arrival and nightlife require both sides to be verified; medium-risk
  // categories are advisory only (not a hard block at this time).
  if (getCategoryRiskLevel(category) === 'high') {
    const buddyVerified = (buddyProfile as any).verification_status === 'verified'
      || ((buddyProfile as any).id_verified && (buddyProfile as any).phone_verified);

    // Fetch traveler's rent_buddy_profile (may not exist for brand-new users)
    const { data: travProf } = await serviceClient
      .from("rent_buddy_profiles")
      .select("verification_status, id_verified, phone_verified")
      .eq("user_id", user.id)
      .maybeSingle();
    const travelerVerified = (travProf as any)?.verification_status === 'verified'
      || ((travProf as any)?.id_verified && (travProf as any)?.phone_verified);

    if (!buddyVerified && !travelerVerified) {
      return res.status(403).json({
        error: "verification_required",
        side: "both",
        message: `${category} bookings require both you and the Buddy to be verified. Please complete identity verification.`,
      });
    }
    if (!buddyVerified) {
      return res.status(403).json({
        error: "verification_required",
        side: "buddy",
        message: `${category} bookings require the Buddy to be verified. This Buddy has not completed identity verification.`,
      });
    }
    if (!travelerVerified) {
      return res.status(403).json({
        error: "verification_required",
        side: "traveler",
        message: `${category} bookings require your account to be verified. Please complete identity verification to continue.`,
      });
    }
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

  // Availability exception / vacation-mode block — check before insert
  const blockingException = await findBlockingAvailabilityException(serviceClient, buddyId, bookingDate);
  if (blockingException) {
    return sendBuddyUnavailable(res, blockingException.exception_type);
  }

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
      is_test_booking: !!(req.body?.is_test_booking),
      expires_at: new Date(nowMs + 48 * 3600 * 1000).toISOString(),
      status: "requested",
      safety_status: "normal",
      route_plan: [],
      updated_at: new Date(nowMs).toISOString(),
    })
    .select()
    .maybeSingle();

  if (error) return sendError(res, "db_error", error.message);

  if (booking) {
    void serviceClient.from("buddy_booking_events").insert({
      booking_id: (booking as any).id,
      actor_user_id: user.id,
      event: "request_created",
      from_status: null,
      to_status: "requested",
      metadata: { city, category, durationH },
    });
    notifyBookingParty(getServiceClient(), buddyUserId, "rent_buddy.booking_requested", (booking as any).id);
  }

  return res.status(201).json({ booking: mapBooking(booking), policyText: POLICY_TEXT });
});

router.get("/rent-a-buddy/bookings", async (req, res) => {
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

router.get("/rent-a-buddy/bookings/:bookingId", async (req, res) => {
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

  // Strip private fields: traveler details hidden from buddy until booking is confirmed;
  // buddy details stripped if not confirmed (first meetup/pending)
  const isConfirmed = ["confirmed", "scheduled", "in_progress", "completed"].includes((data as any).status);
  return res.json({
    booking: mapBooking(stripTravelerPrivateFields(data)),
    buddyPrivateVisible: isConfirmed,
    policyText: POLICY_TEXT,
  });
});

// ── Bookings — Payment ────────────────────────────────────────────────────────

router.post("/rent-a-buddy/bookings/:bookingId/pay-deposit", async (req, res) => {
  // Payment module not yet implemented. Return 503 so no booking is ever
  // marked "paid" and no false milestone notification is sent to the traveler.
  return res.status(503).json({
    error: "payment_not_available",
    payment_stub: true,
    message: "In-app payment is not yet available. Payment arrangements are agreed directly with your Buddy after booking confirmation — no charge is made through the app.",
  });
});

router.post("/rent-a-buddy/bookings/:bookingId/pay-full", async (req, res) => {
  // Payment module not yet implemented. Return 503 so no booking is ever
  // marked "paid" and no false milestone notification is sent to the traveler.
  return res.status(503).json({
    error: "payment_not_available",
    payment_stub: true,
    message: "In-app payment is not yet available. Payment arrangements are agreed directly with your Buddy after booking confirmation — no charge is made through the app.",
  });
});

// ── Bookings — Cancel ─────────────────────────────────────────────────────────

router.post("/rent-a-buddy/bookings/:bookingId/cancel", async (req, res) => {
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
  // Resolve the buddy's user_id so both traveler and buddy can cancel
  const { data: buddyProfForCancel } = await serviceClient
    .from("rent_buddy_profiles")
    .select("user_id")
    .eq("id", b.buddy_id)
    .maybeSingle();
  const buddyUserIdForCancel: string = (buddyProfForCancel as any)?.user_id ?? "";
  const isTravelerCancel = b.traveler_id === auth.user.id;
  const isBuddyCancel   = !!buddyUserIdForCancel && buddyUserIdForCancel === auth.user.id;
  if (!isTravelerCancel && !isBuddyCancel) {
    return res.status(403).json({ error: "forbidden" });
  }

  const cancellableStatuses = ["pending", "confirmed", "scheduled"];
  if (!cancellableStatuses.includes(b.status)) {
    return res.status(409).json({
      error: "invalid_transition",
      message: `Cannot cancel a booking in status '${b.status}'. Only pending or confirmed bookings can be cancelled.`,
      currentStatus: b.status,
    });
  }

  const { cancellation_reason } = req.body ?? {};
  const cancelStatus = isTravelerCancel ? "cancelled_by_traveler" : "cancelled_by_buddy";
  const now = new Date();
  const bookingDt = new Date(`${b.booking_date}T${b.start_time ?? "12:00"}Z`);
  const hoursUntil = (bookingDt.getTime() - now.getTime()) / 3600000;
  const trustEventType = isTravelerCancel
    ? (hoursUntil < 2 ? "rent_buddy_late_cancel" : "rent_buddy_abandoned_booking")
    : "rent_buddy_buddy_cancel";

  await serviceClient
    .from("rent_buddy_bookings")
    .update({
      status: cancelStatus,
      cancelled_at: now.toISOString(),
      cancellation_reason: cancellation_reason ?? null,
      updated_at: now.toISOString(),
    })
    .eq("id", bookingId);

  void serviceClient.from("buddy_booking_events").insert({
    booking_id: bookingId, actor_user_id: auth.user.id, event: cancelStatus,
    from_status: b.status, to_status: cancelStatus,
    metadata: { hoursUntil: Math.round(hoursUntil * 10) / 10, cancellation_reason: cancellation_reason ?? null },
  });

  // Buddy-initiated cancellations count against the buddy's reliability.
  if (isBuddyCancel) {
    await adjustBuddyCounter(serviceClient, b.buddy_id, "cancel_count", 1);
  }

  void recordTrustEvent(serviceClient, {
    userId: auth.user.id,
    eventType: trustEventType,
    category: "communication",
    delta: hoursUntil < 2 ? -5 : -2,
    severity: "minor",
    sourceType: "booking",
    sourceId: bookingId,
  });

  void emitBookingMilestone(serviceClient, bookingId, auth.user.id, "rent_buddy_cancelled", "Booking cancelled.");
  void emitBookingCard(serviceClient, bookingId, auth.user.id, "cancelled");

  // Notify the other party
  const notifyUserId = isTravelerCancel ? buddyUserIdForCancel : b.traveler_id as string;
  const notifyEvent  = isTravelerCancel ? "rent_buddy.booking_cancelled_by_traveler" : "rent_buddy.booking_cancelled_by_buddy";
  const sc2 = getServiceClient();
  if (notifyUserId) {
    notifyBookingParty(sc2, notifyUserId, notifyEvent, bookingId);
  }

  // Calls policy: an active call on this booking's thread deliberately rides
  // out the cancellation (we do NOT terminate the call session here). Only
  // the next call START is denied (rab_context_ineligible) once this booking
  // leaves the call-eligible statuses. See lib/calls/callGatewayAdapter.ts.

  // Invalidate compass cache before response so caller sees fresh active_booking state
  await invalidateCompassCache(sc2, auth.user.id, "booking_cancel");

  return res.json({ ok: true });
});

// ── Bookings — Buddy lifecycle (accept / decline / start / complete) ───────────

router.post("/rent-a-buddy/bookings/:bookingId/accept", async (req, res) => {
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
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });
  if (!["pending", "requested"].includes((booking as any).status)) {
    return res.status(409).json({
      error: "invalid_transition",
      message: `Cannot accept a booking in status '${(booking as any).status}'. Only requested (or pending) bookings can be accepted.`,
      currentStatus: (booking as any).status,
    });
  }

  // Guard: reject expired requests — buddy cannot accept after the 48-hour window
  if ((booking as any).expires_at && new Date((booking as any).expires_at) < new Date()) {
    return res.status(422).json({
      error: "request_expired",
      message: "This booking request has expired and can no longer be accepted.",
    });
  }

  // Conflict detection: check for overlapping scheduled/in_progress bookings for this buddy
  const { data: existingBookings } = await serviceClient
    .from("rent_buddy_bookings")
    .select("id, booking_date, start_time, duration_h")
    .eq("buddy_id", (bp as any).id)
    .in("status", ["scheduled", "confirmed", "in_progress"])
    .neq("id", bookingId);

  const newStart = new Date(`${(booking as any).booking_date}T${(booking as any).start_time ?? "00:00"}Z`);
  const newEnd   = new Date(newStart.getTime() + Number((booking as any).duration_h ?? 1) * 3600 * 1000);
  const hasConflict = (existingBookings ?? []).some((cb: any) => {
    const cbStart = new Date(`${cb.booking_date}T${cb.start_time ?? "00:00"}Z`);
    const cbEnd   = new Date(cbStart.getTime() + Number(cb.duration_h ?? 1) * 3600 * 1000);
    return newStart < cbEnd && newEnd > cbStart;
  });
  if (hasConflict) {
    return res.status(409).json({
      error: "schedule_conflict",
      message: "This booking overlaps with an existing confirmed or in-progress session. Please decline and suggest an alternative time.",
    });
  }

  const now = new Date().toISOString();
  await serviceClient
    .from("rent_buddy_bookings")
    .update({ status: "scheduled", confirmed_at: now, updated_at: now })
    .eq("id", bookingId);

  void serviceClient.from("buddy_booking_events").insert({
    booking_id: bookingId, actor_user_id: auth.user.id, event: "accepted",
    from_status: (booking as any).status, to_status: "scheduled", metadata: {},
  });

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
  void emitBookingCard(serviceClient, bookingId, auth.user.id, "scheduled");

  // Await invalidation for both parties before response — same-request guarantee
  const sc_ = getServiceClient();
  await Promise.allSettled([
    invalidateCompassCache(sc_, auth.user.id, "booking_accept"),
    invalidateCompassCache(sc_, (booking as any).traveler_id as string, "booking_accept"),
  ]);

  // Push notification to traveler
  notifyBookingParty(sc_, (booking as any).traveler_id as string, "rent_buddy.booking_accepted", bookingId);

  return res.json({ ok: true });
});

router.post("/rent-a-buddy/bookings/:bookingId/decline", async (req, res) => {
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
    .select("id, status, traveler_id")
    .eq("id", req.params.bookingId)
    .eq("buddy_id", (bp as any).id)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });
  if (!["pending", "requested"].includes((booking as any).status)) {
    return res.status(409).json({
      error: "invalid_transition",
      message: `Cannot decline a booking in status '${(booking as any).status}'. Only requested (or pending) bookings can be declined.`,
      currentStatus: (booking as any).status,
    });
  }

  const { decline_reason } = req.body ?? {};
  await serviceClient
    .from("rent_buddy_bookings")
    .update({ status: "declined", decline_reason: decline_reason ?? null, updated_at: now })
    .eq("id", req.params.bookingId);

  void serviceClient.from("buddy_booking_events").insert({
    booking_id: req.params.bookingId, actor_user_id: auth.user.id, event: "declined",
    from_status: (booking as any).status, to_status: "declined", metadata: { decline_reason: decline_reason ?? null },
  });

  // Push notification to traveler
  const travelerId: string = (booking as any).traveler_id ?? "";
  if (travelerId) {
    notifyBookingParty(getServiceClient(), travelerId, "rent_buddy.booking_declined", req.params.bookingId);
  }

  return res.json({ ok: true });
});

// ── Suggest changes (reschedule) ──────────────────────────────────────────────
// POST /api/rent-a-buddy/bookings/:bookingId/suggest
// Buddy (or traveler) proposes alternative details for a requested booking.
// Creates buddy_booking_change_requests rows (one per changed field) that the
// other party accepts/declines via respond-change-request.
// A proposed date must not fall inside the buddy's blocked/vacation ranges.
router.post("/rent-a-buddy/bookings/:bookingId/suggest", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { proposedDate, proposedTime, proposedDurationH, proposedLocation, message } = req.body ?? {};

  if (!proposedDate && !proposedTime && proposedDurationH === undefined && !proposedLocation) {
    return res.status(400).json({ error: "invalid_payload", message: "At least one proposed change is required." });
  }

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("id, traveler_id, buddy_id, status, booking_date, start_time, duration_h")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const party = await requireBookingParty(serviceClient, booking, auth.user.id, res);
  if (!party) return;

  const suggestAllowedStatuses = ["pending", "requested", "confirmed", "scheduled"];
  if (!suggestAllowedStatuses.includes((booking as any).status)) {
    return res.status(409).json({
      error: "invalid_transition",
      message: "Changes can only be suggested before the session starts.",
      currentStatus: (booking as any).status,
    });
  }

  // A proposed date must not land on the buddy's blocked/vacation dates
  if (proposedDate !== undefined) {
    if (typeof proposedDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(proposedDate)) {
      return res.status(400).json({ error: "invalid_payload", message: "proposedDate must be an ISO date (YYYY-MM-DD)." });
    }
    const blocking = await findBlockingAvailabilityException(serviceClient, (booking as any).buddy_id, proposedDate);
    if (blocking) return sendBuddyUnavailable(res, blocking.exception_type);
  }

  const changes: Array<{ field: string; current: Record<string, unknown>; proposed: Record<string, unknown> }> = [];
  if (proposedDate) changes.push({ field: "date", current: { date: (booking as any).booking_date }, proposed: { date: proposedDate } });
  if (proposedTime) changes.push({ field: "start_time", current: { start_time: (booking as any).start_time }, proposed: { start_time: proposedTime } });
  if (proposedDurationH !== undefined && Number.isFinite(Number(proposedDurationH))) {
    changes.push({ field: "duration_h", current: { duration_h: (booking as any).duration_h }, proposed: { duration_h: Number(proposedDurationH) } });
  }

  for (const ch of changes) {
    const { error: crErr } = await serviceClient
      .from("buddy_booking_change_requests")
      .insert({
        booking_id: bookingId,
        requested_by: auth.user.id,
        change_field: ch.field,
        current_value: ch.current,
        proposed_value: ch.proposed,
        reason: message ?? null,
      });
    if (crErr) return sendError(res, "db_error", crErr.message);
  }

  void serviceClient.from("buddy_booking_events").insert({
    booking_id: bookingId, actor_user_id: auth.user.id, event: "changes_suggested",
    from_status: (booking as any).status, to_status: (booking as any).status,
    metadata: {
      proposed_date: proposedDate ?? null,
      proposed_time: proposedTime ?? null,
      proposed_duration_h: proposedDurationH ?? null,
      proposed_location: proposedLocation ?? null,
      message: message ?? null,
    },
  });

  const notifyTargetId = party.isTraveler ? party.buddyUserId : (booking as any).traveler_id as string;
  if (notifyTargetId) {
    notifyBookingParty(getServiceClient(), notifyTargetId, "rent_buddy.change_request_raised", bookingId);
  }

  return res.status(201).json({ ok: true });
});

router.post("/rent-a-buddy/bookings/:bookingId/start", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  // The buddy confirms the meetup has started (spec: buddy-triggered action)
  const { data: buddyProfile } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!buddyProfile) return res.status(403).json({ error: "not_a_buddy" });

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .eq("buddy_id", (buddyProfile as any).id)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });
  if (!["confirmed", "scheduled"].includes((booking as any).status)) {
    return res.status(409).json({
      error: "invalid_transition",
      message: `Cannot start a booking in status '${(booking as any).status}'. Only confirmed or scheduled bookings can be started.`,
      currentStatus: (booking as any).status,
    });
  }

  const now = new Date().toISOString();
  await serviceClient
    .from("rent_buddy_bookings")
    .update({ status: "in_progress", started_at: now, updated_at: now })
    .eq("id", bookingId);

  void serviceClient.from("buddy_booking_events").insert({
    booking_id: bookingId, actor_user_id: auth.user.id, event: "started",
    from_status: (booking as any).status, to_status: "in_progress", metadata: {},
  });

  await serviceClient.from("rent_buddy_emergency_contacts_snapshot").insert({
    booking_id: bookingId,
    user_id: auth.user.id,
    trusted_circle_shared: req.body?.trustedCircleShared ?? false,
    safe_return_enabled: req.body?.safeReturnEnabled ?? false,
    emergency_contact_count: req.body?.emergencyContactCount ?? 0,
  });

  void emitBookingMilestone(serviceClient, bookingId, auth.user.id, "rent_buddy_started", "Meetup started — enjoy your time together!");
  void emitBookingCard(serviceClient, bookingId, auth.user.id, "in_progress");

  return res.json({ ok: true });
});

router.post("/rent-a-buddy/bookings/:bookingId/complete", async (req, res) => {
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

  // Either the traveler OR the buddy can mark the session complete (spec: mutual confirmation)
  const { data: completingBP } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", auth.user.id)
    .maybeSingle();

  const isCompletingParty =
    (booking as any).traveler_id === auth.user.id ||
    (completingBP && (booking as any).buddy_id === (completingBP as any).id);
  if (!isCompletingParty) return res.status(403).json({ error: "forbidden" });

  if ((booking as any).status !== "in_progress") {
    return res.status(409).json({
      error: "invalid_transition",
      message: `Cannot complete a booking in status '${(booking as any).status}'. Only in-progress bookings can be completed.`,
      currentStatus: (booking as any).status,
    });
  }

  // Buddy completing → pending traveler confirmation with a 24h dispute window.
  // Traveler completing directly → completed (backward-compatible path).
  const isBuddyCompleting = completingBP && (booking as any).buddy_id === (completingBP as any).id;
  const nowMs = Date.now();
  const disputeWindowH = 24;
  const disputeWindowExpiresAt = isBuddyCompleting
    ? new Date(nowMs + disputeWindowH * 3600 * 1000).toISOString()
    : null;
  const finalStatus = isBuddyCompleting ? "completed_pending_traveler_confirmation" : "completed";

  const now = new Date(nowMs).toISOString();
  await serviceClient
    .from("rent_buddy_bookings")
    .update({
      status: finalStatus,
      completed_at: now,
      ...(disputeWindowExpiresAt ? { dispute_window_expires_at: disputeWindowExpiresAt } : {}),
      updated_at: now,
    })
    .eq("id", bookingId);

  void serviceClient.from("buddy_booking_events").insert({
    booking_id: bookingId, actor_user_id: auth.user.id,
    event: isBuddyCompleting ? "buddy_marked_complete" : "completed",
    from_status: "in_progress", to_status: finalStatus,
    metadata: isBuddyCompleting ? { disputeWindowH, disputeWindowExpiresAt } : {},
  });

  // Fetch buddy user_id and current canonical counter for badge threshold checks.
  const { data: profRow } = await serviceClient
    .from("rent_buddy_profiles")
    .select("user_id, completed_count")
    .eq("id", (booking as any).buddy_id)
    .maybeSingle();

  const buddyUserId: string = (profRow as any)?.user_id ?? "";
  // Pre-increment value — used below to decide which stamps to award.
  const currentCount: number = (profRow as any)?.completed_count ?? 0;

  // Canonical counter — atomic DB-side increment via ReliabilityCounters.
  // completed_bookings is the legacy column; completed_count is the single
  // source of truth exposed on public profiles and used for ranking.
  await adjustBuddyCounter(serviceClient, (booking as any).buddy_id, "completed_count", 1);

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

  if (isBuddyCompleting) {
    void emitBookingMilestone(serviceClient, bookingId, auth.user.id, "rent_buddy_pending_confirmation",
      `Session finished! Traveler has ${disputeWindowH}h to review or raise a dispute.`);
    void emitBookingCard(serviceClient, bookingId, auth.user.id, "completed_pending_traveler_confirmation");
  } else {
    void emitBookingMilestone(serviceClient, bookingId, auth.user.id, "rent_buddy_completed", "Booking completed — hope you had a great time!");
    void emitBookingCard(serviceClient, bookingId, auth.user.id, "completed");
  }

  // Await invalidation before response — active_booking state changed for both parties
  const scComplete = getServiceClient();
  await Promise.allSettled([
    invalidateCompassCache(scComplete, auth.user.id, "booking_complete"),
    buddyUserId ? invalidateCompassCache(scComplete, buddyUserId, "booking_complete") : Promise.resolve(),
  ]);

  // Compass activity ingestion — both traveler and buddy get credit
  recordActivityEvent(serviceClient, auth.user.id, "booking_completed", { category: "buddy_session" });
  if (buddyUserId) {
    recordActivityEvent(serviceClient, buddyUserId, "buddy_session_completed", { category: "buddy_session" });
  }

  // Fire-and-forget: award first_buddy_booking (traveler) and first_buddy_hosted (buddy).
  void (async () => {
    try {
      const { awardStamp } = await import("../services/passport/StampAwardEngine.js");
      const { NotificationService } = await import("../services/notifications/NotificationService.js");
      const { NotificationRouter }  = await import("../services/notifications/NotificationRouter.js");
      const sc = getServiceClient();
      if (!sc) return;

      const travelerResult = await awardStamp(sc, {
        userId:        auth.user.id,
        definitionSlug: "first_buddy_booking",
        sourceType:    "rent_buddy",
        sourceId:      bookingId,
      });
      if (travelerResult.awarded) {
        const notifSvc    = new NotificationService(sc);
        const notifRouter = new NotificationRouter(sc);
        const row = await notifSvc.create({
          userId:     auth.user.id,
          eventType:  "passport.stamp_earned",
          sourceType: "rent_buddy",
          sourceId:   bookingId,
          params:     { location: "Rent a Buddy" },
        });
        if (row) await notifRouter.route(row);
      }

      if (buddyUserId) {
        const bookingCategory: string = (booking as any).category ?? "";

        // Build all buddy stamp candidates for this completion
        const buddyAwards: Array<{ slug: string }> = [
          { slug: "first_buddy_hosted" },
        ];
        // buddy_veteran: 5+ completed sessions
        if ((currentCount + 1) >= 5) buddyAwards.push({ slug: "buddy_veteran" });
        // nightlife_guide: completed a nightlife session
        if (bookingCategory === "nightlife") buddyAwards.push({ slug: "nightlife_guide" });
        // food_guide: completed a food & dining session
        if (bookingCategory === "food" || bookingCategory === "food_dining") buddyAwards.push({ slug: "food_guide" });

        const buddySettled = await Promise.allSettled(
          buddyAwards.map(({ slug }) =>
            awardStamp(sc, {
              userId:        buddyUserId,
              definitionSlug: slug,
              sourceType:    "rent_buddy",
              sourceId:      bookingId,
            }).then((r) => ({ slug, ...r })),
          ),
        );

        const awardedBuddySlugs = buddySettled
          .filter((r) => r.status === "fulfilled" && (r as any).value.awarded)
          .map((r) => (r as any).value.slug as string);

        if (awardedBuddySlugs.length > 0) {
          const notifSvc    = new NotificationService(sc);
          const notifRouter = new NotificationRouter(sc);
          const row = await notifSvc.create({
            userId:     buddyUserId,
            eventType:  "passport.stamp_earned",
            sourceType: "rent_buddy",
            sourceId:   bookingId,
            params: { stamps: awardedBuddySlugs.join(","), count: String(awardedBuddySlugs.length) },
          });
          if (row) await notifRouter.route(row);
        }
      }
    } catch {}
  })();

  // Push notification to the other party
  if (isBuddyCompleting) {
    notifyBookingParty(scComplete, (booking as any).traveler_id as string,
      "rent_buddy.booking_pending_confirmation", bookingId);
  } else {
    if (buddyUserId) {
      notifyBookingParty(scComplete, buddyUserId, "rent_buddy.booking_completed", bookingId);
    }
  }

  // Archive the booking thread only when the booking is fully completed (not pending confirmation).
  // For pending confirmation, the thread stays open so traveler can dispute or confirm.
  const bothStayConnected = !!((booking as any).stay_connected_traveler && (booking as any).stay_connected_buddy);

  if (finalStatus === "completed" && !bothStayConnected) {
    const telegraphThreadId2: string | null = (booking as any).telegraph_thread_id ?? null;
    if (telegraphThreadId2) {
      const archiveNow = new Date(nowMs).toISOString();
      await serviceClient
        .from("message_thread_members")
        .update({ archived_at: archiveNow })
        .eq("thread_id", telegraphThreadId2)
        .is("archived_at", null);
    }
  }
  return res.json({ ok: true, status: finalStatus });
});

// ── Bookings — Telegraph thread ───────────────────────────────────────────────
// POST /api/rent-a-buddy/bookings/:bookingId/thread
// Gets or creates the Telegraph thread for a rent-a-buddy booking.
// Both the traveler and the buddy can call this to get the thread ID.

// POST /api/rent-a-buddy/bookings/:bookingId/add-time
// Traveler or buddy adds extra hours to an in-progress or confirmed booking and
// emits a rent_buddy_extra_time system milestone on the thread.
router.post("/rent-a-buddy/bookings/:bookingId/add-time", async (req, res) => {
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
  const addTimeAllowedStatuses = ["confirmed", "scheduled", "in_progress"];
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
router.post("/rent-a-buddy/bookings/:bookingId/stay-connected", async (req, res) => {
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

router.post("/rent-a-buddy/bookings/:bookingId/thread", async (req, res) => {
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
  const threadAllowedStatuses = ["confirmed", "scheduled", "in_progress", "completed", "disputed"];
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

router.post("/rent-a-buddy/bookings/:bookingId/confirm-cash", async (req, res) => {
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

router.post("/rent-a-buddy/bookings/:bookingId/route", async (req, res) => {
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

router.post("/rent-a-buddy/bookings/:bookingId/route-change", async (req, res) => {
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

router.post("/rent-a-buddy/bookings/:bookingId/route-change/:changeId/approve", async (req, res) => {
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

router.post("/rent-a-buddy/bookings/:bookingId/route-change/:changeId/decline", async (req, res) => {
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

router.post("/rent-a-buddy/bookings/:bookingId/review", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { rating, body: reviewBody, safetyScore, communicationScore, punctualityScore, photos = [], categoryRatings, privateNote } = req.body ?? {};
  if (!rating) return res.status(400).json({ error: "invalid_payload", message: "rating required." });

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const party = await requireBookingParty(serviceClient, booking, auth.user.id, res);
  if (!party) return;
  if ((booking as any).status !== "completed") return res.status(400).json({ error: "invalid_payload", message: "Reviews can only be submitted for completed bookings." });

  const b = booking as any;
  const { isTraveler, buddyUserId } = party;

  const role = isTraveler ? "traveler" : "buddy";
  // reviewee must be a profiles.id (user ID), NOT a rent_buddy_profiles.id
  const revieweeId: string = isTraveler ? buddyUserId : b.traveler_id;

  // One-review-per-booking enforcement at API level (DB also has a unique constraint)
  const { data: existingReview } = await serviceClient
    .from("rent_buddy_reviews")
    .select("id")
    .eq("booking_id", bookingId)
    .eq("reviewer_id", auth.user.id)
    .maybeSingle();
  if (existingReview) {
    return res.status(409).json({ error: "already_reviewed", message: "You have already submitted a review for this booking." });
  }

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
      category_ratings: categoryRatings && typeof categoryRatings === "object" ? categoryRatings : null,
      body: reviewBody ?? null,
      photos,
      is_public: false,
      blind_until: blindUntil.toISOString(),
      moderation_status: "pending_moderation",
      updated_at: new Date().toISOString(),
    })
    .select()
    .maybeSingle();

  if (error) return sendError(res, "db_error", error.message);

  // Compass activity ingestion — reviewer earns review_posted credit
  if (typeof privateNote === "string" && privateNote.trim()) {
    void serviceClient.from("rent_buddy_review_notes").insert({
      review_id: (review as any)?.id ?? null,
      booking_id: bookingId,
      author_id: auth.user.id,
      note: privateNote.trim().slice(0, 4000),
    });
  }

  recordActivityEvent(serviceClient, auth.user.id, "review_posted", { category: "buddy_session" });

  // Unblind if both sides have submitted — lift the inter-party blind only.
  // Do NOT set is_public here: reviews stay private until admin approves them.
  // Only the admin approve route sets is_public=true.
  const { count } = await serviceClient
    .from("rent_buddy_reviews")
    .select("id", { count: "exact" })
    .eq("booking_id", bookingId);

  let unblinded = false;
  if ((count ?? 0) >= 2) {
    await serviceClient.from("rent_buddy_reviews")
      .update({ blind_until: new Date().toISOString() })
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

  // Fire-and-forget: award top_rated_buddy when buddy's average rating hits 4.8+
  // Only check when the reviewer is the traveler (rating is for the buddy).
  if (isTraveler && buddyUserId) {
    void (async () => {
      try {
        const { awardStamp: _awardStamp } = await import("../services/passport/StampAwardEngine.js");
        const { NotificationService: NS } = await import("../services/notifications/NotificationService.js");
        const { NotificationRouter: NR }  = await import("../services/notifications/NotificationRouter.js");
        const stampSc = getServiceClient();
        if (!stampSc) return;

        // Read fresh average_rating from the profile (may be updated by a DB trigger)
        const { data: profileRow } = await stampSc
          .from("rent_buddy_profiles")
          .select("average_rating, review_count")
          .eq("user_id", buddyUserId)
          .maybeSingle();

        const avgRating = Number((profileRow as any)?.average_rating ?? 0);
        const reviewCount = Number((profileRow as any)?.review_count ?? 0);

        // Require at least 3 reviews to be eligible to avoid gaming with 1 review
        if (avgRating >= 4.8 && reviewCount >= 3) {
          const result = await _awardStamp(stampSc, {
            userId:         buddyUserId,
            definitionSlug: "top_rated_buddy",
            sourceType:     "rent_buddy",
            sourceId:       bookingId,
          });
          if (result.awarded) {
            const notifSvc    = new NS(stampSc);
            const notifRouter = new NR(stampSc);
            const row = await notifSvc.create({
              userId:     buddyUserId,
              eventType:  "passport.stamp_earned",
              sourceType: "rent_buddy",
              sourceId:   bookingId,
              params:     { stamps: "top_rated_buddy", count: "1" },
            });
            if (row) await notifRouter.route(row);
          }
        }
      } catch {}
    })();
  }

  return res.status(201).json({ review, unblinded });
});

// ── Bookings — Report (no immediate trust penalty; admin reviews) ─────────────

router.post("/rent-a-buddy/bookings/:bookingId/report", async (req, res) => {
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

  // Invalidate compass cache for the reporter: dispute state changed
  await invalidateCompassCache(getServiceClient(), auth.user.id, "booking_report");

  return res.status(201).json({ ok: true });
});

// ── Dispute / payment stubs (payment module not yet implemented) ─────────────
// NOTE: POST /api/rent-a-buddy/bookings/:bookingId/cancel is FULLY IMPLEMENTED
//       above (handles status transition to "cancelled" + emit + compass invalidation).
//       The routes below are stubs for features pending payment-module integration.

router.post("/rent-a-buddy/bookings/:bookingId/reschedule", async (req, res) => {
  res.status(501).json({
    error:  "pending_implementation",
    message: "Reschedule requests are not yet implemented. Please contact support.",
  });
});

// POST /api/rent-a-buddy/bookings/:bookingId/dispute
// Either party files a dispute. Opens a rent_buddy_disputes row and moves booking to 'disputed'.
// Allowed statuses: in_progress, completed_pending_traveler_confirmation, completed.
// For completed_pending_traveler_confirmation, must be within dispute_window_expires_at.
router.post("/rent-a-buddy/bookings/:bookingId/dispute", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { reason } = req.body ?? {};

  const VALID_REASONS = ["cash_balance_disagreement", "no_show", "harassment", "policy_violation", "route_violation", "other"];
  if (!reason || !VALID_REASONS.includes(reason)) {
    return res.status(400).json({
      error: "invalid_payload",
      message: `reason must be one of: ${VALID_REASONS.join(", ")}.`,
    });
  }

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("traveler_id, buddy_id, status, dispute_window_expires_at")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const party = await requireBookingParty(serviceClient, booking, auth.user.id, res);
  if (!party) return;

  // Already disputed — give a dedicated code so clients can show a targeted message.
  if ((booking as any).status === "disputed") {
    return res.status(409).json({
      error: "already_disputed",
      currentStatus: "disputed",
    });
  }

  // A no-show report is already open — it escalates to a dispute automatically
  // after the grace period. Dedicated code so clients can distinguish
  // "already in process" from "wrong state".
  if ((booking as any).status === "no_show_pending") {
    return res.status(409).json({
      error: "no_show_in_progress",
      currentStatus: "no_show_pending",
    });
  }

  // completed and cancelled are terminal — disputing them would corrupt the final state.
  const disputableStatuses = ["in_progress", "completed_pending_traveler_confirmation"];
  if (!disputableStatuses.includes((booking as any).status)) {
    return res.status(409).json({
      error: "invalid_transition",
      message: `Cannot dispute a booking in status '${(booking as any).status}'.`,
      currentStatus: (booking as any).status,
    });
  }

  // Enforce dispute window for completed_pending_traveler_confirmation
  if ((booking as any).status === "completed_pending_traveler_confirmation") {
    const windowExpiry = (booking as any).dispute_window_expires_at;
    if (windowExpiry && new Date(windowExpiry) < new Date()) {
      return res.status(409).json({
        error: "dispute_window_expired",
        message: "The dispute window has closed. The booking has been automatically completed.",
      });
    }
  }

  const { data: dispute, error: disputeErr } = await serviceClient
    .from("rent_buddy_disputes")
    .insert({ booking_id: bookingId, raised_by: auth.user.id, reason, status: "open" })
    .select("id")
    .maybeSingle();

  if (disputeErr) return sendError(res, "db_error", disputeErr.message);

  const now = new Date().toISOString();
  await serviceClient
    .from("rent_buddy_bookings")
    .update({ status: "disputed", updated_at: now })
    .eq("id", bookingId);

  void serviceClient.from("buddy_booking_events").insert({
    booking_id: bookingId, actor_user_id: auth.user.id, event: "dispute_opened",
    from_status: (booking as any).status, to_status: "disputed",
    metadata: { reason, dispute_id: (dispute as any)?.id ?? null },
  });

  void emitBookingMilestone(serviceClient, bookingId, auth.user.id, "rent_buddy_disputed",
    "A dispute has been opened. Our team will review and reach out within 24 hours.");
  void emitBookingCard(serviceClient, bookingId, auth.user.id, "disputed");

  const notifyTargetId = party.isTraveler
    ? party.buddyUserId
    : (booking as any).traveler_id as string;
  if (notifyTargetId) {
    notifyBookingParty(getServiceClient(), notifyTargetId, "rent_buddy.dispute_opened", bookingId);
  }

  return res.json({ ok: true, disputeId: (dispute as any)?.id ?? null });
});

// GET /api/rent-a-buddy/bookings/:bookingId/dispute
// Returns the open dispute for a booking, if any.
router.get("/rent-a-buddy/bookings/:bookingId/dispute", async (req, res) => {
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

  const { data: dispute } = await serviceClient
    .from("rent_buddy_disputes")
    .select("id, reason, status, resolution_note, resolved_at, created_at")
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return res.json({ dispute: dispute ?? null });
});

router.get("/rent-a-buddy/bookings/:bookingId/refund-eligibility", async (req, res) => {
  res.status(501).json({
    error:  "pending_implementation",
    message: "Refund eligibility check is not yet implemented. See cancellation policy for manual refund guidance.",
  });
});

// POST /api/rent-a-buddy/bookings/:bookingId/no-show
// Either party reports the other did not appear. Creates a safety checkin, opens a dispute,
// and moves the booking to 'disputed'. Works for confirmed or in_progress bookings.
router.post("/rent-a-buddy/bookings/:bookingId/no-show", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { note } = req.body ?? {};

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("traveler_id, buddy_id, status")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const party = await requireBookingParty(serviceClient, booking, auth.user.id, res);
  if (!party) return;

  // Reject duplicates: if the booking is already in a no-show or disputed state,
  // return a specific 409 so callers can distinguish idempotency conflicts from
  // genuinely invalid transitions. Mirrors the same guard in rentABuddySpec.ts.
  if ((booking as any).status === "no_show_pending" || (booking as any).status === "disputed") {
    return res.status(409).json({ error: "already_reported", status: (booking as any).status });
  }

  const noShowAllowedStatuses = ["confirmed", "scheduled", "in_progress"];
  if (!noShowAllowedStatuses.includes((booking as any).status)) {
    return res.status(409).json({
      error: "invalid_transition",
      message: "No-show can only be reported for confirmed or in-progress bookings.",
      currentStatus: (booking as any).status,
    });
  }

  // Record the no-show as a safety checkin using the spec-required 'could_not_find' value.
  // Fail closed: return an error if the row is not created.
  const { error: noShowCheckinErr } = await serviceClient.from("rent_buddy_safety_checkins").insert({
    booking_id: bookingId,
    user_id: auth.user.id,
    checkin_type: "could_not_find",
    response: note ?? null,
  });
  if (noShowCheckinErr) return sendError(res, "db_error", noShowCheckinErr.message);

  // Enter a 2-hour grace period instead of opening a dispute immediately.
  // The other party has this window to submit their account.
  // The expiry sweeper escalates no_show_pending → disputed after the grace period.
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const graceExpiry = new Date(nowMs + 2 * 3600 * 1000).toISOString();

  await serviceClient
    .from("rent_buddy_bookings")
    .update({ status: "no_show_pending", no_show_grace_expires_at: graceExpiry, updated_at: now })
    .eq("id", bookingId);

  void serviceClient.from("buddy_booking_events").insert({
    booking_id: bookingId, actor_user_id: auth.user.id, event: "no_show_reported",
    from_status: (booking as any).status, to_status: "no_show_pending",
    metadata: {
      reported_by: party.isTraveler ? "traveler" : "buddy",
      grace_expires_at: graceExpiry,
    },
  });

  void emitBookingMilestone(serviceClient, bookingId, auth.user.id, "rent_buddy_no_show",
    "A no-show was reported. The other party has 2 hours to respond before a dispute is opened.");

  const notifyTargetId = party.isTraveler
    ? party.buddyUserId
    : (booking as any).traveler_id as string;
  if (notifyTargetId) {
    notifyBookingParty(getServiceClient(), notifyTargetId, "rent_buddy.no_show_reported", bookingId);
  }

  return res.json({ ok: true, disputeId: null, gracePeriodExpiresAt: graceExpiry });
});

// ── Safety routes ─────────────────────────────────────────────────────────────

router.post("/rent-a-buddy/bookings/:bookingId/safety/checkin", async (req, res) => {
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

router.post("/rent-a-buddy/bookings/:bookingId/safety/feel-unsafe", async (req, res) => {
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

router.post("/rent-a-buddy/bookings/:bookingId/safety/end-early", async (req, res) => {
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

router.post("/rent-a-buddy/bookings/:bookingId/safety/emergency-phrase", async (req, res) => {
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

router.get("/rent-a-buddy/apply", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const [{ data }, { data: profileRow }] = await Promise.all([
    serviceClient
      .from("rent_buddy_applications")
      .select("*")
      .eq("user_id", auth.user.id)
      .maybeSingle(),
    serviceClient
      .from("rent_buddy_profiles")
      .select("display_name, bio, hourly_rate_usd, availability_blocks, preferred_meetup_zones")
      .eq("user_id", auth.user.id)
      .maybeSingle(),
  ]);

  return res.json({ application: mapApplication(data, profileRow) });
});

router.post("/rent-a-buddy/apply", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const applyRollout = await checkRentBuddyAccess({
    sc: serviceClient, userId: auth.user.id, city: req.body?.city, action: "apply",
  });
  if (!applyRollout.allowed) {
    return res.status(applyRollout.httpStatus).json({ error: applyRollout.code, message: applyRollout.message });
  }

  const {
    city, country, categories = [], languages = [], motivation, socialLinks = {},
    displayName, bio, hourlyRateUsd, availability, zones, photos,
  } = req.body ?? {};
  if (!city) return res.status(400).json({ error: "invalid_payload", message: "city required." });

  if (motivation) {
    const matches = await scanForPolicyViolations({
      sc: serviceClient, text: motivation, sourceType: "profile", flaggedUserId: auth.user.id,
    });
    await applyPolicySeverity({ sc: serviceClient, userId: auth.user.id, matches });
  }

  if (bio && typeof bio === "string") {
    const bioMatches = await scanForPolicyViolations({
      sc: serviceClient, text: bio, sourceType: "profile", flaggedUserId: auth.user.id,
    });
    await applyPolicySeverity({ sc: serviceClient, userId: auth.user.id, matches: bioMatches });
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

  // Persist wizard-collected profile fields atomically with the application
  // so admin review has complete data without requiring a separate profile-patch call.
  const profilePatch: Record<string, any> = {
    user_id: auth.user.id,
    city,
    country: country ?? null,
    categories,
    languages,
    updated_at: new Date().toISOString(),
  };
  if (typeof displayName === "string")                              profilePatch.display_name         = displayName;
  if (typeof bio === "string")                                      profilePatch.bio                  = bio;
  if (typeof hourlyRateUsd === "number" && Number.isFinite(hourlyRateUsd)) profilePatch.hourly_rate_usd = hourlyRateUsd;
  if (Array.isArray(availability))                                  profilePatch.availability_blocks  = availability;
  if (Array.isArray(zones))                                         profilePatch.preferred_meetup_zones = zones;
  if (Array.isArray(photos) && photos.length > 0)                   profilePatch.gallery_urls           = photos;

  const { data: profileRow, error: profileError } = await serviceClient
    .from("rent_buddy_profiles")
    .upsert(profilePatch, { onConflict: "user_id" })
    .select("display_name, bio, hourly_rate_usd, availability_blocks, preferred_meetup_zones")
    .maybeSingle();

  if (profileError) return sendError(res, "db_error", profileError.message);

  return res.status(201).json({
    application: mapApplication(data, profileRow),
    message: "Application submitted. Our team will review it soon.",
    policyText: POLICY_TEXT,
  });
});

// ── Buddy me profile ──────────────────────────────────────────────────────────

router.get("/rent-a-buddy/me/profile", async (req, res) => {
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

router.patch("/rent-a-buddy/me/profile", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const meProfileRollout = await checkRentBuddyAccess({ sc: serviceClient, userId: auth.user.id, action: "read" });
  if (!meProfileRollout.allowed) return res.status(meProfileRollout.httpStatus).json({ error: meProfileRollout.code, message: meProfileRollout.message });

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

  // Approximate meetup-base pin (privacy-safe, neighbourhood-level — never a
  // home address). Both coordinates must be set together; null clears the pin.
  if (body.meetupBaseLat !== undefined || body.meetupBaseLng !== undefined) {
    const latRaw = body.meetupBaseLat;
    const lngRaw = body.meetupBaseLng;
    if (latRaw === null && lngRaw === null) {
      patch.meetup_base_lat = null;
      patch.meetup_base_lng = null;
    } else if (
      typeof latRaw === "number" && Number.isFinite(latRaw) && latRaw >= -90 && latRaw <= 90 &&
      typeof lngRaw === "number" && Number.isFinite(lngRaw) && lngRaw >= -180 && lngRaw <= 180
    ) {
      patch.meetup_base_lat = latRaw;
      patch.meetup_base_lng = lngRaw;
    } else {
      return res.status(400).json({
        error: "invalid_meetup_base",
        message: "meetupBaseLat and meetupBaseLng must both be valid coordinates, or both null to clear.",
      });
    }
  }

  if (body.bio) {
    const matches = await scanForPolicyViolations({
      sc: serviceClient, text: body.bio, sourceType: "profile", flaggedUserId: auth.user.id,
    });
    await applyPolicySeverity({ sc: serviceClient, userId: auth.user.id, matches });
  }

  await serviceClient.from("rent_buddy_profiles").update(patch).eq("user_id", auth.user.id);
  return res.json({ ok: true });
});

router.patch("/rent-a-buddy/me/availability", async (req, res) => {
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

router.get("/rent-a-buddy/me/requests", async (req, res) => {
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

router.get("/rent-a-buddy/saved", async (req, res) => {
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

router.post("/rent-a-buddy/saved/:buddyId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  await serviceClient.from("rent_buddy_saved").upsert({ user_id: auth.user.id, buddy_id: req.params.buddyId });
  await syncFavoritesCount(serviceClient, req.params.buddyId);
  return res.json({ ok: true });
});

router.delete("/rent-a-buddy/saved/:buddyId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  await serviceClient.from("rent_buddy_saved").delete().eq("user_id", auth.user.id).eq("buddy_id", req.params.buddyId);
  await syncFavoritesCount(serviceClient, req.params.buddyId);
  return res.json({ ok: true });
});

// ── Waitlist ──────────────────────────────────────────────────────────────────

router.get("/rent-a-buddy/waitlist", async (req, res) => {
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

router.post("/rent-a-buddy/waitlist", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { city, category, lat, lng, desiredDate, desiredTime, budgetUsd, notes } = req.body ?? {};
  if (!city) return res.status(400).json({ error: "invalid_payload", message: "city required." });

  const latPresent = typeof lat === "number" && Number.isFinite(lat);
  const lngPresent = typeof lng === "number" && Number.isFinite(lng);
  if (latPresent !== lngPresent) {
    return res.status(400).json({ error: "invalid_payload", message: "lat and lng must both be provided together." });
  }

  const waitlistRollout = await checkRentBuddyAccess({
    sc: serviceClient, userId: auth.user.id,
    city, category, action: "waitlist",
  });
  if (!waitlistRollout.allowed) {
    return res.status(waitlistRollout.httpStatus).json({ error: waitlistRollout.code, message: waitlistRollout.message });
  }

  await serviceClient.from("rent_buddy_waitlist").upsert(
    {
      user_id: auth.user.id, city, category: category ?? null,
      lat: typeof lat === "number" && Number.isFinite(lat) ? lat : null,
      lng: typeof lng === "number" && Number.isFinite(lng) ? lng : null,
      desired_date: typeof desiredDate === "string" && desiredDate ? desiredDate.slice(0, 32) : null,
      desired_time: typeof desiredTime === "string" && desiredTime ? desiredTime.slice(0, 32) : null,
      budget_usd: typeof budgetUsd === "number" && Number.isFinite(budgetUsd) ? budgetUsd : null,
      notes: typeof notes === "string" && notes ? notes.slice(0, 2000) : null,
    },
    { onConflict: "user_id,city" },
  );

  return res.status(201).json({ ok: true });
});

router.delete("/rent-a-buddy/waitlist/:city", async (req, res) => {
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

router.get("/rent-a-buddy/dashboard", async (req, res) => {
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

router.get("/rent-a-buddy/dashboard/requests", async (req, res) => {
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

router.patch("/rent-a-buddy/dashboard/offer", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const offerRollout = await checkRentBuddyAccess({ sc: serviceClient, userId: auth.user.id, action: "read" });
  if (!offerRollout.allowed) return res.status(offerRollout.httpStatus).json({ error: offerRollout.code, message: offerRollout.message });

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

router.get("/rent-a-buddy/dashboard/availability", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id, available_now, min_notice_hours, buffer_minutes, max_bookings_per_day")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!bp) return res.json({ availability: [], settings: null });

  const today = new Date().toISOString().slice(0, 10);
  const { data } = await serviceClient
    .from("rent_buddy_availability")
    .select("*")
    .eq("buddy_id", (bp as any).id)
    .gte("date", today)
    .order("date");

  // Current/future vacation block (single range surfaced to the dashboard UI)
  const { data: vacations } = await serviceClient
    .from("buddy_availability_exceptions")
    .select("exception_date, end_date")
    .eq("buddy_id", (bp as any).id)
    .eq("exception_type", "vacation")
    .or(`end_date.gte.${today},and(end_date.is.null,exception_date.gte.${today})`)
    .order("exception_date")
    .limit(1);
  const vacation = (vacations ?? [])[0] as any | undefined;

  return res.json({
    availability: (data ?? []).map((av: any) => ({
      id: av.id, date: av.date, timeSlots: av.time_slots ?? [], isAvailable: av.is_available, notes: av.notes,
    })),
    settings: {
      availableNow: (bp as any).available_now ?? false,
      minNoticeHours: (bp as any).min_notice_hours ?? null,
      bufferMinutes: (bp as any).buffer_minutes ?? null,
      maxBookingsPerDay: (bp as any).max_bookings_per_day ?? null,
      blockedFrom: vacation?.exception_date ?? null,
      blockedTo: vacation?.end_date ?? vacation?.exception_date ?? null,
    },
  });
});

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.patch("/rent-a-buddy/dashboard/availability/settings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });

  const body = req.body ?? {};
  const { availableNow, minNoticeHours, bufferMinutes, maxBookingsPerDay, blockedFrom, blockedTo } = body;

  // Validate blocked range when provided (empty string = clear)
  const hasBlockedInput = blockedFrom !== undefined || blockedTo !== undefined;
  const from = typeof blockedFrom === "string" && blockedFrom.trim() ? blockedFrom.trim() : null;
  const to = typeof blockedTo === "string" && blockedTo.trim() ? blockedTo.trim() : null;
  if (from && !ISO_DATE_RE.test(from)) return res.status(400).json({ error: "invalid_blocked_from", message: "blockedFrom must be YYYY-MM-DD." });
  if (to && !ISO_DATE_RE.test(to)) return res.status(400).json({ error: "invalid_blocked_to", message: "blockedTo must be YYYY-MM-DD." });
  if (!from && to) return res.status(400).json({ error: "invalid_blocked_range", message: "blockedTo requires blockedFrom." });
  if (from && to && to < from) return res.status(400).json({ error: "invalid_blocked_range", message: "blockedTo must be on or after blockedFrom." });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (availableNow !== undefined) patch.available_now = !!availableNow;
  if (minNoticeHours !== undefined) patch.min_notice_hours = minNoticeHours == null ? null : Number(minNoticeHours);
  if (bufferMinutes !== undefined) patch.buffer_minutes = bufferMinutes == null ? null : Number(bufferMinutes);
  if (maxBookingsPerDay !== undefined) patch.max_bookings_per_day = maxBookingsPerDay == null ? null : Number(maxBookingsPerDay);

  if (Object.keys(patch).length > 1) {
    const { error } = await serviceClient.from("rent_buddy_profiles").update(patch).eq("id", (bp as any).id);
    if (error) return sendError(res, "db_error", error.message);
    // Invalidate the suggested-city cache when available_now changes
    if (availableNow !== undefined) invalidateSuggestedCityCache();
  }

  if (hasBlockedInput) {
    // Replace the buddy's vacation block with the new range (or just clear it)
    const { error: delError } = await serviceClient
      .from("buddy_availability_exceptions")
      .delete()
      .eq("buddy_id", (bp as any).id)
      .eq("exception_type", "vacation");
    if (delError) return sendError(res, "db_error", delError.message);

    if (from) {
      const { error: insError } = await serviceClient
        .from("buddy_availability_exceptions")
        .insert({
          buddy_id: (bp as any).id,
          exception_date: from,
          end_date: to ?? from,
          exception_type: "vacation",
          reason: "Vacation / blocked dates",
        });
      if (insError) return sendError(res, "db_error", insError.message);
    }
  }

  return res.json({ ok: true });
});

router.post("/rent-a-buddy/dashboard/availability", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });

  const availRollout = await checkRentBuddyAccess({ sc: serviceClient, userId: auth.user.id, action: "read" });
  if (!availRollout.allowed) return res.status(availRollout.httpStatus).json({ error: availRollout.code, message: availRollout.message });

  const { entries = [] } = req.body ?? {};
  const failures: string[] = [];
  for (const e of entries as any[]) {
    const { error } = await serviceClient.from("rent_buddy_availability").upsert(
      { buddy_id: (bp as any).id, date: e.date, time_slots: e.timeSlots ?? [], is_available: e.isAvailable ?? true, notes: e.notes ?? null },
      { onConflict: "buddy_id,date" },
    );
    if (error) {
      // Log the raw DB error for operators; the client only learns WHICH dates
      // failed, never the underlying Postgres/PostgREST text.
      req.log?.error({ err: error, date: e.date }, "rent_buddy_availability upsert failed");
      failures.push(String(e.date));
    }
  }
  if (failures.length > 0) {
    return sendError(
      res,
      "db_error",
      `Failed to save ${failures.length} of ${(entries as any[]).length} availability rows. Dates not saved: ${failures.join(", ")}.`,
      { exposeDetail: true },
    );
  }
  return res.json({ ok: true });
});

// ── Dashboard — Packages ──────────────────────────────────────────────────────

router.get("/rent-a-buddy/dashboard/packages", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.json({ packages: [] });
  const { data } = await serviceClient.from("rent_buddy_packages").select("*").eq("buddy_id", (bp as any).id).order("created_at");
  return res.json({ packages: data ?? [] });
});

router.post("/rent-a-buddy/dashboard/packages", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.status(404).json({ error: "profile_not_found" });

  const pkgCreateRollout = await checkRentBuddyAccess({ sc: serviceClient, userId: auth.user.id, action: "read" });
  if (!pkgCreateRollout.allowed) return res.status(pkgCreateRollout.httpStatus).json({ error: pkgCreateRollout.code, message: pkgCreateRollout.message });

  const { title, description, category, durationH, priceUsd, maxGroup = 1, stops, meetupRules } = req.body ?? {};
  if (!title || !category || !durationH || !priceUsd) {
    return res.status(400).json({ error: "invalid_payload", message: "title, category, durationH, priceUsd required." });
  }

  const { data, error } = await serviceClient.from("rent_buddy_packages").insert({
    buddy_id: (bp as any).id, title, description: description ?? null, category,
    duration_h: durationH, price_usd: priceUsd, max_group: maxGroup, is_active: true,
    stops: Array.isArray(stops) ? stops.filter((s: unknown) => typeof s === "string" && s).slice(0, 20) : [],
    meetup_rules: typeof meetupRules === "string" && meetupRules ? meetupRules.slice(0, 2000) : null,
    updated_at: new Date().toISOString(),
  }).select().maybeSingle();
  if (error) return sendError(res, "db_error", error.message);

  return res.status(201).json({ pkg: data });
});

router.patch("/rent-a-buddy/dashboard/packages/:packageId", async (req, res) => {
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
  if (body.stops !== undefined)       patch.stops       = Array.isArray(body.stops) ? body.stops.filter((s: unknown) => typeof s === "string" && s).slice(0, 20) : [];
  if (body.meetupRules !== undefined) patch.meetup_rules = typeof body.meetupRules === "string" && body.meetupRules ? body.meetupRules.slice(0, 2000) : null;

  await serviceClient.from("rent_buddy_packages").update(patch).eq("id", req.params.packageId).eq("buddy_id", (bp as any).id);
  return res.json({ ok: true });
});

router.delete("/rent-a-buddy/dashboard/packages/:packageId", async (req, res) => {
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

router.get("/rent-a-buddy/dashboard/addons", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient.from("rent_buddy_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
  if (!bp) return res.json({ addons: [] });
  const { data } = await serviceClient.from("rent_buddy_addons").select("*").eq("buddy_id", (bp as any).id).order("created_at");
  return res.json({ addons: data ?? [] });
});

router.post("/rent-a-buddy/dashboard/addons", async (req, res) => {
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

router.patch("/rent-a-buddy/dashboard/addons/:addonId", async (req, res) => {
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

router.delete("/rent-a-buddy/dashboard/addons/:addonId", async (req, res) => {
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

router.get("/rent-a-buddy/dashboard/earnings", async (req, res) => {
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

router.get("/rent-a-buddy/admin/applications", async (req, res) => {
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
  const rows = data ?? [];

  // Enrich with wizard-collected profile fields so the review page shows
  // everything in one place (no separate profile-tab lookup needed).
  const userIds = Array.from(new Set(rows.map((r: any) => r.user_id).filter(Boolean)));
  const profilesByUserId = new Map<string, any>();
  if (userIds.length > 0) {
    const { data: profileRows } = await serviceClient
      .from("rent_buddy_profiles")
      .select("user_id, display_name, bio, hourly_rate_usd, availability_blocks, preferred_meetup_zones")
      .in("user_id", userIds);
    for (const p of profileRows ?? []) profilesByUserId.set((p as any).user_id, p);
  }

  return res.json({
    applications: rows.map((r: any) => mapApplication(r, profilesByUserId.get(r.user_id))),
    total: count ?? 0,
  });
});

router.patch("/rent-a-buddy/admin/applications/:appId", async (req, res) => {
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

  // Training must be completed before a buddy can be approved.
  // Source of truth: rent_buddy_training_checklist (where training route writes),
  // keyed by application_id so no profile needs to exist yet.
  if (status === "approved") {
    const { count: trainedCount } = await serviceClient
      .from("rent_buddy_training_checklist")
      .select("id", { count: "exact" })
      .eq("application_id", appId)
      .eq("completed", true);
    if ((trainedCount ?? 0) < TRAINING_CHECKLIST_ITEMS.length) {
      return res.status(400).json({
        error: "training_incomplete",
        message: "Applicant must complete all required training before being approved as a Buddy.",
      });
    }
  }

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

router.get("/rent-a-buddy/admin/buddies", async (req, res) => {
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

router.post("/rent-a-buddy/admin/buddies/:buddyId/suspend", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient, userId } = admin;
  const { buddyId } = req.params;
  const { reason } = req.body ?? {};
  const { data: buddy } = await serviceClient.from("rent_buddy_profiles").select("id, user_id").eq("id", buddyId).maybeSingle();
  if (!buddy) return res.status(404).json({ error: "not_found" });
  await serviceClient.from("rent_buddy_profiles").update({ admin_status: "disabled", status: "suspended", updated_at: new Date().toISOString() }).eq("id", buddyId);
  await serviceClient.from("rent_buddy_admin_actions").insert({ admin_id: userId, target_type: "buddy", target_id: buddyId, action: "suspended", notes: reason ?? null });
  // Await before response so suspended buddy's cache is evicted before 200
  if ((buddy as any).user_id) await invalidateCompassCache(serviceClient, (buddy as any).user_id as string, "buddy_suspend");
  return res.json({ ok: true });
});

router.post("/rent-a-buddy/admin/buddies/:buddyId/reactivate", async (req, res) => {
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

router.post("/rent-a-buddy/admin/buddies/:buddyId/feature", async (req, res) => {
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

router.post("/rent-a-buddy/admin/buddies/:buddyId/unfeature", async (req, res) => {
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

router.patch("/rent-a-buddy/admin/buddies/:buddyId/level", async (req, res) => {
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

router.patch("/rent-a-buddy/admin/buddies/:buddyId/categories", async (req, res) => {
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

// ── Admin — review moderation ─────────────────────────────────────────────────

router.post("/rent-a-buddy/admin/reviews/:reviewId/approve", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient, userId } = admin;
  const { reviewId } = req.params;

  const { data: review } = await serviceClient
    .from("rent_buddy_reviews")
    .select("*")
    .eq("id", reviewId)
    .maybeSingle();
  if (!review) return res.status(404).json({ error: "not_found" });

  await serviceClient
    .from("rent_buddy_reviews")
    .update({ is_public: true, moderation_status: "approved", updated_at: new Date().toISOString() })
    .eq("id", reviewId);

  // Recalculate average_rating and review_count on the buddy's profile using
  // only approved (public) reviews where the reviewer is the traveler role
  const revieweeId = (review as any).reviewee_id as string;
  const { data: approvedRows } = await serviceClient
    .from("rent_buddy_reviews")
    .select("rating")
    .eq("reviewee_id", revieweeId)
    .eq("role", "traveler")
    .in("moderation_status", ["approved", "auto_approved"]);

  // Recalculate even when count is zero (e.g. first ever approve after all were rejected)
  const { data: buddyProfileForApprove } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", revieweeId)
    .maybeSingle();

  if (buddyProfileForApprove) {
    if (approvedRows && approvedRows.length > 0) {
      const sum = approvedRows.reduce((acc: number, r: any) => acc + Number(r.rating), 0);
      const avg = Math.round((sum / approvedRows.length) * 100) / 100;
      await serviceClient
        .from("rent_buddy_profiles")
        .update({ average_rating: avg, review_count: approvedRows.length, updated_at: new Date().toISOString() })
        .eq("id", (buddyProfileForApprove as any).id);
    } else {
      // Zero approved traveler reviews — reset aggregates
      await serviceClient
        .from("rent_buddy_profiles")
        .update({ average_rating: 0, review_count: 0, updated_at: new Date().toISOString() })
        .eq("id", (buddyProfileForApprove as any).id);
    }
  }

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: userId, target_type: "review", target_id: reviewId,
    action: "review_approved", notes: null,
  });

  return res.json({ ok: true });
});

router.post("/rent-a-buddy/admin/reviews/:reviewId/reject", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient, userId } = admin;
  const { reviewId } = req.params;
  const { reason } = req.body ?? {};

  const { data: review } = await serviceClient
    .from("rent_buddy_reviews")
    .select("id, reviewee_id")
    .eq("id", reviewId)
    .maybeSingle();
  if (!review) return res.status(404).json({ error: "not_found" });

  await serviceClient
    .from("rent_buddy_reviews")
    .update({ is_public: false, moderation_status: "rejected", updated_at: new Date().toISOString() })
    .eq("id", reviewId);

  // Recalculate buddy rating after rejection — the rejected review may have been public
  const rejectedRevieweeId = (review as any).reviewee_id as string;
  const { data: remainingRows } = await serviceClient
    .from("rent_buddy_reviews")
    .select("rating")
    .eq("reviewee_id", rejectedRevieweeId)
    .eq("role", "traveler")
    .in("moderation_status", ["approved", "auto_approved"]);

  const { data: buddyProfileForReject } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", rejectedRevieweeId)
    .maybeSingle();

  if (buddyProfileForReject) {
    if (remainingRows && remainingRows.length > 0) {
      const sum = remainingRows.reduce((acc: number, r: any) => acc + Number(r.rating), 0);
      const avg = Math.round((sum / remainingRows.length) * 100) / 100;
      await serviceClient
        .from("rent_buddy_profiles")
        .update({ average_rating: avg, review_count: remainingRows.length, updated_at: new Date().toISOString() })
        .eq("id", (buddyProfileForReject as any).id);
    } else {
      await serviceClient
        .from("rent_buddy_profiles")
        .update({ average_rating: 0, review_count: 0, updated_at: new Date().toISOString() })
        .eq("id", (buddyProfileForReject as any).id);
    }
  }

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: userId, target_type: "review", target_id: reviewId,
    action: "review_rejected", notes: reason ?? null,
  });

  return res.json({ ok: true });
});

router.get("/rent-a-buddy/admin/reviews", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient } = admin;
  const moderationStatus = (req.query.moderationStatus as string) ?? "pending_moderation";
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;

  const { data, count, error } = await serviceClient
    .from("rent_buddy_reviews")
    .select("*", { count: "exact" })
    .eq("moderation_status", moderationStatus)
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (error) return sendError(res, "db_error", error.message);
  return res.json({ reviews: data ?? [], total: count ?? 0, page });
});

router.get("/rent-a-buddy/admin/bookings", async (req, res) => {
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

router.get("/rent-a-buddy/admin/analytics", async (req, res) => {
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

router.get("/rent-a-buddy/admin/safety/flags", async (req, res) => {
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

router.post("/rent-a-buddy/admin/safety/flags/:flagId/dismiss", async (req, res) => {
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

router.post("/rent-a-buddy/admin/safety/flags/:flagId/confirm", async (req, res) => {
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

router.post("/rent-a-buddy/admin/safety/flags/:flagId/escalate", async (req, res) => {
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

router.get("/rent-a-buddy/admin/safety/events", async (req, res) => {
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

router.post("/rent-a-buddy/admin/users/:userId/limits", async (req, res) => {
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

router.patch("/rent-a-buddy/admin/users/:userId/limits", async (req, res) => {
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


// ══════════════════════════════════════════════════════════════════════════════
// COMPLIANCE & LAUNCH HARDENING — added in 0051 migration cycle
// ══════════════════════════════════════════════════════════════════════════════

// ── Legal disclaimer constants ─────────────────────────────────────────────────

export const DISCLAIMER_MAIN =
  "Rent a Buddy is a local guide and travel companionship service. It is not a dating, escort, adult-service, romantic, or sexual-service platform. All meetups start at public locations. Both parties are responsible for their own safety and compliance with local laws.";

export const DISCLAIMER_ADULT_SERVICE =
  "This platform strictly prohibits adult services, sexual services, escort services, or any romantic or intimate service arrangement. Any request or offer of such services will result in immediate account suspension and may be reported to authorities.";

export const DISCLAIMER_EMERGENCY =
  "In a genuine emergency, call local emergency services immediately (112 / 911 / 999). This app's safety tools are a supplement, not a replacement, for emergency services. Share your location with a trusted contact before any meetup.";

export const DISCLAIMER_TRANSPORTATION =
  "Rent a Buddy does not provide licensed transportation, licensed tour guide services, or professional driver services. Buddies who offer travel support do so as fellow community members, not as licensed professionals. Transport features are not currently available.";

// ── Nightlife prohibited-behavior patterns ────────────────────────────────────

const NIGHTLIFE_PROHIBITED_PATTERNS = [
  /\bunapproved\s+guest/i,
  /\bbringing\s+extra\s+people\b/i,
  /\bprivate\s+after\s+party/i,
  /\bafter\s+hours\s+at\s+my\s+place\b/i,
  /\bafter\s+hours\s+at\s+hotel\b/i,
];

function hasNightlifeProhibitedContent(text: string): boolean {
  return NIGHTLIFE_PROHIBITED_PATTERNS.some((p) => p.test(text));
}

// ── Privacy-strip helpers ──────────────────────────────────────────────────────

function stripTravelerPrivateFields(travelerRow: any): any {
  if (!travelerRow) return null;
  const { legal_name, id_document_ref, hotel_address, exact_location, home_address, ...safe } = travelerRow;
  return safe;
}

function stripBuddyPrivateFields(buddyRow: any, confirmed: boolean): any {
  if (!buddyRow) return null;
  if (confirmed) return buddyRow;
  const { id_verification_ref, legal_name, exact_address, home_address, phone_number, ...safe } = buddyRow;
  return safe;
}

// ── Launch control helpers ─────────────────────────────────────────────────────

async function getLaunchControl(
  client: any,
  { countryCode, city, category }: { countryCode?: string; city?: string; category?: string },
): Promise<{
  enabled: boolean;
  waitlistOnly: boolean;
  minAge: number;
  nightlifeMinAge: number;
  requireIdVerification: boolean;
  requirePhoneVerification: boolean;
  fullPaymentRequired: boolean;
} | null> {
  const queries: Array<{ country_code: string | null; city: string | null; category: string | null }> = [];

  if (category && city && countryCode) queries.push({ country_code: countryCode, city, category });
  if (category && countryCode) queries.push({ country_code: countryCode, city: null, category });
  if (city && countryCode) queries.push({ country_code: countryCode, city, category: null });
  // Country-wide catch-all (country-level gating without city/category specificity)
  if (countryCode) queries.push({ country_code: countryCode, city: null, category: null });
  if (category) queries.push({ country_code: null, city: null, category });
  queries.push({ country_code: null, city: null, category: null });

  for (const q of queries) {
    let query = client.from("rent_buddy_launch_controls").select("*");
    if (q.country_code !== undefined) {
      query = q.country_code === null ? query.is("country_code", null) : query.eq("country_code", q.country_code);
    }
    if (q.city !== undefined) {
      query = q.city === null ? query.is("city", null) : query.eq("city", q.city);
    }
    if (q.category !== undefined) {
      query = q.category === null ? query.is("category", null) : query.eq("category", q.category);
    }
    const { data } = await query.maybeSingle();
    if (data) {
      return {
        enabled: (data as any).enabled,
        waitlistOnly: (data as any).waitlist_only,
        minAge: (data as any).min_age ?? 18,
        nightlifeMinAge: (data as any).nightlife_min_age ?? 21,
        requireIdVerification: (data as any).require_id_verification ?? true,
        requirePhoneVerification: (data as any).require_phone_verification ?? true,
        fullPaymentRequired: (data as any).full_payment_required ?? false,
      };
    }
  }
  return null;
}

// ── Eligibility check ──────────────────────────────────────────────────────────

router.get("/rent-a-buddy/me/eligibility", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const serviceClient = sc(client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const category = (req.query.category as string) ?? null;
  const city = (req.query.city as string) ?? undefined;
  const countryCode = (req.query.country as string) ?? undefined;
  const isNightlife = category === "nightlife";

  // Load launch-control requirements for this city/country/category so eligibility
  // reflects the policy-of-record rather than hardcoded constants
  // This endpoint answers "can I, the TRAVELLER, book?" — so identity, age and
  // phone come from `profiles`. It previously read them from rent_buddy_profiles
  // and so returned eligible:false with reason "age_unverified" for every user
  // who had never applied to become a buddy, i.e. for every actual traveller.
  // The buddy row is still loaded, but only for the buddy-side risk status.
  // `training_completed` was selected here and then never used — dropped rather
  // than gated on, since a traveller's eligibility to book cannot depend on
  // whether they finished BUDDY safety training.
  const [launchCtrl, travIdentity, profileRes, limits] = await Promise.all([
    getLaunchControl(serviceClient, { city, countryCode, category: category ?? undefined }),
    loadTravelerIdentity(serviceClient, user.id),
    serviceClient
      .from("rent_buddy_profiles")
      .select("id, risk_review_status")
      .eq("user_id", user.id)
      .maybeSingle(),
    getUserLimits(serviceClient, user.id),
  ]);

  const profile = profileRes.data;
  const minAge = launchCtrl?.minAge ?? 18;
  const nightlifeMinAge = launchCtrl?.nightlifeMinAge ?? 21;
  // Fail CLOSED when no launch-control row matches. getLaunchControl already
  // defaults these to true when a row EXISTS; defaulting to false when none did
  // meant "no policy of record" was the most permissive state in the system.
  const requireId = launchCtrl?.requireIdVerification ?? true;
  const requirePhone = launchCtrl?.requirePhoneVerification ?? true;

  const reasons: string[] = [];

  if (limits?.rent_buddy_disabled || limits?.traveler_booking_disabled) {
    reasons.push("account_restricted");
  }

  const riskStatus = profile ? (profile as any).risk_review_status : "normal";
  if (riskStatus === "suspended") reasons.push("account_suspended");
  if (riskStatus === "under_review") reasons.push("account_under_review");

  const phoneVerified = travIdentity.phoneVerified;
  if (requirePhone && !phoneVerified) reasons.push("phone_not_verified");

  const idVerified = travIdentity.idVerified;
  if (requireId && !idVerified) reasons.push("id_not_verified");

  let ageOk = true;
  const age: number | null = travIdentity.age;
  if (age !== null) {
    if (age < minAge) { reasons.push(`age_under_${minAge}`); ageOk = false; }
    if (isNightlife && age < nightlifeMinAge) { reasons.push(`nightlife_requires_${nightlifeMinAge}`); ageOk = false; }
  } else {
    reasons.push("age_unverified");
    ageOk = false;
  }

  if (isNightlife && limits?.nightlife_disabled) reasons.push("nightlife_access_restricted");

  const eligible = reasons.length === 0;

  return res.json({
    eligible,
    reasons,
    age,
    ageOk,
    phoneVerified,
    idVerified,
    riskStatus,
    disclaimers: {
      main: DISCLAIMER_MAIN,
      adultService: DISCLAIMER_ADULT_SERVICE,
      emergency: DISCLAIMER_EMERGENCY,
    },
  });
});

// ── Location availability & launch status ──────────────────────────────────────

router.get("/rent-a-buddy/availability/location", async (req, res) => {
  const serviceClient = sc();
  if (!serviceClient) return res.json({ available: false, waitlistOnly: false, reason: "service_unavailable" });

  const globalEnabled = await checkRentBuddyEnabled(serviceClient);
  if (!globalEnabled) return res.json({ available: false, waitlistOnly: false, reason: "feature_disabled" });

  const countryCode = (req.query.country as string) ?? undefined;
  const city = (req.query.city as string) ?? undefined;
  const category = (req.query.category as string) ?? undefined;

  const control = await getLaunchControl(serviceClient, { countryCode, city, category });

  if (!control) {
    return res.json({ available: false, waitlistOnly: true, reason: "city_not_launched" });
  }

  if (!control.enabled && !control.waitlistOnly) {
    return res.json({ available: false, waitlistOnly: false, reason: "city_disabled" });
  }

  if (!control.enabled && control.waitlistOnly) {
    return res.json({ available: false, waitlistOnly: true, reason: "waitlist_only",
      minAge: control.minAge, nightlifeMinAge: control.nightlifeMinAge });
  }

  return res.json({
    available: true,
    waitlistOnly: false,
    minAge: control.minAge,
    nightlifeMinAge: control.nightlifeMinAge,
    requireIdVerification: control.requireIdVerification,
    requirePhoneVerification: control.requirePhoneVerification,
    fullPaymentRequired: control.fullPaymentRequired,
    disclaimers: {
      main: DISCLAIMER_MAIN,
      emergency: DISCLAIMER_EMERGENCY,
    },
  });
});

router.get("/rent-a-buddy/launch-status", async (req, res) => {
  const serviceClient = sc();
  if (!serviceClient) return res.json({ enabled: false, categories: {} });

  const globalEnabled = await checkRentBuddyEnabled(serviceClient);
  if (!globalEnabled) return res.json({ enabled: false, categories: {} });

  const { data } = await serviceClient
    .from("rent_buddy_launch_controls")
    .select("category, enabled, waitlist_only, min_age, nightlife_min_age")
    .is("country_code", null)
    .is("city", null);

  const categories: Record<string, { enabled: boolean; waitlistOnly: boolean; minAge: number }> = {};
  for (const row of (data ?? []) as any[]) {
    if (row.category) {
      categories[row.category] = {
        enabled: row.enabled,
        waitlistOnly: row.waitlist_only,
        minAge: row.category === "nightlife" ? row.nightlife_min_age : row.min_age,
      };
    }
  }

  return res.json({ enabled: globalEnabled, categories });
});

// ── Admin — Launch controls CRUD ──────────────────────────────────────────────

router.get("/rent-a-buddy/admin/launch-controls", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient } = admin;

  const { data } = await serviceClient
    .from("rent_buddy_launch_controls")
    .select("*")
    .order("category");

  return res.json({ controls: data ?? [] });
});

router.post("/rent-a-buddy/admin/launch-controls", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient, userId } = admin;

  const {
    countryCode = null, city = null, category = null, enabled = false,
    waitlistOnly = false, minAge = 18, nightlifeMinAge = 21,
    requireIdVerification = true, requirePhoneVerification = true,
    fullPaymentRequired = false, minDepositPct = 30, notes,
  } = req.body ?? {};

  // PostgreSQL NULLs do not satisfy UNIQUE equality, so onConflict with nullable columns
  // is unreliable. Use an explicit select-then-update/insert pattern instead.
  let findQuery = serviceClient.from("rent_buddy_launch_controls").select("id");
  findQuery = countryCode ? findQuery.eq("country_code", countryCode) : findQuery.is("country_code", null);
  findQuery = city ? findQuery.eq("city", city) : findQuery.is("city", null);
  findQuery = category ? findQuery.eq("category", category) : findQuery.is("category", null);
  const { data: existing } = await findQuery.maybeSingle();

  const controlPayload: Record<string, unknown> = {
    enabled,
    waitlist_only: waitlistOnly,
    min_age: minAge,
    nightlife_min_age: nightlifeMinAge,
    require_id_verification: requireIdVerification,
    require_phone_verification: requirePhoneVerification,
    full_payment_required: fullPaymentRequired,
    min_deposit_pct: minDepositPct,
    notes: notes ?? null,
    updated_at: new Date().toISOString(),
  };

  let data: unknown, error: unknown;
  if (existing) {
    ({ data, error } = await serviceClient
      .from("rent_buddy_launch_controls")
      .update(controlPayload)
      .eq("id", (existing as any).id)
      .select()
      .maybeSingle());
  } else {
    ({ data, error } = await serviceClient
      .from("rent_buddy_launch_controls")
      .insert({ ...controlPayload, country_code: countryCode, city, category, created_by: userId })
      .select()
      .maybeSingle());
  }

  if (error) return sendError(res, "db_error", String((error as any).message ?? error));

  await serviceClient.from("rent_buddy_admin_access_logs").insert({
    admin_id: userId,
    resource: "launch_control",
    resource_id: category ?? "global",
    reason: `Created/updated launch control: enabled=${enabled}`,
  });

  return res.status(201).json({ control: data, ok: true });
});

router.patch("/rent-a-buddy/admin/launch-controls/:controlId", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient, userId } = admin;

  const { controlId } = req.params;
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  const b = req.body ?? {};

  if (b.enabled !== undefined)                 patch.enabled                  = b.enabled;
  if (b.waitlistOnly !== undefined)            patch.waitlist_only            = b.waitlistOnly;
  if (b.minAge !== undefined)                  patch.min_age                  = b.minAge;
  if (b.nightlifeMinAge !== undefined)         patch.nightlife_min_age        = b.nightlifeMinAge;
  if (b.requireIdVerification !== undefined)   patch.require_id_verification  = b.requireIdVerification;
  if (b.requirePhoneVerification !== undefined)patch.require_phone_verification = b.requirePhoneVerification;
  if (b.fullPaymentRequired !== undefined)     patch.full_payment_required    = b.fullPaymentRequired;
  if (b.notes !== undefined)                   patch.notes                    = b.notes;

  await serviceClient.from("rent_buddy_launch_controls").update(patch).eq("id", controlId);

  await serviceClient.from("rent_buddy_admin_access_logs").insert({
    admin_id: userId, resource: "launch_control", resource_id: controlId,
    reason: `Patched launch control`,
  });

  return res.json({ ok: true });
});

// ── Mutual tagging consent ─────────────────────────────────────────────────────

router.post("/rent-a-buddy/bookings/:bookingId/tag-consent", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const serviceClient = sc(client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { targetUserId, postId } = req.body ?? {};

  if (!targetUserId) return res.status(400).json({ error: "invalid_payload", message: "targetUserId required" });

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings").select("id, traveler_id, buddy_id, status, safety_status")
    .eq("id", bookingId).maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  const party = await requireBookingParty(serviceClient, booking, user.id, res);
  if (!party) return;

  // Validate targetUserId is exactly the opposite booking party
  const validTargets = [party.buddyUserId, (booking as any).traveler_id].filter((id) => id !== user.id);
  if (!validTargets.includes(targetUserId)) {
    return res.status(400).json({
      error: "invalid_target",
      message: "Tag consent can only be requested between the two booking parties.",
    });
  }

  const bStatus = (booking as any).status;
  if (bStatus === "disputed") {
    return res.status(403).json({ error: "consent_blocked", message: "Tagging consent is paused while this booking is disputed." });
  }
  const safetyStatus = (booking as any).safety_status;
  if (safetyStatus === "emergency") {
    return res.status(403).json({ error: "consent_blocked", message: "Tagging consent is paused due to an active safety flag." });
  }

  const { data: existing } = await serviceClient
    .from("rent_buddy_tag_consents")
    .select("id, consent_status")
    .eq("booking_id", bookingId)
    .eq("requester_id", user.id)
    .eq("target_id", targetUserId)
    .maybeSingle();

  if (existing) {
    return res.json({ consentId: (existing as any).id, status: (existing as any).consent_status, alreadyExists: true });
  }

  const { data: consent } = await serviceClient.from("rent_buddy_tag_consents").insert({
    booking_id: bookingId,
    requester_id: user.id,
    target_id: targetUserId,
    post_id: postId ?? null,
    consent_status: "pending",
  }).select().maybeSingle();

  return res.status(201).json({ consent, ok: true });
});

router.post("/rent-a-buddy/tag-consents/:consentId/approve", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const serviceClient = sc(client);

  const { consentId } = req.params;
  const { data: consent } = await serviceClient
    .from("rent_buddy_tag_consents").select("*").eq("id", consentId).maybeSingle();

  if (!consent) return res.status(404).json({ error: "not_found" });
  if ((consent as any).target_id !== user.id) return res.status(403).json({ error: "forbidden" });

  await serviceClient.from("rent_buddy_tag_consents").update({
    consent_status: "approved", resolved_at: new Date().toISOString(),
  }).eq("id", consentId);

  return res.json({ ok: true });
});

router.post("/rent-a-buddy/tag-consents/:consentId/decline", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const serviceClient = sc(client);

  const { consentId } = req.params;
  const { data: consent } = await serviceClient
    .from("rent_buddy_tag_consents").select("*").eq("id", consentId).maybeSingle();

  if (!consent) return res.status(404).json({ error: "not_found" });
  if ((consent as any).target_id !== user.id) return res.status(403).json({ error: "forbidden" });

  await serviceClient.from("rent_buddy_tag_consents").update({
    consent_status: "declined",
    decline_reason: req.body?.reason ?? null,
    resolved_at: new Date().toISOString(),
  }).eq("id", consentId);

  return res.json({ ok: true });
});

router.delete("/rent-a-buddy/tag-consents/:consentId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const serviceClient = sc(client);

  const { consentId } = req.params;
  const { data: consent } = await serviceClient
    .from("rent_buddy_tag_consents").select("*").eq("id", consentId).maybeSingle();

  if (!consent) return res.status(404).json({ error: "not_found" });
  const c = consent as any;
  if (c.requester_id !== user.id && c.target_id !== user.id) return res.status(403).json({ error: "forbidden" });

  await serviceClient.from("rent_buddy_tag_consents").update({
    consent_status: "removed", resolved_at: new Date().toISOString(),
  }).eq("id", consentId);

  return res.json({ ok: true });
});

// ── Support / dispute structured reports ───────────────────────────────────────

const SUPPORT_WINDOWS: Record<string, number | null> = {
  safety: null,        // safety reports always accepted
  emergency: null,
  harassment: null,
  adult_service_violation: null,
  cash_dispute: 72,    // hours
  refund_request: 72,
  buddy_no_show: 48,
  traveler_no_show: 48,
  venue_scam: 168,     // 7 days
  off_app_payment: 168,
  route_changed: 168,
  fake_profile: 168,
  other: 168,
};

router.post("/rent-a-buddy/bookings/:bookingId/support/report", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const serviceClient = sc(client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { category, details } = req.body ?? {};

  const VALID_CATEGORIES = [
    "buddy_no_show","traveler_no_show","cash_dispute","harassment",
    "adult_service_violation","off_app_payment","route_changed",
    "venue_scam","refund_request","fake_profile","emergency","other",
  ];

  if (!category || !VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: "invalid_payload", message: `category must be one of: ${VALID_CATEGORIES.join(", ")}` });
  }

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings").select("id, traveler_id, buddy_id, status, completed_at")
    .eq("id", bookingId).maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  const party = await requireBookingParty(serviceClient, booking, user.id, res);
  if (!party) return;

  const windowH = SUPPORT_WINDOWS[category] ?? SUPPORT_WINDOWS.other!;
  const safetyAlwaysAllowed = ["emergency","harassment","adult_service_violation"].includes(category);

  if (!safetyAlwaysAllowed && windowH !== null && (booking as any).completed_at) {
    const completedAt = new Date((booking as any).completed_at).getTime();
    const hoursElapsed = (Date.now() - completedAt) / 3_600_000;
    if (hoursElapsed > windowH) {
      return res.status(400).json({
        error: "report_window_expired",
        message: `${category} reports must be filed within ${windowH} hours of booking completion.`,
      });
    }
  }

  const { data: templateRow } = await serviceClient
    .from("rent_buddy_admin_response_templates")
    .select("id, title, body")
    .eq("category", category)
    .eq("is_active", true)
    .maybeSingle();

  const { data: report, error } = await serviceClient.from("rent_buddy_support_reports").insert({
    booking_id: bookingId,
    reporter_id: user.id,
    category,
    details: details ?? null,
    status: "open",
    template_id: templateRow ? (templateRow as any).id : null,
  }).select().maybeSingle();

  if (error) return sendError(res, "db_error", error.message);

  if (category === "venue_scam") {
    // Aggregate venue_scam complaints per buddy across ALL their bookings
    // to detect repeat-abuse patterns, not just reports on a single trip
    const { data: buddyBookings } = await serviceClient
      .from("rent_buddy_bookings")
      .select("id")
      .eq("buddy_id", (booking as any).buddy_id);
    const buddyBookingIds = (buddyBookings ?? []).map((b: any) => b.id);

    const { count: priorScamCount } = buddyBookingIds.length > 0
      ? await serviceClient
          .from("rent_buddy_support_reports")
          .select("id", { count: "exact" })
          .eq("category", "venue_scam")
          .in("booking_id", buddyBookingIds)
      : { count: 0 };

    const totalScams = (priorScamCount ?? 0);
    if (totalScams >= 2) {
      await serviceClient.from("rent_buddy_safety_events").insert({
        booking_id: bookingId,
        actor_user_id: user.id,
        event_type: "venue_scam_complaint",
        event_status: "open",
        metadata: { buddyId: (booking as any).buddy_id, reportCount: totalScams + 1 },
      });
    }
  }

  return res.status(201).json({
    report,
    templateResponse: templateRow ? { title: (templateRow as any).title, body: (templateRow as any).body } : null,
    ok: true,
  });
});

router.get("/rent-a-buddy/admin/support/reports", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient } = admin;

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const status = (req.query.status as string) ?? "open";

  let query = serviceClient
    .from("rent_buddy_support_reports")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (status) query = query.eq("status", status);

  const { data, count } = await query;
  return res.json({ reports: data ?? [], total: count ?? 0 });
});

router.patch("/rent-a-buddy/admin/support/reports/:reportId", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient } = admin;

  const { reportId } = req.params;
  const { status, adminNotes } = req.body ?? {};

  const VALID_STATUSES = ["open", "in_review", "resolved", "closed"];
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      error: "invalid_payload",
      message: `status must be one of: ${VALID_STATUSES.join(", ")}.`,
    });
  }

  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (status) patch.status = status;
  if (adminNotes !== undefined) patch.admin_notes = adminNotes;
  if (status === "resolved" || status === "closed") patch.resolved_at = new Date().toISOString();

  const { error: updateErr } = await serviceClient
    .from("rent_buddy_support_reports")
    .update(patch)
    .eq("id", reportId);
  if (updateErr) return sendError(res, "db_error", updateErr.message);
  return res.json({ ok: true });
});

router.get("/rent-a-buddy/admin/support/templates", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient } = admin;

  const { data } = await serviceClient
    .from("rent_buddy_admin_response_templates")
    .select("*")
    .order("category");

  return res.json({ templates: data ?? [] });
});

// ── Risk review status ─────────────────────────────────────────────────────────

router.get("/rent-a-buddy/admin/risk-review", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient } = admin;

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = 50;
  const status = (req.query.status as string) ?? "watch";

  const { data, count } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id, user_id, display_name, city, risk_review_status, risk_review_note, risk_reviewed_at", { count: "exact" })
    .eq("risk_review_status", status)
    .order("risk_reviewed_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  return res.json({ profiles: data ?? [], total: count ?? 0 });
});

router.post("/rent-a-buddy/admin/users/:userId/risk-status", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient, userId: adminId } = admin;

  const { userId } = req.params;
  const { status, note } = req.body ?? {};

  const VALID_STATUSES = ["normal","watch","limited","under_review","suspended"];
  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: "invalid_payload", message: `status must be one of: ${VALID_STATUSES.join(", ")}` });
  }

  await serviceClient.from("rent_buddy_profiles").update({
    risk_review_status: status,
    risk_review_note: note ?? null,
    risk_reviewed_at: new Date().toISOString(),
  }).eq("user_id", userId);

  if (status === "suspended") {
    await serviceClient.from("rent_buddy_user_limits").upsert(
      { user_id: userId, rent_buddy_disabled: true, reason: `Risk status: ${status}`, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  }

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: adminId,
    target_type: "user",
    target_id: userId,
    action: `risk_status_set_${status}`,
    notes: note ?? null,
  });

  await serviceClient.from("rent_buddy_admin_access_logs").insert({
    admin_id: adminId, resource: "user_risk_status", resource_id: userId,
    reason: `Risk status updated to ${status}`,
  });

  return res.status(201).json({ ok: true });
});

// ── Repeat-abuse pattern detector (run on-demand by admin or triggered job) ────

router.post("/rent-a-buddy/admin/run-risk-scan", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient } = admin;

  const flagged: Array<{ userId: string; reason: string; elevatedTo: string }> = [];
  const now = new Date();
  const windowDays = Number(req.body?.windowDays ?? 30);
  const since = new Date(now.getTime() - windowDays * 86400000).toISOString();

  const PATTERN_THRESHOLDS: Array<{ eventType: string; threshold: number; riskLevel: string; reason: string }> = [
    { eventType: "private_meetup_violation",  threshold: 2, riskLevel: "watch",        reason: "repeated_private_meetup_complaints" },
    { eventType: "emergency_phrase_triggered",threshold: 2, riskLevel: "under_review", reason: "repeated_nightlife_safety_events" },
    { eventType: "harassment_reported",       threshold: 2, riskLevel: "under_review", reason: "repeated_harassment_reports" },
    { eventType: "off_app_payment_attempt",   threshold: 2, riskLevel: "limited",      reason: "repeated_off_app_payment_attempts" },
    { eventType: "no_show",                   threshold: 3, riskLevel: "watch",        reason: "repeated_no_shows" },
    { eventType: "comfort_check_distress",    threshold: 3, riskLevel: "watch",        reason: "repeated_distress_checkins" },
  ];

  for (const pt of PATTERN_THRESHOLDS) {
    const { data: events } = await serviceClient
      .from("rent_buddy_safety_events")
      .select("target_user_id")
      .eq("event_type", pt.eventType)
      .gte("created_at", since);

    const counts: Record<string, number> = {};
    for (const ev of (events ?? []) as any[]) {
      if (ev.target_user_id) counts[ev.target_user_id] = (counts[ev.target_user_id] ?? 0) + 1;
    }

    for (const [uid, cnt] of Object.entries(counts)) {
      if (cnt >= pt.threshold) {
        const { data: profile } = await serviceClient
          .from("rent_buddy_profiles")
          .select("risk_review_status")
          .eq("user_id", uid)
          .maybeSingle();

        const currentRisk = (profile as any)?.risk_review_status ?? "normal";
        const riskOrder = ["normal","watch","limited","under_review","suspended"];
        const currentIdx = riskOrder.indexOf(currentRisk);
        const newIdx = riskOrder.indexOf(pt.riskLevel);

        if (newIdx > currentIdx) {
          await serviceClient.from("rent_buddy_profiles").update({
            risk_review_status: pt.riskLevel,
            risk_review_note: `Auto-elevated: ${pt.reason} (${cnt} events in ${windowDays}d)`,
            risk_reviewed_at: new Date().toISOString(),
          }).eq("user_id", uid);

          flagged.push({ userId: uid, reason: pt.reason, elevatedTo: pt.riskLevel });
        }
      }
    }
  }

  return res.json({ ok: true, flagged, scannedAt: now.toISOString() });
});

// ── Training checklist ─────────────────────────────────────────────────────────

export const TRAINING_CHECKLIST_ITEMS = [
  { key: "safety_policy",           label: "Read and understood the Safety & Conduct Policy" },
  { key: "no_adult_services",       label: "Confirmed: no adult, escort, or romantic services" },
  { key: "public_meetup_rule",      label: "Confirmed: all first meetups in public locations" },
  { key: "emergency_protocol",      label: "Completed emergency protocol training" },
  { key: "in_app_payment_only",     label: "Confirmed: all payments through the app" },
  { key: "no_off_app_contact",      label: "Confirmed: no sharing personal contact off-app before confirmation" },
  { key: "reporting_obligations",   label: "Understood: how to report policy violations" },
  { key: "trust_score_explained",   label: "Understood: how Trust Score affects your profile" },
  { key: "cancellation_policy",     label: "Read and understood the Cancellation & No-Show Policy" },
  { key: "nightlife_rules",         label: "Read the Nightlife Guide rules (public meetup required, no unapproved guests, Safe Return prompt)" },
];

router.get("/rent-a-buddy/me/training-checklist", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const serviceClient = sc(client);

  const { data: app } = await serviceClient
    .from("rent_buddy_applications")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!app) return res.json({ checklist: TRAINING_CHECKLIST_ITEMS.map(i => ({ ...i, completed: false })), allComplete: false });

  const { data: rows } = await serviceClient
    .from("rent_buddy_training_checklist")
    .select("item_key, completed")
    .eq("application_id", (app as any).id);

  const completedSet = new Set(
    ((rows ?? []) as any[]).filter((r) => r.completed).map((r) => r.item_key),
  );

  const checklist = TRAINING_CHECKLIST_ITEMS.map((item) => ({
    ...item,
    completed: completedSet.has(item.key),
  }));

  return res.json({ checklist, allComplete: checklist.every((i) => i.completed) });
});

router.post("/rent-a-buddy/me/training-checklist/:itemKey", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const serviceClient = sc(client);

  const { itemKey } = req.params;
  const validKeys = TRAINING_CHECKLIST_ITEMS.map((i) => i.key);
  if (!validKeys.includes(itemKey)) {
    return res.status(400).json({ error: "invalid_item", message: `Unknown checklist item: ${itemKey}` });
  }

  const { data: app } = await serviceClient
    .from("rent_buddy_applications")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!app) return res.status(404).json({ error: "no_application", message: "No application found. Submit an application first." });

  await serviceClient.from("rent_buddy_training_checklist").upsert(
    {
      application_id: (app as any).id,
      user_id: user.id,
      item_key: itemKey,
      completed: true,
      completed_at: new Date().toISOString(),
    },
    { onConflict: "application_id,item_key" },
  );

  const { data: allRows } = await serviceClient
    .from("rent_buddy_training_checklist")
    .select("completed")
    .eq("application_id", (app as any).id)
    .eq("completed", true);

  const completedCount = (allRows ?? []).length;
  const allComplete = completedCount >= TRAINING_CHECKLIST_ITEMS.length;

  if (allComplete) {
    await serviceClient.from("rent_buddy_profiles")
      .update({ training_completed: true })
      .eq("user_id", user.id);
  }

  return res.json({ ok: true, completedCount, allComplete });
});

// ── Admin — Nightlife buddy sign-off ──────────────────────────────────────────

router.post("/rent-a-buddy/admin/buddies/:buddyId/nightlife-approve", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient, userId: adminId } = admin;

  const { buddyId } = req.params;
  const { approved, note } = req.body ?? {};

  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles").select("user_id").eq("id", buddyId).maybeSingle();
  if (!bp) return res.status(404).json({ error: "not_found" });

  await serviceClient.from("rent_buddy_profiles").update({
    nightlife_admin_approved: !!approved,
    ...(approved ? { category_approvals: { nightlife: true } } : {}),
  }).eq("id", buddyId);

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: adminId,
    target_type: "buddy",
    target_id: buddyId,
    action: approved ? "nightlife_approved" : "nightlife_rejected",
    notes: note ?? null,
  });

  return res.json({ ok: true, approved: !!approved });
});

// ── Delayed-posting default note ───────────────────────────────────────────────
// Returns whether the user has an active Rent a Buddy booking and the default posting rules.

router.get("/rent-a-buddy/me/posting-defaults", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const serviceClient = sc(client);

  const { data: activeBookings, count } = await serviceClient
    .from("rent_buddy_bookings")
    .select("id, city", { count: "exact" })
    .eq("traveler_id", user.id)
    .eq("status", "in_progress")
    .limit(1);

  const hasActiveBooking = (count ?? 0) > 0;

  return res.json({
    hasActiveRentABuddyBooking: hasActiveBooking,
    defaultDelayPost: hasActiveBooking,
    defaultLocationGranularity: hasActiveBooking ? "neighborhood" : "exact",
    suppressExactCoordinates: hasActiveBooking,
    safetyNote: hasActiveBooking
      ? "Posts made during Rent a Buddy bookings are delayed by default to protect everyone's real-time location."
      : null,
  });
});

// ── Admin — access log for sensitive booking context ───────────────────────────

router.get("/rent-a-buddy/admin/bookings/:bookingId/sensitive", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient, userId } = admin;

  const { bookingId } = req.params;
  const reason = (req.query.reason as string) ?? null;

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return res.status(404).json({ error: "not_found" });

  await serviceClient.from("rent_buddy_admin_access_logs").insert({
    admin_id: userId,
    resource: "booking_sensitive_context",
    resource_id: bookingId,
    reason: reason ?? "admin_review",
  });

  const b = booking as any;
  return res.json({
    booking: {
      id: b.id,
      buddyId: b.buddy_id,
      travelerId: b.traveler_id,
      city: b.city,
      category: b.category,
      bookingDate: b.booking_date,
      notes: b.notes,
      status: b.status,
      safetyStatus: b.safety_status,
      paymentMode: b.payment_mode,
      totalUsd: b.total_usd,
      cashBalanceUsd: b.cash_balance_usd,
    },
  });
});

// ── Buddy verification override (admin) ────────────────────────────────────────

router.patch("/rent-a-buddy/admin/users/:userId/verification", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc: serviceClient, userId: adminId } = admin;

  const { userId } = req.params;
  const { idVerified, phoneVerified, ageVerified, dateOfBirth, note } = req.body ?? {};

  const patch: Record<string, any> = {};
  if (idVerified !== undefined) patch.id_verified = idVerified;
  if (phoneVerified !== undefined) patch.phone_verified = phoneVerified;
  if (ageVerified !== undefined) patch.age_verified = ageVerified;
  if (dateOfBirth !== undefined) patch.date_of_birth = dateOfBirth;

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: "invalid_payload", message: "No verification fields provided." });
  }

  await serviceClient.from("rent_buddy_profiles").update(patch).eq("user_id", userId);

  await serviceClient.from("rent_buddy_admin_actions").insert({
    admin_id: adminId,
    target_type: "user",
    target_id: userId,
    action: "verification_override",
    notes: note ?? JSON.stringify(patch),
  });

  await serviceClient.from("rent_buddy_admin_access_logs").insert({
    admin_id: adminId, resource: "user_verification", resource_id: userId,
    reason: note ?? "admin_verification_override",
  });

  return res.json({ ok: true });
});

// ── Booking creation: nightlife enforcement ────────────────────────────────────
// Augment the policy scanner rules with nightlife patterns
// and enforce 21+ check + public meetup at the booking-create level.
// This is exposed as a helper called from the booking create route via the
// POLICY_RULES array and inline checks already in that route.
// We export the nightlife check function for re-use.

export function isNightlifeRequiresPublicMeetup(category: string): boolean {
  return category === "nightlife";
}

export function nightlifePublicMeetupViolation(meetupLocation: string, category: string): boolean {
  if (category !== "nightlife") return false;
  return NIGHTLIFE_PROHIBITED_PATTERNS.some((p) => p.test(meetupLocation));
}

// ── Buddy earnings summary ─────────────────────────────────────────────────────
// The /api/rent-a-buddy/dashboard/earnings route already exists in the
// main router section. We add a richer breakdown endpoint here.

router.get("/rent-a-buddy/dashboard/earnings/summary", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;
  const serviceClient = sc(client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { data: bp } = await serviceClient
    .from("rent_buddy_profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!bp) return res.status(404).json({ error: "not_found", message: "No Buddy profile found." });

  const { data: bookings } = await serviceClient
    .from("rent_buddy_bookings")
    .select("id, total_usd, deposit_usd, cash_balance_usd, payment_mode, status, completed_at, booking_date, category")
    .eq("buddy_id", (bp as any).id)
    .in("status", ["completed", "disputed"]);

  const rows = (bookings ?? []) as any[];

  const platformFeePct = 0.15;
  let totalInApp = 0;
  let totalCashConfirmed = 0;
  let totalFees = 0;
  let totalDisputed = 0;
  let totalPending = 0;

  const monthlyMap: Record<string, { totalUsd: number; bookingCount: number; inApp: number; cash: number; fees: number }> = {};

  for (const b of rows) {
    const month = (b.completed_at ?? b.booking_date ?? "").slice(0, 7);
    if (!monthlyMap[month]) monthlyMap[month] = { totalUsd: 0, bookingCount: 0, inApp: 0, cash: 0, fees: 0 };

    const gross = Number(b.total_usd ?? 0);
    const fee = Math.round(gross * platformFeePct * 100) / 100;
    const net = gross - fee;

    if (b.status === "disputed") {
      totalDisputed += gross;
      monthlyMap[month].totalUsd += 0;
    } else {
      const inApp = Number(b.deposit_usd ?? 0);
      const cash = Number(b.cash_balance_usd ?? 0);
      totalInApp += inApp;
      totalCashConfirmed += cash;
      totalFees += fee;
      monthlyMap[month].totalUsd += net;
      monthlyMap[month].inApp += inApp;
      monthlyMap[month].cash += cash;
      monthlyMap[month].fees += fee;
    }
    monthlyMap[month].bookingCount += 1;
  }

  const monthlyBreakdown = Object.entries(monthlyMap)
    .map(([month, v]) => ({ month, ...v }))
    .sort((a, b) => b.month.localeCompare(a.month));

  const currentYear = new Date().getFullYear().toString();
  const yearlyTotalUsd = monthlyBreakdown
    .filter((m) => m.month.startsWith(currentYear))
    .reduce((sum, m) => sum + m.totalUsd, 0);

  return res.json({
    totalInAppUsd: totalInApp,
    totalCashConfirmedUsd: totalCashConfirmed,
    totalPlatformFeesUsd: totalFees,
    totalDisputedUsd: totalDisputed,
    totalPendingUsd: totalPending,
    totalNetUsd: totalInApp + totalCashConfirmed - totalFees,
    yearlyNetUsd: yearlyTotalUsd,
    monthlyBreakdown,
    taxNote: "Tax documents are not available yet. Please keep your own records of earnings for tax purposes. A tax summary feature is planned for a future release.",
    platformFeePct: platformFeePct * 100,
  });
});

// ── Booking lifecycle — expiry sweeper ────────────────────────────────────────
// POST /api/internal/buddy-requests/expire
// Sweeps two sets of stale bookings:
//   1. pending requests past expires_at → expired
//   2. completed_pending_traveler_confirmation past dispute_window_expires_at → completed
// Call on a schedule (cron / Supabase pg_cron / external scheduler).
// Accessible without user auth — restrict at the infrastructure / firewall level.

router.post("/internal/buddy-requests/expire", async (req, res) => {
  // Require the internal shared secret (INTERNAL_API_SECRET) to prevent
  // unauthenticated callers from triggering mass state transitions. Callers
  // must set X-Internal-Key: <INTERNAL_API_SECRET>. Fail closed when the env
  // var is unset (route disabled) — same pattern as notifications.ts.
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    return res.status(503).json({
      error: "misconfigured",
      message: "INTERNAL_API_SECRET is not set; internal endpoints are disabled",
    });
  }
  const internalKey = req.headers["x-internal-key"];
  if (!safeSecretEquals(internalKey, secret)) {
    return res.status(401).json({ error: "unauthorized", message: "Missing or invalid internal key." });
  }

  // The sweep logic lives in lib/rentBuddyRequestSweeper.ts so that the
  // scheduler and this endpoint share ONE implementation. This route previously
  // held the only copy and had no caller — src/index.ts started ~25 schedulers
  // and this was not one of them, so nothing expired, no dispute window closed
  // and no no-show escalated. The endpoint is kept for manual replay and for an
  // external cron; it now delegates.
  const result = await runBuddyRequestSweep();
  if (result.unavailable) return res.status(503).json({ error: "service_unavailable" });

  return res.json({
    ok: true,
    expired: result.expired,
    autoCompleted: result.autoCompleted,
    noShowEscalated: result.noShowEscalated,
  });
});

// ── Traveler confirm ──────────────────────────────────────────────────────────
// POST /api/rent-a-buddy/bookings/:bookingId/traveler-confirm
// Traveler explicitly confirms the session is complete without raising a dispute.
// Only valid for completed_pending_traveler_confirmation status.
// Moves to completed, archives thread, notifies buddy.

router.post("/rent-a-buddy/bookings/:bookingId/traveler-confirm", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("traveler_id, buddy_id, status, telegraph_thread_id, stay_connected_traveler, stay_connected_buddy")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  if ((booking as any).traveler_id !== auth.user.id) {
    return res.status(403).json({ error: "forbidden" });
  }

  if ((booking as any).status !== "completed_pending_traveler_confirmation") {
    return res.status(409).json({
      error: "invalid_transition",
      message: `Cannot confirm a booking in status '${(booking as any).status}'.`,
      currentStatus: (booking as any).status,
    });
  }

  const now = new Date().toISOString();
  await serviceClient
    .from("rent_buddy_bookings")
    .update({ status: "completed", updated_at: now })
    .eq("id", bookingId);

  void serviceClient.from("buddy_booking_events").insert({
    booking_id: bookingId, actor_user_id: auth.user.id, event: "traveler_confirmed",
    from_status: "completed_pending_traveler_confirmation", to_status: "completed", metadata: {},
  });

  void emitBookingMilestone(serviceClient, bookingId, auth.user.id, "rent_buddy_completed",
    "Confirmed — booking complete! Thank you for using Rent a Buddy.");

  // Notify buddy
  const { data: bProf } = await serviceClient
    .from("rent_buddy_profiles")
    .select("user_id")
    .eq("id", (booking as any).buddy_id)
    .maybeSingle();
  const buddyUserIdConfirm: string = (bProf as any)?.user_id ?? "";
  if (buddyUserIdConfirm) {
    notifyBookingParty(getServiceClient(), buddyUserIdConfirm, "rent_buddy.booking_completed", bookingId);
  }

  // Archive thread
  const bothStayConnected3 = !!((booking as any).stay_connected_traveler && (booking as any).stay_connected_buddy);
  if (!bothStayConnected3) {
    const threadId3: string | null = (booking as any).telegraph_thread_id ?? null;
    if (threadId3) {
      await serviceClient
        .from("message_thread_members")
        .update({ archived_at: now })
        .eq("thread_id", threadId3)
        .is("archived_at", null);
    }
  }

  await invalidateCompassCache(getServiceClient(), auth.user.id, "booking_confirm");
  return res.json({ ok: true });
});

// ── Booking events (evidence log) ─────────────────────────────────────────────
// GET /api/rent-a-buddy/bookings/:bookingId/events
// Returns the public event log for a booking (admin_only events excluded).
// Both the traveler and the buddy can call this.

router.get("/rent-a-buddy/bookings/:bookingId/events", async (req, res) => {
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

  const { data: events } = await serviceClient
    .from("buddy_booking_events")
    .select("id, event, from_status, to_status, metadata, created_at")
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: true });

  // Exclude admin-only events from public timeline responses (spec §9)
  const publicEvents = (events ?? []).filter(
    (e: any) => !(e.metadata as any)?.visibility || (e.metadata as any).visibility !== "admin_only"
  );

  return res.json({ events: publicEvents });
});

// ── Booking change-request endpoints (time / service / price / date) ──────────
// POST /api/rent-a-buddy/bookings/:bookingId/change-request
// (the mobile client calls /api/buddy-bookings/:bookingId/change-request, which
// the specAliasRewrite middleware in app.ts rewrites to this canonical path)
// Creates a buddy_booking_change_requests row proposing a change.
// Either party can propose. Only accepted requests mutate the booking.
//
// Body: { changeField, proposedValue, reason? }
//   changeField: 'date' | 'start_time' | 'duration_h' | 'service' | 'price_usd'
//   proposedValue: JSONB (e.g. { date: "2025-09-01" } or { duration_h: 4 })

router.post("/rent-a-buddy/bookings/:bookingId/change-request", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { changeField, proposedValue, reason } = req.body ?? {};

  const validFields = ["date", "start_time", "duration_h", "service", "price_usd"];
  if (!changeField || !validFields.includes(changeField)) {
    return res.status(400).json({
      error: "invalid_payload",
      message: `changeField must be one of: ${validFields.join(", ")}`,
    });
  }
  if (proposedValue === undefined || proposedValue === null) {
    return res.status(400).json({ error: "invalid_payload", message: "proposedValue is required." });
  }

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("traveler_id, buddy_id, status, booking_date, start_time, duration_h, package_id, total_usd")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const party = await requireBookingParty(serviceClient, booking, auth.user.id, res);
  if (!party) return;

  const changeAllowedStatuses = ["pending", "confirmed", "scheduled"];
  if (!changeAllowedStatuses.includes((booking as any).status)) {
    return res.status(409).json({
      error: "invalid_transition",
      message: "Change requests can only be raised before the session starts.",
      currentStatus: (booking as any).status,
    });
  }

  // A proposed date change must not land on the buddy's blocked/vacation dates
  if (changeField === "date") {
    const proposedDate = (proposedValue as any)?.date;
    if (typeof proposedDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(proposedDate)) {
      return res.status(400).json({ error: "invalid_payload", message: "proposedValue.date must be an ISO date (YYYY-MM-DD)." });
    }
    const blocking = await findBlockingAvailabilityException(serviceClient, (booking as any).buddy_id, proposedDate);
    if (blocking) return sendBuddyUnavailable(res, blocking.exception_type);
  }

  // Check for an already-open pending change request on the same field
  const { data: existingOpen } = await serviceClient
    .from("buddy_booking_change_requests")
    .select("id")
    .eq("booking_id", bookingId)
    .eq("change_field", changeField)
    .eq("status", "pending")
    .maybeSingle();
  if (existingOpen) {
    return res.status(409).json({
      error: "conflict",
      message: `A pending change request for '${changeField}' already exists. Respond to it before raising another.`,
    });
  }

  // Capture the current value for audit trail
  const currentValueMap: Record<string, unknown> = {
    date: { date: (booking as any).booking_date },
    start_time: { start_time: (booking as any).start_time },
    duration_h: { duration_h: (booking as any).duration_h },
    service: { service_id: (booking as any).package_id },
    price_usd: { price_usd: (booking as any).total_usd },
  };
  const currentValue = currentValueMap[changeField] ?? {};

  const { data: changeReq, error: crErr } = await serviceClient
    .from("buddy_booking_change_requests")
    .insert({
      booking_id: bookingId,
      requested_by: auth.user.id,
      change_field: changeField,
      current_value: currentValue,
      proposed_value: proposedValue,
      reason: reason ?? null,
    })
    .select()
    .maybeSingle();
  if (crErr) return sendError(res, "db_error", crErr.message);

  void serviceClient.from("buddy_booking_events").insert({
    booking_id: bookingId, actor_user_id: auth.user.id, event: "change_request_raised",
    from_status: (booking as any).status, to_status: (booking as any).status,
    metadata: { change_field: changeField, proposed_value: proposedValue, change_request_id: (changeReq as any)?.id },
  });

  const notifyTargetId = party.isTraveler ? party.buddyUserId : (booking as any).traveler_id as string;
  if (notifyTargetId) {
    notifyBookingParty(getServiceClient(), notifyTargetId, "rent_buddy.change_request_raised", bookingId);
  }

  return res.status(201).json({ changeRequest: changeReq });
});

// POST /api/rent-a-buddy/bookings/:bookingId/respond-change-request
// (also reachable at /api/buddy-bookings/:bookingId/respond-change-request via alias)
// Accepts or declines a pending change request.
// Only the OTHER party (not the requester) can respond.
// On accept: applies the proposed value to the booking immediately.
//
// Body: { changeRequestId, decision: "accept" | "decline", responseNote? }

router.post("/rent-a-buddy/bookings/:bookingId/respond-change-request", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { changeRequestId, decision, responseNote } = req.body ?? {};

  if (!changeRequestId) return res.status(400).json({ error: "invalid_payload", message: "changeRequestId is required." });
  if (!["accept", "decline"].includes(decision)) {
    return res.status(400).json({ error: "invalid_payload", message: "decision must be 'accept' or 'decline'." });
  }

  const { data: booking } = await serviceClient
    .from("rent_buddy_bookings")
    .select("traveler_id, buddy_id, status")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return res.status(404).json({ error: "not_found" });

  const party = await requireBookingParty(serviceClient, booking, auth.user.id, res);
  if (!party) return;

  const { data: changeReq } = await serviceClient
    .from("buddy_booking_change_requests")
    .select("*")
    .eq("id", changeRequestId)
    .eq("booking_id", bookingId)
    .eq("status", "pending")
    .maybeSingle();
  if (!changeReq) return res.status(404).json({ error: "not_found", message: "No pending change request found." });

  // The responder must be the OTHER party — not the one who raised the request
  if ((changeReq as any).requested_by === auth.user.id) {
    return res.status(403).json({ error: "forbidden", message: "You cannot respond to your own change request." });
  }

  const newStatus = decision === "accept" ? "approved" : "declined";
  const now = new Date().toISOString();

  // Re-check blocked dates at accept time — the buddy may have blocked the
  // range after the change request was raised.
  if (decision === "accept" && (changeReq as any).change_field === "date") {
    const proposedDate = ((changeReq as any).proposed_value ?? {}).date;
    if (typeof proposedDate === "string") {
      const blocking = await findBlockingAvailabilityException(serviceClient, (booking as any).buddy_id, proposedDate);
      if (blocking) return sendBuddyUnavailable(res, blocking.exception_type);
    }
  }

  await serviceClient
    .from("buddy_booking_change_requests")
    .update({ status: newStatus, responded_by: auth.user.id, response_note: responseNote ?? null, responded_at: now })
    .eq("id", changeRequestId);

  // If accepted, apply the proposed change to the booking
  if (decision === "accept") {
    const field: string = (changeReq as any).change_field;
    const proposed: Record<string, unknown> = (changeReq as any).proposed_value ?? {};

    const bookingPatch: Record<string, unknown> = { updated_at: now };
    if (field === "date" && proposed.date) bookingPatch.booking_date = proposed.date;
    if (field === "start_time" && proposed.start_time) bookingPatch.start_time = proposed.start_time;
    if (field === "duration_h" && proposed.duration_h !== undefined) bookingPatch.duration_h = proposed.duration_h;
    if (field === "service" && proposed.service_id) bookingPatch.package_id = proposed.service_id;
    if (field === "price_usd" && proposed.price_usd !== undefined) bookingPatch.total_usd = proposed.price_usd;

    await serviceClient.from("rent_buddy_bookings").update(bookingPatch).eq("id", bookingId);
  }

  void serviceClient.from("buddy_booking_events").insert({
    booking_id: bookingId, actor_user_id: auth.user.id, event: `change_request_${newStatus}`,
    from_status: (booking as any).status, to_status: (booking as any).status,
    metadata: {
      change_request_id: changeRequestId,
      change_field: (changeReq as any).change_field,
      decision,
      response_note: responseNote ?? null,
    },
  });

  const notifyTargetId = (changeReq as any).requested_by as string;
  if (notifyTargetId) {
    notifyBookingParty(getServiceClient(), notifyTargetId,
      decision === "accept" ? "rent_buddy.change_request_accepted" : "rent_buddy.change_request_declined",
      bookingId);
  }

  return res.json({ ok: true, decision, changeRequestId });
});

// ── Rebook — create a new pending booking pre-filled from a completed booking ─
// POST /api/rent-a-buddy/bookings/:bookingId/rebook
// (the mobile client calls /api/buddy-bookings/:bookingId/rebook, which the
// specAliasRewrite middleware in app.ts rewrites to this canonical path)
// Requires: bookingDate (fresh date); optional overrides: startTime, durationH, groupSize.
// Uses current buddy pricing; keeps service category, city, and notes from original.

router.post("/rent-a-buddy/bookings/:bookingId/rebook", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const serviceClient = sc(auth.client);
  if (!await requireRentBuddyEnabled(serviceClient, res)) return;

  // Rebook INSERTs a new rent_buddy_bookings row, so it is a booking-creation
  // path and gets the same KYC gate as POST /rent-a-buddy/bookings. Without
  // this it would be a bypass: rebook skips the kill switches, the rollout
  // check and launch controls entirely.
  if (!await requireBookingKyc(serviceClient, res)) return;

  const { bookingId } = req.params;
  const { bookingDate, startTime, durationH, groupSize } = req.body ?? {};

  if (!bookingDate) {
    return res.status(400).json({ error: "invalid_payload", message: "bookingDate is required to rebook." });
  }
  // startTime is optional — when omitted the new booking inherits the original
  // booking's start_time (see insert below). Clients may omit it to carry the
  // same time slot forward without having to re-send it.

  const { data: original } = await serviceClient
    .from("rent_buddy_bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();
  if (!original) return res.status(404).json({ error: "not_found", message: "Booking not found." });
  if ((original as any).traveler_id !== auth.user.id) {
    return res.status(403).json({ error: "forbidden", message: "Not your booking." });
  }
  if ((original as any).status !== "completed") {
    return res.status(400).json({ error: "invalid_payload", message: "You can only rebook from a completed booking." });
  }

  const buddyProfileId = (original as any).buddy_id as string;
  const { data: buddyProfile } = await serviceClient
    .from("rent_buddy_profiles")
    .select("*")
    .eq("id", buddyProfileId)
    .maybeSingle();

  if (!buddyProfile || (buddyProfile as any).status !== "active" || (buddyProfile as any).admin_status !== "active") {
    return res.status(409).json({ error: "buddy_unavailable", message: "This Buddy is no longer accepting bookings." });
  }

  // Enforce buddy availability on the requested date
  const { data: avRow } = await serviceClient
    .from("rent_buddy_availability")
    .select("is_available")
    .eq("buddy_id", buddyProfileId)
    .eq("date", bookingDate)
    .maybeSingle();
  if (avRow && !(avRow as any).is_available) {
    return res.status(409).json({ error: "buddy_not_available", message: "This Buddy is not available on the requested date." });
  }

  // Blocked/vacation date ranges also make the buddy unavailable
  const rebookBlocking = await findBlockingAvailabilityException(serviceClient, buddyProfileId, bookingDate);
  if (rebookBlocking) return sendBuddyUnavailable(res, rebookBlocking.exception_type);

  // Compute price with current buddy rates.
  // Prefer explicit overrides from the request; fall back to the original's
  // values; leave null when neither the request nor the original supplies a value
  // (avoid silently substituting arbitrary defaults like 2 h / 1 person).
  const newDurationH: number | null =
    durationH != null ? Number(durationH)
    : (original as any).duration_h != null ? Number((original as any).duration_h)
    : null;
  const newGroupSize: number | null =
    groupSize != null ? Number(groupSize)
    : (original as any).group_size != null ? Number((original as any).group_size)
    : null;
  const rateUsd = (buddyProfile as any).hourly_rate_usd ? Number((buddyProfile as any).hourly_rate_usd) : 0;
  const totalUsd = newDurationH != null ? Math.round(rateUsd * newDurationH * 100) / 100 : 0;

  const { data: newBooking, error } = await serviceClient
    .from("rent_buddy_bookings")
    .insert({
      buddy_id: buddyProfileId,
      traveler_id: auth.user.id,
      package_id: null,
      trip_id: null,
      booking_date: bookingDate,
      start_time: startTime ?? (original as any).start_time ?? null,
      duration_h: newDurationH,
      group_size: newGroupSize,
      city: (original as any).city,
      country_code: (original as any).country_code ?? null,
      category: (original as any).category,
      notes: (original as any).notes ?? null,
      total_usd: totalUsd,
      deposit_usd: totalUsd,
      cash_balance_usd: 0,
      payment_mode: "full_in_app",
      status: "pending",
      safety_status: "normal",
      route_plan: [],
      updated_at: new Date().toISOString(),
    })
    .select()
    .maybeSingle();

  if (error) return sendError(res, "db_error", error.message);

  void serviceClient.from("buddy_booking_events").insert({
    booking_id: (newBooking as any)?.id,
    actor_user_id: auth.user.id,
    event: "rebook_created",
    from_status: null,
    to_status: "pending",
    metadata: { original_booking_id: bookingId },
  });

  return res.status(201).json({ bookingId: (newBooking as any)?.id, booking: newBooking });
});

export default router;

