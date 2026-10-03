-- Rollback for 2920_creator_attributions.sql
-- Written 2026-10-03 by the creator-ledger lane, completing the rollback set for
-- the seven-file creator-ledger rollout (2901, 2920, 2921, 2922, 3386, 3387, 3510);
-- 2920 and 2922 were the two with no rollback file.
-- Rehearsed on the local PostgreSQL 16 harness only (scripts/local-db/up.sh:
-- apply the chain, roll the dependents back newest-first, roll this back,
-- re-apply, catalogue diff).
-- NOT run against portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2920 DID
-- =============
--   * CREATE TABLE public.creator_rule_versions (two UNIQUE constraints
--     crv_version_unique / crv_instant_unique, CHECKs crv_creator_type_known /
--     crv_rule_version_shape, index crv_type_effective_idx, trigger crv_no_update
--     over 2130's intel_append_only(), RLS on, table/column COMMENTs,
--     service_role INSERT/SELECT only — deliberately no DELETE).
--   * CREATE TABLE public.creator_attributions (fifteen CHECKs, FK to
--     public.profiles(id) ON DELETE CASCADE, self-FK supersedes_id, seven
--     indexes — ca_idempotency_key_once, ca_one_supersede_per_row,
--     ca_type_subject_idx, ca_beneficiary_idx, ca_value_event_idx,
--     ca_rule_version_idx, ca_fraud_hold_idx — trigger ca_no_update over
--     intel_append_only(), RLS on, table/column COMMENTs, service_role
--     INSERT/SELECT/DELETE only, no client grant).
--   * REVOKE ALL on both tables from PUBLIC, anon, authenticated, service_role
--     before those grants.
--   * INSERT six creator_rule_versions rows, one per `07` §2 creator type
--     ('creator-rules/<type>/v1'), ON CONFLICT ON CONSTRAINT crv_version_unique
--     DO NOTHING.
--   * Created NO function. Created NO policy. Touched no other table's rows in
--     either direction — its own postconditions assert intel_reward_ledger and
--     rent_buddy_earnings_ledger were left exactly as found.
-- Everything above except the six seed rows lives inside the two tables, so
-- dropping them reverses the indexes, constraints, triggers, comments, RLS and
-- grants with them. 2130's intel_append_only() is NOT 2920's and is kept.
--
-- WHAT THIS ROLLBACK DOES, AND WHEN IT REFUSES
-- ============================================
-- Order is 2920's own: creator_attributions FIRST, then creator_rule_versions.
--
-- IT REFUSES WHILE ANYTHING IS BUILT ON THESE TABLES — it does not cascade. Roll
-- the dependents back first, newest first:
--   3510  its ca_erasure_policy_undecided trigger sits on creator_attributions;
--   3387  its triggers, creator_ledger_lock_attribution, creator_ledger_append
--         and creator_ledger_audit_events' two foreign keys all read them;
--   3386  its recommendation_id column, CHECK, index and trigger are ON
--         creator_attributions;
--   3385/2930  creator_share_ledger reads creator_earning_entries, which holds
--         the foreign key into creator_attributions;
--   2921  creator_earning_entries' attribution_id foreign key.
-- A DROP ... CASCADE here would silently take those with it, which is how a
-- rollback turns into a schema edit nobody reviewed.
--
-- IT REFUSES WHILE creator_attribution_enabled (2922) IS TRUE: the owner has
-- turned the writer on, and dropping its tables would fail every write. Turn it
-- off deliberately first. 2921's rollback refuses on the same condition.
--
-- IT REFUSES WHILE creator_attributions HOLDS A ROW. Those rows are the only
-- per-creator-type record of who contributed what (2920's own reversal note says
-- so); dropping the table destroys them. Keeping, anonymising or deleting them
-- is the owner's retention question (W10D-B0 / C-11), never a rollback.
--
-- IT REFUSES WHILE creator_rule_versions HOLDS A LINEAGE 2920 DID NOT SEED.
-- The table is append-only and service_role has no DELETE on it precisely so a
-- rule lineage cannot be made unreconstructable; a seventh row is a rule
-- somebody published after 2920, and dropping the table would do by rollback
-- what the missing privilege forbids. The six seeded lineages
-- ('creator-rules/<type>/v1') go with the table, as 2920 says.
--
-- With nothing built on them, the flag off, no attributions and only 2920's own
-- six lineages, it drops both tables and deletes 2920's ledger row.
-- Idempotent: every statement is existence-guarded and the postconditions pass
-- on an already-rolled-back database.
--
-- ⚠ WHAT THIS CANNOT REVERSE
-- ==========================
-- 2920 has a RECONCILE path: if both tables already existed with its exact
-- column set (an unrecorded rehearsal put them on portava-ci on 2026-09-14), it
-- re-asserts every object instead of creating anything, and its seed is
-- ON CONFLICT DO NOTHING so pre-existing lineage rows kept their own notes.
-- Nothing in the catalogue records which of the two paths ran. On a database
-- 2920 RECONCILED, this file drops tables 2920 did not create — that is not a
-- reversal and no SQL can tell the difference. The row guards above are the only
-- thing standing between the two cases, and they only help if those tables carry
-- rows. Before running this anywhere whose 2920 apply is not in
-- public.schema_migration_ledger, establish by hand which path ran.

BEGIN;

DO $pre$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.feature_flags') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.feature_flags
                  WHERE flag = 'creator_attribution_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2920): creator_attribution_enabled is TRUE; its writer records into these tables. Turn it off deliberately first.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ca_erasure_policy_undecided' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2920): 3510 is applied (ca_erasure_policy_undecided guards creator_attributions). Roll 3510 back first.';
  END IF;
  IF to_regprocedure('public.creator_ledger_append(jsonb)') IS NOT NULL
     OR to_regprocedure('public.creator_ledger_lock_attribution(uuid)') IS NOT NULL
     OR to_regclass('public.creator_ledger_audit_events') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2920): 3387 is applied (its audit table, lock function and triggers read these tables). Roll 3387 back first.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'creator_attributions' AND column_name = 'recommendation_id'
  ) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2920): 3386 is applied (creator_attributions.recommendation_id). Roll 3386 back first.';
  END IF;
  IF to_regclass('public.creator_share_ledger') IS NOT NULL THEN  -- nested: plpgsql does not short-circuit AND, and the cast needs the view
    IF pg_get_viewdef('public.creator_share_ledger'::regclass) LIKE '%creator_earning_entries%' THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (2920): creator_share_ledger reads creator_earning_entries, which keys into creator_attributions. Roll 3385 (and 2930) back first.';
    END IF;
  END IF;
  IF to_regclass('public.creator_earning_entries') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (2920): 2921 is applied (creator_earning_entries keys into creator_attributions). Roll 2921 back first.';
  END IF;

  IF to_regclass('public.creator_attributions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.creator_attributions' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (2920): creator_attributions holds % row(s). Dropping the table would destroy the only per-creator-type record of who contributed what; what happens to them is the owner''s retention decision (W10D-B0 / C-11). Nothing has been changed.', n;
    END IF;
  END IF;

  IF to_regclass('public.creator_rule_versions') IS NOT NULL THEN
    EXECUTE $q$SELECT count(*) FROM public.creator_rule_versions
                WHERE rule_version NOT IN (
                  'creator-rules/discovery-creator/v1', 'creator-rules/trail-builder/v1',
                  'creator-rules/local-expert/v1',      'creator-rules/itinerary-creator/v1',
                  'creator-rules/experience-host/v1',   'creator-rules/travel-partner/v1')$q$ INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (2920): creator_rule_versions holds % rule version(s) 2920 did not seed. The table is append-only and service_role has no DELETE on it so a lineage cannot be made unreconstructable; dropping it would do by rollback what that missing privilege forbids. Nothing has been changed.', n;
    END IF;
  END IF;
END
$pre$;

-- 2920's own stated order: creator_attributions first. It holds no foreign key
-- to creator_rule_versions (rule_version is a text stamp by design), so the
-- order is stated rather than enforced.
DROP TABLE IF EXISTS public.creator_attributions;
DROP TABLE IF EXISTS public.creator_rule_versions;

DO $ledger$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '2920_creator_attributions.sql';
  END IF;
END
$ledger$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE n int;
BEGIN
  IF to_regclass('public.creator_attributions') IS NOT NULL
     OR to_regclass('public.creator_rule_versions') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2920 rollback): a 2920 table still exists.';
  END IF;
  SELECT count(*) INTO n FROM pg_trigger
   WHERE NOT tgisinternal AND tgname IN ('ca_no_update', 'crv_no_update');
  IF n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2920 rollback): % of 2920''s triggers remain.', n;
  END IF;
  -- Objects 2920 depended on and did not create must survive it.
  IF to_regclass('public.profiles') IS NULL OR to_regprocedure('public.intel_append_only()') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2920 rollback): an object 2920 depended on (profiles, intel_append_only) is gone.';
  END IF;
  -- 2920 asserted it touched nothing in the two live ledgers; nor does this file.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.intel_reward_ledger'::regclass
     AND conname = 'intel_reward_ledger_cash_amount_check';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2920 rollback): intel_reward_ledger''s cash boundary is missing; neither 2920 nor its rollback may touch that table.';
  END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.rent_buddy_earnings_ledger'::regclass
     AND conname = 'rent_buddy_earnings_ledger_booking_id_key';
  IF n <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2920 rollback): rent_buddy_earnings_ledger was modified; neither 2920 nor its rollback may touch that table.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '2920_creator_attributions.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (2920 rollback): the ledger still records 2920 as applied.';
  END IF;
END
$post$;
