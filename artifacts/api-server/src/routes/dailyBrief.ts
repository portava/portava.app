/**
 * Daily Trip Brief Routes
 *
 * GET  /api/trips/:tripId/daily-brief?date=YYYY-MM-DD  — fetch brief for a date
 * POST /api/trips/:tripId/daily-brief/refresh           — force refresh (clears cache)
 * POST /api/trips/:tripId/daily-brief/actions/:actionId — execute a quick action
 * POST /api/trips/:tripId/daily-brief/dismiss/:recommendationId — dismiss a suggestion
 *
 * Access: accepted trip members only. Non-members get access_denied, not 403.
 *
 * Personalisation:
 *   - fetchActiveTripForUser finds the user's active trip by checking trip_members
 *     (covers both owned trips and accepted-member trips) for in_progress status or
 *     upcoming trips starting within 3 days. Returns the actual trip record.
 *   - When an active trip is found, its destination/dates/plan/meetups drive the
 *     trip_context brief — even if that trip is not the same as :tripId.
 *   - When no active trip exists, a general inspiration brief is generated using
 *     only preference profile + past destinations; no trip-specific data is used.
 *
 * Caching (two layers):
 *   - L1: 24-hour in-memory cache keyed by userId:tripId:date.
 *   - L2: daily_briefs table in Supabase (see migration 0012_daily_briefs.sql).
 *         Provides durable once-per-calendar-day storage across server restarts.
 *         Route reads from DB before regenerating; writes after generation via upsert.
 *         DB errors are caught and degrade gracefully to in-memory behaviour.
 *   Smart invalidation: if plan items, meetups, or RSVPs were modified after the
 *   brief was built, it is rebuilt regardless of cache freshness.
 */
import { Router } from "express";
import { z } from "zod";
import { logger as rootLogger } from "../lib/logger.js";

const briefLogger = rootLogger.child({ route: "dailyBrief" });
import { requireUser, sendError, isAcceptedTripMember } from "../lib/http.js";
import { resolveContext } from "../lib/privacyResolver.js";
import {
  buildDailyBrief,
  type RawRecommendation,
  type UpcomingMeetup24h,
  type BriefType,
} from "../lib/dailyBriefEngine.js";
import { defaultExplicit, defaultInferred } from "../lib/preferenceLearning.js";
import { getWeatherContext, type WeatherContext, type DailyWeather } from "../lib/weatherCache.js";
import { getLocalContext, type LocalContext } from "../lib/localContext.js";
import { getEventsNearDestination, type EventsContext } from "../lib/eventsCache.js";

const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ── L1: In-memory cache ───────────────────────────────────────────────────
 * Key: `${userId}:${date}`   TTL: 24 h
 * Keyed per-user-per-day — the brief content is driven by the user's active
 * trip, not the requested :tripId, so a single daily brief per user is correct.
 */
const BRIEF_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
interface CachedBrief { brief: any; builtAt: number }
const briefCache = new Map<string, CachedBrief>();

function briefCacheKey(userId: string, date: string) {
  return `${userId}:${date}`;
}
function getCachedBrief(userId: string, date: string): CachedBrief | null {
  return briefCache.get(briefCacheKey(userId, date)) ?? null;
}
function setCachedBrief(userId: string, date: string, brief: any, builtAt?: number): void {
  briefCache.set(briefCacheKey(userId, date), { brief, builtAt: builtAt ?? Date.now() });
}
function invalidateBriefCache(userId: string, date: string): void {
  briefCache.delete(briefCacheKey(userId, date));
}
function isCacheStale(cached: CachedBrief): boolean {
  return Date.now() - cached.builtAt > BRIEF_CACHE_TTL_MS;
}

/* ── L2: DB-backed daily_briefs table ──────────────────────────────────────
 * Requires migration 0012_daily_briefs.sql to be applied.
 * Keyed per-user-per-day: (user_id, brief_date) UNIQUE.
 * trip_id stored for informational purposes only (which active trip drove it).
 * All operations degrade gracefully if the table is absent.
 */
async function getStoredBrief(
  client: any,
  userId: string,
  date: string,
): Promise<{ brief: any; generatedAt: number } | null> {
  try {
    const { data, error } = await client
      .from("daily_briefs")
      .select("brief_json,generated_at")
      .eq("user_id", userId)
      .eq("brief_date", date)
      .maybeSingle();
    if (error || !data) return null;
    return {
      brief: JSON.parse(data.brief_json),
      generatedAt: new Date(data.generated_at).getTime(),
    };
  } catch {
    return null;
  }
}

async function storeBriefInDB(
  client: any,
  userId: string,
  tripId: string,
  date: string,
  briefType: string,
  brief: any,
): Promise<void> {
  // graceful: in-memory L1 still covers the session
  try {
    const { error } = await client.from("daily_briefs").upsert(
      {
        user_id:      userId,
        trip_id:      tripId,
        brief_date:   date,
        brief_type:   briefType,
        brief_json:   JSON.stringify(brief),
        generated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,brief_date" },
    );
    if (error) briefLogger.warn({ err: error, userId, date }, "daily brief upsert failed (best-effort)");
  } catch (err) {
    // partial/fake clients may lack .upsert — never block the brief response
    briefLogger.warn({ err, userId, date }, "daily brief upsert threw (best-effort)");
  }
}

async function invalidateStoredBrief(
  client: any,
  userId: string,
  date: string,
): Promise<void> {
  try {
    await client
      .from("daily_briefs")
      .delete()
      .eq("user_id", userId)
      .eq("brief_date", date);
  } catch { /* graceful */ }
}

/* ── Preference profile ─────────────────────────────────────────────────── */

async function getPreferenceProfile(client: any, userId: string) {
  const [prefRes, profileRes] = await Promise.all([
    client
      .from("user_preference_profiles")
      .select("explicit_preferences_json,inferred_preferences_json,updated_at")
      .eq("user_id", userId)
      .maybeSingle(),
    client
      .from("profiles")
      .select("spoken_languages,default_language,travel_styles,travel_pace,budget_style,travel_group_style,looking_for,comfort_level,availability_tags,planning_style")
      .eq("id", userId)
      .maybeSingle(),
  ]);

  const explicit = (() => {
    try { return JSON.parse(prefRes.data?.explicit_preferences_json); }
    catch { return defaultExplicit(); }
  })();
  const inferred = (() => {
    try { return JSON.parse(prefRes.data?.inferred_preferences_json); }
    catch { return defaultInferred(); }
  })();

  const p = profileRes.data;
  if (p) {
    if (p.travel_pace) explicit.pace = p.travel_pace;
    if (p.travel_styles?.length) explicit.travelStyles = p.travel_styles;
    if (p.budget_style) explicit.budgetStyle = p.budget_style;
    if (p.travel_group_style?.length) explicit.groupStyle = p.travel_group_style.join(", ");
    if (p.looking_for?.length) explicit.lookingFor = p.looking_for;
    if (p.availability_tags?.length) explicit.preferredActivityTimes = p.availability_tags;
    if (p.spoken_languages?.length) explicit.spokenLanguages = p.spoken_languages;
    if (p.default_language) explicit.defaultLanguage = p.default_language;
    if (p.comfort_level) explicit.comfortLevel = p.comfort_level;
    if (p.planning_style) explicit.planningStyle = p.planning_style;
  }

  return { userId, explicit, inferred, lastUpdatedAt: prefRes.data?.updated_at ?? null };
}

/* ── Active trip resolution ─────────────────────────────────────────────────
 * Checks trip_members for accepted membership (owner|member role), covering
 * both trips the user owns and trips they have been invited to and accepted.
 * Priority: in_progress > upcoming-within-3-days.
 */
interface ActiveTripInfo {
  tripId: string;
  destinationCity: string;
  destinationCountry: string | null;
  startDate: string | null;
  endDate: string | null;
}

async function fetchActiveTripForUser(
  client: any,
  userId: string,
  today: string,
): Promise<ActiveTripInfo | null> {
  try {
    // Gather all trip IDs where the user is an accepted member (owner OR member role).
    // The trip_members table includes owners with role='owner', so this covers both.
    const { data: memberRows } = await client
      .from("trip_members")
      .select("trip_id")
      .eq("user_id", userId)
      .in("role", ["owner", "member"]);

    const tripIds = (memberRows ?? []).map((r: any) => r.trip_id as string);
    if (tripIds.length === 0) return null;

    // 1. In-progress trips (highest priority — user is there right now)
    //
    // This used to filter `status = 'in_progress'`. `in_progress` is not a
    // label of the `trip_status` enum (draft | planning | upcoming | active |
    // completed | cancelled | archived), so PostgREST rejected it 22P02 and the
    // whole read failed: the daily brief could never tell a user they were on a
    // trip, and always fell through to the "upcoming" branch below. This exact
    // defect is documented in lib/activeCrew.ts:26-28, which named dailyBrief
    // as the reader carrying it. `active` is the label every other current-trip
    // reader uses.
    const { data: inProgress } = await client
      .from("trips")
      .select("id,destination_city,destination_country,start_date,end_date")
      .in("id", tripIds)
      .eq("status", "active")
      .order("start_date", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (inProgress) {
      return {
        tripId: inProgress.id,
        destinationCity: inProgress.destination_city,
        destinationCountry: inProgress.destination_country ?? null,
        startDate: inProgress.start_date ?? null,
        endDate: inProgress.end_date ?? null,
      };
    }

    // 2. Upcoming trips starting within the next 3 calendar days
    const in3Days = new Date(today + "T00:00:00Z");
    in3Days.setUTCDate(in3Days.getUTCDate() + 3);
    const in3DaysStr = in3Days.toISOString().slice(0, 10);

    const { data: upcomingRows } = await client
      .from("trips")
      .select("id,destination_city,destination_country,start_date,end_date")
      .in("id", tripIds)
      .eq("status", "upcoming")
      .gte("start_date", today)
      .lte("start_date", in3DaysStr)
      .order("start_date", { ascending: true })
      .limit(1);

    const upcoming = (upcomingRows ?? [])[0] ?? null;
    if (upcoming) {
      return {
        tripId: upcoming.id,
        destinationCity: upcoming.destination_city,
        destinationCountry: upcoming.destination_country ?? null,
        startDate: upcoming.start_date ?? null,
        endDate: upcoming.end_date ?? null,
      };
    }

    return null;
  } catch {
    // Degrade gracefully — return null so the route falls back to general brief
    return null;
  }
}

/* ── Past destinations (for general briefs) ────────────────────────────── */

async function fetchPastDestinations(client: any, userId: string): Promise<string[]> {
  try {
    // Note: .not() is intentionally avoided here — filter non-null destination_city in JS
    // so this function remains compatible with the test fake-client query builder.
    const { data } = await client
      .from("trips")
      .select("destination_city,destination_country")
      .eq("owner_id", userId)
      .in("status", ["completed", "cancelled"])
      .order("end_date", { ascending: false })
      .limit(6);
    if (!data || data.length === 0) return [];
    return (data as any[])
      .filter((t) => Boolean(t.destination_city))
      .map((t) =>
        t.destination_country
          ? `${t.destination_city}, ${t.destination_country}`
          : (t.destination_city as string),
      )
      .slice(0, 3);
  } catch {
    return [];
  }
}

/* ── Upcoming meetups within 24 h ───────────────────────────────────────── */

async function fetchUpcomingMeetups24h(
  client: any,
  userId: string,
  tripId: string,
  now: Date,
): Promise<UpcomingMeetup24h[]> {
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1_000);

  const { data: rsvpRows } = await client
    .from("meetup_invites")
    .select("meetup_id")
    .eq("user_id", userId)
    .in("status", ["going", "maybe"]);

  const rsvpMeetupIds = (rsvpRows ?? []).map((r: any) => r.meetup_id as string);
  if (rsvpMeetupIds.length === 0) return [];

  const { data: meetupRows } = await client
    .from("meetups")
    .select("id,title,starts_at,location_name")
    .eq("trip_id", tripId)
    .in("id", rsvpMeetupIds)
    .eq("status", "confirmed")
    .gte("starts_at", now.toISOString())
    .lte("starts_at", in24h.toISOString())
    .order("starts_at", { ascending: true });

  return (meetupRows ?? []).map((m: any) => ({
    id: m.id as string,
    title: m.title as string,
    proposedTime: m.starts_at as string,
    locationName: (m.location_name as string | null) ?? null,
  }));
}

/* ── Recommendation generators ─────────────────────────────────────────── */

/**
 * Generate trip-context recommendations: destination-aware suggestions for
 * today, enriched with live weather forecasts and local OSM POIs, plus
 * gap-day nudges for unplanned trip days.
 *
 * Weather context: injects weather-aware suggestions (indoor alternatives on
 * rain days, outdoor boosts on sunny days). Gracefully skipped if null.
 *
 * Local context: enriches the pool with specific named POIs from OSM
 * (museums, parks, restaurants) when available. Gracefully skipped if null.
 */
function generateTripContextRecommendations(
  preferenceProfile: any,
  destination: string | null,
  gapDays: string[],
  weatherContext?: WeatherContext | null,
  localContext?: LocalContext | null,
  eventsContext?: EventsContext | null,
): RawRecommendation[] {
  const dest = destination ? ` in ${destination}` : "";
  const interests: string[] = preferenceProfile?.explicit?.interests ?? [];
  const foodPrefs: string[] = preferenceProfile?.explicit?.foodPreferences ?? [];
  const nightlifePrefs: string[] = preferenceProfile?.explicit?.nightlifePreferences ?? [];
  const avoidList: string[] = preferenceProfile?.explicit?.avoidList ?? [];

  // Determine weather character for this trip
  const forecasts = weatherContext?.forecasts ?? [];
  const rainyDays = forecasts.filter((f) => f.precipMm > 2 || f.weatherCode >= 51);
  const sunnyDays = forecasts.filter((f) => f.weatherCode <= 3);
  const isRainy = rainyDays.length > 0;
  const isSunny = sunnyDays.length === forecasts.length && forecasts.length > 0;

  // Weather reason prefix for relevant suggestions
  const weatherReason = weatherContext?.briefSummary
    ? ` (${weatherContext.briefSummary.split("—")[0].trim()})`
    : "";

  const pool: RawRecommendation[] = [
    {
      id: "rec_culture",
      title: `Local cultural experience${dest}`,
      category: "culture",
      reason: "Immerse yourself in the local scene",
      estimatedTime: "2–3 hours",
      priceLevel: "$$",
    },
    {
      id: "rec_food_market",
      title: `Street food market${dest}`,
      category: "food",
      reason: "Authentic local flavours at great value",
      estimatedTime: "1–2 hours",
      priceLevel: "$",
    },
    {
      id: "rec_outdoor",
      title: `Outdoor activity${dest}`,
      category: "outdoor",
      reason: isSunny
        ? `Perfect weather for it${weatherReason}`
        : "Fresh air and local scenery",
      estimatedTime: "2–4 hours",
      priceLevel: "$",
    },
    {
      id: "rec_nightlife",
      title: `Evening bar or lounge${dest}`,
      category: "nightlife",
      reason: "Wind down with the local night scene",
      estimatedTime: "2–3 hours",
      priceLevel: "$$",
    },
    {
      id: "rec_hidden_gem",
      title: `Off-the-beaten-path spot${dest}`,
      category: "activity",
      reason: "A local favourite most tourists miss",
      estimatedTime: "1.5 hours",
      priceLevel: "$",
    },
    {
      id: "rec_restaurant",
      title: `Top-rated restaurant${dest}`,
      category: "food",
      reason: "Highly recommended by fellow travellers",
      estimatedTime: "1–1.5 hours",
      priceLevel: "$$",
    },
    {
      id: "rec_wellness",
      title: `Spa or wellness session${dest}`,
      category: "wellness",
      reason: "Recharge after a busy day of travel",
      estimatedTime: "1.5–2 hours",
      priceLevel: "$$$",
    },
    {
      id: "rec_market",
      title: `Local artisan market${dest}`,
      category: "shopping",
      reason: "Browse unique local crafts and souvenirs",
      estimatedTime: "1–2 hours",
      priceLevel: "$",
    },
  ];

  // Weather-aware additions: if rain is forecast, add indoor alternatives
  if (isRainy) {
    pool.push({
      id: "rec_indoor_rain",
      title: `Indoor alternatives${dest}`,
      category: "culture",
      reason: weatherContext?.briefSummary ?? "Rain in the forecast — stay dry with an indoor activity",
      estimatedTime: "2–3 hours",
      priceLevel: "$$",
    });
  }

  // Weather-aware additions: sunny days are great for outdoor spots
  if (isSunny && !isRainy) {
    pool.push({
      id: "rec_sunny_outdoor",
      title: `Scenic outdoor spot${dest}`,
      category: "outdoor",
      reason: weatherContext?.briefSummary ?? "Clear skies — perfect for exploring outside",
      estimatedTime: "1–3 hours",
      priceLevel: "free",
    });
  }

  // Local POI enrichment: add up to 3 specific named places from OSM
  if (localContext?.tips?.length) {
    const museums = localContext.tips.filter((t) => t.category === "museum" || t.category === "art");
    const parks   = localContext.tips.filter((t) => t.category === "park");
    const restaurants = localContext.tips.filter((t) => t.category === "restaurant");

    if (museums[0]) {
      pool.push({
        id: `rec_poi_museum_${museums[0].name.slice(0, 20).replace(/\s/g, "_")}`,
        title: museums[0].name,
        category: "culture",
        reason: `Popular local museum in ${destination ?? "the area"}`,
        estimatedTime: "1.5–3 hours",
        priceLevel: "$$",
      });
    }
    if (parks[0]) {
      pool.push({
        id: `rec_poi_park_${parks[0].name.slice(0, 20).replace(/\s/g, "_")}`,
        title: parks[0].name,
        category: "outdoor",
        reason: isRainy
          ? `A local park — check back on sunny days`
          : `One of the top green spaces in ${destination ?? "the area"}`,
        estimatedTime: "1–2 hours",
        priceLevel: "free",
      });
    }
    if (restaurants[0]) {
      pool.push({
        id: `rec_poi_restaurant_${restaurants[0].name.slice(0, 20).replace(/\s/g, "_")}`,
        title: restaurants[0].name,
        category: "food",
        reason: `Highly visited dining spot in ${destination ?? "the area"}`,
        estimatedTime: "1–1.5 hours",
        priceLevel: "$$",
      });
    }
  }

  // Events enrichment: add up to 3 nearby events as activity suggestions
  if (eventsContext?.events?.length) {
    for (const event of eventsContext.events.slice(0, 3)) {
      const safeId = `rec_event_${event.id.slice(0, 24).replace(/[^a-z0-9_]/gi, "_")}`;
      const category = event.category.toLowerCase().includes("music")
        ? "nightlife"
        : event.category.toLowerCase().includes("sport")
          ? "outdoor"
          : "activity";
      const venueText = event.venueName ? ` at ${event.venueName}` : "";
      pool.push({
        id: safeId,
        title: event.name.slice(0, 120),
        category,
        reason: `Live ${event.category} event${venueText} on ${event.localDate}`,
        estimatedTime: "2–4 hours",
        priceLevel: "$$",
      });
    }
  }

  // Filter out anything on the user's avoid list
  const filtered = avoidList.length
    ? pool.filter((r) => !avoidList.some((a) => r.category.toLowerCase().includes(a.toLowerCase())))
    : pool;

  const preferredCategories = new Set<string>([
    ...interests.map((i: string) => i.toLowerCase()),
    ...(foodPrefs.length ? ["food"] : []),
    ...(nightlifePrefs.length ? ["nightlife"] : []),
    // Boost outdoor when sunny; boost culture/wellness when rainy
    ...(isSunny ? ["outdoor"] : []),
    ...(isRainy ? ["culture", "wellness"] : []),
  ]);

  const boosted = filtered.filter((r) => preferredCategories.has(r.category));
  const rest    = filtered.filter((r) => !preferredCategories.has(r.category));
  const base    = [...boosted, ...rest].slice(0, 4);

  const gapRecs: RawRecommendation[] = gapDays.slice(0, 2).map((gapDay, i) => {
    const dayLabel = formatGapDayLabel(gapDay);
    return {
      id: `rec_gap_${i}`,
      title: `Nothing planned ${dayLabel}${dest} — explore ideas`,
      category: (boosted[i % Math.max(boosted.length, 1)] ?? rest[0] ?? filtered[0])?.category ?? "activity",
      reason: destination
        ? `${dayLabel} in ${destination} is wide open. Here are some ideas.`
        : `${dayLabel} has no plans yet. Here are some ideas.`,
      estimatedTime: "Half day",
      priceLevel: "$",
      forGapDay: gapDay,
    };
  });

  return [...base, ...gapRecs];
}

function generateGeneralRecommendations(
  preferenceProfile: any,
  pastDestinations: string[],
): RawRecommendation[] {
  const interests: string[] = preferenceProfile?.explicit?.interests ?? [];
  const avoidList: string[] = preferenceProfile?.explicit?.avoidList ?? [];

  const destHint = pastDestinations.length > 0
    ? ` (like ${pastDestinations.slice(0, 2).join(" or ")})`
    : "";

  const pool: RawRecommendation[] = [
    { id: "rec_gen_plan",    title: "Start planning your next adventure",     category: "planning",  reason: `Get inspired by destinations${destHint} you've loved`, estimatedTime: "15 min",  priceLevel: "$"   },
    { id: "rec_gen_culture", title: "Discover cultural hotspots worldwide",   category: "culture",   reason: "Broaden your horizons with art, history and local traditions",            estimatedTime: "2–3 hours",priceLevel: "$$" },
    { id: "rec_gen_food",    title: "Explore world food trails",              category: "food",      reason: "Great travel often starts with great food",                               estimatedTime: "1–2 hours", priceLevel: "$"  },
    { id: "rec_gen_outdoor", title: "Plan an outdoor adventure",              category: "outdoor",   reason: "From city parks to mountain hikes — get moving",                          estimatedTime: "Half day",  priceLevel: "$"  },
    { id: "rec_gen_bucket",  title: "Add a dream destination to your bucket list", category: "planning", reason: "Trip ideas based on where travellers like you go next",              estimatedTime: "10 min",    priceLevel: "$"  },
    { id: "rec_gen_wellness",title: "Recharge with a wellness retreat",       category: "wellness",  reason: "Between trips is the best time to plan the next reset",                  estimatedTime: "Weekend",   priceLevel: "$$$"},
  ];

  const filtered = avoidList.length
    ? pool.filter((r) => !avoidList.some((a) => r.category.toLowerCase().includes(a.toLowerCase())))
    : pool;

  const preferredCategories = new Set(interests.map((i: string) => i.toLowerCase()));
  const boosted = filtered.filter((r) => preferredCategories.has(r.category));
  const rest    = filtered.filter((r) => !preferredCategories.has(r.category));
  return [...boosted, ...rest].slice(0, 4);
}

function formatGapDayLabel(dateStr: string): string {
  return new Date(dateStr + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

/* ── Plan + meetup fetch ─────────────────────────────────────────────────── */

export async function fetchBriefData(client: any, tripId: string) {
  const [planResult, meetupsResult] = await Promise.all([
    client
      .from("trip_plan_items")
      .select("id,title,starts_at,ends_at,category,status,location_name,day_date")
      .eq("trip_id", tripId)
      .is("removed_at", null),
    client
      .from("meetups")
      .select("id,title,starts_at,status")
      .eq("trip_id", tripId)
      .then((r: any) => r, () => ({ data: [] })),
  ]);

  const meetups = meetupsResult.data ?? [];

  // Derive per-meetup attendee counts from meetup_invites (status "going") —
  // the meetups table has no attendee_count column.
  const meetupIds = meetups.map((m: any) => m.id as string).filter(Boolean);
  const countByMeetup = new Map<string, number>();
  if (meetupIds.length > 0) {
    const { data: inviteRows } = await client
      .from("meetup_invites")
      .select("meetup_id")
      .in("meetup_id", meetupIds)
      .eq("status", "going");
    for (const row of inviteRows ?? []) {
      const id = row.meetup_id as string;
      countByMeetup.set(id, (countByMeetup.get(id) ?? 0) + 1);
    }
  }

  return {
    planItems: planResult.data ?? [],
    meetups: meetups.map((m: any) => ({ ...m, attendee_count: countByMeetup.get(m.id) ?? 0 })),
  };
}

/* ── Gap-day computation ─────────────────────────────────────────────────── */

function computeTripGapDays(
  tripStartDate: string | null,
  tripEndDate: string | null,
  daysWithItems: Set<string>,
  today: string,
): string[] {
  if (!tripStartDate || !tripEndDate) return [];
  const start  = new Date(tripStartDate + "T00:00:00Z");
  const end    = new Date(tripEndDate   + "T00:00:00Z");
  const gaps: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end && gaps.length < 5) {
    const isoDate = cursor.toISOString().slice(0, 10);
    if (isoDate !== today && !daysWithItems.has(isoDate)) gaps.push(isoDate);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return gaps;
}

/* ── Build brief context ─────────────────────────────────────────────────── */

interface BriefContext {
  briefType: BriefType;
  activeTripId: string | null;
  destination: string | null;
  tripStartDate: string | null;
  tripEndDate: string | null;
  planItems: any[];
  meetups: any[];
  gapDays: string[];
  upcomingMeetups24h: UpcomingMeetup24h[];
  recommendations: RawRecommendation[];
  preferenceProfile: any;
  weatherSummary: string | null;
  weatherForecasts: DailyWeather[];
}

/** Cap the weather end date to at most `maxDays` ahead of `todayDate`, clamped to tripEndDate. */
function capForecastEnd(todayDate: string, tripEndDate: string | null, maxDays: number): string {
  const maxEnd = new Date(todayDate + "T00:00:00Z");
  maxEnd.setUTCDate(maxEnd.getUTCDate() + maxDays - 1);
  const maxEndStr = maxEnd.toISOString().slice(0, 10);
  if (!tripEndDate) return maxEndStr;
  return tripEndDate < maxEndStr ? tripEndDate : maxEndStr;
}

async function buildBriefContext(
  client: any,
  userId: string,
  requestedTripId: string,
  date: string,
  activeTrip: ActiveTripInfo | null,
): Promise<BriefContext> {
  if (!activeTrip) {
    // No active trip — generate generic inspiration brief only using preference + history
    const [preferenceProfile, pastDestinations] = await Promise.all([
      getPreferenceProfile(client, userId),
      fetchPastDestinations(client, userId),
    ]);
    return {
      briefType: "general",
      activeTripId: null,
      destination: null,
      tripStartDate: null,
      tripEndDate: null,
      planItems: [],
      meetups: [],
      gapDays: [],
      upcomingMeetups24h: [],
      recommendations: generateGeneralRecommendations(preferenceProfile, pastDestinations),
      preferenceProfile,
      weatherSummary: null,
      weatherForecasts: [],
    };
  }

  // Active trip found — use ITS data (may differ from the requested :tripId)
  const activeTripId = activeTrip.tripId;
  const destination  = activeTrip.destinationCity
    ? activeTrip.destinationCountry
      ? `${activeTrip.destinationCity}, ${activeTrip.destinationCountry}`
      : activeTrip.destinationCity
    : null;

  const now = new Date();
  const [{ planItems, meetups }, preferenceProfile, upcomingMeetups24h, weatherContext, localContext, eventsContext] = await Promise.all([
    fetchBriefData(client, activeTripId),
    getPreferenceProfile(client, userId),
    fetchUpcomingMeetups24h(client, userId, activeTripId, now),
    destination ? getWeatherContext(destination, date, capForecastEnd(date, activeTrip.endDate, 7)) : Promise.resolve(null),
    destination ? getLocalContext(destination) : Promise.resolve(null),
    destination ? getEventsNearDestination(destination, date, date) : Promise.resolve(null),
  ]);

  const daysWithItems = new Set<string>();
  for (const item of planItems) {
    if (item.day_date) daysWithItems.add(item.day_date as string);
  }
  const gapDays = computeTripGapDays(activeTrip.startDate, activeTrip.endDate, daysWithItems, date);
  const recommendations = generateTripContextRecommendations(
    preferenceProfile, destination, gapDays, weatherContext, localContext, eventsContext,
  );

  return {
    briefType: "trip_context",
    activeTripId,
    destination,
    tripStartDate: activeTrip.startDate,
    tripEndDate: activeTrip.endDate,
    planItems,
    meetups,
    gapDays,
    upcomingMeetups24h,
    recommendations,
    preferenceProfile,
    weatherSummary: weatherContext?.briefSummary ?? null,
    weatherForecasts: weatherContext?.forecasts ?? [],
  };
}

/* ── Staleness check for smart invalidation ──────────────────────────────── */

async function getLastModifiedTs(client: any, tripId: string): Promise<number> {
  const { data: tripMeetupRows } = await client
    .from("meetups")
    .select("id,updated_at")
    .eq("trip_id", tripId)
    .order("updated_at", { ascending: false });

  const meetupIds = (tripMeetupRows ?? []).map((m: any) => m.id as string);
  const latestMeetupUpdatedAt: string | null = tripMeetupRows?.[0]?.updated_at ?? null;

  const [planItemRow, rsvpRow] = await Promise.all([
    client
      .from("trip_plan_items")
      .select("updated_at")
      .eq("trip_id", tripId)
      .is("removed_at", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then((r: any) => r.data),
    meetupIds.length > 0
      ? client
          .from("meetup_invites")
          .select("updated_at")
          .in("meetup_id", meetupIds)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle()
          .then((r: any) => r.data)
      : Promise.resolve(null),
  ]);

  return Math.max(
    planItemRow?.updated_at        ? new Date(planItemRow.updated_at).getTime()        : 0,
    latestMeetupUpdatedAt          ? new Date(latestMeetupUpdatedAt).getTime()         : 0,
    rsvpRow?.updated_at            ? new Date(rsvpRow.updated_at).getTime()            : 0,
  );
}

/* ===========================================================================
 * GET /trips/:tripId/daily-brief
 * ===========================================================================
 */
router.get("/trips/:tripId/daily-brief", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { tripId } = req.params;
  if (!UUID.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const verdict = await resolveContext(client, user.id, tripId);
  if (verdict.access !== "full") {
    res.status(200).json({ access: verdict.access, denialReason: verdict.denialReason ?? "not_member", brief: null });
    return;
  }

  const nowMs = Date.now();
  const date = (req.query.date as string) ?? new Date(nowMs).toISOString().slice(0, 10);
  if (!DATE_RE.test(date)) { sendError(res, "invalid_payload", "date must be YYYY-MM-DD"); return; }

  // L1: in-memory cache (keyed per-user-per-day)
  const cached = getCachedBrief(user.id, date);
  if (cached && !isCacheStale(cached)) {
    // Authz: if the cached brief was built from a different active trip, re-validate
    // that the user is still an accepted member of that trip before serving the data.
    // Prevents exposure of trip data after membership is revoked.
    const cachedActiveTripId: string | null = cached.brief.activeTripId ?? null;
    const membershipValid = !cachedActiveTripId
      || await isAcceptedTripMember(client, cachedActiveTripId, user.id);
    if (!membershipValid) {
      invalidateBriefCache(user.id, date);
      // fall through to regenerate with fresh active-trip lookup
    } else {
      // Smart invalidation: flag isStale when source data changed since brief was built
      const activeTripForStaleCheck = cachedActiveTripId ?? tripId;
      const lastModified = await getLastModifiedTs(client, activeTripForStaleCheck);
      const isStale = lastModified > cached.builtAt;
      res.json({ access: "full", brief: { ...cached.brief, isStale, generatedAt: cached.builtAt }, fromCache: true });
      return;
    }
  }

  // L2: DB cache (durable across restarts, keyed per-user-per-day)
  const stored = await getStoredBrief(client, user.id, date);
  if (stored) {
    // Authz: same membership re-validation for DB-stored briefs
    const storedActiveTripId: string | null = stored.brief.activeTripId ?? null;
    const membershipValid = !storedActiveTripId
      || await isAcceptedTripMember(client, storedActiveTripId, user.id);
    if (!membershipValid) {
      await invalidateStoredBrief(client, user.id, date);
      // fall through to regenerate
    } else {
      const activeTripForStaleCheck = storedActiveTripId ?? tripId;
      const lastModified = await getLastModifiedTs(client, activeTripForStaleCheck);
      const isStale = lastModified > stored.generatedAt;
      // DB brief may be stale — warm L1 preserving original generatedAt so
      // subsequent L1 hits compare against the real generation time, not now.
      setCachedBrief(user.id, date, stored.brief, stored.generatedAt);
      res.json({ access: "full", brief: { ...stored.brief, isStale, generatedAt: stored.generatedAt }, fromCache: true });
      return;
    }
  }

  // Determine the user's active trip (checks owner + accepted-member across ALL trips)
  const activeTrip = await fetchActiveTripForUser(client, user.id, date);
  const ctx = await buildBriefContext(client, user.id, tripId, date, activeTrip);

  const brief = buildDailyBrief({
    tripId,
    userId: user.id,
    date,
    briefType: ctx.briefType,
    destination: ctx.destination,
    tripStartDate: ctx.tripStartDate,
    tripEndDate: ctx.tripEndDate,
    planItems: ctx.planItems,
    meetups: ctx.meetups,
    upcomingMeetups24h: ctx.upcomingMeetups24h,
    recommendations: ctx.recommendations,
    preferenceProfile: ctx.preferenceProfile,
    weatherSummary: ctx.weatherSummary,
    weatherForecasts: ctx.weatherForecasts,
  });

  // Attach activeTripId to the brief so cache invalidation knows which trip to check
  const briefWithMeta = { ...brief, activeTripId: ctx.activeTripId };

  setCachedBrief(user.id, date, briefWithMeta);
  await storeBriefInDB(client, user.id, tripId, date, ctx.briefType, briefWithMeta);

  res.json({ access: "full", brief: { ...briefWithMeta, isStale: false, generatedAt: nowMs } });
});

/* ===========================================================================
 * POST /trips/:tripId/daily-brief/refresh
 * ===========================================================================
 */
router.post("/trips/:tripId/daily-brief/refresh", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { tripId } = req.params;
  if (!UUID.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const verdict = await resolveContext(client, user.id, tripId);
  if (verdict.access !== "full") {
    res.status(200).json({ access: verdict.access, brief: null });
    return;
  }

  const dateParam = z.string().regex(DATE_RE).optional().safeParse(req.body?.date);
  const nowMs = Date.now();
  const date = dateParam.success && dateParam.data ? dateParam.data : new Date(nowMs).toISOString().slice(0, 10);

  // Always invalidate both cache layers on explicit refresh (per-user-per-day keys)
  invalidateBriefCache(user.id, date);
  await invalidateStoredBrief(client, user.id, date);

  const activeTrip = await fetchActiveTripForUser(client, user.id, date);
  const ctx = await buildBriefContext(client, user.id, tripId, date, activeTrip);

  const brief = buildDailyBrief({
    tripId,
    userId: user.id,
    date,
    briefType: ctx.briefType,
    destination: ctx.destination,
    tripStartDate: ctx.tripStartDate,
    tripEndDate: ctx.tripEndDate,
    planItems: ctx.planItems,
    meetups: ctx.meetups,
    upcomingMeetups24h: ctx.upcomingMeetups24h,
    recommendations: ctx.recommendations,
    preferenceProfile: ctx.preferenceProfile,
    weatherSummary: ctx.weatherSummary,
    weatherForecasts: ctx.weatherForecasts,
  });

  const briefWithMeta = { ...brief, activeTripId: ctx.activeTripId };
  const refreshedAt = nowMs;
  setCachedBrief(user.id, date, briefWithMeta);
  await storeBriefInDB(client, user.id, tripId, date, ctx.briefType, briefWithMeta);

  res.json({ access: "full", brief: { ...briefWithMeta, isStale: false, generatedAt: refreshedAt }, refreshed: true });
});

/* ===========================================================================
 * POST /trips/:tripId/daily-brief/actions/:actionId
 * ===========================================================================
 */
router.post("/trips/:tripId/daily-brief/actions/:actionId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { tripId, actionId } = req.params;
  if (!UUID.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const member = await isAcceptedTripMember(client, tripId, user.id);
  if (!member) { sendError(res, "not_member", "You must be an accepted trip member"); return; }

  const VALID_ACTIONS = ["view_plan", "ask_telegraph", "add_to_plan", "create_meetup", "open_poll"];
  if (!VALID_ACTIONS.includes(actionId)) {
    sendError(res, "invalid_payload", `Unknown action: ${actionId}`);
    return;
  }

  res.json({ ok: true, actionId, tripId, requiresConfirmation: actionId !== "view_plan" && actionId !== "ask_telegraph" });
});

/* ===========================================================================
 * POST /trips/:tripId/daily-brief/dismiss/:recommendationId
 * ===========================================================================
 */
router.post("/trips/:tripId/daily-brief/dismiss/:recommendationId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { tripId, recommendationId } = req.params;
  if (!UUID.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const member = await isAcceptedTripMember(client, tripId, user.id);
  if (!member) { sendError(res, "not_member", "You must be an accepted trip member"); return; }

  // best-effort
  {
    const { error: evtError } = await client.from("user_preference_events").insert({
      user_id:           user.id,
      recommendation_id: recommendationId,
      category:          req.body?.category ?? "unknown",
      signal:            "dismiss",
      trip_id:           tripId,
      created_at:        new Date().toISOString(),
    });
    if (evtError) briefLogger.warn({ err: evtError, recommendationId }, "dismiss preference event insert failed (best-effort)");
  }

  res.json({ ok: true, dismissed: recommendationId });
});

export default router;
