-- 3510_creator_ledger_erasure_policy_undecided.sql
-- census-discovery §107 (C-11 / W10D-B0; §52.2 item 3). Depends on 2901, 2920,
-- 2921 and 3387.
--
-- ── WHAT IS WRONG TODAY ─────────────────────────────────────────────────────
-- Whether a person's earning records are DELETED when their account is erased,
-- or RETAINED with the identity removed, is an open owner decision (C-11,
-- docs/ops/discovery-owner-approval-request.md question 22(a)). The schema
-- nevertheless already answers it, twice, and inconsistently:
--
--   * 2901 rent_buddy_earnings_entries.beneficiary_user_id … ON DELETE SET NULL.
--     PostgreSQL executes SET NULL as an UPDATE, and rbee_no_update
--     (intel_append_only) refuses every UPDATE. So erasing any buddy with an
--     earning fails with "rent_buddy_earnings_entries is append-only: UPDATE is
--     not permitted", which names the wrong cause and decides nothing on purpose.
--   * 2920 creator_attributions.beneficiary_user_id … ON DELETE CASCADE, and 3387
--     makes creator_earning_entries' two keys CASCADE too, and
--     creator_ledger_audit_events cascades from the attribution. So erasing a
--     creator silently DELETES their whole creator ledger: "delete on erasure",
--     the policy nobody has chosen.
--
-- ── WHAT THIS FILE DOES: IT REFUSES, AND DECIDES NOTHING ────────────────────
--   (1) rent_buddy_earnings_entries' beneficiary key becomes ON DELETE CASCADE,
--       like its two sibling ledgers, so an erasure reaches the ledger as a
--       DELETE and meets (2), instead of an UPDATE that fails for an unrelated
--       reason. On its own that would delete; (2) is what stops it.
--   (2) A ROW-LEVEL BEFORE DELETE guard on all four ledger tables
--       (rent_buddy_earnings_entries, creator_attributions,
--       creator_earning_entries, creator_ledger_audit_events) that refuses
--       every DELETE with SQLSTATE CL451 and a message naming C-11. It fires
--       for every path that could remove a ledger row: the profile's cascade,
--       the booking's cascade (a TRAVELLER's erasure deletes their booking,
--       which cascades into the BUDDY's earning entries), the attribution's
--       cascade, and a direct DELETE by any role.
--
-- WHY THIS IMPOSES NO POLICY. Its only effect is that a ledger row cannot be
-- deleted. It deletes nothing, keeps nothing that was not already kept, and
-- rewrites nothing:
--   * a person with NO ledger row is unaffected — the guard is ROW-level and so
--     never fires for them (2292_intel_stmt_trigger_removal_ig_campaign.sql:20-32
--     is why it is not statement-level: a statement-level append-only trigger
--     made users with no rows undeletable);
--   * a person WITH ledger rows keeps exactly those rows, identity and all,
--     until the owner chooses. That is the state every such row is in before
--     this file too, except that 3387's cascade could delete them;
--   * the application's own erasure (services/accountDeletion/AccountDeletionService.ts)
--     keeps an anonymised tombstone profile and never deletes a profiles row,
--     so it never reaches this guard at all. It does not name any ledger table
--     either; wiring the chosen policy into it is the integration step after
--     the decision, not something this file does.
--   * On every database this file can reach the four tables hold ZERO rows:
--     creator_attribution_enabled (2922) and rent_buddy_enabled (2210) are FALSE,
--     and Rent-a-Buddy booking creation is hard-blocked (lib/rentBuddyKycGate.ts).
--     So on the day it is applied it refuses nothing that exists.
--
-- THE TWO ANSWERS ARE WRITTEN AND HELD, NOT APPLIED. Each is a complete
-- migration with its own rollback, rehearsed in its own throwaway database by
-- src/test/db/creatorLedgerErasurePolicy.db.test.ts, and kept OUT of the
-- canonical chain in reconciliation-staging/ (check:frozen-dir allowlists that
-- directory as "proposals awaiting owner review/apply"):
--   A  reconciliation-staging/3511_creator_ledger_erasure_delete_on_erasure.sql
--   B  reconciliation-staging/3512_creator_ledger_erasure_retain_pseudonymised.sql
-- The owner's answer promotes exactly one of them into this directory (at the
-- next free prefix after this file), and it replaces this guard.
--
-- NOT A CORRECTION PATH. Nothing here was ever a way to fix a wrong entry;
-- corrections are new rows (2901, 2921, 3387). The DELETE grants 2901/2920/
-- 2921/3387 gave service_role are left exactly as they are: the cascades they
-- were granted "for" run as the table owner anyway, and changing a grant is one
-- of the answers' business (A revokes them).
--
-- RUNTIME EFFECT: none on any existing surface. No reader or writer deletes
-- from these tables.
--
-- Rollback: db/rollback/2026-09-30-3510-creator-ledger-erasure-policy-undecided-rollback.sql
-- (refuses while any of the four tables holds a row: removing the guard then
-- would hand those rows to 3387's cascade, i.e. choose "delete" by default).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.rent_buddy_earnings_entries') IS NULL
     OR to_regclass('public.creator_attributions') IS NULL
     OR to_regclass('public.creator_earning_entries') IS NULL THEN
    RAISE EXCEPTION '3510: PRECONDITION FAILED: 2901, 2920 and 2921 must be applied first.';
  END IF;
  IF to_regclass('public.creator_ledger_audit_events') IS NULL THEN
    RAISE EXCEPTION '3510: PRECONDITION FAILED: public.creator_ledger_audit_events is absent (3387 not applied).';
  END IF;
  -- Refuse to re-impose "undecided" over an answer that has been applied.
  IF to_regprocedure('public.creator_ledger_erase_beneficiary(uuid,text,uuid,text)') IS NOT NULL
     OR to_regprocedure('public.creator_ledger_remove_identity(uuid,text,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION '3510: PRECONDITION FAILED: a C-11 answer (3511 or 3512) is already applied; this guard would contradict it.';
  END IF;
END
$pre$;

-- ═══════════════════════════════════════════════════════════════════════════
-- (1) 2901's beneficiary key: SET NULL (an UPDATE the ledger refuses) -> CASCADE.
-- ═══════════════════════════════════════════════════════════════════════════
DO $fk$
DECLARE
  att smallint;
  cname text;
  deltype "char";
BEGIN
  SELECT attnum INTO att FROM pg_attribute
   WHERE attrelid = 'public.rent_buddy_earnings_entries'::regclass AND attname = 'beneficiary_user_id';
  SELECT conname, confdeltype INTO cname, deltype FROM pg_constraint
   WHERE conrelid = 'public.rent_buddy_earnings_entries'::regclass AND contype = 'f'
     AND conkey = ARRAY[att]
     AND confrelid = 'public.profiles'::regclass;
  IF cname IS NULL THEN
    RAISE EXCEPTION '3510: the beneficiary_user_id foreign key is absent from rent_buddy_earnings_entries';
  END IF;
  IF deltype <> 'c' THEN
    EXECUTE format('ALTER TABLE public.rent_buddy_earnings_entries DROP CONSTRAINT %I', cname);
    ALTER TABLE public.rent_buddy_earnings_entries
      ADD CONSTRAINT rbee_beneficiary_fk FOREIGN KEY (beneficiary_user_id)
      REFERENCES public.profiles(id) ON DELETE CASCADE;
    RAISE NOTICE '3510: % replaced by rbee_beneficiary_fk ON DELETE CASCADE (held by the erasure guard below)', cname;
  END IF;
END
$fk$;

-- ═══════════════════════════════════════════════════════════════════════════
-- (2) The guard: no ledger row is deleted while C-11 is open.
-- ═══════════════════════════════════════════════════════════════════════════
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
COMMENT ON FUNCTION public.creator_ledger_erasure_policy_undecided() IS
  '3510: C-11 is undecided, so no creator / Rent-a-Buddy ledger row may be deleted by any path. Row-level BEFORE DELETE only: a person with no ledger row is never affected. SQLSTATE CL451. Replaced by whichever held answer (3511 delete on erasure, 3512 retain pseudonymised) the owner chooses.';
REVOKE ALL ON FUNCTION public.creator_ledger_erasure_policy_undecided() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.creator_ledger_erasure_policy_undecided() FROM anon, authenticated;

DROP TRIGGER IF EXISTS rbee_erasure_policy_undecided ON public.rent_buddy_earnings_entries;
CREATE TRIGGER rbee_erasure_policy_undecided
  BEFORE DELETE ON public.rent_buddy_earnings_entries
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_erasure_policy_undecided();

DROP TRIGGER IF EXISTS ca_erasure_policy_undecided ON public.creator_attributions;
CREATE TRIGGER ca_erasure_policy_undecided
  BEFORE DELETE ON public.creator_attributions
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_erasure_policy_undecided();

DROP TRIGGER IF EXISTS cee_erasure_policy_undecided ON public.creator_earning_entries;
CREATE TRIGGER cee_erasure_policy_undecided
  BEFORE DELETE ON public.creator_earning_entries
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_erasure_policy_undecided();

DROP TRIGGER IF EXISTS clae_erasure_policy_undecided ON public.creator_ledger_audit_events;
CREATE TRIGGER clae_erasure_policy_undecided
  BEFORE DELETE ON public.creator_ledger_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_erasure_policy_undecided();

-- ── Postconditions (assertion only) ─────────────────────────────────────────
DO $post$
DECLARE n int;
BEGIN
  -- The guard is on all four tables, row-level, BEFORE DELETE, enabled.
  SELECT count(*) INTO n FROM pg_trigger t
   WHERE NOT t.tgisinternal
     AND t.tgfoid = 'public.creator_ledger_erasure_policy_undecided()'::regprocedure
     AND t.tgenabled = 'O'
     AND (t.tgtype & 1) = 1      -- ROW
     AND (t.tgtype & 2) = 2      -- BEFORE
     AND (t.tgtype & 8) = 8      -- DELETE
     AND t.tgrelid IN ('public.rent_buddy_earnings_entries'::regclass, 'public.creator_attributions'::regclass,
                       'public.creator_earning_entries'::regclass, 'public.creator_ledger_audit_events'::regclass);
  IF n <> 4 THEN
    RAISE EXCEPTION '3510: POSTCONDITION FAILED: the erasure guard is on % of the 4 ledger tables', n;
  END IF;

  -- Never a statement-level DELETE trigger on these tables (2292): it would
  -- refuse the erasure of a person who has no ledger row at all.
  SELECT count(*) INTO n FROM pg_trigger t
   WHERE NOT t.tgisinternal AND (t.tgtype & 1) = 0 AND (t.tgtype & 8) = 8
     AND t.tgrelid IN ('public.rent_buddy_earnings_entries'::regclass, 'public.creator_attributions'::regclass,
                       'public.creator_earning_entries'::regclass, 'public.creator_ledger_audit_events'::regclass);
  IF n <> 0 THEN
    RAISE EXCEPTION '3510: POSTCONDITION FAILED: % statement-level DELETE trigger(s) on a ledger table', n;
  END IF;

  -- No key from a ledger table to profiles may SET NULL / SET DEFAULT: that is
  -- an UPDATE, which every one of these append-only tables refuses.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype = 'f' AND confdeltype IN ('n', 'd')
     AND conrelid IN ('public.rent_buddy_earnings_entries'::regclass, 'public.creator_attributions'::regclass,
                      'public.creator_earning_entries'::regclass, 'public.creator_ledger_audit_events'::regclass);
  IF n <> 0 THEN
    RAISE EXCEPTION '3510: POSTCONDITION FAILED: % SET NULL / SET DEFAULT key(s) remain on a ledger table', n;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.rent_buddy_earnings_entries'::regclass AND contype = 'f'
     AND confrelid = 'public.profiles'::regclass AND confdeltype = 'c';
  IF n <> 1 THEN
    RAISE EXCEPTION '3510: POSTCONDITION FAILED: rent_buddy_earnings_entries'' beneficiary key does not route erasure into the guard';
  END IF;

  IF has_function_privilege('anon', 'public.creator_ledger_erasure_policy_undecided()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.creator_ledger_erasure_policy_undecided()', 'EXECUTE') THEN
    RAISE EXCEPTION '3510: POSTCONDITION FAILED: a client role can execute the guard function';
  END IF;
  SELECT count(*) INTO n FROM pg_proc
   WHERE oid = 'public.creator_ledger_erasure_policy_undecided()'::regprocedure AND prosecdef;
  IF n <> 0 THEN RAISE EXCEPTION '3510: POSTCONDITION FAILED: the guard function is SECURITY DEFINER'; END IF;
END
$post$;

-- ── Probe: PROVE the refusal rather than assert it ──────────────────────────
-- A seam attribution for an existing profile, then its DELETE, inside a block
-- that is always rolled back (sentinel CL999), so nothing persists either way.
DO $probe$
DECLARE probe_user uuid; probe_id uuid; in_force text; refused boolean := false;
BEGIN
  SELECT p.id INTO probe_user FROM public.profiles p LIMIT 1;
  -- 3387 requires an original row to carry the version in force now.
  SELECT v.rule_version INTO in_force FROM public.creator_rule_versions v
   WHERE v.creator_type = 'trail_builder' AND v.effective_from <= now()
   ORDER BY v.effective_from DESC LIMIT 1;
  IF probe_user IS NULL THEN
    RAISE WARNING '3510: erasure-guard probe SKIPPED — public.profiles is empty on this database';
    RETURN;
  END IF;
  BEGIN
    INSERT INTO public.creator_attributions
      (creator_type, subject_kind, subject_id, value_event, value_event_id,
       attribution_basis, beneficiary_user_id, rule_version, idempotency_key)
    VALUES
      ('trail_builder', 'trail', gen_random_uuid(), 'route_completion', NULL,
       'seam_no_producer', probe_user, in_force, '3510-postcondition-probe')
    RETURNING id INTO probe_id;
    BEGIN
      DELETE FROM public.creator_attributions WHERE id = probe_id;
    EXCEPTION WHEN SQLSTATE 'CL451' THEN
      refused := true;
    END;
    RAISE EXCEPTION USING ERRCODE = 'CL999', MESSAGE = '3510 probe rollback';
  EXCEPTION WHEN SQLSTATE 'CL999' THEN
    NULL;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION '3510: POSTCONDITION FAILED: a ledger row was deleted while C-11 is undecided';
  END IF;
END
$probe$;

COMMIT;
