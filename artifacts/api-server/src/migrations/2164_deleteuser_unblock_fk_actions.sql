-- 2164_deleteuser_unblock_fk_actions.sql
--
-- ⚠ STAGED. Apply to portava-ci ONLY. DO NOT APPLY TO PRODUCTION without owner
--   approval — this changes account-deletion behaviour and is part of owner
--   decision D6 (deletion fate). It is the ruling-INDEPENDENT sub-fix.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
--
-- ── WHAT IS WRONG (from the D6 triage, verified on portava-ci) ───────────────
-- executeAccountDeletion keeps an ANONYMISED TOMBSTONE profile instead of
-- deleting profiles(id), so no FK cascade off profiles fires; every table is
-- cleared by hand. FOUR foreign keys to auth.users are ON DELETE NO ACTION and
-- are NOT cleared by the deletion service, so step 5's auth.admin.deleteUser is
-- REJECTED (SQLSTATE 23503) and the retry fails identically forever — account
-- deletion is hard-broken today, which also violates the IG spec's fail-closed
-- deletion requirement. These are provenance/actor references, not the primary
-- owner of their row.
--
-- ── FIX (least-destructive; unblocks deleteUser regardless of the D6 ruling) ──
-- Give each rejecting FK an ON DELETE action so the parent delete succeeds:
--   * SET NULL where the column is NULLABLE — the row is RETAINED with the
--     personal reference nulled (anonymised): who ADDED a co-host, who RESOLVED
--     a report, who CREATED a trip item is forgotten; the record survives.
--   * CASCADE for post_edits.user_id, which is NOT NULL and IS the deleted
--     user's own edit action — the edit is erased with the account.
-- The broader table-fate (retain-vs-erase for the ~229 tables that survive
-- deletion) stays with owner decision D6; this only stops the hard failure.
-- Additive, idempotent (DROP CONSTRAINT IF EXISTS then ADD). SAFE TO RE-RUN.

BEGIN;
DO $$ BEGIN
  IF to_regclass('public.event_cohosts') IS NULL
     OR to_regclass('public.moderation_reports') IS NULL
     OR to_regclass('public.trip_plan_items') IS NULL
     OR to_regclass('public.post_edits') IS NULL
    THEN RAISE EXCEPTION 'PRECONDITION FAILED: an expected table is missing'; END IF;
END $$;

ALTER TABLE public.event_cohosts    DROP CONSTRAINT IF EXISTS event_cohosts_added_by_fkey;
ALTER TABLE public.event_cohosts    ADD  CONSTRAINT event_cohosts_added_by_fkey
  FOREIGN KEY (added_by)   REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.moderation_reports DROP CONSTRAINT IF EXISTS moderation_reports_resolver_id_fkey;
ALTER TABLE public.moderation_reports ADD  CONSTRAINT moderation_reports_resolver_id_fkey
  FOREIGN KEY (resolver_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.trip_plan_items   DROP CONSTRAINT IF EXISTS trip_plan_items_creator_id_fkey;
ALTER TABLE public.trip_plan_items   ADD  CONSTRAINT trip_plan_items_creator_id_fkey
  FOREIGN KEY (creator_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.post_edits        DROP CONSTRAINT IF EXISTS post_edits_user_id_fkey;
ALTER TABLE public.post_edits        ADD  CONSTRAINT post_edits_user_id_fkey
  FOREIGN KEY (user_id)    REFERENCES auth.users(id) ON DELETE CASCADE;

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(t.relname||'.'||a.attname||'='||c.confdeltype::text, ', ') INTO bad
  FROM pg_constraint c
  JOIN pg_class t ON t.oid=c.conrelid AND t.relnamespace='public'::regnamespace
  JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
  WHERE c.conname IN ('event_cohosts_added_by_fkey','moderation_reports_resolver_id_fkey','trip_plan_items_creator_id_fkey','post_edits_user_id_fkey')
    AND NOT (
      (c.conname='post_edits_user_id_fkey' AND c.confdeltype='c') OR
      (c.conname<>'post_edits_user_id_fkey' AND c.confdeltype='n')
    );
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED: unexpected ON DELETE action: %', bad; END IF;
END $$;
COMMIT;
