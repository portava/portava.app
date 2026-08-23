-- 2130_intel_storage.sql
-- Intelligence Gathering IG-02 — the claim storage layer.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Prefix 2130 follows
-- 2128/2129 and leaves 2124-2127 for the unpushed Journey files.
--
-- ── WHAT THIS CREATES, AND WHAT IT DELIBERATELY DOES NOT ────────────────────
-- Creates five tables:
--   intel_observations   append-only raw human reports about the world
--   intel_claims         the current belief derived from observations
--   intel_evidence       artifacts supporting an observation
--   intel_confirmations  independent agreement/disagreement with a claim
--   intel_state_snapshots TTL-bounded projected live state per (subject, claim)
--
-- It does NOT create four tables the specification lists, because each would
-- duplicate a system that already exists — the spec's own "no duplicate truth
-- store" rule applied to its own table list:
--   * intel_outcomes      — canonical_events already carries arrival, completion,
--                           rejection and satisfaction, and 2123 already files
--                           them as family='outcome'. Record outcomes there.
--   * intel_expertise_scopes — would be the sixth verification ladder. Scope the
--                           existing Trust services instead.
--   * intel_coverage_cells — would be the third coverage model.
--   * intel_missions      — a contribution-dispatch loop already exists in three
--                           pieces.
--
-- RUNTIME EFFECT: NONE. No route reads or writes any of these. Every capture and
-- projection flag is off, and IG-03 supplies the write path.
--
-- ── SUBJECT IDENTITY (owner ruling D2) ──────────────────────────────────────
-- subject_id FKs public.places(id). places EXISTS on production but currently
-- holds ZERO rows (verified 2026-08-22), while discovery_places holds 184. That
-- is deliberate and load-bearing: a subject with no canonical place row cannot be
-- observed. Populating places is therefore a PREREQUISITE OF IG-03 (capture),
-- not of this migration — storage can be correct before the pool is filled, and
-- declaring the FK now is what stops observations being keyed to an untyped
-- string the way canonical_events.subject_id is.
--
-- ── APPEND-ONLY, AND ITS COST ───────────────────────────────────────────────
-- intel_observations uses the three-mechanism guarantee from 2120: a BEFORE
-- UPDATE OR DELETE row trigger, a statement-level trigger, and a BEFORE TRUNCATE
-- trigger. Corrections are new rows; nothing is rewritten.
--
-- That fights erasure, so unlike canonical_events these tables DO carry an
-- ON DELETE CASCADE to profiles(id), and they are registered in
-- src/lib/deletionDispositions.ts as ERASED_BY_CASCADE with matching code in
-- AccountDeletionService. canonical_events deliberately took no FK; repeating
-- that here would add five more tables to the 229 that already survive account
-- deletion. Append-only governs CORRECTION, not RETENTION.

BEGIN;

-- ── Preconditions ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.places') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.places does not exist. IG-02 keys subjects to the canonical place table (owner ruling D2).';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.profiles does not exist.';
  END IF;
  IF to_regclass('public.freshness_policies') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.freshness_policies does not exist. Apply 2122 and 2128 first — claim TTLs come from there.';
  END IF;
END $$;

-- ── Shared append-only trigger function ─────────────────────────────────────
-- Append-only over UPDATE, ALWAYS. A stored observation is what someone said;
-- rewriting it is never legitimate, so there is no escape hatch for UPDATE.
--
-- DELETE is different, and the difference is deliberate. Append-only governs
-- CORRECTION, not RETENTION — and a table that cannot be deleted from cannot
-- honour a right to erasure. Blocking DELETE outright would add five more tables
-- to the 229 that already survive account deletion (see
-- src/lib/deletionDispositions.ts). So DELETE is refused for ordinary callers and
-- permitted only inside a transaction that has explicitly declared an erasure:
--
--   SET LOCAL portava.erasure_in_progress = 'on';
--
-- SET LOCAL scopes it to that transaction, so the permission cannot leak into
-- later work on the same connection. The declaration is the audit trail: an
-- ordinary bug cannot delete an observation, and a deletion worker says out loud
-- that it is erasing.
CREATE OR REPLACE FUNCTION public.intel_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('portava.erasure_in_progress', true), 'off') = 'on' THEN
    RETURN OLD; -- declared erasure: permitted
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      '% is append-only: DELETE requires an explicit erasure declaration (SET LOCAL portava.erasure_in_progress = ''on'').', TG_TABLE_NAME;
  END IF;

  RAISE EXCEPTION
    '% is append-only: % is not permitted. Corrections are new rows.', TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE OR REPLACE FUNCTION public.intel_append_only_stmt()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('portava.erasure_in_progress', true), 'off') = 'on' THEN
    RETURN NULL; -- declared erasure: permitted
  END IF;
  RAISE EXCEPTION
    '% is append-only: % is not permitted at statement level.', TG_TABLE_NAME, TG_OP;
END;
$$;

-- Lock both down. Postgres grants EXECUTE to PUBLIC by default on every new
-- function, so without these REVOKEs anon and authenticated could reach
-- /rest/v1/rpc/intel_append_only. A direct call only raises (TG_OP is null
-- outside a trigger), but it puts two more functions into precisely the
-- anon-executable class this codebase has been clearing out, and a trigger
-- function has no business being callable over REST at all. Trigger execution
-- does NOT depend on the invoking role holding EXECUTE, so this costs nothing.
REVOKE ALL ON FUNCTION public.intel_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intel_append_only() FROM anon;
REVOKE ALL ON FUNCTION public.intel_append_only() FROM authenticated;
REVOKE ALL ON FUNCTION public.intel_append_only_stmt() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.intel_append_only_stmt() FROM anon;
REVOKE ALL ON FUNCTION public.intel_append_only_stmt() FROM authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. intel_observations — raw reports, append-only
-- ═══════════════════════════════════════════════════════════════════════════
-- Distinct from journey_observations, which is PASSIVE DEVICE TELEMETRY (GPS
-- fixes on a location session). This is an ACTIVE HUMAN REPORT about the world,
-- carrying visibility, moderation state and commercial disclosure — fields
-- device telemetry has no use for. They share the temporal, consent and
-- idempotency conventions on purpose; they are not the same table.
CREATE TABLE IF NOT EXISTS public.intel_observations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  subject_kind       text NOT NULL,
  subject_id         uuid NOT NULL REFERENCES public.places(id) ON DELETE CASCADE,
  zone_id            text,
  claim_type         text NOT NULL,
  value              jsonb NOT NULL,
  source_class       text NOT NULL,
  capture_surface    text NOT NULL,
  visibility         text NOT NULL DEFAULT 'private',
  moderation_state   text NOT NULL DEFAULT 'pending',
  commercial_disclosure text NOT NULL DEFAULT 'none',
  presence_level     text NOT NULL DEFAULT 'P0',
  -- A derived attestation, never a pointer to a coordinate row. Storing an FK to
  -- location_snapshots would make raw GPS harder to purge — retention pressure
  -- running backwards — so the facts the confidence formula needs are copied here.
  presence_attestation jsonb,
  observed_at        timestamptz NOT NULL,
  captured_at        timestamptz,
  received_at        timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz,
  idempotency_key    text NOT NULL,
  schema_version     smallint NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT intel_observations_subject_kind_check
    CHECK (subject_kind IN ('experience','zone','neighborhood','route','event','service')),
  CONSTRAINT intel_observations_source_class_check
    CHECK (source_class IN ('verified_firsthand','firsthand_unverified','official_signed','sponsored','imported_owned','historical_pattern','portava_prediction','hearsay')),
  CONSTRAINT intel_observations_capture_surface_check
    CHECK (capture_surface IN ('quick_signal','moment','highlight','postcard','trail','question','mission','followup')),
  CONSTRAINT intel_observations_visibility_check
    CHECK (visibility IN ('public','followers','crew','invite_only','delayed','aggregate_only','private')),
  CONSTRAINT intel_observations_moderation_check
    CHECK (moderation_state IN ('pending','allowed','restricted','blocked','removed')),
  CONSTRAINT intel_observations_disclosure_check
    CHECK (commercial_disclosure IN ('none','employee','owner','hosted','complimentary','affiliate','paid')),
  CONSTRAINT intel_observations_presence_check
    CHECK (presence_level IN ('P0','P1','P2','P3','P4')),
  CONSTRAINT intel_observations_schema_version_check CHECK (schema_version = 1),
  CONSTRAINT intel_observations_idempotency_key_check
    CHECK (length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  -- observed_at is server-clamped by lib/intelContracts.clampObservedAt before
  -- insert; this is the database-side backstop against a future timestamp
  -- reading as permanently fresh.
  CONSTRAINT intel_observations_observed_at_not_future
    CHECK (observed_at <= received_at + interval '60 seconds'),
  CONSTRAINT intel_observations_captured_before_received
    CHECK (captured_at IS NULL OR captured_at <= received_at + interval '60 seconds')
);

CREATE UNIQUE INDEX IF NOT EXISTS intel_observations_idempotency
  ON public.intel_observations (actor_id, idempotency_key);
CREATE INDEX IF NOT EXISTS intel_observations_subject_claim_observed
  ON public.intel_observations (subject_id, claim_type, observed_at DESC);
CREATE INDEX IF NOT EXISTS intel_observations_actor
  ON public.intel_observations (actor_id);
CREATE INDEX IF NOT EXISTS intel_observations_expires_at
  ON public.intel_observations (expires_at) WHERE expires_at IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. intel_claims — the current belief, superseded rather than updated
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.intel_claims (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind     text NOT NULL,
  subject_id       uuid NOT NULL REFERENCES public.places(id) ON DELETE CASCADE,
  zone_id          text,
  claim_type       text NOT NULL,
  value            jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'candidate',
  confidence       numeric,
  confidence_band  text,
  source_count     integer NOT NULL DEFAULT 0,
  observed_at      timestamptz NOT NULL,
  expires_at       timestamptz,
  hard_expires_at  timestamptz,
  superseded_by    uuid REFERENCES public.intel_claims(id) ON DELETE SET NULL,
  schema_version   smallint NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT intel_claims_status_check
    CHECK (status IN ('candidate','active','conflicting','superseded','expired','retracted','rejected')),
  CONSTRAINT intel_claims_band_check
    CHECK (confidence_band IS NULL OR confidence_band IN ('unverified','provisional','likely_current','live','strong')),
  CONSTRAINT intel_claims_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT intel_claims_source_count_nonneg CHECK (source_count >= 0),
  CONSTRAINT intel_claims_hard_expiry_after_expiry
    CHECK (hard_expires_at IS NULL OR expires_at IS NULL OR hard_expires_at >= expires_at)
);

CREATE INDEX IF NOT EXISTS intel_claims_subject_type_status
  ON public.intel_claims (subject_id, claim_type, status);
CREATE INDEX IF NOT EXISTS intel_claims_expires_at
  ON public.intel_claims (expires_at) WHERE expires_at IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. intel_evidence — artifacts supporting an observation, append-only
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.intel_evidence (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id uuid NOT NULL REFERENCES public.intel_observations(id) ON DELETE CASCADE,
  actor_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  evidence_kind  text NOT NULL,
  -- A storage key or external reference. Never raw coordinates: EXIF is stripped
  -- upstream and this table must not become a second location store.
  reference      text,
  detail         jsonb,
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT intel_evidence_kind_check
    CHECK (evidence_kind IN ('photo','receipt','official_feed','partner_api','sensor','text_note'))
);

CREATE INDEX IF NOT EXISTS intel_evidence_observation ON public.intel_evidence (observation_id);
CREATE INDEX IF NOT EXISTS intel_evidence_actor ON public.intel_evidence (actor_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. intel_confirmations — independent agreement, append-only
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.intel_confirmations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id   uuid NOT NULL REFERENCES public.intel_claims(id) ON DELETE CASCADE,
  actor_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  stance     text NOT NULL,
  presence_level text NOT NULL DEFAULT 'P0',
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT intel_confirmations_stance_check CHECK (stance IN ('agree','disagree','unsure')),
  CONSTRAINT intel_confirmations_presence_check CHECK (presence_level IN ('P0','P1','P2','P3','P4'))
);

-- One stance per actor per claim: a second is a correction, not a second vote,
-- and without this an actor could inflate consensus by repeating themselves.
CREATE UNIQUE INDEX IF NOT EXISTS intel_confirmations_one_per_actor
  ON public.intel_confirmations (claim_id, actor_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. intel_state_snapshots — TTL-bounded projected live state
-- ═══════════════════════════════════════════════════════════════════════════
-- Scoped to LIVE, TTL-bounded claims only. It is not a general per-field truth
-- store: places.field_freshness already occupies that space (write-once today,
-- and to be either wired or deprecated — see the A0 packet), and circle_presence
-- already projects traveler presence with its own sweeper.
CREATE TABLE IF NOT EXISTS public.intel_state_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id      uuid NOT NULL REFERENCES public.places(id) ON DELETE CASCADE,
  zone_id         text,
  claim_type      text NOT NULL,
  value           jsonb NOT NULL,
  confidence      numeric,
  confidence_band text,
  source_count    integer NOT NULL DEFAULT 0,
  -- Fail-closed: an output is not publishable until a privacy gate says so.
  privacy_eligible boolean NOT NULL DEFAULT false,
  distinct_actors integer,
  observed_at     timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  computed_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT intel_state_band_check
    CHECK (confidence_band IS NULL OR confidence_band IN ('unverified','provisional','likely_current','live','strong')),
  CONSTRAINT intel_state_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS intel_state_snapshots_subject_claim
  ON public.intel_state_snapshots (subject_id, coalesce(zone_id,''), claim_type);
CREATE INDEX IF NOT EXISTS intel_state_snapshots_expires_at
  ON public.intel_state_snapshots (expires_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- APPEND-ONLY ENFORCEMENT
-- ═══════════════════════════════════════════════════════════════════════════
-- observations, evidence and confirmations are immutable records of what someone
-- said. claims and state_snapshots are DERIVED and must be updatable — a claim is
-- superseded and a snapshot is recomputed; freezing them would make the
-- projection layer impossible.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intel_observations','intel_evidence','intel_confirmations'] LOOP
    -- Build each trigger name BEFORE quoting. `format('%I_suffix', t)` would
    -- quote only the table part, so a name that ever needed quoting would yield
    -- "Foo"_no_update_delete — invalid SQL. Quoting the whole identifier once is
    -- correct for any name, not just the lowercase ones in this array.
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_no_update_delete', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.intel_append_only()', t || '_no_update_delete', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_no_update_delete_stmt', t);
    -- Statement-level guard covers the 'DELETE FROM t' with no matching rows
    -- case, which fires no row trigger. It consults the same declaration.
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.intel_append_only_stmt()', t || '_no_update_delete_stmt', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_no_truncate', t);
    -- TRUNCATE is refused unconditionally, erasure declaration or not: the
    -- erasure path deletes by actor and never truncates, so a TRUNCATE here is
    -- always a mistake.
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.intel_append_only()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS AND GRANTS
-- ═══════════════════════════════════════════════════════════════════════════
-- Deny-default. Grants use the 2093 shape: REVOKE ALL first, because on Supabase
-- ALTER DEFAULT PRIVILEGES grants ALL to service_role at CREATE TABLE time and a
-- bare GRANT establishes no limit.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['intel_observations','intel_claims','intel_evidence','intel_confirmations','intel_state_snapshots'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM service_role', t);
  END LOOP;
END $$;

-- service_role: write where the pipeline writes, read everywhere. No UPDATE on
-- the append-only three even for service_role — the triggers would refuse anyway,
-- and the grant should say the same thing.
GRANT INSERT, SELECT ON public.intel_observations   TO service_role;
GRANT INSERT, SELECT ON public.intel_evidence       TO service_role;
GRANT INSERT, SELECT ON public.intel_confirmations  TO service_role;
GRANT INSERT, SELECT, UPDATE ON public.intel_claims TO service_role;
GRANT INSERT, SELECT, UPDATE, DELETE ON public.intel_state_snapshots TO service_role;

-- authenticated: own rows only, and nothing at all on derived state. Published
-- live state reaches clients through a projection the server controls, never by
-- reading the snapshot table directly.
GRANT SELECT ON public.intel_observations  TO authenticated;
GRANT SELECT ON public.intel_confirmations TO authenticated;

CREATE POLICY intel_observations_select_own ON public.intel_observations
  FOR SELECT TO authenticated USING (actor_id = auth.uid());
CREATE POLICY intel_confirmations_select_own ON public.intel_confirmations
  FOR SELECT TO authenticated USING (actor_id = auth.uid());

COMMENT ON TABLE public.intel_observations IS
  'IG-02: append-only human reports about the world. Distinct from journey_observations (passive device telemetry). ON DELETE CASCADE to profiles — append-only governs correction, not retention.';
COMMENT ON TABLE public.intel_claims IS
  'IG-02: current belief derived from observations. Updatable by design: claims are superseded, not frozen.';
COMMENT ON TABLE public.intel_state_snapshots IS
  'IG-02: TTL-bounded projected live state. privacy_eligible defaults false — an output is not publishable until a privacy gate says so.';

-- ═══════════════════════════════════════════════════════════════════════════
-- ERASURE ENTRY POINT
-- ═══════════════════════════════════════════════════════════════════════════
-- The deletion worker reaches the database through PostgREST, which cannot issue
-- SET LOCAL. Without this, the append-only triggers would make the intel tables
-- undeletable in practice — the exact outcome the trigger's erasure clause exists
-- to avoid. One SECURITY DEFINER function is therefore the single erasure path:
-- it declares the erasure, deletes the actor's rows, and returns the counts so
-- the caller can log what was removed.
--
-- It is deliberately narrow: one actor, five tables, no filters the caller can
-- widen. There is no "erase everything" variant.
CREATE OR REPLACE FUNCTION public.erase_intel_for_actor(p_actor_id uuid)
RETURNS TABLE (table_name text, deleted_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  n bigint;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'erase_intel_for_actor: actor id is required';
  END IF;

  -- Scoped to this transaction only.
  PERFORM set_config('portava.erasure_in_progress', 'on', true);

  DELETE FROM public.intel_evidence WHERE actor_id = p_actor_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_evidence'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_confirmations WHERE actor_id = p_actor_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'intel_confirmations'; deleted_count := n; RETURN NEXT;

  DELETE FROM public.intel_observations WHERE actor_id = p_actor_id;
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
  'Single auditable erasure path for a user''s intelligence contributions. Declares portava.erasure_in_progress for the transaction so the append-only triggers permit DELETE, then removes that actor''s evidence, confirmations and observations. Derived claims/snapshots are NOT deleted — they are aggregate and are recomputed.';

-- ── Postcondition ───────────────────────────────────────────────────────────
DO $$
DECLARE
  created int;
  rls_off int;
BEGIN
  SELECT count(*) INTO created FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='r'
     AND c.relname IN ('intel_observations','intel_claims','intel_evidence','intel_confirmations','intel_state_snapshots');
  IF created <> 5 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: expected 5 intel tables, found %', created;
  END IF;

  SELECT count(*) INTO rls_off FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public'
     AND c.relname IN ('intel_observations','intel_claims','intel_evidence','intel_confirmations','intel_state_snapshots')
     AND NOT c.relrowsecurity;
  IF rls_off > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % intel table(s) have RLS disabled', rls_off;
  END IF;

  IF to_regprocedure('public.erase_intel_for_actor(uuid)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: erase_intel_for_actor is missing — the intel tables would be undeletable in practice.';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- REVERSAL
-- ═══════════════════════════════════════════════════════════════════════════
--   DROP TABLE IF EXISTS public.intel_state_snapshots, public.intel_confirmations,
--     public.intel_evidence, public.intel_claims, public.intel_observations CASCADE;
--   DROP FUNCTION IF EXISTS public.intel_append_only();
-- Safe while no producer exists (IG-03 is unbuilt and every capture flag is off).
-- Once observations are being written, dropping these destroys user contributions
-- that append-only exists to preserve — reverse before IG-03, not after.
