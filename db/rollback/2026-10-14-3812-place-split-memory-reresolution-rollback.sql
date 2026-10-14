-- Rollback for 3812_place_split_memory_reresolution.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3812 DID: widened place_merge_log_action_check to admit 'split'; created
-- public.place_split(uuid, jsonb, uuid[], uuid); created
-- public.memory_place_reresolution_proposals with its guard trigger and
-- function; installed the memory_place_reresolution_purge trigger on
-- public.memories and its function; seeded
-- memory_place_split_reresolution_enabled FALSE.
--
-- WHAT THIS ROLLBACK DOES:
--   * REFUSES while memory_place_split_reresolution_enabled is ON (admins can
--     split and owners are being asked: turn it off first);
--   * REFUSES while any proposal exists. A proposal is the only record of what
--     the owner was asked and what they decided, and nothing re-derives a
--     decision. Export (id, memory_id, owner_id, state, accepted_place_id,
--     decided_at) by hand and delete the rows first if the rollback must go on;
--   * restores place_merge_log_action_check to ('merge', 'unmerge') ONLY when no
--     'split' row exists. A 'split' row is the catalog's audit history of a
--     split that happened (its place rows stay: they are venues now, and other
--     content may reference them), so with one present the widened CHECK is
--     KEPT and a NOTICE says so — the narrow CHECK could not even be added;
--   * drops the purge trigger on memories first (so no Memory write can reach a
--     dropped table), then the proposals table and every 3812 function, the
--     flag and the ledger row. Re-running it is a no-op.

BEGIN;

-- The table check and the row check are two statements (VERIFY-H4 H4-5): the
-- row check is never planned on a database without the table, so a re-run
-- after a rollback is a no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_place_split_reresolution_enabled' AND enabled) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3812): memory_place_split_reresolution_enabled is ON. Turn it off first.';
  END IF;
  IF to_regclass('public.memory_place_reresolution_proposals') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.memory_place_reresolution_proposals) THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3812): memory_place_reresolution_proposals holds rows — what owners were asked and what they decided. Export and delete them first.';
    END IF;
  END IF;
END $$;

DROP TRIGGER IF EXISTS memory_place_reresolution_purge ON public.memories;
DROP FUNCTION IF EXISTS public.memory_place_reresolution_purge();
DROP TABLE IF EXISTS public.memory_place_reresolution_proposals;
DROP FUNCTION IF EXISTS public.memory_place_reresolution_proposals_guard();
DROP FUNCTION IF EXISTS public.place_split(uuid, jsonb, uuid[], uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.place_merge_log WHERE action = 'split') THEN
    RAISE NOTICE 'ROLLBACK (3812): place_merge_log records % split(s); place_merge_log_action_check keeps admitting split (audit history is not rewritten).',
      (SELECT count(*) FROM public.place_merge_log WHERE action = 'split');
  ELSE
    ALTER TABLE public.place_merge_log DROP CONSTRAINT IF EXISTS place_merge_log_action_check;
    ALTER TABLE public.place_merge_log ADD CONSTRAINT place_merge_log_action_check CHECK ((action = ANY (ARRAY['merge'::text, 'unmerge'::text])));
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag = 'memory_place_split_reresolution_enabled';
DELETE FROM public.schema_migration_ledger WHERE filename = '3812_place_split_memory_reresolution.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.memory_place_reresolution_proposals') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812 rollback): memory_place_reresolution_proposals still exists';
  END IF;
  IF to_regprocedure('public.place_split(uuid,jsonb,uuid[],uuid)') IS NOT NULL
     OR to_regprocedure('public.memory_place_reresolution_proposals_guard()') IS NOT NULL
     OR to_regprocedure('public.memory_place_reresolution_purge()') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812 rollback): a 3812 function still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'memory_place_reresolution_purge') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812 rollback): the purge trigger on memories still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'memory_place_split_reresolution_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812 rollback): memory_place_split_reresolution_enabled still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3812_place_split_memory_reresolution.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812 rollback): the ledger still records 3812 as applied';
  END IF;
  -- Exactly one of: no split row and the CHECK refuses 'split' again, or split rows and the CHECK still admits them.
  IF EXISTS (SELECT 1 FROM public.place_merge_log WHERE action = 'split') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.place_merge_log'::regclass
                     AND conname = 'place_merge_log_action_check' AND pg_get_constraintdef(oid) LIKE '%''split''%') THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3812 rollback): split rows exist but place_merge_log_action_check no longer admits them';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.place_merge_log'::regclass
                      AND conname = 'place_merge_log_action_check'
                      AND pg_get_constraintdef(oid) LIKE '%''merge''%' AND pg_get_constraintdef(oid) LIKE '%''unmerge''%'
                      AND pg_get_constraintdef(oid) NOT LIKE '%''split''%') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3812 rollback): place_merge_log_action_check was not restored to (merge, unmerge)';
  END IF;
END $post$;
