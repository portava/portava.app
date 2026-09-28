/**
 * `01` §4's three output kinds PDE ranks and no route served — census-discovery
 * §91 (lane W10-I), DC-01, serving what §85 (lane W10-R3) built in
 * lib/discoveryCandidates/outputKinds.ts.
 *
 *   GET /v1/discovery/recommendations/trails[?destination=]
 *   GET /v1/discovery/recommendations/shared_moments
 *   GET /v1/discovery/recommendations/emerging_discoveries?destination=
 *
 * THE SHAPE (register D-W10-I-4). `11` §5's Recommendation API takes "surface,
 * session context, pagination/cursor" and answers "items, reason labels where
 * user-facing, cursor". The kind is the surface; the destination is the
 * session context; one page of at most 50 (the rankers' own cap) with
 * `cursor: null`. `11` §3 "list/search Trails" (GET /trails) and `11` §4's
 * trend explanation keep their own routes and orders: this route is where a
 * kind is RECOMMENDED, not a second list. No reason labels are served: the
 * three rankers run `rankForViewer` with every modifier off, and no grounded
 * reason code describes a Trail or a Shared Moment yet.
 *
 * NOT LOGGED, AND SAID SO. The other serve points write `rank_events`
 * impressions and a per-request `recommendations` row. Neither store can hold
 * these kinds today: 3376's `recommendations_serve_point_check` admits serve
 * points 1–12 only, and 0153's `rank_events.item_kind` has no Trail or Shared
 * Moment kind. Widening them is a migration, owed and routed (census §91), so
 * no `recommendation_id` is minted: an id that joins to no row is worse than
 * none.
 *
 * Behind `discovery_output_kinds_enabled` (3483, seeded FALSE), read per
 * request as a literal (check:flag-polarity reads call sites; an unreadable
 * flag reads OFF). Signed-in only: every order here is the viewer's own.
 *
 * `11` §9: 401 unauthenticated · 404 feature_disabled (flag off, or an unknown
 * kind) · 400 invalid_payload (emerging discoveries without a destination) ·
 * 503 degraded_unavailable with the ranker's `reason`. A failed read never
 * answers 200 with an empty list.
 */
import { Router, type Request, type Response } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { loadPdeViewer } from "../lib/discoveryPde.js";
import {
  rankTrailsForViewer, rankSharedMomentsForViewer, rankEmergingForViewer, type RankedKind,
} from "../lib/discoveryCandidates/outputKinds.js";

export const SERVED_OUTPUT_KINDS = ["trails", "shared_moments", "emerging_discoveries"] as const;
export type ServedOutputKind = (typeof SERVED_OUTPUT_KINDS)[number];

const isServedKind = (k: string): k is ServedOutputKind => (SERVED_OUTPUT_KINDS as readonly string[]).includes(k);

const router = Router();

router.get("/v1/discovery/recommendations/:kind", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const sc = getServiceClient();
  if (!sc) return sendError(res, "degraded_unavailable", "recommendations are not available in this deployment", { reason: "no_service_client" });

  // Literal at the read site (check:flag-polarity reads call sites).
  if (!(await isFlagEnabled(sc, "discovery_output_kinds_enabled"))) {
    return sendError(res, "feature_disabled", "these recommendations are not enabled");
  }

  const kind = String(req.params["kind"] ?? "");
  if (!isServedKind(kind)) return sendError(res, "feature_disabled", `no recommendations of kind "${kind}"`);

  const rawDest = typeof req.query["destination"] === "string" ? req.query["destination"].trim() : "";
  const city = rawDest ? (rawDest.split(",")[0]?.trim().toLowerCase() ?? "") || null : null;
  if (kind === "emerging_discoveries" && !city) {
    return sendError(res, "invalid_payload", "emerging discoveries need a destination");
  }

  const viewer = await loadPdeViewer(sc, auth.user.id, city);
  // The flag was read above; the rankers are told so rather than reading it again.
  const ranked: RankedKind<unknown> =
    kind === "trails" ? await rankTrailsForViewer(sc, viewer, { destination: city, enabled: true })
    : kind === "shared_moments" ? await rankSharedMomentsForViewer(sc, viewer, { enabled: true })
    : await rankEmergingForViewer(sc, viewer, { enabled: true });

  if (ranked.status === "unavailable" || ranked.status === "flag_off") {
    return sendError(res, "degraded_unavailable", "these recommendations could not be ranked just now", { reason: ranked.unavailable ?? ranked.status });
  }

  res.setHeader("Cache-Control", "private, no-store");
  res.json({ kind: ranked.kind, rankedBy: ranked.rankedBy, items: ranked.items, cursor: null });
}));

export default router;
