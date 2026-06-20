/**
 * Daily Trip Brief Routes
 *
 * GET  /api/trips/:tripId/daily-brief?date=YYYY-MM-DD  — fetch brief for a date
 * POST /api/trips/:tripId/daily-brief/refresh           — force refresh (clears cache)
 * POST /api/trips/:tripId/daily-brief/actions/:actionId — execute a quick action
 * POST /api/trips/:tripId/daily-brief/dismiss/:recommendationId — dismiss a suggestion
 *
 * Access: accepted trip members only. Non-members get access_denied, not 403.
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError, isAcceptedTripMember } from "../lib/http.js";
import { resolveContext } from "../lib/privacyResolver.js";
import { buildDailyBrief, type RawRecommendation } from "../lib/dailyBriefEngine.js";
import { defaultExplicit, defaultInferred } from "../lib/preferenceLearning.js";

const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ── In-memory Brief Cache ─────────────────────────────────────────────────
 * Key: `${userId}:${tripId}:${date}`
 * TTL: 5 minutes. Invalidated explicitly by POST /refresh.
 * Invalidation hooks for plan-item / meetup writes are a follow-up task (#41).
 */
const BRIEF_CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes
interface CachedBrief { brief: any; builtAt: number }
const briefCache = new Map<string, CachedBrief>();

function briefCacheKey(userId: string, tripId: string, date: string): string {
  return `${userId}:${tripId}:${date}`;
}

function getCachedBrief(userId: string, tripId: string, date: string): CachedBrief | null {
  const key = briefCacheKey(userId, tripId, date);
  const cached = briefCache.get(key);
  if (!cached) return null;
  return cached;
}

function setCachedBrief(userId: string, tripId: string, date: string, brief: any): void {
  briefCache.set(briefCacheKey(userId, tripId, date), { brief, builtAt: Date.now() });
}

function invalidateBriefCache(userId: string, tripId: string, date: string): void {
  briefCache.delete(briefCacheKey(userId, tripId, date));
}

function isCacheStale(cached: CachedBrief): boolean {
  return Date.now() - cached.builtAt > BRIEF_CACHE_TTL_MS;
}

async function getPreferenceProfile(client: any, userId: string) {
  const { data } = await client
    .from("user_preference_profiles")
    .select("explicit_preferences_json,inferred_preferences_json,updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  const explicit = (() => { try { return JSON.parse(data.explicit_preferences_json); } catch { return defaultExplicit(); } })();
  const inferred = (() => { try { return JSON.parse(data.inferred_preferences_json); } catch { return defaultInferred(); } })();
  return { userId, explicit, inferred, lastUpdatedAt: data.updated_at };
}

/**
 * Build a set of context-aware RawRecommendations from the user's preference
 * profile and the trip's destination. These are scored and sorted by
 * buildDailyBrief using the full preference profile.
 */
function generateContextualRecommendations(
  preferenceProfile: { explicit: ReturnType<typeof defaultExplicit>; inferred: ReturnType<typeof defaultInferred> } | null,
  destination?: string,
): RawRecommendation[] {
  const dest = destination ? ` in ${destination}` : "";
  const interests: string[] = preferenceProfile?.explicit?.interests ?? [];
  const foodPrefs: string[] = preferenceProfile?.explicit?.foodPreferences ?? [];
  const nightlifePrefs: string[] = preferenceProfile?.explicit?.nightlifePreferences ?? [];
  const avoidList: string[] = preferenceProfile?.explicit?.avoidList ?? [];

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
      reason: "Fresh air and local scenery",
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

  // Filter out anything on the user's avoid list
  const filtered = avoidList.length
    ? pool.filter((r) => !avoidList.some((a) => r.category.toLowerCase().includes(a.toLowerCase())))
    : pool;

  // Boost categories matching explicit interests / food / nightlife prefs
  const preferredCategories = new Set<string>([
    ...interests.map((i) => i.toLowerCase()),
    ...(foodPrefs.length ? ["food"] : []),
    ...(nightlifePrefs.length ? ["nightlife"] : []),
  ]);

  const boosted = filtered.filter((r) => preferredCategories.has(r.category));
  const rest    = filtered.filter((r) => !preferredCategories.has(r.category));

  // Return up to 6: preference-matching ones first, then fill from the rest
  return [...boosted, ...rest].slice(0, 6);
}

async function fetchBriefData(client: any, tripId: string, date: string) {
  const [planResult, meetupsResult] = await Promise.all([
    client
      .from("trip_plan_items")
      .select("id,title,starts_at,ends_at,category,status,location_name,day_date")
      .eq("trip_id", tripId)
      .is("removed_at", null),
    client
      .from("meetups")
      .select("id,title,proposed_time,attendee_count,status")
      .eq("trip_id", tripId)
      .then((r: any) => r, () => ({ data: [] })),
  ]);
  return {
    planItems: planResult.data ?? [],
    meetups: meetupsResult.data ?? [],
  };
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
    res.status(200).json({
      access: verdict.access,
      denialReason: verdict.denialReason ?? "not_member",
      brief: null,
    });
    return;
  }

  const date = (req.query.date as string) ?? new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(date)) { sendError(res, "invalid_payload", "date must be YYYY-MM-DD"); return; }

  const destination = (req.query.destination as string | undefined) ?? undefined;

  // Check cache freshness against all contributing data sources:
  // plan items, meetups (create/cancel/update), and RSVP changes.
  // If any source was modified after the brief was built, rebuild.
  const cached = getCachedBrief(user.id, tripId, date);
  if (cached && !isCacheStale(cached)) {
    // Resolve meetup IDs first so RSVP check can use them without nested awaits.
    const { data: tripMeetupRows } = await client
      .from("meetups")
      .select("id, updated_at")
      .eq("trip_id", tripId)
      .order("updated_at", { ascending: false });

    const meetupIds = (tripMeetupRows ?? []).map((m: any) => m.id as string);
    const latestMeetupUpdatedAt = tripMeetupRows?.[0]?.updated_at ?? null;

    const [planItemRow, rsvpRow] = await Promise.all([
      client
        .from("trip_plan_items")
        .select("updated_at")
        .eq("trip_id", tripId)
        .is("removed_at", null)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()
        .then((r) => r.data),
      meetupIds.length > 0
        ? client
            .from("meetup_invites")
            .select("updated_at")
            .in("meetup_id", meetupIds)
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle()
            .then((r) => r.data)
        : Promise.resolve(null),
    ]);

    const lastModified = Math.max(
      planItemRow?.updated_at        ? new Date(planItemRow.updated_at).getTime()        : 0,
      latestMeetupUpdatedAt          ? new Date(latestMeetupUpdatedAt).getTime()          : 0,
      rsvpRow?.updated_at            ? new Date(rsvpRow.updated_at).getTime()            : 0,
    );

    if (lastModified <= cached.builtAt) {
      res.json({ access: "full", brief: { ...cached.brief, isStale: false }, fromCache: true });
      return;
    }
    // A contributing source was modified after the brief was built — rebuild.
  }

  const [{ planItems, meetups }, preferenceProfile] = await Promise.all([
    fetchBriefData(client, tripId, date),
    getPreferenceProfile(client, user.id),
  ]);

  const recommendations = generateContextualRecommendations(preferenceProfile, destination);

  const brief = buildDailyBrief({
    tripId,
    userId: user.id,
    date,
    planItems,
    meetups,
    recommendations,
    preferenceProfile,
  });

  setCachedBrief(user.id, tripId, date, brief);
  res.json({ access: "full", brief });
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
  const date = dateParam.success && dateParam.data ? dateParam.data : new Date().toISOString().slice(0, 10);
  const destination = typeof req.body?.destination === "string" ? req.body.destination : undefined;

  // Explicit refresh — invalidate cache before rebuilding
  invalidateBriefCache(user.id, tripId, date);

  const [{ planItems, meetups }, preferenceProfile] = await Promise.all([
    fetchBriefData(client, tripId, date),
    getPreferenceProfile(client, user.id),
  ]);

  const recommendations = generateContextualRecommendations(preferenceProfile, destination);

  const brief = buildDailyBrief({
    tripId,
    userId: user.id,
    date,
    planItems,
    meetups,
    recommendations,
    preferenceProfile,
  });

  setCachedBrief(user.id, tripId, date, brief);
  res.json({ access: "full", brief, refreshed: true });
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

  try {
    await client.from("user_preference_events").insert({
      user_id:           user.id,
      recommendation_id: recommendationId,
      category:          req.body?.category ?? "unknown",
      signal:            "dismiss",
      trip_id:           tripId,
      created_at:        new Date().toISOString(),
    });
  } catch { /* best-effort */ }

  res.json({ ok: true, dismissed: recommendationId });
});

export default router;
