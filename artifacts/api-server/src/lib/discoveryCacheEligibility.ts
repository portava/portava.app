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
  | "rank_version_changed" | "row_revoked"; // row_revoked — census-discovery §47; see `pageHasRevokedRow` at the foot of this file

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
  // Revocation of a ROW, as distinct from a change in the viewer's own context.
  // Skipped only when the caller supplies no current eligible set at all, which
  // is the pre-§47 contract the pure-function tests above still exercise; the
  // route always supplies one (guarded in src/test/discoveryCacheRevocation.test.ts).
  if (req.eligibleDbIds !== undefined && pageHasRevokedRow(entry.places, req.eligibleDbIds)) {
    return { usable: false, reason: "row_revoked" };
  }
  return { usable: true, reason: "hit" };
}

// ─────────────────────────────────────────────────────────────────────────────
// census-discovery §47 — REVOCATION INSIDE THE TTL, and the author policy.
//
// Everything below this line was appended rather than edited into the body
// above, because `cacheBEntryUsable` is cited by line (census-discovery §12.2)
// and a line inserted above it silently repoints that citation. The two
// interfaces above are extended by declaration merging for the same reason.
//
// WHAT WAS WRONG. `cacheBEntryUsable` bound a stored cache-B page to the
// VIEWER's context (block set, model version, freshness), and to nothing about
// the ROWS in it. Cache B stores a FINAL page, community rows included, and
// replays it for ten minutes. So anything that made a stored row ineligible
// WITHOUT changing the viewer's own context was served around:
//
//   - a moderator deactivating the row (`discovery_places.status` → not
//     `active`) — `evictCacheEntriesForEntity` evicts CACHE A, which holds OSM
//     rows only, and never touched cache B at all;
//   - the submitter's account leaving `active` (deactivated, pending deletion,
//     deleted) — which no Discovery reader checked on any path;
//   - a canonical `places` row being merged away or deactivated.
//
// Cache A never had this defect, because every serve from it RE-QUERIES the
// community half (`loadCuratedAndCanonicalPlaces`). Cache B's hit path runs on
// a request that has ALSO just re-queried that half — the cold path loads it
// before the Compass branch — so the current eligible set is already in hand.
// The rule is: a stored `db/` row that the current read did not return is a row
// this request is not authorised to serve, and the page is re-ranked.
//
// WHY RE-RANK AND NOT FILTER. Filtering the stored page would serve the old
// order minus the row, which is cheaper, but a row that merely fell out of the
// current read's window (curated rows are capped at 60 by `saved_count`) would
// then be silently dropped rather than re-ranked back in. Invalidation is the
// half of DSV2-06 ("invalidate/revalidate") whose result is exactly what a
// fresh rank would serve.
//
// FAIL-CLOSED ON A FAILED READ. If the curated or canonical read failed, its
// rows are absent from the current set, so every stored row from that source
// reads as revoked and the page is re-ranked from what this request could
// verify. `authorizedContextKey` below makes the degraded page itself a
// distinct context, so it is not replayed after the read recovers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The id prefix of every row that came from a Portava table (`discovery_places`
 * or the canonical `places` registry) rather than from Overpass. These are the
 * rows that carry a status, and may carry an author; OSM rows carry neither, so
 * there is nothing about them a moderator or an account change can revoke.
 */
export const REVALIDATED_ROW_PREFIX = "db/";

export interface CacheBStoredFacts {
  /**
   * The stored page. Required for the row-revocation check whenever the
   * request supplies `eligibleDbIds`; an entry that cannot show its rows cannot
   * show that none of them was revoked, and is rejected.
   */
  places?: ReadonlyArray<{ id: string }>;
}

export interface CacheBRequestFacts {
  /**
   * The `db/` ids THIS request's own community/canonical read returned, after
   * the author policy (blocks both ways, mutes, submitter standing) and the
   * `status = 'active'` predicate. Absent ⇒ the row check is skipped.
   */
  eligibleDbIds?: ReadonlySet<string>;
}

/** The current eligible set, from the places this request actually read. */
export function eligibleDbIdSet(dbPlaces: ReadonlyArray<{ id: string }>): Set<string> {
  const out = new Set<string>();
  for (const p of dbPlaces) if (p.id.startsWith(REVALIDATED_ROW_PREFIX)) out.add(p.id);
  return out;
}

/**
 * True when any `db/` row on a stored page is missing from the current eligible
 * set — or when there is no stored page to inspect (fail-closed). OSM rows are
 * never revoked here: see `REVALIDATED_ROW_PREFIX`.
 */
export function pageHasRevokedRow(
  places: ReadonlyArray<{ id: string }> | undefined,
  eligibleDbIds: ReadonlySet<string>,
): boolean {
  if (!places) return true;
  for (const p of places) {
    if (p.id.startsWith(REVALIDATED_ROW_PREFIX) && !eligibleDbIds.has(p.id)) return true;
  }
  return false;
}

/**
 * The authorized context a cache-B page is stored under and must be replayed
 * under: the author-exclusion fingerprint (blocks both ways AND mutes — see
 * `withMutedAuthors`) plus the retrieval sources this request could NOT read.
 *
 * The second term is what makes a retry correct. A page ranked while the
 * curated read was down holds no community rows; without the term it would
 * replay, unmarked, for the whole TTL after the read recovered. With it, the
 * degraded page is its own context: it is reused while the outage lasts (so an
 * outage does not become a re-rank per request, the same argument
 * `blockFingerprint` makes for `null`) and missed the moment the read succeeds.
 *
 * With no failed source the key is exactly `blockFingerprint(hidden)`, so every
 * page stored by a healthy request keeps the key it had before §47.
 */
export function authorizedContextKey(
  hidden: Set<string> | null,
  failedSources: readonly string[],
): string {
  const base = blockFingerprint(hidden);
  if (failedSources.length === 0) return base;
  return `${base}|unread:${[...failedSources].sort().join(",")}`;
}

// ── The author policy: mutes, and submitter standing ─────────────────────────
//
// A `discovery_places` row may carry `submitted_by` — a person whose blurb,
// photo and rating ride along with the venue. Blocks (both ways) were already
// enforced at the one funnel every row crosses (`submitterIsVisible`, in
// lib/blocks.ts). Two further author rules were enforced on the sibling media
// surfaces (lib/mediaEligibility.ts steps 2 and 3) and on NO Discovery path:
//
//   MUTES — `user_mutes` (muter_id → muted_id). A viewer who muted a person is
//     not shown that person's content on Media; on Discovery they were.
//   STANDING — `profiles.account_status`. Only `active` accounts are
//     distributed; a deactivated, pending-deletion or deleted account's
//     submissions were served on every Discovery path, byline included on
//     `GET /discovery/community`.
//
// `DiscoveryRankingService`'s viewer context carries `mutedCreatorIds` and
// `blockedCreatorIds`, and `lib/discoveryPde.ts` hands it empty sets. Threading
// real sets there would change nothing: no code in services/ranking reads
// either field (its eligibility gate reads per-ITEM booleans), and every
// Discovery item reaches it with `creatorId: null`. The enforcement point is the
// candidate pre-filter, as it already was for blocks, and that is where these go.

/**
 * The viewer's author-exclusion set: `blocked` (both directions, from
 * `fetchBlockedSet`) plus everyone the viewer MUTED.
 *
 * FAIL-CLOSED, both halves: `null` in, or an unreadable `user_mutes`, gives
 * `null`, which `submitterIsVisible` answers by withholding every AUTHORED row
 * and keeping every venue fact. Media fails a mute read OPEN (it is a
 * preference there); here the mute set is folded into the same set as blocks —
 * and so into cache B's authorized-context key — and a set whose membership is
 * unknown cannot be half-trusted. The blast radius is the authored rows of one
 * signed-in viewer's page, never the page.
 */
export async function withMutedAuthors(
  sc: any,
  viewerId: string,
  blocked: Set<string> | null,
): Promise<Set<string> | null> {
  if (blocked === null) return null;
  if (!sc) return null;
  try {
    const { data, error } = await sc.from("user_mutes").select("muted_id").eq("muter_id", viewerId);
    if (error || !Array.isArray(data)) return null;
    if (data.length === 0) return blocked;
    const out = new Set(blocked);
    for (const r of data as Array<{ muted_id?: unknown }>) {
      if (typeof r?.muted_id === "string" && r.muted_id !== "") out.add(r.muted_id);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Which of these submitters are NOT in good standing (`account_status` other
 * than `active`).
 *
 * The complement of an allowlist, not a denylist of named bad values:
 * `not.eq.active` returns every status that is not `active`, including any
 * added to the CHECK later — the objection lib/circleLocationsRead.ts records
 * against a `['suspended','banned']` list does not apply. A NULL status is not
 * returned and so reads as active, which is lib/http.ts's convention for the
 * pre-migration case; the column is NOT NULL.
 *
 * Returns an EMPTY set without reading when there is no submitter to ask about,
 * and `null` when the read fails — the caller must treat `null` as "standing
 * unknown", never as "everyone is active".
 */
export async function inactiveSubmitterIds(
  sc: any,
  submittedBy: Iterable<unknown>,
): Promise<Set<string> | null> {
  const ids = [...new Set([...submittedBy].filter((v): v is string => typeof v === "string" && v !== ""))];
  if (ids.length === 0) return new Set();
  if (!sc) return null;
  try {
    const { data, error } = await sc
      .from("profiles")
      .select("id")
      .in("id", ids)
      .not("account_status", "eq", "active");
    if (error || !Array.isArray(data)) return null;
    return new Set((data as Array<{ id?: unknown }>).map((r) => r?.id).filter((v): v is string => typeof v === "string"));
  } catch {
    return null;
  }
}

/**
 * Standing half of the author policy, for one row. A row with no submitter is a
 * venue fact and always passes; an authored row passes only when standing was
 * READ and the submitter is not in the inactive set.
 */
export function submitterInGoodStanding(submittedBy: unknown, inactive: Set<string> | null): boolean {
  const author = typeof submittedBy === "string" && submittedBy !== "" ? submittedBy : null;
  if (!author) return true;
  if (inactive === null) return false;
  return !inactive.has(author);
}

/**
 * The inactive set for rows that already carry their submitter's profile as a
 * PostgREST embed (`GET /discovery/community`'s byline join), so that route
 * pays no second round trip for the same rule.
 *
 * An authored row whose embed is ABSENT is standing-unknown and is treated as
 * inactive — withheld. `discovery_places.submitted_by` is `ON DELETE SET NULL`
 * (0029), so a live submitter id always has a profile row for the service
 * client to see; an absent embed is not a state the schema produces, and it is
 * not one to serve an author's byline under. An embed with no `account_status`
 * key reads as active, the same NULL convention as above.
 */
export function inactiveSubmittersFromEmbed(
  rows: ReadonlyArray<{ submitted_by?: unknown; profiles?: unknown }>,
): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    const author = typeof row.submitted_by === "string" && row.submitted_by !== "" ? row.submitted_by : null;
    if (!author) continue;
    const embed = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
    if (!embed || typeof embed !== "object") { out.add(author); continue; }
    const status = (embed as { account_status?: unknown }).account_status;
    if (status !== undefined && status !== null && status !== "active") out.add(author);
  }
  return out;
}

// ── The adult-venue predicate the age gate applies on every serve path ───────
//
// census-discovery §47. `GET /discovery`'s `applyFilters` withholds adult-only
// venue types (`ADULT_OSM_VENUE_TYPES` in routes/discovery.ts) from a caller who
// is not a confirmed adult or whose age bounds fall under 18. It compared the
// set against `place.category` — and on this route `category` is never a venue
// type: an OSM row's `category` is the requested TAB (`mapOsmElementToPlace`
// stamps the `category` argument), and a Portava row's is a canonical tab from
// `mapDbCategory` / `toCanonicalCategory`. So a real bar, served from Overpass
// as `{ category: "for_you", type: "bar" }`, passed the gate for a verified
// minor. The only test of the gate injected a fixture spelled
// `category: "bar"`, a shape the route never produces, which is how it stayed
// green.
//
// The venue type an OSM row carries is `type` (`friendlyType`: the `amenity`,
// `leisure` or `tourism` value with `_` rendered as a space — so
// `adult_gaming_centre` arrives as `adult gaming centre`). Both fields are read,
// both normalised to the set's spelling, so the gate fires on real rows and
// every row the old comparison caught is still caught.

function venueKey(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase().replace(/\s+/g, "_") : "";
}

/** True when either the row's venue `type` or its `category` names an adult-only venue type. */
export function isAdultOnlyVenue(
  place: { category?: string | null; type?: string | null },
  adultTypes: ReadonlySet<string>,
): boolean {
  return adultTypes.has(venueKey(place.type)) || adultTypes.has(venueKey(place.category));
}
