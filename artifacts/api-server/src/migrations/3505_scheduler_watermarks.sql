-- 3505_scheduler_watermarks.sql
-- A durable "processed through" mark per background scheduler, so a scheduler
-- that asks "what happened since last time" survives the process dying.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band). APPLIED TO NO
-- DATABASE by the lane that wrote it other than the local PostgreSQL 16
-- harness.
--
-- Additive + idempotent. Safe to re-run. Creates one table, enables RLS on it,
-- revokes the client roles and PUBLIC, grants service_role its four DML
-- privileges, and asserts all of that in a $post$ block. Writes no row.
--
-- ── WHY THIS TABLE EXISTS ───────────────────────────────────────────────────
-- Several schedulers select work with a window anchored on the current clock —
-- "every row created in the last hour", "every event in the last 24 hours" —
-- and keep no record of where the previous tick got to. That shape is correct
-- only while the ticks keep pace. The API runs on Replit autoscale
-- (`deploymentTarget = "autoscale"` in .replit), which suspends a container
-- after fifteen idle minutes, and a suspended container's event loop does not
-- advance. So a one-hour window is narrower than an ordinary quiet night, and
-- every row that fell inside the gap is outside the next tick's window and is
-- never examined by any later tick.
--
-- On 2026-09-30 every in-process scheduler stopped for fifty-four hours, which
-- is how this was found, but the outage is not the reason the table exists: the
-- narrow windows lose rows routinely, and an always-on host would hide that
-- rather than fix it.
--
-- One watermark per JOB, not per scheduler, because a scheduler can run several
-- detectors with different windows and one failing must not advance another's
-- mark. `lib/schedulerWatermark.ts` owns the read/advance rules — above all
-- that the mark is advanced only after the window's work actually succeeded,
-- and that a mark which cannot be READ makes the caller fall back to its old
-- lookback rather than assume "nothing processed yet" and scan from scratch.
--
-- This is NOT a liveness record. It says how far work got, never whether the
-- scheduler is running; `job_health` (0017) and GET /healthz/schedulers are the
-- liveness surfaces, and they cover four of the fifty-eight jobs.
CREATE TABLE IF NOT EXISTS public.scheduler_watermarks (
  job               text PRIMARY KEY,
  processed_through timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.scheduler_watermarks IS
  'Per-job "processed through" mark for background schedulers whose work is selected by a time window. Written only after that window''s work succeeded. Server operational state; no client involvement.';
COMMENT ON COLUMN public.scheduler_watermarks.processed_through IS
  'The instant up to which this job''s work is known to have been done. The next tick scans from here, not from now minus a fixed lookback.';

-- Server operational state, exactly like job_health (see 2070's hardening of
-- it): RLS ON with NO policies, so the service role the API uses reaches it and
-- every client role reaches nothing. There is no user-linked column here, so
-- the table states no deletion fate: it holds no personal data and nothing in
-- it survives or outlives an account.
DO $$
BEGIN
  IF to_regclass('public.scheduler_watermarks') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.scheduler_watermarks ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;

-- ── PRIVILEGES: RLS ON IS NOT "EVERY CLIENT ROLE REACHES NOTHING" BY ITSELF ───
-- Added 2026-10-04 at the integration of #561, before this file was applied to
-- any database, because the paragraph above was not yet true of what the file
-- did. Supabase's default ACL grants `anon` and `authenticated` every privilege
-- on a table created in `public`, and this file named no role, so the table was
-- born client-writable behind RLS: the shape 3504 removes from 53 older tables.
-- RLS with no policy hides the ROWS; it does not take the PRIVILEGE away, and
-- TRUNCATE, REFERENCES and TRIGGER are not policed by RLS at all (2490).
--
-- It was also a red `schema drift` job waiting on `main`: certify:migrations
-- stage 3 refuses a table a migration created on which a client role holds a
-- write privilege no migration granted. Measured on a local PostgreSQL 16 with
-- the repository's own certify run unchanged over this file as #561 wrote it:
--   ✖ 3505_scheduler_watermarks.sql: role 'anon' holds INSERT on
--     public.scheduler_watermarks, and no migration in scope grants it.
-- (and UPDATE, DELETE, TRUNCATE, and the same four for `authenticated`).
--
-- So the client roles and PUBLIC are revoked BY NAME (2490's rule), and
-- `service_role` is granted the four DML privileges by name:
-- lib/schedulerWatermark.ts reads a mark (SELECT) and upserts one on (job)
-- (INSERT, UPDATE); DELETE is for an operator clearing a retired job's mark.
REVOKE ALL ON TABLE public.scheduler_watermarks FROM PUBLIC;
REVOKE ALL ON TABLE public.scheduler_watermarks FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.scheduler_watermarks TO service_role;

-- ── POSTCONDITIONS ───────────────────────────────────────────────────────────
-- Reads only the catalogue, so certify:migrations stage 4 can re-run it after
-- the commit. It asserts the NEGATIVE as well: a presence check cannot see a
-- privilege that should not be there.
DO $post$
DECLARE
  v_rel   regclass := to_regclass('public.scheduler_watermarks');
  v_who   text;
  v_lacks text;
BEGIN
  IF v_rel IS NULL THEN
    RAISE EXCEPTION '3505 POSTCONDITION FAILED: public.scheduler_watermarks was not created.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel) THEN
    RAISE EXCEPTION '3505 POSTCONDITION FAILED: row level security is not enabled on public.scheduler_watermarks.';
  END IF;
  -- No policy is declared, so none may be permissive: a permissive policy is a
  -- client surface, and this table has no client.
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_rel AND polpermissive) THEN
    RAISE EXCEPTION '3505 POSTCONDITION FAILED: public.scheduler_watermarks carries a permissive RLS policy; it is server state with no client surface.';
  END IF;
  -- aclexplode, not has_table_privilege: a grant to PUBLIC has grantee 0 and is
  -- reported as neither client role by name.
  SELECT string_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END || ':' || x.privilege_type, ', ')
    INTO v_who
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
   WHERE c.oid = v_rel
     AND (x.grantee = 0 OR pg_get_userbyid(x.grantee) IN ('anon', 'authenticated'));
  IF v_who IS NOT NULL THEN
    RAISE EXCEPTION '3505 POSTCONDITION FAILED: a client role or PUBLIC still holds a privilege on public.scheduler_watermarks: %', v_who;
  END IF;
  -- One call per privilege: has_table_privilege(role, rel, 'a,b') is TRUE when
  -- the role holds EITHER (3504's own test found that the hard way).
  SELECT string_agg(p, ', ') INTO v_lacks
    FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p
   WHERE NOT has_table_privilege('service_role', v_rel, p);
  IF v_lacks IS NOT NULL THEN
    RAISE EXCEPTION '3505 POSTCONDITION FAILED: service_role lacks % on public.scheduler_watermarks; lib/schedulerWatermark.ts would refuse every pass.', v_lacks;
  END IF;
END
$post$;

-- Rollback: db/rollback/2026-10-04-3505-scheduler-watermarks-rollback.sql
