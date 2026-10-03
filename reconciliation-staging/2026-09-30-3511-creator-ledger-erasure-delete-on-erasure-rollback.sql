-- Rollback for 3511_creator_ledger_erasure_delete_on_erasure.sql (HELD — C-11 answer A).
-- Written 2026-09-30 by the creator-ledger lane (census-discovery §107).
-- Rehearsed only inside fixture A's throwaway database
-- (src/test/db/creatorLedgerErasurePolicy.db.test.ts); never run against
-- portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- Returns the schema to 3510's "undecided" state: drops answer A's rule, the
-- whole-transaction trigger, the erase door and the receipt table; restores
-- rbee.reverses_entry_id to 2901's NO ACTION; re-grants service_role DELETE as
-- 2901/2920/2921/3387 had it; re-installs 3510's guard exactly.
--
-- It REFUSES while creator_ledger_erasures holds a row: those receipts are the
-- only record that an erasure was performed, and dropping them would leave no
-- trace that records were deleted. Rows already deleted are not restored by any
-- rollback — that is what A means.

BEGIN;

DO $pre$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.creator_ledger_erasures') IS NOT NULL THEN
    SELECT count(*) INTO n FROM public.creator_ledger_erasures;
    IF n > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3511): creator_ledger_erasures holds % receipt(s) of performed erasures. Nothing has been changed.', n;
    END IF;
  END IF;
END
$pre$;

DROP TRIGGER IF EXISTS rbee_delete_on_erasure_only ON public.rent_buddy_earnings_entries;
DROP TRIGGER IF EXISTS ca_delete_on_erasure_only   ON public.creator_attributions;
DROP TRIGGER IF EXISTS cee_delete_on_erasure_only  ON public.creator_earning_entries;
DROP TRIGGER IF EXISTS clae_delete_on_erasure_only ON public.creator_ledger_audit_events;
DROP TRIGGER IF EXISTS rbee_erase_whole_transaction ON public.rent_buddy_earnings_entries;
DROP FUNCTION IF EXISTS public.creator_ledger_delete_on_erasure_only();
DROP FUNCTION IF EXISTS public.creator_ledger_rbee_erase_whole_transaction();
DROP FUNCTION IF EXISTS public.creator_ledger_erase_beneficiary(uuid, text, uuid, text);
DROP TABLE IF EXISTS public.creator_ledger_erasures;

DO $fk$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.rent_buddy_earnings_entries'::regclass
                AND conname = 'rbee_reverses_entry_fk') THEN
    ALTER TABLE public.rent_buddy_earnings_entries DROP CONSTRAINT rbee_reverses_entry_fk;
    ALTER TABLE public.rent_buddy_earnings_entries
      ADD CONSTRAINT rent_buddy_earnings_entries_reverses_entry_id_fkey FOREIGN KEY (reverses_entry_id)
      REFERENCES public.rent_buddy_earnings_entries(id);
  END IF;
END
$fk$;

GRANT DELETE ON public.rent_buddy_earnings_entries TO service_role;
GRANT DELETE ON public.creator_attributions        TO service_role;
GRANT DELETE ON public.creator_earning_entries     TO service_role;
GRANT DELETE ON public.creator_ledger_audit_events TO service_role;

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
    DELETE FROM public.schema_migration_ledger WHERE filename = '3511_creator_ledger_erasure_delete_on_erasure.sql';
  END IF;
END $$;

COMMIT;

DO $post$
DECLARE n int;
BEGIN
  IF to_regprocedure('public.creator_ledger_erase_beneficiary(uuid,text,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3511 rollback): the erase door still exists.';
  END IF;
  SELECT count(*) INTO n FROM pg_trigger
   WHERE NOT tgisinternal AND tgfoid = 'public.creator_ledger_erasure_policy_undecided()'::regprocedure;
  IF n <> 4 THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3511 rollback): 3510''s guard is on % of 4 tables.', n; END IF;
END $post$;
