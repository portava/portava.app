-- Generated with supabase migration new; moved to the repository's canonical
-- numbered migration directory. P77: an explicit, private association only.
-- No legacy backfill and no copied participants, media, or Memory contents.
BEGIN;

CREATE TABLE public.passport_memory_sources (
  passport_memory_id uuid PRIMARY KEY REFERENCES public.passport_memories(id) ON DELETE CASCADE,
  memory_id uuid NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE
);
CREATE INDEX passport_memory_sources_memory_idx ON public.passport_memory_sources(memory_id);
ALTER TABLE public.passport_memory_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.passport_memory_sources FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.passport_memory_sources TO service_role;
COMMENT ON TABLE public.passport_memory_sources IS
  'Owner-chosen private source association for Passport scrapbook People views. No participant cache. Only passport_memory_source_set writes; service reads revalidate both owners, source lifecycle, canonical redirects and participant consent. Never exposed through public Passport SELECT.';

CREATE FUNCTION public.passport_memory_source_set(
  p_actor uuid, p_passport_memory uuid, p_memory uuid, p_expected_memory uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE v_owner uuid; v_status text; v_source uuid; v_memory_owner uuid; v_state text;
BEGIN
  -- The authenticated server supplies p_actor. No browser or anon role can
  -- execute this command, nor write the association table directly.
  SELECT user_id, status INTO v_owner, v_status FROM public.passport_memories
    WHERE id = p_passport_memory FOR UPDATE;
  IF NOT FOUND OR p_actor IS NULL OR v_owner IS DISTINCT FROM p_actor OR v_status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  SELECT memory_id INTO v_source FROM public.passport_memory_sources WHERE passport_memory_id = p_passport_memory;
  -- Revalidate the proposed source even for an idempotent retry. An owner may
  -- not newly associate a deleted/merged-away source; existing links remain
  -- stable IDs whose reader follows the canonical one-hop redirect.
  IF p_memory IS NOT NULL THEN
    SELECT owner_id, state INTO v_memory_owner, v_state FROM public.memories WHERE id = p_memory FOR UPDATE;
    IF NOT FOUND OR v_memory_owner IS DISTINCT FROM p_actor OR v_state IS NULL OR v_state = 'deleted' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
    END IF;
  END IF;
  IF v_source IS NOT DISTINCT FROM p_memory THEN
    RETURN jsonb_build_object('ok', true, 'memoryId', p_memory);
  END IF;
  -- A delayed retry must not replace a more recent owner choice.
  IF v_source IS DISTINCT FROM p_expected_memory THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'conflict');
  END IF;
  IF p_memory IS NULL THEN
    DELETE FROM public.passport_memory_sources WHERE passport_memory_id = p_passport_memory;
  ELSE
    INSERT INTO public.passport_memory_sources(passport_memory_id, memory_id)
      VALUES(p_passport_memory, p_memory)
      ON CONFLICT(passport_memory_id) DO UPDATE SET memory_id = EXCLUDED.memory_id;
  END IF;
  RETURN jsonb_build_object('ok', true, 'memoryId', p_memory);
END
$fn$;
REVOKE ALL ON FUNCTION public.passport_memory_source_set(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.passport_memory_source_set(uuid, uuid, uuid, uuid) TO service_role;

COMMIT;
