/**
 * discoveryRefusal — the ONE refusal vocabulary for the Discovery API.
 *
 * WHY THIS EXISTS
 * ===============
 * Owner ruling D11, verbatim:
 *
 *   "internal failures must not masquerade as successful empty results or
 *    corrupt exposure accounting"
 *
 * It implements `11` §9 (docs/specs/discovery-v1/11_API_Specification.md:103):
 * *"A failure must not masquerade as success."* — the sentence that stands over
 * the six failure classes §9 names three lines above it.
 *
 * Every Discovery collection route used to answer an internal failure with the
 * SAME BODY it answers a genuinely empty city with: `200 { places: [] }`,
 * `200 { counts: {} }`, `200 { groups: [] }`. A consumer — a client, an
 * analyst, or the exposure denominator — reads "we looked and there was
 * nothing" when the truth is "we did not look". That is the masquerade, and it
 * is indistinguishable from the real thing BY CONSTRUCTION: the two answers are
 * byte-identical.
 *
 * WHY THE STATUS CODE DOES NOT CHANGE (the additive shape)
 * ========================================================
 * §9 has exactly one imperative — "A failure must not masquerade as success" —
 * and one recommendation — APIs "should distinguish" six named classes. NEITHER
 * SENTENCE NAMES A STATUS CODE. The masquerade §9 forbids is a body that is
 * indistinguishable from a successful empty one; a body carrying
 * `refusal: { class, code, coverage: "nothing" }` is not indistinguishable from
 * anything, and it is not claiming to have served a result. So no sentence of
 * §9 forces 4xx/5xx on these routes, and the sentence that would have to force
 * it is not there.
 *
 * Against that, the cost of a status change is concrete and was measured on a
 * sibling surface. routes/mapProjection.ts:195-217 records what happened when a
 * gateway answered a read failure with the wrong SHAPE rather than the wrong
 * status: the client (travel-buddy-standalone/src/hooks/useMapEntities.ts)
 * takes an answer's shape as a claim of ownership and stops re-fetching. The
 * fix there was NOT a new status code; it was `enabled: false` plus a NAMED
 * REFUSAL in the same 200 envelope. This module is that pattern, generalised,
 * and it is deliberately the same pattern rather than a second one: an unknown
 * key is ignored by every existing client, so not one of them breaks, while
 * every consumer that wants the truth can read it.
 *
 * WHAT IS **NOT** RE-EXPRESSED HERE, AND WHY
 * ==========================================
 *  - VALIDATION of genuinely-invalid input keeps its 4xx. `sendError(res,
 *    "invalid_payload", ...)` already returns 400 and is already distinguishable
 *    from an empty success. A prior mutation proved that downgrading such a 400
 *    to `200 { places: [] }` IS the defect; softening one here would be the same
 *    defect with a nicer name. The `"validation"` class below is for a route
 *    that must keep a 200 for a different reason (see `query_too_short` on
 *    /discovery/suggest), never a licence to demote an existing 400.
 *  - AUTHORIZATION failures keep their 401/403 from `requireUser`.
 *
 * THE SIX CLASSES ARE `11` §9's LIST, NOT AN INVENTED ONE
 * ======================================================
 * All six are declared because §9 names all six. Only the ones that actually
 * occur on a Discovery route are emitted today — `transient_db` and
 * `validation`. `feature_disabled` and `unsupported_surface` have no reachable
 * site on these routes at the time of writing, and a site was NOT invented to
 * populate them: a class emitted where nothing of that kind happens is a lie
 * about the failure, which is the thing this module exists to stop.
 */
import type { Response } from "express";
import { logger } from "./logger.js";
import { logDiscoveryServe, type DiscoveryServeLogParams } from "./discoveryServeLog.js";

/**
 * `11` §9's six failure classes, verbatim and in the order the spec lists them
 * (docs/specs/discovery-v1/11_API_Specification.md:96-101).
 */
export const DISCOVERY_REFUSAL_CLASSES = [
  "validation",
  "authorization",
  "constraint_mismatch",
  "transient_db",
  "feature_disabled",
  "unsupported_surface",
] as const;

export type DiscoveryRefusalClass = (typeof DISCOVERY_REFUSAL_CLASSES)[number];

/**
 * What the body this refusal travels in actually contains.
 *
 * This is the field that defeats the masquerade, and it is separate from
 * `class` on purpose. `class` says WHAT WENT WRONG; `coverage` says WHAT THE
 * READER IS HOLDING:
 *
 *   "nothing" — the collection in this body is empty BECAUSE OF THE FAILURE.
 *               It is not a result. Nothing here was served to anyone, so
 *               nothing here may be counted as exposure.
 *   "partial" — some of the collection was produced and IS a real result; the
 *               rest failed. The items present were genuinely served (and are
 *               genuinely exposure); the absences are not evidence of absence.
 *
 * Without the split, the only honest answer to a half-failed multi-source route
 * would be to throw away the half that worked.
 */
export type DiscoveryRefusalCoverage = "nothing" | "partial";

export interface DiscoveryRefusal {
  /** `11` §9 class. */
  readonly class: DiscoveryRefusalClass;
  /** Narrower, route-specific cause. Stable enough to alert on. */
  readonly code: string;
  /** The route that refused, in the same spelling the serve log uses. */
  readonly route: string;
  /** Whether the body carries nothing at all, or a real but incomplete result. */
  readonly coverage: DiscoveryRefusalCoverage;
  /** Which of the route's sources failed, when the route has more than one. */
  readonly failedSources?: readonly string[];
}

/** Build a refusal. One constructor so every route spells the shape identically. */
export function discoveryRefusal(
  cls: DiscoveryRefusalClass,
  code: string,
  route: string,
  coverage: DiscoveryRefusalCoverage = "nothing",
  failedSources?: readonly string[],
): DiscoveryRefusal {
  return {
    class: cls,
    code,
    route,
    coverage,
    ...(failedSources && failedSources.length > 0 ? { failedSources } : {}),
  };
}

/**
 * Responses that served NOTHING because they refused.
 *
 * A WeakSet keyed on the response object rather than a field on `res.locals`:
 * nothing downstream can read it off the wire, nothing has to be cleaned up,
 * and it cannot collide with a route's own locals. Entries die with the
 * response.
 */
const _refusedResponses = new WeakSet<object>();

/** True when this response was sent by `sendDiscoveryRefusal` with coverage "nothing". */
export function wasRefused(res: object): boolean {
  return _refusedResponses.has(res);
}

/**
 * HTTP status for a refusal. See "WHY THE STATUS CODE DOES NOT CHANGE" above:
 * the refusal is carried IN the envelope, additively, so existing clients are
 * byte-compatible and honest consumers are not lied to.
 */
export const DISCOVERY_REFUSAL_STATUS = 200;

/**
 * Send `envelope` with `refusal` merged in.
 *
 * `refusal` is spread LAST so a route cannot accidentally shadow it with a key
 * of its own — the same discipline lib/discoveryServeLog.ts:417-424 applies to
 * the denominator fields it writes.
 *
 * `res.headersSent` is checked because several Discovery routes fire their
 * serve log AFTER `res.json()` and INSIDE the try: a throw from that last
 * statement lands in the catch arm with the real response already on the wire.
 * Calling `res.json` a second time there would replace a served page with an
 * `ERR_HTTP_HEADERS_SENT` crash — a bug introduced by the fix for a bug.
 */
export function sendDiscoveryRefusal<T extends object>(
  res: Response,
  envelope: T,
  refusal: DiscoveryRefusal,
  status: number = DISCOVERY_REFUSAL_STATUS,
): void {
  if (refusal.coverage === "nothing") _refusedResponses.add(res);
  logger.warn(
    { route: refusal.route, refusalClass: refusal.class, code: refusal.code, coverage: refusal.coverage },
    "discovery: refusing — the empty body below is a failure, not a result",
  );
  if (res.headersSent) return;
  res.status(status).json({ ...envelope, refusal });
}

/**
 * Exposure accounting, second half of D11: "or corrupt exposure accounting".
 *
 * `logDiscoveryServe` writes one `rank_events` impression row per served item
 * and then increments `content_distribution_stats.eligible_impressions` — the
 * exposure DENOMINATOR (lib/discoveryServeLog.ts:460-466). A serve that failed
 * exposed nothing, so it must not appear there.
 *
 * Two things stand between a refusal and the denominator, and only one of them
 * existed before D11:
 *
 *  1. `logDiscoveryServe` returns before any insert when `items.length === 0`
 *     (lib/discoveryServeLog.ts:380). A refusal body is empty, so even a
 *     mistaken call writes no row. This is REAL but it is INCIDENTAL: it holds
 *     because of a guard written for a different reason, in a file this lane
 *     does not own, and a future partial-refusal call site would slip past it.
 *  2. This function, which is the guard that is ABOUT the invariant. A response
 *     already sent as a refusal cannot log a serve, whatever it is handed.
 *
 * Route call sites use this instead of `logDiscoveryServe` directly so the
 * invariant is enforced structurally rather than by everyone remembering it.
 * `coverage: "partial"` responses are NOT suppressed: their items really were
 * served, and dropping them would under-count exposure — the same corruption in
 * the other direction.
 */
export function logServeUnlessRefused(
  res: object,
  sc: unknown,
  params: DiscoveryServeLogParams,
): void {
  if (wasRefused(res)) {
    logger.warn(
      { route: params.route, servePoint: params.servePoint, items: params.items.length },
      "discoveryRefusal: serve log SUPPRESSED — a refused response must not enter the exposure denominator",
    );
    return;
  }
  void logDiscoveryServe(sc, params);
}
