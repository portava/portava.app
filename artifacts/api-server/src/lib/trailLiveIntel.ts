/**
 * Intelligence Gathering — Trail LIVE-INTEL read (IG / §19 GET /v1/trails/:id/live-intel).
 *
 * "What is live right now along this trail's stops?" A trail is a route_plan; its
 * stops are the route_stops that point at a place. For each such place this
 * returns the same LIVE claim envelopes the place card serves
 * (lib/liveClaimRead.readLiveClaimEnvelopes), so every live gate is inherited in
 * ONE place: the flag chain + kill switch + pilot master switch (liveLabelsServable),
 * per-scope promotion, the k-anonymity / privacy-eligibility snapshot gate, the
 * truth-boundary source-class rule, and TTL freshness. Nothing here re-derives a
 * label or serves protected location proof.
 *
 * WHAT THIS IS NOT. It is NOT crowd-movement output. §29 EXCLUDES "Public Crowd
 * Movement output"; the going-next aggregate (lib/trailServe.readTrailMovement)
 * stays admin-only and is never reached from here. This read serves only the
 * per-subject LIVE claims a place already publishes.
 *
 * FAIL-CLOSED, in order — every refusal returns EMPTY, never partial:
 *   1. no client                         → "no_service_client"
 *   2. no viewer id                      → "unknown_trail" (no relation to evaluate)
 *   3. trail missing OR viewer not owner
 *      and not an accepted trip member   → "unknown_trail" (existence is not leaked)
 *   4. stop read fails                   → "read_failed"
 * Live gating itself is not a refusal: when Live is off/empty every stop simply
 * carries an empty claims array (exactly what the place card would show).
 */
import { readLiveClaimEnvelopes, type LiveClaimEnvelope } from "./liveClaimRead.js";
import { logger } from "./logger.js";

export type TrailLiveIntelRefusal = "no_service_client" | "unknown_trail" | "read_failed";

export interface TrailStopLiveIntel {
  stopId: string;
  subjectId: string;
  title: string | null;
  orderIndex: number;
  claims: LiveClaimEnvelope[];
}

export interface TrailLiveIntelRead {
  refusal: TrailLiveIntelRefusal | null;
  trailId: string;
  stops: TrailStopLiveIntel[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReadTrailLiveIntelOptions {
  now?: Date;
}

/**
 * Resolve the trail, authorize the viewer, and gather live claims for every
 * place stop. Uses the service client but authorizes explicitly (owner, or an
 * ACCEPTED trip member of the trail's trip) because the service client bypasses
 * RLS. An unauthorized or missing trail is indistinguishable ("unknown_trail")
 * so existence is never leaked.
 */
export async function readTrailLiveIntel(
  sc: any,
  viewerId: string,
  trailId: string,
  opts: ReadTrailLiveIntelOptions = {},
): Promise<TrailLiveIntelRead> {
  const empty = (refusal: TrailLiveIntelRefusal): TrailLiveIntelRead => ({ refusal, trailId, stops: [] });

  if (!sc) return empty("no_service_client");
  if (typeof viewerId !== "string" || viewerId === "") return empty("unknown_trail");
  if (typeof trailId !== "string" || !UUID_RE.test(trailId)) return empty("unknown_trail");

  try {
    // 1. Resolve the trail (route_plan). Missing ⇒ unknown_trail.
    const { data: plan, error: planErr } = await sc
      .from("route_plans")
      .select("id, owner_user_id, trip_id")
      .eq("id", trailId)
      .maybeSingle();
    if (planErr) {
      logger.warn({ err: planErr }, "trailLiveIntel: route_plan read failed");
      return empty("read_failed");
    }
    if (!plan) return empty("unknown_trail");

    // 2. Authorize: owner, or an ACCEPTED member of the trail's trip. Fail-closed.
    let authorized = plan.owner_user_id === viewerId;
    if (!authorized && plan.trip_id) {
      const { data: member, error: memberErr } = await sc
        .from("trip_members")
        .select("user_id")
        .eq("trip_id", plan.trip_id)
        .eq("user_id", viewerId)
        .eq("status", "accepted")
        .maybeSingle();
      if (memberErr) {
        logger.warn({ err: memberErr }, "trailLiveIntel: membership read failed");
        return empty("read_failed");
      }
      authorized = !!member;
    }
    if (!authorized) return empty("unknown_trail");

    // 3. The trail's PLACE stops (source_type='place' with a uuid source_id).
    const { data: stops, error: stopErr } = await sc
      .from("route_stops")
      .select("id, source_id, source_type, title, order_index")
      .eq("route_plan_id", trailId)
      .eq("source_type", "place")
      .order("order_index", { ascending: true });
    if (stopErr) {
      logger.warn({ err: stopErr }, "trailLiveIntel: route_stops read failed");
      return empty("read_failed");
    }

    const placeStops = ((stops as any[]) ?? []).filter(
      (s) => typeof s.source_id === "string" && UUID_RE.test(s.source_id),
    );

    // 4. Per-subject LIVE claims — readLiveClaimEnvelopes inherits every live gate
    //    and returns [] whenever Live is off/empty/expired/not-promoted.
    const out: TrailStopLiveIntel[] = [];
    for (const s of placeStops) {
      const claims = await readLiveClaimEnvelopes(sc, s.source_id as string, { now: opts.now });
      out.push({
        stopId: String(s.id),
        subjectId: String(s.source_id),
        title: typeof s.title === "string" ? s.title : null,
        orderIndex: typeof s.order_index === "number" ? s.order_index : 0,
        claims,
      });
    }
    return { refusal: null, trailId, stops: out };
  } catch (err) {
    logger.warn({ err }, "trailLiveIntel: read threw");
    return empty("read_failed");
  }
}
