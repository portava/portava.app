-- Rollback for 3600_creator_ledger_erasure_retain_pseudonymised.sql (C-11 answer B, chosen).
-- Written 2026-09-30 by the creator-ledger lane (census-discovery §107); promoted
-- with its migration on 2026-10-04 when the owner answered C-11.
-- Rehearsed only in the throwaway local-db harness and its clones
-- (src/test/db/creatorLedgerErasurePolicy.db.test.ts); never run against
-- portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- IT IS NOT A WAY BACK FROM AN ERASURE. It restores the SCHEMA, and only while
-- no erasure has used it: an identity removal is irreversible by construction
-- (no mapping from the pseudonym back to the person is stored anywhere), so the
-- first refusal below is the only honest behaviour once a single receipt exists.
--
-- Returns the schema to 3510's "undecided" state. It REFUSES while any row is
-- pseudonymised or any identity-removal receipt exists: dropping the pseudonym
-- columns would destroy the only grouping of a retained person's records, and
-- creator_attributions.beneficiary_user_id could not become NOT NULL again over
-- rows whose identity was removed. Nothing a removal did can be undone by a
-- rollback — no mapping back to the person exists, by design.
--
-- ONE THING IS DELIBERATELY NOT RESTORED (2026-10-07): 3600 makes
-- profiles.account_status server-only — it revokes the client roles'
-- UPDATE (account_status) and installs trg_profiles_account_status_privileged /
-- enforce_profile_account_status_privileged() — so that nobody can mark
-- themselves erased. No application path writes that column with a client key
-- (every writer is the service client), so undoing either would restore nothing
-- but a self-service write to the account-state column. Both stay.

BEGIN;

DO $pre$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM public.rent_buddy_earnings_entries WHERE beneficiary_pseudonym IS NOT NULL)
       + (SELECT count(*) FROM public.creator_attributions        WHERE beneficiary_pseudonym IS NOT NULL)
       + (SELECT count(*) FROM public.creator_earning_entries     WHERE beneficiary_pseudonym IS NOT NULL)
       + (SELECT count(*) FROM public.creator_ledger_audit_events WHERE actor_pseudonym IS NOT NULL)
       + (SELECT count(*) FROM public.creator_ledger_identity_removals)
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3600): % pseudonymised row(s) or identity-removal receipt(s) exist. Nothing has been changed.', n;
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.creator_ledger_remove_identity(uuid, text, uuid, text);
DROP TABLE IF EXISTS public.creator_ledger_identity_removals;

DROP TRIGGER IF EXISTS rbee_pseudonymised_is_frozen ON public.rent_buddy_earnings_entries;
DROP TRIGGER IF EXISTS ca_pseudonymised_is_frozen   ON public.creator_attributions;
DROP TRIGGER IF EXISTS cee_pseudonymised_is_frozen  ON public.creator_earning_entries;
DROP TRIGGER IF EXISTS clae_pseudonymised_is_frozen ON public.creator_ledger_audit_events;
DROP FUNCTION IF EXISTS public.creator_ledger_pseudonymised_is_frozen();

-- The append-only triggers go back to 2130's intel_append_only(), as 2901/2920/2921/3387 made them.
DROP TRIGGER IF EXISTS rbee_no_update ON public.rent_buddy_earnings_entries;
CREATE TRIGGER rbee_no_update BEFORE UPDATE ON public.rent_buddy_earnings_entries
  FOR EACH ROW EXECUTE FUNCTION public.intel_append_only();
DROP TRIGGER IF EXISTS ca_no_update ON public.creator_attributions;
CREATE TRIGGER ca_no_update BEFORE UPDATE ON public.creator_attributions
  FOR EACH ROW EXECUTE FUNCTION public.intel_append_only();
DROP TRIGGER IF EXISTS cee_no_update ON public.creator_earning_entries;
CREATE TRIGGER cee_no_update BEFORE UPDATE ON public.creator_earning_entries
  FOR EACH ROW EXECUTE FUNCTION public.intel_append_only();
DROP TRIGGER IF EXISTS clae_no_update ON public.creator_ledger_audit_events;
CREATE TRIGGER clae_no_update BEFORE UPDATE ON public.creator_ledger_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.intel_append_only();
DROP FUNCTION IF EXISTS public.creator_ledger_append_only_except_identity_removal();
DROP FUNCTION IF EXISTS public.creator_ledger_identity_substitution(jsonb, text, text);

ALTER TABLE public.creator_attributions        DROP CONSTRAINT IF EXISTS ca_one_beneficiary_identity;
ALTER TABLE public.rent_buddy_earnings_entries DROP CONSTRAINT IF EXISTS rbee_at_most_one_beneficiary_identity;
ALTER TABLE public.creator_earning_entries     DROP CONSTRAINT IF EXISTS cee_at_most_one_beneficiary_identity;
ALTER TABLE public.creator_ledger_audit_events DROP CONSTRAINT IF EXISTS clae_at_most_one_actor_identity;
ALTER TABLE public.rent_buddy_earnings_entries DROP COLUMN IF EXISTS beneficiary_pseudonym;
ALTER TABLE public.creator_attributions        DROP COLUMN IF EXISTS beneficiary_pseudonym;
ALTER TABLE public.creator_earning_entries     DROP COLUMN IF EXISTS beneficiary_pseudonym;
ALTER TABLE public.creator_ledger_audit_events DROP COLUMN IF EXISTS actor_pseudonym;
ALTER TABLE public.creator_attributions ALTER COLUMN beneficiary_user_id SET NOT NULL;

DROP TRIGGER IF EXISTS rbee_retained_on_erasure ON public.rent_buddy_earnings_entries;
DROP TRIGGER IF EXISTS ca_retained_on_erasure   ON public.creator_attributions;
DROP TRIGGER IF EXISTS cee_retained_on_erasure  ON public.creator_earning_entries;
DROP TRIGGER IF EXISTS clae_retained_on_erasure ON public.creator_ledger_audit_events;
DROP FUNCTION IF EXISTS public.creator_ledger_retained_on_erasure();

-- 3510's guard, byte-for-byte in behaviour (the function body is 3510's).
CREATE OR REPLACE FUNCTION public.creator_ledger_erasure_policy_undecided()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $fn$
BEGIN
  RAISE EXCEPTION
    'creator_ledger_erasure_policy_undecided — % row % was not deleted: whether earning records are deleted or retained pseudonymised when an account is erased is an open owner decision (C-11, W10D-B0)',
    TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'CL451',
          DETAIL = 'Every DELETE of a creator or Rent-a-Buddy ledger row is refused until the owner chooses: by a profile''s erasure, a booking''s deletion, an attribution''s cascade or directly.',
          HINT = 'Nothing was deleted. The two answers are held in reconciliation-staging/3511 (delete on erasure) and 3512 (retain, pseudonymised); census-discovery §107.';
END;
$fn$;
REVOKE ALL ON FUNCTION public.creator_ledger_erasure_policy_undecided() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.creator_ledger_erasure_policy_undecided() FROM anon, authenticated;
CREATE TRIGGER rbee_erasure_policy_undecided BEFORE DELETE ON public.rent_buddy_earnings_entries
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_erasure_policy_undecided();
CREATE TRIGGER ca_erasure_policy_undecided BEFORE DELETE ON public.creator_attributions
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_erasure_policy_undecided();
CREATE TRIGGER cee_erasure_policy_undecided BEFORE DELETE ON public.creator_earning_entries
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_erasure_policy_undecided();
CREATE TRIGGER clae_erasure_policy_undecided BEFORE DELETE ON public.creator_ledger_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_erasure_policy_undecided();

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger WHERE filename = '3600_creator_ledger_erasure_retain_pseudonymised.sql';
  END IF;
END $$;

COMMIT;

DO $post$
DECLARE n int;
BEGIN
  IF to_regprocedure('public.creator_ledger_remove_identity(uuid,text,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3600 rollback): the identity-removal door still exists.';
  END IF;
  SELECT count(*) INTO n FROM pg_trigger
   WHERE NOT tgisinternal AND tgfoid = 'public.creator_ledger_erasure_policy_undecided()'::regprocedure;
  IF n <> 4 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3600 rollback): 3510''s guard is on % of 4 tables.', n; END IF;
  SELECT count(*) INTO n FROM pg_trigger
   WHERE NOT tgisinternal AND tgfoid = 'public.intel_append_only()'::regprocedure
     AND tgname IN ('rbee_no_update', 'ca_no_update', 'cee_no_update', 'clae_no_update');
  IF n <> 4 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3600 rollback): % of 4 append-only triggers restored.', n; END IF;
END $post$;
