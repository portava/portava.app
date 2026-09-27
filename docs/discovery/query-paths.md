# Discovery query paths: cardinality, index rationale, EXPLAIN

*census-discovery DC-15, §54. Written 2026-09-27 by the Discovery database and rollout lane. It answers `docs/specs/discovery-v1/10_Database_Architecture.md` §4 for Discovery's hot reads and writes: "Every new query path must have: expected cardinality, index rationale, EXPLAIN verification where meaningful."*

**Read this first: every plan below is a HARNESS plan, not a production plan.** It was captured on the local PostgreSQL 16 harness (`artifacts/api-server/scripts/local-db`), over synthetic rows at the cardinality in §1, after `ANALYZE`. Production runs PostgreSQL 17.6 over different row counts and a different distribution, and nobody has run `EXPLAIN` there for this document. A harness plan shows that an index is usable by its predicate and what the planner does at the stated scale. It does not show what production does today. The production cardinality column is copied from reads the census recorded, with the date of each read.

To reproduce, run `docs/discovery/query-paths-explain.sql` against the harness. It seeds the rows, analyzes, explains, and then rolls everything back. It must never be pointed at `portava-ci` or production.

`pnpm run check:discovery-query-paths` keeps §4 complete. It fails when any migration creates a table or an index on a Discovery table without a registry row here, and when a row names an object that no migration creates. Since census-discovery §62 an "index" includes one a UNIQUE or EXCLUDE constraint creates, inline in `CREATE TABLE` or through `ALTER TABLE … ADD`, and an unnamed one fails until it is named.

## 1. Cardinality

| table | synthetic (harness) | production, as last read | source of the production figure |
|---|---:|---:|---|
| `discovery_places` | 20,000 (100 cities × 200, 90 % active) | 184 | census-discovery §5, 2026-09-07 |
| `discovery_place_saves` | 20,000 | 0 | §5 |
| `discovery_place_reports` | 1,000 | 0 | §5 |
| `discovery_cache` | 5,000 | 76 | §5 |
| `discovery_geocode_cache` | 2,000 | 20 | §5 |
| `discovery_place_photos` | 20,000 | 15 | §5 |
| `discovery_shadow_serves` | 10,000 | 0 | §5 |
| `rank_events` | 250,000 (50,000 `discovery`, 2,000 dismisses) | 234,224, of which 13 `discovery` | §5; §49.4 (2026-09-27: all rows `schema_version` 1, newest 2026-08-27) |
| `recommendations` | 20,000 | table absent (3376 unapplied) | §49.4 |
| `place_momentum` | 20,000 | table absent (2892 unapplied) | §47.1 |
| `rank_event_outcome_receipts` | 20,000 (10 per viewer) | table absent (3420 unapplied) | §62 |
| `trails` / `content_trails` / `trail_edges` / `trail_follows` / `trail_reports` / `trail_health_snapshots` | 2,000 / 50,000 / 4,000 / 10,000 / 500 / 20,000 | `trails` 0 (2910 applied 2026-09-20); the rest not read | §47.1 |
| `trail_relations` | 3,991 after one rebuild over the rows above (QP-27) | table absent (3416 unapplied) | census-discovery §61 |

**Expected production growth, where anything states it.** `recommendations` gets one row per served Discovery request while `discovery_serve_log_enabled` is on, which is its value in production (3376's header). `rank_events` gets one `discovery` row per served item per signed-in serve. No document states an expected corpus size for `discovery_places` or `trails`. The synthetic figures are chosen so a plan has something to choose between. They are not a forecast.

## 2. The paths

The serve paths are the ones §47.2 of the census maps. "Rows examined" is the harness's `actual rows` at the scan node, plus `Rows Removed by Filter` where the scan filtered.

### QP-01 Cache A L2 read

`lib/discoveryPersistentCache.ts`: `discovery_cache` by `cache_key`, on every Cache A L1 miss. **Index:** `discovery_cache_pkey`. Harness: Index Scan, 1 row. Production: 76 rows. One lookup per L1 miss.

### QP-02 Geocode cache read

`lib/discoveryPersistentCache.ts`: `discovery_geocode_cache` by `location_key`. **Index:** `discovery_geocode_cache_pkey`. Harness: Index Scan, 1 row. Production: 20 rows.

### QP-03 Curated community rows for a city

`routes/discovery.ts` (`loadCuratedAndCanonicalPlaces`): `city ILIKE x OR city ILIKE x%`, `status = 'active'`, source not a fixture, `ORDER BY saved_count DESC LIMIT 200`. It runs on every `GET /discovery`, cache hit or miss (§47.2). **Index: none usable.** Case-insensitive `ILIKE` cannot use the btree on `city`. Harness: Seq Scan, 200 rows kept of 20,000 (19,800 removed), then Sort. **At production's 184 rows a sequential scan is the right plan, and no index is proposed.** If the corpus grows by two orders of magnitude, the index this path needs is an expression index on `lower(city)` with `text_pattern_ops`, plus a change of predicate to match it. That changes the served rows' matching, so it is not built here.

### QP-04 `GET /discovery/community`

`routes/discovery.ts`: `city ILIKE x`, `status = 'active'`, ordered by `created_at` / `rating` / `saved_count`, with a limit. **Index: none usable** (same reason as QP-03). Harness: Seq Scan, then top-N heapsort. Production: 184 rows.

### QP-05 Saved counts for served OSM ids

`routes/discovery.ts:1331`: `osm_id IN (…)`. **Index:** `idx_discovery_places_osm_id` (partial, `osm_id IS NOT NULL`). Harness: Index Scan, 5 rows. The unique twin `discovery_places_osm_id_idx` exists as well (§3).

### QP-06 Resolved photo for a card

`lib/discoveryPlacePhotoStore.ts`: `discovery_place_photos` by `place_key`. **Index:** `discovery_place_photos_pkey`. Harness: Index Scan, 1 row. Production: 15 rows.

### QP-07 The viewer's "Not interested" set

`lib/discoveryDismissed.ts`: `rank_events` for this viewer's `discovery` dismisses, newest 500. **Index:** `rank_events_discovery_dismissed` (2995, partial). Harness: Index Only Scan, 125 rows.

### QP-08 The viewer's recently-seen set (the PDE seen penalty)

`lib/discoveryPde.ts`: this viewer's `discovery` rows (not analytics) from the last 24 h. **Index:** `rank_events_user_served_at`. Harness: Index Scan on (user, time), with surface and outcome as filters, 3 rows.

### QP-09 Local momentum over candidate ids

`lib/discoveryLocalMomentum.ts` (behind 2289): `discovery` rows for a candidate id set in a time window, paged. **Index:** `rank_events_discovery_served_at` (3391). Harness: Index Scan Backward over the Discovery rows in the window, filtered by id. **Without 3391's index the same query was a Parallel Seq Scan over all 250,000 rows** (QP-09-before-3391 in the script). 3391 was written for QP-19, and it changes this existing path's plan too. The change is stated here because a new index moving an existing plan is exactly what §4 asks to be verified.

### QP-10 An outcome bound to its exposure by recommendation id

`routes/rankEvents.ts` (§48's binding): `recommendation_id = x AND outcome = 'impression'`. **Index:** `rank_events_recommendation_idempotency_idx` (2891, unique). Harness: Index Scan.

### QP-11 Latest exposure for (viewer, item, surface)

`routes/rankEvents.ts` fallback: `ORDER BY served_at DESC LIMIT 1`. **Index:** `rank_events_user_item`. Harness: Index Scan, with surface as a filter, 1 row.

### QP-12 Search: places by free text

`routes/discoverySearch.ts`: `name / city / blurb ILIKE %q%`, `status = 'active'`. **Index: none usable.** A leading-wildcard `ILIKE` needs a trigram index (`pg_trgm` is installed on the harness and on Supabase), and none exists. Harness: Seq Scan, 1,000 kept of 20,000. Production: 184 rows, where a trigram index would cost more than it saves. The same applies to the two sibling queries in that file (`:1448`, `:1901`).

### QP-13 Trails for a destination

`services/trails/TrailService.ts`: `destination = x AND lifecycle_status = 'active'`. **Index:** `idx_trails_destination_lifecycle`. Harness: Bitmap Index Scan, 6 rows. Production: 0 Trails.

### QP-14 A Trail's members, newest 500

`TrailService.readMembers`. **Index:** `idx_content_trails_trail` (trail_id, created_at DESC). Harness: Bitmap Index Scan, 10 rows, then Sort. Well under 500 per Trail at this cardinality.

### QP-15 A Trail's edges, both directions

`TrailService` related-Trail walk. **Index:** `trail_edges_pkey` (out-edges) and `idx_trail_edges_to` (in-edges). Harness: Index Scan each way.

### QP-16 A Trail's open reports

`TrailService.readOpenReportCount`. **Index:** `idx_trail_reports_open` (partial, `resolution IS NULL`). Harness: Index Scan.

### QP-17 The hourly health-snapshot guard

`TrailService.recordTrailHealthSnapshot`: one snapshot per Trail per hour. **Index:** `idx_trail_health_recent`. Harness: Index Scan, 1 row.

### QP-18 A viewer's followed Trails

The Trail-affinity input. **Index:** `idx_trail_follows_user`. Harness: Index Scan.

### QP-19 Stop measurement: Discovery exposures in the window

`discovery_stop_measurements()` (3391), at most once per resolver refresh (30 s) per API instance, and only while the engine mode is non-legacy. **Index:** `rank_events_discovery_served_at` (3391, partial `surface = 'discovery'`). Harness: Index Scan over the window. Without it, the planner used `rank_events_user_served_at` as a whole-index scan filtered by surface (QP-19-before-3391), which reads every surface's rows. Production has 13 `discovery` rows, so today the index is nearly free to keep. It exists for the rollout, when it will not be.

### QP-20 Stop measurement: dismisses in the window

3391. **Index:** `rank_events_discovery_dismissed` (2995), used as a scan of every Discovery dismiss, because `outcome_at` is not indexed. Harness: 2,000 rows read for 0 in the window. It is linear in all-time Discovery dismisses, which is 0 in production. If dismisses reach the tens of thousands, an index on `(outcome_at) WHERE outcome = 'dismiss' AND surface = 'discovery'` is the fix. It is not built now.

### QP-21 Per-request serve record window

3376's reports: `recommendations` by `served_at`. **Index:** `recommendations_served_at`. Harness: Index Scan, 120 rows.

### QP-22 Latest momentum for a place

2892's table (no reader yet): `place_id = x ORDER BY computed_at DESC LIMIT 1`. **Index:** `place_momentum_place_computed_idx`. Harness: Index Scan, 1 row. **Reader since census-discovery §58** — `lib/discoveryTrendExplanation.readTrendSnapshot`, behind `discovery_trending_api_enabled` (3410, seeded FALSE), makes two reads: the newest run, `source_surface = 'discovery' ORDER BY computed_at DESC LIMIT 1` (**Index:** `place_momentum_computed_idx`, filter on `source_surface`), then that run's rows for at most 20 served ids, `computed_at = x AND place_id = ANY(…)` (**Index:** `place_momentum_computed_idx` or `place_momentum_place_computed_idx`). Harness, empty table, `enable_seqscan = off`: Index Scan with no Sort node for both. A harness plan at zero rows proves the index is usable, not that the planner chooses it at production volume; the table ships empty and nothing schedules the rebuild.

### QP-23 Shadow divergence report window

`lib/discoveryDivergenceReport.ts`: `discovery_shadow_serves` by serve point and time. **Index:** `discovery_shadow_serves_serve_point_observed_at`. Harness: Bitmap Index Scan, 482 rows.

### QP-24 Discovery's writes to `rank_events`

`lib/discoveryServeLog.ts` and `lib/rankLog.ts` insert one row per served item. `routes/rankEvents.ts` updates or inserts outcomes. An `INSERT` plan says nothing useful. The cost is **index maintenance**: every Discovery row maintains `rank_events_pkey`, `rank_events_user_served_at`, `rank_events_user_item`, `rank_events_features_gin` (a GIN index over the whole `features` jsonb, the most expensive of them), `rank_events_recommendation_idempotency_idx`, and, when it applies, the two partial Discovery indexes (2995, 3391) and `rank_events_event_type`. 3391 adds one partial index that only `surface = 'discovery'` rows pay for. 3420 (§62) adds no index to `rank_events`. A nullable column and a row trigger fire only for an UPDATE that sets `outcome_client_event_id`, which costs one primary-key insert into `rank_event_outcome_receipts`. Production writes nothing to `rank_events` today (newest row 2026-08-27, §49.4).

### QP-25 A keyed outcome's receipt (census-discovery §62, 3420)

`routes/rankEvents.ts` (`readOutcomeReceipt`): `rank_event_outcome_receipts` by `(user_id, client_event_id)`, once per outcome report that carries a `client_event_id`, before any other read. **Index:** the table's primary key, which is also the idempotency arbiter. Harness: Index Scan using `rank_event_outcome_receipts_pkey`, 1 row of 20,000. Expected cardinality: one row per keyed outcome, so at most `rank_events`' outcome count for the client builds that send a key (production: 13 `discovery` rows ever, and no build sends a key yet). The write side is the trigger `rank_events_outcome_receipt`, which fires only on an UPDATE that names `rank_events.outcome_client_event_id`. Only the keyed outcome route does that, so no other `rank_events` write pays for it (QP-24).

### QP-26 A Trail proposal's comparison set, under 3415's lock

*census-discovery §61.* `public.trail_proposal_peers`, which `public.trail_propose` (3415) reads after taking its per-title-token advisory locks, and which is the same filter `TrailService.proposeTrail`'s pre-check sends through PostgREST: `destination = $1 OR destination IS NULL OR slug ILIKE ANY ($patterns)`. **Index:** none is usable, and none is added. The `ILIKE '%tok%'` legs cannot use a b-tree, so the read is a sequential scan of `trails` at any size. Harness, 2,000 Trails: Seq Scan, 2,000 rows removed by filter. **Cardinality:** production holds 0 Trails. The read runs inside the serialised window, so its duration is also how long a colliding proposal waits. If the catalogue grows past a few tens of thousands of Trails, a trigram index on `slug` is the index this path would want. It is not added here, because nothing measured needs it.

### QP-27 The `trail_relations` rebuild

*census-discovery §61.* `public.rebuild_trail_relations` (3416): one `INSERT … SELECT` over `trail_edges`, `trails.parent_trail_id` and a self-join of `content_trails` on (source_type, source_id). **Not a hot path:** nothing calls it and nothing reads its output. **Index:** the parent-pointer branch uses `idx_trails_parent` and an anti-join on `trail_edges_pkey`. The common-content branch groups `content_trails` and merge-joins it with itself: no index serves a whole-table self-join, and none is wanted. Harness, 2,000 Trails, 2,000 edges and 30,000 memberships (10,000 contents held by two Trails): Append of a Seq Scan (2,000 declared edges), a Nested Loop Anti Join (0 pointers without an edge) and a HashAggregate over a Merge Join (9,990 shared pairs → 1,991 relations). 3,991 rows in all. `idx_trail_relations_to` (3416) serves "relations into a Trail", for a reader that does not exist yet. The primary key serves "relations out of a Trail".

## 3. Findings this document does not fix

- **Duplicate indexes in the baseline**, which no migration in this tree creates, so §4 does not register them. The 2026-08-19 baseline carries `discovery_cache_expires_idx` and `idx_discovery_cache_expires_at` (the same column), `discovery_geocode_cache_expires_idx` and `idx_discovery_geocode_cache_expires_at`, `discovery_places_type_idx` and `discovery_places_place_type_idx`, and `discovery_places_osm_id_idx` (unique) beside `idx_discovery_places_osm_id`. Each pair doubles the write cost for no read. Dropping an index in production is an operator decision, and this lane made none.
- **`discovery_place_saves`** exists only in the baseline, with `discovery_place_saves_pkey (user_id, place_id)` and `discovery_place_saves_user_idx (user_id)`. The second is a prefix of the first.
- **QP-03, QP-04 and QP-12 have no usable index**, which is correct at 184 rows. The spec's "unapplied geo indexes can leave production on sequential scans" is the same class of fact: the plan is right for today's corpus and wrong for a large one.
- **Two indexes duplicated by a constraint (§62).** Both come from migrations in this tree, and both were invisible to the check until §62.
  - `place_momentum_place_run_key` is `UNIQUE (place_id, computed_at)`, and `place_momentum_place_computed_idx` is `(place_id, computed_at DESC)`: the same two columns. A btree scans either way. With the plain index dropped inside the script's transaction, QP-22 is an `Index Scan Backward using place_momentum_place_run_key`, 1 row (QP-22-without-place_momentum_place_computed_idx). Every row a rebuild writes maintains both. 2892 is applied to no production database, so this costs nothing yet.
  - `discovery_place_reports_unique` is `UNIQUE (place_id, reporter_id)`, and `discovery_place_reports_place_idx` is `(place_id)`, its leading column. The planner chose the single-column index for the by-place count. Either index serves that read.
  - Dropping either index is a schema decision for the owner of that table's migration, and §62 made none.

## 4. Index and table registry (checked by `check:discovery-query-paths`)

One row per table or index that a migration in `artifacts/api-server/src/migrations/` creates on a Discovery table. Columns: kind, name, table, the migration(s) that create it, the query path it serves (or "not a hot path" with the reason), and the rationale.

**What counts as an index (§62).** A `CREATE [UNIQUE] INDEX` counts. So does the index a UNIQUE or EXCLUDE constraint builds, inline or added later: it costs the same on every write and the planner can choose it the same way. **A PRIMARY KEY has no row of its own. This is a reading of `10` §4, stated here so it can be contested.** `10` §4 asks each *query path* for an "index rationale". A primary key is not chosen to serve a path. It is the table's row identity, a table has exactly one, and its rationale is the table's own, which the table's row already carries. Where a path uses a primary key, the path's section names it (QP-01, QP-02, QP-06, QP-15). A UNIQUE constraint is an optional design choice with a write cost, so it needs its own reason. The same reading covers `idx_discovery_cache_dest_cat`, which only the baseline creates: no migration makes it, so the check cannot key it, and like §3's duplicates it is recorded rather than registered.

**Harness evidence for the three §62 rows** (`query-paths-explain.sql`, the `§62` block, at the §1 cardinality). None of the three is read on a hot path. Each is an insert-time arbiter. So the meaningful plan is the arbiter itself (`EXPLAIN` of the `INSERT … ON CONFLICT`, without `ANALYZE`, because `ANALYZE` would write), plus the reads that could use the index but do not:

| constraint-backed index | what the harness shows |
|---|---|
| `trails_slug_unique` | A slug-equality probe is an `Index Scan using trails_slug_unique`, 1 row of 2,000. `proposeTrail`'s peer read (`destination = x OR destination IS NULL OR slug ILIKE %x%`) is a `Seq Scan` that keeps 30 rows and removes 1,970. A btree cannot serve a leading-wildcard `ILIKE`, so the constraint gives that read nothing. |
| `place_momentum_place_run_key` | `Conflict Arbiter Indexes: place_momentum_place_run_key` on the rebuild's `ON CONFLICT (place_id, computed_at) DO UPDATE`. QP-22 uses `place_momentum_place_computed_idx` while that index exists, and this one when it does not (§3). |
| `discovery_place_reports_unique` | `Conflict Arbiter Indexes: discovery_place_reports_unique` on `ON CONFLICT (place_id, reporter_id) DO NOTHING`. The by-place count (`routes/admin.ts`) is an `Index Only Scan using discovery_place_reports_place_idx` (§3). |

| kind | name | table | migration | path | rationale |
|---|---|---|---|---|---|
| table | `discovery_places` | `discovery_places` | 0029 | QP-03, QP-04, QP-05, QP-12 | the community / curated corpus: 184 rows in production |
| index | `discovery_places_city_idx` | `discovery_places` | 0029 | not a hot path: every city read is case-insensitive `ILIKE`, which a plain btree cannot serve (QP-03) | kept for exact-match callers; unused by the serve path |
| index | `discovery_places_type_idx` | `discovery_places` | 0029 | not a hot path: duplicated by the baseline's `discovery_places_place_type_idx` (§3) | place-type filter on `/community`, which applies after the city filter |
| index | `discovery_places_created_at_idx` | `discovery_places` | 0029 | QP-04 | newest-first `/community`; at 184 rows the planner sorts instead |
| index | `discovery_places_has_coords_idx` | `discovery_places` | 0060 | not a hot path: map-coordinate filter, no Discovery serve path reads it | partial on rows with coordinates |
| table | `discovery_place_reports` | `discovery_place_reports` | 0061 | not a hot path: written on report, read only by moderation | 0 rows in production |
| index | `discovery_place_reports_place_idx` | `discovery_place_reports` | 0061 | not a hot path: moderation by place | FK-side index on `place_id` (ON DELETE CASCADE from discovery_places) |
| index | `discovery_place_reports_reporter_idx` | `discovery_place_reports` | 0061 | not a hot path: the reporter's own-row policy and account erasure | FK-side index on `reporter_id` |
| index | `discovery_place_reports_unique` | `discovery_place_reports` | 0061 | not a hot path: the one-report-per-(place, reporter) arbiter, probed once per report insert; no writer in this tree, 0 rows in production | `CONSTRAINT … UNIQUE (place_id, reporter_id)`, 0061's "upsert on conflict"; harness: the conflict arbiter (§4 note, §62). Its leading column duplicates `discovery_place_reports_place_idx` (§3) |
| index | `discovery_places_primary_category_idx` | `discovery_places` | 0083 | not a hot path: the tab filter runs in TypeScript after QP-03 | category browse outside the serve path |
| index | `discovery_places_city_category_idx` | `discovery_places` | 0083 | not a hot path: exact-city equality only, and the serve path uses `ILIKE` | Compass / seed tooling reads |
| index | `discovery_places_osm_id_idx` | `discovery_places` | 0086 | QP-05 | uniqueness of an OSM place's row; the baseline adds a non-unique twin (§3) |
| index | `discovery_places_compass_city_idx` | `discovery_places` | 0105 | not a hot path: Compass candidate reads (Compass's paths, not Discovery's) | (city, category, status) |
| index | `discovery_places_compass_category_idx` | `discovery_places` | 0105 | not a hot path: Compass candidate reads | (category, status) |
| table | `rank_events` | `rank_events` | 0153 | QP-07, QP-08, QP-09, QP-10, QP-11, QP-19, QP-20, QP-24 | the behaviour store (`10` §3): 234,224 rows in production |
| index | `rank_events_features_gin` | `rank_events` | 0153 | not a hot path: no Discovery read filters on `features`, and every write pays for it (QP-24) | general jsonb containment for analytics |
| index | `rank_events_user_served_at` | `rank_events` | 0153 | QP-08 | a viewer's history by time |
| index | `rank_events_user_item` | `rank_events` | 0153 | QP-11 | a viewer's exposures of one item, newest first |
| table | `discovery_cache` | `discovery_cache` | 0168 | QP-01 | Cache A's L2: 76 rows in production |
| table | `discovery_geocode_cache` | `discovery_geocode_cache` | 0168 | QP-02 | 20 rows in production |
| index | `discovery_cache_expires_idx` | `discovery_cache` | 0168 | not a hot path: the expiry sweep (`lib/discoveryCacheCleanup.ts`) | range delete on `expires_at`; the baseline duplicates it (§3) |
| index | `discovery_geocode_cache_expires_idx` | `discovery_geocode_cache` | 0168 | not a hot path: the expiry sweep | range delete on `expires_at`; duplicated in the baseline (§3) |
| index | `rank_events_event_type` | `rank_events` | 0197 | not a hot path: analytics `event_type` rows, which Discovery neither writes nor reads | partial on `event_type IS NOT NULL` |
| index | `discovery_places_canonical_location_idx` | `discovery_places` | 2053 | not a hot path: the canonical-location bridge (`lib/placeIdBridge.ts`) | partial on linked rows |
| table | `discovery_shadow_serves` | `discovery_shadow_serves` | 2092 | QP-23 | one row per shadow observation; 0 in production (never in shadow) |
| index | `discovery_shadow_serves_key_observed_at` | `discovery_shadow_serves` | 2092 | not a hot path: per-request-key divergence drill-down in the report script | (destination, category, radius, time) |
| index | `discovery_shadow_serves_serve_point_observed_at` | `discovery_shadow_serves` | 2092 | QP-23 | the divergence report's window |
| index | `discovery_shadow_serves_user_id` | `discovery_shadow_serves` | 2092 | not a hot path: account erasure (ON DELETE CASCADE from auth.users) | FK-side index |
| table | `discovery_place_photos` | `discovery_place_photos` | 2095 | QP-06 | 15 rows in production |
| index | `discovery_place_photos_expires_at_idx` | `discovery_place_photos` | 2095 | not a hot path: the expired / invalid sweep | range scan on `expires_at` |
| index | `discovery_places_source_id` | `discovery_places` | 2121 | not a hot path: source-registry joins (`sources`) | FK-side index on `source_id` |
| index | `rank_events_recommendation_idempotency_idx` | `rank_events` | 2891 | QP-10 | the idempotency arbiter for (recommendation_id, outcome), and the binding lookup |
| table | `place_momentum` | `place_momentum` | 2892 | QP-22 | derived, rebuildable (DV-72); absent from production |
| index | `place_momentum_place_computed_idx` | `place_momentum` | 2892 | QP-22 | latest snapshot per place |
| index | `place_momentum_computed_idx` | `place_momentum` | 2892 | QP-22 | per-run reads and retention; the trend API's newest-run read (census-discovery §58) |
| index | `place_momentum_live_state_idx` | `place_momentum` | 2892 | not a hot path: "what is trending" listing; no reader yet | partial on classified rows |
| index | `place_momentum_place_run_key` | `place_momentum` | 2892 | not a hot path: `rebuild_place_momentum`'s `ON CONFLICT (place_id, computed_at)` arbiter, one probe per row a rebuild writes; QP-22 reads `place_momentum_place_computed_idx` | `CONSTRAINT … UNIQUE (place_id, computed_at)`: one reading per place per run, which makes a rebuild idempotent; harness: the conflict arbiter (§4 note, §62). Same two columns as `place_momentum_place_computed_idx` (§3) |
| table | `trails` | `trails` | 2910 | QP-13 | 0 Trails in production |
| table | `content_trails` | `content_trails` | 2910 | QP-14 | Trail membership |
| table | `trail_edges` | `trail_edges` | 2910 | QP-15 | declared Trail relations |
| table | `trail_health_snapshots` | `trail_health_snapshots` | 2910 | QP-17 | at most one row per Trail per hour |
| table | `trail_follows` | `trail_follows` | 2910 | QP-18 | a viewer's follows |
| table | `trail_reports` | `trail_reports` | 2910 | QP-16 | moderation input to Trail health |
| index | `idx_trails_destination_lifecycle` | `trails` | 2910 | QP-13 | Trails for a destination, by lifecycle |
| index | `idx_trails_parent` | `trails` | 2910 | not a hot path: parent walk on a merge or split | partial on `parent_trail_id IS NOT NULL` |
| index | `trails_slug_unique` | `trails` | 2910 | not a hot path: the uniqueness arbiter probed once per Trail proposal insert (a 23505 is a concurrent duplicate); no read filters `slug` by equality, and the proposal's peer read is `slug ILIKE %token%`, which a btree cannot serve | `CONSTRAINT … UNIQUE (slug)`: `02` §18's canonical handle: one slug is one Trail. Whether two spellings of a theme reach the same slug is the canonicaliser's job (DV-20), not this index's; harness: an equality probe is an Index Scan on it, the peer read a Seq Scan (§4 note, §62) |
| index | `uq_content_trails_label` | `content_trails` | 2910 | not a hot path: a uniqueness constraint (one label per member), probed on insert | enforces `02` §4's one label per (trail, source, relationship, signal) |
| index | `idx_content_trails_trail` | `content_trails` | 2910 | QP-14 | members of a Trail, newest first |
| index | `idx_content_trails_source` | `content_trails` | 2910 | not a hot path: "which Trails is this place in" and the label-cap trigger | (source_type, source_id) |
| index | `uq_content_trails_one_primary` | `content_trails` | 3380 | not a hot path: a partial uniqueness constraint (at most one `primary` label per source), probed on insert under 3380's serialised label-cap trigger | enforces `02` §4's one primary Trail per piece of content under concurrency (census-discovery §51.3); added to this registry by the integrator at the P9 merge (§54 addendum), because P9 was cut before 3380 existed |
| index | `idx_trail_edges_to` | `trail_edges` | 2910 | QP-15 | in-edges; out-edges use the primary key |
| index | `idx_trail_health_recent` | `trail_health_snapshots` | 2910 | QP-17 | the hourly guard and the latest snapshot |
| index | `idx_trail_follows_user` | `trail_follows` | 2910 | QP-18 | a viewer's follows |
| index | `idx_trail_reports_open` | `trail_reports` | 2910 | QP-16 | open reports per Trail |
| index | `rank_events_discovery_dismissed` | `rank_events` | 2995 | QP-07, QP-20 | a viewer's Discovery dismisses (partial) |
| table | `recommendations` | `recommendations` | 3376 | QP-21 | one row per served request; absent from production |
| index | `recommendations_user_served_at` | `recommendations` | 3376 | not a hot path: account erasure and per-viewer audits | partial on signed-in rows |
| index | `recommendations_served_at` | `recommendations` | 3376 | QP-21 | the per-window denominator |
| index | `rank_events_discovery_served_at` | `rank_events` | 3391 | QP-19, QP-09 | Discovery exposures in a window, without scanning other surfaces |
| table | `rank_event_outcome_receipts` | `rank_event_outcome_receipts` | 3420 | QP-25 | one row per keyed outcome that landed. Its primary key `(user_id, client_event_id)` is the only index: the idempotency arbiter, the lookup, and account erasure's cascade (§62) |
| table | `trail_relations` | `trail_relations` | 3416 | not a hot path: a derived projection (`10` §3) that nothing reads and only `rebuild_trail_relations` writes (QP-27) | the Trail Graph of `05` §2 over declared relations and common content. 0 rows in production (3416 unapplied; 0 Trails). Rebuildable by construction (census-discovery §61, DV-72) |
| index | `idx_trail_relations_to` | `trail_relations` | 3416 | not a hot path: "relations into a Trail", for a reader that does not exist yet (QP-27) | (to_trail_id, relation). Out-relations use the primary key (from_trail_id, to_trail_id, relation) |

## 5. What would turn this red

- A migration that creates a Discovery table or index with no row in §4: `check:discovery-query-paths` fails.
- A plan here that production contradicts. Running `docs/discovery/query-paths-explain.sql` shows only the harness. The production check is an `EXPLAIN` (no `ANALYZE`) of QP-03, QP-07, QP-08, QP-11 and QP-19 by an operator with read access, with the result recorded here beside the harness plan.
