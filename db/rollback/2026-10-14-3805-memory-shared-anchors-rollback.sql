-- Rollback for 3805_memory_shared_anchors.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3805 DID: created memory_shared_anchors and memory_shared_anchor_members
-- (RLS on, no policy, service role only), the guard and dissolution triggers on
-- the members table, memory_shared_anchor_invite(uuid, uuid, uuid), and seeded
-- memory_shared_anchors_enabled FALSE.
-- WHAT THIS ROLLBACK DOES: refuses while the flag is ON (the API is serving the
-- feature: turn it off first), and while ANY anchor or membership row exists —
-- dropping the tables would erase invitations people have not answered and
-- consents people gave, and nothing can re-derive them. With neither, it drops
-- the function, the triggers, both tables and the flag. Run again after a
-- rollback, this file is a no-op.

BEGIN;

-- The table checks and the row checks are separate statements: PL/pgSQL plans a
-- statement when it first runs it, so a row check is never planned on a database
-- without the table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_shared_anchors_enabled' AND enabled) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3805): memory_shared_anchors_enabled is ON. Turn it off first.';
  END IF;
  IF to_regclass('public.memory_shared_anchor_members') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.memory_shared_anchor_members) THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3805): memory_shared_anchor_members holds rows (invitations or consents). Dropping it would erase them.';
    END IF;
  END IF;
  IF to_regclass('public.memory_shared_anchors') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.memory_shared_anchors) THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3805): memory_shared_anchors holds rows. Dropping it would erase them.';
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.memory_shared_anchor_invite(uuid, uuid, uuid);
DROP TABLE IF EXISTS public.memory_shared_anchor_members;
DROP TABLE IF EXISTS public.memory_shared_anchors;
DROP FUNCTION IF EXISTS public.memory_shared_anchor_members_guard();
DROP FUNCTION IF EXISTS public.memory_shared_anchor_dissolve();
DELETE FROM public.feature_flags WHERE flag = 'memory_shared_anchors_enabled';
DELETE FROM public.schema_migration_ledger WHERE filename = '3805_memory_shared_anchors.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.memory_shared_anchors') IS NOT NULL OR to_regclass('public.memory_shared_anchor_members') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3805 rollback): a 3805 table still exists';
  END IF;
  IF to_regprocedure('public.memory_shared_anchor_invite(uuid,uuid,uuid)') IS NOT NULL
     OR to_regprocedure('public.memory_shared_anchor_members_guard()') IS NOT NULL
     OR to_regprocedure('public.memory_shared_anchor_dissolve()') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3805 rollback): a 3805 function still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_shared_anchors_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3805 rollback): memory_shared_anchors_enabled still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3805_memory_shared_anchors.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3805 rollback): the ledger still records 3805 as applied';
  END IF;
END $post$;
