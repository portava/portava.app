-- Rollback for 3820_rent_buddy_bookings_write_boundary.sql
-- Written 2026-10-04 by the payments lane (PAY-002).
-- Rehearsed on a private PostgreSQL 16 carrying the 2026-08-19 baseline and the
-- chain (apply, re-apply, rollback, re-apply), from three starting states: the
-- baseline's own grants, 2490's (TRUNCATE, REFERENCES, TRIGGER already gone),
-- and the hosted databases' as read on 2026-10-04 (the nine views already
-- security_invoker, no anon grant on them).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- RUN IT SO THAT A REFUSAL STOPS THE RUN:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/rollback/2026-10-04-3820-rent-buddy-bookings-write-boundary-rollback.sql
-- Without ON_ERROR_STOP psql prints an error, carries on and exits 0. For that
-- case the LAST statement of this file speaks as well: it FAILS when the
-- rollback did not happen and 3820's boundary still stands, and WARNS when the
-- rollback was refused on a database that had nothing to roll back. Either way
-- the final thing on the screen is not a bare COMMIT.
--
-- WHAT 3820 DID
-- =============
--   * REVOKEd INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER (and
--     MAINTAIN on PostgreSQL 17) on rent_buddy_bookings, rent_buddy_offers and
--     the buddy_bookings / buddy_booking_requests views FROM anon,
--     authenticated and PUBLIC;
--   * dropped the policy rb_booking_traveler_ins, whatever its definition was;
--   * set security_invoker on those of the nine buddy_* compatibility views
--     that still ran with their owner's rights (on the hosted databases: none);
--   * recorded in the comment on rent_buddy_bookings, on one line of its own
--     between <<3820-prior-state and 3820-prior-state>>, exactly which client
--     write privileges it removed, the dropped policy's definition, and which
--     views it switched.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores that record and nothing more: each recorded privilege is granted
-- back to the role that held it, the policy is recreated AS RECORDED (command,
-- role list, USING and WITH CHECK as that database had them — not as the
-- baseline wrote them) if there was one, security_invoker is reset on the views
-- 3820 switched (and only those), 3820's two lines are taken out of the comment
-- and whatever stood before or was added after them stays, and 3820's
-- schema_migration_ledger row is deleted so the applier re-applies 3820 later.
-- It never widens past the recorded state: on a database where 2490 had removed
-- TRUNCATE, REFERENCES and TRIGGER, they stay removed.
--
-- It REFUSES — raises, changes nothing — when the comment carries no 3820
-- record (never applied, already rolled back, or the comment was replaced):
-- that is not the state 3820 left, and there is nothing to restore from. A
-- replaced comment is recovered by hand: the apply that wrote the record also
-- printed it (NOTICE "3820 recorded the state before it: …"), so it is in that
-- apply's output.
--
-- ⚠ IT RE-OPENS EVERY DOOR 3820 CLOSED. A signed-in user can again INSERT a
-- booking with a price of their choosing, past the master flag, the identity
-- gate and the launch controls; and where the views ran as their owner, a
-- caller with only the public anon key can again read every booking, write and
-- delete bookings, and set `verified` on a buddy profile. Use it only to
-- recover from a writer 3820 broke, and re-apply 3820 as soon as that writer
-- goes through the API.
--
-- It changes no row other than the ledger's.

-- Cleared outside the transaction, so that a marker left by an earlier run in
-- this same session cannot speak for this one.
SET pay_3820.rolled_back TO 'no';

BEGIN;

DO $rollback$
DECLARE
  bk      regclass := to_regclass('public.rent_buddy_bookings');
  descr   text;
  state   jsonb;
  pol     jsonb;
  rest    text;
  g       jsonb;
  w       jsonb;
  missing text;
  priv    text;
BEGIN
  IF bk IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3820): public.rent_buddy_bookings does not exist.';
  END IF;
  descr := obj_description(bk, 'pg_class');
  -- The record is one line between its delimiters; whatever else the comment
  -- holds, before it or after it, is not read.
  state := substring(descr FROM '<<3820-prior-state (\{[^\n]*\}) 3820-prior-state>>')::jsonb;
  IF state IS NULL OR jsonb_typeof(state -> 'privileges') IS DISTINCT FROM 'array'
     OR jsonb_typeof(state -> 'invoker') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3820): the comment on rent_buddy_bookings carries no 3820 record (<<3820-prior-state … 3820-prior-state>>). 3820 was never applied here, was already rolled back, or the comment was replaced; there is nothing to restore from. Nothing has been changed.';
  END IF;
  pol := state -> 'policy';
  IF jsonb_typeof(pol) = 'object' THEN
    -- Everything the policy is recreated from is checked before anything is
    -- changed. The two expressions are pg_get_expr's own output, as pg_dump
    -- would write them.
    IF pol ->> 'cmd' IS NULL OR pol ->> 'cmd' NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL')
       OR jsonb_typeof(pol -> 'permissive') IS DISTINCT FROM 'boolean'
       OR jsonb_typeof(pol -> 'roles') IS DISTINCT FROM 'array' OR jsonb_array_length(pol -> 'roles') = 0
       OR (pol ->> 'using' IS NULL AND pol ->> 'check' IS NULL) THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3820): the recorded definition of rb_booking_traveler_ins is not one 3820 writes (%). Nothing has been changed.', pol;
    END IF;
    SELECT string_agg(r, ', ') INTO missing
      FROM jsonb_array_elements_text(pol -> 'roles') r
     WHERE r <> 'PUBLIC' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    IF missing IS NOT NULL THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3820): the recorded policy names role(s) that no longer exist (%). Nothing has been changed.', missing;
    END IF;
  ELSIF jsonb_typeof(pol) IS DISTINCT FROM 'null' THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3820): the record''s policy entry is neither a definition nor null (%). Nothing has been changed.', pol;
  END IF;

  -- 1. The privileges, each to the role that held it. A relation that has since
  --    been dropped is skipped: there is nothing to grant on.
  FOR g IN SELECT * FROM jsonb_array_elements(state -> 'privileges') LOOP
    IF to_regclass(format('public.%I', g ->> 'rel')) IS NOT NULL THEN
      FOR priv IN SELECT * FROM jsonb_array_elements_text(g -> 'held') LOOP
        -- The privilege names come from this server's own aclexplode, written by
        -- 3820; they are checked against the closed set before being issued.
        IF priv NOT IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN') THEN
          RAISE EXCEPTION 'ROLLBACK REFUSED (3820): the record names a privilege 3820 does not remove (%).', priv;
        END IF;
        EXECUTE format('GRANT %s ON public.%I TO %s%s',
                       priv,
                       g ->> 'rel',
                       CASE WHEN g ->> 'grantee' = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(g ->> 'grantee') END,
                       CASE WHEN (g -> 'grantable') ? priv THEN ' WITH GRANT OPTION' ELSE '' END);
      END LOOP;
    END IF;
  END LOOP;

  -- 2. The traveller INSERT policy, as THIS database had it when 3820 dropped
  --    it. Left alone if a policy of that name has been put back since.
  IF jsonb_typeof(pol) = 'object'
     AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = bk AND p.polname = 'rb_booking_traveler_ins') THEN
    EXECUTE format('CREATE POLICY rb_booking_traveler_ins ON public.rent_buddy_bookings AS %s FOR %s TO %s%s%s',
                   CASE WHEN (pol ->> 'permissive')::boolean THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
                   pol ->> 'cmd',
                   (SELECT string_agg(CASE WHEN r = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(r) END, ', ')
                      FROM jsonb_array_elements_text(pol -> 'roles') r),
                   CASE WHEN pol ->> 'using' IS NOT NULL THEN format(' USING (%s)', pol ->> 'using') ELSE '' END,
                   CASE WHEN pol ->> 'check' IS NOT NULL THEN format(' WITH CHECK (%s)', pol ->> 'check') ELSE '' END);
  END IF;

  -- 3. The views 3820 switched go back to their owner's rights.
  FOR w IN SELECT * FROM jsonb_array_elements(state -> 'invoker') LOOP
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = w ->> 0 AND c.relname = w ->> 1 AND c.relkind = 'v') THEN
      EXECUTE format('ALTER VIEW %I.%I RESET (security_invoker)', w ->> 0, w ->> 1);
    END IF;
  END LOOP;

  -- 4. The comment without 3820's two lines (its sentence and the record),
  --    and without the blank line 3820 put before them. Text that stood before
  --    them, or that was added after them since, stays as it is.
  rest := regexp_replace(descr, '\n{0,2}3820 \(PAY-002\):[^\n]*\n<<3820-prior-state [^\n]* 3820-prior-state>>', '');
  IF rest = descr THEN
    -- The record is there but 3820's sentence above it is not: take the record line alone.
    rest := regexp_replace(descr, '\n?<<3820-prior-state [^\n]* 3820-prior-state>>', '');
  END IF;
  rest := NULLIF(ltrim(rest, E'\n'), '');
  EXECUTE format('COMMENT ON TABLE public.rent_buddy_bookings IS %L', rest);

  -- 5. The ledger row, so a later apply-migrations run re-applies 3820.
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3820_rent_buddy_bookings_write_boundary.sql';
  END IF;

  -- Exact, or nothing: every recorded privilege is held again.
  SELECT string_agg(format('%s:%s:%s', e ->> 'rel', e ->> 'grantee', h), ', ') INTO missing
    FROM jsonb_array_elements(state -> 'privileges') e
    CROSS JOIN LATERAL jsonb_array_elements_text(e -> 'held') h
   WHERE to_regclass(format('public.%I', e ->> 'rel')) IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
        WHERE c.oid = to_regclass(format('public.%I', e ->> 'rel'))
          AND x.privilege_type = h
          AND CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END = e ->> 'grantee');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED (3820 rollback): recorded privilege(s) were not restored: %.', missing;
  END IF;

  -- Seen by the block after COMMIT: this transaction ran to its end. Session
  -- scope, so it survives the COMMIT and is undone with the transaction if
  -- anything above raised.
  PERFORM set_config('pay_3820.rolled_back', 'yes', false);
END
$rollback$;

COMMIT;

-- ── Postconditions: the rollback HAPPENED, and left no trace of 3820 ─────────
DO $post$
DECLARE
  ran    boolean := COALESCE(current_setting('pay_3820.rolled_back', true), '') = 'yes';
  descr  text := COALESCE(obj_description('public.rent_buddy_bookings'::regclass, 'pg_class'), '');
  can_insert  boolean;
BEGIN
  -- A refusal above leaves the database exactly as 3820 left it. Where this
  -- file was run without ON_ERROR_STOP that refusal has already scrolled past,
  -- so it is said again here, as the last statement: the block above did not
  -- complete in this session, and no client role can INSERT a booking — the
  -- boundary 3820 drew still stands. (The second half keeps this quiet for a
  -- rollback that did commit but whose session a transaction pooler has since
  -- swapped: there the INSERT privilege is back.)
  SELECT bool_or(has_table_privilege(r.oid, 'public.rent_buddy_bookings'::regclass, 'INSERT')) INTO can_insert
    FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated');
  IF NOT ran AND NOT COALESCE(can_insert, false) THEN
    RAISE EXCEPTION 'ROLLBACK DID NOT HAPPEN (3820): the rollback block did not complete — see the ROLLBACK REFUSED error above it — and rent_buddy_bookings is still as 3820 left it. Nothing has been changed.';
  END IF;
  IF NOT ran THEN
    -- Refused, on a database that is not in the state 3820 leaves (already
    -- rolled back, or never applied): nothing needed doing, and it is said.
    RAISE WARNING 'ROLLBACK DID NOT RUN (3820): the rollback block did not complete in this session — see the error above it. A client role can INSERT into rent_buddy_bookings, so this database is not in the state 3820 leaves; nothing has been changed by this run.';
  END IF;
  IF descr ~ '<<3820-prior-state ' OR position('3820 (PAY-002):' IN descr) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3820 rollback): the 3820 record is still in the comment on rent_buddy_bookings.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3820_rent_buddy_bookings_write_boundary.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3820 rollback): the ledger still records 3820 as applied.';
  END IF;
END
$post$;
