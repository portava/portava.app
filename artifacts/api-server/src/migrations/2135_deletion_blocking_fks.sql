-- 2135_deletion_blocking_fks.sql
-- D6 — make account deletion completable. Five foreign keys currently abort it.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
-- 2134 is taken by reconciliation-staging/2134_rls_predicate_functions_private_schema.sql,
-- which is staged for the same target; this file starts at 2135 so the two do
-- not collide when that one is applied and promoted into this directory.
--
-- ── WHAT IS BROKEN ──────────────────────────────────────────────────────────
-- executeAccountDeletion destroys the user's content in steps 1-3, anonymises
-- the profile in step 4, and calls auth.admin.deleteUser in step 5. Step 5 is
-- NOT fatal. Five foreign keys pointing at auth.users make that DELETE fail:
--
--   event_cohosts.added_by            NO ACTION            — rejects the delete
--   moderation_reports.resolver_id    NO ACTION            — rejects the delete
--   post_edits.user_id                NO ACTION            — rejects the delete
--   trip_plan_items.creator_id        NO ACTION            — rejects the delete
--   moderation_reports.reporter_id    SET NULL, NOT NULL   — raises 23502
--
-- None of those five tables is cleared by the deletion service, so the retry
-- fails identically, forever. The outcome is the exact inverse of a deletion:
-- content destroyed, identity and email retained. Both failure modes were
-- reproduced against a real database before this file was written; the last one
-- is the more dangerous, because a SET NULL rule READS as a severance policy
-- while actually aborting the delete.
--
-- ── WHAT EACH BECOMES, AND WHY (owner rulings, 2026-08-23) ──────────────────
-- Ruling 3: user-created content is deletable with the account, unless a minimal
-- tombstone is needed to preserve another user's conversation or transaction.
-- Ruling 4: safety records may be retained narrowly, preferring severance of the
-- person's live identity.
--
--   event_cohosts.added_by         -> nullable, SET NULL
--       The cohost relationship belongs to someone else's event. Deleting the
--       row would edit another user's event; severing WHO ADDED them keeps the
--       event intact and drops the departed person's identity. Note the cohost's
--       own membership (user_id) is already CASCADE and still removes their row.
--
--   moderation_reports.reporter_id -> nullable, SET NULL (rule unchanged)
--       The rule already said SET NULL. The column being NOT NULL made that
--       impossible. This makes the schema able to do what it already claimed:
--       the abuse report survives as a safety record, the reporter does not.
--       Ruling 4 exactly — and it matters because a harassed user deleting their
--       account is the common case, and it must not destroy the report.
--
--   moderation_reports.resolver_id -> SET NULL
--       Already nullable. Which moderator closed a report is not needed once
--       they are gone; the resolution itself is the record.
--
--   post_edits.user_id             -> CASCADE
--       Edit history of a post. Ruling 3: the post is already deleted with the
--       account by delete_posts, so its edit trail is content about content that
--       no longer exists. Nothing else references it.
--
--   trip_plan_items.creator_id     -> nullable, SET NULL
--       A plan item inside a trip that other travellers share. Ruling 3's
--       tombstone case: erasing it would damage their itinerary. The item stays,
--       the creator does not.
--
-- ── CLIENT IMPACT, STATED RATHER THAN DISCOVERED LATER ──────────────────────
-- Three columns become nullable and will start returning null in API responses:
-- routes/events.ts selects added_by; routes/trips.ts selects creator_id; the
-- moderation surfaces select reporter_id. Clients must render an absent author
-- (a "Deleted user" affordance), not assume a uuid. No route filters or joins on
-- these columns today, so nothing breaks server-side — but a client that assumes
-- non-null will show a blank where a name was.
--
-- ── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────
-- 62 further NO ACTION / RESTRICT edges point at public.profiles. They do not
-- block anything today, because production's profiles row is anonymised rather
-- than deleted and so the parent delete never happens. They WOULD all become
-- blockers the moment production converges to the migration-defined
-- profiles -> auth.users ON DELETE CASCADE relationship. Converging without
-- fixing them first would move the failure rather than remove it. That set is
-- enumerated for the owner and is not touched here.
--
-- RUNTIME EFFECT BEFORE A DELETION RUNS: none. These rules only fire when an
-- auth user is deleted, and account_deletion_worker_enabled is false.
--
-- ── VERIFIED ON CI, 2026-08-23 ──────────────────────────────────────────────
-- Applied to portava-ci and exercised with a synthetic account holding a row in
-- every one of the five tables, plus a second "bystander" user who owned the
-- event and the trip. Result:
--
--   auth delete .......... SUCCEEDED (it aborted before this migration)
--   event_cohosts ........ row survives, added_by = NULL
--   moderation_reports ... row survives, reporter_id = NULL, resolver_id = NULL
--   post_edits ........... 0 rows — removed with the post
--   trip_plan_items ...... row survives, creator_id = NULL
--
-- Which is the ruling, executed: the bystander keeps their event and their
-- itinerary, the safety record keeps its substance and loses both identities,
-- and the departing user's own content goes.
--
-- ── AN ORDERING REQUIREMENT THIS EXPOSED ────────────────────────────────────
-- On a schema where profiles cascades from auth.users (CI today, production
-- after convergence), deleting the auth user cascades into intel_observations,
-- whose statement-level append-only trigger fires EVEN WHEN THE CASCADE WOULD
-- DELETE ZERO ROWS. So calling erase_intel_for_actor() and letting its
-- transaction end is not sufficient: portava.erasure_in_progress must remain
-- set for the transaction that deletes the auth user, or the delete aborts with
-- "intel_observations is append-only". The first probe failed exactly there.
-- This is not a defect — the trigger is doing its job — but the deletion worker
-- must hold the declaration across the auth delete, and that is a code change
-- that has to land before production converges.

BEGIN;

-- ── Preconditions ───────────────────────────────────────────────────────────
DO $$
DECLARE missing text := '';
BEGIN
  IF to_regclass('public.event_cohosts')      IS NULL THEN missing := missing || ' event_cohosts';      END IF;
  IF to_regclass('public.moderation_reports') IS NULL THEN missing := missing || ' moderation_reports'; END IF;
  IF to_regclass('public.post_edits')         IS NULL THEN missing := missing || ' post_edits';         END IF;
  IF to_regclass('public.trip_plan_items')    IS NULL THEN missing := missing || ' trip_plan_items';    END IF;
  IF missing <> '' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: missing table(s):%', missing;
  END IF;
END $$;

-- ── 1. event_cohosts.added_by — nullable, SET NULL ─────────────────────────
ALTER TABLE public.event_cohosts ALTER COLUMN added_by DROP NOT NULL;
ALTER TABLE public.event_cohosts DROP CONSTRAINT IF EXISTS event_cohosts_added_by_fkey;
ALTER TABLE public.event_cohosts
  ADD CONSTRAINT event_cohosts_added_by_fkey
  FOREIGN KEY (added_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- ── 2. moderation_reports.reporter_id — nullable so its SET NULL can fire ──
ALTER TABLE public.moderation_reports ALTER COLUMN reporter_id DROP NOT NULL;
ALTER TABLE public.moderation_reports DROP CONSTRAINT IF EXISTS moderation_reports_reporter_id_fkey;
ALTER TABLE public.moderation_reports
  ADD CONSTRAINT moderation_reports_reporter_id_fkey
  FOREIGN KEY (reporter_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- ── 3. moderation_reports.resolver_id — SET NULL ───────────────────────────
ALTER TABLE public.moderation_reports DROP CONSTRAINT IF EXISTS moderation_reports_resolver_id_fkey;
ALTER TABLE public.moderation_reports
  ADD CONSTRAINT moderation_reports_resolver_id_fkey
  FOREIGN KEY (resolver_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- ── 4. post_edits.user_id — CASCADE ────────────────────────────────────────
ALTER TABLE public.post_edits DROP CONSTRAINT IF EXISTS post_edits_user_id_fkey;
ALTER TABLE public.post_edits
  ADD CONSTRAINT post_edits_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- ── 5. trip_plan_items.creator_id — nullable, SET NULL ─────────────────────
ALTER TABLE public.trip_plan_items ALTER COLUMN creator_id DROP NOT NULL;
ALTER TABLE public.trip_plan_items DROP CONSTRAINT IF EXISTS trip_plan_items_creator_id_fkey;
ALTER TABLE public.trip_plan_items
  ADD CONSTRAINT trip_plan_items_creator_id_fkey
  FOREIGN KEY (creator_id) REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.event_cohosts.added_by IS
  'Who added this cohost. NULL once that person deletes their account — the cohost relationship belongs to the event and survives; the attribution does not.';
COMMENT ON COLUMN public.moderation_reports.reporter_id IS
  'Who filed the report. NULL once they delete their account. The report is retained as a safety record without them (owner ruling 4, 2026-08-23).';
COMMENT ON COLUMN public.trip_plan_items.creator_id IS
  'Who created this plan item. NULL once they delete their account — the item stays so other travellers keep their itinerary.';

-- ── Postconditions ──────────────────────────────────────────────────────────
-- Assert the rules AND the nullability, because a SET NULL onto a NOT NULL
-- column is exactly the defect this file exists to remove; re-creating it here
-- would be worse than leaving things alone.
DO $$
DECLARE
  bad text := '';
  r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col,
           c.confdeltype AS rule, a.attnotnull AS notnull
      FROM pg_constraint c
      JOIN unnest(c.conkey) k(attnum) ON TRUE
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
     WHERE c.contype='f'
       AND c.conname IN ('event_cohosts_added_by_fkey','moderation_reports_reporter_id_fkey',
                         'moderation_reports_resolver_id_fkey','post_edits_user_id_fkey',
                         'trip_plan_items_creator_id_fkey')
  LOOP
    IF r.rule = 'a' OR r.rule = 'r' THEN
      bad := bad || format(' %s.%s still NO ACTION/RESTRICT;', r.tbl, r.col);
    END IF;
    IF r.rule = 'n' AND r.notnull THEN
      bad := bad || format(' %s.%s is SET NULL onto a NOT NULL column;', r.tbl, r.col);
    END IF;
  END LOOP;

  IF bad <> '' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED:%', bad;
  END IF;

  IF (SELECT count(*) FROM pg_constraint
       WHERE conname IN ('event_cohosts_added_by_fkey','moderation_reports_reporter_id_fkey',
                         'moderation_reports_resolver_id_fkey','post_edits_user_id_fkey',
                         'trip_plan_items_creator_id_fkey')) <> 5 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected all 5 constraints present after rebuild';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERSAL
-- ═══════════════════════════════════════════════════════════════════════════
-- Restore the previous rules (which re-blocks account deletion — do this only
-- to unwind a bad apply, never as a resting state):
--   ALTER TABLE public.event_cohosts DROP CONSTRAINT event_cohosts_added_by_fkey;
--   ALTER TABLE public.event_cohosts ADD CONSTRAINT event_cohosts_added_by_fkey
--     FOREIGN KEY (added_by) REFERENCES auth.users(id);
--   ... and likewise for the other four.
-- Re-adding NOT NULL to the three widened columns requires that no row has yet
-- been severed; once a deletion has run, those nulls are the intended state and
-- the constraint cannot be restored without inventing data.
