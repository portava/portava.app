-- 3495_place_cooccurrence_trail_projection.sql
-- Discovery graph projections (census-discovery DV-72, §95; register
-- D-W11X3-1): `10_Database_Architecture.md` §3 "Graph projections …
-- place_cooccurrence … These are derived and rebuildable", built ONLY in the
-- form that needs no personal data: two places co-occur when a Trail holds
-- both. The itinerary / trip-sequence / transition form (`05` §2) is NOT built
-- here: it is a behavioural inference over people and waits on the owner
-- (W10D-C5, §61.12 Q2).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane W11-X3,
-- 3495-3499). NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of
-- writing. NOT applied to travel-buddy (ajrurzioarfkagpuxfnb). Rehearsed on the
-- local PostgreSQL 16 harness only (scripts/local-db/up.sh).
--
-- ── THE DEFINITION ──────────────────────────────────────────────────────────
-- Input: `content_trails` rows with source_type = 'place' whose Trail is not
-- archived. A membership is an EDITORIAL act (attach / accepted suggestion; a
-- stranger's pending suggestion lives in 3488's table, not here), so the pair
-- it implies describes the catalogue, not anyone's movement. No user id is
-- read, copied or joined.
--   (a, b)             two distinct place ids, a < b, each pair once
--   shared_trail_count the number of distinct non-archived Trails that hold both
--   basis              'shared_trail' — the ONLY basis this table admits; a
--                      people-derived basis needs a new migration and the
--                      owner's answer, and the CHECK refuses one silently added
-- A Trail holding more than c_max_trail_places (100) places contributes NO
-- pairs: a catalogue-sized Trail ("everything in Lisbon") says nothing about
-- which two places belong together, and its n² pairs would swamp every other
-- Trail's evidence (D-W11X3-1).
-- `05` §6's edge strength has no formula (§61.6), so none is computed: the
-- count and its time window are the frequency and recency ingredients, not a
-- score made of them.
-- Every row carries `10` §9's lineage: source window (oldest and newest
-- membership it rests on), feature version, model version, computed_at.
--
-- ── WHAT ────────────────────────────────────────────────────────────────────
--   public.place_cooccurrence                   the projection (service role only)
--   public.rebuild_place_cooccurrence(ts)       recompute it from content_trails,
--                                               atomically, idempotently
-- Read only by lib/discoveryPlaceCooccurrence.ts `readPlaceCooccurrence`, and
-- rebuilt only by its hourly tick, both behind
-- `discovery_place_cooccurrence_enabled` (3496, seeded FALSE). No ranker reads
-- it. A reader answers place ids; a serving surface must still apply its own
-- eligibility to each (the projection is a function of the rows, not of a
-- viewer).
--
-- ── `10` §4 — cardinality, index, EXPLAIN ───────────────────────────────────
-- Production: 0 Trails, so 0 rows. Harness figures: docs/discovery/query-paths.md
-- QP-28 (rebuild) and QP-29 (a place's neighbours). The primary key (place_a,
-- place_b) serves the "place is a" half of the neighbour read;
-- idx_place_cooccurrence_b serves the "place is b" half.
--
-- ── `10` §5 / §6 — RLS and SECURITY ─────────────────────────────────────────
-- RLS on; every operation DENIED to anon and authenticated by a RESTRICTIVE
-- policy (3390's / 3416's pattern); service_role holds SELECT, INSERT and
-- DELETE and nothing else (rows are replaced, never edited). The rebuild is
-- SECURITY INVOKER with a pinned search_path, executable by service_role only.
--
-- Rollback: db/rollback/2026-09-28-3495-place-cooccurrence-trail-projection-rollback.sql
-- (drops the table and the function; the projection is derived, so nothing is
-- lost that a rebuild cannot restore).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trails') IS NULL OR to_regclass('public.content_trails') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3495): the 2910 Trails tables are absent. Apply 2910_discovery_trails.sql first.';
  END IF;
  IF to_regclass('public.place_cooccurrence') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'place_cooccurrence' AND column_name = 'shared_trail_count') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3495): a public.place_cooccurrence of another shape exists; this file will not re-assert over it.';
  END IF;
END
$pre$;

CREATE TABLE IF NOT EXISTS public.place_cooccurrence (
  place_a              uuid        NOT NULL,
  place_b              uuid        NOT NULL,
  basis                text        NOT NULL,
  shared_trail_count   integer     NOT NULL,
  -- `10` §9 lineage.
  source_window_start  timestamptz NOT NULL,
  source_window_end    timestamptz NOT NULL,
  feature_version      text        NOT NULL,
  model_version        text        NOT NULL,
  computed_at          timestamptz NOT NULL,
  PRIMARY KEY (place_a, place_b),
  CONSTRAINT place_cooccurrence_basis_trail_only CHECK (basis = 'shared_trail'),
  CONSTRAINT place_cooccurrence_ordered CHECK (place_a < place_b),
  CONSTRAINT place_cooccurrence_count_positive CHECK (shared_trail_count >= 1),
  CONSTRAINT place_cooccurrence_window CHECK (source_window_start <= source_window_end)
);
COMMENT ON TABLE public.place_cooccurrence IS
  '10 §3 graph projection (census-discovery DV-72, §95, 3495): two places co-occur when a non-archived Trail holds both (content_trails, source_type place). Built from Trail membership ONLY — no personal data; the itinerary form waits on the owner (W10D-C5). Derived: rebuild_place_cooccurrence recomputes it. Read only behind discovery_place_cooccurrence_enabled (3496, FALSE).';
CREATE INDEX IF NOT EXISTS idx_place_cooccurrence_b ON public.place_cooccurrence (place_b, shared_trail_count DESC);

ALTER TABLE public.place_cooccurrence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.place_cooccurrence FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.place_cooccurrence FROM service_role;
GRANT SELECT, INSERT, DELETE ON public.place_cooccurrence TO service_role;

DO $policies$
DECLARE v_op text;
BEGIN
  FOREACH v_op IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.place_cooccurrence', format('place_cooccurrence_deny_%s_clients', lower(v_op)));
    EXECUTE format('CREATE POLICY %I ON public.place_cooccurrence AS RESTRICTIVE FOR %s TO anon, authenticated %s',
      format('place_cooccurrence_deny_%s_clients', lower(v_op)), v_op,
      CASE v_op WHEN 'INSERT' THEN 'WITH CHECK (false)'
                WHEN 'UPDATE' THEN 'USING (false) WITH CHECK (false)'
                ELSE 'USING (false)' END);
    EXECUTE format('COMMENT ON POLICY %I ON public.place_cooccurrence IS %L',
      format('place_cooccurrence_deny_%s_clients', lower(v_op)),
      format('3495 (census-discovery DV-72, 10 §5): %s is DENIED to anon and authenticated on place_cooccurrence, a derived projection read by the server only. Restrictive, so a later permissive policy or re-GRANT cannot reopen it silently.', v_op));
  END LOOP;
END
$policies$;

CREATE OR REPLACE FUNCTION public.rebuild_place_cooccurrence(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER          -- `10` §6: nothing here needs definer rights.
SET search_path = pg_catalog
AS $fn$
DECLARE
  c_feature          CONSTANT text    := 'trail-place-membership-v1';
  c_model            CONSTANT text    := 'place-cooccurrence-shared-trail-v1';
  c_max_trail_places CONSTANT integer := 100;
  n integer;
BEGIN
  -- One rebuild at a time; a second waits and then replaces the first's rows.
  PERFORM pg_advisory_xact_lock(hashtextextended('rebuild_place_cooccurrence', 0));

  DELETE FROM public.place_cooccurrence WHERE true;

  INSERT INTO public.place_cooccurrence (
    place_a, place_b, basis, shared_trail_count,
    source_window_start, source_window_end, feature_version, model_version, computed_at)
  SELECT x.place_id, y.place_id, 'shared_trail', count(*)::integer,
         min(least(x.first_at, y.first_at)), max(greatest(x.last_at, y.last_at)),
         c_feature, c_model, p_now
    FROM (
      -- One row per (Trail, place): several labels on one place are one membership.
      SELECT ct.trail_id, ct.source_id AS place_id, min(ct.created_at) AS first_at, max(ct.created_at) AS last_at
        FROM public.content_trails AS ct
        JOIN public.trails AS t ON t.id = ct.trail_id
       WHERE ct.source_type = 'place'
         AND t.lifecycle_status <> 'archived'
       GROUP BY ct.trail_id, ct.source_id
    ) AS x
    JOIN (
      SELECT ct.trail_id, ct.source_id AS place_id, min(ct.created_at) AS first_at, max(ct.created_at) AS last_at
        FROM public.content_trails AS ct
        JOIN public.trails AS t ON t.id = ct.trail_id
       WHERE ct.source_type = 'place'
         AND t.lifecycle_status <> 'archived'
       GROUP BY ct.trail_id, ct.source_id
    ) AS y
      ON y.trail_id = x.trail_id AND x.place_id < y.place_id
   WHERE x.trail_id IN (
           SELECT ct.trail_id FROM public.content_trails AS ct
            WHERE ct.source_type = 'place'
            GROUP BY ct.trail_id
           HAVING count(DISTINCT ct.source_id) <= c_max_trail_places)
   GROUP BY x.place_id, y.place_id;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;
REVOKE ALL ON FUNCTION public.rebuild_place_cooccurrence(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_place_cooccurrence(timestamptz) TO service_role;
COMMENT ON FUNCTION public.rebuild_place_cooccurrence(timestamptz) IS
  '3495 (census-discovery DV-72, §95): replaces every place_cooccurrence row with the pairs of places held by a common non-archived Trail (Trails holding more than 100 places contribute none), stamped computed_at = p_now. One statement, one snapshot; idempotent for a given p_now. SECURITY INVOKER, pinned search_path (10 §6). Called only by the hourly tick behind discovery_place_cooccurrence_enabled.';

-- ── Behavioural postcondition, inside the applying transaction ──────────────
-- Probe: Trail T1 holds places P, Q, R (Q under two labels); archived Trail T2
-- holds P and Q. Expect (P,Q,1), (P,R,1), (Q,R,1) — the archived Trail adds
-- nothing and two labels are one membership. Rebuild twice; the second equals
-- the first. The sentinel exception rolls the probes (and the rebuild) back.
DO $probe$
DECLARE
  t1 uuid := '00000000-0000-4000-8000-0000000034e0';
  t2 uuid := '00000000-0000-4000-8000-0000000034e1';
  p  uuid := '00000000-0000-4000-8000-0000000034f0';
  q  uuid := '00000000-0000-4000-8000-0000000034f1';
  r  uuid := '00000000-0000-4000-8000-0000000034f2';
  n1 int; n2 int; got text; want text;
BEGIN
  BEGIN
    INSERT INTO public.trails (id, slug, title, lifecycle_status) VALUES
      (t1, 'migration-3495-probe-a', 'probe a', 'active'),
      (t2, 'migration-3495-probe-b', 'probe b', 'archived');
    INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship, signal) VALUES
      (t1, 'place', p, 'primary', NULL),
      (t1, 'place', q, 'supporting', NULL),
      (t1, 'place', q, 'signal', 'food'),
      (t1, 'place', r, 'supporting', NULL),
      (t2, 'place', p, 'supporting', NULL),
      (t2, 'place', q, 'supporting', NULL);
    n1 := public.rebuild_place_cooccurrence('2026-09-28T00:00:00Z');
    SELECT string_agg(concat_ws('|', place_a, place_b, basis, shared_trail_count), ',' ORDER BY place_a, place_b)
      INTO got FROM public.place_cooccurrence WHERE place_a IN (p, q, r);
    want := concat_ws(',',
      concat_ws('|', p, q, 'shared_trail', 1),
      concat_ws('|', p, r, 'shared_trail', 1),
      concat_ws('|', q, r, 'shared_trail', 1));
    IF got IS DISTINCT FROM want THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3495): the projection of the probe is % (want %)', got, want;
    END IF;
    n2 := public.rebuild_place_cooccurrence('2026-09-28T00:00:00Z');
    IF n1 <> n2 THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3495): a second rebuild wrote % rows, the first %', n2, n1;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P3495', MESSAGE = '3495 probe rollback';
  EXCEPTION
    WHEN SQLSTATE 'P3495' THEN
      NULL;
  END;
END
$probe$;

COMMIT;

-- ── Postconditions (read-only: what persisted) ──────────────────────────────
DO $post$
DECLARE v_op text; v_role text;
BEGIN
  IF to_regclass('public.place_cooccurrence') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3495): public.place_cooccurrence is absent.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.place_cooccurrence'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3495): RLS is not enabled on place_cooccurrence.';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_op IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF has_table_privilege(v_role, 'public.place_cooccurrence', v_op) THEN
        RAISE EXCEPTION 'POSTCONDITION FAILED (3495): % holds % on place_cooccurrence.', v_role, v_op;
      END IF;
    END LOOP;
    IF has_function_privilege(v_role, 'public.rebuild_place_cooccurrence(timestamptz)', 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3495): % may execute rebuild_place_cooccurrence.', v_role;
    END IF;
  END LOOP;
  IF has_table_privilege('service_role', 'public.place_cooccurrence', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3495): service_role must not UPDATE place_cooccurrence (rows are replaced, never edited).';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.place_cooccurrence'::regclass AND NOT polpermissive) <> 4 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3495): expected four restrictive client-deny policies on place_cooccurrence.';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.rebuild_place_cooccurrence(timestamptz)'::regprocedure) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3495): rebuild_place_cooccurrence must be SECURITY INVOKER.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.trails WHERE slug LIKE 'migration-3495-probe-%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3495): a probe Trail persisted.';
  END IF;
END
$post$;
