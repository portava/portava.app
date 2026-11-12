BEGIN;

-- The membership of a restrictive SELECT policy is the whole audience that
-- could hold SELECT. The predicate still lets owners retract their own rows.
-- The old 3390 privilege audit distinguishes a PUBLIC narrowing from one of
-- its explicitly role-targeted restrictive denies.
ALTER POLICY discovery_places_canonical_moderation ON public.discovery_places TO PUBLIC;

-- A Highlights insert can run under a client role. Give its deferred guard
-- exclusively the relations needed for a highlight. A writer of a regular
-- highlight never needs privileges on private Memory items or reference rows.
CREATE OR REPLACE FUNCTION public.highlight_post_reference_destination_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE
  actual_url text;
  actual_type text;
  actual_owner uuid;
BEGIN
  SELECT media_url, media_type, owner_id INTO actual_url, actual_type, actual_owner
    FROM public.highlights WHERE id = NEW.id;
  IF NOT FOUND OR actual_type IS DISTINCT FROM 'application/vnd.portava.post-reference+json' THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.post_destination_references r
    WHERE r.highlight_id = NEW.id AND r.owner_id = actual_owner
      AND actual_url = 'portava-post-reference:' || r.id::text
  ) THEN
    RAISE EXCEPTION 'post_reference_provenance_required';
  END IF;
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.highlight_post_reference_destination_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER highlight_post_reference_guard ON public.highlights;
CREATE CONSTRAINT TRIGGER highlight_post_reference_guard AFTER INSERT OR UPDATE ON public.highlights
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.highlight_post_reference_destination_guard();

COMMIT;
