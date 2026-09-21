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
 *   GET /api/media/search                     §38   media / places / people / gems / experiences
 *   GET /api/media/gems                       §16   Hidden Gems lens — derived gem state, not a feed
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
import { filterMediaProjectionVisibility } from "../lib/mediaVisibility.js";
import { searchMedia, type MediaSearchScope } from "../services/media/MediaSearchService.js";

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
 *
 * TWO BOUNDARIES, IN THIS ORDER. `ctx` adds the directional circle-override
 * filter (lib/mediaVisibility) BEFORE the scrub. The projectors resolve
 * eligibility, blocks, mutes and private accounts; what they have never known
 * is that one crew member asked not to be seen by another INSIDE a specific
 * trip. That is not a property of the post — a PUBLIC post attached to that
 * trip carries it too — so it cannot be answered by the candidate filter and is
 * answered here, on the assembled response, where every lens passes through one
 * function.
 *
 * A `null` from the filter means the ownership read could not be completed. It
 * becomes an ERROR, never a partially-filtered body: a projection this router
 * could not decide about is not one it may serve.
 *
 * `ctx` is optional ONLY so the scrub half stays drivable from a unit test with
 * no database. Every route in this file passes it.
 */
export async function sendProjection(
  res: any,
  route: string,
  payload: unknown,
  ctx?: { sc: any; viewerId: string },
): Promise<void> {
  if (ctx) {
    const filtered = await filterMediaProjectionVisibility(ctx.sc, ctx.viewerId, payload);
    if (filtered === null) {
      logger.error({ route }, "mediaWorld: media visibility could not be resolved — refusing to serve");
      sendError(res, "db_error", "Media visibility could not be resolved.");
      return;
    }
    payload = filtered;
  }
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
    await sendProjection(res, "world", projection, { sc, viewerId: auth.user.id });
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
    await sendProjection(res, "place", projection, { sc, viewerId: auth.user.id });
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
      await sendProjection(res, "experience", {
        id: experienceId,
        kind: null,
        title: null,
        available: false,
        placeIds: [],
        perspectiveCount: 0,
        contributorCount: 0,
        freshness: "none",
        currentState: { live: false, claims: [], crowdLabel: null }, confidence: buildExperienceConfidence([], [], nowMs),
        heroMedia: [],
        generatedAt: new Date(nowMs).toISOString(),
      }, { sc, viewerId: auth.user.id });
      return;
    }
    await sendProjection(res, "experience", { ...projection, available: true, generatedAt: new Date(nowMs).toISOString() }, { sc, viewerId: auth.user.id });
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
    await sendProjection(res, "people", projection, { sc, viewerId: auth.user.id });
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
    await sendProjection(res, "me", projection, { sc, viewerId: auth.user.id });
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
    await sendProjection(res, "timeline", projection, { sc, viewerId: auth.user.id });
  }),
);

// ── GET /media/search ────────────────────────────────────────────────────────
// §38. A READ over the SAME candidate loader + coarse projector every lens above
// uses — see MediaSearchService's header for why it is not a second read path.
// A criteria-free query returns an empty result, never the feed.
router.get(
  "/media/search",
  asyncHandler(async (req, res) => {
    const nowMs = Date.now();
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    // Tighter than the browse lenses on purpose: a search box is the cheapest
    // enumeration primitive on any surface that has one.
    const rl = checkRateLimit("media_search", auth.user.id, 30, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }
    const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
    const scopeRaw = str(req.query.scope);
    const scope: MediaSearchScope =
      scopeRaw === "me" || scopeRaw === "trip" ? scopeRaw : "all";
    const viewer = await resolveViewer(sc, auth.user.id, { needFollows: scope === "me" });
    const results = await searchMedia(
      sc,
      viewer,
      {
        q: str(req.query.q),
        city: parseCity(req.query.city),
        category: str(req.query.category),
        placeId: str(req.query.placeId),
        tripId: str(req.query.tripId),
        mediaId: str(req.query.mediaId),
        scope,
        freshOnly: req.query.freshOnly === "true" || req.query.freshOnly === "1",
        limit: Number.parseInt(str(req.query.limit) ?? "", 10) || undefined,
      },
      nowMs,
    );
    await sendProjection(res, "search", results, { sc, viewerId: auth.user.id });
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
    await sendProjection(res, "map", projection, { sc, viewerId: auth.user.id });
  }),
);

// ── GET /media/gems ──────────────────────────────────────────────────────────
// §16 Hidden Gems lens. Registered LAST and written below every other route in
// this file ON PURPOSE: eight `file:line` citations across census-media.md and
// docs/architecture/mobile-reachability-ledger.json point into the seven routes
// above (MD367's is ANCHORED at `"/media/search"`), so an addition anywhere
// higher would silently rot them. The import sits here with the route, rather
// than in the block at the top, for the same reason — ESM hoists it either way.
// See census-media §12.9 on anchored-citation decay.
//
// This is NOT `GET /media/gems-feed`. That endpoint (routes/mediaFeed.ts) is a
// ranked social feed whose order weights saves and visits; §16.2 forbids
// popularity-first ranking outright. This one serves derived §16 gem STATE.
import { buildGemStateProjection } from "../services/media/MediaGemStateService.js";
// §23 confidence on the "not available to you" experience shape, so the field is
// a measured ZERO rather than absent (census-media MD169). Imported here for the
// same anchored-citation reason as the line above.
import { buildExperienceConfidence } from "../services/media/MediaExperienceResolver.js";

router.get(
  "/media/gems",
  asyncHandler(async (req, res) => {
    const nowMs = Date.now();
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }
    const rl = checkRateLimit("media_gems", auth.user.id, 60, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }
    // The lens resolves the viewer only for identity: gem disclosure turns on
    // `mayDiscloseGemIdentity`, not on the follow graph, so `needFollows` is
    // false and no follow read is spent.
    const viewer = await resolveViewer(sc, auth.user.id, { needFollows: false });
    const projection = await buildGemStateProjection(
      sc,
      viewer,
      { city: parseCity(req.query.city) },
      nowMs,
    );
    await sendProjection(res, "gems", projection, { sc, viewerId: auth.user.id });
  }),
);

export default router;
