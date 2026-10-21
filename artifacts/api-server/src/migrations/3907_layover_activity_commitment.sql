-- Extends the existing sourced place-fact producer; no invented category commitment.
BEGIN;
DO $pre$ BEGIN
  IF to_regclass('public.layover_objective_facts') IS NULL THEN RAISE EXCEPTION 'PRECONDITION FAILED (3907): 3899 is required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.layover_objective_facts'::regclass AND conname='layover_objective_facts_kind_check' AND pg_get_constraintdef(oid) = $$CHECK ((kind = ANY (ARRAY['local_distinctiveness'::text, 'social_format'::text, 'exertion'::text, 'quoted_cost'::text])))$$) THEN RAISE EXCEPTION 'PRECONDITION FAILED (3907): original kind constraint changed or extension already applied'; END IF;
  IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_objective_evidence_enabled' AND enabled IS NOT FALSE) THEN RAISE EXCEPTION 'PRECONDITION FAILED (3907): objective capability must be FALSE'; END IF;
  IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_activity_commitment_enabled') OR EXISTS(SELECT 1 FROM public.feature_flag_audit_log WHERE flag='layover_activity_commitment_enabled') THEN RAISE EXCEPTION 'PRECONDITION FAILED (3907): unowned activity flag or flag history already exists'; END IF;
END $pre$;
ALTER TABLE public.layover_objective_facts DROP CONSTRAINT layover_objective_facts_kind_check;
ALTER TABLE public.layover_objective_facts ADD CONSTRAINT layover_objective_facts_kind_check CHECK(kind IN ('local_distinctiveness','social_format','exertion','quoted_cost','activity_commitment'));
INSERT INTO public.feature_flags(flag,enabled) VALUES('layover_activity_commitment_enabled',FALSE);
NOTIFY pgrst,'reload schema';
COMMIT;
