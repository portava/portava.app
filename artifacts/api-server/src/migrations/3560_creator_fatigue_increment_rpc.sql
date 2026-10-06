-- 3560_creator_fatigue_increment_rpc.sql
--
-- Port public.increment_creator_fatigue_batch into the canonical chain, so that
-- CREATOR_FATIGUE_ENABLED can be turned on without every impression batch
-- failing its fatigue write.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; FLAGS lane, 3560).
-- Creates ONE function. Creates no table, writes no row, flips no flag.
--
-- ── WHAT IS WRONG TODAY ─────────────────────────────────────────────────────
-- lib/rankLog.ts upsertCreatorFatigueAsync calls
--     sc.rpc("increment_creator_fatigue_batch", { p_viewer_id, p_creator_ids })
-- after every impression batch whenever CREATOR_FATIGUE_ENABLED is ON. The
-- function's only definition is in the FROZEN, never-applied root
--     artifacts/api-server/supabase/migrations/20260804_creator_fatigue_expires.sql
-- (src/scripts/frozenMigrationRoots.ts). No canonical migration creates it, and
-- it is absent from the testing database (read-only pg_proc listing,
-- 2026-10-03). So with the flag ON every batch is rejected with 42883 and
-- reported (rankLog reportFatigueWriteFailure; pinned by
-- src/test/rankLogReadFailureVisibility.test.ts), viewer_creator_fatigue never
-- gains a row, and the fatigue the flag promises never happens.
--
-- The rest of that frozen file is already canonical or deliberately not ported:
--   * viewer_creator_fatigue.expires_at + its partial index -> 2058.
--   * the ranking.caps.* ranking_config seeds -> not ported: no reader needs
--     them for this RPC (rankLog passes neither p_half_life_hours nor
--     p_fatigue_threshold, so the defaults 48 / 5 apply, exactly as the frozen
--     file intended).
--
-- ── WHAT THIS FILE CREATES ──────────────────────────────────────────────────
-- The frozen body, unchanged in what it computes (insert at 1 impression /
-- score 1.0; on conflict add one impression, decay the score by elapsed time
-- with the half-life, add 1.0, cap at 10; open an expires_at window of one
-- half-life once the impression count reaches the threshold), with four
-- reviewed differences:
--   1. SET search_path = '' and schema-qualified names. The frozen function was
--      SECURITY DEFINER with no search_path (search-path injection).
--   2. EXECUTE revoked from PUBLIC, anon and authenticated and granted to
--      service_role only (2973's rule: a SECURITY DEFINER function that WRITES
--      is not callable by a client role; rankLog uses the service client).
--   3. updated_at = now() on every touch (the column exists on
--      viewer_creator_fatigue; the frozen body left it stale).
--   4. A NULL/empty creator list is a no-op, and a non-positive half-life or
--      threshold is refused (the frozen body divided by zero).
--
-- ── NO OWNER DECISION ───────────────────────────────────────────────────────
-- viewer_creator_fatigue is ranking state (viewer x creator impression counts),
-- not an earnings or payout record: nothing in the frozen DDL or in this body
-- touches a ledger, a payout or money. Its retention is already stated and
-- enforced in code: lib/rankingFatigueSweeper.ts RETENTION_DAYS = 30 (deletes
-- rows whose last_impression_at is older than 30 days every 6 hours; started by
-- src/index.ts startRankingFatigueSweeper).
--
-- Idempotent (CREATE OR REPLACE + REVOKE/GRANT). Postconditions RAISE.
-- Rollback: db/rollback/2026-10-03-3560-creator-fatigue-increment-rpc-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.viewer_creator_fatigue') IS NULL THEN
    RAISE EXCEPTION '3560 PRECONDITION FAILED: public.viewer_creator_fatigue is missing.';
  END IF;
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.viewer_creator_fatigue'::regclass AND NOT attisdropped
         AND attname IN ('viewer_id','creator_id','recent_impressions','last_impression_at','fatigue_score','updated_at','expires_at')) <> 7 THEN
    RAISE EXCEPTION '3560 PRECONDITION FAILED: viewer_creator_fatigue lacks one of viewer_id, creator_id, recent_impressions, last_impression_at, fatigue_score, updated_at, expires_at (2058 adds expires_at).';
  END IF;
  -- ON CONFLICT (viewer_id, creator_id) needs a unique index on exactly that pair.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'public.viewer_creator_fatigue'::regclass AND i.indisunique
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM unnest(i.indkey) k JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k)
           = ARRAY['creator_id','viewer_id']
  ) THEN
    RAISE EXCEPTION '3560 PRECONDITION FAILED: viewer_creator_fatigue has no unique index on (viewer_id, creator_id).';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.increment_creator_fatigue_batch(
  p_viewer_id         uuid,
  p_creator_ids       uuid[],
  p_half_life_hours   integer DEFAULT 48,
  p_fatigue_threshold integer DEFAULT 5
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  cid uuid;
BEGIN
  IF p_viewer_id IS NULL THEN
    RAISE EXCEPTION 'increment_creator_fatigue_batch: p_viewer_id is required' USING ERRCODE = '22004';
  END IF;
  IF p_half_life_hours IS NULL OR p_half_life_hours <= 0
     OR p_fatigue_threshold IS NULL OR p_fatigue_threshold <= 0 THEN
    RAISE EXCEPTION 'increment_creator_fatigue_batch: half-life (%) and threshold (%) must be positive',
      p_half_life_hours, p_fatigue_threshold USING ERRCODE = '22023';
  END IF;
  IF p_creator_ids IS NULL OR cardinality(p_creator_ids) = 0 THEN
    RETURN;
  END IF;

  FOREACH cid IN ARRAY p_creator_ids LOOP
    CONTINUE WHEN cid IS NULL;
    INSERT INTO public.viewer_creator_fatigue AS f
      (viewer_id, creator_id, recent_impressions, last_impression_at, fatigue_score, updated_at, expires_at)
    VALUES
      (p_viewer_id, cid, 1, now(), 1.0, now(), NULL)
    ON CONFLICT (viewer_id, creator_id) DO UPDATE SET
      recent_impressions = f.recent_impressions + 1,
      last_impression_at = now(),
      fatigue_score = LEAST(10.0,
        f.fatigue_score::double precision
          * power(0.5,
              extract(epoch FROM (now() - f.last_impression_at))
              / (p_half_life_hours::double precision * 3600.0)
            )
        + 1.0
      ),
      updated_at = now(),
      expires_at = CASE
        WHEN f.recent_impressions + 1 >= p_fatigue_threshold
          THEN now() + make_interval(hours => p_half_life_hours)
        ELSE f.expires_at
      END;
  END LOOP;
END;
$fn$;

COMMENT ON FUNCTION public.increment_creator_fatigue_batch(uuid, uuid[], integer, integer) IS
  '3560: atomic per-batch creator-fatigue increment called by lib/rankLog.ts while CREATOR_FATIGUE_ENABLED is ON. Ported from the frozen root 20260804_creator_fatigue_expires.sql with search_path pinned, service_role-only EXECUTE, updated_at maintained and non-positive parameters refused. Retention of the rows it writes: lib/rankingFatigueSweeper.ts (30 days).';

REVOKE ALL ON FUNCTION public.increment_creator_fatigue_batch(uuid, uuid[], integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_creator_fatigue_batch(uuid, uuid[], integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_creator_fatigue_batch(uuid, uuid[], integer, integer) TO service_role;

DO $post$
DECLARE
  fn regprocedure := to_regprocedure('public.increment_creator_fatigue_batch(uuid,uuid[],integer,integer)');
BEGIN
  IF fn IS NULL THEN
    RAISE EXCEPTION '3560 POSTCONDITION FAILED: increment_creator_fatigue_batch(uuid,uuid[],integer,integer) is missing.';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = fn) THEN
    RAISE EXCEPTION '3560 POSTCONDITION FAILED: increment_creator_fatigue_batch is not SECURITY DEFINER.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = fn AND 'search_path=""' = ANY (proconfig)) THEN
    RAISE EXCEPTION '3560 POSTCONDITION FAILED: increment_creator_fatigue_batch does not pin search_path.';
  END IF;
  IF has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE') THEN
    RAISE EXCEPTION '3560 POSTCONDITION FAILED: a client role (anon/authenticated) can EXECUTE increment_creator_fatigue_batch.';
  END IF;
  IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
    RAISE EXCEPTION '3560 POSTCONDITION FAILED: service_role cannot EXECUTE increment_creator_fatigue_batch.';
  END IF;
  -- More than one overload would make the PostgREST call ambiguous.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'increment_creator_fatigue_batch') <> 1 THEN
    RAISE EXCEPTION '3560 POSTCONDITION FAILED: public.increment_creator_fatigue_batch has more than one overload.';
  END IF;
END
$post$;

COMMIT;
