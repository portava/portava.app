-- A private Memory draft retains ONE explicit message reference. No message
-- body, media URL, location, participant list or title snapshot is copied.
BEGIN;
CREATE TABLE IF NOT EXISTS public.telegraph_memory_sources (
  memory_id uuid PRIMARY KEY REFERENCES public.memories(id) ON DELETE CASCADE,
  message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.telegraph_memory_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegraph_memory_sources FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.telegraph_memory_sources TO service_role;

CREATE OR REPLACE FUNCTION public.telegraph_memory_draft_execute(p_command jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  actor uuid := (p_command->>'actor_user_id')::uuid;
  source_id uuid := (p_command#>>'{payload,telegraph_source_message_id}')::uuid;
  msg public.messages%ROWTYPE;
  member public.message_thread_members%ROWTYPE;
  result jsonb;
  target uuid;
BEGIN
  IF p_command->>'type' IS DISTINCT FROM 'CREATE_MEMORY' OR actor IS NULL OR source_id IS NULL
    OR p_command#>>'{payload,write,state}' IS DISTINCT FROM 'draft'
    OR p_command#>>'{payload,write,visibility}' IS DISTINCT FROM 'only_me' THEN
    RAISE EXCEPTION 'invalid_telegraph_memory_command';
  END IF;
  -- Same lock order as receipts and unsend. Recheck at the committing writer,
  -- including on retries, rather than trusting an earlier HTTP authorization.
  SELECT * INTO msg FROM public.messages WHERE id=source_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'message_unavailable'; END IF;
  PERFORM 1 FROM public.message_threads WHERE id=msg.thread_id FOR UPDATE;
  SELECT * INTO msg FROM public.messages WHERE id=source_id FOR UPDATE;
  IF NOT FOUND OR msg.deleted_at IS NOT NULL OR msg.unsent_at IS NOT NULL OR msg.ciphertext IS NOT NULL THEN
    RAISE EXCEPTION 'message_unavailable';
  END IF;
  SELECT * INTO member FROM public.message_thread_members WHERE thread_id=msg.thread_id AND user_id=actor FOR UPDATE;
  IF NOT FOUND OR member.left_at IS NOT NULL THEN RAISE EXCEPTION 'message_unavailable'; END IF;
  IF msg.sender_id<>actor AND ((member.visible_from_at IS NOT NULL AND msg.created_at<member.visible_from_at)
    OR (member.visible_from_sequence IS NOT NULL AND (msg.sequence IS NULL OR msg.sequence<member.visible_from_sequence))
    OR (member.visible_until_sequence IS NOT NULL AND (msg.sequence IS NULL OR msg.sequence>member.visible_until_sequence))) THEN
    RAISE EXCEPTION 'message_unavailable';
  END IF;
  IF EXISTS(SELECT 1 FROM public.blocks WHERE (blocker_id=actor AND blocked_id=msg.sender_id)
    OR (blocked_id=actor AND blocker_id=msg.sender_id)) THEN RAISE EXCEPTION 'message_unavailable'; END IF;
  -- The canonical kernel still owns policy, receipts, domain events and outbox.
  -- It and the reference insert succeed or roll back in this one transaction.
  result := public.memory_kernel_execute(p_command);
  IF result->>'ok' IS DISTINCT FROM 'true' THEN RETURN result; END IF;
  target := (result->>'memory_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.memories WHERE id=target AND owner_id=actor) THEN
    RAISE EXCEPTION 'memory_owner_mismatch';
  END IF;
  INSERT INTO public.telegraph_memory_sources(memory_id,message_id) VALUES(target,source_id)
    ON CONFLICT(memory_id) DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM public.telegraph_memory_sources WHERE memory_id=target AND message_id=source_id) THEN
    RAISE EXCEPTION 'memory_source_mismatch';
  END IF;
  INSERT INTO public.saved_messages(user_id,message_id) VALUES(actor,source_id) ON CONFLICT DO NOTHING;
  RETURN result;
END;
$fn$;
REVOKE ALL ON FUNCTION public.telegraph_memory_draft_execute(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_memory_draft_execute(jsonb) TO service_role;
COMMIT;
