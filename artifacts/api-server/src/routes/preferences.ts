/**
 * User Preference Routes
 *
 * GET    /api/me/preferences           — fetch full preference profile
 * PATCH  /api/me/preferences           — update explicit preferences
 * POST   /api/me/preferences/events    — record a preference signal event
 * POST   /api/me/preferences/reset-learned — clear inferred_preferences_json only
 * GET    /api/me/preferences/summary   — lightweight summary for UI
 *
 * All routes resolve identity from auth token only — never from request body.
 */
import { Router } from "express";
import { z } from "zod";
import { logger as rootLogger } from "../lib/logger.js";
import { requireUser, sendError } from "../lib/http.js";
import { invalidateCompassHomeCache } from "./compassHome.js";

const prefsLogger = rootLogger.child({ route: "preferences" });
import {
  defaultExplicit,
  defaultInferred,
  applyEvent,
  type FeedbackSignal,
} from "../lib/preferenceLearning.js";

const router = Router();

const VALID_SIGNALS: FeedbackSignal[] = [
  "save", "add_to_plan", "more_like_this", "less_like_this",
  "not_for_me", "dismiss", "view", "share",
];
const VALID_PACES = ["relaxed", "balanced", "packed"] as const;
const VALID_GROUPS = ["solo", "small", "group", "mixed"] as const;
const VALID_TIMES = ["morning", "afternoon", "evening", "late_night"] as const;

const PatchPreferencesSchema = z.object({
  interests:               z.array(z.string().max(50)).max(20).optional(),
  foodPreferences:         z.array(z.string().max(50)).max(20).optional(),
  nightlifePreferences:    z.array(z.string().max(50)).max(20).optional(),
  pace:                    z.enum(VALID_PACES).optional(),
  groupStyle:              z.enum(VALID_GROUPS).optional(),
  preferredActivityTimes:  z.array(z.enum(VALID_TIMES)).max(4).optional(),
  avoidList:               z.array(z.string().max(50)).max(30).optional(),
});

const PreferenceEventSchema = z.object({
  recommendationId: z.string().min(1).max(120),
  category:         z.string().min(1).max(80),
  signal:           z.enum(VALID_SIGNALS as [FeedbackSignal, ...FeedbackSignal[]]),
  tripId:           z.string().optional().nullable(),
});

/* ── helpers ── */

async function getOrCreateProfile(client: any, userId: string) {
  const { data, error } = await client
    .from("user_preference_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return null;
  if (data) return data;

  const blank = {
    user_id: userId,
    explicit_preferences_json: JSON.stringify(defaultExplicit()),
    inferred_preferences_json: JSON.stringify(defaultInferred()),
  };
  const { data: created } = await client
    .from("user_preference_profiles")
    .insert(blank)
    .select("*")
    .single();
  return created ?? null;
}

function parseProfile(row: any) {
  const explicit = (() => { try { return JSON.parse(row.explicit_preferences_json); } catch { return defaultExplicit(); } })();
  const inferred = (() => { try { return JSON.parse(row.inferred_preferences_json); } catch { return defaultInferred(); } })();
  return { userId: row.user_id, explicit, inferred, lastUpdatedAt: row.updated_at ?? row.created_at };
}

/* ===========================================================================
 * GET /me/preferences
 * ===========================================================================
 */
router.get("/me/preferences", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const row = await getOrCreateProfile(client, user.id);
  if (!row) { sendError(res, "db_error", "Could not load preference profile", { exposeDetail: true }); return; }

  res.json(parseProfile(row));
});

/* ===========================================================================
 * PATCH /me/preferences
 * ===========================================================================
 */
router.patch("/me/preferences", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = PatchPreferencesSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const patch = parsed.data;

  const row = await getOrCreateProfile(client, user.id);
  if (!row) { sendError(res, "db_error", "Could not load preference profile", { exposeDetail: true }); return; }

  const current = (() => { try { return JSON.parse(row.explicit_preferences_json); } catch { return defaultExplicit(); } })();
  const merged = { ...current, ...patch };

  const { error } = await client
    .from("user_preference_profiles")
    .update({
      explicit_preferences_json: JSON.stringify(merged),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id);

  if (error) { sendError(res, "db_error", error.message); return; }

  invalidateCompassHomeCache(user.id);

  res.json({ ok: true, explicit: merged });
});

/* ===========================================================================
 * POST /me/preferences/events
 * ===========================================================================
 */
router.post("/me/preferences/events", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = PreferenceEventSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const { recommendationId, category, signal, tripId } = parsed.data;

  const now = new Date().toISOString();

  const { error: evtError } = await client
    .from("user_preference_events")
    .insert({
      user_id:           user.id,
      recommendation_id: recommendationId,
      category,
      signal,
      trip_id:           tripId ?? null,
      created_at:        now,
    });

  if (evtError) { req.log.warn({ err: evtError }, "Failed to insert preference event"); }

  // Update inferred profile
  const row = await getOrCreateProfile(client, user.id);
  if (row) {
    const inferred = (() => { try { return JSON.parse(row.inferred_preferences_json); } catch { return defaultInferred(); } })();
    const updated = applyEvent(inferred, { userId: user.id, recommendationId, category, signal, createdAt: now, tripId });
    await client
      .from("user_preference_profiles")
      .update({ inferred_preferences_json: JSON.stringify(updated), updated_at: now })
      .eq("user_id", user.id);
  }

  res.status(201).json({ ok: true, signal, category });
});

/* ===========================================================================
 * POST /me/preferences/reset-learned
 * ===========================================================================
 */
router.post("/me/preferences/reset-learned", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const blank = JSON.stringify(defaultInferred());
  const { error } = await client
    .from("user_preference_profiles")
    .update({ inferred_preferences_json: blank, updated_at: new Date().toISOString() })
    .eq("user_id", user.id);

  if (error) { sendError(res, "db_error", error.message); return; }

  // Events are retained for analytics; only the computed inferred profile is cleared.
  res.json({ ok: true, reset: "learned_preferences" });
});

/* ===========================================================================
 * GET /me/preferences/summary
 * ===========================================================================
 */
router.get("/me/preferences/summary", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const row = await getOrCreateProfile(client, user.id);
  if (!row) { sendError(res, "db_error", "Could not load preference profile", { exposeDetail: true }); return; }

  const profile = parseProfile(row);
  const topCategories = Object.entries(profile.inferred.categoryAffinities as Record<string, number>)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([cat, score]) => ({ category: cat, score: Math.round(score * 100) / 100 }));

  res.json({
    interests:    profile.explicit.interests,
    pace:         profile.explicit.pace,
    groupStyle:   profile.explicit.groupStyle,
    avoidList:    profile.explicit.avoidList,
    topInferred:  topCategories,
    lastUpdatedAt: profile.lastUpdatedAt,
  });
});

/**
 * POST /api/me/preferences/mute-category  — permanently suppress a content category (#155).
 * Writes a "mute" signal to user_preference_events; the learning system
 * treats this as a strong persistent skip and suppresses the category from feeds.
 */
router.post("/me/preferences/mute-category", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const category = typeof req.body?.category === "string" ? req.body.category.trim().toLowerCase() : "";
  if (!category) { sendError(res, "invalid_payload", "category is required"); return; }

  // best-effort — table may not exist in all environments
  {
    const { error } = await client.from("user_preference_events").insert({
      user_id:           user.id,
      // NOT `null`. user_preference_events.recommendation_id is `text NOT NULL`,
      // so this insert raised 23502 every time — and because the failure is
      // swallowed as best-effort below, the endpoint still answered 200
      // {muted:true} while writing nothing. Muting a category silently did not
      // work. A mute has no originating recommendation, so this uses a synthetic
      // id, exactly as telegraphCommands does with `${commandId}:${actionId}`;
      // the column is text, not a uuid reference.
      recommendation_id: `mute:${category}`,
      category,
      signal:            "mute",
      created_at:        new Date().toISOString(),
    });
    if (error) prefsLogger.warn({ err: error, category }, "mute preference event insert failed (best-effort)");
  }

  res.status(200).json({ ok: true, muted: true, category });
});

export default router;
