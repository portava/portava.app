-- 3386_creator_attribution_recommendation_link.sql
-- census-discovery DV-26 (`02` §17 "Trail attribution … should preserve
-- trail_id, recommendation_id, content contributors involved, confidence,
-- downstream revenue event") and DV-67 (`09` §11 "attribution is linked";
-- `08` §4 "Every monetizable action should be able to link back to:
-- recommendation_id, …"). Depends on 2920 and on rank_events.recommendation_id
-- (2891, applied to production 2026-09-14).
--
-- ── THE DEFECT ──────────────────────────────────────────────────────────────
-- `grep -c recommendation_id` over 2910 and 2920 returned 0 and 0 (census
-- §40.5). Four of `02` §17's five attribution facts were storable on
-- public.creator_attributions — the subject (trail_id when subject_kind =
-- 'trail'), one row per contributor, confidence, and the value event — and the
-- served recommendation that led to the action had no column on ANY
-- attribution relation. The recommendation id exists on every served
-- Discovery item (census §48, lib/discoveryRecommendationRecord.ts) and on
-- every signed-in exposure row in rank_events; it simply could not be carried
-- from an exposure to the attribution a conversion produces.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────
--   creator_attributions.recommendation_id text NULL
--     + ca_recommendation_id_shape: 2891's shape, [A-Za-z0-9_-]{22}
--     + trigger ca_recommendation_is_served: an ORIGINAL attribution (one that
--       supersedes nothing) may only name an id that a rank_events row carries
--     + a partial index for the reverse read (exposure -> attributions).
--
-- NULLABLE ON PURPOSE. Most attributions have no recommendation: a Travel
-- Partner's completed booking was not necessarily reached through Discovery, and
-- claiming a recommendation for it would be the fabrication `08` §4 exists to
-- prevent. NULL means "no served recommendation is linked", never "unknown".
--
-- ── WHY THE DATABASE CHECKS EXISTENCE AND NOT OWNERSHIP ─────────────────────
-- A recommendation id is minted per (viewer, session, instant, surface,
-- position, item) and is NEVER trusted from a client. The OWNERSHIP rule —
-- the id must be the converting viewer's own exposure, never another viewer's —
-- needs the converting viewer, which this table does not store (it stores the
-- creator who is credited, and storing the traveller here would put a
-- traveller's identity on a creator-facing record). So ownership is enforced
-- where the viewer is known: services/creators/CreatorAttributionService.ts
-- binds the claimed id through lib/creatorServedRecommendation.ts against the
-- viewer's own rank_events row, refusing another viewer's, an unknown and a
-- later-than-the-conversion id. The database adds the part it CAN check for
-- every writer: the id names a real served exposure. An invented id is refused
-- here even from a writer that bypasses the service.
--
-- The trigger checks ORIGINALS only. A hold, a release or a recomputation
-- supersedes an existing row and must carry its recommendation_id forward
-- unchanged (3387 enforces identity on supersession); requiring the exposure
-- row to still exist at that moment would make a rank_events retention sweep
-- block a fraud hold, which is backwards.
--
-- ── 2920's RE-RUN GUARD, STATED ─────────────────────────────────────────────
-- 2920 compares creator_attributions' columns to an EXACT set before
-- re-asserting itself. After this file that set is no longer exact, so a re-run
-- of 2920 refuses (its state C) instead of re-asserting over a table it did not
-- create. That is 2920 working as written, not a regression.
--
-- RUNTIME EFFECT: none on any existing surface. The column is written only by
-- CreatorAttributionService (gated on creator_attribution_enabled, 2922, seeded
-- FALSE), and only when a caller supplies a recommendation it can bind.
--
-- Rollback: db/rollback/2026-09-27-3386-creator-attribution-recommendation-link-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.creator_attributions') IS NULL THEN
    RAISE EXCEPTION '3386: PRECONDITION FAILED: public.creator_attributions does not exist (2920 not applied).';
  END IF;
  IF to_regclass('public.rank_events') IS NULL THEN
    RAISE EXCEPTION '3386: PRECONDITION FAILED: public.rank_events does not exist.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'rank_events' AND column_name = 'recommendation_id'
  ) THEN
    RAISE EXCEPTION '3386: PRECONDITION FAILED: rank_events.recommendation_id is absent (2891 not applied); an attribution could name an exposure nothing records.';
  END IF;
  -- RE-RUNNABLE, and says which state it found.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'creator_attributions' AND column_name = 'recommendation_id'
       AND data_type <> 'text'
  ) THEN
    RAISE EXCEPTION '3386: PRECONDITION FAILED: creator_attributions.recommendation_id exists and is not text; refusing to re-assert over a different column.';
  END IF;
END
$pre$;

ALTER TABLE public.creator_attributions
  ADD COLUMN IF NOT EXISTS recommendation_id text NULL;

ALTER TABLE public.creator_attributions
  DROP CONSTRAINT IF EXISTS ca_recommendation_id_shape;
ALTER TABLE public.creator_attributions
  ADD CONSTRAINT ca_recommendation_id_shape
  CHECK (recommendation_id IS NULL OR recommendation_id ~ '^[A-Za-z0-9_-]{22}$');

COMMENT ON COLUMN public.creator_attributions.recommendation_id IS
  '08 §4 / 02 §17 / 09 §11: the served Discovery recommendation (lib/discoveryRecommendationRecord.ts) that the attributed action is linked to. NULL = no recommendation is linked (never "unknown"). Written only after the service binds the claimed id to the CONVERTING viewer''s own rank_events exposure (lib/creatorServedRecommendation.ts); the database additionally refuses, on an original row, an id no rank_events row carries (trigger ca_recommendation_is_served). Carried forward unchanged by holds, releases and recomputations (3387).';

CREATE INDEX IF NOT EXISTS ca_recommendation_idx
  ON public.creator_attributions (recommendation_id)
  WHERE recommendation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.creator_attribution_recommendation_is_served()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $fn$
BEGIN
  IF NEW.recommendation_id IS NULL OR NEW.supersedes_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.rank_events r WHERE r.recommendation_id = NEW.recommendation_id
  ) THEN
    RAISE EXCEPTION
      'creator_attributions: recommendation_id % names no served exposure (no rank_events row carries it); an attribution may only link a recommendation that was actually served',
      NEW.recommendation_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
COMMENT ON FUNCTION public.creator_attribution_recommendation_is_served() IS
  '3386: an ORIGINAL creator_attributions row may link only a recommendation id that a rank_events row carries. Existence only — ownership (the converting viewer''s own exposure) is enforced by the service, which knows the viewer. Raised as foreign_key_violation because it is a reference to a row that does not exist.';

-- PostgreSQL has no CREATE TRIGGER IF NOT EXISTS; drop-then-create is the
-- re-runnable form 2920 and 2921 use.
DROP TRIGGER IF EXISTS ca_recommendation_is_served ON public.creator_attributions;
CREATE TRIGGER ca_recommendation_is_served
  BEFORE INSERT ON public.creator_attributions
  FOR EACH ROW EXECUTE FUNCTION public.creator_attribution_recommendation_is_served();

REVOKE ALL ON FUNCTION public.creator_attribution_recommendation_is_served() FROM PUBLIC;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE n int; probe_user uuid; probe_ok boolean := false;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'creator_attributions'
     AND column_name = 'recommendation_id' AND is_nullable = 'YES' AND data_type = 'text';
  IF n <> 1 THEN RAISE EXCEPTION '3386: POSTCONDITION FAILED: recommendation_id is not a nullable text column'; END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'public.creator_attributions'::regclass AND conname = 'ca_recommendation_id_shape';
  IF n <> 1 THEN RAISE EXCEPTION '3386: POSTCONDITION FAILED: the recommendation id shape CHECK is absent'; END IF;

  SELECT count(*) INTO n FROM pg_trigger
   WHERE tgrelid = 'public.creator_attributions'::regclass AND tgname = 'ca_recommendation_is_served' AND NOT tgisinternal;
  IF n <> 1 THEN RAISE EXCEPTION '3386: POSTCONDITION FAILED: ca_recommendation_is_served is absent'; END IF;

  -- The append-only posture 2920 gave the table is untouched.
  IF has_table_privilege('service_role', 'public.creator_attributions', 'UPDATE') THEN
    RAISE EXCEPTION '3386: POSTCONDITION FAILED: service_role has UPDATE on creator_attributions';
  END IF;
  IF has_table_privilege('authenticated', 'public.creator_attributions', 'SELECT')
     OR has_table_privilege('anon', 'public.creator_attributions', 'SELECT') THEN
    RAISE EXCEPTION '3386: POSTCONDITION FAILED: a client role can read creator_attributions';
  END IF;

  -- PROVE the existence rule rather than assert it: an original row naming an
  -- id no exposure carries must be refused.
  SELECT p.id INTO probe_user FROM public.profiles p LIMIT 1;
  IF probe_user IS NULL THEN
    RAISE WARNING '3386: unserved-recommendation probe SKIPPED — public.profiles is empty on this database';
  ELSE
    BEGIN
      INSERT INTO public.creator_attributions
        (creator_type, subject_kind, subject_id, value_event, value_event_id,
         attribution_basis, beneficiary_user_id, rule_version, idempotency_key, recommendation_id)
      VALUES
        ('trail_builder', 'trail', gen_random_uuid(), 'route_completion', NULL,
         'seam_no_producer', probe_user, 'creator-rules/trail-builder/v1',
         '3386-postcondition-probe', '3386probeXXXXXXXXXXXXX');
      probe_ok := true;
    EXCEPTION
      WHEN foreign_key_violation THEN NULL;  -- expected: ca_recommendation_is_served
    END;
    IF probe_ok THEN
      RAISE EXCEPTION '3386: POSTCONDITION FAILED: an attribution naming an unserved recommendation id was accepted';
    END IF;
  END IF;
END
$post$;

COMMIT;

-- REVERSAL: db/rollback/2026-09-27-3386-creator-attribution-recommendation-link-rollback.sql
-- (drops the trigger, the function, the index, the CHECK and the column; it
-- REFUSES while any row carries a recommendation_id, because dropping the
-- column destroys the only link from those attributions to their exposure).
