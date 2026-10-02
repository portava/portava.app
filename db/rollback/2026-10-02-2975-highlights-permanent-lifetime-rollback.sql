-- Rollback for 2975_highlights_permanent_lifetime.sql
--
-- ⚠ THIS ONE DESTROYS PRODUCT STATE, AND IT IS NOT A SIDE EFFECT. Making
-- `public.highlights.expires_at` NOT NULL again requires every PERMANENT
-- Highlight to be given an expiry, because a NOT NULL column cannot hold the
-- NULL that permanence IS. 2975's own header names this cost at
-- `2975_highlights_permanent_lifetime.sql:98-104`; this file is that paragraph
-- made runnable, with the one thing that paragraph leaves out measured and
-- fixed below.
--
-- WHAT THE REVERSAL LEAVES BEHIND, MEASURED 2026-10-02 on a local database
-- carrying production's exact policy text: after the UPDATE, the row still
-- reads `lifetime_class = 'PERMANENT'` while carrying an expiry 24 hours out.
-- `services/highlights/highlightLifecycle.ts` grades exactly that combination
-- as `invalid` rather than as PERMANENT — 2975's header says so itself. So a
-- bare reversal does not return the product to its pre-2975 state; it leaves
-- rows the code calls invalid. This file therefore reclassifies them to DAY in
-- the same transaction and reports how many it touched, because a silent
-- invalid row is worse than a loud demotion.
--
-- ORDER WHEN REVERSING THE PAIR: 2975 FIRST, THEN 3502. The apply order is
-- 3502 then 2975; the reversal runs backwards through it. Reversing 3502 first
-- would restore the top-level expiry conjunct while NULL expiries still exist,
-- which is precisely the state in which a PERMANENT Highlight is selectable by
-- nobody — the hazard the pair exists to avoid, reached through the exit.
--
-- Run it only to reverse 2975 deliberately, never as routine cleanup.

BEGIN;

SET LOCAL search_path = public, pg_catalog;

DO $$
DECLARE
  v_nullable   boolean;
  n_perm       bigint;
  n_reclass    bigint;
BEGIN
  SELECT a.attnotnull = false INTO v_nullable
    FROM pg_attribute a
   WHERE a.attrelid = 'public.highlights'::regclass
     AND a.attname = 'expires_at' AND a.attnum > 0 AND NOT a.attisdropped;

  IF v_nullable IS NULL THEN
    RAISE EXCEPTION '2975 rollback PRECONDITION FAILED: public.highlights.expires_at does not exist.';
  END IF;

  IF NOT v_nullable THEN
    RAISE NOTICE '2975 rollback: expires_at is already NOT NULL; nothing to reverse. Dropping the constraint if it somehow survives.';
    ALTER TABLE public.highlights DROP CONSTRAINT IF EXISTS highlights_permanent_has_no_expiry;
    RETURN;
  END IF;

  SELECT count(*) INTO n_perm FROM public.highlights WHERE expires_at IS NULL;
  RAISE NOTICE '2975 rollback: % Highlight(s) carry no expiry and are about to be given one 24 hours out. This is the cost of the reversal.', n_perm;

  ALTER TABLE public.highlights DROP CONSTRAINT IF EXISTS highlights_permanent_has_no_expiry;

  UPDATE public.highlights
     SET expires_at = now() + interval '24 hours'
   WHERE expires_at IS NULL;

  -- The half 2975's header does not cover: a row claiming PERMANENT while
  -- carrying an expiry is graded `invalid` by the lifecycle code. Demote it.
  UPDATE public.highlights
     SET lifetime_class = 'DAY'
   WHERE lifetime_class = 'PERMANENT'
     AND expires_at IS NOT NULL;
  GET DIAGNOSTICS n_reclass = ROW_COUNT;
  IF n_reclass > 0 THEN
    RAISE NOTICE '2975 rollback: % row(s) reclassified PERMANENT -> DAY, because PERMANENT with an expiry is graded invalid by highlightLifecycle.ts rather than being a lifetime the product can describe.', n_reclass;
  END IF;

  ALTER TABLE public.highlights ALTER COLUMN expires_at SET NOT NULL;
END
$$;

-- ── Postconditions: read the catalog, do not infer from the statements above ──
DO $post$
DECLARE
  v_notnull  boolean;
  v_check    boolean;
  n_bad      bigint;
BEGIN
  SELECT a.attnotnull INTO v_notnull
    FROM pg_attribute a
   WHERE a.attrelid = 'public.highlights'::regclass AND a.attname = 'expires_at';
  IF NOT v_notnull THEN
    RAISE EXCEPTION '2975 rollback postcondition 1 FAILED: expires_at is still nullable.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.highlights'::regclass
       AND conname = 'highlights_permanent_has_no_expiry'
  ) INTO v_check;
  IF v_check THEN
    RAISE EXCEPTION '2975 rollback postcondition 2 FAILED: highlights_permanent_has_no_expiry still exists.';
  END IF;

  SELECT count(*) INTO n_bad FROM public.highlights
   WHERE lifetime_class = 'PERMANENT' AND expires_at IS NOT NULL;
  IF n_bad > 0 THEN
    RAISE EXCEPTION '2975 rollback postcondition 3 FAILED: % row(s) still claim PERMANENT while carrying an expiry, which the lifecycle code grades invalid.', n_bad;
  END IF;

  RAISE NOTICE '2975 rollback postconditions PASSED: expires_at is NOT NULL, the constraint is gone, and no row claims PERMANENT while carrying an expiry.';
END
$post$;

-- The applier wrote 2975's ledger row in 2975's own transaction; without this
-- delete the ledger would take 2975 as still applied and never re-apply it.
-- The repository's standard since 2026-09-28: every rollback removes its own
-- ledger row (docs/migrations.md).
DELETE FROM public.schema_migration_ledger
 WHERE filename = '2975_highlights_permanent_lifetime.sql';

DO $ledger$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '2975_highlights_permanent_lifetime.sql') THEN
    RAISE EXCEPTION '2975 rollback POSTCONDITION FAILED: the ledger still records 2975 as applied after the reversal.';
  END IF;
END
$ledger$;

COMMIT;
