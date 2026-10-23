-- 3910_reviews_and_compass_memories_2096_2099_codified.sql
--
-- Codifies two more of the owner's August 2026 SQL-editor migrations, recorded as
-- 2096 and 2099 in reconciliation-staging/2096-2099_OWNER_ASSERTED_APPLIED.md and
-- never committed. 3909 did the same for 2098. 2097 (a column-limited grant on
-- profiles) needs nothing: production and portava-ci hold identical profiles
-- column grants (read 2026-10-23), so the chain already carries it.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). Order-independent:
-- its prerequisites, 0051 (compass_memories), 0067 (reviews and its policies) and
-- 2161 (compass_memories' client privileges revoked), all sort before it.
--
-- ── 2096: compass_memories RLS ──────────────────────────────────────────────
-- Production: RLS enabled, no policy, no client privilege (2161): deny-all for
-- every client role; the API reads and writes it with the service role, which
-- bypasses RLS. scripts/rlsDispositions.ts already classifies it that way
-- (DENY_ALL_BY_DESIGN, "RLS enabled, zero policies"). portava-ci, rebuilt from
-- the chain, had RLS OFF. 2161's REVOKE kept that from being a hole, but a single
-- future GRANT would have re-opened every user's private Compass memories.
--
-- ── 2099: public review reads honour the review's visibility ────────────────
-- 2099 ("D4 reviews anonymity", 2026-08-18) replaced 0067's
--   "Public read published reviews"         USING (state = 'published')
-- with
--   "Public reads published public reviews" USING (state = 'published' AND visibility = 'public')
-- so a review its author published as `anonymous` is not readable, with its
-- reviewer_id, through the public read. Production carries the stricter policy
-- (its comment is 2099's stamp: pre-state, rollback rules). portava-ci still had
-- 0067's, which hands every published review, anonymous ones included, to any
-- caller, anon included. audit:schema's ALLOWLIST already records 0067's policy
-- as superseded by the baseline's.
--
-- ── THE TEXT, AND WHAT IT DOES BY STARTING SHAPE ────────────────────────────
-- The policy is baseline/20260819_baseline_structure.sql's, byte for byte.
-- 2099's comment is NOT copied: it records production's pre-state at 2099's
-- apply, which is not true of any other database.
--   production   compass_memories already has RLS, the stricter policy exists and
--                0067's is absent. A strict no-op; only the postconditions run,
--                and they only read.
--   portava-ci   Enables RLS on compass_memories, creates the stricter policy and
--                drops 0067's.
--   local-db     The baseline restore is production's shape: a no-op.
-- Each change happens only where it is missing. A database whose reviews policies
-- differ in some other way is not repaired here: the postconditions refuse.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- None at the schema level, deliberately. On production this file changes
-- nothing. Elsewhere it removes a read of anonymous reviews and an RLS-off
-- private table, and putting either back is not a rollback anyone should run.
-- Deleting this file's ledger row is the whole rollback.

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.compass_memories') IS NULL OR to_regclass('public.reviews') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3910): public.compass_memories (0051) and public.reviews (0067) must exist.';
  END IF;
  IF to_regtype('public.review_visibility') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.reviews'::regclass AND attname = 'visibility' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3910): reviews.visibility (public.review_visibility) is missing; 2099''s policy reads it.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.reviews'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3910): RLS is not enabled on reviews; its policies would decide nothing.';
  END IF;
END $pre$;

-- ── 1. 2096: RLS on compass_memories, only where it is off ─────────────────────
DO $rls$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.compass_memories'::regclass) THEN
    ALTER TABLE public.compass_memories ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;

-- ── 2. 2099: the visibility-scoped public read, only where it is absent ────────
DO $policy$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.reviews'::regclass
                   AND polname = 'Public reads published public reviews') THEN
CREATE POLICY "Public reads published public reviews" ON public.reviews FOR SELECT USING (((state = 'published'::public.review_state) AND (visibility = 'public'::public.review_visibility)));
  END IF;
END $policy$;

-- ── 3. 0067's unscoped public read, superseded. Absent on production. ─────────
DROP POLICY IF EXISTS "Public read published reviews" ON public.reviews;

COMMIT;

-- ── Postconditions (separate transaction; they read and raise, nothing else) ───
-- reviews' five policies must equal production's, read 2026-10-23 with this same
-- expression (command, permissive, roles, whitespace-normalised predicates;
-- comments excluded, see above), and be exactly those five. compass_memories
-- must have RLS, no policy and no client privilege.
DO $$
DECLARE
  r record;
  got text;
  n int;
BEGIN
  PERFORM pg_catalog.set_config('search_path', '"$user", public, extensions', true);

  FOR r IN SELECT * FROM (VALUES
      ('Authors can delete own place reviews', 'd8169af1f16f83fdd0598874d3cf0ed4'),
      ('Authors can insert own reviews', '6abad25a7772c678dc61e890dd9d425d'),
      ('Authors can read own reviews', 'ca5d10a2e2f5cbfaf2e80efad707dbf9'),
      ('Authors can update own reviews', '1178472cdf0f5fe62c76874933a0d4b8'),
      ('Public reads published public reviews', '818516623e5efa2af2a3cac505c5ddea')
    ) AS x(polname, want)
  LOOP
    SELECT md5(concat_ws('|', p.polcmd::text, p.polpermissive::text,
             (SELECT string_agg(rn, ',' ORDER BY rn) FROM (
                SELECT CASE WHEN x = 0 THEN 'public' ELSE pg_get_userbyid(x) END AS rn FROM unnest(p.polroles) x) rr),
             regexp_replace(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), '\s+', ' ', 'g'),
             regexp_replace(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '\s+', ' ', 'g')))
      INTO got
      FROM pg_policy p
     WHERE p.polrelid = 'public.reviews'::regclass AND p.polname = r.polname;
    IF got IS NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3910): reviews policy "%" is absent.', r.polname;
    END IF;
    IF got <> r.want THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3910): reviews policy "%" differs from production''s (fingerprint %, production %).', r.polname, got, r.want;
    END IF;
  END LOOP;

  SELECT count(*) INTO n FROM pg_policy WHERE polrelid = 'public.reviews'::regclass;
  IF n <> 5 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3910): reviews has % policies, not production''s five (0067''s unscoped read must be gone).', n;
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.compass_memories'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3910): RLS is not enabled on compass_memories.';
  END IF;
  SELECT count(*) INTO n FROM pg_policy WHERE polrelid = 'public.compass_memories'::regclass;
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3910): compass_memories has % policies; production''s deny-all has none.', n;
  END IF;
  SELECT count(*) INTO n
    FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) e
   WHERE c.oid = 'public.compass_memories'::regclass
     AND (e.grantee = 0 OR pg_get_userbyid(e.grantee) IN ('anon', 'authenticated'));
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3910): a client role holds % privilege(s) on compass_memories (2161 revoked them all).', n;
  END IF;
END $$;
