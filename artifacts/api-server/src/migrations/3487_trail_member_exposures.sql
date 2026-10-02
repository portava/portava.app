-- 3487_trail_member_exposures.sql
-- A Trail's OWN module serves, counted per member per day, so §9's grant moves
-- §9's denominator (census-discovery §86, lane W10-T: DV-22; §51.7, §51.10 Q2).
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane W10-T owns
-- 3485-3494). APPLIED TO NO DATABASE by the lane that wrote it other than the
-- local PostgreSQL 16 harness (port 55457).
--   NOT applied to portava-ci (hwokxgbmezheskbzskfr).
--   NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- ── WHY A TABLE OF ITS OWN, AND NOT rank_events ─────────────────────────────
-- §51.7 found that writing Trail-module serves to `rank_events` under the only
-- admitted surface (`discovery`) would move GET /discovery's place momentum and
-- make `trending_now` self-reinforcing (serving an item would raise the
-- momentum that ranks it into the module), and that a `trail` surface needs the
-- surface CHECK widened. Decided (register W10-T, D-W10T-6): neither. The Trail
-- counts its own serves HERE, and only §9's "has this item had its bounded
-- opportunity?" reads them. No momentum reader, no trend reader and no
-- Discovery reader names this table, so no feed can reinforce itself through it.
--
-- ── NO PERSONAL DATA ────────────────────────────────────────────────────────
-- A row is (Trail, member content, UTC day) → a count. It carries no viewer id,
-- no session, no position and no outcome, so it is not a behaviour record about
-- anyone and raises no consent or retention question of its own. It answers
-- only "how often has the Trail itself shown this member".
--
-- The one writer is public.trail_record_member_exposures, called fire-and-forget
-- after GET /v1/discovery/trails/:id/modules ONLY while
-- discovery_trail_exploration_enabled (3485, seeded FALSE) is on.
--
-- Rollback: db/rollback/2026-09-28-3487-trail-member-exposures-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.trails') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3487): public.trails (2910) does not exist.';
  END IF;
END
$pre$;

CREATE TABLE IF NOT EXISTS public.trail_member_exposures (
  trail_id     uuid        NOT NULL REFERENCES public.trails(id) ON DELETE CASCADE,
  source_type  text        NOT NULL,
  source_id    uuid        NOT NULL,
  served_on    date        NOT NULL,
  impressions  integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trail_id, source_type, source_id, served_on),
  CONSTRAINT tme_source_type_known CHECK (source_type IN ('post', 'place', 'event', 'itinerary', 'route')),
  CONSTRAINT tme_impressions_nonnegative CHECK (impressions >= 0)
);
COMMENT ON TABLE public.trail_member_exposures IS
  '3487 (census-discovery DV-22; 02 §9 "use exposure denominators"): how many times a Trail''s OWN modules served one member on one UTC day. No viewer id, no outcome. Read only by §9''s qualification (services/trails/trailExploration.ts) behind discovery_trail_exploration_enabled; never by momentum, trending or Discovery.';

ALTER TABLE public.trail_member_exposures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trail_member_exposures FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.trail_member_exposures TO service_role;

DO $policies$
DECLARE v_op text;
BEGIN
  FOREACH v_op IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.trail_member_exposures', format('trail_member_exposures_deny_%s_clients', lower(v_op)));
    EXECUTE format('CREATE POLICY %I ON public.trail_member_exposures AS RESTRICTIVE FOR %s TO anon, authenticated %s',
      format('trail_member_exposures_deny_%s_clients', lower(v_op)), v_op,
      CASE v_op WHEN 'INSERT' THEN 'WITH CHECK (false)'
                WHEN 'UPDATE' THEN 'USING (false) WITH CHECK (false)'
                ELSE 'USING (false)' END);
  END LOOP;
END
$policies$;

-- One call per served page: each distinct (source_type, source_id) in p_items
-- is counted ONCE (a member shown in two modules of one page was shown once).
CREATE OR REPLACE FUNCTION public.trail_record_member_exposures(p_trail_id uuid, p_items jsonb, p_at timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE v_n int;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN RETURN 0; END IF;
  WITH items AS (
    SELECT DISTINCT x->>'source_type' AS source_type, (x->>'source_id')::uuid AS source_id
      FROM jsonb_array_elements(p_items) x
     WHERE x->>'source_type' IN ('post', 'place', 'event', 'itinerary', 'route')
       AND x->>'source_id' ~ '^[0-9a-fA-F-]{36}$'
  ), up AS (
    INSERT INTO public.trail_member_exposures AS e (trail_id, source_type, source_id, served_on, impressions, updated_at)
    SELECT p_trail_id, i.source_type, i.source_id, (p_at AT TIME ZONE 'UTC')::date, 1, now() FROM items i
    ON CONFLICT (trail_id, source_type, source_id, served_on)
    DO UPDATE SET impressions = e.impressions + 1, updated_at = now()
    RETURNING 1
  ) SELECT count(*) INTO v_n FROM up;
  RETURN v_n;
END;
$fn$;
REVOKE ALL ON FUNCTION public.trail_record_member_exposures(uuid, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trail_record_member_exposures(uuid, jsonb, timestamptz) TO service_role;

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.trail_member_exposures') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3487): public.trail_member_exposures was not created';
  END IF;
  IF has_table_privilege('authenticated', 'public.trail_member_exposures', 'SELECT')
     OR has_function_privilege('authenticated', 'public.trail_record_member_exposures(uuid, jsonb, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3487): a client role can read the counts or call the writer';
  END IF;
END $post$;
