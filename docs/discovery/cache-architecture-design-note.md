# Discovery cache architecture — design note

*`docs/specs/discovery-v1/12_Claude_Code_Implementation.md` Phase 2: "Deliver a design note documenting: candidate cache key, ranking cache key, invalidation, model/version handling, personalization boundary." This is that note. Census row **DC-25**; graded in `docs/architecture/census-discovery.md` §47.*

*Written 2026-09-27 against `disc-p2-ranking` (parent `709b7b800`). It records what the code does at this tree, with file:line. Where the code falls short of the design, the note says so and names the owner of the gap. It does not describe an intended future as if it were present.*

---

## 0. The two caches in one paragraph

`GET /discovery` has two in-process caches, and they are **in series, not in parallel**.

- **Cache A** is user-independent. It holds retrieval results only: OSM rows from Overpass. It has a second tier (L2) in Postgres.
- **Cache B** is per-user. It holds a final ranked page from Compass for ten minutes.

A request consults Cache A first. On a hit it returns from Cache A (serve points 1/2/3) and never reaches Cache B. Cache B is consulted only on a Cache A miss, and only for a signed-in `for_you` request while `COMPASS_V1_RULE_BASED_ENABLED` is on. That flag is TRUE on production (integrator read, 2026-09-27).

The shipping client calls `GET /discovery` with no bearer token (`travel-buddy-standalone/src/services/discovery.ts:697#const res = await fetch(`). So on production today every request is anonymous and Cache B is never reached from that client.

## 1. Candidate cache key (Cache A)

| | |
|---|---|
| Key | `cacheKey(dest, cat, radius)` = lower-cased trimmed destination, category, radius km (`artifacts/api-server/src/routes/discovery.ts:299#function cacheKey(dest: string, cat: strin`). **No viewer term, by design.** |
| L1 | In-process `Map`, TTL 2 h (`artifacts/api-server/src/routes/discovery.ts:115#const CACHE_TTL_MS     = 2 * 60 * 60`), bounded to 500 entries on every write (`artifacts/api-server/src/routes/discovery.ts:311#function setCacheA(key: string, entry: CacheE`). |
| L2 | `discovery_cache`, keyed `cache_key`, TTL 2 h, stale-while-revalidate (`artifacts/api-server/src/lib/discoveryPersistentCache.ts:19#const PLACE_TTL_MS   = 2  * 60 * 60 * 1_000;`). A stale row is served while a background refetch runs. |
| Contents | **OSM rows only**: the Overpass result enriched with aggregate saved/vote counts, with distances measured from the request's `lat/lng` (the destination centre). It holds no community (`discovery_places`) row and no canonical `places` row; both are re-read on every request. It holds nothing a viewer contributed: no device position (`userLat/userLng`), mutes, dismissals, recommendation ids or projection fields. Written at `artifacts/api-server/src/routes/discovery.ts:2099#setCacheA(key, { places: enrichedOsm, cachedAt` (L1) and `artifacts/api-server/src/routes/discovery.ts:2101#void writePlacesToDb(key, destination!, category, radiusKm, enrichedOsm` (L2), by the stale revalidation, and by `GET /discovery/counts`. |
| Proof | `src/test/discoveryServePathIsolation.test.ts` covers this. I6: a signed-in fetch with a device position, mutes and a dismissal persists the same L2 row an anonymous fetch persists. I7: B, served from the entry A's fetch wrote, sees what A's rules removed from A. I8: the entry is OSM-only, so a community row that becomes ineligible cannot ride the cached half. |

**Stated gap, not fixed here.** The key omits the Overpass centre. The first request's `lat/lng` therefore fixes the entry for two hours, and L2 persists that centre as `geocode_lat/lng`, which nothing reads back. The client contract is that `lat/lng` is the destination's coordinates and never the device's; all three client call sites honour it in comments and code. A caller that broke the contract would pin its own centre into a shared entry. Two designs close the gap:

- bind a rounded centre (about 1 km) into the key; or
- refuse to write L1/L2 from a request whose centre is not the geocoded destination centre.

Both change legacy cache behaviour, so neither was taken under the "legacy byte-identical" rule.

## 2. Ranking cache key (Cache B)

| | |
|---|---|
| Key | `compassCandidateCacheKey(userId, destination, radiusKm, sortBy)` (`artifacts/api-server/src/routes/discovery.ts:295#function compassCandidateCacheKey(userId: str`). Never stored for `sortBy=nearest` (`artifacts/api-server/src/routes/discovery.ts:2117#const skipCache = sortBy === "nearest";`). Bounded to 1,000 entries. |
| Acceptance | One pure rule, `cacheBEntryUsable` (`artifacts/api-server/src/lib/discoveryCacheEligibility.ts:149#export function cacheBEntryUsable(`). A stored page answers only when all of these hold: it is present; it is younger than 10 min (`artifacts/api-server/src/lib/discoveryCacheEligibility.ts:94#export const CACHE_B_TTL_MS`); its **authorized context** matches; its **rank version** matches; and **no row on it has been revoked**. |
| Authorized context | `authorizedContextKey(exclusions, failedSources)` (`artifacts/api-server/src/lib/discoveryCacheEligibility.ts:296#export function authorizedContextKey(`). It combines the viewer's author-exclusion fingerprint (blocks in both directions **and mutes**; unreadable is its own value) with the retrieval sources this request could not read. A page ranked during an outage is reused while the outage lasts and missed once the read recovers. |
| Row revocation | Every stored `db/` row must be in THIS request's community/canonical read (`artifacts/api-server/src/lib/discoveryCacheEligibility.ts:248#export function pageHasRevokedRow(`). That read already applies `status = 'active'`, blocks in both directions, mutes and submitter standing. A moderated, deactivated, muted or merged row therefore re-ranks the page. |
| Replay | The stored **order** is replayed with the **current** row content (`artifacts/api-server/src/lib/discoveryCacheEligibility.ts:272#export function withCurrentRows`). A moderated image or blurb is not served from the stored copy. |

## 3. Invalidation

**Cache A** is invalidated by its TTL and by explicit eviction on writes that change an OSM row's enrichment:

- `evictOsmPlaceFromL1Cache` and `invalidateDiscoveryCacheForOsmId`, on a vote, review or save;
- `patchOsmSavedCount`.

The moderation eviction `evictCacheEntriesForEntity` targets `db/<id>`. Cache A holds no `db/` row, so that eviction is a no-op. It is harmless, because community rows are re-read per request. It is recorded here so nobody mistakes it for Cache B's invalidation.

**Cache B** is never evicted by a write. It is **revalidated on every hit** against the facts the request has just read (§2). That is DSV2-06's "invalidate/revalidate": a permission change changes the authorized context, and an evidence change revokes the row or replaces its content.

**Re-applied per viewer on every serve**, including every cache hit:

| rule | Cache A serve (1/2/3) | Cache B hit (4) | fresh rank (5, 6) | failure direction |
|---|---|---|---|---|
| blocks, both directions | community half re-read | fingerprint in the key | pre-filter | closed (authored rows withheld) |
| mutes | community half re-read | fingerprint in the key | pre-filter | closed (authored rows withheld) |
| submitter standing (`account_status`) | community half re-read | row revocation | pre-filter | closed (curated source reported unreadable) |
| row status / moderation | community half re-read | row revocation and current content | read predicate | closed |
| "Not interested" | `dismissGatedPlaces` | `dismissGatedPlaces` | `dismissGatedPlaces` | open, and **reported** (`failedSources`) |
| Layover gate | `layoverGatedPlaces` | `layoverGatedPlaces` | `layoverGatedPlaces` | refuses |
| age gate | `applyFilters` | `applyFilters` | `applyFilters` | closed (adult venues out when age is unknown) |

Profile opt-outs (real name, avatar) apply only where a person's identity is served. On these routes that means only `GET /discovery/community`'s byline. There, `nameVisibilitySet` applies the real-name opt-out. The **avatar** opt-out (`profiles.show_profile_picture_publicly`, private profiles) is **not** applied; census-discovery §47 records it as a residual.

## 4. Model / version handling

- **Cache A** stores no model output, so it has no version.
- **Cache B** stores `rankVersionKey(DISCOVERY_MODEL_VERSION, DISCOVERY_FEATURE_VERSION)` (`artifacts/api-server/src/routes/discovery.ts:272#const CURRENT_RANK_VERSION`; `artifacts/api-server/src/lib/discoveryRankProvenance.ts:73#export const DISCOVERY_MODEL_VERSION` and `:80`). A page from another version is a miss. A page with no version is also a miss: unknown is never treated as matching.
- `06` §5's provenance is **replayed, not rebuilt**, on a hit (`artifacts/api-server/src/routes/discovery.ts:2145#provenanceById: cCacheHit.provenanceById`). That provenance covers model and feature version, candidate source, reasons, raw features and ranking timestamp.

## 5. Personalization boundary

**Shared across viewers:** retrieval results, meaning OSM facts in Cache A. Nothing else.

**Per viewer, never shared:** every ranked order, every eligibility decision, community and canonical rows, recommendation ids, dismissals and the projection fields.

Where the shipping default **does not personalize**: in `legacy` mode a Cache A hit serves the cached candidate order unranked (`artifacts/api-server/src/routes/discovery.ts:1852#let servedFiltered = filtered;`). That is DV-03. It is not a privacy crossing, because no viewer's data or order reaches another viewer (§1's tests). It is a missing personalization step. The step is built: the `pde` branch ranks the same candidates per request (`artifacts/api-server/src/routes/discovery.ts:1857#if (pdeCohort?.included && callerUserId) {`). Enabling it is Phase F gate 2 of `docs/discovery/ROADMAP.md`, which is the owner's decision and not a code change.

## 6. What would make this note false

- A `tripId` or other trip context added to `GET /discovery` without entering `authorizedContextKey`.
- A community or canonical row written into Cache A. `discoveryServePathIsolation` I8 would go red.
- A second writer of Cache B that bypasses `cacheBEntryUsable`, or a hit path that drops `eligibleDbIds`. `discoveryCacheRevocation` G1 would go red.
- A client that sends a device position as `lat/lng` (§1's stated gap).
