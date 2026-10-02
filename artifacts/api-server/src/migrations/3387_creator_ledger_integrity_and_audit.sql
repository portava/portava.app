-- 3387_creator_ledger_integrity_and_audit.sql
-- census-discovery DV-58, DV-59, DV-60, DV-63, DV-65, DV-66, DV-68, DV-74.
-- Depends on 2920, 2921, 3386.
--
-- ── WHAT 2920/2921 LEFT TO CONVENTION, AND WHY EACH IS A DEFECT ─────────────
-- 2920/2921 made the creator ledger append-only, idempotent and double-entry
-- IN SHAPE. Six properties the acceptance criteria depend on were enforced only
-- by the TypeScript model, i.e. only for a caller that happened to use it:
--
--  1. A HELD attribution could still be earned against. The model refuses a
--     held CreatorAttribution OBJECT; nothing stops a caller booking against
--     the ORIGINAL row after a hold was appended on top of it (`07` §9/§10
--     "fraud holds exist" — a hold that does not hold).
--  2. A SUPERSEDED attribution could still be earned against — i.e. an earning
--     booked under a rule version that a recomputation has already replaced
--     (`07` §10 "rules are versioned" read backwards: a stale version kept
--     earning).
--  3. A rule_version was a free string. `buildAttribution` checks the LINEAGE
--     by string prefix, so `creator-rules/travel-partner/v9` — a version nobody
--     published — was accepted, and a new attribution could be recorded under
--     an OLD version after a newer one came into force.
--  4. "Entries sharing a transaction_key sum to zero per currency" (2921:28)
--     was a claim, not a constraint. A one-legged row was insertable.
--  5. A reversal (`09` §6 "create reversing entries") only had to NAME an
--     entry; it did not have to NEGATE it. A "reversal" of +100 by -1 was a
--     legal row.
--  6. Account erasure was BLOCKED for any creator with an earning, twice over.
--     2921 says service_role has DELETE "only so the account-erasure cascade
--     from creator_attributions can fire", but (a) its attribution_id FK has no
--     ON DELETE, so the profile's cascade into creator_attributions stops at
--     the first earning entry that references it; and (b) its
--     beneficiary_user_id FK is ON DELETE SET NULL, which PostgreSQL executes
--     as an UPDATE — and cee_no_update (intel_append_only) refuses every
--     UPDATE. Found by the harness suite (L15), not by reading: the profile
--     DELETE failed with "creator_earning_entries is append-only".
--
-- And two things the specification asks for had no object at all:
--
--  7. `11` §8 "creator fraud holds", "ledger audit" and `11` §10 "admin actions
--     are audited": no audit record of who held, released, recomputed or
--     reversed anything, or why a hold was LIFTED (2920's ca_hold_is_explained
--     requires a reason to PLACE a hold; a release row carries fraud_hold =
--     false and therefore, by that same CHECK, no reason).
--  8. ATOMICITY. A recomputation is (supersede the attribution) + (reverse the
--     old entries) + (book the new ones). Through PostgREST those are three
--     requests, and a failure between them leaves a half-ledger: a new rule
--     version with the old money still live, or old money reversed and nothing
--     booked. There was no single-transaction door.
--
-- ── WHAT THIS FILE ADDS ─────────────────────────────────────────────────────
--   (1)(2) trigger cee_attribution_is_current on creator_earning_entries: a
--          non-reversal entry may only be booked against an attribution that is
--          the CURRENT head of its chain (superseded by nothing) and not held,
--          and under that attribution's own rule_version.
--   (5)    the same trigger: a reversal must be the EXACT negation of the entry
--          it names — same attribution, account, currency and rule version,
--          opposite amount.
--   ONE EARNING, ONE LEDGER (3385's header): the same trigger refuses a
--          creator_earning_entries row for a booking whose earning is already
--          booked in rent_buddy_earnings_entries, so creator_share_ledger can
--          never count one booking's money twice.
--   (3)    trigger ca_rule_version_is_published on creator_attributions: the
--          rule_version must be a published version of the row's creator type,
--          effective by computed_at; an ORIGINAL row must use the version IN
--          FORCE at computed_at (not an older one).
--   (1)(2) trigger ca_supersession_is_lawful: a superseding row keeps the
--          identity of what it supersedes (type, subject, value event,
--          beneficiary, basis, currency, recommendation) and is exactly one of
--          HOLD (same version, not held -> held), RELEASE (same version,
--          held -> not held) or RECOMPUTE (a different version, neither held,
--          and not a seam). Anything else is refused.
--          Both triggers take the same transaction-scoped advisory lock on the
--          attribution, so a hold racing a booking is serialised rather than
--          interleaved (no row lock is available: service_role has no UPDATE,
--          which SELECT ... FOR UPDATE requires).
--   (4)    DEFERRABLE constraint trigger cee_transaction_balances: at COMMIT,
--          every transaction_key touched sums to zero per currency.
--   (6)    creator_earning_entries.attribution_id and .beneficiary_user_id ->
--          ON DELETE CASCADE (a SET NULL is an UPDATE, which an append-only
--          table refuses). The erased creator's legs go with the attribution
--          they belong to, platform legs included, so no half-transaction is
--          left behind.
--   (7)    public.creator_ledger_audit_events: append-only, one row per hold,
--          release, recomputation or reversal, carrying the actor and the
--          reason (including the reason a hold was LIFTED).
--   (8)    public.creator_ledger_append(jsonb): ONE function call = ONE
--          transaction that appends an attribution, its entries and its audit
--          row, or appends nothing. Idempotent by key, and a replay whose
--          content differs from what the key already recorded is REFUSED
--          (SQLSTATE CL409) rather than reported as a replay.
--
-- NO PERCENTAGE, NO AMOUNT AND NO PROVIDER IS DECIDED HERE. Every figure an
-- entry carries is still handed in by a caller that read it off a published
-- creator_rule_versions row; this file only refuses the figures that could not
-- be audited.
--
-- RUNTIME EFFECT: none on any existing surface. Every writer of these tables is
-- CreatorAttributionService / CreatorLedgerOperations, gated fail-closed on
-- creator_attribution_enabled (2922, seeded FALSE). Both ledgers hold zero rows
-- in every database this file could reach (census §17.3).
--
-- Rollback: db/rollback/2026-09-27-3387-creator-ledger-integrity-and-audit-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.creator_attributions') IS NULL
     OR to_regclass('public.creator_earning_entries') IS NULL
     OR to_regclass('public.creator_rule_versions') IS NULL THEN
    RAISE EXCEPTION '3387: PRECONDITION FAILED: 2920/2921 are not applied.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'creator_attributions' AND column_name = 'recommendation_id'
  ) THEN
    RAISE EXCEPTION '3387: PRECONDITION FAILED: creator_attributions.recommendation_id is absent (3386 not applied); supersession identity must include it.';
  END IF;
  IF to_regclass('public.rent_buddy_earnings_entries') IS NULL THEN
    RAISE EXCEPTION '3387: PRECONDITION FAILED: public.rent_buddy_earnings_entries is absent (2901); the one-earning-one-ledger rule reads it.';
  END IF;
  IF to_regclass('public.creator_ledger_audit_events') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'creator_ledger_audit_events' AND column_name = 'resulting_attribution_id'
  ) THEN
    RAISE EXCEPTION '3387: PRECONDITION FAILED: public.creator_ledger_audit_events exists and is not the table this file creates.';
  END IF;
END
$pre$;

-- ═══════════════════════════════════════════════════════════════════════════
-- (6) Account erasure reaches the earning entries.
-- ═══════════════════════════════════════════════════════════════════════════
DO $fk$
DECLARE
  att smallint;
  cname text;
  deltype "char";
BEGIN
  SELECT attnum INTO att FROM pg_attribute
   WHERE attrelid = 'public.creator_earning_entries'::regclass AND attname = 'attribution_id';
  SELECT conname, confdeltype INTO cname, deltype FROM pg_constraint
   WHERE conrelid = 'public.creator_earning_entries'::regclass AND contype = 'f'
     AND conkey = ARRAY[att]
     AND confrelid = 'public.creator_attributions'::regclass;
  IF cname IS NULL THEN
    RAISE EXCEPTION '3387: the attribution_id foreign key is absent from creator_earning_entries';
  END IF;
  IF deltype <> 'c' THEN
    EXECUTE format('ALTER TABLE public.creator_earning_entries DROP CONSTRAINT %I', cname);
    ALTER TABLE public.creator_earning_entries
      ADD CONSTRAINT cee_attribution_fk FOREIGN KEY (attribution_id)
      REFERENCES public.creator_attributions(id) ON DELETE CASCADE;
    RAISE NOTICE '3387: % replaced by cee_attribution_fk ON DELETE CASCADE', cname;
  END IF;

  -- (b) the beneficiary FK: SET NULL is an UPDATE on an append-only table.
  SELECT attnum INTO att FROM pg_attribute
   WHERE attrelid = 'public.creator_earning_entries'::regclass AND attname = 'beneficiary_user_id';
  cname := NULL;
  SELECT conname, confdeltype INTO cname, deltype FROM pg_constraint
   WHERE conrelid = 'public.creator_earning_entries'::regclass AND contype = 'f'
     AND conkey = ARRAY[att]
     AND confrelid = 'public.profiles'::regclass;
  IF cname IS NULL THEN
    RAISE EXCEPTION '3387: the beneficiary_user_id foreign key is absent from creator_earning_entries';
  END IF;
  IF deltype <> 'c' THEN
    EXECUTE format('ALTER TABLE public.creator_earning_entries DROP CONSTRAINT %I', cname);
    ALTER TABLE public.creator_earning_entries
      ADD CONSTRAINT cee_beneficiary_fk FOREIGN KEY (beneficiary_user_id)
      REFERENCES public.profiles(id) ON DELETE CASCADE;
    RAISE NOTICE '3387: % replaced by cee_beneficiary_fk ON DELETE CASCADE', cname;
  END IF;
END
$fk$;

-- ═══════════════════════════════════════════════════════════════════════════
-- The lock both write paths take on one attribution.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.creator_ledger_lock_attribution(p_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path TO ''
AS $fn$
  SELECT pg_advisory_xact_lock(hashtextextended('creator_attribution:' || p_id::text, 0));
$fn$;
COMMENT ON FUNCTION public.creator_ledger_lock_attribution(uuid) IS
  '3387: serialises every write that depends on whether an attribution is the current, unheld head of its chain — a booking against it and a supersession of it. Transaction-scoped advisory lock: service_role holds no UPDATE, so SELECT ... FOR UPDATE is unavailable to it.';
REVOKE ALL ON FUNCTION public.creator_ledger_lock_attribution(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.creator_ledger_lock_attribution(uuid) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- (3) Rule versions are published, and an original uses the one in force.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.creator_attribution_rule_version_is_published()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path TO ''
AS $fn$
DECLARE in_force text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.creator_rule_versions v
     WHERE v.creator_type = NEW.creator_type
       AND v.rule_version = NEW.rule_version
       AND v.effective_from <= NEW.computed_at
  ) THEN
    RAISE EXCEPTION
      'creator_attributions: rule_version % is not a published % rule in effect by % (07 §8/§10: an earning under a version nobody published cannot be recomputed)',
      NEW.rule_version, NEW.creator_type, NEW.computed_at
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.supersedes_id IS NULL THEN
    SELECT v.rule_version INTO in_force FROM public.creator_rule_versions v
     WHERE v.creator_type = NEW.creator_type AND v.effective_from <= NEW.computed_at
     ORDER BY v.effective_from DESC LIMIT 1;
    IF in_force IS DISTINCT FROM NEW.rule_version THEN
      RAISE EXCEPTION
        'creator_attributions: stale_rule_version — a new % attribution must be computed under the version in force (%), not %',
        NEW.creator_type, in_force, NEW.rule_version
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.creator_attribution_rule_version_is_published() FROM PUBLIC;

DROP TRIGGER IF EXISTS ca_rule_version_is_published ON public.creator_attributions;
CREATE TRIGGER ca_rule_version_is_published
  BEFORE INSERT ON public.creator_attributions
  FOR EACH ROW EXECUTE FUNCTION public.creator_attribution_rule_version_is_published();

-- ═══════════════════════════════════════════════════════════════════════════
-- (1)(2) A supersession is a hold, a release or a recomputation — nothing else.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.creator_attribution_supersession_is_lawful()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path TO ''
AS $fn$
DECLARE p public.creator_attributions%ROWTYPE;
BEGIN
  IF NEW.supersedes_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM public.creator_ledger_lock_attribution(NEW.supersedes_id);
  SELECT * INTO p FROM public.creator_attributions WHERE id = NEW.supersedes_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'creator_attributions: supersedes_id % does not exist', NEW.supersedes_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW.creator_type <> p.creator_type
     OR NEW.subject_kind <> p.subject_kind
     OR NEW.subject_id <> p.subject_id
     OR NEW.value_event <> p.value_event
     OR NEW.value_event_id IS DISTINCT FROM p.value_event_id
     OR NEW.attribution_basis <> p.attribution_basis
     OR NEW.beneficiary_user_id <> p.beneficiary_user_id
     OR NEW.currency <> p.currency
     OR NEW.recommendation_id IS DISTINCT FROM p.recommendation_id THEN
    RAISE EXCEPTION
      'creator_attributions: supersession_changes_identity — row % may only supersede an attribution of the same type, subject, value event, beneficiary, basis, currency and recommendation',
      NEW.idempotency_key
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.rule_version = p.rule_version THEN
    -- HOLD or RELEASE: a fact about the SAME computation, so the figures carry
    -- forward exactly (07 §9: a detection must not blank its evidence).
    IF NEW.gross_revenue_minor <> p.gross_revenue_minor
       OR NEW.provisional_share_minor <> p.provisional_share_minor
       OR NEW.weight <> p.weight
       OR NEW.confidence <> p.confidence THEN
      RAISE EXCEPTION
        'creator_attributions: a hold or release must carry the held computation''s figures unchanged (row %)', NEW.idempotency_key
        USING ERRCODE = 'check_violation';
    END IF;
    IF p.fraud_hold = NEW.fraud_hold THEN
      RAISE EXCEPTION
        'creator_attributions: supersession_is_not_a_transition — same rule version and same hold state (%): nothing was held, released or recomputed',
        NEW.fraud_hold
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- RECOMPUTE: a different, published version (ca_rule_version_is_published).
  IF p.fraud_hold OR NEW.fraud_hold THEN
    RAISE EXCEPTION
      'creator_attributions: recompute_while_held — release the hold on % before recomputing it; a recomputation must not quietly carry or drop a hold',
      p.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF p.attribution_basis <> 'recorded_value_event' THEN
    RAISE EXCEPTION
      'creator_attributions: a seam has no computation to recompute (row %)', p.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.creator_attribution_supersession_is_lawful() FROM PUBLIC;

DROP TRIGGER IF EXISTS ca_supersession_is_lawful ON public.creator_attributions;
CREATE TRIGGER ca_supersession_is_lawful
  BEFORE INSERT ON public.creator_attributions
  FOR EACH ROW EXECUTE FUNCTION public.creator_attribution_supersession_is_lawful();

-- ═══════════════════════════════════════════════════════════════════════════
-- (1)(2)(5) + one earning, one ledger: what an entry may be booked against.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.creator_earning_attribution_is_current()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path TO ''
AS $fn$
DECLARE
  a public.creator_attributions%ROWTYPE;
  o public.creator_earning_entries%ROWTYPE;
BEGIN
  IF NEW.entry_reason = 'reversal' THEN
    -- A correction of history is always permitted — against a held or a
    -- superseded attribution too; that is what a correction is. It must be
    -- the exact negation of what it corrects.
    SELECT * INTO o FROM public.creator_earning_entries WHERE id = NEW.reverses_entry_id;
    IF NOT FOUND THEN
      RETURN NEW;  -- the FK reports the missing row with its own message
    END IF;
    IF o.attribution_id <> NEW.attribution_id OR o.account <> NEW.account
       OR o.currency <> NEW.currency OR o.rule_version <> NEW.rule_version
       OR o.amount_minor <> -NEW.amount_minor OR o.creator_type <> NEW.creator_type
       OR o.beneficiary_user_id IS DISTINCT FROM NEW.beneficiary_user_id THEN
      RAISE EXCEPTION
        'creator_earning_entries: reversal_is_not_a_negation — % must negate entry % exactly (same attribution, account, currency, rule version, beneficiary; opposite amount)',
        NEW.idempotency_key, NEW.reverses_entry_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  PERFORM public.creator_ledger_lock_attribution(NEW.attribution_id);
  SELECT * INTO a FROM public.creator_attributions WHERE id = NEW.attribution_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- 2921's trigger and the FK report it
  END IF;
  IF EXISTS (SELECT 1 FROM public.creator_attributions s WHERE s.supersedes_id = a.id) THEN
    RAISE EXCEPTION
      'creator_earning_entries: attribution_not_current — % has been superseded (held, released or recomputed); book against the current head of its chain',
      a.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF a.fraud_hold THEN
    RAISE EXCEPTION
      'creator_earning_entries: attribution_held — % is under a fraud hold (%); nothing may be earned against it until the hold is released (07 §9)',
      a.id, a.fraud_hold_reason
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.rule_version <> a.rule_version THEN
    RAISE EXCEPTION
      'creator_earning_entries: stale_rule_version — entry under % against an attribution computed under %',
      NEW.rule_version, a.rule_version
      USING ERRCODE = 'check_violation';
  END IF;
  IF a.subject_kind = 'booking' AND EXISTS (
    SELECT 1 FROM public.rent_buddy_earnings_entries r WHERE r.booking_id = a.subject_id
  ) THEN
    RAISE EXCEPTION
      'creator_earning_entries: booked_in_subsystem_ledger — booking %''s earning is already booked in rent_buddy_earnings_entries; booking it here too would count it twice in creator_share_ledger',
      a.subject_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.creator_earning_attribution_is_current() FROM PUBLIC;

DROP TRIGGER IF EXISTS cee_attribution_is_current ON public.creator_earning_entries;
CREATE TRIGGER cee_attribution_is_current
  BEFORE INSERT ON public.creator_earning_entries
  FOR EACH ROW EXECUTE FUNCTION public.creator_earning_attribution_is_current();

-- ═══════════════════════════════════════════════════════════════════════════
-- (4) Every transaction balances, checked at COMMIT.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.creator_earning_transaction_balances()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path TO ''
AS $fn$
DECLARE residual numeric;
BEGIN
  SELECT coalesce(sum(amount_minor), 0) INTO residual
    FROM public.creator_earning_entries
   WHERE transaction_key = NEW.transaction_key AND currency = NEW.currency;
  IF residual <> 0 THEN
    RAISE EXCEPTION
      'creator_earning_entries: transaction_unbalanced — transaction % (%) sums to %, not 0 (09 §5.3 I1)',
      NEW.transaction_key, NEW.currency, residual
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.creator_earning_transaction_balances() FROM PUBLIC;

DROP TRIGGER IF EXISTS cee_transaction_balances ON public.creator_earning_entries;
CREATE CONSTRAINT TRIGGER cee_transaction_balances
  AFTER INSERT ON public.creator_earning_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.creator_earning_transaction_balances();

-- ═══════════════════════════════════════════════════════════════════════════
-- (7) The audit record.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.creator_ledger_audit_events (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  action                    text        NOT NULL,
  -- 'admin' carries the admin's profile id; 'system' is a scheduler or producer.
  actor_kind                text        NOT NULL,
  -- An audit FACT, deliberately not a foreign key. ON DELETE SET NULL would be
  -- an UPDATE, which clae_no_update refuses (the defect (6)(b) fixes on
  -- creator_earning_entries), so an admin's own erasure would be blocked by the
  -- record of their actions; and CASCADE would erase the record of who held a
  -- creator's money. Who acted is kept as the id that acted.
  actor_user_id             uuid        NULL,
  -- The attribution the action was taken ON, and the row it produced (if any).
  -- CASCADE: account erasure of the credited creator removes the audit trail of
  -- their attributions with them (the audit is about the creator's money).
  attribution_id            uuid        NOT NULL REFERENCES public.creator_attributions(id) ON DELETE CASCADE,
  resulting_attribution_id  uuid        NULL REFERENCES public.creator_attributions(id) ON DELETE CASCADE,
  reason                    text        NULL,
  detail                    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key           text        NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT clae_action_known CHECK (action IN (
    'hold_placed', 'hold_released', 'recomputed', 'reversed')),
  CONSTRAINT clae_actor_kind_known CHECK (actor_kind IN ('admin', 'system')),
  -- Every action here changes what a creator is owed or whether it can move;
  -- one with no stated reason is indistinguishable from a bug.
  CONSTRAINT clae_reason_given CHECK (reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT clae_idempotency_shape CHECK (length(idempotency_key) BETWEEN 1 AND 400),
  -- A hold, a release and a recomputation each produce a superseding row.
  CONSTRAINT clae_supersession_named CHECK (
    (action IN ('hold_placed', 'hold_released', 'recomputed')) = (resulting_attribution_id IS NOT NULL))
);
COMMENT ON TABLE public.creator_ledger_audit_events IS
  '3387: 11 §8 "creator fraud holds" / "ledger audit", 11 §10 "admin actions are audited". One append-only row per hold, release, recomputation or reversal of a creator ledger record, written in the SAME transaction as the change by public.creator_ledger_append, carrying the actor and the reason — including the reason a hold was LIFTED, which creator_attributions cannot hold (ca_hold_is_explained ties a reason to fraud_hold = true). No client grant.';

CREATE UNIQUE INDEX IF NOT EXISTS clae_idempotency_key_once
  ON public.creator_ledger_audit_events (idempotency_key);
CREATE INDEX IF NOT EXISTS clae_attribution_idx
  ON public.creator_ledger_audit_events (attribution_id, created_at DESC);
CREATE INDEX IF NOT EXISTS clae_resulting_idx
  ON public.creator_ledger_audit_events (resulting_attribution_id)
  WHERE resulting_attribution_id IS NOT NULL;

DROP TRIGGER IF EXISTS clae_no_update ON public.creator_ledger_audit_events;
CREATE TRIGGER clae_no_update
  BEFORE UPDATE ON public.creator_ledger_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.intel_append_only();

ALTER TABLE public.creator_ledger_audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.creator_ledger_audit_events FROM PUBLIC, anon, authenticated, service_role;
-- DELETE only so the account-erasure cascade can fire; never a correction path.
GRANT INSERT, SELECT, DELETE ON public.creator_ledger_audit_events TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- (8) The one-transaction door.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.creator_ledger_append(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path TO ''
AS $fn$
DECLARE
  a          jsonb := p->'attribution';
  new_id     uuid  := NULL;
  a_inserted boolean := false;
  ex         public.creator_attributions%ROWTYPE;
  e          jsonb;
  e_att      uuid;
  e_id       uuid;
  ee         public.creator_earning_entries%ROWTYPE;
  n_ins      int := 0;
  n_rep      int := 0;
  au         jsonb := p->'audit';
  au_id      uuid := NULL;
  au_ins     boolean := false;
  au_att     uuid;
  au_res     uuid;
  exa        public.creator_ledger_audit_events%ROWTYPE;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'creator_ledger_append: payload must be a JSON object' USING ERRCODE = '22023';
  END IF;

  -- ── 1. The attribution, when the operation produces one ────────────────
  IF a IS NOT NULL AND jsonb_typeof(a) = 'object' THEN
    INSERT INTO public.creator_attributions
      (creator_type, subject_kind, subject_id, value_event, value_event_id,
       attribution_basis, beneficiary_user_id, weight, confidence,
       gross_revenue_minor, provisional_share_minor, currency, settled_minor,
       rule_version, fraud_hold, fraud_hold_reason, supersedes_id,
       idempotency_key, recommendation_id)
    VALUES
      (a->>'creator_type', a->>'subject_kind', (a->>'subject_id')::uuid, a->>'value_event',
       NULLIF(a->>'value_event_id', '')::uuid, a->>'attribution_basis',
       (a->>'beneficiary_user_id')::uuid, (a->>'weight')::numeric, (a->>'confidence')::numeric,
       (a->>'gross_revenue_minor')::bigint, (a->>'provisional_share_minor')::bigint,
       a->>'currency', 0, a->>'rule_version', (a->>'fraud_hold')::boolean,
       a->>'fraud_hold_reason', NULLIF(a->>'supersedes_id', '')::uuid,
       a->>'idempotency_key', a->>'recommendation_id')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO new_id;

    IF new_id IS NOT NULL THEN
      a_inserted := true;
    ELSE
      SELECT * INTO ex FROM public.creator_attributions WHERE idempotency_key = a->>'idempotency_key';
      IF ex.supersedes_id IS DISTINCT FROM NULLIF(a->>'supersedes_id', '')::uuid
         OR ex.rule_version <> a->>'rule_version'
         OR ex.fraud_hold <> (a->>'fraud_hold')::boolean
         OR ex.fraud_hold_reason IS DISTINCT FROM a->>'fraud_hold_reason'
         OR ex.beneficiary_user_id <> (a->>'beneficiary_user_id')::uuid
         OR ex.subject_id <> (a->>'subject_id')::uuid
         OR ex.gross_revenue_minor <> (a->>'gross_revenue_minor')::bigint
         OR ex.provisional_share_minor <> (a->>'provisional_share_minor')::bigint
         OR ex.recommendation_id IS DISTINCT FROM a->>'recommendation_id' THEN
        RAISE EXCEPTION
          'creator_ledger_append: conflicting_replay — attribution key % is already recorded with different content',
          a->>'idempotency_key'
          USING ERRCODE = 'CL409';
      END IF;
      new_id := ex.id;
    END IF;
  END IF;

  -- ── 2. The entries ──────────────────────────────────────────────────────
  FOR e IN SELECT value FROM jsonb_array_elements(coalesce(p->'entries', '[]'::jsonb)) LOOP
    IF e->>'attribution_id' = '$new' THEN
      IF new_id IS NULL THEN
        RAISE EXCEPTION 'creator_ledger_append: an entry targets $new but the payload carries no attribution'
          USING ERRCODE = '22023';
      END IF;
      e_att := new_id;
    ELSE
      e_att := (e->>'attribution_id')::uuid;
    END IF;

    e_id := NULL;
    INSERT INTO public.creator_earning_entries
      (transaction_key, creator_type, attribution_id, account, entry_reason,
       revenue_source, amount_minor, currency, cash_settled_minor, rule_version,
       beneficiary_user_id, reverses_entry_id, provider, external_ref, idempotency_key)
    VALUES
      (e->>'transaction_key', e->>'creator_type', e_att, e->>'account', e->>'entry_reason',
       e->>'revenue_source', (e->>'amount_minor')::bigint, e->>'currency', 0, e->>'rule_version',
       NULLIF(e->>'beneficiary_user_id', '')::uuid, NULLIF(e->>'reverses_entry_id', '')::uuid,
       coalesce(e->>'provider', 'none'), e->>'external_ref', e->>'idempotency_key')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO e_id;

    IF e_id IS NOT NULL THEN
      n_ins := n_ins + 1;
    ELSE
      SELECT * INTO ee FROM public.creator_earning_entries WHERE idempotency_key = e->>'idempotency_key';
      IF ee.attribution_id <> e_att OR ee.account <> e->>'account'
         OR ee.amount_minor <> (e->>'amount_minor')::bigint
         OR ee.currency <> e->>'currency' OR ee.rule_version <> e->>'rule_version'
         OR ee.entry_reason <> e->>'entry_reason'
         OR ee.reverses_entry_id IS DISTINCT FROM NULLIF(e->>'reverses_entry_id', '')::uuid THEN
        RAISE EXCEPTION
          'creator_ledger_append: conflicting_replay — entry key % is already recorded with different content',
          e->>'idempotency_key'
          USING ERRCODE = 'CL409';
      END IF;
      n_rep := n_rep + 1;
    END IF;
  END LOOP;

  -- ── 3. The audit row ────────────────────────────────────────────────────
  IF au IS NOT NULL AND jsonb_typeof(au) = 'object' THEN
    au_att := CASE WHEN au->>'attribution_id' = '$new' THEN new_id ELSE (au->>'attribution_id')::uuid END;
    au_res := CASE WHEN au->>'resulting_attribution_id' = '$new' THEN new_id
                   ELSE NULLIF(au->>'resulting_attribution_id', '')::uuid END;
    INSERT INTO public.creator_ledger_audit_events
      (action, actor_kind, actor_user_id, attribution_id, resulting_attribution_id,
       reason, detail, idempotency_key)
    VALUES
      (au->>'action', au->>'actor_kind', NULLIF(au->>'actor_user_id', '')::uuid, au_att, au_res,
       au->>'reason', coalesce(au->'detail', '{}'::jsonb), au->>'idempotency_key')
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO au_id;
    IF au_id IS NOT NULL THEN
      au_ins := true;
    ELSE
      SELECT * INTO exa FROM public.creator_ledger_audit_events WHERE idempotency_key = au->>'idempotency_key';
      IF exa.action <> au->>'action' OR exa.attribution_id <> au_att
         OR exa.resulting_attribution_id IS DISTINCT FROM au_res THEN
        RAISE EXCEPTION
          'creator_ledger_append: conflicting_replay — audit key % is already recorded for a different action',
          au->>'idempotency_key'
          USING ERRCODE = 'CL409';
      END IF;
      au_id := exa.id;
    END IF;
  END IF;

  -- The balance check (cee_transaction_balances) is DEFERRED; run it now so a
  -- caller learns of an unbalanced payload from this call, inside this
  -- transaction, rather than from a failed COMMIT it may not be reading.
  SET CONSTRAINTS public.cee_transaction_balances IMMEDIATE;

  RETURN jsonb_build_object(
    'attribution_id',       new_id,
    'attribution_inserted', a_inserted,
    'entries_inserted',     n_ins,
    'entries_replayed',     n_rep,
    'audit_id',             au_id,
    'audit_inserted',       au_ins
  );
END;
$fn$;
COMMENT ON FUNCTION public.creator_ledger_append(jsonb) IS
  '3387: the one-transaction door for creator ledger operations that span rows — a hold, a release, a recomputation (supersede + reverse + rebook) or a reversal, each WITH its audit row. One call is one transaction: everything is appended or nothing is. Idempotent by key; a replay whose content differs from what the key recorded raises SQLSTATE CL409 (conflicting_replay) instead of reporting success. SECURITY INVOKER; EXECUTE for service_role only; every trigger on the three tables still applies.';
REVOKE ALL ON FUNCTION public.creator_ledger_append(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.creator_ledger_append(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.creator_ledger_append(jsonb) TO service_role;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.creator_earning_entries'::regclass AND contype = 'f'
     AND confrelid = 'public.creator_attributions'::regclass AND confdeltype = 'c';
  IF n <> 1 THEN
    RAISE EXCEPTION '3387: POSTCONDITION FAILED: creator_earning_entries.attribution_id does not cascade; account erasure stays blocked';
  END IF;
  -- No foreign key on any append-only creator-ledger table may SET NULL: that
  -- is an UPDATE, and the append-only trigger refuses it, blocking erasure.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype = 'f' AND confdeltype IN ('n', 'd')
     AND conrelid IN ('public.creator_earning_entries'::regclass, 'public.creator_attributions'::regclass,
                      'public.creator_ledger_audit_events'::regclass);
  IF n <> 0 THEN
    RAISE EXCEPTION '3387: POSTCONDITION FAILED: % SET NULL / SET DEFAULT foreign key(s) on an append-only creator-ledger table; erasure would be refused as an UPDATE', n;
  END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE NOT tgisinternal AND (
         (tgrelid = 'public.creator_attributions'::regclass
          AND tgname IN ('ca_rule_version_is_published', 'ca_supersession_is_lawful'))
      OR (tgrelid = 'public.creator_earning_entries'::regclass
          AND tgname IN ('cee_attribution_is_current'))
      OR (tgrelid = 'public.creator_ledger_audit_events'::regclass
          AND tgname IN ('clae_no_update')));
  IF n <> 4 THEN RAISE EXCEPTION '3387: POSTCONDITION FAILED: % of 4 row triggers present', n; END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'public.creator_earning_entries'::regclass
     AND tgname = 'cee_transaction_balances' AND tgconstraint <> 0 AND tgdeferrable AND tginitdeferred;
  IF n <> 1 THEN RAISE EXCEPTION '3387: POSTCONDITION FAILED: the deferred balance constraint trigger is absent'; END IF;

  IF has_table_privilege('service_role', 'public.creator_ledger_audit_events', 'UPDATE') THEN
    RAISE EXCEPTION '3387: POSTCONDITION FAILED: service_role has UPDATE on the audit table';
  END IF;
  IF has_table_privilege('authenticated', 'public.creator_ledger_audit_events', 'SELECT')
     OR has_table_privilege('anon', 'public.creator_ledger_audit_events', 'SELECT') THEN
    RAISE EXCEPTION '3387: POSTCONDITION FAILED: a client role can read the audit table';
  END IF;
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relname = 'creator_ledger_audit_events' AND NOT c.relrowsecurity;
  IF n > 0 THEN RAISE EXCEPTION '3387: POSTCONDITION FAILED: RLS is disabled on the audit table'; END IF;

  IF has_function_privilege('anon', 'public.creator_ledger_append(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.creator_ledger_append(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '3387: POSTCONDITION FAILED: a client role can execute creator_ledger_append';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.creator_ledger_append(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '3387: POSTCONDITION FAILED: service_role cannot execute creator_ledger_append';
  END IF;
  SELECT count(*) INTO n FROM pg_proc WHERE oid = 'public.creator_ledger_append(jsonb)'::regprocedure AND prosecdef;
  IF n <> 0 THEN RAISE EXCEPTION '3387: POSTCONDITION FAILED: creator_ledger_append is SECURITY DEFINER'; END IF;

  -- PROVE the published-version rule rather than assert it: an original row
  -- under a version nobody published must be refused.
  DECLARE probe_user uuid; accepted boolean := false;
  BEGIN
    SELECT p.id INTO probe_user FROM public.profiles p LIMIT 1;
    IF probe_user IS NULL THEN
      RAISE WARNING '3387: unpublished-version probe SKIPPED — public.profiles is empty on this database';
    ELSE
      BEGIN
        INSERT INTO public.creator_attributions
          (creator_type, subject_kind, subject_id, value_event, value_event_id,
           attribution_basis, beneficiary_user_id, rule_version, idempotency_key)
        VALUES
          ('trail_builder', 'trail', gen_random_uuid(), 'route_completion', NULL,
           'seam_no_producer', probe_user, 'creator-rules/trail-builder/v999', '3387-postcondition-probe');
        accepted := true;
      EXCEPTION WHEN check_violation THEN NULL;
      END;
      IF accepted THEN
        RAISE EXCEPTION '3387: POSTCONDITION FAILED: an attribution under an unpublished rule version was accepted';
      END IF;
    END IF;
  END;
END
$post$;

COMMIT;

-- REVERSAL: db/rollback/2026-09-27-3387-creator-ledger-integrity-and-audit-rollback.sql
-- drops the door, the audit table, the five triggers and their functions, and
-- restores the NO ACTION foreign key. It REFUSES while the audit table holds
-- rows (they are the only record of who held, released or recomputed what).
