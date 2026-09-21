/**
 * Intelligence Gathering — Trail read models (spec §19 Read models).
 *
 * GET /v1/trails/:id/live-intel
 *   The LIVE intelligence along a trail's stops: for each place the trail visits,
 *   the same live-claim envelopes the place card serves (lib/liveClaimRead), so
 *   every live gate (flag chain, kill switch, pilot master switch, per-scope
 *   promotion, k-anonymity, TTL freshness, truth boundary) is inherited, not
 *   re-implemented. Authorised to the trail's owner or an accepted trip member;
 *   an unknown or unauthorised trail is a fail-closed 404 (existence not leaked).
 *
 *   This is NOT crowd-movement output. §29 EXCLUDES "Public Crowd Movement
 *   output"; the going-next aggregate (lib/trailServe.readTrailMovement) stays
 *   admin-only and is never reached from here.
 *
 * Per §19 API contract rules the response carries schema_version, generated_at
 * and valid_until per claim, never protected location proof, and an ETag so a
 * client can revalidate cheaply (If-None-Match ⇒ 304).
 *
 * ── TWO DIFFERENT TRAILS LIVE IN THIS FILE, AND THEY MUST STAY DIFFERENT ────
 *
 * Everything above is the INTELLIGENCE-GATHERING trail: a `route_plans` row,
 * one trip's ordered `route_stops`, mounted at /v1/trails/:id/live-intel.
 *
 * Everything below `── 02_Trails.md ──` is the DISCOVERY Trail: the permanent,
 * themed discovery space of `docs/specs/discovery-v1/02_Trails.md` §1
 * ("Bangkok After Dark", "Kyoto Hidden Temples"), stored in `trails` /
 * `content_trails` / `trail_edges` (migration 2910). It is mounted under
 * /v1/discovery/trails so the two never share a path, and it reads none of the
 * tables above. They share four letters and nothing else; a previous pass
 * mistook one for the other, which is why this paragraph exists.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { createHash } from "node:crypto";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getServiceClient } from "../lib/supabase.js";
import { readTrailLiveIntel } from "../lib/trailLiveIntel.js";
import {
  windowSpanMs, type DerivedStoreProvenance,
} from "../lib/discoveryRankProvenance.js";
import {
  listTrails, getTrail, getTrailModules, relatedTrails, trailTrending,
  proposeTrail, attachContentToTrail, detachContentFromTrail,
  setTrailFollow, reportTrail, recordTrailHealthSnapshot,
  type TrailRefusal, type TrailRow,
} from "../services/trails/TrailService.js";

const router = Router();

const TRAIL_LIVE_INTEL_SCHEMA_VERSION = 1;

/** A weak-free, content-addressed ETag for the serialized body. */
export function computeETag(payload: unknown): string {
  return `"${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32)}"`;
}

router.get("/v1/trails/:id/live-intel", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "trail id must be a uuid");

  const read = await readTrailLiveIntel(getServiceClient()!, auth.user.id, id.data);
  // Fail-closed: an unknown OR unauthorised trail is an indistinguishable 404 so
  // trail existence is never leaked. Any other refusal is a server-side read error.
  if (read.refusal === "unknown_trail") return sendError(res, "not_found", "trail not found");
  if (read.refusal !== null) return sendError(res, "db_error", read.refusal);

  const body = {
    trailId: read.trailId,
    schemaVersion: TRAIL_LIVE_INTEL_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    stops: read.stops.map((s) => ({
      stopId: s.stopId,
      subjectId: s.subjectId,
      title: s.title,
      orderIndex: s.orderIndex,
      liveClaims: s.claims,
    })),
  };

  // ETag over the STABLE part of the body (never generatedAt, which changes each
  // call) so a client that already holds the current live picture gets a 304.
  const etag = computeETag({ trailId: body.trailId, schemaVersion: body.schemaVersion, stops: body.stops });
  if (req.header("If-None-Match") === etag) {
    res.status(304).end();
    return;
  }
  res.setHeader("ETag", etag);
  res.json(body);
}));

// ── 02_Trails.md — the DISCOVERY Trail API (`11` §3, census DC-20) ──────────
//
// Nine conceptual actions, `11` §3's own list, under /v1/discovery/trails:
//
//   list/search Trails          GET    /v1/discovery/trails
//   get Trail                   GET    /v1/discovery/trails/:id
//   get Trail modules           GET    /v1/discovery/trails/:id/modules
//   follow / unfollow Trail     PUT|DELETE /v1/discovery/trails/:id/follow
//   suggest Trail association   POST   /v1/discovery/trails/:id/suggestions
//   attach / detach content     POST   /v1/discovery/trails/:id/content
//                               DELETE /v1/discovery/trails/:id/content/:contentId
//   propose Trail               POST   /v1/discovery/trails
//   report Trail/content        POST   /v1/discovery/trails/:id/reports
//   get related Trails          GET    /v1/discovery/trails/:id/related
//
// plus `11` §4's "trending by Trail" at GET /v1/discovery/trails/:id/trending —
// ONE of §4's five actions, and reported as one rather than as the set.
//
// NOTHING HERE SERVES A SCORE. `11` §4: "Never return internal raw scores
// unless needed for admin diagnostics"; `02` §12: "Avoid exposing opaque
// quality scores". So the §11 health metrics, the health multiplier and the
// per-item momentum decide ORDER and STATUS on the server and are never
// serialised — the client receives §12's five status words and an order. This
// is the same rule census-discovery DV-27 records as `C` for GET /discovery,
// held on the new surface rather than re-litigated.
//
// UNTIL 2910 IS APPLIED every one of these answers 503 degraded_unavailable
// (`trails_unavailable`). That is deliberate and is not an error path: the
// object does not exist yet in that deployment, and saying "no Trails" would be
// a false claim rather than a missing one.

/** One refusal vocabulary → one HTTP mapping, so no handler invents its own. */
function sendTrailRefusal(res: Response, refusal: Exclude<TrailRefusal, null>): void {
  switch (refusal) {
    case "unknown_trail":
      return sendError(res, "not_found", "trail not found");
    case "invalid_request":
      return sendError(res, "invalid_payload", "request refused by 02_Trails rules");
    case "trails_unavailable":
    case "no_service_client":
      // 503, not 500: nothing failed. The Trail object is not deployed here.
      return sendError(res, "degraded_unavailable", "trails are not available in this deployment");
    default:
      return sendError(res, "db_error", "trail read failed");
  }
}

/** The public projection of a Trail. No score, no metric, no internal state. */
function toPublicTrail(t: TrailRow) {
  return {
    id: t.id,
    slug: t.slug,
    title: t.title,
    description: t.description,
    destination: t.destination,
    parentTrailId: t.parent_trail_id,
    lifecycle: t.lifecycle_status,
    createdAt: t.created_at,
  };
}

const uuid = z.string().uuid();

router.get("/v1/discovery/trails", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const limit = z.coerce.number().int().min(1).max(50).safeParse(req.query.limit);
  const r = await listTrails(getServiceClient(), {
    destination: typeof req.query.destination === "string" ? req.query.destination : null,
    query: typeof req.query.q === "string" ? req.query.q : null,
    limit: limit.success ? limit.data : 20,
  });
  if (r.refusal) return sendTrailRefusal(res, r.refusal);
  res.json({ trails: r.trails.map(toPublicTrail) });
}));

router.post("/v1/discovery/trails", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const body = z.object({
    title: z.string().min(2).max(120),
    destination: z.string().max(120).nullish(),
    description: z.string().max(2000).nullish(),
    // §6: declare this a sub-Trail. See TrailService.proposeTrail for which
    // canonicalization refusals a declared parent waives, and which it does not.
    parentTrailId: z.string().uuid().nullish(),
  }).safeParse(req.body);
  if (!body.success) return sendError(res, "invalid_payload", "title is required");

  const r = await proposeTrail(getServiceClient(), {
    title: body.data.title,
    destination: body.data.destination ?? null,
    description: body.data.description ?? null,
    parentTrailId: body.data.parentTrailId ?? null,
  }, auth.user.id);
  if (r.refusal) return sendTrailRefusal(res, r.refusal);

  // §5's four checks refusing is a 409, not a 400: the proposal is well formed
  // and the CATALOGUE is the reason it cannot be admitted. The refusals are
  // returned in full, with the suggested parent, because §6 makes "this belongs
  // under Bangkok After Dark" an instruction the client can act on.
  if (!r.trail) {
    res.status(409).json({
      error: "canonicalization_refused",
      refusals: r.canonicalisation.map((x) => ({ check: x.check, conflictsWith: x.conflictsWith })),
      suggestedParentTrailId: r.suggestedParentTrailId,
    });
    return;
  }
  res.status(201).json({ trail: toPublicTrail(r.trail) });
}));

router.get("/v1/discovery/trails/:id", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "trail id must be a uuid");

  const r = await getTrail(getServiceClient(), id.data);
  if (r.refusal) return sendTrailRefusal(res, r.refusal);
  if (!r.trail) return sendError(res, "not_found", "trail not found");
  res.json({
    trail: toPublicTrail(r.trail),
    // §12's word. `healthScale` and the nine metrics stay on the server.
    status: r.status,
    memberCount: r.memberCount,
  });
}));

/**
 * DC-17 on the wire — `10` §5's four facts about a DERIVED reading, published.
 *
 * `11` §4 forbids returning internal raw scores; none of these four is one. A
 * model version, a feature version, a computation clock and the event-window
 * bounds say WHAT WAS MEASURED, not how any item scored, and they are the only
 * way a client can tell two readings of the same Trail apart when the answer it
 * is given is a boolean.
 *
 * `spanMs` comes from `windowSpanMs`, never from `endMs - startMs`: `Number(null)`
 * is 0, so raw subtraction would publish a corpus with NO oldest event and a
 * window that admitted NOTHING as the same number. Three states survive to the
 * client — `null` record (nothing was read), `spanMs: null` (unbounded start),
 * and `spanMs: 0` (a window that admitted nothing).
 *
 * EXPORTED so that the three-state contract can be PINNED rather than asserted.
 * The only producer that reaches this route today (`lib/discoveryLocalMomentum`)
 * always stamps a `bounded` window, so the `unbounded_start` branch is not
 * reachable through the HTTP surface — and a defensive branch no test can enter
 * is a branch the next refactor deletes. Reaching it directly is the only way to
 * keep `windowSpanMs` here from being collapsed into raw subtraction.
 */
export function toPublicProvenance(p: DerivedStoreProvenance | null) {
  if (!p) return null;
  return {
    modelVersion: p.modelVersion,
    featureVersion: p.featureVersion,
    computedAt: p.computedAt,
    window: { kind: p.window.kind, startMs: p.window.startMs, endMs: p.window.endMs },
    spanMs: windowSpanMs(p.window),
  };
}

router.get("/v1/discovery/trails/:id/modules", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "trail id must be a uuid");

  const sc = getServiceClient();
  const r = await getTrailModules(sc, id.data);
  if (r.refusal) return sendTrailRefusal(res, r.refusal);

  res.json({
    modules: r.modules.map((m) => ({
      key: m.key,
      // §8: "Each spotlight has its own objective and time horizon." Published
      // because it is the difference between a module and a feed, and it names
      // no score — DV-21's criterion is "modular", not "scored".
      objective: m.objective,
      horizonMs: m.horizonMs,
      items: m.items,
      moreFromThisPlace: m.moreFromThisPlace,
      // §9 / DV-22. Ids, never counts: §9 forbids promising a number of
      // impressions publicly, and this names WHICH items hold the page's
      // bounded exploration slots without saying how much exposure any of them
      // gets. `null` means the denominators could not be read — a client that
      // saw `[]` for that case would be told "nothing qualified", which is a
      // claim the server cannot make when it could not measure.
      explorationSlots: m.explorationSlots,
    })),
    // DC-17. `trending_now` is ordered by a store that computes over an event
    // window; this is that store's own record, carried through rather than
    // re-derived. `null` means no reading entered the page at all, so the
    // ordering rests on no window — which a client must be able to see.
    //
    // NAMED `readingProvenance`, NOT `momentumProvenance`, ON PURPOSE. The
    // route suite asserts that the serialised body contains no occurrence of
    // the string "momentum" at all — `11` §4's "never return internal raw
    // scores", pinned as a blunt tripwire rather than as a field list. That
    // guard is over-broad and was left over-broad: it costs one word here and
    // it catches a leak no narrower assertion would. Do not rename this field
    // to match the service's, and do not loosen the assertion to allow it.
    readingProvenance: toPublicProvenance(r.momentumProvenance),
  });

  // §11's snapshot, after the response and never blocking it — the shape
  // lib/discoveryServeLog.ts already uses for the serve log. At most one row
  // per Trail per hour; a failure is logged inside the service and swallowed.
  if (r.health) void recordTrailHealthSnapshot(sc, id.data, r.health);
}));

router.get("/v1/discovery/trails/:id/related", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "trail id must be a uuid");

  const r = await relatedTrails(getServiceClient(), id.data);
  if (r.refusal) return sendTrailRefusal(res, r.refusal);
  // DV-24 "navigable": both directions are returned and labelled, so a client
  // can walk from a parent to a sub-Trail AND back without a second vocabulary.
  res.json({
    related: r.edges.map((e) => ({
      trail: toPublicTrail(e.trail), edgeType: e.edgeType, direction: e.direction,
    })),
  });
}));

router.get("/v1/discovery/trails/:id/trending", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "trail id must be a uuid");

  const r = await trailTrending(getServiceClient(), id.data);
  if (r.refusal) return sendTrailRefusal(res, r.refusal);
  // `11` §4's prohibition, honoured: `trending` is a BOOLEAN derived from the
  // Trail's momentum and the momentum number itself is not serialised.
  // DC-17 — `trending` is a BOOLEAN, so without the window it is a claim about
  // an unspecified corpus. The provenance says which corpus, and `null` says
  // that no reading was taken, which is not the same as "not trending".
  // `readingProvenance` rather than `momentumProvenance`: see the note on the
  // modules route above — the `11` §4 tripwire forbids the WORD here.
  res.json({
    trending: (r.momentum ?? 0) > 0,
    items: r.items,
    readingProvenance: toPublicProvenance(r.momentumProvenance),
  });
}));

router.put("/v1/discovery/trails/:id/follow", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "trail id must be a uuid");
  const r = await setTrailFollow(getServiceClient(), id.data, auth.user.id, true);
  if (r.refusal) return sendTrailRefusal(res, r.refusal);
  res.json({ following: true });
}));

router.delete("/v1/discovery/trails/:id/follow", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "trail id must be a uuid");
  const r = await setTrailFollow(getServiceClient(), id.data, auth.user.id, false);
  if (r.refusal) return sendTrailRefusal(res, r.refusal);
  res.json({ following: false });
}));

const attachmentBody = z.object({
  labels: z.array(z.object({
    sourceType: z.enum(["post", "place", "event", "itinerary", "route"]),
    sourceId: z.string().uuid(),
    relationship: z.enum(["primary", "supporting", "signal"]),
    signal: z.string().max(40).nullish(),
  })).min(1).max(8),
});

/**
 * `02` §4's cap arriving as a 409 with the refused labels named.
 *
 * Shared by attach and suggest so the two cannot drift: a creator who hits the
 * cap must be told WHICH budget is full, because "supporting_cap" and
 * "signal_cap" have different remedies and a single "rejected" would hide that.
 */
function sendAttachResult(
  res: Response,
  r: { attached: number; capRefusals: Array<{ label: { relationship: string; signal: string | null }; reason: string }> },
): void {
  if (r.attached === 0) {
    res.status(409).json({
      error: "label_cap_refused",
      refusals: r.capRefusals.map((x) => ({ relationship: x.label.relationship, signal: x.label.signal, reason: x.reason })),
    });
    return;
  }
  res.status(201).json({
    attached: r.attached,
    refusals: r.capRefusals.map((x) => ({ relationship: x.label.relationship, signal: x.label.signal, reason: x.reason })),
  });
}

router.post("/v1/discovery/trails/:id/content", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "trail id must be a uuid");
  const body = attachmentBody.safeParse(req.body);
  if (!body.success) return sendError(res, "invalid_payload", "labels[] is required");

  const r = await attachContentToTrail(getServiceClient(), id.data, body.data.labels, {
    userId: auth.user.id, mode: "attach",
  });
  if (r.refusal) return sendTrailRefusal(res, r.refusal);
  sendAttachResult(res, r);
}));

router.post("/v1/discovery/trails/:id/suggestions", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "trail id must be a uuid");
  const body = attachmentBody.safeParse(req.body);
  if (!body.success) return sendError(res, "invalid_payload", "labels[] is required");

  // The SAME write as attach, at a lower confidence. §5's "user proposal"
  // origin: a third party's suggestion is evidence, not a statement, and the
  // confidence difference is what §11's quality-to-noise metric reads.
  const r = await attachContentToTrail(getServiceClient(), id.data, body.data.labels, {
    userId: auth.user.id, mode: "suggest",
  });
  if (r.refusal) return sendTrailRefusal(res, r.refusal);
  sendAttachResult(res, r);
}));

router.delete("/v1/discovery/trails/:id/content/:contentId", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = uuid.safeParse(req.params.id);
  const contentId = uuid.safeParse(req.params.contentId);
  if (!id.success || !contentId.success) return sendError(res, "invalid_payload", "ids must be uuids");

  const r = await detachContentFromTrail(getServiceClient(), id.data, contentId.data, auth.user.id);
  if (r.refusal) return sendTrailRefusal(res, r.refusal);
  res.json({ detached: r.detached });
}));

router.post("/v1/discovery/trails/:id/reports", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = uuid.safeParse(req.params.id);
  if (!id.success) return sendError(res, "invalid_payload", "trail id must be a uuid");
  const body = z.object({
    reason: z.enum(["unrelated_content", "duplicate_trail", "wrong_place_link", "stale", "abuse"]),
    contentTrailId: z.string().uuid().nullish(),
  }).safeParse(req.body);
  if (!body.success) return sendError(res, "invalid_payload", "reason must be one of 02 §15's five");

  const r = await reportTrail(getServiceClient(), id.data, {
    reason: body.data.reason, contentTrailId: body.data.contentTrailId ?? null,
  }, auth.user.id);
  if (r.refusal) return sendTrailRefusal(res, r.refusal);
  // No moderation outcome is disclosed: §15 makes resolution an admin action,
  // and telling a reporter what happened to a report is a channel for probing
  // other people's content state.
  res.status(202).json({ reported: r.reported });
}));

export default router;
