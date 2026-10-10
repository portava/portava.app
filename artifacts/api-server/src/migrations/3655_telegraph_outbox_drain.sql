-- 3655_telegraph_outbox_drain.sql
-- Telegraph §13.3 — the CONSUMER side of 2810's transactional outbox
-- (census-telegraph T154, T196, T376). POST-CUTOVER CANONICAL FORWARD MIGRATION.
-- Lane T-REL band 3654-3659.
--
-- Spec §13.3, verbatim: "Canonical mutation and event-outbox write occur in the
-- same database transaction. Push, realtime fanout, indexing, translation,
-- moderation, analytics and projections consume asynchronously and
-- idempotently."
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT 2810 LEFT OPEN, IN ITS OWN WORDS
-- ══════════════════════════════════════════════════════════════════════════════
-- "IT DOES NOT DRAIN THE OUTBOX. public.telegraph_outbox accumulates rows with
-- published_at IS NULL and nothing reads them yet." and "exactly-once DELIVERY
-- … needs a drainer with a cursor". This file gives that drainer the three
-- statements it needs and nothing more, modelled on 2994's memory_outbox_claim /
-- _ack / _fail (the house pattern, already reviewed):
--
--   telegraph_outbox_claim(limit, lease_seconds, max_attempts)
--       one UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED): concurrent
--       drainers (several instances, the in-request nudge and the timer) take
--       DISJOINT batches; attempts is incremented at CLAIM so a row that kills
--       its consumer stops being claimed at max_attempts and stays for triage.
--   telegraph_outbox_ack(ids, disposition)
--       idempotent (published_at IS NULL filter); returns the count ACTUALLY
--       acked; records WHAT consumed the row (disposition), because "published"
--       alone cannot say whether the realtime fan-out ran or the route had
--       already published the event directly.
--   telegraph_outbox_fail(id, error)
--       records a failure CLASS (truncated, never a message body) and releases
--       the lease so the row is retried promptly.
--
-- AT-LEAST-ONCE, NOT EXACTLY-ONCE. A crash between fan-out and ack redelivers;
-- every fanned-out event carries the message id (and the outbox dedupe_key), and
-- clients already dedupe message.created on messageId.
--
-- THE FLAG. telegraph_outbox_fanout_enabled, seeded FALSE. OFF: the drainer
-- claims nothing and POST /threads/:id/messages publishes message.created
-- directly, exactly as before. ON (and only together with
-- telegraph_message_kernel_enabled, which is what makes the trigger write a row):
-- the route stops publishing message.created itself and nudges the drainer, so
-- the event is delivered FROM the outbox row written in the message's own
-- transaction — a process that dies between commit and publish no longer loses
-- the event.
--
-- No table is created. Two columns are added to 2810's telegraph_outbox, which
-- 3504 already revoked from anon/authenticated; RLS stays on with zero policies.
-- The three functions are SECURITY INVOKER and executable by service_role only.
--
-- ROLLBACK: db/rollback/2026-10-10-3655-telegraph-outbox-drain-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.telegraph_outbox') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3655): public.telegraph_outbox does not exist — apply 2810 first.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3655): public.feature_flags must exist.';
  END IF;
END $pre$;

ALTER TABLE public.telegraph_outbox ADD COLUMN IF NOT EXISTS locked_until timestamptz;
ALTER TABLE public.telegraph_outbox ADD COLUMN IF NOT EXISTS disposition text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'telegraph_outbox_disposition_check'
                    AND conrelid = 'public.telegraph_outbox'::regclass) THEN
    ALTER TABLE public.telegraph_outbox
      ADD CONSTRAINT telegraph_outbox_disposition_check
      CHECK (disposition IS NULL OR disposition IN ('fanned_out', 'route_direct', 'message_absent'));
  END IF;
END $$;

COMMENT ON COLUMN public.telegraph_outbox.locked_until IS
  'Telegraph §13.3 drain lease (migration 3655). Set by telegraph_outbox_claim; a row whose lease has passed is claimable again.';
COMMENT ON COLUMN public.telegraph_outbox.disposition IS
  'What consumed the row (migration 3655): fanned_out = the drainer published the realtime event; route_direct = the event type is still published directly by its route, the row is the durable record only; message_absent = the message was gone or retracted before fan-out, so nothing was announced.';

CREATE OR REPLACE FUNCTION public.telegraph_outbox_claim(
  p_limit         integer DEFAULT 100,
  p_lease_seconds integer DEFAULT 60,
  p_max_attempts  integer DEFAULT 8
)
RETURNS TABLE (
  id              uuid,
  event_type      text,
  conversation_id uuid,
  message_id      uuid,
  sequence        bigint,
  actor_id        uuid,
  dedupe_key      text,
  created_at      timestamptz,
  attempts        integer
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  UPDATE public.telegraph_outbox o
     SET locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
         attempts     = o.attempts + 1
   WHERE o.id IN (
     SELECT c.id
       FROM public.telegraph_outbox c
      WHERE c.published_at IS NULL
        AND (c.locked_until IS NULL OR c.locked_until < now())
        AND c.attempts < greatest(p_max_attempts, 1)
      ORDER BY c.created_at ASC, c.id ASC
      LIMIT greatest(p_limit, 0)
        FOR UPDATE SKIP LOCKED
   )
  RETURNING o.id, o.event_type, o.conversation_id, o.message_id, o.sequence, o.actor_id, o.dedupe_key, o.created_at, o.attempts;
$fn$;

COMMENT ON FUNCTION public.telegraph_outbox_claim(integer, integer, integer) IS
  'Claim a batch of unpublished Telegraph outbox rows under a lease (§13.3, migration 3655). FOR UPDATE SKIP LOCKED: concurrent drainers take disjoint batches. attempts incremented at claim; rows at max_attempts are no longer claimed and stay for triage. Returns no payload body (2810''s payload has none).';

CREATE OR REPLACE FUNCTION public.telegraph_outbox_ack(p_ids uuid[], p_disposition text)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_count integer;
BEGIN
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;
  UPDATE public.telegraph_outbox o
     SET published_at = now(),
         locked_until = NULL,
         last_error   = NULL,
         disposition  = p_disposition
   WHERE o.id = ANY(p_ids)
     AND o.published_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$fn$;

COMMENT ON FUNCTION public.telegraph_outbox_ack(uuid[], text) IS
  'Mark Telegraph outbox rows consumed with their disposition (§13.3, migration 3655). Idempotent: filtered on published_at IS NULL. Returns the number ACTUALLY acked.';

CREATE OR REPLACE FUNCTION public.telegraph_outbox_fail(p_id uuid, p_error text)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  UPDATE public.telegraph_outbox o
     SET locked_until = NULL,
         last_error   = left(coalesce(p_error, 'unknown'), 200)
   WHERE o.id = p_id
     AND o.published_at IS NULL;
$fn$;

COMMENT ON FUNCTION public.telegraph_outbox_fail(uuid, text) IS
  'Record a Telegraph outbox consumer failure CLASS (truncated to 200 chars, never a message body) and release the lease (§13.3, migration 3655). attempts is not incremented here — the claim did it.';

REVOKE ALL ON FUNCTION public.telegraph_outbox_claim(integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.telegraph_outbox_ack(uuid[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.telegraph_outbox_fail(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telegraph_outbox_claim(integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.telegraph_outbox_ack(uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.telegraph_outbox_fail(uuid, text) TO service_role;

-- Belt and braces on the table 3504 already closed: a re-run on a database where
-- someone re-granted it must not leave a client role reading the event log.
REVOKE ALL ON public.telegraph_outbox FROM PUBLIC, anon, authenticated;

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('telegraph_outbox_fanout_enabled', false,
   'CAPABILITY gate for Telegraph §13.3 outbox consumption (census-telegraph T154, migration 3655). OFF (the seed): the outbox drainer claims nothing and POST /threads/:id/messages publishes message.created directly, as before. ON (effective only with telegraph_message_kernel_enabled): the route nudges the drainer instead, and message.created is fanned out FROM the outbox row written in the message''s own transaction (at-least-once, deduped on messageId); other event types are acked route_direct.')
ON CONFLICT (flag) DO NOTHING;

DO $post$
DECLARE
  v_missing text;
  v_client_exec int;
  v_client_tbl int;
  v_rls boolean;
BEGIN
  SELECT string_agg(c, ', ') INTO v_missing FROM (
    SELECT c FROM unnest(ARRAY['locked_until', 'disposition']) c
     WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'telegraph_outbox' AND column_name = c)
  ) q;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3655): telegraph_outbox missing column(s): %', v_missing;
  END IF;

  IF to_regprocedure('public.telegraph_outbox_claim(integer, integer, integer)') IS NULL
     OR to_regprocedure('public.telegraph_outbox_ack(uuid[], text)') IS NULL
     OR to_regprocedure('public.telegraph_outbox_fail(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3655): a drain function is missing.';
  END IF;

  SELECT count(*) INTO v_client_exec
    FROM unnest(ARRAY['anon', 'authenticated']) r(role),
         unnest(ARRAY['public.telegraph_outbox_claim(integer, integer, integer)',
                      'public.telegraph_outbox_ack(uuid[], text)',
                      'public.telegraph_outbox_fail(uuid, text)']) f(sig)
   WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role)
     AND has_function_privilege(r.role, f.sig, 'EXECUTE');
  IF v_client_exec <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3655): a client role can execute % drain function grant(s).', v_client_exec;
  END IF;

  SELECT count(*) INTO v_client_tbl FROM information_schema.table_privileges
   WHERE table_schema = 'public' AND table_name = 'telegraph_outbox' AND grantee IN ('anon', 'authenticated');
  IF v_client_tbl <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3655): anon/authenticated hold % privilege(s) on telegraph_outbox', v_client_tbl;
  END IF;

  SELECT relrowsecurity INTO v_rls FROM pg_class WHERE oid = 'public.telegraph_outbox'::regclass;
  IF NOT v_rls THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3655): RLS is not enabled on telegraph_outbox';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_outbox_fanout_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3655): telegraph_outbox_fanout_enabled was not seeded.';
  END IF;
END $post$;

COMMIT;
