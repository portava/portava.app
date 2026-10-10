-- 3677_highlight_lifecycle_events.sql
-- Highlights/Memories spec §5 (Highlight lifecycle DRAFT -> ACTIVE -> EXPIRED),
-- §17 (domain events highlight.created, highlight.published, highlight.expired;
-- "canonical mutation and event-outbox insert occur in one database
-- transaction"). Census H155, H156, H157.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; lane H-REST
-- 3677-3689). APPLIED TO NO DATABASE by the lane that wrote it. ADDITIVE: two
-- functions and one flag seeded FALSE. No table, column, constraint, policy or
-- grant on an existing object changes, and no existing row is written.
--
-- ── WHY THESE THREE EVENTS HAD NO WRITER ───────────────────────────────────
-- 2710's type CHECK admits highlight.created / .published / .expired and 2993
-- made them writeable (a Highlight subject on the event and outbox rows), but
-- nothing wrote them: POST /highlights and POST /stories/:id/save-to-highlight
-- insert the row directly, and expiry is a read-time filter.
--
-- ── 1. public.highlight_create_execute(p_command jsonb) — CREATE_HIGHLIGHT ──
-- An EXT command (§17 names highlight.created but no command that produces
-- it; the UPDATE_MEMORY / UNHIDE_HIGHLIGHT precedent, lib/memoryCommandBus.ts).
-- A THIRD function rather than a branch of highlight_kernel_execute, for the
-- reason 3676 gives for memory_graph_kernel_execute: it has no subject id when
-- the command arrives (the function assigns it, exactly as CREATE_MEMORY's),
-- so it cannot share that function's lock-the-row-first shape, and leaving
-- 2993/3001's body untouched keeps their postconditions true by construction.
-- In ONE transaction it inserts the row, then writes
--   highlight.created   (sequence 1)  §17: the Highlight exists;
--   highlight.published (sequence 2)  §5 DRAFT -> ACTIVE: it is live to its
--                                     audience;
-- plus one outbox row per event, the idempotency receipt and the audit row.
-- PUBLICATION AT CREATION IS A FACT OF THIS PRODUCT, NOT A SHORTCUT: no
-- writer stores a draft Highlight (2723's lifecycle_state is NULL on every
-- row; services/highlights/highlightLifecycle.ts says DRAFT "has no witness"),
-- so the DRAFT stage has zero duration and the published event's payload says
-- so (`published_at_creation: true`, `from_state: null`). PUBLISH_HIGHLIGHT
-- stays undeclared — there is still no state to publish OUT OF.
--
-- ── 2. public.highlight_expiry_emit(p_now, p_limit) — highlight.expired ────
-- The clock, not a command: actor NULL, causation NULL, command_type NULL,
-- `cause: 'clock'`, occurred_at = the row's expires_at. It emits for a
-- Highlight exactly when the event log's LAST word is that the Highlight is
-- ACTIVE (`to_state = 'ACTIVE'` on its highest-sequence event) and the row is
-- now EXPIRED under the kernel's own derivation (not archived, not pinned,
-- not deleted, expires_at <= p_now). So:
--   * it fires once: the event it writes makes the last word EXPIRED;
--   * a pinned Highlight does not expire (§12 "expires after recent context
--     unless pinned"; the kernel derives PINNED before EXPIRED); if it is
--     unpinned after its expiry, UNPIN's own event already says to_state
--     EXPIRED, so no second record of the same transition is written;
--   * a Highlight whose writes all bypassed the boundary (no stream) gets
--     nothing: a stream that began with highlight.expired would describe an
--     aggregate the log never saw created, and the first enablement would
--     flood the outbox with every expired Highlight ever made;
--   * a PERMANENT Highlight (expires_at NULL, 2975) never qualifies.
-- Rows are taken FOR UPDATE SKIP LOCKED, the lock highlight_kernel_execute
-- takes, so a concurrent PIN and this pass cannot both allocate one sequence.
-- Called by lib/highlightExpiryEventScheduler.ts behind
-- `highlight_expiry_events_enabled` (seeded FALSE here) AND
-- `memory_kernel_enabled` (2710, FALSE): the kernel flag decides whether the
-- event store is the write path at all.
--
-- §23: every payload is ids and §5 vocabulary only — never the caption, the
-- media URL, the filter or the place.
--
-- Rollback: db/rollback/2026-10-10-3677-highlight-lifecycle-events-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.highlights') IS NULL OR to_regclass('public.memory_domain_events') IS NULL
     OR to_regclass('public.memory_event_outbox') IS NULL OR to_regclass('public.memory_command_receipts') IS NULL
     OR to_regclass('public.memory_command_audit') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3677): highlights and the four 2710 kernel tables must exist.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'memory_domain_events' AND column_name = 'highlight_id') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3677): memory_domain_events.highlight_id (2993) is missing; apply 2993 first.';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'highlights'
         AND column_name IN ('lifetime_class', 'pinned_at', 'archived_at', 'deleted_at', 'filter_id', 'filter_intensity')) <> 6 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3677): highlights lacks lifetime_class/pinned_at/archived_at/deleted_at/filter_id/filter_intensity (2723, 0164).';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3677): public.feature_flags does not exist.';
  END IF;
END $pre$;

-- ── 1. CREATE_HIGHLIGHT ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.highlight_create_execute(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  v_actor      uuid;
  v_cmd_id     uuid;
  v_corr       uuid;
  v_key        text;
  v_type       text;
  v_payload    jsonb;
  v_observed   timestamptz;
  v_now        timestamptz;
  v_receipt    public.memory_command_receipts%ROWTYPE;
  v_media_url  text;
  v_media_type text;
  v_visibility text;
  v_class      text;
  v_hours      integer;
  v_expires    timestamptz;
  v_duration   double precision;
  v_intensity  integer;
  v_id         uuid;
  v_created    uuid;
  v_published  uuid;
  v_result     jsonb;
  v_refs       jsonb;
BEGIN
  -- ONE CLOCK: the row's expiry and both events' occurred_at derive from it.
  v_now := now();

  BEGIN
    v_actor    := (p_command->>'actor_user_id')::uuid;
    v_cmd_id   := (p_command->>'command_id')::uuid;
    v_corr     := (p_command->>'correlation_id')::uuid;
    v_key      := p_command->>'idempotency_key';
    v_type     := p_command->>'type';
    v_payload  := coalesce(p_command->'payload', '{}'::jsonb);
    v_observed := (p_command->>'client_observed_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED',
                              'detail', SQLERRM, 'contract_version', 1);
  END;

  IF v_actor IS NULL OR v_cmd_id IS NULL OR v_type IS NULL OR v_key IS NULL
     OR char_length(v_key) < 1 OR char_length(v_key) > 200
     OR jsonb_typeof(v_payload) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED', 'contract_version', 1);
  END IF;

  IF v_type IS DISTINCT FROM 'CREATE_HIGHLIGHT' THEN
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, highlight_id, actor_user_id, idempotency_key, outcome, reason)
    VALUES (v_cmd_id, v_type, NULL, NULL, v_actor, v_key, 'rejected', 'MEMORY_COMMAND_UNKNOWN_TYPE');
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_UNKNOWN_TYPE',
                              'detail', v_type, 'contract_version', 1);
  END IF;

  -- §19: the SAME receipt table and key space as the other kernels.
  SELECT * INTO v_receipt FROM public.memory_command_receipts
   WHERE actor_user_id = v_actor AND idempotency_key = v_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_receipt.command_type IS DISTINCT FROM v_type THEN
      INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, highlight_id, actor_user_id, idempotency_key, outcome, reason)
      VALUES (v_cmd_id, v_type, NULL, NULL, v_actor, v_key, 'rejected', 'MEMORY_IDEMPOTENCY_KEY_REUSED');
      RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_IDEMPOTENCY_KEY_REUSED',
                                'detail', format('key already used for %s', v_receipt.command_type),
                                'contract_version', 1);
    END IF;
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, highlight_id, actor_user_id, idempotency_key, outcome, event_id)
    VALUES (v_cmd_id, v_type, NULL, v_receipt.highlight_id, v_actor, v_key, 'duplicate', v_receipt.event_id);
    RETURN jsonb_build_object(
      'ok', true, 'duplicate', true,
      'highlight_id', v_receipt.highlight_id, 'event_id', v_receipt.event_id,
      'event_type', v_receipt.event_type, 'result', v_receipt.result_json,
      'contract_version', 1);
  END IF;

  -- ── invariants, re-checked here and not trusted from the caller ───────────
  v_media_url  := v_payload->>'media_url';
  v_media_type := v_payload->>'media_type';
  v_visibility := coalesce(v_payload->>'visibility', 'public');
  v_class      := v_payload->>'lifetime_class';
  BEGIN
    v_hours     := (v_payload->>'expires_in_hours')::integer;
    v_duration  := (v_payload->>'video_duration_seconds')::double precision;
    v_intensity := coalesce((v_payload->>'filter_intensity')::integer, 100);
  EXCEPTION WHEN OTHERS THEN
    v_hours := -1;
  END;

  IF v_media_url IS NULL OR char_length(v_media_url) < 1
     OR v_media_type IS NULL OR char_length(v_media_type) < 1
     OR v_visibility NOT IN ('public', 'travelers_nearby', 'circle_only', 'trip_only', 'private')
     OR (v_class IS NOT NULL AND v_class NOT IN ('LIVE', 'DAY', 'TRIP', 'SEASONAL', 'PERMANENT'))
     -- §4 PERMANENT is exactly the class with no expiry, and only it (2975's CHECK
     -- says the same from the storage side).
     OR (v_class = 'PERMANENT' AND v_hours IS NOT NULL)
     OR (v_class IS DISTINCT FROM 'PERMANENT' AND (v_hours IS NULL OR v_hours NOT IN (3, 6, 12, 24, 48)))
     OR v_intensity < 0 OR v_intensity > 100 THEN
    INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, highlight_id, actor_user_id, idempotency_key, outcome, reason)
    VALUES (v_cmd_id, v_type, NULL, NULL, v_actor, v_key, 'rejected', 'MEMORY_COMMAND_MALFORMED');
    RETURN jsonb_build_object('ok', false, 'reason', 'MEMORY_COMMAND_MALFORMED',
                              'detail', 'CREATE_HIGHLIGHT payload violates the Highlight invariants', 'contract_version', 1);
  END IF;
  v_expires := CASE WHEN v_class = 'PERMANENT' THEN NULL ELSE v_now + make_interval(hours => v_hours) END;

  -- A PERMANENT Highlight on a database without 2975 fails the NOT NULL; with
  -- 2723 but not 2975's CHECK it is still refused by the NOT NULL. Refused BY
  -- NAME and audited, never stored with an invented expiry.
  BEGIN
    INSERT INTO public.highlights (
      owner_id, media_url, media_type, video_duration_seconds, caption,
      location_name, location_city, location_country, visibility, expires_at,
      lifetime_class, filter_id, filter_intensity, created_at)
    VALUES (
      v_actor, v_media_url, v_media_type, v_duration, v_payload->>'caption',
      v_payload->>'location_name', v_payload->>'location_city', v_payload->>'location_country',
      v_visibility, v_expires, v_class, coalesce(v_payload->>'filter_id', 'original'), v_intensity, v_now)
    RETURNING id INTO v_id;
  EXCEPTION WHEN not_null_violation OR check_violation THEN
    IF v_class = 'PERMANENT' THEN
      INSERT INTO public.memory_command_audit (command_id, command_type, memory_id, highlight_id, actor_user_id, idempotency_key, outcome, reason)
      VALUES (v_cmd_id, v_type, NULL, NULL, v_actor, v_key, 'rejected', 'HIGHLIGHT_LIFETIME_UNAVAILABLE');
      RETURN jsonb_build_object('ok', false, 'reason', 'HIGHLIGHT_LIFETIME_UNAVAILABLE',
                                'detail', 'highlights.expires_at cannot hold a PERMANENT Highlight on this database (2975 not applied)',
                                'contract_version', 1);
    END IF;
    RAISE;
  END;

  v_refs := jsonb_build_object('highlight_id', v_id, 'memory_id', NULL, 'actor_user_id', v_actor);

  INSERT INTO public.memory_domain_events (
    memory_id, highlight_id, sequence, type, actor_user_id, causation_id,
    correlation_id, payload_json, schema_version, occurred_at)
  VALUES (
    NULL, v_id, 1, 'highlight.created', v_actor, v_cmd_id, v_corr,
    jsonb_build_object(
      'command_type', v_type, 'from_state', NULL, 'to_state', 'ACTIVE',
      'state_provenance', 'derived', 'pinned', false,
      'visibility', v_visibility, 'lifetime_class', v_class, 'refs', v_refs),
    1, coalesce(v_observed, v_now))
  RETURNING event_id INTO v_created;

  INSERT INTO public.memory_domain_events (
    memory_id, highlight_id, sequence, type, actor_user_id, causation_id,
    correlation_id, payload_json, schema_version, occurred_at)
  VALUES (
    NULL, v_id, 2, 'highlight.published', v_actor, v_cmd_id, v_corr,
    jsonb_build_object(
      'command_type', v_type, 'from_state', NULL, 'to_state', 'ACTIVE',
      'state_provenance', 'derived', 'published_at_creation', true,
      'visibility', v_visibility, 'refs', v_refs),
    1, coalesce(v_observed, v_now))
  RETURNING event_id INTO v_published;

  INSERT INTO public.memory_event_outbox (event_id, memory_id, highlight_id, type)
  VALUES (v_created, NULL, v_id, 'highlight.created'),
         (v_published, NULL, v_id, 'highlight.published');

  -- The result is ids only (§23): the route re-reads the row under the
  -- caller's own client, so the receipt never holds the caption or media URL.
  v_result := jsonb_build_object('id', v_id, 'created_event_id', v_created, 'published_event_id', v_published);

  INSERT INTO public.memory_command_receipts (
    actor_user_id, idempotency_key, command_id, command_type, memory_id,
    highlight_id, event_id, event_type, result_json)
  VALUES (v_actor, v_key, v_cmd_id, v_type, NULL, v_id, v_created, 'highlight.created', v_result);

  INSERT INTO public.memory_command_audit (
    command_id, command_type, memory_id, highlight_id, actor_user_id,
    idempotency_key, outcome, event_id)
  VALUES (v_cmd_id, v_type, NULL, v_id, v_actor, v_key, 'accepted', v_created);

  RETURN jsonb_build_object(
    'ok', true, 'duplicate', false,
    'highlight_id', v_id, 'event_id', v_created, 'event_type', 'highlight.created',
    'sequence', 2, 'result', v_result, 'contract_version', 1);
END;
$fn$;

COMMENT ON FUNCTION public.highlight_create_execute(jsonb) IS
  'Highlights/Memories spec §5/§17 (migration 3677): CREATE_HIGHLIGHT (EXT). Inserts the Highlight and, in the same transaction, highlight.created (seq 1) + highlight.published (seq 2; no draft stage exists, published_at_creation) + their outbox rows + the receipt + the audit row. PERMANENT on a database without 2975 is refused as HIGHLIGHT_LIFETIME_UNAVAILABLE. service_role only.';

REVOKE ALL ON FUNCTION public.highlight_create_execute(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.highlight_create_execute(jsonb) TO service_role;

-- ── 2. highlight.expired ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.highlight_expiry_emit(p_now timestamptz DEFAULT now(), p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
  r        record;
  v_seq    bigint;
  v_event  uuid;
  v_n      integer := 0;
BEGIN
  IF p_now IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'highlight_expiry_emit: p_now required and p_limit must be 1..1000' USING ERRCODE = 'check_violation';
  END IF;

  FOR r IN
    SELECT h.id, h.expires_at, h.visibility
      FROM public.highlights h
     WHERE h.expires_at IS NOT NULL
       AND h.expires_at <= p_now
       AND h.deleted_at IS NULL
       AND h.archived_at IS NULL
       AND h.pinned_at IS NULL
       -- The log's last word is ACTIVE. Implies a stream exists.
       AND (SELECT e.payload_json->>'to_state'
              FROM public.memory_domain_events e
             WHERE e.highlight_id = h.id
             ORDER BY e.sequence DESC
             LIMIT 1) = 'ACTIVE'
     ORDER BY h.expires_at, h.id
     LIMIT p_limit
     FOR UPDATE OF h SKIP LOCKED
  LOOP
    SELECT coalesce(max(sequence), 0) + 1 INTO v_seq
      FROM public.memory_domain_events WHERE highlight_id = r.id;

    INSERT INTO public.memory_domain_events (
      memory_id, highlight_id, sequence, type, actor_user_id, causation_id,
      correlation_id, payload_json, schema_version, occurred_at)
    VALUES (
      NULL, r.id, v_seq, 'highlight.expired', NULL, NULL, NULL,
      jsonb_build_object(
        'command_type', NULL, 'cause', 'clock',
        'from_state', 'ACTIVE', 'to_state', 'EXPIRED', 'state_provenance', 'derived',
        'expires_at', r.expires_at, 'visibility', r.visibility,
        'refs', jsonb_build_object('highlight_id', r.id, 'memory_id', NULL, 'actor_user_id', NULL)),
      1, r.expires_at)
    RETURNING event_id INTO v_event;

    INSERT INTO public.memory_event_outbox (event_id, memory_id, highlight_id, type)
    VALUES (v_event, NULL, r.id, 'highlight.expired');
    v_n := v_n + 1;
  END LOOP;

  RETURN jsonb_build_object('emitted', v_n, 'limit', p_limit, 'more', v_n >= p_limit);
END;
$fn$;

COMMENT ON FUNCTION public.highlight_expiry_emit(timestamptz, integer) IS
  'Highlights/Memories spec §5/§17 (migration 3677): writes highlight.expired (+ outbox row) for each Highlight whose event log last said ACTIVE and whose row is now EXPIRED (not archived, pinned or deleted; expires_at <= p_now). Clock-caused: actor/causation NULL, occurred_at = expires_at. Bounded by p_limit, FOR UPDATE SKIP LOCKED. service_role only; called by lib/highlightExpiryEventScheduler.ts behind highlight_expiry_events_enabled AND memory_kernel_enabled.';

REVOKE ALL ON FUNCTION public.highlight_expiry_emit(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.highlight_expiry_emit(timestamptz, integer) TO service_role;

-- ── 3. The flag, seeded OFF ─────────────────────────────────────────────────
INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'highlight_expiry_events_enabled',
    false,
    'Highlights/Memories spec 17 highlight.expired (census H157, migration 3677). ON together with memory_kernel_enabled: a scheduler pass every few minutes calls highlight_expiry_emit, which writes highlight.expired + an outbox row for each Highlight whose event log last said ACTIVE and whose expires_at has passed (not pinned, hidden or deleted). OFF / absent (the seed): the pass reads the flags and does nothing else.'
  )
ON CONFLICT (flag) DO NOTHING;

-- ── POSTCONDITIONS ──────────────────────────────────────────────────────────
-- Inside the applying transaction (the probes write and then remove audit
-- rows, which a post-COMMIT block may not). Self-contained: each reads the
-- catalog or probes a rejection path. No fixture row, no session state.
DO $post$
DECLARE
  v jsonb;
  v_def text;
BEGIN
  IF to_regprocedure('public.highlight_create_execute(jsonb)') IS NULL
     OR to_regprocedure('public.highlight_expiry_emit(timestamptz,integer)') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3677): a function is missing';
  END IF;
  IF has_function_privilege('anon', 'public.highlight_create_execute(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.highlight_create_execute(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.highlight_expiry_emit(timestamptz,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.highlight_expiry_emit(timestamptz,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3677): a client role can EXECUTE a 3677 function';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.highlight_create_execute(jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.highlight_expiry_emit(timestamptz,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3677): service_role cannot EXECUTE a 3677 function';
  END IF;

  -- A malformed command is RETURNED, not raised.
  v := public.highlight_create_execute('{}'::jsonb);
  IF (v->>'reason') IS DISTINCT FROM 'MEMORY_COMMAND_MALFORMED' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3677): highlight_create_execute({}) returned %', v;
  END IF;

  -- Another command name is refused by name and audited; PUBLISH_HIGHLIGHT
  -- stays undeclared (there is no draft to publish out of).
  v := public.highlight_create_execute(jsonb_build_object(
        'command_id', gen_random_uuid(), 'actor_user_id', gen_random_uuid(),
        'idempotency_key', '3677-postcondition-publish', 'type', 'PUBLISH_HIGHLIGHT', 'payload', '{}'::jsonb));
  IF (v->>'reason') IS DISTINCT FROM 'MEMORY_COMMAND_UNKNOWN_TYPE' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3677): PUBLISH_HIGHLIGHT returned %', v;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memory_command_audit
                  WHERE idempotency_key = '3677-postcondition-publish' AND reason = 'MEMORY_COMMAND_UNKNOWN_TYPE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3677): a refused command wrote no audit row';
  END IF;
  DELETE FROM public.memory_command_audit WHERE idempotency_key = '3677-postcondition-publish';

  -- PERMANENT carrying an expiry is refused before any write.
  v := public.highlight_create_execute(jsonb_build_object(
        'command_id', gen_random_uuid(), 'actor_user_id', gen_random_uuid(),
        'idempotency_key', '3677-postcondition-permanent', 'type', 'CREATE_HIGHLIGHT',
        'payload', jsonb_build_object('media_url', 'x', 'media_type', 'image/jpeg',
                                      'lifetime_class', 'PERMANENT', 'expires_in_hours', 24)));
  IF (v->>'reason') IS DISTINCT FROM 'MEMORY_COMMAND_MALFORMED' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3677): PERMANENT with an expiry returned %', v;
  END IF;
  DELETE FROM public.memory_command_audit WHERE idempotency_key = '3677-postcondition-permanent';

  -- The expiry emitter refuses an out-of-range batch rather than scanning.
  BEGIN
    PERFORM public.highlight_expiry_emit(now(), 0);
    RAISE EXCEPTION 'POSTCONDITION FAILED (3677): highlight_expiry_emit accepted p_limit 0';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Both writers name only event types 2710's CHECK admits.
  v_def := pg_get_functiondef('public.highlight_create_execute(jsonb)'::regprocedure)
        || pg_get_functiondef('public.highlight_expiry_emit(timestamptz,integer)'::regprocedure);
  IF v_def !~ '''highlight\.created''' OR v_def !~ '''highlight\.published''' OR v_def !~ '''highlight\.expired''' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3677): the installed functions do not write the three events';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'highlight_expiry_events_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3677): highlight_expiry_events_enabled was not seeded';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'highlight_expiry_events_enabled' AND enabled = true) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3677): highlight_expiry_events_enabled is ON — it must ship OFF';
  END IF;
END
$post$;

COMMIT;
