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
 * LOGGED AS SERVE POINT 13 (census-discovery §94, lane W11-X2; §91.7 item 1):
 * one `rank_events` impression per item and one per-request `recommendations`
 * row, as every serve point writes (lib/discoveryServeLog.ts, behind
 * discovery_serve_log_enabled); each served item carries its impression's
 * `recommendationId`. 3491 widens 3376's CHECK to 13. Trails and Shared Moments
 * are logged as `trail/<id>` / `moment/<id>` with a NULL kind (none of 0153's
 * six describes them); an emerging discovery is logged as the place it is.
 *
 * Behind `discovery_output_kinds_enabled` (3483, seeded FALSE), read per
 * request as a literal (check:flag-polarity reads call sites; §104: an unreadable
 * flag is a 503 flag_unreadable, never OFF). Signed-in only: every order here is the viewer's own.
 *
 * `11` §9: 401 unauthenticated · 404 feature_disabled (flag off, or an unknown
 * kind) · 400 invalid_payload (emerging discoveries without a destination) ·
 * 503 degraded_unavailable with the ranker's `reason`. A failed read never
 * answers 200 with an empty list.
 */
import { Router, type Request, type Response } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getServiceClient } from "../lib/supabase.js"; import { exposureForResponse, serveClockOf, servedRecommendationId } from "../lib/discoveryRecommendationRecord.js"; import { logServeUnlessRefused } from "../lib/discoveryRefusal.js"; import { DiscoveryServePoint, type ServedItem } from "../lib/discoveryServeLog.js";  // §94: the serve log
import { discoveryStopHalt } from "../lib/discoveryStopGate.js";  // census-discovery §104 (DV-83, D-W11X2-56): the flag is read strictly at the foot — this line used to bring in the isFlagEnabled helper from lib/featureFlags
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
  const kindsFlag = await outputKindsFlagRead(sc); if (kindsFlag === null) return sendError(res, "degraded_unavailable", "these recommendations could not be checked just now", { reason: "flag_unreadable" }); if (!kindsFlag) {  // census-discovery §104 (DV-83, D-W11X2-56): an UNREAD flag is a failed read, never the off 404 — was: if (!(await isFlagEnabled(sc, "discovery_output_kinds_enabled"))) {
    return sendError(res, "feature_disabled", "these recommendations are not enabled");
  } const stopHalt = await discoveryStopHalt(sc); if (stopHalt === "stop_unreadable") return sendError(res, "degraded_unavailable", "these recommendations could not be checked just now", { reason: "stop_unreadable" }); if (stopHalt !== null) return sendError(res, "feature_disabled", "these recommendations are not enabled");  // census-discovery §97: flag ON but the Discovery stop engaged ⇒ exactly the flag-off 404; §107 (DV-83, D-W11X2-69): an UNREAD stop still serves nothing but says so (503), never the off 404 the rail hides — was: } if (!(await unlessDiscoveryStopped(sc, true))) return sendError(res, "feature_disabled", "these recommendations are not enabled");

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

  // §94: ONE exposure for the response and the serve log, so the id each item
  // carries is the id its impression row carries (DV-40).
  const exposure = exposureForResponse(res, auth.user.id);
  const logged = outputKindServedItems(kind, ranked.items);
  const items = ranked.items.map((it, i) => ({ ...(it as object), recommendationId: servedRecommendationId(exposure, i, logged[i]!.id) }));
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ kind: ranked.kind, rankedBy: ranked.rankedBy, items, cursor: null });
  logServeUnlessRefused(res, sc, {
    userId: auth.user.id,
    servePoint: DiscoveryServePoint.OUTPUT_KINDS,
    route: "GET /v1/discovery/recommendations/:kind",
    ...serveClockOf(exposure),
    items: logged,
    context: { destination: city ?? "", type: kind },
  });
}));

/**
 * What the serve log records for each served item of a kind (census-discovery
 * §94). Trails and Shared Moments are namespaced (`trail/…`, `moment/…`, the
 * ids the rankers already rank them under) with a NULL kind: none of
 * `rank_events.item_kind`'s six values describes them, and an invented kind
 * would corrupt every per-kind rollup. An emerging discovery IS a place, so it
 * is logged by its place id and the serve log infers `gem` / `place` as it
 * does for every other place.
 */
export function outputKindServedItems(kind: ServedOutputKind, items: readonly unknown[]): ServedItem[] {
  return items.map((it) => {
    const row = it as { id?: unknown; place?: { id?: unknown } };
    if (kind === "trails") return { id: `trail/${String(row.id)}`, kind: null };
    if (kind === "shared_moments") return { id: `moment/${String(row.id)}`, kind: null };
    return { id: String(row.place?.id) };
  });
}

export default router;

// ── census-discovery §104 (DV-83, D-W11X2-56): the rollout flag, read strictly ──
// `isFlagEnabled` answers false for a failed read as for an off flag, so a timed-out
// feature_flags read was "these recommendations are not enabled" (404), which the
// output-kinds rail hides exactly like the feature being off. `null` here is the failed
// read: the route answers 503 degraded_unavailable / flag_unreadable, the rail's failed
// state. An ABSENT row is still off. check:flag-polarity records this read in DIRECT_READS.
async function outputKindsFlagRead(sc: any): Promise<boolean | null> {
  try {
    const { data, error } = await sc.from("feature_flags").select("enabled").eq("flag", "discovery_output_kinds_enabled").maybeSingle();
    if (error) return null;
    return Boolean((data as any)?.enabled);
  } catch {
    return null;
  }
}
