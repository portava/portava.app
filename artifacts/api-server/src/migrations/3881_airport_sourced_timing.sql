-- Sourced timing samples are projected from the existing validated publication workflow.
-- No observations are seeded. No feature flag is created or enabled.
BEGIN;
DO $pre$ BEGIN
  IF to_regclass('public.airport_curated_facts') IS NULL OR to_regprocedure('public.airport_profiles_curation_guard()') IS NULL THEN RAISE EXCEPTION 'PRECONDITION FAILED (3881): 3874 is required'; END IF;
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.airport_profiles'::regclass AND attname='curated_timing_evidence' AND NOT attisdropped)
    OR to_regprocedure('public.airport_profiles_timing_evidence_guard()') IS NOT NULL THEN RAISE EXCEPTION 'PRECONDITION FAILED (3881): timing projection already exists'; END IF;
END $pre$;
ALTER TABLE public.airport_profiles ADD COLUMN curated_timing_evidence jsonb;
CREATE FUNCTION public.airport_profiles_timing_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE f public.airport_curated_facts%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.curated_timing_evidence IS NOT NULL THEN RAISE EXCEPTION 'timing evidence must be published through airport curation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.curated_timing_evidence IS DISTINCT FROM OLD.curated_timing_evidence THEN RAISE EXCEPTION 'timing evidence projection is not directly writable'; END IF;
  IF NEW.curated_timing_fact_id IS NULL THEN NEW.curated_timing_evidence:=NULL; RETURN NEW; END IF;
  SELECT * INTO f FROM public.airport_curated_facts WHERE id=NEW.curated_timing_fact_id AND airport_id=NEW.id AND fact_kind='timing_assumptions' AND state='published';
  IF NOT FOUND THEN NEW.curated_timing_evidence:=NULL;
  ELSIF f.value ? 'timingEvidence' THEN
    NEW.curated_timing_evidence:=jsonb_build_object('factId',f.id,'sourceKind',f.source_kind,'evidence',f.value->'timingEvidence');
  ELSE NEW.curated_timing_evidence:=NULL; END IF;
  RETURN NEW;
END $fn$;
-- Alphabetical order follows airport_profiles_curation_guard, which validates/clears the curated reference.
CREATE TRIGGER airport_profiles_timing_evidence_guard BEFORE INSERT OR UPDATE ON public.airport_profiles FOR EACH ROW EXECUTE FUNCTION public.airport_profiles_timing_evidence_guard();
REVOKE ALL ON FUNCTION public.airport_profiles_timing_evidence_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.airport_profiles_timing_evidence_guard() TO service_role;
UPDATE public.airport_profiles SET curated_timing_fact_id=curated_timing_fact_id WHERE curated_timing_fact_id IS NOT NULL;
COMMENT ON COLUMN public.airport_profiles.curated_timing_evidence IS '3881: published anonymous timing sample evidence with source fact identity; never synthetic percentiles. Read-time expiry/context validation is mandatory.';
NOTIFY pgrst,'reload schema';
COMMIT;
