/**
 * Media v2 — World-first projection endpoints (spec §43).
 *
 *   GET /api/media/world                     §4.1  city visual state + for-you-now + changing-now
 *   GET /api/media/places/:placeId           §13   current-view mosaic + perspective groups + freshness
 *   GET /api/media/experiences/:experienceId §23   event/trip experience projection
 *   GET /api/media/people                    §27   followed / crew / creators lens
 *   GET /api/media/me                         §30   owner library (My World)
 *   GET /api/media/timeline                   §17   Earlier / Now rails (observed only, no forecast)
 *   GET /api/media/map                        §21   perspective counts per canonical place
 *
 * ADDITIVE. These are NEW routes and touch NO existing media serving
 * (mediaFeed.ts is unchanged). They are registered BEFORE mediaFeedRouter in
 * routes/index.ts so the specific `/media/world` etc. paths are not swallowed by
 * mediaFeed's `/media/:id`.
 *
 * INVARIANTS (enforced, not hoped for):
 *   • requireUser on every route (auth + ban gate).
 *   • Viewer eligibility resolves BEFORE projection — blocks / mutes / private /
 *     restricted content is dropped inside the shared eligibility gate
 *     (lib/mediaEligibility) before anything is shaped.
 *   • NO precise media location leaves this router. The projectors are coarse by
 *     construction; scrubPreciseLocation is a fail-closed boundary backstop that
 *     removes (and counts) any coordinate key a regression might reintroduce.
 *   • COARSE IS NOT THE SAME AS SAFE. Place-level IS the venue: a projection's
 *     `placeLabel` is the stored `location_name` and its `placeId` resolves to
 *     that same venue through the Map gateway. Every projection here therefore
 *     goes through MediaProjectionService.projectCandidatesProtected — the
 *     lib/mediaLocationVisibility choke point — so the OWNER's
 *     `location_privacy_mode` and any hosting Hidden Gem's ceiling bind before
 *     the venue is named. scrubPreciseLocation stays the last line, not the
 *     first.
 *   • NO fabricated live/"busy now": current state comes only from the gated
 *     live-claim read, which returns nothing when live is off/stale/unpromoted.
 *   • Empty data yields a well-formed empty projection, never an error
 *     (pre-launch = empty is normal).
 */

import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { logger } from "../lib/logger.js";
import { scrubPreciseLocation } from "../lib/media/mediaLocationSafety.js";
import {
  resolveViewer,
  buildWorldProjection,
  buildPlaceProjection,
  buildPeopleProjection,
  buildMyWorldProjection,
  buildTimelineProjection,
  buildMediaMapProjection,
} from "../services/media/MediaProjectionService.js";
import { resolveExperience } from "../services/media/MediaExperienceResolver.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse a coarse `city` query param — a plain label, capped, or null. */
function parseCity(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.trim();
  if (c.length === 0 || c.length > 120) return null;
  return c;
}

/**
 * Send a projection, applying the fail-closed precise-location boundary scrub.
 * In the healthy case nothing is removed; if anything ever is, it is logged so
 * the leak is visible rather than silent.
 *
 * EXPORTED FOR PROOF, not for reuse. Until 2026-09-05 this whole second line of
 * defence was untested wiring: replacing the body with `res.json(payload)` left
 * every media suite green, because the projectors are already coarse so no test
 * fixture could ever reach the scrub with a coordinate on it. The scrub could
 * have been deleted from all seven endpoints and nothing would have noticed —
 * which is the definition of a defence that is not there.
 * `src/test/mediaWorldBoundaryScrub.test.ts` now drives this function directly
 * with a payload that DOES carry coordinates, and separately asserts that every
 * response in this router still leaves through it.
 */
export function sendProjection(res: any, route: string, payload: unknown): void {
  const { value, removed } = scrubPreciseLocation(payload);
  if (removed > 0) {
    logger.error(
      { route, removed },
      "mediaWorld: precise-location keys were scrubbed at the response boundary — a projector regressed",
    );
  }
  res.json(value);
}

// ── GET /media/world ─────────────────────────────────────────────────────────
router.get(
  "/media/world",
  asyncHandler(async (req, res) => {
    const nowMs = Date.now();
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const rl = checkRateLimit("media_world", auth.user.id, 60, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }
    const viewer = await resolveViewer(sc, auth.user.id, { needFollows: false });
    const projection = await buildWorldProjection(sc, viewer, parseCity(req.query.city), nowMs);
    sendProjection(res, "world", projection);
  }),
);

// ── GET /media/places/:placeId ───────────────────────────────────────────────
router.get(
  "/media/places/:placeId",
  asyncHandler(async (req, res) => {
    const nowMs = Date.now();
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const placeId = String(req.params.placeId ?? "");
    if (!UUID_RE.test(placeId)) {
      sendError(res, "invalid_payload", "Invalid place id");
      return;
    }
    const rl = checkRateLimit("media_place", auth.user.id, 120, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }
    const viewer = await resolveViewer(sc, auth.user.id, { needFollows: false });
    const projection = await buildPlaceProjection(sc, viewer, placeId, nowMs);
    sendProjection(res, "place", projection);
  }),
);

// ── GET /media/experiences/:experienceId ─────────────────────────────────────
router.get(
  "/media/experiences/:experienceId",
  asyncHandler(async (req, res) => {
    const nowMs = Date.now();
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const experienceId = String(req.params.experienceId ?? "");
    if (!UUID_RE.test(experienceId)) {
      sendError(res, "invalid_payload", "Invalid experience id");
      return;
    }
    const rl = checkRateLimit("media_experience", auth.user.id, 120, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }
    const viewer = await resolveViewer(sc, auth.user.id, { needFollows: false });
    const projection = await resolveExperience(sc, viewer, experienceId, nowMs);
    if (!projection) {
      // Not visible to this viewer (private / blocked / ineligible) or not found.
      // A well-formed empty shape rather than a probe-able 404.
      sendProjection(res, "experience", {
        id: experienceId,
        kind: null,
        title: null,
        available: false,
        placeIds: [],
        perspectiveCount: 0,
        contributorCount: 0,
        freshness: "none",
        currentState: { live: false, claims: [], crowdLabel: null },
        heroMedia: [],
        generatedAt: new Date(nowMs).toISOString(),
      });
      return;
    }
    sendProjection(res, "experience", { ...projection, available: true, generatedAt: new Date(nowMs).toISOString() });
  }),
);

// ── GET /media/people ────────────────────────────────────────────────────────
router.get(
  "/media/people",
  asyncHandler(async (req, res) => {
    const nowMs = Date.now();
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const rl = checkRateLimit("media_people", auth.user.id, 60, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }
    // The People lens is explicitly social — it needs the follow graph.
    const viewer = await resolveViewer(sc, auth.user.id, { needFollows: true });
    const projection = await buildPeopleProjection(sc, viewer, nowMs);
    sendProjection(res, "people", projection);
  }),
);

// ── GET /media/me ────────────────────────────────────────────────────────────
router.get(
  "/media/me",
  asyncHandler(async (req, res) => {
    const nowMs = Date.now();
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const rl = checkRateLimit("media_me", auth.user.id, 120, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }
    const viewer = await resolveViewer(sc, auth.user.id, { needFollows: false });
    const projection = await buildMyWorldProjection(sc, viewer, nowMs);
    sendProjection(res, "me", projection);
  }),
);

// ── GET /media/timeline ──────────────────────────────────────────────────────
router.get(
  "/media/timeline",
  asyncHandler(async (req, res) => {
    const nowMs = Date.now();
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const placeIdRaw = typeof req.query.placeId === "string" ? req.query.placeId : null;
    const placeId = placeIdRaw && UUID_RE.test(placeIdRaw) ? placeIdRaw : null;
    const rl = checkRateLimit("media_timeline", auth.user.id, 60, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }
    const viewer = await resolveViewer(sc, auth.user.id, { needFollows: !placeId });
    const projection = await buildTimelineProjection(sc, viewer, { placeId, nowMs });
    sendProjection(res, "timeline", projection);
  }),
);

// ── GET /media/map ───────────────────────────────────────────────────────────
router.get(
  "/media/map",
  asyncHandler(async (req, res) => {
    const nowMs = Date.now();
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const rl = checkRateLimit("media_map", auth.user.id, 60, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }
    const viewer = await resolveViewer(sc, auth.user.id, { needFollows: false });
    const projection = await buildMediaMapProjection(sc, viewer, parseCity(req.query.city), nowMs);
    sendProjection(res, "map", projection);
  }),
);

export default router;
