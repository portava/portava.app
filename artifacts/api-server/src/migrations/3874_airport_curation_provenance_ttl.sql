-- 3874_airport_curation_provenance_ttl.sql
-- Airport Intelligence: curated airport facts WITH provenance, TTL and a
-- validation state, and the curation workflow's server-side guarantees
-- (census-layover L14, L79, L80, L223; spec §3 "Airport Intelligence: airport
-- operational facts + provenance + TTL", §10 fact classes and freshness, §19
-- step 6). Layover 165 program, lane B2-CURATE.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band, gap number 3874).
-- WRITTEN, NOT APPLIED. Additive: one table, three columns-groups on
-- airport_profiles, three functions, two triggers. No flag.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE DEFECT (census L14, 0127:17-41)
-- ══════════════════════════════════════════════════════════════════════════════
-- Every airport_profiles fact the engine reads is a BARE VALUE: the buffers,
-- `terminal_info` and the `verified` boolean carry no source, no observed time,
-- no curator and no expiry. `verified` could be set TRUE by any admin PATCH and
-- then raised the engine's confidence and the §22 maturity rung of an airport
-- nobody had checked; `terminal_info` had no writer at all.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT THIS CREATES
-- ══════════════════════════════════════════════════════════════════════════════
-- 1. public.airport_curated_facts — one row per VERSION of one curated fact
--    about one airport. Columns: fact_kind (eight kinds, below) and its §10
--    fact_class; value (jsonb, validated by the service before it may be
--    validated); PROVENANCE (source_kind, source_url — https, REQUIRED for an
--    official source —, source_title, source_note, retrieved_at); TTL
--    (expires_at, bounded per class: STATIC_TOPOLOGY at most 180 days after
--    retrieval — "weeks/months" —, OPERATIONAL_SEMI_LIVE at most 7 days —
--    "hours/days"); the VALIDATION STATE proposed → validated → published →
--    superseded, or → rejected, each transition stamped (who, when) and a
--    validation_report (the quality checks the service ran).
--      kinds  STATIC_TOPOLOGY:       terminal_topology, ground_transport,
--                                    timing_assumptions, entry_restrictions
--             OPERATIONAL_SEMI_LIVE: security_layout, lounge_hours,
--                                    transport_schedules, overnight_lodging
--    EDIT HISTORY IS KEPT: content and provenance are IMMUTABLE once inserted
--    (an edit is a new version), transitions are only the legal ones, stamps
--    are write-once (trigger airport_curated_facts_guard), and the API's
--    service_role holds no DELETE or TRUNCATE on the table. A row leaves only
--    with its airport (ON DELETE CASCADE from airport_profiles).
--    `published` is reachable ONLY through airport_curation_publish(), so the
--    projection below can never disagree with the published row.
-- 2. airport_profiles projection columns, written ONLY by the two curation
--    functions:
--      curated_timing_fact_id / _expires_at      (timing_assumptions → buffers)
--      curated_topology_fact_id / _expires_at    (terminal_topology → terminal_info)
--      curated_transport_fact_id / _expires_at   (ground_transport)
--      topology_version, topology_changed_at     bumped on every AUTHORITATIVE
--                                                change of a curated static fact
--      facts_provenance (GENERATED): 'curated' when the buffers are a published
--                       timing fact, else 'unvalidated_no_provenance'
--      legacy_verified  the bare `verified` value a writer supplied, kept for
--                       the record and read by nothing
--    and trigger airport_profiles_curation_guard (BEFORE INSERT OR UPDATE):
--      * a buffer or terminal_info edit that did NOT come from the curation
--        functions (an admin PATCH, the session-creation upsert) drops the
--        matching curated reference: the value is now unvalidated, with no
--        provenance — NEVER silently validated — and topology_version moves;
--      * a direct write of a curated reference to a non-NULL value is refused;
--      * `verified` is DERIVED: TRUE exactly when timing, topology and transport
--        are all curated-and-published (§22 L1). A writer's bare value is kept
--        in legacy_verified and does not reach the engine.
-- 3. public.airport_curation_publish(p_fact_id uuid, p_actor uuid) → jsonb and
--    public.airport_curation_retract(p_fact_id uuid, p_actor uuid, p_reason text)
--    → jsonb. Each locks the airport row (FOR UPDATE: publishes for one airport
--    serialise), checks the fact's state (validated / published) and expiry,
--    supersedes the previously published version of the same kind, and
--    projects (or clears) the airport_profiles columns above, all in one
--    statement's transaction. SECURITY INVOKER, search_path = pg_catalog,
--    EXECUTE for service_role only.
--
-- EXISTING DATA: every existing row becomes "unvalidated, no provenance":
-- facts_provenance reads 'unvalidated_no_provenance' (no curated reference
-- exists), legacy_verified receives the row's current `verified`, and
-- `verified` is then set FALSE on any row that had it TRUE (no row can be
-- curated before this file). Production at writing: 3,206 rows, 0 verified,
-- 0 with terminal_info (census L14/L143) — so no production `verified` value
-- changes, and none is lost: legacy_verified holds it and the rollback restores
-- it. No buffer, terminal_info or other value is modified.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- ORDER INDEPENDENCE (gap number: at 3874 on a fresh replay, after 3999 on
-- portava-ci and production)
-- ══════════════════════════════════════════════════════════════════════════════
-- Depends on: public.airport_profiles (0127) with the columns named in $pre$,
-- public.profiles (baseline), the roles. No file numbered above 3874 (3900-3906,
-- 3930-3933, 3970-3999 at writing) names airport_profiles, airport_curated_facts,
-- either function, either trigger, or alters DEFAULT PRIVILEGES on public
-- tables; 3880 (this lane) adds calibration columns and is written against this
-- file's state. Grep evidence in the lane handback.
--
-- LOCKS: ACCESS EXCLUSIVE on airport_profiles for the ALTERs and the trigger
-- (brief: 3,206 rows, catalog changes plus one UPDATE of the rows with
-- verified = TRUE — none in production).
--
-- ROLLBACK: db/rollback/2026-10-18-3874-airport-curation-provenance-ttl-rollback.sql
-- (refuses while any curated fact exists or any airport_profiles row carries a
-- curated reference; restores `verified` from legacy_verified; drops what this
-- file made; deletes this file's ledger row).

BEGIN;

DO $pre$
DECLARE
  v_missing text;
BEGIN
  IF to_regclass('public.airport_profiles') IS NULL OR to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3874): public.airport_profiles (0127) and public.profiles must exist.';
  END IF;
  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(ARRAY['id','iata_code','terminal_info','domestic_buffer_min','domestic_buffer_max',
                      'international_buffer_min','international_buffer_max','immigration_extra_min',
                      'checked_bags_extra_min','traffic_extra_min','verified','updated_at']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = 'public.airport_profiles'::regclass AND a.attname = c AND NOT a.attisdropped);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3874): public.airport_profiles lacks column(s) %', v_missing;
  END IF;
  -- Nothing of this file's may pre-exist half-made: either none of it (a fresh
  -- apply) or all of it (a re-run, which the IF NOT EXISTS clauses make a no-op).
  IF to_regclass('public.airport_curated_facts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.airport_profiles'::regclass AND attname = 'curated_timing_fact_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3874): public.airport_curated_facts exists but airport_profiles has no curated_timing_fact_id: a half-applied or hand-made state. Nothing was changed.';
  END IF;
END $pre$;

-- ── 1. the curated facts ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.airport_curated_facts (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id             uuid        NOT NULL REFERENCES public.airport_profiles(id) ON DELETE CASCADE,
  fact_kind              text        NOT NULL CHECK (fact_kind IN (
                           'terminal_topology','ground_transport','timing_assumptions','entry_restrictions',
                           'security_layout','lounge_hours','transport_schedules','overnight_lodging')),
  fact_class             text        NOT NULL CHECK (fact_class IN ('STATIC_TOPOLOGY','OPERATIONAL_SEMI_LIVE')),
  version                integer     NOT NULL CHECK (version >= 1),
  value                  jsonb       NOT NULL CHECK (jsonb_typeof(value) = 'object' AND octet_length(value::text) <= 65536),

  -- provenance
  source_kind            text        NOT NULL CHECK (source_kind IN (
                           'official_airport','official_operator','official_government','curator_survey','curator_judgment')),
  source_url             text        CHECK (source_url IS NULL OR (source_url ~ '^https://' AND length(source_url) <= 2048)),
  source_title           text        CHECK (source_title IS NULL OR length(source_title) <= 300),
  source_note            text        CHECK (source_note IS NULL OR length(source_note) <= 2000),
  retrieved_at           timestamptz NOT NULL,

  -- TTL
  expires_at             timestamptz NOT NULL,

  -- validation state and its stamps
  state                  text        NOT NULL DEFAULT 'proposed'
                           CHECK (state IN ('proposed','validated','published','rejected','superseded')),
  proposed_via           text        NOT NULL CHECK (proposed_via IN ('admin','packet_import')),
  proposed_by            uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  proposed_at            timestamptz NOT NULL DEFAULT now(),
  validation_report      jsonb       CHECK (validation_report IS NULL OR jsonb_typeof(validation_report) = 'object'),
  validated_by           uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  validated_at           timestamptz,
  published_by           uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  published_at           timestamptz,
  rejected_by            uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  rejected_at            timestamptz,
  rejection_reason       text        CHECK (rejection_reason IS NULL OR length(rejection_reason) BETWEEN 1 AND 1000),
  superseded_at          timestamptz,
  superseded_by_fact_id  uuid        REFERENCES public.airport_curated_facts(id) ON DELETE SET NULL,
  retracted_by           uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  retraction_reason      text        CHECK (retraction_reason IS NULL OR length(retraction_reason) BETWEEN 1 AND 1000),

  CONSTRAINT airport_curated_facts_kind_class CHECK (
    (fact_kind IN ('terminal_topology','ground_transport','timing_assumptions','entry_restrictions') AND fact_class = 'STATIC_TOPOLOGY')
    OR (fact_kind IN ('security_layout','lounge_hours','transport_schedules','overnight_lodging') AND fact_class = 'OPERATIONAL_SEMI_LIVE')),
  CONSTRAINT airport_curated_facts_official_has_url CHECK (
    source_kind IN ('curator_survey','curator_judgment') OR source_url IS NOT NULL),
  CONSTRAINT airport_curated_facts_ttl_forward CHECK (expires_at > retrieved_at),
  CONSTRAINT airport_curated_facts_ttl_class_bound CHECK (
    (fact_class = 'STATIC_TOPOLOGY' AND expires_at <= retrieved_at + interval '180 days')
    OR (fact_class = 'OPERATIONAL_SEMI_LIVE' AND expires_at <= retrieved_at + interval '7 days')),
  CONSTRAINT airport_curated_facts_validated_stamped CHECK (
    state NOT IN ('validated','published','superseded') OR (validated_at IS NOT NULL AND validation_report IS NOT NULL)),
  CONSTRAINT airport_curated_facts_published_stamped CHECK (
    state NOT IN ('published','superseded') OR published_at IS NOT NULL),
  CONSTRAINT airport_curated_facts_rejected_stamped CHECK (
    state <> 'rejected' OR (rejected_at IS NOT NULL AND rejection_reason IS NOT NULL)),
  CONSTRAINT airport_curated_facts_superseded_stamped CHECK (
    state <> 'superseded' OR superseded_at IS NOT NULL),
  CONSTRAINT airport_curated_facts_version_unique UNIQUE (airport_id, fact_kind, version)
);

-- At most one PUBLISHED version of a kind per airport: the one the projection names.
CREATE UNIQUE INDEX IF NOT EXISTS airport_curated_facts_one_published
  ON public.airport_curated_facts(airport_id, fact_kind) WHERE state = 'published';
-- The admin history read and the newest-version lookup.
CREATE INDEX IF NOT EXISTS airport_curated_facts_history_idx
  ON public.airport_curated_facts(airport_id, fact_kind, version DESC);

ALTER TABLE public.airport_curated_facts ENABLE ROW LEVEL SECURITY;
-- Server-only: no client role reads or writes a curation row; the API's service
-- client reads, proposes and transitions, and can never delete (history).
REVOKE ALL ON TABLE public.airport_curated_facts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.airport_curated_facts FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.airport_curated_facts TO service_role;

COMMENT ON TABLE public.airport_curated_facts IS
  '3874: curated airport facts (census L14/L79/L80/L223). One row per version; content and provenance immutable; proposed -> validated -> published -> superseded, or rejected; published only through airport_curation_publish(). TTL bounded per §10 class. Never deleted by the API.';

CREATE OR REPLACE FUNCTION public.airport_curated_facts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  v_projection boolean := coalesce(current_setting('portava.airport_curation_projection', true), '') = 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'proposed' THEN
      RAISE EXCEPTION 'airport_curated_facts: a fact is inserted as proposed, never as %', NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.validated_at IS NOT NULL OR NEW.published_at IS NOT NULL OR NEW.rejected_at IS NOT NULL
       OR NEW.superseded_at IS NOT NULL OR NEW.validation_report IS NOT NULL THEN
      RAISE EXCEPTION 'airport_curated_facts: a new proposal carries no validation, publication or rejection stamp' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Content and provenance are immutable: an edit is a NEW VERSION.
  IF (NEW.id, NEW.airport_id, NEW.fact_kind, NEW.fact_class, NEW.version, NEW.value, NEW.source_kind, NEW.source_url,
      NEW.source_title, NEW.source_note, NEW.retrieved_at, NEW.expires_at, NEW.proposed_via, NEW.proposed_at)
     IS DISTINCT FROM
     (OLD.id, OLD.airport_id, OLD.fact_kind, OLD.fact_class, OLD.version, OLD.value, OLD.source_kind, OLD.source_url,
      OLD.source_title, OLD.source_note, OLD.retrieved_at, OLD.expires_at, OLD.proposed_via, OLD.proposed_at) THEN
    RAISE EXCEPTION 'airport_curated_facts: a curated fact''s content and provenance are immutable; propose a new version' USING ERRCODE = 'check_violation';
  END IF;
  -- Actor columns may only be CLEARED (an account erased: ON DELETE SET NULL), never re-pointed.
  IF (NEW.proposed_by IS NOT NULL AND NEW.proposed_by IS DISTINCT FROM OLD.proposed_by)
     OR (NEW.validated_by IS NOT NULL AND OLD.validated_by IS NOT NULL AND NEW.validated_by IS DISTINCT FROM OLD.validated_by)
     OR (NEW.published_by IS NOT NULL AND OLD.published_by IS NOT NULL AND NEW.published_by IS DISTINCT FROM OLD.published_by)
     OR (NEW.rejected_by IS NOT NULL AND OLD.rejected_by IS NOT NULL AND NEW.rejected_by IS DISTINCT FROM OLD.rejected_by)
     OR (NEW.retracted_by IS NOT NULL AND OLD.retracted_by IS NOT NULL AND NEW.retracted_by IS DISTINCT FROM OLD.retracted_by) THEN
    RAISE EXCEPTION 'airport_curated_facts: who validated, published, rejected or retracted a fact is written once' USING ERRCODE = 'check_violation';
  END IF;
  -- Stamps and reasons are write-once.
  IF (OLD.validated_at IS NOT NULL AND NEW.validated_at IS DISTINCT FROM OLD.validated_at)
     OR (OLD.validation_report IS NOT NULL AND NEW.validation_report IS DISTINCT FROM OLD.validation_report)
     OR (OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at)
     OR (OLD.rejected_at IS NOT NULL AND NEW.rejected_at IS DISTINCT FROM OLD.rejected_at)
     OR (OLD.rejection_reason IS NOT NULL AND NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason)
     OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at)
     OR (OLD.retraction_reason IS NOT NULL AND NEW.retraction_reason IS DISTINCT FROM OLD.retraction_reason) THEN
    RAISE EXCEPTION 'airport_curated_facts: a validation, publication, rejection or supersession stamp is written once' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT ((OLD.state = 'proposed'  AND NEW.state IN ('validated','rejected'))
         OR (OLD.state = 'validated' AND NEW.state IN ('published','rejected'))
         OR (OLD.state = 'published' AND NEW.state = 'superseded')) THEN
      RAISE EXCEPTION 'airport_curated_facts: illegal transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state = 'validated' THEN
      -- A HUMAN curator validates: the actor is named, the checks passed, and the fact is not stale on arrival.
      IF NEW.validated_by IS NULL OR NEW.validated_at IS NULL OR NEW.validation_report IS NULL
         OR coalesce(NEW.validation_report->>'ok', '') <> 'true' THEN
        RAISE EXCEPTION 'airport_curated_facts: validation needs the curator, the time and a passing quality report' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.expires_at <= now() THEN
        RAISE EXCEPTION 'airport_curated_facts: the fact expired at % — re-retrieve the source and propose a new version', NEW.expires_at USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW.state = 'rejected' AND (NEW.rejected_by IS NULL OR NEW.rejected_at IS NULL OR NEW.rejection_reason IS NULL) THEN
      RAISE EXCEPTION 'airport_curated_facts: a rejection names the curator, the time and the reason' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state IN ('published','superseded') AND NOT v_projection THEN
      RAISE EXCEPTION 'airport_curated_facts: publish and supersede only through airport_curation_publish() / airport_curation_retract()' USING ERRCODE = 'check_violation';
    END IF;
    -- Only the stamps that belong to THIS transition may appear with it.
    IF NEW.state <> 'validated' AND ((OLD.validated_at IS NULL AND NEW.validated_at IS NOT NULL)
         OR (OLD.validated_by IS NULL AND NEW.validated_by IS NOT NULL) OR (OLD.validation_report IS NULL AND NEW.validation_report IS NOT NULL))
       OR NEW.state <> 'published' AND ((OLD.published_at IS NULL AND NEW.published_at IS NOT NULL) OR (OLD.published_by IS NULL AND NEW.published_by IS NOT NULL))
       OR NEW.state <> 'rejected' AND ((OLD.rejected_at IS NULL AND NEW.rejected_at IS NOT NULL)
         OR (OLD.rejected_by IS NULL AND NEW.rejected_by IS NOT NULL) OR (OLD.rejection_reason IS NULL AND NEW.rejection_reason IS NOT NULL))
       OR NEW.state <> 'superseded' AND ((OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL)
         OR (OLD.superseded_by_fact_id IS NULL AND NEW.superseded_by_fact_id IS NOT NULL)
         OR (OLD.retracted_by IS NULL AND NEW.retracted_by IS NOT NULL) OR (OLD.retraction_reason IS NULL AND NEW.retraction_reason IS NOT NULL)) THEN
      RAISE EXCEPTION 'airport_curated_facts: a % transition may only carry its own stamps', NEW.state USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    -- No transition: the only change allowed is an actor reference CLEARED by an
    -- account erasure (ON DELETE SET NULL) or a superseding fact gone with its airport.
    IF (NEW.validation_report, NEW.validated_at, NEW.published_at, NEW.rejected_at, NEW.rejection_reason,
        NEW.superseded_at, NEW.retraction_reason)
       IS DISTINCT FROM
       (OLD.validation_report, OLD.validated_at, OLD.published_at, OLD.rejected_at, OLD.rejection_reason,
        OLD.superseded_at, OLD.retraction_reason)
       OR (NEW.validated_by IS NOT NULL AND NEW.validated_by IS DISTINCT FROM OLD.validated_by)
       OR (NEW.published_by IS NOT NULL AND NEW.published_by IS DISTINCT FROM OLD.published_by)
       OR (NEW.rejected_by IS NOT NULL AND NEW.rejected_by IS DISTINCT FROM OLD.rejected_by)
       OR (NEW.retracted_by IS NOT NULL AND NEW.retracted_by IS DISTINCT FROM OLD.retracted_by)
       OR (NEW.superseded_by_fact_id IS NOT NULL AND NEW.superseded_by_fact_id IS DISTINCT FROM OLD.superseded_by_fact_id) THEN
      RAISE EXCEPTION 'airport_curated_facts: nothing about a fact changes without a state transition' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS airport_curated_facts_guard ON public.airport_curated_facts;
CREATE TRIGGER airport_curated_facts_guard
  BEFORE INSERT OR UPDATE ON public.airport_curated_facts
  FOR EACH ROW EXECUTE FUNCTION public.airport_curated_facts_guard();

-- ── 2. the airport_profiles projection ───────────────────────────────────────
ALTER TABLE public.airport_profiles
  ADD COLUMN IF NOT EXISTS legacy_verified             boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS curated_timing_fact_id      uuid        REFERENCES public.airport_curated_facts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS curated_timing_expires_at   timestamptz,
  ADD COLUMN IF NOT EXISTS curated_topology_fact_id    uuid        REFERENCES public.airport_curated_facts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS curated_topology_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS curated_transport_fact_id   uuid        REFERENCES public.airport_curated_facts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS curated_transport_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS topology_version            integer     NOT NULL DEFAULT 0 CHECK (topology_version >= 0),
  ADD COLUMN IF NOT EXISTS topology_changed_at         timestamptz;
ALTER TABLE public.airport_profiles
  ADD COLUMN IF NOT EXISTS facts_provenance text GENERATED ALWAYS AS (
    CASE WHEN curated_timing_fact_id IS NULL THEN 'unvalidated_no_provenance' ELSE 'curated' END) STORED;

-- Existing data: the bare `verified` is kept, then nothing un-curated is verified.
UPDATE public.airport_profiles SET legacy_verified = true WHERE verified IS TRUE AND legacy_verified IS FALSE;
UPDATE public.airport_profiles SET verified = false
 WHERE verified IS TRUE AND curated_timing_fact_id IS NULL;

CREATE OR REPLACE FUNCTION public.airport_profiles_curation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  v_projection boolean := coalesce(current_setting('portava.airport_curation_projection', true), '') = 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.curated_timing_fact_id IS NOT NULL OR NEW.curated_topology_fact_id IS NOT NULL OR NEW.curated_transport_fact_id IS NOT NULL THEN
      RAISE EXCEPTION 'airport_profiles: a new airport row is never curated; publish facts through airport_curation_publish()' USING ERRCODE = 'check_violation';
    END IF;
    NEW.legacy_verified := coalesce(NEW.verified, false);
    NEW.curated_timing_expires_at := NULL; NEW.curated_topology_expires_at := NULL; NEW.curated_transport_expires_at := NULL;
    NEW.topology_version := 0;
    NEW.verified := false;
    RETURN NEW;
  END IF;

  IF NOT v_projection THEN
    -- A curated reference may be CLEARED by anyone (fail closed) but set only by the curation functions.
    IF (NEW.curated_timing_fact_id IS NOT NULL AND NEW.curated_timing_fact_id IS DISTINCT FROM OLD.curated_timing_fact_id)
       OR (NEW.curated_topology_fact_id IS NOT NULL AND NEW.curated_topology_fact_id IS DISTINCT FROM OLD.curated_topology_fact_id)
       OR (NEW.curated_transport_fact_id IS NOT NULL AND NEW.curated_transport_fact_id IS DISTINCT FROM OLD.curated_transport_fact_id)
       OR (NEW.curated_timing_expires_at IS NOT NULL AND NEW.curated_timing_expires_at IS DISTINCT FROM OLD.curated_timing_expires_at)
       OR (NEW.curated_topology_expires_at IS NOT NULL AND NEW.curated_topology_expires_at IS DISTINCT FROM OLD.curated_topology_expires_at)
       OR (NEW.curated_transport_expires_at IS NOT NULL AND NEW.curated_transport_expires_at IS DISTINCT FROM OLD.curated_transport_expires_at) THEN
      RAISE EXCEPTION 'airport_profiles: curated references are written only by airport_curation_publish() / airport_curation_retract()' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.topology_version IS DISTINCT FROM OLD.topology_version THEN
      RAISE EXCEPTION 'airport_profiles: topology_version is moved only by an authoritative change' USING ERRCODE = 'check_violation';
    END IF;
    -- A bare edit of a curated value makes it unvalidated, with no provenance.
    IF (NEW.domestic_buffer_min, NEW.domestic_buffer_max, NEW.international_buffer_min, NEW.international_buffer_max,
        NEW.immigration_extra_min, NEW.checked_bags_extra_min, NEW.traffic_extra_min)
       IS DISTINCT FROM
       (OLD.domestic_buffer_min, OLD.domestic_buffer_max, OLD.international_buffer_min, OLD.international_buffer_max,
        OLD.immigration_extra_min, OLD.checked_bags_extra_min, OLD.traffic_extra_min) THEN
      NEW.curated_timing_fact_id := NULL; NEW.curated_timing_expires_at := NULL;
    END IF;
    IF NEW.terminal_info IS DISTINCT FROM OLD.terminal_info THEN
      NEW.curated_topology_fact_id := NULL; NEW.curated_topology_expires_at := NULL;
    END IF;
    IF NEW.verified IS DISTINCT FROM OLD.verified THEN
      NEW.legacy_verified := coalesce(NEW.verified, false);
    END IF;
  END IF;

  -- Any change of a curated reference, or of the bare topology, is an AUTHORITATIVE change:
  -- everything derived from the old model (snapshots, the maturity rung, pinned terminal
  -- context) is stale, and the version every derivation carries moves.
  IF (NEW.curated_timing_fact_id, NEW.curated_topology_fact_id, NEW.curated_transport_fact_id, NEW.terminal_info)
     IS DISTINCT FROM (OLD.curated_timing_fact_id, OLD.curated_topology_fact_id, OLD.curated_transport_fact_id, OLD.terminal_info) THEN
    NEW.topology_version := OLD.topology_version + 1;
    NEW.topology_changed_at := now();
  END IF;
  NEW.verified := (NEW.curated_timing_fact_id IS NOT NULL AND NEW.curated_topology_fact_id IS NOT NULL
                   AND NEW.curated_transport_fact_id IS NOT NULL);
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS airport_profiles_curation_guard ON public.airport_profiles;
CREATE TRIGGER airport_profiles_curation_guard
  BEFORE INSERT OR UPDATE ON public.airport_profiles
  FOR EACH ROW EXECUTE FUNCTION public.airport_profiles_curation_guard();

-- ── 3. publish and retract ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.airport_curation_publish(p_fact_id uuid, p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  f        public.airport_curated_facts%ROWTYPE;
  v_prev   uuid;
  v_tv     integer;
BEGIN
  IF p_actor IS NULL THEN
    RETURN jsonb_build_object('outcome', 'no_actor');
  END IF;
  SELECT * INTO f FROM public.airport_curated_facts WHERE id = p_fact_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'no_fact');
  END IF;
  -- One publication per airport at a time, and the fact re-read under the lock.
  PERFORM 1 FROM public.airport_profiles WHERE id = f.airport_id FOR UPDATE;
  SELECT * INTO f FROM public.airport_curated_facts WHERE id = p_fact_id FOR UPDATE;
  IF f.state <> 'validated' THEN
    RETURN jsonb_build_object('outcome', 'not_validated', 'state', f.state);
  END IF;
  IF f.expires_at <= now() THEN
    RETURN jsonb_build_object('outcome', 'expired', 'expiresAt', f.expires_at);
  END IF;

  PERFORM set_config('portava.airport_curation_projection', 'on', true);
  UPDATE public.airport_curated_facts
     SET state = 'superseded', superseded_at = now(), superseded_by_fact_id = f.id
   WHERE airport_id = f.airport_id AND fact_kind = f.fact_kind AND state = 'published'
  RETURNING id INTO v_prev;
  UPDATE public.airport_curated_facts
     SET state = 'published', published_by = p_actor, published_at = now()
   WHERE id = f.id;

  IF f.fact_kind = 'timing_assumptions' THEN
    UPDATE public.airport_profiles SET
      domestic_buffer_min      = (f.value->>'domesticBufferMin')::integer,
      domestic_buffer_max      = (f.value->>'domesticBufferMax')::integer,
      international_buffer_min = (f.value->>'internationalBufferMin')::integer,
      international_buffer_max = (f.value->>'internationalBufferMax')::integer,
      immigration_extra_min    = (f.value->>'immigrationExtraMin')::integer,
      checked_bags_extra_min   = (f.value->>'checkedBagsExtraMin')::integer,
      traffic_extra_min        = (f.value->>'trafficExtraMin')::integer,
      curated_timing_fact_id = f.id, curated_timing_expires_at = f.expires_at, updated_at = now()
     WHERE id = f.airport_id;
  ELSIF f.fact_kind = 'terminal_topology' THEN
    UPDATE public.airport_profiles SET
      terminal_info = f.value, curated_topology_fact_id = f.id, curated_topology_expires_at = f.expires_at, updated_at = now()
     WHERE id = f.airport_id;
  ELSIF f.fact_kind = 'ground_transport' THEN
    UPDATE public.airport_profiles SET
      curated_transport_fact_id = f.id, curated_transport_expires_at = f.expires_at, updated_at = now()
     WHERE id = f.airport_id;
  END IF;
  PERFORM set_config('portava.airport_curation_projection', 'off', true);

  SELECT topology_version INTO v_tv FROM public.airport_profiles WHERE id = f.airport_id;
  RETURN jsonb_build_object('outcome', 'published', 'factId', f.id, 'airportId', f.airport_id, 'kind', f.fact_kind,
                            'version', f.version, 'supersededFactId', v_prev, 'topologyVersion', v_tv);
END $fn$;

CREATE OR REPLACE FUNCTION public.airport_curation_retract(p_fact_id uuid, p_actor uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  f      public.airport_curated_facts%ROWTYPE;
  v_tv   integer;
BEGIN
  IF p_actor IS NULL THEN
    RETURN jsonb_build_object('outcome', 'no_actor');
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 OR length(p_reason) > 1000 THEN
    RETURN jsonb_build_object('outcome', 'no_reason');
  END IF;
  SELECT * INTO f FROM public.airport_curated_facts WHERE id = p_fact_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'no_fact');
  END IF;
  PERFORM 1 FROM public.airport_profiles WHERE id = f.airport_id FOR UPDATE;
  SELECT * INTO f FROM public.airport_curated_facts WHERE id = p_fact_id FOR UPDATE;
  IF f.state <> 'published' THEN
    RETURN jsonb_build_object('outcome', 'not_published', 'state', f.state);
  END IF;

  PERFORM set_config('portava.airport_curation_projection', 'on', true);
  UPDATE public.airport_curated_facts
     SET state = 'superseded', superseded_at = now(), retracted_by = p_actor, retraction_reason = p_reason
   WHERE id = f.id;
  IF f.fact_kind = 'timing_assumptions' THEN
    UPDATE public.airport_profiles SET curated_timing_fact_id = NULL, curated_timing_expires_at = NULL, updated_at = now()
     WHERE id = f.airport_id AND curated_timing_fact_id = f.id;
  ELSIF f.fact_kind = 'terminal_topology' THEN
    UPDATE public.airport_profiles SET terminal_info = '{}'::jsonb, curated_topology_fact_id = NULL, curated_topology_expires_at = NULL, updated_at = now()
     WHERE id = f.airport_id AND curated_topology_fact_id = f.id;
  ELSIF f.fact_kind = 'ground_transport' THEN
    UPDATE public.airport_profiles SET curated_transport_fact_id = NULL, curated_transport_expires_at = NULL, updated_at = now()
     WHERE id = f.airport_id AND curated_transport_fact_id = f.id;
  END IF;
  PERFORM set_config('portava.airport_curation_projection', 'off', true);

  SELECT topology_version INTO v_tv FROM public.airport_profiles WHERE id = f.airport_id;
  RETURN jsonb_build_object('outcome', 'retracted', 'factId', f.id, 'airportId', f.airport_id, 'kind', f.fact_kind,
                            'version', f.version, 'topologyVersion', v_tv);
END $fn$;

COMMENT ON FUNCTION public.airport_curation_publish(uuid, uuid) IS
  '3874: publish a VALIDATED, unexpired curated airport fact: supersede the previous published version of its kind and project it onto airport_profiles (buffers / terminal_info / transport reference), bumping topology_version. service_role only.';
COMMENT ON FUNCTION public.airport_curation_retract(uuid, uuid, text) IS
  '3874: withdraw a PUBLISHED curated airport fact with a reason, clearing its airport_profiles projection (the airport falls back to unvalidated). service_role only.';

REVOKE ALL ON FUNCTION public.airport_curation_publish(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.airport_curation_retract(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.airport_curated_facts_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.airport_profiles_curation_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.airport_curation_publish(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.airport_curation_retract(uuid, uuid, text) TO service_role;

COMMIT;

DO $post$
DECLARE
  v_n bigint;
  v   text;
BEGIN
  IF to_regclass('public.airport_curated_facts') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3874): public.airport_curated_facts was not created';
  END IF;
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.airport_curated_facts'::regclass) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3874): RLS is not enabled on airport_curated_facts';
  END IF;
  FOREACH v IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
    IF has_table_privilege('anon', 'public.airport_curated_facts', v) OR has_table_privilege('authenticated', 'public.airport_curated_facts', v) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3874): a client role holds % on airport_curated_facts', v;
    END IF;
  END LOOP;
  FOREACH v IN ARRAY ARRAY['SELECT','INSERT','UPDATE'] LOOP
    IF NOT has_table_privilege('service_role', 'public.airport_curated_facts', v) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3874): service_role lacks % on airport_curated_facts -- the curation service could not run', v;
    END IF;
  END LOOP;
  IF has_table_privilege('service_role', 'public.airport_curated_facts', 'DELETE') OR has_table_privilege('service_role', 'public.airport_curated_facts', 'TRUNCATE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3874): service_role can delete curated facts -- the edit history would not be kept';
  END IF;
  IF has_function_privilege('anon', 'public.airport_curation_publish(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.airport_curation_publish(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.airport_curation_retract(uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.airport_curation_retract(uuid, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3874): a client role can execute a curation function';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.airport_curation_publish(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3874): service_role cannot execute airport_curation_publish';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('airport_curated_facts_guard','airport_profiles_curation_guard')) <> 2 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3874): both curation triggers must exist';
  END IF;
  SELECT count(*) INTO v_n FROM public.airport_profiles
   WHERE verified IS TRUE AND (curated_timing_fact_id IS NULL OR curated_topology_fact_id IS NULL OR curated_transport_fact_id IS NULL);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3874): % airport row(s) are verified without curated timing, topology and transport', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.airport_profiles WHERE facts_provenance <> 'unvalidated_no_provenance' AND curated_timing_fact_id IS NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3874): facts_provenance disagrees with curated_timing_fact_id on % row(s)', v_n;
  END IF;
  -- The functions run: an unknown fact id answers no_fact and writes nothing.
  IF (public.airport_curation_publish('00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid)->>'outcome') <> 'no_fact' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3874): airport_curation_publish did not answer no_fact for an unknown id';
  END IF;
END $post$;
