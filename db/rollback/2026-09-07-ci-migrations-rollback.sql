-- Rollback set for the five migrations applied by hand to portava-ci
-- (project ref hwokxgbmezheskbzskfr) on 2026-09-07.
--
-- WHY THESE WERE APPLIED BY HAND
-- ==============================
-- CI's `schema drift` job runs `db:apply-migrations:dry-run` (which writes
-- NOTHING) and then `audit:schema`, which fails if a migration file claims an
-- object that is absent from the live database. So a PR that adds a migration
-- is red by construction until that migration is applied out-of-band. These
-- five were blocking PRs #456, #457, #461, #470, #472 and #475.
--
-- HOW TO USE
-- ==========
-- Each section is independent and idempotent. Run ONLY the section you want.
-- Sections are listed in REVERSE dependency order: if you are undoing more than
-- one, run them top to bottom as written here.
--
-- SAFETY: every DROP below is guarded with IF EXISTS. None of these tables had
-- any writer in the application at the time of apply (all five are inert by
-- construction), so dropping them cannot orphan live application state. The two
-- exceptions that touch PRE-EXISTING objects are called out loudly in
-- sections 2325 and 2313 — read those before running them.

-- ═════════════════════════════════════════════════════════════════════════════
-- 2320_memory_episode_provenance_spine  — PR #470
-- Drops two new tables and RESTORES the previous erase_memory_for_user.
-- ═════════════════════════════════════════════════════════════════════════════
BEGIN;

DROP TABLE IF EXISTS public.memory_evidence;
DROP TABLE IF EXISTS public.memory_episodes;
DROP FUNCTION IF EXISTS public.memory_evidence_no_update();

-- 2320 replaced erase_memory_for_user with a 5-column version. Restore 2190's
-- 3-column signature, or account deletion loses its memory purge entirely.
DROP FUNCTION IF EXISTS public.erase_memory_for_user(uuid);

CREATE FUNCTION public.erase_memory_for_user(p_user_id uuid)
RETURNS TABLE (
  projections_deleted integer,
  events_deleted      integer,
  feedback_deleted    integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  p_del integer := 0;
  e_del integer := 0;
  f_del integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0; RETURN;
  END IF;

  WITH d AS (DELETE FROM public.memory_feedback WHERE user_id = p_user_id RETURNING 1)
  SELECT count(*)::int INTO f_del FROM d;

  WITH d AS (DELETE FROM public.memory_projections WHERE user_id = p_user_id RETURNING 1)
  SELECT count(*)::int INTO p_del FROM d;

  WITH d AS (DELETE FROM public.memory_events WHERE user_id = p_user_id RETURNING 1)
  SELECT count(*)::int INTO e_del FROM d;

  RETURN QUERY SELECT p_del, e_del, f_del;
END
$fn$;

-- 2190's least-privilege block. Supabase's ALTER DEFAULT PRIVILEGES grants
-- EXECUTE on every NEW public function to anon AND authenticated, so this
-- revoke MUST follow every DROP/CREATE or the function is world-executable.
REVOKE ALL ON FUNCTION public.erase_memory_for_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erase_memory_for_user(uuid) TO service_role;

DELETE FROM public.schema_migration_ledger
 WHERE filename = '2320_memory_episode_provenance_spine.sql';

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2325_telegraph_unsend_before_seen  — PR #472
-- ⚠ TOUCHES A PRE-EXISTING TABLE: drops a COLUMN from public.messages.
-- Any row that was unsent will lose its unsent_at marker. Those rows keep
-- deleted_at, so they stay suppressed — they just become indistinguishable
-- from ordinary deletes. Data loss is limited to that distinction.
-- ═════════════════════════════════════════════════════════════════════════════
BEGIN;

DROP FUNCTION IF EXISTS public.telegraph_unsend_message_before_seen(uuid, uuid, uuid);
DROP INDEX  IF EXISTS public.messages_unsent_at_idx;
ALTER TABLE public.messages DROP COLUMN IF EXISTS unsent_at;

DELETE FROM public.schema_migration_ledger
 WHERE filename = '2325_telegraph_unsend_before_seen.sql';

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2315_sensing_anon_contributions  — PR #475
-- Fully self-contained: one new table, two new functions, no pre-existing
-- object touched.
-- ═════════════════════════════════════════════════════════════════════════════
BEGIN;

DROP FUNCTION IF EXISTS public.revoke_sensing_contributions(bigint, text);
DROP FUNCTION IF EXISTS public.purge_expired_sensing_contributions(timestamptz);
DROP TABLE    IF EXISTS public.sensing_anon_contributions;

DELETE FROM public.schema_migration_ledger
 WHERE filename = '2315_sensing_anon_contributions.sql';

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2313_highlights_permanent  — PR #461
-- ⚠ TOUCHES A PRE-EXISTING TABLE: restores the NOT NULL on highlights.expires_at
-- and reinstates the two prior SELECT policies.
--
-- ⚠ THE NOT NULL RESTORE WILL FAIL if any permanent Highlight (expires_at IS
--   NULL) has been created since the migration was applied. That is deliberate
--   — it refuses rather than destroying the rows. If it fails, decide what those
--   rows should become before re-running; do NOT blanket-UPDATE them to a date.
--
-- ⚠ SCHEMA NOTE: the authorization predicates live in the `authz` schema
--   (authz.in_accepted_circle, authz.is_blocked), NOT `public`. public.viewer_is_blocked
--   does live in public. The committed migration file in PR #461 writes
--   `public.in_accepted_circle` / `public.is_blocked`, which do not exist on
--   portava-ci — that is why it was applied here with the authz prefix, and it
--   is a real defect in the PR that must be fixed before the file is trusted.
-- ═════════════════════════════════════════════════════════════════════════════
BEGIN;

DROP INDEX IF EXISTS public.highlights_owner_archive_idx;

ALTER TABLE public.highlights
  DROP CONSTRAINT IF EXISTS highlights_expiry_is_permanent_or_dated;

-- Prior policy bodies, restored verbatim as they stood before 2313.
DROP POLICY IF EXISTS highlights_select ON public.highlights;
CREATE POLICY highlights_select ON public.highlights FOR SELECT USING (
  (deleted_at IS NULL) AND (expires_at > now()) AND (
    (owner_id = auth.uid())
    OR ((NOT public.viewer_is_blocked(owner_id)) AND (
      (visibility = ANY (ARRAY['public'::text, 'travelers_nearby'::text]))
      OR ((visibility = 'circle_only'::text) AND (
        authz.in_accepted_circle(auth.uid(), owner_id)
        OR (EXISTS (
          SELECT 1 FROM public.user_friendships
          WHERE (((user_friendships.user_a = auth.uid()) AND (user_friendships.user_b = highlights.owner_id))
              OR ((user_friendships.user_b = auth.uid()) AND (user_friendships.user_a = highlights.owner_id)))
        ))
      ))
    ))
  )
);

DROP POLICY IF EXISTS highlights_select_active ON public.highlights;
CREATE POLICY highlights_select_active ON public.highlights FOR SELECT TO authenticated USING (
  (deleted_at IS NULL) AND (expires_at > now())
  AND (NOT authz.is_blocked(auth.uid(), owner_id))
  AND (
    (owner_id = auth.uid())
    OR (visibility = ANY (ARRAY['public'::text, 'travelers_nearby'::text]))
    OR ((visibility = 'circle_only'::text) AND (EXISTS (
      SELECT 1 FROM public.circle_memberships cm
      WHERE ((cm.user_id = highlights.owner_id) AND (cm.other_id = auth.uid()))
    )))
    OR ((visibility = 'trip_only'::text) AND (EXISTS (
      SELECT 1 FROM (public.trip_members tm1 JOIN public.trip_members tm2 ON ((tm1.trip_id = tm2.trip_id)))
      WHERE ((tm1.user_id = highlights.owner_id) AND (tm2.user_id = auth.uid()))
    )))
  )
);

-- Refuses if a permanent Highlight exists. See the warning above.
ALTER TABLE public.highlights ALTER COLUMN expires_at SET NOT NULL;

DELETE FROM public.schema_migration_ledger
 WHERE filename = '2313_highlights_permanent.sql';

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2311_intel_claim_reviews  — PRs #456 / #457
-- Fully self-contained: one new table. The FK to intel_claims is ON DELETE
-- CASCADE inbound only, so dropping it cannot affect intel_claims.
-- ═════════════════════════════════════════════════════════════════════════════
BEGIN;

DROP TABLE IF EXISTS public.intel_claim_reviews;

DELETE FROM public.schema_migration_ledger
 WHERE filename = '2311_intel_claim_reviews.sql';

COMMIT;
