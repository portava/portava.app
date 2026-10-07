-- 3600_creator_ledger_erasure_retain_pseudonymised.sql
-- C-11 ANSWER B, CHOSEN: "RETAIN, WITH THE DIRECT IDENTITY REMOVED".
-- census-discovery §107. Owner decision C-11 / W10D-B0 (question 22(a)),
-- answered 2026-10-04, verbatim:
--
--   "Creator-ledger erasure: Pseudonymize accounting entries, removing direct
--    identifiers and the identity link when deletion is requested. Keep only
--    the records needed for tax, accounting, disputes, or legal claims, with a
--    defined retention period and access controls. GDPR, for example, permits
--    exceptions to erasure where processing is needed to meet a legal
--    obligation or establish or defend legal claims. [GDPR Article 17]"
--
-- STATUS. PROMOTED from reconciliation-staging/3512_… into the canonical chain
-- at the next free prefix after 3510, which it REPLACES (3511 and 3512 are held
-- numbers: 3511 is answer A, still held unapplied in reconciliation-staging/,
-- and this file kept 3512's name there). Answer A is now unreachable while this
-- file is applied; the two refuse to coexist, by precondition, in both
-- directions.
--
-- RENUMBERED 3513 -> 3600 on 2026-10-06 (lane P, PR #592). 3513 was free when
-- this file was promoted; main has since taken it for
-- 3513_layover_crowd_reports_flag.sql, which is applied to portava-ci. This
-- file had been applied to no database under either number, and it did not
-- self-register in schema_migration_ledger, so the rename moves nothing that
-- exists anywhere. 3600 still sorts after 3510 (the guard it replaces) and
-- after 2901/2920/2921/3387 (its dependencies); the only files it now sorts
-- after instead of before are 3520, 3530, 3560 and 3561, none of which names a
-- ledger table, the guard or the door.
--
-- NOT YET APPLIED TO ANY HOSTED DATABASE, AND THAT IS A DECISION, NOT A GAP.
-- The same ruling scopes the work: "Do not apply the migration to the hosted
-- database, deploy it, or enable collection until legal review confirms
-- Q11(a)". So on travel-buddy (ajrurzioarfkagpuxfnb) and portava-ci
-- (hwokxgbmezheskbzskfr) the schema still carries 3510's CL451 guard. Merging
-- this file is what hands it to CI's main-gated apply step; until then it is
-- rehearsed only in the throwaway local-db harness
-- (src/test/db/creatorLedgerErasurePolicy.db.test.ts). The owner's 2026-10-06
-- authorization lets #592 merge, and so reach portava-ci through that ordinary
-- path, only with its retention behaviour behind the approved beta/payment
-- gates; it does not allow a production apply. Every writer of these four
-- tables is behind creator_attribution_enabled (2922) or rent_buddy_enabled
-- (2210), both seeded FALSE, so outside the isolated beta environment no row
-- exists for this file's door to pseudonymise.
--
-- WHAT THE DECISION REQUIRES, AND WHERE EACH CLAUSE LIVES:
--   "pseudonymize … removing direct identifiers and the identity link"
--        -> (2) creator_ledger_remove_identity: every occurrence of the id in
--           every column of the four ledgers becomes one random pseudonym, and
--           the *_user_id columns — the identity LINK, the foreign keys — go to
--           NULL. Asserted by a residual scan that aborts the transaction.
--   "keep only the records needed for tax, accounting, disputes or legal claims"
--        -> (1) the rows are retained and no purge exists. The four ledgers are
--           exactly the accounting record: double-entry legs, their reversals,
--           and the audit of who held or released what. Nothing else is kept by
--           this file, and nothing in it keeps anything that was not already
--           kept.
--   "access controls"
--        -> no client grant on any of the four tables or on the receipt, no
--           UPDATE for service_role, the door is SECURITY DEFINER and EXECUTE
--           for service_role only, and the postconditions below now ASSERT all
--           of that rather than leaving it to the earlier files' postconditions.
--   "a defined retention period"
--        -> NOT IN THIS FILE, AND NOT INVENTED HERE. When this file was
--           written the period had no value (`04` §11, `09` §6/§11: "Exact
--           retention must be decided with privacy/legal review"). The owner
--           later (2026-10-04 15:52 UTC, docs/ops/owner-decisions-20261004.md)
--           set a DEFAULT: "retain creator-ledger entries pseudonymized for
--           seven years after fiscal year-end. Jurisdiction-specific legal
--           retention periods override this default ... legal confirmation is
--           still required", and on 2026-10-05: "The statutory retention period
--           remains subject to legal review; do not invent legal approval or
--           erase records early." Whose fiscal year, and which jurisdiction's
--           period overrides it, are legal/tax facts nobody has confirmed, so
--           this file still builds NO purge and writes no interval: it retains
--           INDEFINITELY, which can never erase a record early. The purge that
--           enforces the confirmed period is the follow-up, gated on that
--           legal confirmation.
--
-- Depends on 3510 (the undecided guard, which this REPLACES with a retention
-- guard).
--
-- ── WHAT IT DOES ────────────────────────────────────────────────────────────
--  (1) Ledger rows are never deleted: 3510's refusal stays, reworded as the
--      decided retention (SQLSTATE CL452). Deleting retained rows after the
--      statutory period is a PURGE this file does not build — the period has no
--      value yet (`04` §11: "Exact retention must be decided with privacy/legal
--      review").
--  (2) public.creator_ledger_remove_identity(user, actor_kind, actor, reason) —
--      SECURITY DEFINER, EXECUTE for service_role only, audited. In ONE
--      transaction it rewrites every row of the four ledgers that names the
--      person, replacing their profile id with ONE fresh random pseudonym
--      (gen_random_uuid(), derived from nothing):
--        * beneficiary_user_id := NULL, beneficiary_pseudonym := P
--          (rent_buddy_earnings_entries, creator_attributions, creator_earning_entries);
--        * actor_user_id := NULL, actor_pseudonym := P (creator_ledger_audit_events,
--          where the person acted as an admin);
--        * every occurrence of the id inside any text or jsonb column —
--          creator_attributions.idempotency_key is
--          `creator-attr:<type>:<subject>:<event>:<beneficiary id>`, and the
--          creator_earning_entries transaction and idempotency keys embed that
--          key — replaced by P, case-insensitively.
--      It then scans all four tables and ABORTS if the id survives anywhere.
--      No mapping id -> P is stored, returned or logged by it; the receipt row
--      (creator_ledger_identity_removals) names neither.
--  (3) The append-only triggers of the four tables (rbee_no_update, ca_no_update,
--      cee_no_update, clae_no_update — names kept, so 2901/2920/2921/3387's
--      postconditions still hold) are repointed at a function that still refuses
--      every UPDATE EXCEPT the exact substitution (2) declares: the updated row
--      must equal the old row with id -> P and nothing else changed. service_role
--      still has no UPDATE privilege; only the definer can issue one.
--  (4) A pseudonymised record is FROZEN: no supersession (hold, release,
--      recompute), no new entry and no reversal may be appended to it, and no
--      row may be INSERTED already carrying a pseudonym. Corrections to a
--      retained record after erasure (a late refund, a chargeback) are a
--      follow-up decision, not something this file invents.
--  (4b) An ERASED person is never written back (review of PR #592, 2026-10-06:
--      "the producer re-identifies an erased beneficiary"). The tombstone
--      profile keeps the same id and rent_buddy_profiles.user_id still points at
--      it, so a booking completed before the erasure but attributed after it —
--      or every such booking at once, the day creator_attribution_enabled is
--      turned on — would INSERT a fresh row naming the erased id, which (4) did
--      not refuse (it fires only on a superseding or pseudonym-carrying insert).
--      Every INSERT into the four ledgers that names a person whose profile is
--      the tombstone (account_status = 'deleted', the marker 2200/2213 already
--      use) is refused CL452 `creator_ledger_subject_erased`. The profile row is
--      read FOR SHARE, so the deletion's anonymise UPDATE waits for an insert
--      already in flight, and the deletion's second ledger pass (after the
--      tombstone) sees it; an insert that arrives after the tombstone is refused.
--  (4c) A retained record's key cannot be re-sent (same review: "3387 has a
--      NULL-unsafe replay compare"). creator_ledger_append's replay check
--      (3387) compares `ex.beneficiary_user_id <> (a->>'beneficiary_user_id')::uuid`,
--      which is NULL — not true — once (2) has set that column to NULL, so a
--      re-sent attribution key that already sits on a pseudonymised row was
--      answered as a successful replay. A BEFORE INSERT trigger runs before
--      ON CONFLICT is arbitrated, so the guard below refuses CL452
--      `creator_ledger_subject_pseudonymised` first and the compare is never
--      reached for such a row. The other way that compare meets a NULL — a
--      payload with no beneficiary — is refused by ca_one_beneficiary_identity,
--      a CHECK, which is also evaluated before the conflict. 3387 itself is
--      applied and is not edited.
--
-- ── PSEUDONYMISED, NOT ANONYMOUS ────────────────────────────────────────────
-- After (2) no column of the four ledgers holds the person's profile id. The
-- records are still LINKABLE to the person, so they remain personal data:
--   * booking_id / subject_id / value_event_id -> rent_buddy_bookings.buddy_id
--     -> rent_buddy_profiles.user_id = the person. The app's erasure keeps an
--     anonymised TOMBSTONE profile with the SAME id, and rent_buddy_bookings /
--     rent_buddy_profiles are not erased (Rent-a-Buddy's tables, NO ACTION keys),
--     so this join re-identifies every Rent-a-Buddy and Travel Partner row
--     outright. Trail / place subjects join to their authors the same way.
--   * P is one stable key per person: re-identify one row and all are.
--   * amounts, currencies and timestamps are quasi-identifiers against the
--     counterparty's own records (the traveller's booking, a processor reference
--     in external_ref once a provider exists).
--   * free text (fraud_hold_reason, audit reason/detail) is scrubbed of the id
--     only; a handle or name typed into it survives.
--   * the receipt's day and actor correlate with account_deletion_requests.
--   * database backups and point-in-time recovery hold the rows as they were.
-- Anonymity would need at least the booking and subject links cut, the free
-- text removed and the amounts coarsened; none of that is built or claimed.
--
-- Rollback: db/rollback/2026-10-04-3600-creator-ledger-erasure-retain-pseudonymised-rollback.sql
-- (refuses while any row is pseudonymised or any receipt exists).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.creator_ledger_audit_events') IS NULL THEN
    RAISE EXCEPTION '3600: PRECONDITION FAILED: 3387 is not applied.';
  END IF;
  IF to_regprocedure('public.creator_ledger_erase_beneficiary(uuid,text,uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION '3600: PRECONDITION FAILED: C-11 answer A (3511, delete on erasure) is applied. The two answers are mutually exclusive; roll 3511 back first.';
  END IF;
  IF to_regprocedure('public.creator_ledger_remove_identity(uuid,text,uuid,text)') IS NOT NULL THEN
    RAISE NOTICE '3600 RECONCILE: already applied; re-asserting every object.';
  ELSIF to_regprocedure('public.creator_ledger_erasure_policy_undecided()') IS NULL THEN
    RAISE EXCEPTION '3600: PRECONDITION FAILED: 3510 (the undecided guard this file replaces) is not applied.';
  END IF;
END
$pre$;

-- ═══════════════════════════════════════════════════════════════════════════
-- (1) Retention: the undecided refusal becomes the decided one.
-- ═══════════════════════════════════════════════════════════════════════════
DROP TRIGGER IF EXISTS rbee_erasure_policy_undecided ON public.rent_buddy_earnings_entries;
DROP TRIGGER IF EXISTS ca_erasure_policy_undecided   ON public.creator_attributions;
DROP TRIGGER IF EXISTS cee_erasure_policy_undecided  ON public.creator_earning_entries;
DROP TRIGGER IF EXISTS clae_erasure_policy_undecided ON public.creator_ledger_audit_events;
DROP FUNCTION IF EXISTS public.creator_ledger_erasure_policy_undecided();

CREATE OR REPLACE FUNCTION public.creator_ledger_retained_on_erasure()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $fn$
BEGIN
  RAISE EXCEPTION
    'creator_ledger_retained — % row % was not deleted: under C-11 answer B earning records are retained when an account is erased, with the identity removed',
    TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'CL452',
          HINT = 'Remove the person''s identity first with public.creator_ledger_remove_identity(...); their profile can then be erased and these rows stay. Deleting retained rows after the statutory period is a separate purge that is not decided.';
END;
$fn$;
REVOKE ALL ON FUNCTION public.creator_ledger_retained_on_erasure() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.creator_ledger_retained_on_erasure() FROM anon, authenticated;

DROP TRIGGER IF EXISTS rbee_retained_on_erasure ON public.rent_buddy_earnings_entries;
CREATE TRIGGER rbee_retained_on_erasure BEFORE DELETE ON public.rent_buddy_earnings_entries
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_retained_on_erasure();
DROP TRIGGER IF EXISTS ca_retained_on_erasure ON public.creator_attributions;
CREATE TRIGGER ca_retained_on_erasure BEFORE DELETE ON public.creator_attributions
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_retained_on_erasure();
DROP TRIGGER IF EXISTS cee_retained_on_erasure ON public.creator_earning_entries;
CREATE TRIGGER cee_retained_on_erasure BEFORE DELETE ON public.creator_earning_entries
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_retained_on_erasure();
DROP TRIGGER IF EXISTS clae_retained_on_erasure ON public.creator_ledger_audit_events;
CREATE TRIGGER clae_retained_on_erasure BEFORE DELETE ON public.creator_ledger_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_retained_on_erasure();

-- ═══════════════════════════════════════════════════════════════════════════
-- The pseudonym columns. Exactly one identity per attribution; at most one per
-- leg (platform and traveller legs name nobody); at most one actor identity.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.rent_buddy_earnings_entries ADD COLUMN IF NOT EXISTS beneficiary_pseudonym uuid NULL;
ALTER TABLE public.creator_attributions        ADD COLUMN IF NOT EXISTS beneficiary_pseudonym uuid NULL;
ALTER TABLE public.creator_earning_entries     ADD COLUMN IF NOT EXISTS beneficiary_pseudonym uuid NULL;
ALTER TABLE public.creator_ledger_audit_events ADD COLUMN IF NOT EXISTS actor_pseudonym uuid NULL;
ALTER TABLE public.creator_attributions ALTER COLUMN beneficiary_user_id DROP NOT NULL;

ALTER TABLE public.creator_attributions DROP CONSTRAINT IF EXISTS ca_one_beneficiary_identity;
ALTER TABLE public.creator_attributions ADD CONSTRAINT ca_one_beneficiary_identity
  CHECK ((beneficiary_user_id IS NULL) <> (beneficiary_pseudonym IS NULL));
ALTER TABLE public.rent_buddy_earnings_entries DROP CONSTRAINT IF EXISTS rbee_at_most_one_beneficiary_identity;
ALTER TABLE public.rent_buddy_earnings_entries ADD CONSTRAINT rbee_at_most_one_beneficiary_identity
  CHECK (beneficiary_user_id IS NULL OR beneficiary_pseudonym IS NULL);
ALTER TABLE public.creator_earning_entries DROP CONSTRAINT IF EXISTS cee_at_most_one_beneficiary_identity;
ALTER TABLE public.creator_earning_entries ADD CONSTRAINT cee_at_most_one_beneficiary_identity
  CHECK (beneficiary_user_id IS NULL OR beneficiary_pseudonym IS NULL);
ALTER TABLE public.creator_ledger_audit_events DROP CONSTRAINT IF EXISTS clae_at_most_one_actor_identity;
ALTER TABLE public.creator_ledger_audit_events ADD CONSTRAINT clae_at_most_one_actor_identity
  CHECK (actor_user_id IS NULL OR actor_pseudonym IS NULL);

CREATE INDEX IF NOT EXISTS rbee_beneficiary_pseudonym_idx ON public.rent_buddy_earnings_entries (beneficiary_pseudonym)
  WHERE beneficiary_pseudonym IS NOT NULL;
CREATE INDEX IF NOT EXISTS ca_beneficiary_pseudonym_idx ON public.creator_attributions (beneficiary_pseudonym)
  WHERE beneficiary_pseudonym IS NOT NULL;
CREATE INDEX IF NOT EXISTS cee_beneficiary_pseudonym_idx ON public.creator_earning_entries (beneficiary_pseudonym)
  WHERE beneficiary_pseudonym IS NOT NULL;

COMMENT ON COLUMN public.creator_attributions.beneficiary_pseudonym IS
  '3600 (C-11 answer B): set ONLY by creator_ledger_remove_identity, when the beneficiary''s identity is removed; a fresh random uuid per erased person, derived from nothing and mapped to nothing. PSEUDONYMISED, NOT ANONYMOUS: subject_id / value_event_id still join to the booking or subject, and from there to the person.';

-- ═══════════════════════════════════════════════════════════════════════════
-- (2)(3) The one permitted rewrite, and the trigger that permits only it.
-- ═══════════════════════════════════════════════════════════════════════════
-- The substitution, as a pure function of the old row: every occurrence of the
-- id in the row's text becomes P (case-insensitive), and the identity columns
-- move from *_user_id to *_pseudonym.
CREATE OR REPLACE FUNCTION public.creator_ledger_identity_substitution(r jsonb, u text, p text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO ''
AS $fn$
DECLARE out jsonb;
BEGIN
  IF u !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'creator_ledger_identity_substitution: both identities must be uuids' USING ERRCODE = '22023';
  END IF;
  out := regexp_replace(r::text, u, p, 'gi')::jsonb;
  IF lower(r->>'beneficiary_user_id') = lower(u) THEN
    out := out || jsonb_build_object('beneficiary_user_id', NULL, 'beneficiary_pseudonym', p);
  END IF;
  IF lower(r->>'actor_user_id') = lower(u) THEN
    out := out || jsonb_build_object('actor_user_id', NULL, 'actor_pseudonym', p);
  END IF;
  RETURN out;
END;
$fn$;
REVOKE ALL ON FUNCTION public.creator_ledger_identity_substitution(jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.creator_ledger_identity_substitution(jsonb, text, text) FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.creator_ledger_append_only_except_identity_removal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $fn$
DECLARE
  decl text := nullif(current_setting('portava.creator_ledger_identity_removal', true), '');
  u text; p text;
BEGIN
  IF TG_OP <> 'UPDATE' OR decl IS NULL THEN
    RAISE EXCEPTION '% is append-only: % is not permitted. Corrections are new rows.', TG_TABLE_NAME, TG_OP;
  END IF;
  u := split_part(decl, '|', 1);
  p := split_part(decl, '|', 2);
  IF to_jsonb(NEW) IS DISTINCT FROM public.creator_ledger_identity_substitution(to_jsonb(OLD), u, p) THEN
    RAISE EXCEPTION
      'creator_ledger_identity_removal_changes_more_than_identity — % row %: an identity removal may replace the person''s id and nothing else',
      TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.creator_ledger_append_only_except_identity_removal() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.creator_ledger_append_only_except_identity_removal() FROM anon, authenticated;

DROP TRIGGER IF EXISTS rbee_no_update ON public.rent_buddy_earnings_entries;
CREATE TRIGGER rbee_no_update BEFORE UPDATE ON public.rent_buddy_earnings_entries
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_append_only_except_identity_removal();
DROP TRIGGER IF EXISTS ca_no_update ON public.creator_attributions;
CREATE TRIGGER ca_no_update BEFORE UPDATE ON public.creator_attributions
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_append_only_except_identity_removal();
DROP TRIGGER IF EXISTS cee_no_update ON public.creator_earning_entries;
CREATE TRIGGER cee_no_update BEFORE UPDATE ON public.creator_earning_entries
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_append_only_except_identity_removal();
DROP TRIGGER IF EXISTS clae_no_update ON public.creator_ledger_audit_events;
CREATE TRIGGER clae_no_update BEFORE UPDATE ON public.creator_ledger_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_append_only_except_identity_removal();

-- ═══════════════════════════════════════════════════════════════════════════
-- (4) A pseudonymised record is frozen.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.creator_ledger_pseudonymised_is_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $fn$
DECLARE
  frozen boolean := false;
  j jsonb := to_jsonb(NEW);
  who uuid;
  who_status text;
BEGIN
  IF j->>'beneficiary_pseudonym' IS NOT NULL OR j->>'actor_pseudonym' IS NOT NULL THEN
    RAISE EXCEPTION 'creator_ledger_pseudonym_on_insert — % rows are never inserted pseudonymised; only creator_ledger_remove_identity sets a pseudonym', TG_TABLE_NAME
      USING ERRCODE = 'CL452';
  END IF;
  -- (4b) the person this row names, if any: the beneficiary on three ledgers,
  -- the acting admin on the audit. Platform and traveller legs name nobody.
  who := CASE WHEN TG_TABLE_NAME = 'creator_ledger_audit_events'
              THEN (j->>'actor_user_id')::uuid
              ELSE (j->>'beneficiary_user_id')::uuid END;
  IF who IS NOT NULL THEN
    -- FOR SHARE: the account deletion's anonymise_profile UPDATE conflicts with
    -- this lock, so it waits for an insert already in flight (and its second
    -- ledger pass then finds that row), and an insert that starts after the
    -- tombstone reads the tombstone. No profile row: the foreign key answers.
    SELECT p.account_status INTO who_status FROM public.profiles p WHERE p.id = who FOR SHARE;
    IF who_status = 'deleted' THEN
      RAISE EXCEPTION
        'creator_ledger_subject_erased — % row refused: it names an account that was erased (its profile is the anonymised tombstone); under C-11 answer B the ledger keeps that person''s earlier records with the identity removed and never names them again',
        TG_TABLE_NAME
        USING ERRCODE = 'CL452',
              HINT = 'A late event for an erased person (a booking completed before the erasure, a refund, a chargeback) is an undecided follow-up, not a new row naming them.';
    END IF;
  END IF;
  -- (4c) a re-sent key of a retained attribution is neither a replay nor new.
  IF TG_TABLE_NAME = 'creator_attributions' THEN
    IF EXISTS (SELECT 1 FROM public.creator_attributions a
                WHERE a.idempotency_key = NEW.idempotency_key AND a.beneficiary_pseudonym IS NOT NULL) THEN
      RAISE EXCEPTION
        'creator_ledger_subject_pseudonymised — creator_attributions key % is recorded on a retained row whose identity was removed (C-11 answer B); it names nobody, so this write is neither its replay nor a second claim about it',
        NEW.idempotency_key
        USING ERRCODE = 'CL452',
              HINT = 'Corrections to a retained record after erasure are an undecided follow-up.';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'creator_attributions' THEN
    frozen := NEW.supersedes_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.creator_attributions a WHERE a.id = NEW.supersedes_id AND a.beneficiary_pseudonym IS NOT NULL);
  ELSIF TG_TABLE_NAME = 'creator_earning_entries' THEN
    frozen := EXISTS (SELECT 1 FROM public.creator_attributions a
                       WHERE a.id = NEW.attribution_id AND a.beneficiary_pseudonym IS NOT NULL)
           OR (NEW.reverses_entry_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.creator_earning_entries e
                 WHERE e.id = NEW.reverses_entry_id AND e.beneficiary_pseudonym IS NOT NULL));
  ELSIF TG_TABLE_NAME = 'creator_ledger_audit_events' THEN
    frozen := EXISTS (SELECT 1 FROM public.creator_attributions a
                       WHERE a.id = NEW.attribution_id AND a.beneficiary_pseudonym IS NOT NULL);
  ELSE
    frozen := EXISTS (SELECT 1 FROM public.rent_buddy_earnings_entries e
                       WHERE (e.id = NEW.reverses_entry_id OR e.booking_id = NEW.booking_id)
                         AND e.beneficiary_pseudonym IS NOT NULL);
  END IF;
  IF frozen THEN
    RAISE EXCEPTION
      'creator_ledger_subject_pseudonymised — % row refused: the record it extends belongs to a person whose identity was removed (C-11 answer B); it is retained as it was and nothing is appended to it',
      TG_TABLE_NAME
      USING ERRCODE = 'CL452',
            HINT = 'Corrections to a retained record after erasure are an undecided follow-up.';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.creator_ledger_pseudonymised_is_frozen() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.creator_ledger_pseudonymised_is_frozen() FROM anon, authenticated;

DROP TRIGGER IF EXISTS rbee_pseudonymised_is_frozen ON public.rent_buddy_earnings_entries;
CREATE TRIGGER rbee_pseudonymised_is_frozen BEFORE INSERT ON public.rent_buddy_earnings_entries
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_pseudonymised_is_frozen();
DROP TRIGGER IF EXISTS ca_pseudonymised_is_frozen ON public.creator_attributions;
CREATE TRIGGER ca_pseudonymised_is_frozen BEFORE INSERT ON public.creator_attributions
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_pseudonymised_is_frozen();
DROP TRIGGER IF EXISTS cee_pseudonymised_is_frozen ON public.creator_earning_entries;
CREATE TRIGGER cee_pseudonymised_is_frozen BEFORE INSERT ON public.creator_earning_entries
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_pseudonymised_is_frozen();
DROP TRIGGER IF EXISTS clae_pseudonymised_is_frozen ON public.creator_ledger_audit_events;
CREATE TRIGGER clae_pseudonymised_is_frozen BEFORE INSERT ON public.creator_ledger_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_pseudonymised_is_frozen();

-- ═══════════════════════════════════════════════════════════════════════════
-- The receipt: that an identity was removed — never whose, never the pseudonym.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.creator_ledger_identity_removals (
  id            uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  removed_on    date NOT NULL DEFAULT current_date,
  actor_kind    text NOT NULL,
  actor_user_id uuid NULL,
  reason        text NOT NULL,
  CONSTRAINT clir_actor_kind_known CHECK (actor_kind IN ('admin', 'system')),
  CONSTRAINT clir_reason_given CHECK (length(btrim(reason)) BETWEEN 1 AND 2000)
);
COMMENT ON TABLE public.creator_ledger_identity_removals IS
  '3600 (C-11 answer B): one row per identity removal — the day, who ran it and why. It names neither the person nor the pseudonym, and carries no row counts (a count per person is a fingerprint that could be matched to a pseudonym''s rows). Append-only, never deleted; no client grant.';
DROP TRIGGER IF EXISTS clir_no_update ON public.creator_ledger_identity_removals;
CREATE TRIGGER clir_no_update BEFORE UPDATE ON public.creator_ledger_identity_removals
  FOR EACH ROW EXECUTE FUNCTION public.intel_append_only();
DROP TRIGGER IF EXISTS clir_retained ON public.creator_ledger_identity_removals;
CREATE TRIGGER clir_retained BEFORE DELETE ON public.creator_ledger_identity_removals
  FOR EACH ROW EXECUTE FUNCTION public.creator_ledger_retained_on_erasure();
ALTER TABLE public.creator_ledger_identity_removals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.creator_ledger_identity_removals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.creator_ledger_identity_removals TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- (2) The door.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.creator_ledger_remove_identity(
  p_user uuid, p_actor_kind text, p_actor_user_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  u text := lower(p_user::text);
  pseudonym text := gen_random_uuid()::text;
  tbl text;
  cols text;
  n bigint;
  counts jsonb := '{}'::jsonb;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'creator_ledger_remove_identity: a subject is required' USING ERRCODE = '22023';
  END IF;
  IF p_actor_kind IS NULL OR p_actor_kind NOT IN ('admin', 'system') THEN
    RAISE EXCEPTION 'creator_ledger_remove_identity: actor_kind must be admin or system' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'creator_ledger_remove_identity: a reason is required' USING ERRCODE = '22023';
  END IF;
  IF p_actor_user_id IS NOT DISTINCT FROM p_user THEN
    -- The receipt keeps its actor; an actor who is the subject would keep the
    -- subject's id beside the fact of the removal.
    RAISE EXCEPTION 'creator_ledger_remove_identity: the actor may not be the subject' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('creator_ledger_erasure:' || u, 0));
  PERFORM set_config('portava.creator_ledger_identity_removal', u || '|' || pseudonym, true);

  FOREACH tbl IN ARRAY ARRAY['rent_buddy_earnings_entries', 'creator_attributions',
                             'creator_earning_entries', 'creator_ledger_audit_events'] LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO cols
      FROM pg_attribute a
     WHERE a.attrelid = ('public.' || tbl)::regclass AND a.attnum > 0 AND NOT a.attisdropped
       AND a.attgenerated = '';
    EXECUTE format(
      'UPDATE public.%1$I AS t SET (%2$s) = (SELECT %2$s FROM jsonb_populate_record(t, '
      'public.creator_ledger_identity_substitution(to_jsonb(t), $1, $2))) '
      'WHERE to_jsonb(t)::text ~* $1', tbl, cols)
      USING u, pseudonym;
    GET DIAGNOSTICS n = ROW_COUNT;
    counts := counts || jsonb_build_object(tbl, n);
  END LOOP;

  -- The id must be gone from every column of every row, or nothing happened.
  FOREACH tbl IN ARRAY ARRAY['rent_buddy_earnings_entries', 'creator_attributions',
                             'creator_earning_entries', 'creator_ledger_audit_events'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I t WHERE to_jsonb(t)::text ~* $1', tbl) INTO n USING u;
    IF n <> 0 THEN
      RAISE EXCEPTION 'creator_ledger_remove_identity: % row(s) of % still carry the subject''s id; nothing was changed', n, tbl;
    END IF;
  END LOOP;

  INSERT INTO public.creator_ledger_identity_removals (actor_kind, actor_user_id, reason)
  VALUES (p_actor_kind, p_actor_user_id, p_reason);

  PERFORM set_config('portava.creator_ledger_identity_removal', '', true);
  RETURN counts;
END;
$fn$;
COMMENT ON FUNCTION public.creator_ledger_remove_identity(uuid, text, uuid, text) IS
  '3600 (C-11 answer B): replace p_user''s profile id with one fresh random pseudonym in every row and every text/jsonb column of the four creator ledgers, in one transaction, abort if the id survives anywhere, and write a receipt naming neither. Returns row counts per table and never the pseudonym. The caller must not log the counts beside the user id. PSEUDONYMISED, NOT ANONYMOUS (see 3600''s header). SECURITY DEFINER; EXECUTE for service_role only.';
REVOKE ALL ON FUNCTION public.creator_ledger_remove_identity(uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.creator_ledger_remove_identity(uuid, text, uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.creator_ledger_remove_identity(uuid, text, uuid, text) TO service_role;

-- ── Postconditions (assertion only) ─────────────────────────────────────────
DO $post$
DECLARE n int;
BEGIN
  IF to_regprocedure('public.creator_ledger_erasure_policy_undecided()') IS NOT NULL THEN
    RAISE EXCEPTION '3600: POSTCONDITION FAILED: the undecided guard still exists beside answer B';
  END IF;
  SELECT count(*) INTO n FROM pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
     AND t.tgfoid = 'public.creator_ledger_retained_on_erasure()'::regprocedure
     AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 8) = 8;
  IF n <> 5 THEN RAISE EXCEPTION '3600: POSTCONDITION FAILED: the retention guard is on % of 5 tables', n; END IF;
  SELECT count(*) INTO n FROM pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
     AND t.tgfoid = 'public.creator_ledger_append_only_except_identity_removal()'::regprocedure
     AND t.tgname IN ('rbee_no_update', 'ca_no_update', 'cee_no_update', 'clae_no_update');
  IF n <> 4 THEN RAISE EXCEPTION '3600: POSTCONDITION FAILED: % of 4 append-only triggers repointed', n; END IF;
  IF has_table_privilege('service_role', 'public.rent_buddy_earnings_entries', 'UPDATE')
     OR has_table_privilege('service_role', 'public.creator_attributions', 'UPDATE')
     OR has_table_privilege('service_role', 'public.creator_earning_entries', 'UPDATE')
     OR has_table_privilege('service_role', 'public.creator_ledger_audit_events', 'UPDATE') THEN
    RAISE EXCEPTION '3600: POSTCONDITION FAILED: service_role has UPDATE on a ledger table';
  END IF;
  IF has_function_privilege('anon', 'public.creator_ledger_remove_identity(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.creator_ledger_remove_identity(uuid,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '3600: POSTCONDITION FAILED: a client role can execute the identity-removal door';
  END IF;
  -- (4b)/(4c): the frozen guard refuses an erased person's id under a share lock
  -- on their profile, and a re-sent key of a retained attribution.
  IF position('FOR SHARE' IN pg_get_functiondef('public.creator_ledger_pseudonymised_is_frozen()'::regprocedure)) = 0
     OR position('creator_ledger_subject_erased' IN pg_get_functiondef('public.creator_ledger_pseudonymised_is_frozen()'::regprocedure)) = 0
     OR position('a.idempotency_key = NEW.idempotency_key' IN pg_get_functiondef('public.creator_ledger_pseudonymised_is_frozen()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '3600: POSTCONDITION FAILED: the frozen guard does not refuse an erased person (4b) or a re-sent retained key (4c)';
  END IF;
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'creator_ledger_identity_removals'
     AND column_name NOT IN ('id', 'removed_on', 'actor_kind', 'actor_user_id', 'reason');
  IF n <> 0 THEN RAISE EXCEPTION '3600: POSTCONDITION FAILED: the receipt carries a column that could name the subject'; END IF;

  -- ── "with … access controls" (the owner's words), asserted rather than assumed
  -- 2901 / 2920 / 2921 / 3387 each revoked every client grant on their own
  -- table, and each asserted it in its own postconditions. Retention makes those
  -- grants load-bearing for longer than any other table in the schema: these
  -- rows now outlive the account they describe, so a client grant that drifted
  -- back would expose a departed person's accounting record to the very roles a
  -- PostgREST request arrives as. Re-assert all five here, in the file that
  -- decided to keep them, so the access control and the retention cannot drift
  -- apart.
  SELECT count(*) INTO n
    FROM unnest(ARRAY['rent_buddy_earnings_entries', 'creator_attributions',
                      'creator_earning_entries', 'creator_ledger_audit_events',
                      'creator_ledger_identity_removals']) AS t(name),
         unnest(ARRAY['anon', 'authenticated']) AS r(rolename),
         unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS p(priv)
   WHERE has_table_privilege(r.rolename::name, 'public.' || t.name, p.priv);
  IF n <> 0 THEN
    RAISE EXCEPTION '3600: POSTCONDITION FAILED: % client grant(s) (anon / authenticated) on a retained ledger table', n;
  END IF;
  -- service_role reads them and appends; it never updates (asserted above) and
  -- cannot delete past the retention guard. The receipt is read-only to it.
  IF NOT has_table_privilege('service_role', 'public.creator_ledger_identity_removals', 'SELECT')
     OR has_table_privilege('service_role', 'public.creator_ledger_identity_removals', 'INSERT')
     OR has_table_privilege('service_role', 'public.creator_ledger_identity_removals', 'UPDATE')
     OR has_table_privilege('service_role', 'public.creator_ledger_identity_removals', 'DELETE') THEN
    RAISE EXCEPTION '3600: POSTCONDITION FAILED: the receipt is not read-only to service_role (only the definer writes it)';
  END IF;
  SELECT count(*) INTO n FROM pg_class
   WHERE oid = 'public.creator_ledger_identity_removals'::regclass AND relrowsecurity;
  IF n <> 1 THEN RAISE EXCEPTION '3600: POSTCONDITION FAILED: row-level security is off on the receipt'; END IF;
END
$post$;

COMMIT;
