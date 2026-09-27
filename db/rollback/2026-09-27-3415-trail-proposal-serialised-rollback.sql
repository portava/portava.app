-- Rollback for 3415_trail_proposal_serialised.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3415 DID
-- =============
--   * Created eight SECURITY INVOKER functions: trail_letter_fold, trail_canonical_slug,
--     trail_title_tokens, trail_normalised_destination, trail_token_similarity,
--     trail_canonicalisation_verdict, trail_proposal_peers and trail_propose.
--   * Wrote no row and changed no table.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Drops the eight functions and deletes 3415's schema_migration_ledger row so a
-- later apply run re-applies it. No row is deleted. What it gives up:
--   * the serialised decision — two racing near-duplicate proposals could again
--     both be admitted (census-discovery DC-03, §61;
--     src/test/db/trailsProposalRace.db.test.ts goes red);
--   * Trail creation itself, while code that calls trail_propose is deployed:
--     TrailService.proposeTrail fails CLOSED without the function, so
--     POST /v1/discovery/trails answers 503 degraded_unavailable until 3415 is
--     re-applied. That is deliberate: an unserialised creation is the defect.

BEGIN;

DROP FUNCTION IF EXISTS public.trail_propose(text, text, text, uuid, uuid);
DROP FUNCTION IF EXISTS public.trail_proposal_peers(text, text);
DROP FUNCTION IF EXISTS public.trail_canonicalisation_verdict(text, text, jsonb);
DROP FUNCTION IF EXISTS public.trail_token_similarity(text[], text[]);
DROP FUNCTION IF EXISTS public.trail_normalised_destination(text);
DROP FUNCTION IF EXISTS public.trail_title_tokens(text);
DROP FUNCTION IF EXISTS public.trail_canonical_slug(text);
DROP FUNCTION IF EXISTS public.trail_letter_fold(text);

DO $$
BEGIN
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL THEN
    DELETE FROM public.schema_migration_ledger
     WHERE filename = '3415_trail_proposal_serialised.sql';
  END IF;
END $$;

COMMIT;

-- ── Postconditions ──────────────────────────────────────────────────────────
DO $post$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.trail_letter_fold(text)',
    'public.trail_canonical_slug(text)', 'public.trail_title_tokens(text)',
    'public.trail_normalised_destination(text)', 'public.trail_token_similarity(text[],text[])',
    'public.trail_canonicalisation_verdict(text,text,jsonb)', 'public.trail_proposal_peers(text,text)',
    'public.trail_propose(text,text,text,uuid,uuid)'] LOOP
    IF to_regprocedure(f) IS NOT NULL THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED (3415 rollback): % still exists.', f;
    END IF;
  END LOOP;
  -- 2910 must survive: this rollback removes 3415's functions, not the Trails.
  IF to_regclass('public.trails') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3415 rollback): public.trails is gone; this rollback must not touch 2910.';
  END IF;
  IF to_regclass('public.schema_migration_ledger') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.schema_migration_ledger
                  WHERE filename = '3415_trail_proposal_serialised.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3415 rollback): the ledger still records 3415 as applied.';
  END IF;
END $post$;
