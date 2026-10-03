-- 3511_creator_ledger_erasure_delete_on_erasure.sql
-- HELD — C-11 ANSWER A: "DELETE ON ERASURE". NOT IN THE CANONICAL CHAIN.
-- census-discovery §107. Owner decision C-11 / W10D-B0 (question 22(a)).
--
-- STATUS. This file is one of two complete, mutually exclusive answers to C-11.
-- It is kept in reconciliation-staging/ ("proposals awaiting owner review/apply",
-- check:frozen-dir) so that no database applies it until the owner chooses it.
-- If the owner answers "delete on erasure", move it UNCHANGED into
-- artifacts/api-server/src/migrations/ at the next free prefix after 3510
-- (renumber the filename only if 3511 has been taken meanwhile), with its
-- rollback (reconciliation-staging/2026-09-30-3511-…-rollback.sql) moved to
-- db/rollback/. The other answer, 3512, is then discarded. It is rehearsed in
-- its own throwaway database by src/test/db/creatorLedgerErasurePolicy.db.test.ts
-- (fixture A), never against portava-ci or travel-buddy.
--
-- Depends on 3510 (the undecided guard, which this REPLACES).
--
-- ── WHAT "DELETE ON ERASURE" MEANS HERE, PRECISELY ──────────────────────────
-- When a person is erased, every ledger record whose BENEFICIARY they are is
-- deleted, as whole transactions, so no half-transaction is left behind:
--   * creator_attributions naming them, with every creator_earning_entries leg
--     booked against those attributions (platform and traveller legs included)
--     and every creator_ledger_audit_events row about them;
--   * every rent_buddy_earnings_entries TRANSACTION that has a leg naming them
--     (the buddy_payable leg carries the beneficiary; the platform_revenue and
--     traveler_receivable legs of the same transaction carry none), and every
--     reversal of those transactions.
-- A ledger row is deleted ONLY as part of the erasure of its own beneficiary:
--   * a COUNTERPARTY's erasure does not delete it. Deleting a traveller's profile
--     cascades into their booking and from there into the BUDDY's earning
--     entries (rent_buddy_bookings.traveler_id and rbee.booking_id both
--     CASCADE, pre-existing); that is refused while the buddy exists;
--   * a direct DELETE is not an erasure: service_role loses DELETE on the four
--     tables. The two erasure paths below run as the table owner (the
--     SECURITY DEFINER function, and PostgreSQL's own FK cascade, which executes
--     as the owner of the referencing table), so they need no client grant.
--
-- TWO ENTRY POINTS, because the application does not delete profiles:
--   (i)  public.creator_ledger_erase_beneficiary(user, actor_kind, actor, reason)
--        — for AccountDeletionService's tombstone flow, which keeps an
--        anonymised profiles row and so never fires a cascade. Audited by a
--        receipt row that names no subject (creator_ledger_erasures).
--   (ii) a hard DELETE of the profiles row: the FK cascades of 2920/3387/3510
--        reach the ledger and this file's guard permits them, because the
--        beneficiary no longer exists. (A buddy with bookings cannot be
--        hard-deleted at all — rent_buddy_bookings.buddy_id is NO ACTION —
--        which is Rent-a-Buddy's schema and not changed here.)
--
-- WHAT SURVIVES A-ERASURE, stated so nobody calls it complete:
--   * creator_ledger_audit_events.actor_user_id of an erased ADMIN, on audit rows
--     about OTHER creators' money (not an FK by design, 3387:446-452). Those rows
--     belong to the other creators and are not deleted.
--   * rent_buddy_bookings, rent_buddy_earnings_ledger (the mutable summary) and
--     rank_events: other lanes' tables, outside the four ledgers.
--   * backups / PITR of the database.
--
-- Rollback: reconciliation-staging/2026-09-30-3511-creator-ledger-erasure-delete-on-erasure-rollback.sql
-- (re-installs 3510's undecided guard; refuses while an erasure receipt exists).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.creator_ledger_audit_events') IS NULL THEN
    RAISE EXCEPTION '3511: PRECONDITION FAILED: 3387 is not applied.';
  END IF;
  IF to_regprocedure('public.creator_ledger_remove_identity(uuid,text,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION '3511: PRECONDITION FAILED: C-11 answer B (3512, retain pseudonymised) is applied. The two answers are mutually exclusive; roll 3512 back first.';
  END IF;
  IF to_regprocedure('public.creator_ledger_erase_beneficiary(uuid,text,uuid,text)') IS NOT NULL THEN
    RAISE NOTICE '3511 RECONCILE: already applied; re-asserting every object.';
  ELSIF to_regprocedure('public.creator_ledger_erasure_policy_undecided()') IS NULL THEN
    RAISE EXCEPTION '3511: PRECONDITION FAILED: 3510 (the undecided guard this file replaces) is not applied.';
  END IF;
END
$pre$;

-- ── 1. The undecided guard goes; this answer's rule replaces it ─────────────
DROP TRIGGER IF EXISTS rbee_erasure_policy_undecided ON public.rent_buddy_earnings_entries;
DROP TRIGGER IF EXISTS ca_erasure_policy_undecided   ON public.creator_attributions;
DROP TRIGGER IF EXISTS cee_erasure_policy_undecided  ON public.creator_earning_entries;
DROP TRIGGER IF EXISTS clae_erasure_policy_undecided ON public.creator_ledger_audit_events;
DROP FUNCTION IF EXISTS public.creator_ledger_erasure_policy_undecided();

-- ── 2. A reversal goes with the entry it reverses ───────────────────────────
-- rbee's reversal link is NO ACTION (2901). When an erased buddy's transaction
-- goes, its reversal (a separate transaction) must go too, or the link
-- refuses the delete. CASCADE makes the pair one unit.
DO $fk$
DECLARE att smallint; cname text; deltype "char";
BEGIN
  SELECT attnum INTO att FROM pg_attribute
   WHERE attrelid = 'public.rent_buddy_earnings_entries'::regclass AND attname = 'reverses_entry_id';
  SELECT conname, confdeltype INTO cname, deltype FROM pg_constraint
   WHERE conrelid = 'public.rent_buddy_earnings_entries'::regclass AND contype = 'f'
     AND conkey = ARRAY[att] AND confrelid = 'public.rent_buddy_earnings_entries'::regclass;
  IF cname IS NULL THEN RAISE EXCEPTION '3511: rbee.reverses_entry_id foreign key is absent'; END IF;
  IF deltype <> 'c' THEN
    EXECUTE format('ALTER TABLE public.rent_buddy_earnings_entries DROP CONSTRAINT %I', cname);
    ALTER TABLE public.rent_buddy_earnings_entries
      ADD CONSTRAINT rbee_reverses_entry_fk FOREIGN KEY (reverses_entry_id)
      REFERENCES public.rent_buddy_earnings_entries(id) ON DELETE CASCADE;
  END IF;
END
$fk$;

-- ── 3. The receipt: that an erasure happened, never whose ────────────────────
CREATE TABLE IF NOT EXISTS public.creator_ledger_erasures (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  erased_on    date        NOT NULL DEFAULT current_date,
  actor_kind   text        NOT NULL,
  actor_user_id uuid       NULL,
  reason       text        NOT NULL,
  rows_deleted jsonb       NOT NULL,
  CONSTRAINT cle_actor_kind_known CHECK (actor_kind IN ('admin', 'system')),
  CONSTRAINT cle_reason_given CHECK (length(btrim(reason)) BETWEEN 1 AND 2000)
);
COMMENT ON TABLE public.creator_ledger_erasures IS
  '3511 (C-11 answer A): one row per erasure performed by creator_ledger_erase_beneficiary — the day, who ran it, why, and how many rows each ledger lost. It names NO subject: a receipt that kept the erased person''s id would retain the identity the erasure removed. Append-only; no client grant.';
DROP TRIGGER IF EXISTS cle_append_only ON public.creator_ledger_erasures;
CREATE TRIGGER cle_append_only
  BEFORE UPDATE OR DELETE ON public.creator_ledger_erasures
  FOR EACH ROW EXECUTE FUNCTION public.intel_append_only();
ALTER TABLE public.creator_ledger_erasures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.creator_ledger_erasures FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.creator_ledger_erasures TO service_role;

-- ── 4. The rule: a ledger row is deleted only in its beneficiary's erasure ───
-- "Being erased" = the beneficiary's profile no longer exists (the cascade of a
-- hard delete; PostgreSQL runs the cascade after the profile row is gone), or
-- the beneficiary is the subject the erase function declared for this
-- transaction (portava.creator_ledger_erasure_subject, set only by it).
CREATE OR REPLACE FUNCTION public.creator_ledger_delete_on_erasure_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $fn$
DECLARE
  declared text := nullif(current_setting('portava.creator_ledger_erasure_subject', true), '');
  living uuid;
BEGIN
  IF TG_TABLE_NAME = 'rent_buddy_earnings_entries' THEN
    -- A transaction is erasable when none of its legs names a living beneficiary
    -- other than the declared subject.
    SELECT s.beneficiary_user_id INTO living
      FROM public.rent_buddy_earnings_entries s
      JOIN public.profiles p ON p.id = s.beneficiary_user_id
     WHERE s.transaction_key = OLD.transaction_key
       AND s.beneficiary_user_id::text IS DISTINCT FROM declared
     LIMIT 1;
  ELSIF TG_TABLE_NAME = 'creator_attributions' THEN
    SELECT p.id INTO living FROM public.profiles p
     WHERE p.id = OLD.beneficiary_user_id AND p.id::text IS DISTINCT FROM declared;
  ELSE
    -- creator_earning_entries / creator_ledger_audit_events: the beneficiary of
    -- the attribution the row belongs to. An attribution already gone was
    -- erased lawfully (this same rule guards its deletion).
    SELECT p.id INTO living
      FROM public.creator_attributions a
      JOIN public.profiles p ON p.id = a.beneficiary_user_id
     WHERE a.id = OLD.attribution_id AND p.id::text IS DISTINCT FROM declared;
    IF living IS NULL AND TG_TABLE_NAME = 'creator_earning_entries' THEN
      SELECT p.id INTO living FROM public.profiles p
       WHERE p.id = OLD.beneficiary_user_id AND p.id::text IS DISTINCT FROM declared;
    END IF;
  END IF;

  IF living IS NOT NULL THEN
    RAISE EXCEPTION
      'creator_ledger_not_an_erasure — % row % was not deleted: under C-11 answer A a ledger row is deleted only with the erasure of its own beneficiary, and its beneficiary still exists',
      TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'CL451',
            DETAIL = 'A counterparty''s erasure (for example a traveller''s, through their booking) and a direct DELETE are not the beneficiary''s erasure.',
            HINT = 'Erase the beneficiary with public.creator_ledger_erase_beneficiary(...), or delete their profile.';
  END IF;
  RETURN OLD;
END;
$fn$;
REVOKE ALL ON FUNCTION public.creator_ledger_delete_on_erasure_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.creator_ledger_delete_on_erasure_only() FROM anon, authenticated;

DROP TRIGGER IF EXISTS rbee_delete_on_erasure_only ON public.rent_buddy_earnings_entries;
CREATE TRIGGER rbee_delete_on_erasure_only BEFORE DELETE ON public.rent_buddy_earnings_entries
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_delete_on_erasure_only();
DROP TRIGGER IF EXISTS ca_delete_on_erasure_only ON public.creator_attributions;
CREATE TRIGGER ca_delete_on_erasure_only BEFORE DELETE ON public.creator_attributions
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_delete_on_erasure_only();
DROP TRIGGER IF EXISTS cee_delete_on_erasure_only ON public.creator_earning_entries;
CREATE TRIGGER cee_delete_on_erasure_only BEFORE DELETE ON public.creator_earning_entries
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_delete_on_erasure_only();
DROP TRIGGER IF EXISTS clae_delete_on_erasure_only ON public.creator_ledger_audit_events;
CREATE TRIGGER clae_delete_on_erasure_only BEFORE DELETE ON public.creator_ledger_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_delete_on_erasure_only();

-- ── 5. Whole transactions: an erased buddy's leg takes its siblings ──────────
-- rbee legs are tied by transaction_key, not by a key the cascade can follow,
-- and only the buddy_payable leg names the beneficiary. Without this, erasing a
-- buddy would delete one leg of each transaction and leave the rest unbalanced.
-- SECURITY DEFINER because an AFTER trigger queued by a cascade fires as the
-- role that issued the outer DELETE (service_role, which holds no DELETE here);
-- the rule in (4) still decides every row it removes.
CREATE OR REPLACE FUNCTION public.creator_ledger_rbee_erase_whole_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
BEGIN
  DELETE FROM public.rent_buddy_earnings_entries WHERE transaction_key = OLD.transaction_key;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.creator_ledger_rbee_erase_whole_transaction() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.creator_ledger_rbee_erase_whole_transaction() FROM anon, authenticated;
DROP TRIGGER IF EXISTS rbee_erase_whole_transaction ON public.rent_buddy_earnings_entries;
CREATE TRIGGER rbee_erase_whole_transaction AFTER DELETE ON public.rent_buddy_earnings_entries
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_rbee_erase_whole_transaction();

-- ── 6. The erase door, for the tombstone flow ───────────────────────────────
CREATE OR REPLACE FUNCTION public.creator_ledger_erase_beneficiary(
  p_user uuid, p_actor_kind text, p_actor_user_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  n_rbee bigint; n_ca bigint; n_cee bigint; n_clae bigint; n_left bigint;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'creator_ledger_erase_beneficiary: a subject is required' USING ERRCODE = '22023';
  END IF;
  IF p_actor_kind IS NULL OR p_actor_kind NOT IN ('admin', 'system') THEN
    RAISE EXCEPTION 'creator_ledger_erase_beneficiary: actor_kind must be admin or system' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'creator_ledger_erase_beneficiary: a reason is required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('creator_ledger_erasure:' || p_user::text, 0));
  PERFORM set_config('portava.creator_ledger_erasure_subject', p_user::text, true);

  SELECT count(*) INTO n_rbee FROM public.rent_buddy_earnings_entries e
   WHERE e.transaction_key IN (SELECT s.transaction_key FROM public.rent_buddy_earnings_entries s WHERE s.beneficiary_user_id = p_user)
      OR e.reverses_entry_id IN (SELECT s.id FROM public.rent_buddy_earnings_entries s WHERE s.beneficiary_user_id = p_user);
  SELECT count(*) INTO n_ca FROM public.creator_attributions WHERE beneficiary_user_id = p_user;
  SELECT count(*) INTO n_cee FROM public.creator_earning_entries e
   WHERE e.attribution_id IN (SELECT a.id FROM public.creator_attributions a WHERE a.beneficiary_user_id = p_user);
  SELECT count(*) INTO n_clae FROM public.creator_ledger_audit_events e
   WHERE e.attribution_id IN (SELECT a.id FROM public.creator_attributions a WHERE a.beneficiary_user_id = p_user);

  DELETE FROM public.rent_buddy_earnings_entries
   WHERE transaction_key IN (SELECT s.transaction_key FROM public.rent_buddy_earnings_entries s WHERE s.beneficiary_user_id = p_user);
  -- Entries and audit rows go by the attribution's cascade (3387).
  DELETE FROM public.creator_attributions WHERE beneficiary_user_id = p_user;

  SELECT (SELECT count(*) FROM public.rent_buddy_earnings_entries WHERE beneficiary_user_id = p_user)
       + (SELECT count(*) FROM public.creator_attributions WHERE beneficiary_user_id = p_user)
       + (SELECT count(*) FROM public.creator_earning_entries WHERE beneficiary_user_id = p_user)
    INTO n_left;
  IF n_left <> 0 THEN
    RAISE EXCEPTION 'creator_ledger_erase_beneficiary: % row(s) still name the subject after erasure; nothing was erased', n_left;
  END IF;

  INSERT INTO public.creator_ledger_erasures (actor_kind, actor_user_id, reason, rows_deleted)
  VALUES (p_actor_kind, p_actor_user_id, p_reason,
          jsonb_build_object('rent_buddy_earnings_entries', n_rbee, 'creator_attributions', n_ca,
                             'creator_earning_entries', n_cee, 'creator_ledger_audit_events', n_clae));

  PERFORM set_config('portava.creator_ledger_erasure_subject', '', true);
  RETURN jsonb_build_object('rent_buddy_earnings_entries', n_rbee, 'creator_attributions', n_ca,
                            'creator_earning_entries', n_cee, 'creator_ledger_audit_events', n_clae,
                            'actor_rows_retained',
                            (SELECT count(*) FROM public.creator_ledger_audit_events WHERE actor_user_id = p_user));
END;
$fn$;
COMMENT ON FUNCTION public.creator_ledger_erase_beneficiary(uuid, text, uuid, text) IS
  '3511 (C-11 answer A): delete every creator and Rent-a-Buddy ledger record whose beneficiary is p_user, as whole transactions, in one transaction, with a receipt that names no subject. For AccountDeletionService''s tombstone flow, which never deletes the profiles row. SECURITY DEFINER; EXECUTE for service_role only. actor_rows_retained counts audit rows about OTHER creators on which p_user is the acting admin; those are not deleted.';
REVOKE ALL ON FUNCTION public.creator_ledger_erase_beneficiary(uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.creator_ledger_erase_beneficiary(uuid, text, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.creator_ledger_erase_beneficiary(uuid, text, uuid, text) TO service_role;

-- ── 7. No client deletes a ledger row directly ──────────────────────────────
REVOKE DELETE ON public.rent_buddy_earnings_entries FROM service_role;
REVOKE DELETE ON public.creator_attributions        FROM service_role;
REVOKE DELETE ON public.creator_earning_entries     FROM service_role;
REVOKE DELETE ON public.creator_ledger_audit_events FROM service_role;

-- ── Postconditions (assertion only) ─────────────────────────────────────────
DO $post$
DECLARE n int;
BEGIN
  IF to_regprocedure('public.creator_ledger_erasure_policy_undecided()') IS NOT NULL THEN
    RAISE EXCEPTION '3511: POSTCONDITION FAILED: the undecided guard still exists beside answer A';
  END IF;
  SELECT count(*) INTO n FROM pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
     AND t.tgfoid = 'public.creator_ledger_delete_on_erasure_only()'::regprocedure
     AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 8) = 8;
  IF n <> 4 THEN RAISE EXCEPTION '3511: POSTCONDITION FAILED: the erasure rule is on % of 4 tables', n; END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype = 'f' AND confdeltype <> 'c'
     AND conrelid IN ('public.rent_buddy_earnings_entries'::regclass, 'public.creator_attributions'::regclass,
                      'public.creator_earning_entries'::regclass, 'public.creator_ledger_audit_events'::regclass)
     AND confrelid = 'public.profiles'::regclass;
  IF n <> 0 THEN RAISE EXCEPTION '3511: POSTCONDITION FAILED: % beneficiary key(s) do not cascade', n; END IF;
  IF has_table_privilege('service_role', 'public.rent_buddy_earnings_entries', 'DELETE')
     OR has_table_privilege('service_role', 'public.creator_attributions', 'DELETE')
     OR has_table_privilege('service_role', 'public.creator_earning_entries', 'DELETE')
     OR has_table_privilege('service_role', 'public.creator_ledger_audit_events', 'DELETE') THEN
    RAISE EXCEPTION '3511: POSTCONDITION FAILED: service_role can still DELETE a ledger row directly';
  END IF;
  IF has_function_privilege('anon', 'public.creator_ledger_erase_beneficiary(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.creator_ledger_erase_beneficiary(uuid,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '3511: POSTCONDITION FAILED: a client role can execute the erase door';
  END IF;
  IF has_table_privilege('authenticated', 'public.creator_ledger_erasures', 'SELECT')
     OR has_table_privilege('anon', 'public.creator_ledger_erasures', 'SELECT') THEN
    RAISE EXCEPTION '3511: POSTCONDITION FAILED: a client role can read the erasure receipts';
  END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'creator_ledger_erasures'
     AND column_name IN ('user_id', 'beneficiary_user_id', 'subject_id', 'subject_user_id');
  IF n <> 0 THEN RAISE EXCEPTION '3511: POSTCONDITION FAILED: the erasure receipt has a subject column'; END IF;
END
$post$;

COMMIT;
