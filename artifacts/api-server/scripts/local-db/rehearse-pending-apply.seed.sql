-- rehearse-pending-apply.seed.sql — pre-existing DATA and FLAG VALUES for the
-- W10-D rehearsal of the portava-ci pending set (docs/ops/discovery-portava-ci-apply-plan.md).
--
-- Loaded into the harness AFTER the chain up to 3338 and 3350 (the state
-- portava-ci is in), and BEFORE the pending set is applied, so that the
-- rehearsal can prove the owner's condition "preserving existing data and flag
-- values": every row below must read the same after the apply as before it,
-- except the one column a migration is DOCUMENTED to recompute
-- (canonical_locations.search_key, 3440).
--
-- Controlled data only. It names no real person and is never loaded anywhere
-- but the throwaway harness.

BEGIN;

-- Flag values an apply must not change.
--   discovery_serve_log_enabled TRUE: production's value (snapshot 20260922);
--     3376's writer reads it, so it must survive the apply untouched.
--   media_find_busier_enabled FALSE with a non-seed description: 3351 seeds this
--     row with ON CONFLICT DO NOTHING, so a pre-existing row must keep its own
--     description and value.
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('discovery_serve_log_enabled', true, 'rehearsal: pre-existing TRUE row'),
  ('media_find_busier_enabled', false, 'rehearsal: pre-existing row, description must survive')
ON CONFLICT (flag) DO UPDATE SET enabled = EXCLUDED.enabled, description = EXCLUDED.description;

-- One viewer, for the rows that need an account.
INSERT INTO auth.users (id, email) VALUES
  ('0000000d-0010-4000-8000-000000000001', 'w10d-rehearsal@example.invalid')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles (id, handle, name) VALUES
  ('0000000d-0010-4000-8000-000000000001', 'w10d_rehearsal', 'W10-D rehearsal')
ON CONFLICT (id) DO NOTHING;

-- canonical_locations: 3440 rewrites search_key (and only search_key).
INSERT INTO public.canonical_locations (kind, name, normalized_name, display_name) VALUES
  ('city', 'Øresund',  'oresund',  'Øresund'),
  ('city', 'Ǿresund',  'resund',   'Ǿresund'),
  ('city', 'Đà Nẵng',  'da nang',  'Đà Nẵng'),
  ('city', 'Straße',   'strasse',  'Straße');

-- rank_events: 3375 validates every row (schema_version 1), 3420 adds a column,
-- 3391 builds a partial index over the discovery rows.
INSERT INTO public.rank_events (user_id, item_id, item_kind, surface, outcome)
VALUES
  ('0000000d-0010-4000-8000-000000000001', 'db/0000000d-0010-4000-8000-0000000000a1', 'place', 'discovery', 'impression'),
  ('0000000d-0010-4000-8000-000000000001', 'db/0000000d-0010-4000-8000-0000000000a2', 'place', 'discovery', 'dismiss'),
  ('0000000d-0010-4000-8000-000000000001', 'node/42', 'place', 'discovery', 'tap');

-- trails / content_trails: 3380 counts primaries, 3381 adds transition triggers,
-- 3415/3441 replace the slug functions. None of them may touch these rows.
INSERT INTO public.trails (id, slug, title, lifecycle_status) VALUES
  ('0000000d-0010-4000-8000-0000000000b1', 'oresund-cycling', 'Øresund cycling', 'active');
INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship) VALUES
  ('0000000d-0010-4000-8000-0000000000b1', 'post', '0000000d-0010-4000-8000-0000000000c1', 'primary');

-- ranking_debug_samples: 3421 drops NOT NULL on content_id; the existing row
-- keeps its value.
INSERT INTO public.ranking_debug_samples (content_type, content_id, final_score) VALUES
  ('post', '0000000d-0010-4000-8000-0000000000c1', 0.5);

COMMIT;
