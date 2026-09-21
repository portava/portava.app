/**
 * GET /api/wall/moments — Sensing §9: the server-built WallMoment projection,
 * and §15: every world change routed through the Attention Engine before it
 * is told where it goes.
 *
 * For each subject the client names (its saved places, trip stops, the
 * places it is near — a viewer-relevant, bounded set, never a city-wide
 * scan, exactly the Live For You rule) the route reads the CURRENT claims
 * through lib/liveClaimRead — the one gated read path — and the PREVIOUS
 * readings from the projection's own record, detects the transitions between
 * them, builds the moments, and routes each through the Attention Engine for
 * THIS viewer: relevance as the client declared it, novelty from the ids the
 * client says it has shown, availability from the viewer's notification
 * preferences (quiet hours, push), interruption cost from the notifications
 * delivered in the last hour. The answer is chronological — newest change
 * first — and carries, per moment, the route and its factors.
 *
 * What it does NOT do: send anything. NOTIFY is a routing decision on the
 * wire; no dispatcher consumes it yet. And it never serves a previous value
 * on its own: a moment is a change, and only the current side is served.
 *
 * Gated by `wall_enabled` (the Wall's master, 2270) and `wall_moments_enabled`
 * (migration 2801, seeded FALSE), both read fail-closed. A history read that
 * fails is reported per subject as a refusal, never as "no moments".
 *
 * Security: requireUser. Nothing person-shaped is on the wire.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { liveLabelsServable, readLiveClaimEnvelopes } from "../lib/liveClaimRead.js";
import { buildWallMoments, type WallMoment } from "../lib/wallMoments.js";
import { readPreviousReadings } from "../lib/wallMomentRead.js";
import { ATTENTION_RELEVANCE, ATTENTION_WINDOW_MINUTES, routeAttention, type AttentionDecision } from "../lib/attentionEngine.js";
import { NotificationPreferenceService } from "../services/notifications/NotificationPreferenceService.js";

const router = Router();

/** Literal names so check-flag-polarity resolves the reads. `*_enabled` ⇒ capability, fail-closed. */
export const WALL_MOMENTS_FLAG = "wall_moments_enabled";
/** Subjects one request may name. */
export const WALL_MOMENTS_MAX_SUBJECTS = 20;
/** The claim types a place moment can be evidenced by. */
export const WALL_MOMENT_CLAIM_TYPES = ["crowd.level", "crowd.trajectory", "vibe.state", "queue.wait"] as const;

const uuidList = z
  .string()
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.string().uuid()).min(1).max(WALL_MOMENTS_MAX_SUBJECTS));
const querySchema = z.object({
  subjectIds: uuidList,
  relevance: z.enum(ATTENTION_RELEVANCE).default("nearby"),
  seen: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 200) : [])),
});

export interface WallMomentSubjectReport {
  subjectId: string;
  /** Null when the history was read; otherwise why it could not be, so "no moments" is never ambiguous. */
  refusal: "live_intelligence_unavailable" | "versions_unavailable" | "error" | null;
  moments: number;
}

async function viewerAvailability(sc: any, userId: string, now: Date): Promise<boolean | null> {
  const svc = new NotificationPreferenceService(sc);
  const { prefs, readFailed } = await svc.getPreferencesResult(userId);
  if (readFailed) return null; // an unreadable consent is never read as consent
  if ((prefs as { pushEnabled?: boolean }).pushEnabled === false) return false;
  if (prefs.quietHoursEnabled && svc.isQuietHour(prefs, now)) return false;
  return true;
}

/** Interruptions delivered to the viewer in the attention window; null when unknowable. */
async function notifiesInWindow(sc: any, userId: string, now: Date): Promise<number | null> {
  try {
    const since = new Date(now.getTime() - ATTENTION_WINDOW_MINUTES * 60_000).toISOString();
    const { count, error } = await sc
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", since);
    if (error) return null;
    return typeof count === "number" ? count : null;
  } catch {
    return null;
  }
}

router.get(
  "/wall/moments",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured", "Service client unavailable");
      return;
    }
    if (!(await isFlagEnabled(sc, "wall_enabled"))) {
      sendError(res, "feature_disabled", "The Wall is not enabled");
      return;
    }
    if (!(await isFlagEnabled(sc, "wall_moments_enabled"))) {
      sendError(res, "feature_disabled", "Wall moments are not enabled");
      return;
    }
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query");
      return;
    }
    const q = parsed.data;
    const now = new Date();
    const nowMs = now.getTime();

    const readable = await liveLabelsServable(sc);
    const [available, interruptions] = await Promise.all([viewerAvailability(sc, auth.user.id, now), notifiesInWindow(sc, auth.user.id, now)]);
    const seen = new Set(q.seen);

    const subjects: WallMomentSubjectReport[] = [];
    const moments: Array<WallMoment & { attention: AttentionDecision }> = [];
    for (const subjectId of q.subjectIds) {
      if (!readable) {
        subjects.push({ subjectId, refusal: "live_intelligence_unavailable", moments: 0 });
        continue;
      }
      const current = await readLiveClaimEnvelopes(sc, subjectId, { claimTypes: WALL_MOMENT_CLAIM_TYPES, now });
      if (current.length === 0) {
        subjects.push({ subjectId, refusal: null, moments: 0 });
        continue;
      }
      const previous = await readPreviousReadings(sc, subjectId, WALL_MOMENT_CLAIM_TYPES);
      if (!previous.ok) {
        subjects.push({ subjectId, refusal: previous.reason === "no_client" ? "error" : previous.reason, moments: 0 });
        continue;
      }
      const built = buildWallMoments(subjectId, current, previous.readings, nowMs);
      for (const m of built) {
        const attention = routeAttention(
          m,
          {
            relevance: q.relevance,
            seenMomentIds: seen,
            available,
            // An unknowable interruption count is treated as the budget spent:
            // the engine then defers to the Wall rather than interrupting.
            notifiesInWindow: interruptions ?? Number.MAX_SAFE_INTEGER,
          },
          nowMs,
        );
        moments.push({ ...m, attention });
      }
      subjects.push({ subjectId, refusal: null, moments: built.length });
    }
    moments.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));

    res.json({
      ok: true,
      moments,
      subjects,
      viewer: { relevance: q.relevance, available, notifiesInWindow: interruptions },
      liveIntelligenceReadable: readable,
      generatedAt: now.toISOString(),
    });
  }),
);

export default router;
