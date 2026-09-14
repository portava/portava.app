/**
 * discoveryCacheEligibility — the authorized-context fingerprint that binds a
 * cached Discovery page to the permissions it was built under.
 *
 * WHY THIS EXISTS
 * ===============
 * `GET /discovery` has two caches with very different shapes, and only one of
 * them re-checks eligibility on the way out:
 *
 *   Cache A — user-INDEPENDENT, stores the raw candidate set, keyed
 *             (destination, category, radius). Every serve from it re-reads the
 *             curated rows through loadCuratedAndCanonicalPlaces(...,
 *             viewerBlockedIds), so the viewer's block set is re-applied on
 *             every request and a block lands on the very next one.
 *
 *   Cache B — per-USER, stores a FINAL RANKED PAGE for ten minutes. On a hit it
 *             runs only applyFilters over the stored page, and applyFilters
 *             filters on open-now, rating, adult-venue and sort — it applies no
 *             block rule and it re-reads nothing.
 *
 * So eligibility for a cache-B page was decided once, at write time, and then
 * replayed. A viewer who blocked somebody kept receiving that person's
 * submitted places until the TTL expired. The asymmetry with cache A is what
 * makes that a defect rather than a design choice: the same request, one branch
 * earlier, re-applies blocks.
 *
 * REQUIREMENTS
 * ============
 *   DISCOVERY 01 §7 / 06 §4-§5 — a ranking cache is keyed by user + context, and
 *     final ranking must not be served from a cache that skipped it.
 *   DSV2-05 — shared caching must not bypass per-user ranking OR ELIGIBILITY.
 *   DSV2-06 — a change in permission must invalidate or revalidate affected
 *     results. This module is the invalidate half, which is the cheaper one.
 *   Upgrades v2 START_HERE — "Revocation must propagate to caches, projections,
 *     queued attention, and consumers."
 *
 * It lives in its own module rather than inside routes/discovery.ts so it is
 * unit-testable without standing up the route, and so the route's line numbers
 * move as little as possible — a census elsewhere in this repo cites them.
 */

/**
 * Order-independent digest of a viewer's block set, used to decide whether a
 * cached ranked page is still authorized for the request in hand.
 *
 * Three properties are load-bearing, and each has a test and a mutation:
 *
 *   ORDER-INDEPENDENT — the ids are sorted, so an equal set always produces an
 *   equal fingerprint and an unchanged viewer keeps their cache. Without this
 *   the cache would invalidate on iteration order, which is correct but useless.
 *
 *   NOT SIZE-ONLY — the ids themselves are included, so swapping one blocked
 *   user for another does not silently reuse a page ranked for the other set.
 *
 *   UNREADABLE IS ITS OWN VALUE — `null` means the blocks table could not be
 *   read, which every Discovery reader treats as fail-closed. It must never
 *   compare equal to a READABLE set: replaying a page built while blocks were
 *   verifiable, at a moment when they are not, would serve rows the current
 *   request cannot check. It DOES compare equal to another `null`, because two
 *   fail-closed pages are the same page, and forcing a full re-rank on every
 *   request during a blocks outage would turn a degraded read into a load
 *   problem.
 *
 * Pure, synchronous, and total: it reads no clock, touches no client, and has
 * no failure mode of its own.
 */
export function blockFingerprint(blocked: Set<string> | null): string {
  if (blocked === null) return "unreadable";
  if (blocked.size === 0) return "none";
  return `${blocked.size}:${[...blocked].sort().join(",")}`;
}

// ── The full cache-B acceptance rule (DSV2-06) ────────────────────────────────
//
// DSV2-06: "Bound final caches by authorized context, VERSION and freshness.
// Changes in permission, trip context or evidence validity invalidate /
// revalidate affected results; feature and model provenance survives cache
// reuse."  `06` §5's allowed pattern names the same three nouns: "optionally
// cache short-lived ranking results keyed by USER + CONTEXT + MODEL/VERSION".
//
// Two of the three were already bound — the key carries user + destination +
// radius + sort, and `blockFingerprint` above binds the authorized context. The
// third was not: a page ranked by one model/feature shape stayed usable across
// a deploy that changed that shape, because the entry recorded no version and
// the hit path compared none. That is not a hypothetical: the entry survives
// for the whole TTL, and a rolling deploy serves both shapes at once.
//
// The rule lives here, whole, rather than as three conditions spread down the
// route, so that its PRECEDENCE is testable. Precedence is a real decision:
// when a page is both unauthorized and stale-versioned, the reported reason is
// the authorization one, because that is the reason an operator needs to see.

/** How long a cache-B entry may be replayed. Matches the Compass feed TTL. */
export const CACHE_B_TTL_MS = 10 * 60 * 1_000;

/**
 * The identity of the ranking shape a page was produced under.
 *
 * Both halves are included because they fail differently: a new MODEL produces
 * a different order from the same features, and a new FEATURE version produces
 * a bag that cannot be compared with the stored one at all (`01` §7's
 * re-ranking and counterfactual analysis both need the shapes to match).
 */
export function rankVersionKey(modelVersion: string, featureVersion: string): string {
  return `${modelVersion}|${featureVersion}`;
}

export type CacheBRejection =
  | "absent"
  | "expired"
  | "block_set_changed"
  | "rank_version_changed";

export interface CacheBAcceptance {
  usable: boolean;
  reason: "hit" | CacheBRejection;
}

/** What a stored cache-B entry must carry for this rule to judge it. */
export interface CacheBStoredFacts {
  /** Epoch ms the entry was written. */
  at: number;
  /** `blockFingerprint` of the block set the page was ranked under. */
  blockKey: string;
  /**
   * `rankVersionKey` of the ranker that produced the page. `null` means the
   * entry pre-dates version binding — REJECTED, never accepted by default:
   * treating unknown as matching is the fail-open direction, and an unversioned
   * page is exactly the one most likely to be from the previous shape.
   */
  rankVersion: string | null;
}

export interface CacheBRequestFacts {
  nowMs: number;
  blockKey: string;
  rankVersion: string;
  ttlMs?: number;
}

/**
 * Decide whether a stored cache-B entry may answer this request.
 *
 * Pure and total: no clock of its own, no client, no throw. The order of the
 * checks IS the contract — absence, then freshness, then authorization, then
 * version — and each rejection names itself so a caller can log WHY a page was
 * re-ranked rather than only that it was.
 */
export function cacheBEntryUsable(
  entry: CacheBStoredFacts | null | undefined,
  req: CacheBRequestFacts,
): CacheBAcceptance {
  if (!entry) return { usable: false, reason: "absent" };
  const ttlMs = req.ttlMs ?? CACHE_B_TTL_MS;
  if (!(req.nowMs - entry.at < ttlMs)) return { usable: false, reason: "expired" };
  if (entry.blockKey !== req.blockKey) return { usable: false, reason: "block_set_changed" };
  if (entry.rankVersion !== req.rankVersion) return { usable: false, reason: "rank_version_changed" };
  return { usable: true, reason: "hit" };
}
