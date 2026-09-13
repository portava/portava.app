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
