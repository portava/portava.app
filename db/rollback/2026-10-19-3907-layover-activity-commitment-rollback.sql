BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL search_path=pg_catalog,pg_temp;
DO $pre$ DECLARE definition text; BEGIN
  PERFORM 1 FROM public.feature_flags WHERE flag='layover_activity_commitment_enabled' FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_activity_commitment_enabled' AND (enabled IS NOT FALSE OR description IS NOT NULL OR metadata IS NOT NULL))
    OR EXISTS(SELECT 1 FROM public.feature_flag_audit_log WHERE flag='layover_activity_commitment_enabled') THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3907): activity flag changed or has audit history'; END IF;
  IF to_regclass('public.layover_objective_facts') IS NULL THEN
    IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_activity_commitment_enabled') THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3907): partial activity schema'; END IF;
    RETURN;
  END IF;
  LOCK TABLE public.layover_objective_facts IN ACCESS EXCLUSIVE MODE;
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conrelid='public.layover_objective_facts'::regclass AND conname='layover_objective_facts_kind_check' AND convalidated AND NOT condeferrable AND conislocal AND coninhcount=0;
  IF definition=$$CHECK ((kind = ANY (ARRAY['local_distinctiveness'::text, 'social_format'::text, 'exertion'::text, 'quoted_cost'::text])))$$ AND NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_activity_commitment_enabled') THEN RETURN; END IF;
  IF definition IS DISTINCT FROM $$CHECK ((kind = ANY (ARRAY['local_distinctiveness'::text, 'social_format'::text, 'exertion'::text, 'quoted_cost'::text, 'activity_commitment'::text])))$$ THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3907): activity kind constraint changed'; END IF;
  IF EXISTS(SELECT 1 FROM public.layover_objective_facts WHERE kind='activity_commitment') THEN RAISE EXCEPTION 'ROLLBACK REFUSED (3907): activity evidence exists'; END IF;
  ALTER TABLE public.layover_objective_facts DROP CONSTRAINT layover_objective_facts_kind_check;
  ALTER TABLE public.layover_objective_facts ADD CONSTRAINT layover_objective_facts_kind_check CHECK(kind IN ('local_distinctiveness','social_format','exertion','quoted_cost'));
END $pre$;
DELETE FROM public.feature_flags WHERE flag='layover_activity_commitment_enabled' AND enabled IS FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename='3907_layover_activity_commitment.sql';
NOTIFY pgrst,'reload schema';
COMMIT;
