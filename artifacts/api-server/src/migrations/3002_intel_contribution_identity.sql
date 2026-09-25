-- 3002_intel_contribution_identity.sql
-- Sensing / World Intelligence — the contribution identity and subject boundary.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; 3001 is the highest
-- file on disk). 2130 is checksum-ledgered and is NOT edited: this is the
-- forward change.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY
-- ═══════════════════════════════════════════════════════════════════════════
-- The Sensing spec names two prohibitions that 2130's storage layer violates by
-- construction, and both are named again in its paste-ready directive (§23):
--
--   §3  "World-intelligence contribution records should not carry a permanent
--        profiles.id / account user_id foreign key unless a narrowly justified,
--        reviewed security requirement proves it necessary."
--   §24 "World Intelligence store cannot trivially resolve a contribution to a
--        Portava account."
--   §18.3 "Observed activity cluster -> Place? Event? Temporary world object?
--        Unknown?  NEVER ASSIGN TO THE NEAREST PLACE MERELY TO SATISFY A
--        FOREIGN KEY."
--   §14  "Temporary activity must not be forced onto nearest place ID when
--        ownership is unknown."
--
-- 2130 declares, on the one contribution table that has a writer:
--
--   2130_intel_storage.sql:142  actor_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE
--   2130_intel_storage.sql:144  subject_id uuid NOT NULL REFERENCES public.places(id)   ON DELETE CASCADE
--
-- The first resolves every contribution to an account, by foreign key, by
-- design. The second makes `unknown` and `temporary_world_object` UNSTORABLE,
-- and that NOT NULL is the stated motive for the nearest-place snap in
-- routes/mapObservations.ts — the §18.3 sentence quoted verbatim above.
--
-- This migration removes both. It is ADDITIVE in the §22 sense (no table, no
-- column and no row is dropped); what it drops are four CONSTRAINTS and one
-- policy, and it replaces each with something that carries the same weight.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. WHAT REPLACES THE ACCOUNT FOREIGN KEY: A ROTATING CONTRIBUTOR TOKEN
-- ═══════════════════════════════════════════════════════════════════════════
-- `actor_id` is NOT dropped and is NOT emptied. Its CONTENT changes, and the
-- change is enforced by the database rather than by the application:
--
--     app inserts  actor_id = <profiles.id>          (the ingest credential)
--            |
--            v  BEFORE INSERT trigger, SECURITY DEFINER
--     stored row   actor_id = <rotating contributor token>
--
-- The token is sha256(pepper_for_epoch || actor_id), rendered as a uuid. The
-- pepper is a 256-bit random value minted per 7-DAY EPOCH and held in
-- public.intel_contributor_pepper, a table with RLS on, zero policies and zero
-- grants — not even service_role can read it. So no account id is ever stored
-- in a contribution record, and no application bug can put one there: the
-- boundary is a trigger on the table, not a rule someone has to remember.
--
-- WHY THE COLUMN IS NOT RENAMED, STATED PLAINLY BECAUSE IT READS AS A LIE
-- OTHERWISE. `actor_id` is selected by eleven modules outside this lane
-- (lib/intelProjectionAggregator, lib/crowdFlowProducer, lib/intelCalibrationScheduler,
-- lib/media/mediaTimeBands, services/media/MediaContributorReputationService,
-- src/scripts/reportIntelFunnel and the rest). A rename turns every one of them
-- into a PostgREST 400 at once; keeping the name means the COUNT-shaped readers
-- (distinct contributors, the k-anonymity independence floor, calibration
-- cohorts) keep computing the right answer over the token, because a token is
-- exactly as distinct per contributor as the account id was. The readers that
-- JOIN the column to an account are the ones that must change, and they are the
-- ones this migration is about. COMMENT ON COLUMN, below, says so on the column
-- itself so a reader of the schema cannot miss it.
--
-- WHAT THE TOKEN PRESERVES (the audit/abuse story 2130's actor_id carried):
--   * idempotency        unique (actor_id, idempotency_key) still dedupes a
--                        contributor's double-tap — same contributor, same
--                        token, within an epoch.
--   * one stance a claim unique (claim_id, actor_id) on intel_confirmations
--                        still refuses a second vote.
--   * independence       distinct-actor counting and group_key are unchanged in
--                        meaning; the privacy gate's k-floor still counts
--                        contributors, not rows.
--   * moderation         a moderator can still group a contributor's recent
--                        contributions and act on the set.
--   * ERASURE            erase_intel_for_actor(uuid) is rebuilt below to derive
--                        the actor's token for EVERY live epoch and delete on
--                        `actor_id = p_actor_id OR actor_id = ANY(tokens)`. The
--                        first arm erases pre-3002 rows, the second erases
--                        post-3002 rows. Account deletion is unchanged from
--                        AccountDeletionService's point of view.
--
-- WHAT IT DOES NOT PRESERVE, RECORDED AS AN ACCEPTED COST, NOT HIDDEN:
--   a) One stance per claim degrades to one stance per claim PER EPOCH. Claim
--      TTLs are hours (lib/intelContracts CLAIM_TYPES); an epoch is a week, so
--      a claim that outlives an epoch boundary is the only case, and the cost is
--      one extra stance from one contributor.
--   b) THE RESIDUAL LINK. The database can still derive a token from an account
--      id, so an operator holding the pepper could enumerate profiles and match.
--      That is not an oversight — it is what the right to erasure costs. It is
--      bounded three ways: the pepper is unreadable by every application role;
--      it ROTATES weekly; and once an epoch's contributions have passed the
--      180-day retention sweep (2173 purge_intel_contributions_older_than) that
--      epoch's pepper row can be deleted, after which those rows are
--      permanently unlinkable. Deleting spent peppers is NOT automated here —
--      no scheduler is added by this migration — and that is stated as OWED
--      rather than claimed.
--   c) Tables OUTSIDE this migration's scope still bridge an observation to an
--      account: intel_presence_verifications (2276), intel_attributions (2277),
--      intel_scoped_trust (2278) and intel_reward_ledger (2170) each carry
--      actor_id -> profiles AND (for the first two) observation_id ->
--      intel_observations. Those exist to VERIFY, to SCORE and to PAY a person,
--      which is a different purpose with a different lawful basis, and changing
--      them is a separate ruling. Until that ruling, the §24 checklist item is
--      satisfied for the contribution tables and NOT for the intel family as a
--      whole. Saying so here is the point.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 2. WHAT REPLACES `subject_id NOT NULL`: THE FOUR §18.3 OUTCOMES
-- ═══════════════════════════════════════════════════════════════════════════
-- NOT NULL is dropped. REFERENCES public.places(id) is KEPT, and the difference
-- is the whole design: what forced the nearest-place snap was the NOT NULL — a
-- zone contribution had to name SOME place — and a nullable FK still guarantees
-- that a non-null subject is a real place. Nothing is weakened; a requirement is
-- removed.
--
-- With it gone, all four §18.3 outcomes are storable, and a CHECK makes the rule
-- structural rather than advisory:
--
--   place / event            subject_id IS NOT NULL   (an OWNERSHIP signal
--                                                      resolved it — see
--                                                      lib/sensingSubjectReconciliation)
--   temporary_world_object   subject_id IS NULL, zone_id IS NOT NULL
--   unknown                  subject_id IS NULL, zone_id IS NOT NULL
--
-- intel_observations_subject_resolution_check refuses the two shapes that would
-- re-introduce the defect: an unowned cluster carrying a place id, and an
-- unowned cluster carrying neither a place nor a zone. There is no longer a
-- foreign key to satisfy, so there is nothing for a nearest-place resolver to
-- be for — routes/mapObservations.ts deletes its one in the same change.
--
-- DOWNSTREAM, DELIBERATELY UNCHANGED: intel_claims.subject_id and
-- intel_state_snapshots.subject_id stay NOT NULL REFERENCES places(id). A claim
-- is a published proposition ABOUT A PLACE; an unowned cluster has no place to
-- make one about, and inventing one is the snap by another route. The refusal
-- is explicit in IntelCaptureService.proposeClaim ('unresolved_subject'), not a
-- foreign-key 500.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- RUNTIME EFFECT
-- ═══════════════════════════════════════════════════════════════════════════
-- Capture is behind intel_capture_quick_signal and map_contributions_enabled,
-- both off. This migration has NOT been applied to any database. The TypeScript
-- in this lane reads correctly against BOTH schemas (pre- and post-3002) on
-- purpose; the pre-3002 branches are marked and become dead on apply.

BEGIN;

-- ── Preconditions ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.intel_observations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_observations does not exist. Apply 2130 first.';
  END IF;
  IF to_regclass('public.intel_evidence') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_evidence does not exist. Apply 2130 first.';
  END IF;
  IF to_regclass('public.intel_confirmations') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.intel_confirmations does not exist. Apply 2130 first.';
  END IF;
  -- Referenced by the catalogue lookups below ('public.profiles'::regclass) and
  -- by the postcondition that checks no stored value still resolves to an account.
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles does not exist.';
  END IF;
  IF to_regprocedure('public.erase_intel_for_actor(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: erase_intel_for_actor(uuid) is missing (2130, replaced by 2278). This migration rebuilds it as a superset and must not be the first to create it.';
  END IF;
  IF to_regclass('public.intel_scoped_trust') IS NULL OR to_regclass('public.intel_attributions') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: 2277/2278 tables missing — the erasure rebuild below would silently drop their deletes.';
  END IF;
  -- sha256(bytea) is core from PG11; gen_random_uuid() is core from PG13. The
  -- token derivation uses both and takes NO extension dependency (pgcrypto is
  -- not installed in this project's public schema).
  IF to_regprocedure('pg_catalog.sha256(bytea)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: pg_catalog.sha256(bytea) is unavailable (needs PostgreSQL 11+). The contributor token cannot be derived.';
  END IF;
  IF to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: pg_catalog.gen_random_uuid() is unavailable (needs PostgreSQL 13+ or pgcrypto). The epoch pepper cannot be minted.';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The epoch pepper — the only secret, readable by nothing
-- ═══════════════════════════════════════════════════════════════════════════
-- One row per 7-day epoch. RLS on, ZERO policies, and ALL privileges revoked
-- from service_role as well as anon/authenticated: the only readers are the
-- SECURITY DEFINER functions below, which run as the table's owner. A PostgREST
-- caller holding the service role key cannot select a pepper.
CREATE TABLE IF NOT EXISTS public.intel_contributor_pepper (
  epoch      integer PRIMARY KEY,
  pepper     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intel_contributor_pepper_entropy CHECK (length(pepper) >= 48)
);

ALTER TABLE public.intel_contributor_pepper ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.intel_contributor_pepper FROM PUBLIC;
REVOKE ALL ON public.intel_contributor_pepper FROM anon;
REVOKE ALL ON public.intel_contributor_pepper FROM authenticated;
REVOKE ALL ON public.intel_contributor_pepper FROM service_role;

COMMENT ON TABLE public.intel_contributor_pepper IS
  'Per-epoch HMAC pepper for the rotating contributor token that replaced intel_observations.actor_id''s profiles FK (3002). RLS on, zero policies, zero grants — only the SECURITY DEFINER derivation functions read it. Deleting an epoch''s row makes every contribution written in that epoch permanently unlinkable to an account; do that once the 180-day retention sweep has passed over it.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Token derivation
-- ═══════════════════════════════════════════════════════════════════════════
-- Split in two on purpose:
--   *_for_pepper  PURE and read-only, so the RLS helper and the erasure
--                 function can be STABLE and cannot mint anything.
--   intel_contributor_token  VOLATILE, mints the epoch's pepper on first use,
--                 and is called by the INSERT trigger and nothing else.
CREATE OR REPLACE FUNCTION public.intel_contributor_token_for_pepper(
  p_actor_id uuid, p_epoch integer, p_pepper text
)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_hex text;
BEGIN
  IF p_actor_id IS NULL OR p_pepper IS NULL OR p_epoch IS NULL THEN
    RETURN NULL;
  END IF;
  -- Versioned context prefix, the house idiom (lib/intelGroupKey GROUP_KEY_CONTEXT,
  -- lib/telegraphBroadcast HMAC_CONTEXT). The epoch is INSIDE the digest as well
  -- as selecting the pepper, so two epochs cannot collide even if a pepper were
  -- ever reused.
  v_hex := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        'intel-contributor/v1|' || p_epoch::text || '|' || p_actor_id::text || '|' || p_pepper,
        'UTF8'
      )
    ),
    'hex'
  );
  RETURN (
    substr(v_hex, 1, 8) || '-' || substr(v_hex, 9, 4) || '-' ||
    substr(v_hex, 13, 4) || '-' || substr(v_hex, 17, 4) || '-' || substr(v_hex, 21, 12)
  )::uuid;
END;
$$;

REVOKE ALL ON FUNCTION public.intel_contributor_token_for_pepper(uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intel_contributor_token_for_pepper(uuid, integer, text) FROM anon;
REVOKE ALL ON FUNCTION public.intel_contributor_token_for_pepper(uuid, integer, text) FROM authenticated;

-- 604800 seconds = 7 days, anchored to the Unix epoch. A week is short enough
-- that a token is not a durable tracking identity (§3 "no stable anonymous
-- identifier that becomes a tracking identity") and long enough that dedup,
-- one-stance and independence counting all hold within any realistic claim TTL.
CREATE OR REPLACE FUNCTION public.intel_contributor_token(
  p_actor_id uuid, p_at timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_epoch  integer;
  v_pepper text;
BEGIN
  IF p_actor_id IS NULL THEN
    RETURN NULL;
  END IF;
  v_epoch := floor(extract(epoch FROM coalesce(p_at, now())) / 604800)::integer;

  SELECT p.pepper INTO v_pepper
    FROM public.intel_contributor_pepper p WHERE p.epoch = v_epoch;

  IF v_pepper IS NULL THEN
    -- 256 bits from two uuids. ON CONFLICT so two concurrent first-writers in a
    -- fresh epoch agree on one pepper instead of one of them failing.
    INSERT INTO public.intel_contributor_pepper (epoch, pepper)
    VALUES (
      v_epoch,
      replace(pg_catalog.gen_random_uuid()::text, '-', '') ||
      replace(pg_catalog.gen_random_uuid()::text, '-', '')
    )
    ON CONFLICT (epoch) DO NOTHING;
    SELECT p.pepper INTO v_pepper
      FROM public.intel_contributor_pepper p WHERE p.epoch = v_epoch;
  END IF;

  IF v_pepper IS NULL THEN
    -- Fail loudly. Returning the account id here, or a null, would be the defect.
    RAISE EXCEPTION 'intel_contributor_token: no pepper for epoch % and none could be minted', v_epoch;
  END IF;

  RETURN public.intel_contributor_token_for_pepper(p_actor_id, v_epoch, v_pepper);
END;
$$;

REVOKE ALL ON FUNCTION public.intel_contributor_token(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intel_contributor_token(uuid, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.intel_contributor_token(uuid, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.intel_contributor_token(uuid, timestamptz) TO service_role;

COMMENT ON FUNCTION public.intel_contributor_token(uuid, timestamptz) IS
  'Derives the rotating, non-reversible contributor token stored in intel_observations/intel_evidence/intel_confirmations.actor_id (3002). Service_role may call it for its own bookkeeping (idempotent-replay lookup); the value it returns is a pseudonym, never an account id.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. The boundary: a BEFORE INSERT trigger, so no writer can store an account id
-- ═══════════════════════════════════════════════════════════════════════════
-- The application keeps sending profiles.id as the INGEST CREDENTIAL — it is how
-- the row is authorized and consented (hasValidIntelConsent runs on it) — and
-- the database converts it before the row exists. §3's diagram, made literal:
-- "eligibility proves an authorized participating device; ingest receives an
-- opaque short-lived credential."
CREATE OR REPLACE FUNCTION public.intel_assign_contributor_token()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.actor_id IS NOT NULL THEN
    NEW.actor_id := public.intel_contributor_token(NEW.actor_id, now());
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.intel_assign_contributor_token() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intel_assign_contributor_token() FROM anon;
REVOKE ALL ON FUNCTION public.intel_assign_contributor_token() FROM authenticated;

-- FOR EACH ROW, BEFORE INSERT only. It is deliberately NOT a statement-level
-- trigger: src/test/appendOnlyCascade.test.ts records why a statement-level
-- UPDATE/DELETE trigger on these tables breaks account deletion, and this event
-- is neither.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intel_observations','intel_evidence','intel_confirmations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_contributor_token', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.intel_assign_contributor_token()',
      t || '_contributor_token', t);
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Drop the account foreign key (§3's named prohibition)
-- ═══════════════════════════════════════════════════════════════════════════
-- The constraint name is not assumed: it is looked up from pg_constraint by
-- (table, column, referenced table), so a database whose FK carries a
-- non-default name is handled and a database that has already had it dropped is
-- a no-op.
DO $$
DECLARE
  t text;
  c text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intel_observations','intel_evidence','intel_confirmations'] LOOP
    FOR c IN
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       WHERE ns.nspname = 'public'
         AND rel.relname = t
         AND con.contype = 'f'
         AND con.confrelid = 'public.profiles'::regclass
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, c);
    END LOOP;
    -- NOT NULL goes too. The anonymous sensing path (§3, §4.3) has no account at
    -- all, and a column that MUST hold a contributor identity is the same shape
    -- of requirement that forced the nearest-place snap on subject_id.
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN actor_id DROP NOT NULL', t);
  END LOOP;
END $$;

COMMENT ON COLUMN public.intel_observations.actor_id IS
  'NOT a profiles.id. Since 3002 this holds a ROTATING, NON-REVERSIBLE CONTRIBUTOR TOKEN written by the intel_observations_contributor_token BEFORE INSERT trigger; the profiles foreign key is gone (Sensing §3, §24). Joining it to profiles returns nothing by design. It is still the contributor identity for dedup, one-stance, independence counting and moderation — just not an account. Erasure goes through erase_intel_for_actor(uuid), which derives the token.';
COMMENT ON COLUMN public.intel_evidence.actor_id IS
  'NOT a profiles.id — a rotating contributor token (3002). See the comment on intel_observations.actor_id.';
COMMENT ON COLUMN public.intel_confirmations.actor_id IS
  'NOT a profiles.id — a rotating contributor token (3002). See the comment on intel_observations.actor_id.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Convert the rows that already exist
-- ═══════════════════════════════════════════════════════════════════════════
-- Leaving them would mean the store still resolves the OLD contributions to
-- accounts, which is the whole finding. The append-only row trigger refuses
-- UPDATE with no escape hatch (2130: "there is no escape hatch for UPDATE"), and
-- that refusal is correct for a CORRECTION — this is not one, it is a
-- privacy-directed relabelling of an identifier, so the guard is lifted for
-- exactly the three statements and restored immediately, inside this
-- transaction. The postcondition below asserts it came back enabled.
DO $$
DECLARE
  t       text;
  guard   text;
  present boolean;
  n       bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['intel_observations','intel_evidence','intel_confirmations'] LOOP
    guard := t || '_no_update_delete';
    -- The guard's presence is checked, not assumed: 2137 and 2292 have both
    -- removed triggers from this family before, and DISABLE on a trigger that is
    -- not there aborts the migration for no reason.
    SELECT EXISTS (
      SELECT 1 FROM pg_trigger tg
        JOIN pg_class rel ON rel.oid = tg.tgrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       WHERE ns.nspname = 'public' AND rel.relname = t
         AND tg.tgname = guard AND NOT tg.tgisinternal
    ) INTO present;

    IF present THEN EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I', t, guard); END IF;
    EXECUTE format(
      'UPDATE public.%I SET actor_id = public.intel_contributor_token(actor_id, now()) WHERE actor_id IS NOT NULL', t);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF present THEN EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER %I', t, guard); END IF;

    RAISE NOTICE '3002: relabelled % contributor id(s) on public.%', n, t;
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. §18.3 — the subject boundary
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.intel_observations ALTER COLUMN subject_id DROP NOT NULL;

-- Widen the subject-kind vocabulary by the two §18.3 outcomes that had nowhere
-- to go. Drop-and-recreate because a CHECK cannot be altered in place; the new
-- list is the old list plus two, so no existing row can fail it.
ALTER TABLE public.intel_observations
  DROP CONSTRAINT IF EXISTS intel_observations_subject_kind_check;
ALTER TABLE public.intel_observations
  ADD CONSTRAINT intel_observations_subject_kind_check
  CHECK (subject_kind IN (
    'experience','zone','neighborhood','route','event','service',
    -- §18.3 / §7: a persistent cluster with no owner. Keyed on the zone, never
    -- on a faked permanent places row ("do not fake permanent Place rows for
    -- transient clusters").
    'temporary_world_object',
    -- §18.3 / §5.1: the default. Preserved rather than guessed ("Preserve null /
    -- unknown when canonical fact is unavailable", §1).
    'unknown'
  ));

-- THE RULE, AS A CONSTRAINT. This is what makes "never assign to the nearest
-- place merely to satisfy a foreign key" unenforceable-by-accident: an unowned
-- cluster may not carry a place id, and it must carry the zone it was seen in,
-- so there is no shape in which a resolver could quietly supply a place.
ALTER TABLE public.intel_observations
  DROP CONSTRAINT IF EXISTS intel_observations_subject_resolution_check;
ALTER TABLE public.intel_observations
  ADD CONSTRAINT intel_observations_subject_resolution_check
  CHECK (
    (subject_id IS NOT NULL AND subject_kind NOT IN ('temporary_world_object','unknown'))
    OR
    (subject_id IS NULL AND zone_id IS NOT NULL AND subject_kind IN ('temporary_world_object','unknown'))
  );

-- The read path for unowned clusters: they are found by zone, never by place.
CREATE INDEX IF NOT EXISTS intel_observations_unowned_zone_claim_observed
  ON public.intel_observations (zone_id, claim_type, observed_at DESC)
  WHERE subject_id IS NULL;

COMMENT ON COLUMN public.intel_observations.subject_id IS
  'The canonical place this observation is ABOUT, or NULL when §18.3 reconciliation produced `unknown` or `temporary_world_object`. Nullable since 3002: the NOT NULL was the stated motive for the nearest-place snap that §14 and §18.3 both forbid. The places foreign key is KEPT — a non-null subject is still a real place — and intel_observations_subject_resolution_check refuses an unowned cluster that carries one.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. RLS: a contributor still reads their own contributions
-- ═══════════════════════════════════════════════════════════════════════════
-- 2130's policies were `actor_id = auth.uid()`, which matches nothing now. The
-- data-subject read is preserved by deriving THE CALLER'S OWN tokens instead.
-- The function takes no argument and reads auth.uid() itself, so it can only
-- ever answer about the caller — it is not an oracle about anyone else.
CREATE OR REPLACE FUNCTION public.intel_self_contributor_tokens()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid    uuid;
  v_tokens uuid[];
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN ARRAY[]::uuid[];
  END IF;
  SELECT array_agg(public.intel_contributor_token_for_pepper(v_uid, p.epoch, p.pepper))
    INTO v_tokens
    FROM public.intel_contributor_pepper p;
  RETURN coalesce(v_tokens, ARRAY[]::uuid[]);
END;
$$;

REVOKE ALL ON FUNCTION public.intel_self_contributor_tokens() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intel_self_contributor_tokens() FROM anon;
-- authenticated KEEPS execute deliberately: a policy expression is evaluated as
-- the querying role and the EXECUTE privilege is checked there, so revoking it
-- turns the SELECT below into a hard error rather than an empty result. See the
-- measured note in src/scripts/checkSecurityDefinerOracles.ts.
GRANT EXECUTE ON FUNCTION public.intel_self_contributor_tokens() TO authenticated;
GRANT EXECUTE ON FUNCTION public.intel_self_contributor_tokens() TO service_role;

DROP POLICY IF EXISTS intel_observations_select_own ON public.intel_observations;
CREATE POLICY intel_observations_select_own ON public.intel_observations
  FOR SELECT TO authenticated
  USING (actor_id = ANY (public.intel_self_contributor_tokens()));

DROP POLICY IF EXISTS intel_confirmations_select_own ON public.intel_confirmations;
CREATE POLICY intel_confirmations_select_own ON public.intel_confirmations
  FOR SELECT TO authenticated
  USING (actor_id = ANY (public.intel_self_contributor_tokens()));

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. Erasure — rebuilt as a superset of 2278, now token-aware
-- ═══════════════════════════════════════════════════════════════════════════
-- Still the ONE erasure entry point, still service_role only, still declaring
-- the erasure so the append-only triggers permit the DELETE, and still refusing
-- a null actor. Every DELETE carries BOTH arms:
--
--   actor_id = p_actor_id        pre-3002 rows, and the tables outside this
--                                migration's scope that legitimately keep the
--                                account link (attributions, scoped trust)
--   actor_id = ANY(v_tokens)     post-3002 contribution rows
--
-- v_tokens is derived over every epoch the pepper table still holds. An epoch
-- whose pepper has been deleted is unerasable BY CONSTRUCTION — that is the same
-- fact as "those rows are permanently unlinkable", said from the other side, and
-- it is why spent peppers must not be deleted before retention has swept the
-- rows they key.
CREATE OR REPLACE FUNCTION public.erase_intel_for_actor(p_actor_id uuid)
RETURNS TABLE (table_name text, deleted_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  n bigint;
  v_tokens uuid[];
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'erase_intel_for_actor: actor id is required';
  END IF;

  -- Scoped to this transaction only.
  PERFORM set_config('portava.erasure_in_progress', 'on', true);

  SELECT coalesce(array_agg(public.intel_contributor_token_for_pepper(p_actor_id, p.epoch, p.pepper)), ARRAY[]::uuid[])
    INTO v_tokens
    FROM public.intel_contributor_pepper p;

  -- I4a derived state first: it references intel_attributions (cursor FK) and
  -- intel_attributions references intel_observations. Both still carry a real
  -- account link (2277/2278) — out of 3002's scope, recorded in its header.
  DELETE FROM public.intel_scoped_trust WHERE actor_id = p_actor_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_scoped_trust'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_attributions WHERE actor_id = p_actor_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_attributions'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_evidence WHERE actor_id = p_actor_id OR actor_id = ANY (v_tokens);
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_evidence'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_confirmations WHERE actor_id = p_actor_id OR actor_id = ANY (v_tokens);
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_confirmations'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_observations WHERE actor_id = p_actor_id OR actor_id = ANY (v_tokens);
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_observations'; deleted_count := n; RETURN NEXT;

  -- Claims and snapshots are DERIVED and carry no actor column: they are
  -- aggregate beliefs about a place, not personal data, and are recomputed from
  -- the surviving observations. Deleting them here would destroy other people's
  -- contributions. Recomputation after erasure is IG-04's responsibility.
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.erase_intel_for_actor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erase_intel_for_actor(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.erase_intel_for_actor(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.erase_intel_for_actor(uuid) TO service_role;

COMMENT ON FUNCTION public.erase_intel_for_actor(uuid) IS
  'Single auditable erasure path for a user''s intelligence contributions (2130, widened by 2278, made token-aware by 3002). Declares portava.erasure_in_progress for the transaction, derives the actor''s contributor token for every live epoch, and removes their scoped trust, attributions, evidence, confirmations and observations by account id OR token. Derived claims/snapshots are NOT deleted — they are aggregate and are recomputed.';

-- ── Postcondition ───────────────────────────────────────────────────────────
DO $post$
DECLARE
  fks         int;
  not_nulls   int;
  trig        int;
  disabled    int;
  leftover    int;
  subj_nn     boolean;
BEGIN
  -- (a) The named prohibition: no contribution table references profiles.
  SELECT count(*) INTO fks
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
   WHERE ns.nspname = 'public'
     AND rel.relname IN ('intel_observations','intel_evidence','intel_confirmations')
     AND con.contype = 'f'
     AND con.confrelid = 'public.profiles'::regclass;
  IF fks <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % foreign key(s) from the intel contribution tables to profiles survive — §3''s named prohibition is not met.', fks;
  END IF;

  SELECT count(*) INTO not_nulls
    FROM pg_attribute a
    JOIN pg_class rel ON rel.oid = a.attrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
   WHERE ns.nspname = 'public'
     AND rel.relname IN ('intel_observations','intel_evidence','intel_confirmations')
     AND a.attname = 'actor_id' AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull;
  IF not_nulls <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: actor_id is still NOT NULL on % contribution table(s).', not_nulls;
  END IF;

  -- (b) The boundary exists and is a BEFORE INSERT row trigger on all three.
  SELECT count(*) INTO trig
    FROM pg_trigger tg
    JOIN pg_class rel ON rel.oid = tg.tgrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
   WHERE ns.nspname = 'public'
     AND rel.relname IN ('intel_observations','intel_evidence','intel_confirmations')
     AND NOT tg.tgisinternal
     AND tg.tgname LIKE '%\_contributor\_token';
  IF trig <> 3 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 3 contributor-token triggers, found % — a writer could store an account id.', trig;
  END IF;

  -- (c) The append-only guard was restored after the relabelling.
  SELECT count(*) INTO disabled
    FROM pg_trigger tg
    JOIN pg_class rel ON rel.oid = tg.tgrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
   WHERE ns.nspname = 'public'
     AND rel.relname IN ('intel_observations','intel_evidence','intel_confirmations')
     AND tg.tgname LIKE '%\_no\_update\_delete'
     AND tg.tgenabled = 'D';
  IF disabled <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % append-only trigger(s) left DISABLED by the relabelling step.', disabled;
  END IF;

  -- (d) No stored contributor id is still an account id.
  SELECT count(*) INTO leftover
    FROM public.intel_observations o
   WHERE o.actor_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = o.actor_id);
  IF leftover <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % observation(s) still carry a value that resolves to a profiles row.', leftover;
  END IF;

  -- (e) §18.3: the two outcomes that had nowhere to go now have one.
  SELECT a.attnotnull INTO subj_nn
    FROM pg_attribute a
    JOIN pg_class rel ON rel.oid = a.attrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
   WHERE ns.nspname = 'public' AND rel.relname = 'intel_observations'
     AND a.attname = 'subject_id' AND a.attnum > 0 AND NOT a.attisdropped;
  IF subj_nn IS NOT FALSE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_observations.subject_id is still NOT NULL — `unknown` and `temporary_world_object` still cannot be stored.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.intel_observations'::regclass
       AND conname = 'intel_observations_subject_resolution_check'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: intel_observations_subject_resolution_check is missing — nothing stops an unowned cluster being filed against a place.';
  END IF;

  -- (f) The places foreign key is KEPT. Dropping it was never the goal and
  --     would let a subject id name nothing at all.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
     WHERE con.conrelid = 'public.intel_observations'::regclass
       AND con.contype = 'f'
       AND con.confrelid = 'public.places'::regclass
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the subject_id -> places foreign key was dropped. Only the NOT NULL was meant to go.';
  END IF;
END $post$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERSAL
-- ═══════════════════════════════════════════════════════════════════════════
-- db/rollback/2026-09-25-3002-intel-contribution-identity-rollback.sql.
-- It is PARTIAL BY CONSTRUCTION and says so: the account ids this migration
-- relabelled are not recoverable, because not recovering them is the feature.
