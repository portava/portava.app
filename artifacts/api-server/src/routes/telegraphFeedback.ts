/**
 * Telegraph Feedback Routes
 *
 * POST /api/telegraph/recommendations/:id/feedback
 *   Records a preference signal for a recommendation and updates
 *   the user's inferred preference profile.
 *
 * Signals: more_like_this | less_like_this | not_for_me | save | dismiss
 */
import { Router } from "express";
import { z } from "zod";
import { logger as rootLogger } from "../lib/logger.js";
import { requireUser, sendError } from "../lib/http.js";

const fbLogger = rootLogger.child({ route: "telegraphFeedback" });
import { applyEvent, defaultExplicit, defaultInferred, type FeedbackSignal } from "../lib/preferenceLearning.js";

const router = Router();

const VALID_SIGNALS: FeedbackSignal[] = [
  "save", "add_to_plan", "more_like_this", "less_like_this",
  "not_for_me", "dismiss", "view", "share",
];

const FeedbackSchema = z.object({
  category: z.string().min(1).max(80),
  signal:   z.enum(VALID_SIGNALS as [FeedbackSignal, ...FeedbackSignal[]]),
  tripId:   z.string().optional().nullable(),
});

/**
 * Returns the caller's inferred preference profile, or null when the profile
 * could not be READ.
 *
 * The null is load-bearing. supabase-js RESOLVES on a DB error, so this read
 * used to answer "no profile exists" for an unreadable
 * user_preference_profiles — and the caller then UPDATEs that row with
 * defaultInferred() plus the one event just received, silently overwriting
 * every preference the user has accumulated with a blank profile. There is no
 * copy of the old JSON anywhere, so that write is unrecoverable; the route
 * refuses the feedback instead.
 */
async function getOrCreateInferred(client: any, userId: string) {
  const { data, error } = await client
    .from("user_preference_profiles")
    .select("inferred_preferences_json")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    fbLogger.error({ err: error, userId }, "inferred preference profile read failed — refusing to overwrite it with defaults");
    return null;
  }
  if (data) {
    try { return JSON.parse(data.inferred_preferences_json); } catch { return defaultInferred(); }
  }
  // Create blank profile with full defaults so scoreRecommendation is always safe.
  const blank = { user_id: userId, explicit_preferences_json: JSON.stringify(defaultExplicit()), inferred_preferences_json: JSON.stringify(defaultInferred()) };
  // best-effort
  const { error: blankError } = await client.from("user_preference_profiles").insert(blank);
  if (blankError && blankError.code !== "23505") {
    fbLogger.warn({ err: blankError, userId }, "blank preference profile insert failed (best-effort)");
  }
  return defaultInferred();
}

/* ===========================================================================
 * POST /telegraph/recommendations/:id/feedback
 * ===========================================================================
 */
router.post("/telegraph/recommendations/:id/feedback", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { id: recommendationId } = req.params;

  const parsed = FeedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const { category, signal, tripId } = parsed.data;
  const now = new Date().toISOString();

  // Record preference event (best-effort)
  {
    const { error: evtError } = await client.from("user_preference_events").insert({
      user_id:           user.id,
      recommendation_id: recommendationId,
      category,
      signal,
      trip_id:           tripId ?? null,
      created_at:        now,
    });
    if (evtError) fbLogger.warn({ err: evtError, recommendationId }, "feedback preference event insert failed (best-effort)");
  }

  // Update inferred profile
  const inferred = await getOrCreateInferred(client, user.id);
  if (inferred === null) {
    sendError(res, "db_error", "Could not read your preference profile — feedback not applied");
    return;
  }
  const updated = applyEvent(inferred, {
    userId: user.id,
    recommendationId,
    category,
    signal,
    createdAt: now,
    tripId,
  });

  // ── THE FEEDBACK *IS* THIS WRITE, AND IT WAS ISSUED BLIND ──────────────────
  // `await client.from(...).update(...).eq(...)` with no `.select()` and no
  // `{ error }`. supabase-js RESOLVES on a database error, so an UPDATE that
  // never landed returned exactly what a successful one returns and the route
  // answered HTTP 201 `{ ok: true }` — "your feedback was applied" for a
  // preference profile nobody wrote to. The signal is not queued anywhere and
  // the client has no reason to resend, so it is simply gone; the next
  // recommendation is scored off the unchanged profile and the user watches the
  // thing they just said "less like this" about come back.
  //
  // getOrCreateInferred above already refuses to proceed when this same row
  // cannot be READ, precisely so it is not overwritten with defaults. Leaving
  // the WRITE unobserved made that care one-sided.
  //
  // ZERO ROWS IS THE SAME LOSS BY A DIFFERENT CAUSE, and it is closed here too.
  // The blank-profile insert in getOrCreateInferred is best-effort, so when it
  // fails the row does not exist and this UPDATE applies to nothing while
  // resolving perfectly cleanly. `.select("user_id")` is what makes that
  // visible: without it PostgREST returns data: null and no caller can tell one
  // affected row from none.
  //
  // This was recorded as STILL OPEN one change ago, because
  // src/test/intelligence.test.ts's fake never persisted its
  // user_preference_profiles insert into fake state, so the row-count branch
  // would have reported zero rows for every feedback case and reddened seven of
  // them. The fake was taught to persist that insert in the same change that
  // landed this. The fixture was the obstacle, not the fix.
  const { data: saved, error: saveErr } = await client
    .from("user_preference_profiles")
    .update({
      inferred_preferences_json: JSON.stringify(updated),
      updated_at: now,
    })
    .eq("user_id", user.id)
    .select("user_id");

  if (saveErr) {
    fbLogger.error({ err: saveErr, userId: user.id, recommendationId }, "inferred preference profile write failed — feedback not applied");
    sendError(res, "db_error", "Could not save your preference profile — feedback not applied");
    return;
  }

  if (!Array.isArray(saved) || saved.length === 0) {
    fbLogger.error(
      { userId: user.id, recommendationId },
      "inferred preference profile UPDATE matched no row — the profile does not exist, feedback not applied",
    );
    sendError(res, "db_error", "Could not save your preference profile — feedback not applied");
    return;
  }

  res.status(201).json({ ok: true, signal, category, recommendationId });
});

export default router;
