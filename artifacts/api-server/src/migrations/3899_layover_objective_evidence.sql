-- L78: sourced place facts and explicit private traveller intent, never purchased ranking.
-- Depends only on existing profiles/discovery_places and0127 airport_profiles/sessions.
-- Rollback: db/rollback/2026-10-18-3899-layover-objective-evidence-rollback.sql.
BEGIN;
DO $pre$ BEGIN
  IF to_regclass('public.discovery_places') IS NULL OR to_regclass('public.layover_sessions') IS NULL OR to_regclass('public.airport_profiles') IS NULL
    THEN RAISE EXCEPTION 'PRECONDITION FAILED (3899): place/airport/session prerequisites missing'; END IF;
  IF to_regclass('public.layover_objective_facts') IS NOT NULL OR to_regclass('public.layover_objective_intents') IS NOT NULL
    OR to_regprocedure('public.layover_objective_evidence_guard()') IS NOT NULL
    THEN RAISE EXCEPTION 'PRECONDITION FAILED (3899): objective evidence objects already exist'; END IF;
  IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_objective_evidence_enabled' AND enabled IS NOT FALSE)
    THEN RAISE EXCEPTION 'PRECONDITION FAILED (3899): existing capability must be FALSE'; END IF;
END $pre$;
CREATE TABLE public.layover_objective_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id UUID NOT NULL REFERENCES public.airport_profiles(id) ON DELETE CASCADE,
  place_id UUID NOT NULL REFERENCES public.discovery_places(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('local_distinctiveness','social_format','exertion','quoted_cost')),
  value JSONB NOT NULL CHECK(jsonb_typeof(value)='object'),
  source_class TEXT NOT NULL CHECK(source_class IN ('venue_operator','official_tourism','curator_observed')),
  source_url TEXT NOT NULL CHECK(length(source_url) BETWEEN 9 AND 1000 AND source_url LIKE 'https://%'),
  source_note TEXT NOT NULL CHECK(length(btrim(source_note)) BETWEEN 10 AND 1000),
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK(expires_at>observed_at AND expires_at<=observed_at+interval '90 days'),
  stated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  retracted_at TIMESTAMPTZ
);
CREATE INDEX layover_objective_facts_scope_idx ON public.layover_objective_facts(airport_id,place_id) WHERE retracted_at IS NULL;
CREATE TABLE public.layover_objective_intents (
  session_id UUID PRIMARY KEY REFERENCES public.layover_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  intent JSONB NOT NULL CHECK(jsonb_typeof(intent)='object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX layover_objective_intents_user_idx ON public.layover_objective_intents(user_id);
CREATE FUNCTION public.layover_objective_evidence_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF TG_TABLE_NAME='layover_objective_facts' THEN
    -- Privacy erasure may clear the curator reference; a fact's evidence is otherwise immutable.
    IF (to_jsonb(NEW)-'retracted_at'-'stated_by') IS DISTINCT FROM (to_jsonb(OLD)-'retracted_at'-'stated_by')
      OR NEW.stated_by IS DISTINCT FROM OLD.stated_by AND NEW.stated_by IS NOT NULL
      OR OLD.retracted_at IS NOT NULL AND NEW.retracted_at IS DISTINCT FROM OLD.retracted_at
      THEN RAISE EXCEPTION USING ERRCODE='LY450',MESSAGE='objective source facts are immutable; retract and publish a new source'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.layover_sessions WHERE id=NEW.session_id AND user_id=NEW.user_id)
      THEN RAISE EXCEPTION USING ERRCODE='LY451',MESSAGE='objective intent must belong to the session owner'; END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER layover_objective_fact_immutable BEFORE UPDATE ON public.layover_objective_facts FOR EACH ROW EXECUTE FUNCTION public.layover_objective_evidence_guard();
CREATE TRIGGER layover_objective_intent_owner BEFORE INSERT OR UPDATE ON public.layover_objective_intents FOR EACH ROW EXECUTE FUNCTION public.layover_objective_evidence_guard();
ALTER TABLE public.layover_objective_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.layover_objective_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_objective_facts,public.layover_objective_intents FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.layover_objective_facts,public.layover_objective_intents TO service_role;
REVOKE ALL ON FUNCTION public.layover_objective_evidence_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.layover_objective_evidence_guard() TO service_role;
COMMENT ON TABLE public.layover_objective_facts IS 'Public sourced place facts, airport-scoped complete out-of-pocket quotes; never revenue, sponsorship or Buddy list prices. Conflicting fresh sources remain unknown. Curator FK is cleared on erasure.';
COMMENT ON TABLE public.layover_objective_intents IS 'Private explicit layover preferences and personally meaningful place intent, not actual past memories. Erased with session/profile; never shared with crews or presence.';
INSERT INTO public.feature_flags(flag,enabled) VALUES('layover_objective_evidence_enabled',FALSE) ON CONFLICT(flag) DO NOTHING;
DO $post$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_class WHERE oid IN ('public.layover_objective_facts'::regclass,'public.layover_objective_intents'::regclass) AND NOT relrowsecurity)
    OR has_table_privilege('authenticated','public.layover_objective_facts','SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('authenticated','public.layover_objective_intents','SELECT,INSERT,UPDATE,DELETE')
    OR NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag='layover_objective_evidence_enabled' AND enabled IS FALSE)
    THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3899): service-only objective evidence contract failed'; END IF;
END $post$;
NOTIFY pgrst,'reload schema';
COMMIT;
