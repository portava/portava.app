/**
 * Nearby & Available — the §4 / §30A.2 read surface.
 *
 *   GET /api/nearby/reachable     the viewer's ReachablePersonProjection list
 *
 *   flag: nearby_reachable_enabled (no row exists → OFF; fail-closed)
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT THIS ROUTE DOES NOT ACCEPT, AND WHY THAT IS THE DESIGN
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * There is no `lat`, no `lng`, no `radiusKm` and no `precision` parameter.
 *
 *   • No viewport, because a viewport is the "who is near this point" query
 *     §4.6 separates the social graph from. The candidate set is the viewer's
 *     circle members and accepted trip crew, resolved server-side.
 *   • No caller-supplied position, because a client that can state where the
 *     viewer is can state where the viewer is not, and the whole ladder below
 *     would then be computed from an unverified input.
 *   • No precision parameter, because the answer is bucketed by construction —
 *     `ReachablePersonProjection.proximity.precision` is the literal type
 *     `"bucket"`. There is nothing for a parameter to widen.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE RESPONSE, THE LOG AND THE ORDER
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * RESPONSE: the projections are serialised as they are built. No enrichment step
 * adds a coordinate, and there is nothing in the body finer than a bucket name.
 *
 * LOG: the one log line this handler writes carries `reachableTelemetry` —
 * counts per bucket, counts per refusal reason, and two booleans. It never
 * carries a person id, a city, a coordinate or a raw timestamp, because a log
 * line naming the bucket one specific person fell into is a disclosure with a
 * longer retention than the response that caused it. Handler failures log the
 * message and stage, which are ours, not the traveller's position.
 *
 * ORDER: `orderReachablePeople` sorts on rank then a per-(viewer, person) hash.
 * The handler does not re-sort. A "nearest first" convenience sort added here
 * would reintroduce the disclosure the projection was built to avoid, which is
 * why the ordering lives with the ranker and not with the transport.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * POLL QUANTISATION (§4.5)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `nowMs` is floored to POLL_QUANTUM_MS before it reaches the loader, and every
 * time-derived output (freshness, overlap band, `generatedAt`) is computed from
 * that instant. Two requests inside one quantum are therefore byte-identical:
 * refreshing faster than the quantum returns strictly no new information, so the
 * refresh loop §4.5 warns about yields nothing to difference. The rate limit
 * below bounds the cost; the quantum bounds the INFORMATION, and only the second
 * one closes a side channel.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * INVISIBLE MODE (§4.4), BOTH HALVES
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * A viewer in invisible mode is not refused here. They lose proximity — their
 * own point is withheld, so every bucket is `unknown` — and they are absent from
 * everyone else's list, which is the suppression half. They keep this surface's
 * availability content and their private map (`viewerMayUsePrivateMap`), which
 * is the half a global off-switch would have broken.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { invisibleModeTelemetry } from "../lib/invisibleMode.js";
import { viewerMayUsePrivateMap } from "../services/telegraph/reachablePeople.js";
import { loadReachablePeople, MAX_CANDIDATES } from "../services/telegraph/reachablePeopleQuery.js";

const router = Router();

/**
 * The information quantum, in ms. Also the cadence a client should poll at:
 * anything faster is served the same bytes.
 */
export const POLL_QUANTUM_MS = 60_000;

/** Floor an instant to the quantum. Exported for the test that pins §4.5. */
export function quantiseNow(nowMs: number): number {
  return Math.floor(nowMs / POLL_QUANTUM_MS) * POLL_QUANTUM_MS;
}

router.get(
  "/nearby/reachable",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const db = getServiceClient();
    if (!db) {
      sendError(res, "server_not_configured");
      return;
    }

    // Capability gate. No `nearby_reachable_enabled` row exists on any
    // deployment, and isFlagEnabled answers false for an absent row and for an
    // unreadable one alike, so this surface is OFF everywhere until a migration
    // and a decision turn it on.
    if (!(await isFlagEnabled(db, "nearby_reachable_enabled"))) {
      res.json({ enabled: false, people: [], generatedAt: null });
      return;
    }

    // Bounded well above the quantum: a client that polls at the quantum uses 1
    // per minute, and the ceiling exists for cost, not for privacy — the quantum
    // is what makes extra polls informationless.
    const rl = checkRateLimit("nearby_reachable", user.id, 20, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }

    const nowMs = quantiseNow(Date.now());
    const result = await loadReachablePeople(db, { viewerId: user.id, nowMs });

    if (!result.ok) {
      // A read the answer depends on failed. Saying "nobody is reachable" here
      // would be a fabrication a client cannot tell from the truth, so this is
      // a retryable refusal instead.
      req.log.warn({ stage: result.stage, message: result.message }, "nearby/reachable refused");
      sendError(res, "degraded_unavailable", "Reachability is temporarily unavailable.");
      return;
    }

    req.log.info({ telemetry: result.telemetry }, "nearby/reachable served");

    res.json({
      enabled: true,
      generatedAt: new Date(nowMs).toISOString(),
      pollQuantumMs: POLL_QUANTUM_MS,
      candidateCap: MAX_CANDIDATES,
      people: result.people,
      // The viewer's own state, so the client can explain an empty list without
      // guessing. Coordinate-free by type.
      viewer: {
        invisible: invisibleModeTelemetry(result.viewerInvisible),
        privateMapAvailable: viewerMayUsePrivateMap(result.viewerInvisible),
      },
      degraded: result.degraded,
      refusals: result.telemetry.refusals,
    });
  }),
);

export default router;
