-- L272: bind the existing Safe Return product to one certified layover return.
-- Dependencies: profiles, 0102/0167 Safe Return, 0127 layovers, 2741 returning status, feature_flags.
-- Gap-number order: no file above 3893 references these objects or alters safe_return_sessions.
-- No production application or activation. The new gate is seeded FALSE; 2741's gate is also required.
-- return_started_at is the actual pending -> active transition, NOT the reservation created_at.
-- Generic "I'm safe" is not airport evidence; the checkpoint route closes the bound timer explicitly.
-- Rollback: db/rollback/2026-10-18-3893-layover-safe-return-links-rollback.sql (refuses data, audit history or drift).
BEGIN;
DO $pre$ BEGIN
  IF to_regclass('public.safe_return_sessions') IS NULL OR to_regclass('public.layover_sessions') IS NULL
     OR to_regclass('public.profiles') IS NULL OR to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3893): Safe Return, layover, profiles and feature flags must exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.layover_sessions'::regclass AND pg_get_constraintdef(oid) LIKE '%returning%') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3893): 2741 returning status required';
  END IF;
END $pre$;
CREATE TABLE IF NOT EXISTS public.layover_safe_return_links (
  layover_session_id uuid PRIMARY KEY REFERENCES public.layover_sessions(id) ON DELETE CASCADE,
  safe_return_session_id uuid NOT NULL UNIQUE REFERENCES public.safe_return_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  certified_deadline timestamptz NOT NULL,
  certification jsonb NOT NULL CHECK (jsonb_typeof(certification)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  return_started_at timestamptz
);
CREATE INDEX IF NOT EXISTS layover_safe_return_links_user_idx ON public.layover_safe_return_links(user_id);
CREATE INDEX IF NOT EXISTS layover_safe_return_links_started_idx ON public.layover_safe_return_links(return_started_at) WHERE return_started_at IS NOT NULL;
ALTER TABLE public.layover_safe_return_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.layover_safe_return_links FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.layover_safe_return_links TO service_role;
CREATE POLICY layover_safe_return_links_service_only ON public.layover_safe_return_links FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE FUNCTION public.layover_safe_return_link_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.layover_sessions WHERE id=NEW.layover_session_id AND user_id=NEW.user_id)
     OR NOT EXISTS (SELECT 1 FROM public.safe_return_sessions WHERE id=NEW.safe_return_session_id AND user_id=NEW.user_id) THEN
    RAISE EXCEPTION 'layover_safe_return_owner_mismatch';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.safe_return_sessions WHERE id=NEW.safe_return_session_id AND status='pending' AND timer_end_at=NEW.certified_deadline)
       OR NEW.return_started_at IS NOT NULL THEN RAISE EXCEPTION 'layover_safe_return_reservation_invalid'; END IF;
  ELSE
    IF NEW.layover_session_id<>OLD.layover_session_id OR NEW.safe_return_session_id<>OLD.safe_return_session_id
       OR NEW.user_id<>OLD.user_id OR NEW.created_at<>OLD.created_at OR NEW.certified_deadline>OLD.certified_deadline
       OR (OLD.return_started_at IS NOT NULL AND NEW.return_started_at IS DISTINCT FROM OLD.return_started_at) THEN
      RAISE EXCEPTION 'layover_safe_return_link_immutable';
    END IF;
    IF NEW.return_started_at IS DISTINCT FROM OLD.return_started_at AND NOT EXISTS
       (SELECT 1 FROM public.safe_return_sessions WHERE id=NEW.safe_return_session_id AND status='active' AND timer_start_at=NEW.return_started_at) THEN
      RAISE EXCEPTION 'layover_safe_return_start_not_observed';
    END IF;
    IF NEW.certified_deadline<OLD.certified_deadline THEN
      UPDATE public.safe_return_sessions SET timer_end_at=least(timer_end_at,NEW.certified_deadline), updated_at=now()
        WHERE id=NEW.safe_return_session_id AND status IN ('pending','active','missed');
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.layover_safe_return_link_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER layover_safe_return_link_guard BEFORE INSERT OR UPDATE ON public.layover_safe_return_links FOR EACH ROW EXECUTE FUNCTION public.layover_safe_return_link_guard();
CREATE FUNCTION public.layover_safe_return_timer_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE bound public.layover_safe_return_links%ROWTYPE;
BEGIN
  SELECT * INTO bound FROM public.layover_safe_return_links WHERE safe_return_session_id=OLD.id;
  IF NOT FOUND THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  IF current_setting('role',true) IN ('anon','authenticated') THEN RAISE EXCEPTION 'layover_safe_return_server_authoritative'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.user_id<>OLD.user_id OR NEW.timer_end_at IS NULL OR NEW.timer_end_at>bound.certified_deadline THEN
    RAISE EXCEPTION 'layover_safe_return_certified_deadline';
  END IF;
  IF NEW.status='active' AND OLD.status='pending' THEN
    IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='layover_safe_return_product_enabled' AND enabled)
       OR NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='layover_safe_return_status_enabled' AND enabled)
       OR NEW.timer_start_at IS NULL THEN RAISE EXCEPTION 'layover_safe_return_start_disabled'; END IF;
    UPDATE public.layover_sessions SET status='returning',updated_at=now() WHERE id=bound.layover_session_id AND user_id=bound.user_id AND status IN ('active','returning');
    IF NOT FOUND THEN RAISE EXCEPTION 'layover_safe_return_layover_ended'; END IF;
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.layover_safe_return_timer_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER layover_safe_return_timer_guard BEFORE UPDATE OR DELETE ON public.safe_return_sessions FOR EACH ROW EXECUTE FUNCTION public.layover_safe_return_timer_guard();
CREATE FUNCTION public.layover_safe_return_started() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF NEW.status='active' AND OLD.status='pending' THEN
    UPDATE public.layover_safe_return_links SET return_started_at=NEW.timer_start_at WHERE safe_return_session_id=NEW.id AND return_started_at IS NULL;
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.layover_safe_return_started() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER layover_safe_return_started AFTER UPDATE ON public.safe_return_sessions FOR EACH ROW EXECUTE FUNCTION public.layover_safe_return_started();
INSERT INTO public.feature_flags(flag,enabled,description) VALUES ('layover_safe_return_product_enabled',false,'3893: certified layover deadlines and state bind existing Safe Return; requires 2741 status + 2992 checkpoints and safe_return_enabled') ON CONFLICT(flag) DO NOTHING;
DO $post$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.layover_safe_return_links'::regclass AND relrowsecurity)
     OR has_table_privilege('authenticated','public.layover_safe_return_links','SELECT')
     OR has_table_privilege('anon','public.layover_safe_return_links','INSERT') THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3893): service-only RLS required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag='layover_safe_return_product_enabled') THEN RAISE EXCEPTION 'POSTCONDITION FAILED (3893): flag missing'; END IF;
END $post$;
NOTIFY pgrst,'reload schema';
COMMIT;
