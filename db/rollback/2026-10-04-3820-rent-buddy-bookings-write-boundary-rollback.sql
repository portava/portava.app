-- Rollback for 3820_rent_buddy_bookings_write_boundary.sql
-- Written 2026-10-04 by the payments lane (PAY-002).
-- Rehearsed on a private PostgreSQL 16 carrying the 2026-08-19 baseline and the
-- chain (apply, re-apply, rollback, re-apply), both from the baseline's own
-- grants and from 2490's (TRUNCATE, REFERENCES, TRIGGER already gone).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3820 DID
-- =============
--   * REVOKEd INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER (and
--     MAINTAIN on PostgreSQL 17) on rent_buddy_bookings, rent_buddy_offers and
--     the buddy_bookings / buddy_booking_requests views FROM anon,
--     authenticated and PUBLIC;
--   * dropped the policy rb_booking_traveler_ins;
--   * set security_invoker on the nine buddy_* compatibility views and on any
--     other view reaching either table;
--   * recorded, at the end of the comment on rent_buddy_bookings, exactly which
--     client write privileges it removed, whether the policy existed, and which
--     views it switched.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Restores that record and nothing more: each recorded privilege is granted
-- back to the role that held it, the policy is recreated as the baseline
-- defines it if it was there, security_invoker is reset on the views 3820
-- switched (and only those), the comment returns to what it was, and 3820's
-- schema_migration_ledger row is deleted so the applier re-applies 3820 later.
-- It never widens past the recorded state: on a database where 2490 had removed
-- TRUNCATE, REFERENCES and TRIGGER, they stay removed.
--
-- It REFUSES when the comment carries no 3820 record: that is not the state
-- 3820 left, and there is nothing to restore from.
--
-- ⚠ IT RE-OPENS EVERY DOOR 3820 CLOSED. A signed-in user can again INSERT a
-- booking with a price of their choosing, past the master flag, the identity
-- gate and the launch controls; and through the views a caller with only the
-- public anon key can again read every booking, write and delete bookings, and
-- set `verified` on a buddy profile. Use it only to recover from a writer 3820
-- broke, and re-apply 3820 as soon as that writer goes through the API.
--
-- It changes no row other than the ledger's.

BEGIN;

DO $rollback$
DECLARE
  bk     regclass := to_regclass('public.rent_buddy_bookings');
  descr  text;
  state  jsonb;
  prior  text;
  g      jsonb;
  w      jsonb;
  missing text;
  priv   text;
BEGIN
  IF bk IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3820): public.rent_buddy_bookings does not exist.';
  END IF;
  descr := obj_description(bk, 'pg_class');
  state := substring(descr FROM 'State before 3820, which its rollback restores: (\{.*\})$')::jsonb;
  IF descr IS NULL OR position('3820 (PAY-002):' IN descr) = 0 OR state IS NULL OR state -> 'privileges' IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3820): the comment on rent_buddy_bookings carries no 3820 record; this is not the state 3820 left, and there is nothing to restore from. Nothing has been changed.';
  END IF;
  -- The comment as it was before 3820: nothing, or whatever preceded the record.
  IF position('3820 (PAY-002):' IN descr) = 1 THEN
    prior := NULL;
  ELSIF position(E'\n\n3820 (PAY-002):' IN descr) > 0 THEN
    prior := substring(descr FROM 1 FOR position(E'\n\n3820 (PAY-002):' IN descr) - 1);
  ELSE
    RAISE EXCEPTION 'ROLLBACK REFUSED (3820): the comment on rent_buddy_bookings is not in the shape 3820 wrote. Nothing has been changed.';
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

  -- 2. The traveller INSERT policy, exactly as the baseline defines it
  --    (baseline/20260819_baseline_structure.sql:30753), if 3820 found it.
  IF (state ->> 'policy')::boolean
     AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = bk AND p.polname = 'rb_booking_traveler_ins') THEN
    CREATE POLICY rb_booking_traveler_ins ON public.rent_buddy_bookings
      FOR INSERT WITH CHECK ((auth.uid() = traveler_id));
  END IF;

  -- 3. The views 3820 switched go back to their owner's rights.
  FOR w IN SELECT * FROM jsonb_array_elements(state -> 'invoker') LOOP
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = w ->> 0 AND c.relname = w ->> 1 AND c.relkind = 'v') THEN
      EXECUTE format('ALTER VIEW %I.%I RESET (security_invoker)', w ->> 0, w ->> 1);
    END IF;
  END LOOP;

  -- 4. The comment as it was.
  EXECUTE format('COMMENT ON TABLE public.rent_buddy_bookings IS %L', prior);

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
END
$rollback$;

COMMIT;

-- ── Postconditions: the record is gone, and so is the ledger row ─────────────
DO $post$
BEGIN
  IF position('3820 (PAY-002):' IN COALESCE(obj_description('public.rent_buddy_bookings'::regclass, 'pg_class'), '')) > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3820 rollback): the 3820 record is still in the comment on rent_buddy_bookings.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3820_rent_buddy_bookings_write_boundary.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3820 rollback): the ledger still records 3820 as applied.';
  END IF;
END
$post$;
