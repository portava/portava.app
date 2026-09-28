-- query-paths-explain.sql — the harness run behind docs/discovery/query-paths.md
-- (census-discovery DC-15, §54).
--
-- WHAT IT IS: synthetic rows at the cardinality stated below, ANALYZE, and one
-- EXPLAIN per Discovery hot path, all inside ONE transaction that is ROLLED
-- BACK. Run it against the local PostgreSQL 16 harness ONLY:
--
--   psql -X -q -v ON_ERROR_STOP=1 "$LOCAL_DB_URL" -f docs/discovery/query-paths-explain.sql
--
-- NEVER against portava-ci or production: it inserts 400k+ rows (then rolls
-- them back) and its plans describe THIS synthetic distribution, not theirs.
--
-- SYNTHETIC CARDINALITY (production, read 2026-09-07, in brackets — census §5):
--   profiles / auth.users        2,000   [58 active]
--   discovery_places            20,000   [184]      100 cities × 200, 90 % active, half with an osm_id
--   discovery_place_saves       20,000   [0]
--   discovery_place_reports      1,000   [0]
--   discovery_cache              5,000   [76]
--   discovery_geocode_cache      2,000   [20]
--   discovery_place_photos      20,000   [15]
--   discovery_shadow_serves     10,000   [0]
--   rank_events                250,000   [234,224; 13 with surface='discovery']
--     of which surface='discovery'  50,000, dismiss 2,000
--   recommendations             20,000   [absent: 3376 unapplied]
--   place_momentum              20,000   [absent: 2892 unapplied]
--   rank_event_outcome_receipts 20,000   [absent: 3420 unapplied] (§62)
--   trails / content_trails / trail_edges / trail_follows / trail_reports / trail_health_snapshots
--                          2,000 / 50,000 / 4,000 / 10,000 / 500 / 20,000   [trails 0]
BEGIN;
SET LOCAL client_min_messages = warning;

INSERT INTO auth.users (id, email)
SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'qp' || g || '@local.test'
  FROM generate_series(1, 2000) g;
INSERT INTO public.profiles (id, handle, name)
SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'qp_' || g, 'qp ' || g
  FROM generate_series(1, 2000) g;

INSERT INTO public.discovery_places (id, city, name, place_type, category, primary_category, submitted_by, saved_count, status, source, osm_id, created_at, lat, lng)
SELECT ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
       'City ' || (g % 100), 'Place ' || g, (ARRAY['restaurant','bar','cafe','museum','park'])[1 + g % 5],
       (ARRAY['food','nightlife','cafe','culture','outdoors'])[1 + g % 5], (ARRAY['food','nightlife','cafe','culture','outdoors'])[1 + g % 5],
       ('00000000-0000-4000-8000-' || lpad((1 + g % 2000)::text, 12, '0'))::uuid,
       g % 50, CASE WHEN g % 10 = 0 THEN 'pending' ELSE 'active' END,
       (ARRAY[NULL,'curated','osm','traveler'])[1 + g % 4], CASE WHEN g % 2 = 0 THEN 'node/' || g END,
       now() - make_interval(hours => g % 5000), 10 + (g % 100) * 0.01, 20 + (g % 100) * 0.01
  FROM generate_series(1, 20000) g;
INSERT INTO public.discovery_place_saves (user_id, place_id)
SELECT ('00000000-0000-4000-8000-' || lpad((1 + g % 2000)::text, 12, '0'))::uuid,
       ('10000000-0000-4000-8000-' || lpad((1 + (g * 7) % 20000)::text, 12, '0'))::uuid
  FROM generate_series(1, 20000) g ON CONFLICT DO NOTHING;
INSERT INTO public.discovery_place_reports (place_id, reporter_id, reason)
SELECT ('10000000-0000-4000-8000-' || lpad((1 + g * 13 % 20000)::text, 12, '0'))::uuid,
       ('00000000-0000-4000-8000-' || lpad((1 + g % 2000)::text, 12, '0'))::uuid, 'qp'
  FROM generate_series(1, 1000) g ON CONFLICT DO NOTHING;
INSERT INTO public.discovery_cache (cache_key, destination, category, radius_km, places, expires_at)
SELECT 'qp:' || g, 'City ' || (g % 100), 'for_you', 5, '[]'::jsonb, now() + interval '2 hours' FROM generate_series(1, 5000) g;
INSERT INTO public.discovery_geocode_cache (location_key, lat, lng, display_name, expires_at)
SELECT 'qp:' || g, 1, 1, 'x', now() + interval '30 days' FROM generate_series(1, 2000) g;
INSERT INTO public.discovery_place_photos (place_key, source, photo_url, expires_at)
SELECT 'osm:node/' || g, 'foursquare', 'https://x/' || g, now() + interval '7 days' FROM generate_series(1, 20000) g;
INSERT INTO public.discovery_shadow_serves (user_id, destination, category, radius_km, page, page_size, serve_point, legacy_total, pde_total, overlap_count, displaced_count, top_changed, engine_mode, mode_reason, observed_at)
SELECT ('00000000-0000-4000-8000-' || lpad((1 + g % 2000)::text, 12, '0'))::uuid, 'City ' || (g % 100), 'for_you', 5, 0, 20, 1 + g % 3, 20, 20, 15, 5, g % 2 = 0, 'shadow', 'resolved', now() - make_interval(mins => g)
  FROM generate_series(1, 10000) g;

INSERT INTO public.rank_events (user_id, item_id, item_kind, surface, outcome, served_at, outcome_at, features)
SELECT ('00000000-0000-4000-8000-' || lpad((1 + g % 2000)::text, 12, '0'))::uuid,
       CASE WHEN g % 5 = 0 THEN 'db/10000000-0000-4000-8000-' || lpad((1 + g % 20000)::text, 12, '0') ELSE 'node/' || (g % 40000) END,
       'place',
       CASE WHEN g % 5 = 0 THEN 'discovery' ELSE (ARRAY['pulse','wall','watch_feed','living_page'])[1 + g % 4] END,
       CASE WHEN g % 5 = 0 AND g % 125 = 0 THEN 'dismiss' WHEN g % 17 = 0 THEN 'tap' ELSE 'impression' END,
       now() - make_interval(secs => g * 20),
       CASE WHEN (g % 5 = 0 AND g % 125 = 0) OR g % 17 = 0 THEN now() - make_interval(secs => g * 20 - 5) END,
       jsonb_build_object('servePoint', 1 + g % 6)
  FROM generate_series(1, 250000) g;
INSERT INTO public.recommendations (id, user_id, viewer_class, session_id, surface, serve_point, model_version, served_count, item_ids, item_kinds, served_at)
SELECT 'qp' || lpad(g::text, 20, '0'), CASE WHEN g % 2 = 0 THEN ('00000000-0000-4000-8000-' || lpad((1 + g % 2000)::text, 12, '0'))::uuid END,
       CASE WHEN g % 2 = 0 THEN 'signed_in' ELSE 'anonymous' END, gen_random_uuid(), 'discovery', 1, 'm', 1, ARRAY['node/1'], ARRAY['place'], now() - make_interval(secs => g * 30)
  FROM generate_series(1, 20000) g;
INSERT INTO public.place_momentum (place_id, computed_at, recent_rate, mid_rate, prior_rate, total_weight, trend_state, model_version, event_weights, window_ms, thresholds)
SELECT 'node/' || (g % 5000), now() - make_interval(hours => g / 5000), 1, 1, 1, 3, (ARRAY['unknown','emerging','trending','established'])[1 + g % 4], 'm', '{}', '{}', '{}'
  FROM generate_series(1, 20000) g;

-- §62 (3420): one receipt per keyed outcome, 10 per viewer.
INSERT INTO public.rank_event_outcome_receipts (user_id, client_event_id, rank_event_id, item_id, surface, outcome)
SELECT ('00000000-0000-4000-8000-' || lpad((1 + g % 2000)::text, 12, '0'))::uuid, md5('qp' || g)::uuid, gen_random_uuid(),
       'node/' || g, 'discovery', (ARRAY['tap','save','dismiss'])[1 + g % 3]
  FROM generate_series(1, 20000) g;

INSERT INTO public.trails (id, slug, title, destination, lifecycle_status)
SELECT ('20000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'qp-' || g, 'Trail ' || g, 'City ' || (g % 100),
       (ARRAY['proposed','active','active','active','stale','archived'])[1 + g % 6]
  FROM generate_series(1, 2000) g;
-- census-discovery §61: since 3380 the label-cap trigger takes one advisory lock
-- per content and holds it to COMMIT, so this one-transaction seed of 20,000
-- contents ran out of lock slots ("out of shared memory") and aborted the whole
-- script. The seed skips the triggers (harness only; the rows respect the caps).
SET LOCAL session_replication_role = replica;
INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship, contributor_id, created_at)
SELECT ('20000000-0000-4000-8000-' || lpad((1 + g % 2000)::text, 12, '0'))::uuid, 'place',
       ('10000000-0000-4000-8000-' || lpad((1 + g % 20000)::text, 12, '0'))::uuid, 'supporting',
       ('00000000-0000-4000-8000-' || lpad((1 + g % 2000)::text, 12, '0'))::uuid, now() - make_interval(hours => g)
  FROM generate_series(1, 50000) g ON CONFLICT DO NOTHING;
SET LOCAL session_replication_role = origin;
INSERT INTO public.trail_edges (from_trail_id, to_trail_id, edge_type)
SELECT ('20000000-0000-4000-8000-' || lpad((1 + g % 2000)::text, 12, '0'))::uuid,
       ('20000000-0000-4000-8000-' || lpad((1 + (g * 31 + 1) % 2000)::text, 12, '0'))::uuid, 'related'
  FROM generate_series(1, 4000) g WHERE (1 + g % 2000) <> (1 + (g * 31 + 1) % 2000) ON CONFLICT DO NOTHING;
INSERT INTO public.trail_follows (trail_id, user_id)
SELECT ('20000000-0000-4000-8000-' || lpad((1 + g % 2000)::text, 12, '0'))::uuid,
       ('00000000-0000-4000-8000-' || lpad((1 + (g * 3) % 2000)::text, 12, '0'))::uuid
  FROM generate_series(1, 10000) g ON CONFLICT DO NOTHING;
INSERT INTO public.trail_reports (trail_id, reason, resolution)
SELECT ('20000000-0000-4000-8000-' || lpad((1 + g % 2000)::text, 12, '0'))::uuid, 'stale', CASE WHEN g % 2 = 0 THEN 'dismissed' END
  FROM generate_series(1, 500) g;
INSERT INTO public.trail_health_snapshots (trail_id, metrics, model_version, captured_at)
SELECT ('20000000-0000-4000-8000-' || lpad((1 + g % 2000)::text, 12, '0'))::uuid, '{}'::jsonb, 'trail-health-v1', now() - make_interval(hours => g / 2000)
  FROM generate_series(1, 20000) g;

ANALYZE auth.users, public.profiles, public.discovery_places, public.discovery_place_saves, public.discovery_place_reports,
        public.discovery_cache, public.discovery_geocode_cache, public.discovery_place_photos, public.discovery_shadow_serves,
        public.rank_events, public.recommendations, public.place_momentum, public.rank_event_outcome_receipts, public.trails, public.content_trails,
        public.trail_edges, public.trail_follows, public.trail_reports, public.trail_health_snapshots;

\pset pager off
\echo '### QP-01 cache A L2 read (lib/discoveryPersistentCache.ts)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT places, cached_at, expires_at, geocode_lat, geocode_lng, geocode_display FROM public.discovery_cache WHERE cache_key = 'qp:4242';
\echo '### QP-02 geocode cache read'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT lat, lng, display_name, expires_at FROM public.discovery_geocode_cache WHERE location_key = 'qp:77';
\echo '### QP-03 curated community rows for a city (routes/discovery.ts loadCuratedAndCanonicalPlaces)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT id, city, name, place_type, category, primary_category, secondary_categories, saved_count, submitted_by
  FROM public.discovery_places
 WHERE (city ILIKE 'City 42' OR city ILIKE 'City 42%') AND status = 'active'
   AND (source IS NULL OR source NOT IN ('seed_script','demo','qa_fixture'))
 ORDER BY saved_count DESC LIMIT 200;
\echo '### QP-04 GET /discovery/community (newest)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT id, city, name FROM public.discovery_places
 WHERE city ILIKE 'City 42' AND status = 'active' ORDER BY created_at DESC NULLS LAST LIMIT 40;
\echo '### QP-05 saved counts for served OSM ids'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT id, osm_id, saved_count FROM public.discovery_places WHERE osm_id IN ('node/2','node/4','node/6','node/8','node/10');
\echo '### QP-06 resolved photo for a card (lib/discoveryPlacePhotoStore.ts)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT source, photo_url, photo_ref, expires_at, invalid_at FROM public.discovery_place_photos WHERE place_key = 'osm:node/9001';
\echo '### QP-07 the viewer''s "Not interested" set (lib/discoveryDismissed.ts)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT item_id FROM public.rank_events
 WHERE user_id = '00000000-0000-4000-8000-000000000126' AND surface = 'discovery' AND outcome = 'dismiss'
 ORDER BY served_at DESC LIMIT 500;
\echo '### QP-08 the viewer''s recently-seen set (lib/discoveryPde.ts seen penalty)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT item_id FROM public.rank_events
 WHERE user_id = '00000000-0000-4000-8000-000000000126' AND surface = 'discovery' AND outcome <> 'analytics'
   AND served_at >= now() - interval '24 hours'
 ORDER BY served_at DESC LIMIT 500;
\echo '### QP-09 local momentum over candidate ids (lib/discoveryLocalMomentum.ts)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT item_id, outcome, served_at, outcome_at FROM public.rank_events
 WHERE surface = 'discovery' AND outcome <> 'analytics'
   AND item_id IN ('db/10000000-0000-4000-8000-000000000005','db/10000000-0000-4000-8000-000000000010','db/10000000-0000-4000-8000-000000000015')
   AND served_at >= now() - interval '7 days'
 ORDER BY served_at DESC, id DESC LIMIT 1000;
\echo '### QP-10 outcome bound to its exposure by recommendation id (routes/rankEvents.ts)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT id FROM public.rank_events WHERE recommendation_id = 'AAAAAAAAAAAAAAAAAAAAAA' AND outcome = 'impression';
\echo '### QP-11 latest exposure for (viewer, item, surface) (routes/rankEvents.ts fallback)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT id, position, served_at, session_id, features FROM public.rank_events
 WHERE user_id = '00000000-0000-4000-8000-000000000126' AND item_id = 'db/10000000-0000-4000-8000-000000000126' AND surface = 'discovery'
 ORDER BY served_at DESC LIMIT 1;
\echo '### QP-12 search: places by free text (routes/discoverySearch.ts)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT id, name, city FROM public.discovery_places
 WHERE (name ILIKE '%lace 12%' OR city ILIKE '%lace 12%' OR blurb ILIKE '%lace 12%') AND status = 'active'
 ORDER BY saved_count DESC LIMIT 20;
\echo '### QP-13 Trails for a destination (services/trails/TrailService.ts)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT id, slug, title FROM public.trails WHERE destination = 'City 42' AND lifecycle_status = 'active';
\echo '### QP-14 a Trail''s members, newest 500'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT source_id, contributor_id, confidence, content_state, created_at FROM public.content_trails
 WHERE trail_id = '20000000-0000-4000-8000-000000000042' ORDER BY created_at DESC LIMIT 500;
\echo '### QP-15 a Trail''s edges, both directions'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT from_trail_id, to_trail_id, edge_type, strength FROM public.trail_edges WHERE from_trail_id = '20000000-0000-4000-8000-000000000042';
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT from_trail_id, to_trail_id, edge_type, strength FROM public.trail_edges WHERE to_trail_id = '20000000-0000-4000-8000-000000000042';
\echo '### QP-16 a Trail''s open reports'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT id FROM public.trail_reports WHERE trail_id = '20000000-0000-4000-8000-000000000042' AND resolution IS NULL;
\echo '### QP-17 the hourly health-snapshot guard'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT id FROM public.trail_health_snapshots WHERE trail_id = '20000000-0000-4000-8000-000000000042' AND captured_at > now() - interval '1 hour' LIMIT 1;
\echo '### QP-18 a viewer''s followed Trails'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT trail_id FROM public.trail_follows WHERE user_id = '00000000-0000-4000-8000-000000000126';
\echo '### QP-19 stop measurement: Discovery exposures in the window (3391)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT count(*) FROM public.rank_events
 WHERE surface = 'discovery' AND served_at >= now() - interval '10 minutes' AND served_at < now() AND outcome <> 'analytics';
\echo '### QP-20 stop measurement: dismisses in the window (3391)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT count(*) FROM public.rank_events
 WHERE surface = 'discovery' AND outcome = 'dismiss' AND outcome_at >= now() - interval '10 minutes' AND outcome_at < now();
\echo '### QP-21 per-request serve record window (3376 recommendations_served_at)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT serve_point, count(*) FROM public.recommendations WHERE served_at >= now() - interval '1 hour' GROUP BY serve_point;
\echo '### QP-22 latest momentum for a place (2892)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT trend_state, recent_rate FROM public.place_momentum WHERE place_id = 'node/42' ORDER BY computed_at DESC LIMIT 1;
\echo '### QP-23 shadow divergence report window (lib/discoveryDivergenceReport.ts)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT count(*) FROM public.discovery_shadow_serves WHERE serve_point = 1 AND observed_at >= now() - interval '1 day';
-- census-discovery §61 (QP-27): a Signal on 10,000 of the seeded contents in a
-- second Trail, so content is SHARED between Trails. Seeded here, after QP-01..23
-- ran, so their plans are over the same rows as before; triggers skipped as above.
SET LOCAL session_replication_role = replica;
INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship, signal, created_at)
SELECT ('20000000-0000-4000-8000-' || lpad((1 + (g * 7) % 2000)::text, 12, '0'))::uuid, 'place',
       ('10000000-0000-4000-8000-' || lpad((1 + g % 20000)::text, 12, '0'))::uuid, 'signal', 'food', now() - make_interval(hours => g)
  FROM generate_series(1, 10000) g ON CONFLICT DO NOTHING;
SET LOCAL session_replication_role = origin;
ANALYZE public.content_trails;
\echo '### QP-26 the proposal comparison set, as trail_propose reads it under its per-token lock (3415, census-discovery §61)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT id, slug, title, destination FROM public.trails
 WHERE destination = 'city 42' OR destination IS NULL OR slug ILIKE ANY (ARRAY['%riverside%']);
\echo '### QP-27 the trail_relations rebuild (3416, census-discovery §61), as the one SELECT it inserts'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT e.from_trail_id, e.to_trail_id, e.edge_type, NULL::integer FROM public.trail_edges AS e
UNION ALL
SELECT t.parent_trail_id, t.id, 'child', NULL::integer FROM public.trails AS t
 WHERE t.parent_trail_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.trail_edges AS e
                    WHERE e.from_trail_id = t.parent_trail_id AND e.to_trail_id = t.id AND e.edge_type = 'child')
UNION ALL
SELECT s.a, s.b, 'common_content', count(*)::integer
  FROM (SELECT x.trail_id AS a, y.trail_id AS b
          FROM (SELECT trail_id, source_type, source_id FROM public.content_trails GROUP BY 1, 2, 3) AS x
          JOIN (SELECT trail_id, source_type, source_id FROM public.content_trails GROUP BY 1, 2, 3) AS y
            ON y.source_type = x.source_type AND y.source_id = x.source_id AND x.trail_id < y.trail_id) AS s
 GROUP BY s.a, s.b;

\echo '### QP-25 a keyed outcome''s receipt, by (viewer, client_event_id) (routes/rankEvents.ts, 3420, §62)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT rank_event_id, item_id, surface, outcome FROM public.rank_event_outcome_receipts
 WHERE user_id = '00000000-0000-4000-8000-000000000126' AND client_event_id = md5('qp125')::uuid;

-- census-discovery §62 (DC-15): the three constraint-backed unique indexes the
-- check could not see. None is a hot read; each is an insert-time arbiter, so the
-- meaningful plans are the arbiter (EXPLAIN of the INSERT … ON CONFLICT, not
-- ANALYZE: it would write) and the reads that could, but do not, use them.
\echo '### §62 trails_slug_unique: the slug-equality probe a proposal INSERT makes'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT id FROM public.trails WHERE slug = 'qp-42';
\echo '### §62 trails_slug_unique: the proposal peer read (TrailService proposeTrail), which it cannot serve'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT id, slug, title, destination FROM public.trails
 WHERE destination = 'City 42' OR destination IS NULL OR slug ILIKE '%qp-42%' LIMIT 500;
\echo '### §62 place_momentum_place_run_key: the rebuild''s conflict arbiter (2892 rebuild_place_momentum)'
EXPLAIN (COSTS OFF)
INSERT INTO public.place_momentum (place_id, computed_at, recent_rate, mid_rate, prior_rate, total_weight, trend_state, model_version, event_weights, window_ms, thresholds)
VALUES ('node/42', now(), 1, 1, 1, 3, 'unknown', 'm', '{}', '{}', '{}')
ON CONFLICT (place_id, computed_at) DO UPDATE SET recent_rate = EXCLUDED.recent_rate;
\echo '### §62 discovery_place_reports_unique: the one-report-per-(place, reporter) arbiter (0061)'
EXPLAIN (COSTS OFF)
INSERT INTO public.discovery_place_reports (place_id, reporter_id, reason)
VALUES ('10000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000002', 'qp')
ON CONFLICT (place_id, reporter_id) DO NOTHING;
\echo '### §62 discovery_place_reports by place (routes/admin.ts most-reported count)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT count(*) FROM public.discovery_place_reports WHERE place_id = '10000000-0000-4000-8000-000000000013';

-- The same two window paths WITHOUT 3391's partial index, to show what it buys.
DROP INDEX IF EXISTS public.rank_events_discovery_served_at;
\echo '### QP-19-before-3391 Discovery exposures in the window, no partial index'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT count(*) FROM public.rank_events
 WHERE surface = 'discovery' AND served_at >= now() - interval '10 minutes' AND served_at < now() AND outcome <> 'analytics';
\echo '### QP-09-before-3391 local momentum, no partial index'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT item_id, outcome, served_at, outcome_at FROM public.rank_events
 WHERE surface = 'discovery' AND outcome <> 'analytics'
   AND item_id IN ('db/10000000-0000-4000-8000-000000000005','db/10000000-0000-4000-8000-000000000010','db/10000000-0000-4000-8000-000000000015')
   AND served_at >= now() - interval '7 days'
 ORDER BY served_at DESC, id DESC LIMIT 1000;

-- §62: QP-22 WITHOUT place_momentum_place_computed_idx, to show that the unique
-- constraint's index over the same two columns serves it on its own.
DROP INDEX IF EXISTS public.place_momentum_place_computed_idx;
\echo '### QP-22-without-place_momentum_place_computed_idx (§62)'
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT trend_state, recent_rate FROM public.place_momentum WHERE place_id = 'node/42' ORDER BY computed_at DESC LIMIT 1;

ROLLBACK;
