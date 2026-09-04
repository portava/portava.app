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
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { createHash } from "node:crypto";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getServiceClient } from "../lib/supabase.js";
import { readTrailLiveIntel } from "../lib/trailLiveIntel.js";

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

export default router;
