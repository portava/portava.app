-- 2211_intel_mission_candidates_accepted_by_erasure_grant.sql
-- Let account deletion actually clear a departed user's uuid from an accepted mission.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). CI-APPLIED ONLY.
--
-- ── THE HOLE ─────────────────────────────────────────────────────────────────
-- intel_mission_candidates (migration 2167) records the mission-dispatch pipeline's
-- candidate questions. The row is an OPS record, not user content — but one column,
-- accepted_by, names the contributor who accepted the mission:
--   accepted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL   (2167 L48)
-- The FK's declared intent is unambiguous: when the referenced profile goes away,
-- NULL the identifier and keep the ops row. That SET NULL never fires. Account
-- deletion (executeAccountDeletion) keeps an ANONYMISED TOMBSTONE profile rather
-- than deleting profiles(id) — on production public.profiles has no FK that would
-- take the row with it — so no FK cascade or SET-NULL hanging off profiles ever
-- runs. This is the same tombstone-breaks-the-declared-FK-intent mistake migration
-- 2172 made for the consent row (corrected by 2203), 2170 made for the reward
-- ledger (corrected by 2204), and 2187 made for derived memory (corrected by 2190).
-- The departed user's uuid therefore SURVIVES in accepted_by — a residual identifier
-- in an operational record, still joinable to every other table keyed by that uuid,
-- long after the contributions that mission produced were erased by
-- erase_intel_for_actor().
--
-- ── THE FIX ──────────────────────────────────────────────────────────────────
-- AccountDeletionService now performs the SET NULL explicitly (step
-- `null_intel_mission_accepted_by`): update({ accepted_by: null }).eq('accepted_by', userId).
-- The ROW is retained (it is not the user's content — it is a city-scoped ops record
-- with no other user-identifying column); only the identifier is removed, which is
-- exactly what the FK's ON DELETE SET NULL declared should happen. This is the
-- 'anonymised / FK nulled' disposition, NOT a row erasure.
--
-- 2167 already granted service_role INSERT, SELECT, UPDATE (L65), so the UPDATE
-- above is already permitted at the grant layer. This migration REAFFIRMS that
-- UPDATE grant so the erasure step's authority is explicit and drift-tolerant:
-- the grant is restored even in an environment where 2167 was never applied, or
-- where a later change trimmed it. Nothing else may write the table: anon and
-- authenticated hold no grant (missions are not user-facing data), and no client
-- grant is added here.
--
-- DRIFT-TOLERANT: guarded on the table existing, so it is correct whether or not
-- 2167 has been applied in a given environment. Idempotent — safe to re-run.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.intel_mission_candidates') IS NOT NULL THEN
    GRANT UPDATE ON public.intel_mission_candidates TO service_role;
  END IF;
END $$;

-- ── Postcondition ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.intel_mission_candidates') IS NOT NULL
     AND NOT has_table_privilege('service_role', 'public.intel_mission_candidates', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role still lacks UPDATE on intel_mission_candidates — account deletion cannot NULL a departed user''s accepted_by.';
  END IF;
END $$;

COMMIT;

-- REVERSAL:
--   REVOKE UPDATE ON public.intel_mission_candidates FROM service_role;
-- Only reverse alongside removing the null_intel_mission_accepted_by deletion step,
-- and note that doing so also disables the pipeline's own accepted/expired/aborted
-- status writes — UPDATE is load-bearing for this table beyond erasure.
